// What a verdict shows, in one place so it is easy to tune (lead's defaults,
// from the replay of real sessions). Every verdict is kept in the pane's
// history whatever this says; this decides what reaches the person unasked.
//
// quiet (the default):
//   ❌                                   band, stamp, send-back (modes B and C)
//   ⚠️ tests/build claim, edited this turn band, stamp, nudge (B), send-back (C)
//   ⚠️ generic, or the edit was earlier   pane only
//   ✅ tests/build claim                  band (until the next prompt), stamp
//   ✅ generic                            pane only
// all: every verdict on the band and stamped; every ⚠️ nudged (B) or sent back (C).

import type { ClaimKind, VerdictKind } from './types.ts'

export type Verbosity = 'quiet' | 'all'
export type Visibility = { band: boolean; stamp: boolean; nudge: boolean; sendBackEligible: boolean }

// The parts of a verdict that matter here: the replay passes its own TurnResult
// fields, the mod a Verdict.
export type Shown = { kind: VerdictKind; claim: { kind: ClaimKind } }

export function visibility(verdict: Shown, carriedOver: boolean, verbosity: Verbosity = 'quiet'): Visibility {
  const isSpecific = verdict.claim.kind !== 'generic'
  if (verdict.kind === 'contradicted') return { band: true, stamp: true, nudge: false, sendBackEligible: true }
  if (verdict.kind === 'unverified') {
    const surfaces = verbosity === 'all' || (isSpecific && !carriedOver)
    return { band: surfaces, stamp: surfaces, nudge: surfaces, sendBackEligible: surfaces }
  }
  const shows = verbosity === 'all' || isSpecific
  return { band: shows, stamp: shows, nudge: false, sendBackEligible: false }
}
