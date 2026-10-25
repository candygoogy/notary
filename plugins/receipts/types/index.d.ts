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
  | { seq: number; at: number; agentId?: string; toolUseId?: string; kind: 'run'; evidence: ReceiptsEvidence }
export type ReceiptsLedger = { nextSeq: number; entries: ReceiptsLedgerEntry[] }
export type ReceiptsVerdict = {
  kind: 'verified' | 'unverified' | 'contradicted'
  claim: ReceiptsClaim
  evidence: ReceiptsEvidence | null
}

export type HistoryItem = { turnId: string; at: number; verdict: ReceiptsVerdict }
export type CurrentTurn = { turnId: string; startSeq: number }
export type Judged = { key: string; verdict: ReceiptsVerdict | null }
// `/receipts` changes for this conversation, over the settings (Options in hooks/register.tsx).
export type Overrides = {
  mode?: 'A' | 'B' | 'C'
  enabled?: boolean
  smartCheck?: boolean
  verbosity?: 'quiet' | 'all'
  checks?: Array<{ kind: 'tests' | 'build'; prefix: string }>
}

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
      // The prompt now running carried the reminder (mode B).
      reminded: boolean
      inactive: boolean
      stamped: string | null
      overrides: Overrides | null
      // Changes' index seq read up to (files shell commands changed are read
      // from it); null until the first turn takes it.
      shellSeen: number | null
    }
    // Read only, defensively (shared/changes-index.ts): the index is Changes' own.
    changes: { index: unknown }
  }
}
