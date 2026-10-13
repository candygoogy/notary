import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEDGER_LIMIT, emptyLedger, latestQualifyingRun, needsJudging, recordEdit, recordRun } from '../../plugins/receipts/hooks/core/ledger.ts'
import { decide, judge } from '../../plugins/receipts/hooks/core/verdict.ts'
import { bandText, nudgeText, sendBackText, stampText } from '../../plugins/receipts/hooks/core/copy.ts'
import type { Claim, Evidence, Ledger, Verdict } from '../../plugins/receipts/hooks/core/types.ts'

const testsClaim: Claim = { sentence: 'All tests pass', kind: 'tests', certainty: 'sure' }
const genericClaim: Claim = { sentence: 'Fixed.', kind: 'generic', certainty: 'sure' }

const npmPass: Evidence = { strength: 'strong', outcome: 'pass', command: 'npm test', summary: 'npm test passed (42)' }
const npmFail: Evidence = { strength: 'strong', outcome: 'fail', command: 'npm test', summary: 'npm test exited 1 (1 failed)' }
const tscPass: Evidence = { strength: 'medium', outcome: 'pass', command: 'tsc --noEmit', summary: 'tsc --noEmit passed' }
const pending: Evidence = { strength: 'strong', outcome: 'pending', command: 'npm test', summary: 'npm test is still running' }
const zero: Evidence = { strength: 'strong', outcome: 'zero-tests', command: 'pytest', summary: 'pytest ran no tests' }

function ledger(...steps: Array<'edit' | Evidence>): Ledger {
  let l = emptyLedger()
  for (const step of steps) l = step === 'edit' ? recordEdit(l, 'src/a.ts', 1) : recordRun(l, step, 1)
  return l
}

test('edit then a failing test contradicts a tests claim', () => {
  assert.equal(judge([testsClaim], ledger('edit', npmFail), 0)?.kind, 'contradicted')
})

test('fail then pass after the edit is verified', () => {
  const v = judge([testsClaim], ledger('edit', npmFail, npmPass), 0)
  assert.equal(v?.kind, 'verified')
  assert.deepEqual(v?.evidence, npmPass)
})

test('a pass before the last edit does not count', () => {
  const v = judge([testsClaim], ledger(npmPass, 'edit'), 0)
  assert.equal(v?.kind, 'unverified')
  assert.equal(v?.evidence, null)
})

test('no edits means nothing to judge', () => {
  assert.equal(judge([testsClaim], ledger(npmPass), 0), null)
  assert.equal(judge([testsClaim], emptyLedger(), 0), null)
})

test('no claims means nothing to judge', () => {
  assert.equal(judge([], ledger('edit', npmFail), 0), null)
})

test('a later turn with nothing new is not judged', () => {
  const l = ledger('edit', npmPass)
  assert.equal(needsJudging(l, 2), false)
  assert.equal(judge([testsClaim], l, 2), null)
})

test('an edit still unverified when the turn started carries over', () => {
  const l = ledger('edit', npmFail)
  assert.equal(needsJudging(l, 2), true)
  assert.equal(judge([testsClaim], l, 2)?.kind, 'contradicted')
})

test('an edit during the turn is always judged', () => {
  assert.equal(needsJudging(ledger('edit', npmPass, 'edit'), 2), true)
})

test('a tests claim needs strong evidence; a generic claim takes medium', () => {
  const l = ledger('edit', tscPass)
  assert.equal(judge([testsClaim], l, 0)?.kind, 'unverified')
  assert.equal(judge([genericClaim], l, 0)?.kind, 'verified')
})

test('pending and zero-test runs are not evidence', () => {
  assert.equal(judge([testsClaim], ledger('edit', pending, zero), 0)?.kind, 'unverified')
  assert.equal(latestQualifyingRun(ledger('edit', pending), 'generic'), null)
})

test('the worst verdict across claims wins', () => {
  const l = ledger('edit', tscPass)
  const v = judge([genericClaim, testsClaim], l, 0)
  assert.equal(v?.kind, 'unverified')
  assert.equal(v?.claim, testsClaim)
})

test('runs by a subagent count like the main loop', () => {
  let l = recordEdit(emptyLedger(), 'src/a.ts', 1)
  l = recordRun(l, npmPass, 2, 'agent-7')
  assert.equal(judge([testsClaim], l, 0)?.kind, 'verified')
})

const verified: Verdict = { kind: 'verified', claim: testsClaim, evidence: npmPass }
const unverified: Verdict = { kind: 'unverified', claim: testsClaim, evidence: null }
const contradicted: Verdict = { kind: 'contradicted', claim: testsClaim, evidence: npmFail }

test('mode A never acts', () => {
  for (const v of [verified, unverified, contradicted]) assert.deepEqual(decide(v, 'A', false, false), { sendBack: null, nudge: null })
})

test('mode B sends a contradiction back and nudges an unverified claim', () => {
  assert.deepEqual(decide(contradicted, 'B', false, false), { sendBack: sendBackText(contradicted), nudge: null })
  assert.deepEqual(decide(unverified, 'B', false, false), { sendBack: null, nudge: nudgeText(unverified) })
})

test('mode C sends an unverified claim back', () => {
  assert.deepEqual(decide(unverified, 'C', false, false), { sendBack: sendBackText(unverified), nudge: null })
  assert.deepEqual(decide(contradicted, 'C', false, false), { sendBack: sendBackText(contradicted), nudge: null })
})

