import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bandStays, visibility } from '../../plugins/receipts/hooks/core/visibility.ts'
import type { BandMoment, Verbosity } from '../../plugins/receipts/hooks/core/visibility.ts'
import type { ClaimKind, VerdictKind } from '../../plugins/receipts/hooks/core/types.ts'

// [verdict, claim kind, carried over, verbosity] → [band, stamp, nudge, sendBackEligible]
const table: Array<[VerdictKind, ClaimKind, boolean, Verbosity, [boolean, boolean, boolean, boolean]]> = [
  // ❌ always surfaces.
  ['contradicted', 'tests', false, 'quiet', [true, true, false, true]],
  ['contradicted', 'generic', false, 'quiet', [true, true, false, true]],
  ['contradicted', 'build', true, 'quiet', [true, true, false, true]],
  // ⚠️ surfaces only for a tests/build claim with an edit this turn.
  ['unverified', 'tests', false, 'quiet', [true, true, true, true]],
  ['unverified', 'build', false, 'quiet', [true, true, true, true]],
  ['unverified', 'tests', true, 'quiet', [false, false, false, false]],
  ['unverified', 'generic', false, 'quiet', [false, false, false, false]],
  ['unverified', 'generic', true, 'quiet', [false, false, false, false]],
  // ✅ is stamped for tests/build claims only.
  ['verified', 'tests', false, 'quiet', [true, true, false, false]],
  ['verified', 'build', true, 'quiet', [true, true, false, false]],
  ['verified', 'generic', false, 'quiet', [false, false, false, false]],
  // all: as built.
  ['unverified', 'generic', true, 'all', [true, true, true, true]],
  ['unverified', 'tests', true, 'all', [true, true, true, true]],
  ['verified', 'generic', false, 'all', [true, true, false, false]],
  ['contradicted', 'generic', false, 'all', [true, true, false, true]],
]

for (const [kind, claimKind, carriedOver, verbosity, [band, stamp, nudge, sendBackEligible]] of table) {
  test(`visibility: ${verbosity} ${kind} ${claimKind}${carriedOver ? ' carried over' : ''}`, () => {
    assert.deepEqual(visibility({ kind, claim: { kind: claimKind } }, carriedOver, verbosity), { band, stamp, nudge, sendBackEligible })
  })
}

test('quiet is the default', () => {
  assert.deepEqual(visibility({ kind: 'unverified', claim: { kind: 'generic' } }, false), visibility({ kind: 'unverified', claim: { kind: 'generic' } }, false, 'quiet'))
})

// [verdict on the band, moment] → still on the band
const lifetime: Array<[VerdictKind, BandMoment, boolean]> = [
  // The person's next prompt clears ✅ only.
  ['verified', { at: 'prompt' }, false],
  ['unverified', { at: 'prompt' }, true],
  ['contradicted', { at: 'prompt' }, true],
  // A turn ends with no verdict of its own, no reminder carried (mode A, or a
  // prompt from a plugin): everything stays.
  ['unverified', { at: 'turn-end', reminded: false, judged: false }, true],
  ['contradicted', { at: 'turn-end', reminded: false, judged: false }, true],
  ['verified', { at: 'turn-end', reminded: false, judged: false }, true],
  // Its prompt carried the reminder (mode B): ⚠️ goes, ❌ stays.
  ['unverified', { at: 'turn-end', reminded: true, judged: false }, false],
  ['contradicted', { at: 'turn-end', reminded: true, judged: false }, true],
  // The turn gave a verdict: that one is on the band now and stays.
  ['unverified', { at: 'turn-end', reminded: true, judged: true }, true],
  ['contradicted', { at: 'turn-end', reminded: true, judged: true }, true],
  ['verified', { at: 'turn-end', reminded: true, judged: true }, true],
]

for (const [kind, moment, stays] of lifetime) {
  const when = moment.at === 'prompt' ? 'prompt' : `turn end${moment.reminded ? ', reminded' : ''}${moment.judged ? ', judged' : ''}`
  test(`band: ${kind} at ${when} ${stays ? 'stays' : 'goes'}`, () => {
    assert.equal(bandStays(kind, moment), stays)
  })
}
