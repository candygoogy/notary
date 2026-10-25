import { test } from 'node:test'
import assert from 'node:assert/strict'

import { editedSince, emptyLedger, latestQualifyingRun, readShellIndex, recordEdit, recordRun, recordShellEdit } from '../../plugins/receipts/hooks/core/ledger.ts'
import { judge } from '../../plugins/receipts/hooks/core/verdict.ts'
import type { Claim, Evidence } from '../../plugins/receipts/hooks/core/types.ts'

const testsClaim: Claim = { sentence: 'All tests pass.', kind: 'tests', certainty: 'sure' }
const npmPass: Evidence = { strength: 'strong', outcome: 'pass', command: 'npm test', summary: 'npm test passed (42)' }
const sedRun: Evidence = { strength: 'none', outcome: 'pass', command: "sed -i 's/a/b/' src/a.ts", summary: '' }

// Changes' index as it stands: its edits, by `via`.
function index(...edits: Array<{ seq: number; via: string; toolUseId: string; path?: string; agentId?: string }>) {
  return { turns: [], edits: edits.map(e => ({ turnId: 't1', tool: 'Bash', path: '/w/src/a.ts', ...e })), nextSeq: 99 }
}

test('a shell edit after a passing run leaves no run to back a tests claim', () => {
  let l = recordRun(emptyLedger(), npmPass, 1, undefined, 'call-1')
  l = recordShellEdit(l, '/w/src/a.ts', 2, 'call-2')
  assert.equal(latestQualifyingRun(l, 'tests'), null)
  assert.equal(judge([testsClaim], l, 0)?.kind, 'unverified')
})

test('same command: the edit goes in before that call\'s run, which still backs the claim', () => {
  let l = recordEdit(emptyLedger(), '/w/src/b.ts', 1)
  const turnStart = l.nextSeq
  l = recordRun(l, npmPass, 2, undefined, 'call-1')
  l = recordShellEdit(l, '/w/src/a.ts', 3, 'call-1', 'agent-7')
  assert.deepEqual(
    l.entries.map(e => [e.seq, e.kind]),
    [
      [0, 'edit'],
      [1, 'edit'],
      [2, 'run'],
    ],
  )
  assert.equal(l.nextSeq, 3)
  assert.deepEqual(l.entries[1], { seq: 1, at: 3, agentId: 'agent-7', kind: 'edit', path: '/w/src/a.ts' })
  assert.deepEqual(latestQualifyingRun(l, 'tests'), npmPass)
  assert.equal(judge([testsClaim], l, turnStart)?.kind, 'verified')
  // Still an edit made this turn.
  assert.equal(editedSince(l, turnStart), true)
})

test('same command: entries after the run move one seq later', () => {
  let l = recordRun(emptyLedger(), sedRun, 1, undefined, 'call-1')
  l = recordRun(l, npmPass, 2, undefined, 'call-2')
  l = recordShellEdit(l, '/w/src/a.ts', 3, 'call-1')
  assert.deepEqual(
    l.entries.map(e => [e.seq, e.kind, e.kind === 'run' ? e.toolUseId : e.path]),
    [
      [0, 'edit', '/w/src/a.ts'],
      [1, 'run', 'call-1'],
      [2, 'run', 'call-2'],
    ],
  )
  assert.equal(l.nextSeq, 3)
  assert.deepEqual(latestQualifyingRun(l, 'tests'), npmPass)
})

test('a shell edit recorded before its own run lands is followed by it', () => {
  let l = recordShellEdit(emptyLedger(), '/w/src/a.ts', 1, 'call-1')
  l = recordRun(l, npmPass, 2, undefined, 'call-1')
  assert.deepEqual(latestQualifyingRun(l, 'tests'), npmPass)
})

test('a shell edit with no call id is appended', () => {
  let l = recordRun(emptyLedger(), npmPass, 1)
  l = recordShellEdit(l, '/w/src/a.ts', 2, '')
  assert.equal(latestQualifyingRun(l, 'tests'), null)
})

test('a run keeps no empty call id', () => {
  assert.equal('toolUseId' in recordRun(emptyLedger(), npmPass, 1, undefined, '').entries[0]!, false)
})

test("the turn-end sweep's files are skipped", () => {
  const read = readShellIndex(index({ seq: 3, via: 'shell', toolUseId: 'call-1' }, { seq: 4, via: 'unattributed', toolUseId: 'sweep:t1', path: '/w/src/b.ts' }), 2)
  assert.equal(read.seen, 4)
  assert.deepEqual(
    read.edits.map(e => [e.seq, e.path]),
    [[3, '/w/src/a.ts']],
  )
})

test('edits read once: only those after the seq read up to', () => {
  const idx = index({ seq: 3, via: 'shell', toolUseId: 'call-1' }, { seq: 5, via: 'tool', toolUseId: 'call-2' }, { seq: 6, via: 'shell', toolUseId: 'call-3', agentId: 'a1' })
  const read = readShellIndex(idx, 3)
  assert.equal(read.seen, 6)
  assert.deepEqual(
    read.edits.map(e => [e.seq, e.toolUseId, e.agentId]),
    [[6, 'call-3', 'a1']],
  )
  assert.deepEqual(readShellIndex(idx, 6), { seen: 6, edits: [] })
})

test('the first read, and one after Changes started afresh, record nothing older', () => {
  const idx = index({ seq: 3, via: 'shell', toolUseId: 'call-1' })
  assert.deepEqual(readShellIndex(idx, null), { seen: 3, edits: [] })
  assert.deepEqual(readShellIndex(idx, 40), { seen: 3, edits: [] })
})

test('no Changes index, or a shape it never had: nothing', () => {
  assert.deepEqual(readShellIndex(undefined, 0), { seen: 0, edits: [] })
  assert.deepEqual(readShellIndex({ edits: 'x' }, 0), { seen: 0, edits: [] })
  assert.deepEqual(readShellIndex(null, null), { seen: 0, edits: [] })
})
