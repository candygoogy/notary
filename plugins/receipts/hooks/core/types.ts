// Shared types of the Receipts core. Pure data: no `$`, no engine imports.

export type ClaimKind = 'tests' | 'build' | 'generic'
export type Claim = { sentence: string; kind: ClaimKind; certainty: 'sure' | 'maybe' }

// A command the person declared as a check (the `checks` setting): a test run
// or a build run, matched by its command and any arguments after it.
export type DeclaredCheck = { kind: 'tests' | 'build'; prefix: string }

export type Strength = 'strong' | 'medium' | 'none'
export type Outcome = 'pass' | 'fail' | 'pending' | 'zero-tests'
export type RunInput = { tool: 'Bash' | 'PowerShell'; command: string; isError: boolean; text: string; backgrounded: boolean }
// `subset`: a failing run that ran only part of its suite (a name filter, "N filtered out").
export type Evidence = { strength: Strength; outcome: Outcome; command: string; summary: string; subset?: true }

export type LedgerEntry =
  | { seq: number; at: number; agentId?: string; kind: 'edit'; path: string }
  | { seq: number; at: number; agentId?: string; kind: 'run'; evidence: Evidence }
export type Ledger = { nextSeq: number; entries: LedgerEntry[] }

export type VerdictKind = 'verified' | 'unverified' | 'contradicted'
export type Verdict = { kind: VerdictKind; claim: Claim; evidence: Evidence | null }

export type Mode = 'A' | 'B' | 'C'
export type Action = { sendBack: string | null; nudge: string | null }