test('never a second send-back in a turn, nor while the stop hook is active', () => {
  for (const mode of ['B', 'C'] as const) {
    assert.equal(decide(contradicted, mode, true, false).sendBack, null)
    assert.equal(decide(contradicted, mode, false, true).sendBack, null)
  }
})

test('a verified claim gets nothing in any mode', () => {
  for (const mode of ['A', 'B', 'C'] as const) assert.deepEqual(decide(verified, mode, false, false), { sendBack: null, nudge: null })
})

test('copy strings are exact', () => {
  assert.equal(bandText(verified), '✅ Verified · npm test passed (42)')
  assert.equal(bandText(unverified), '⚠️ Unverified: no receipts · no check ran after the last edit')
  assert.equal(bandText(contradicted), '❌ Contradicted: "All tests pass" · npm test exited 1 (1 failed)')
  assert.equal(stampText(contradicted), '🧾 ❌ Contradicted: "All tests pass" · npm test exited 1 (1 failed)')
  assert.equal(
    sendBackText(contradicted),
    'Receipts: you claimed "All tests pass", but npm test exited 1 (1 failed). Fix it and verify before claiming success.',
  )
  assert.equal(
    sendBackText(unverified),
    'Receipts: you claimed "All tests pass", but no check ran after your last edit. Run the relevant tests or build before claiming success.',
  )
  assert.equal(
    nudgeText(unverified),
    "Receipts: your previous claim 'All tests pass' was not verified by any check run after your last edit. Verify before claiming success.",
  )
})

test('a claim longer than 80 characters is cut with an ellipsis', () => {
  const sentence = 'I have fixed ' + 'a'.repeat(100)
  const v: Verdict = { kind: 'contradicted', claim: { sentence, kind: 'generic', certainty: 'sure' }, evidence: npmFail }
  const shown = sentence.slice(0, 79) + '…'
  assert.equal(bandText(v), `❌ Contradicted: "${shown}" · npm test exited 1 (1 failed)`)
})

test('the ledger keeps the last 500 entries and keeps counting', () => {
  let l = emptyLedger()
  for (let i = 0; i < 600; i++) l = recordEdit(l, `f${i}.ts`, i)
  assert.equal(LEDGER_LIMIT, 500)
  assert.equal(l.entries.length, 500)
  assert.equal(l.nextSeq, 600)
  assert.equal(l.entries[0].seq, 100)
})

test('on a tie the tests claim is quoted over a generic one', () => {
  const v = judge([genericClaim, testsClaim], ledger('edit', npmFail), 0)
  assert.equal(v?.kind, 'contradicted')
  assert.equal(v?.claim, testsClaim)
})

const buildClaim: Claim = { sentence: 'The build succeeds.', kind: 'build', certainty: 'sure' }

test('review 3b: a build claim is judged by build runs, not by a failing test run', () => {
  assert.equal(judge([buildClaim], ledger('edit', tscPass, npmFail), 0)?.kind, 'verified')
  assert.equal(judge([buildClaim], ledger('edit', npmFail), 0)?.kind, 'unverified')
  assert.equal(judge([buildClaim], ledger('edit', npmPass), 0)?.kind, 'verified')
})

test('a failure in another area does not contradict a scoped claim; an earlier pass in scope verifies it', () => {
  const website: Claim = { sentence: 'The website tests pass.', kind: 'tests', certainty: 'sure' }
  const cargoFail: Evidence = { strength: 'strong', outcome: 'fail', command: 'cargo test --workspace', summary: 'cargo test exited 101 (1 failed)' }
  assert.equal(judge([website], ledger('edit', cargoFail), 0)?.kind, 'unverified')
  const webPass: Evidence = { strength: 'strong', outcome: 'pass', command: 'npm test -w website', summary: 'npm test passed (428)' }
  assert.equal(judge([website], ledger('edit', webPass, cargoFail), 0)?.kind, 'verified')
  // An unscoped claim is contradicted by any failure.
  assert.equal(judge([testsClaim], ledger('edit', cargoFail), 0)?.kind, 'contradicted')
})

// Lead's rule: a failing run of part of the suite (filtered, by name) after a
// full pass of the same runner, with no edit between, does not overturn it.
const cargoFull: Evidence = { strength: 'strong', outcome: 'pass', command: 'cargo test -p terminal --lib', summary: 'cargo test passed (115)' }
const cargoOne: Evidence = { strength: 'strong', outcome: 'fail', command: 'cargo test -p terminal test_mouse_mode_scroll', summary: 'cargo test failed (1 failed)', subset: true }

test('a mutation check after a full pass does not contradict the claim', () => {
  assert.equal(judge([testsClaim], ledger('edit', cargoFull, cargoOne), 0)?.kind, 'verified')
})

test('a subset failure with no earlier full pass still contradicts', () => {
  assert.equal(judge([testsClaim], ledger('edit', cargoOne), 0)?.kind, 'contradicted')
})

test('a subset failure of another runner does not hide behind this pass', () => {
  const vitestOne: Evidence = { ...cargoOne, command: 'npx vitest run -t parser' }
  assert.equal(judge([testsClaim], ledger('edit', cargoFull, vitestOne), 0)?.kind, 'contradicted')
})

test('a full failure after a full pass contradicts as before', () => {
  const cargoAll: Evidence = { ...cargoOne, command: 'cargo test -p terminal --lib', subset: undefined }
  assert.equal(judge([testsClaim], ledger('edit', cargoFull, cargoAll), 0)?.kind, 'contradicted')
})
