// The replay CLI's own parts. The replay core is tested in test/receipts/replay.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TurnResult } from '../plugins/receipts/hooks/core/replay.ts'
import { parseArgs, shownAs, SKIP_PROJECTS } from '../tools/replay/replay.ts'

test('arguments: a folder, and --examples with or without a count', () => {
  assert.deepEqual(parseArgs([]), { root: null, examples: 0 })
  assert.deepEqual(parseArgs(['D:/logs']), { root: 'D:/logs', examples: 0 })
  assert.deepEqual(parseArgs(['--examples']), { root: null, examples: 10 })
  assert.deepEqual(parseArgs(['--examples', '5']), { root: null, examples: 5 })
  assert.deepEqual(parseArgs(['--examples', 'D:/logs']), { root: 'D:/logs', examples: 10 })
})

test("the team's demo and probe sessions are skipped, nothing else", () => {
  assert.equal(SKIP_PROJECTS.test('C--Users-u-AppData-Local-Temp-notary-smoke'), true)
  assert.equal(SKIP_PROJECTS.test('C--Users-u-code-notary-tools-probe'), true)
  assert.equal(SKIP_PROJECTS.test('C--Users-u-code-notary'), false)
})

test('quiet shows ❌, fresh tests/build ⚠️ and tests/build ✅; all shows everything', () => {
  const turn = (verdict: TurnResult['verdict'], claimKind: TurnResult['claimKind'], reason: TurnResult['reason'] = null): TurnResult =>
    ({ verdict, claimKind, claim: 'x', evidence: null, reason, lastCommand: null })
  const turns = [
    turn('contradicted', 'generic'),
    turn('unverified', 'tests', 'nothing-checked-after'),
    turn('unverified', 'tests', 'carried-over'),
    turn('unverified', 'generic', 'nothing-checked-after'),
    turn('verified', 'build'),
    turn('verified', 'generic'),
  ]
  assert.deepEqual(shownAs(turns, 'quiet'), { flags: 2, stamps: 3, nudges: 1, sendBacks: 1 })
  assert.deepEqual(shownAs(turns, 'all'), { flags: 4, stamps: 6, nudges: 3, sendBacks: 1 })
})
