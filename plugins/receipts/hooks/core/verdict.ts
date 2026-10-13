// Turns claims and the ledger into a verdict, and a verdict into what to do.

import { nudgeText, sendBackText } from './copy.ts'
import { latestQualifyingRun, needsJudging } from './ledger.ts'
import type { Action, Claim, Ledger, Mode, Verdict, VerdictKind } from './types.ts'

const SEVERITY: Record<VerdictKind, number> = { verified: 0, unverified: 1, contradicted: 2 }

// The worst verdict over the claims (contradicted > unverified > verified), or
// null when there is no claim or nothing that needs judging. On a tie the
// tests claim is quoted: "All tests pass." says more than "Fixed.".
export function judge(claims: Claim[], l: Ledger, turnStartSeq: number): Verdict | null {
  if (claims.length === 0 || !needsJudging(l, turnStartSeq)) return null
  let worst: Verdict | null = null
  for (const claim of claims) {
    // "The website tests pass" is no lie because a later `cargo test` failed: a
    // failure counts against a claim only when it can be the claim's own area.
    const evidence = latestQualifyingRun(l, claim.kind, ev => !coversScope(claim.sentence, ev.command))
    const kind: VerdictKind = evidence === null ? 'unverified' : evidence.outcome === 'pass' ? 'verified' : 'contradicted'
    const isWorse = worst === null || SEVERITY[kind] > SEVERITY[worst.kind]
    const isMoreSpecific = worst !== null && SEVERITY[kind] === SEVERITY[worst.kind] && claim.kind === 'tests' && worst.claim.kind !== 'tests'
    if (isWorse || isMoreSpecific) worst = { kind, claim, evidence }
  }
  return worst
}

// Words that qualify tests without naming an area of the code.
const UNSCOPED = new Set([
  'all', 'the', 'unit', 'new', 'existing', 'every', 'our', 'these', 'those', 'my', 'your', 'its', 'their', 'other',
  'remaining', 'relevant', 'related', 'both', 'test', 'full', 'whole', 'entire', 'e2e', 'integration', 'end-to-end',
  'regression', 'failing', 'passing', 'browser', 'visual', 'smoke', 'snapshot', 'and', 'of', 'type', 'site', 'local',
])

// Whether a failing run can be about the area the claim names. A claim that
// names none ("All tests pass") is covered by any run; one that names an area
// ("the website tests", "parser tests") only by a command that mentions it.
function coversScope(sentence: string, command: string): boolean {
  const scope = /\b([a-z][\w-]*)\s+(?:tests?|specs?|suite|build)\b/i.exec(sentence)?.[1]?.toLowerCase()
  if (scope === undefined || UNSCOPED.has(scope) || /^\d/.test(scope)) return true
  const stem = scope.replace(/(?:'s|s)$/, '')
  return command.toLowerCase().includes(stem)
}

export function decide(v: Verdict, mode: Mode, sentBackThisTurn: boolean, stopHookActive: boolean): Action {
  if (v.kind === 'verified' || mode === 'A') return { sendBack: null, nudge: null }
  const canSendBack = !sentBackThisTurn && !stopHookActive
  if (mode === 'C' || v.kind === 'contradicted') return { sendBack: canSendBack ? sendBackText(v) : null, nudge: null }
  return { sendBack: null, nudge: nudgeText(v) }
}
