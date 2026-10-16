// The Changes engine's data model (spec §3.1). Plain JSON data: the index
// lives in `$.state`, the blobs it names live on disk.

import type { Eol } from './diff.ts'

export type Content =
  | { hash: string; size: number; kind: 'text' | 'binary'; eol: Eol; bom: boolean }
  // Clean in git before the change: the blob in `commit` at the record's path.
  // Read with `git cat-file --filters` (so autocrlf applies), restored with
  // `git restore --source=<commit>`, verified with `git hash-object`.
  | { git: { oid: string; commit: string } }
  | { absent: true }
  | { unreadable: 'too-large' | 'io' }

// 'revert' is a revert the person ran from the pane: the disk went from its
// before to its after. It belongs to no turn (turnId REVERT_TURN) and keeps
// each file's history one unbroken chain of transitions.
export type Via = 'tool' | 'shell' | 'unattributed' | 'revert'

export const REVERT_TURN = 'revert'

export type EditRecord = {
  seq: number
  turnId: string
  toolUseId: string
  tool: string
  via: Via
  agentId?: string
  path: string
  key: string
  before: Content
  after: Content
  // When the before capture started and the after capture ended.
  startedAt: number
  at: number
  interleaved?: true
}

export type AgentNode = {
  agentId: string
  turnId: string
  seq: number
  parentToolUseId?: string
  parentAgentId?: string
  label?: string
  // Set when the agent's run completed (its turn.complete); until then its
  // turn is never trimmed, since its edits still arrive.
  endedAt?: number
}

export type TurnRecord = {
  turnId: string
  // Orders turns, background buckets and user actions on one timeline.
  seq: number
  // 'background' is the bucket of an agent whose spawning turn is unknown.
  kind: 'turn' | 'background'
  ordinal: number
  prompt: string
  startedAt: number
  endedAt?: number
  reason?: string
}

export type FileStatus = 'pending' | 'kept' | 'reverted'

// A tool call whose changes were not recorded, and why ("many files
// changed (5123)", "HEAD moved", "took too long"): shown on its turn so the
// timeline never claims more than it knows.
export type UntrackedRecord = { seq: number; turnId: string; toolUseId: string; tool: string; reason: string; at: number }

// Something the person did in the pane, kept in the timeline.
export type UserAction = { seq: number; kind: 'keep' | 'undo-keep' | 'revert'; turnIds: string[]; key: string; path: string; at: number }

export type Index = {
  turns: TurnRecord[]
  edits: EditRecord[]
  agents: AgentNode[]
  actions: UserAction[]
  untracked: UntrackedRecord[]
  // Keyed by statusKey(turnId, key).
  status: Record<string, FileStatus>
  openTurnId?: string
  nextSeq: number
  nextOrdinal: number
  // Per file key, the highest seq of an edit trimmed away: a chain break
  // after it is Claude's dropped history, not the person's change.
  trimmed: Record<string, number>
}

export function emptyIndex(): Index {
  return { turns: [], edits: [], agents: [], actions: [], untracked: [], status: {}, nextSeq: 1, nextOrdinal: 1, trimmed: {} }
}

// NUL, built at runtime: the catalogue's UI scanner flags control characters
// in string literals.
export const KEY_SEP = String.fromCharCode(0)

export function statusKey(turnId: string, key: string): string {
  return turnId + KEY_SEP + key
}

// Whether two captures hold the same content: true, false, or null when it
// can't be told (unreadable, or a git blob id against a SHA-256 hash).
export function sameContent(a: Content, b: Content): boolean | null {
  if ('unreadable' in a || 'unreadable' in b) return null
  if ('absent' in a || 'absent' in b) return 'absent' in a && 'absent' in b
  if ('hash' in a && 'hash' in b) return a.hash === b.hash
  if ('git' in a && 'git' in b) return a.git.oid === b.git.oid
  return null
}
