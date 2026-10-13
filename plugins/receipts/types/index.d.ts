// The receipts state contract. `claude plugin validate` requires it to be
// self-contained (no imports), so the shapes below mirror hooks/core/types.ts:
// change both together.

export type ReceiptsClaim = { sentence: string; kind: 'tests' | 'build' | 'generic'; certainty: 'sure' | 'maybe' }
export type ReceiptsEvidence = {
  strength: 'strong' | 'medium' | 'none'
  outcome: 'pass' | 'fail' | 'pending' | 'zero-tests'
  command: string
  summary: string
  subset?: true
}
export type ReceiptsLedgerEntry =
  | { seq: number; at: number; agentId?: string; kind: 'edit'; path: string }
  | { seq: number; at: number; agentId?: string; kind: 'run'; evidence: ReceiptsEvidence }
export type ReceiptsLedger = { nextSeq: number; entries: ReceiptsLedgerEntry[] }
export type ReceiptsVerdict = {
  kind: 'verified' | 'unverified' | 'contradicted'
  claim: ReceiptsClaim
  evidence: ReceiptsEvidence | null
}

export type HistoryItem = { turnId: string; at: number; verdict: ReceiptsVerdict }
export type CurrentTurn = { turnId: string; startSeq: number }
export type Judged = { key: string; verdict: ReceiptsVerdict | null }

declare module 'claude-code' {
  interface PluginState {
    receipts: {
      ledger: ReceiptsLedger
      currentTurn: CurrentTurn | null
      judged: Judged | null
      sentBack: string[]
      last: ReceiptsVerdict | null
      bandHidden: boolean
      history: HistoryItem[]
      pendingNudge: string | null
      inactive: boolean
      stamped: string | null
    }
  }
}
