// Every string Receipts shows the user or hands Claude. Exact copy: tests pin it.

import { CLAIM_CHARS, truncate } from './text.ts'
import type { Verdict } from './types.ts'

export function bandText(v: Verdict): string {
  if (v.kind === 'verified') return `✅ Verified · ${v.evidence?.summary ?? ''}`
  if (v.kind === 'unverified') return '⚠️ Unverified: no receipts · no check ran after the last edit'
  return `❌ Contradicted: "${claimOf(v)}" · ${v.evidence?.summary ?? ''}`
}

export function stampText(v: Verdict): string {
  return `🧾 ${bandText(v)}`
}

export function sendBackText(v: Verdict): string {
  if (v.kind === 'contradicted') {
    return `Receipts: you claimed "${claimOf(v)}", but ${v.evidence?.summary ?? 'a check failed'}. Fix it and verify before claiming success.`
  }
  return `Receipts: you claimed "${claimOf(v)}", but no check ran after your last edit. Run the relevant tests or build before claiming success.`
}

export function nudgeText(v: Verdict): string {
  return `Receipts: your previous claim '${claimOf(v)}' was not verified by any check run after your last edit. Verify before claiming success.`
}

function claimOf(v: Verdict): string {
  return truncate(v.claim.sentence, CLAIM_CHARS)
}
