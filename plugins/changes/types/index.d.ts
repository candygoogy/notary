// The changes state contract. `claude plugin validate` requires it to be
// self-contained (no imports), so the shapes below mirror hooks/core/model.ts:
// change both together.

export type ChangesEol = 'lf' | 'crlf' | 'mixed' | 'none'
export type ChangesContent =
  | { hash: string; size: number; kind: 'text' | 'binary'; eol: ChangesEol; bom: boolean }
  | { git: { oid: string; commit: string } }
  | { absent: true }
  | { unreadable: 'too-large' | 'io' }

export type ChangesEdit = {
  seq: number
  turnId: string
  toolUseId: string
  tool: string
  via: 'tool' | 'shell' | 'unattributed' | 'revert'
  agentId?: string
  path: string
  key: string
  before: ChangesContent
  after: ChangesContent
  startedAt: number
  at: number
  interleaved?: true
}
export type ChangesAgent = { agentId: string; turnId: string; seq: number; parentToolUseId?: string; parentAgentId?: string; label?: string; endedAt?: number }
export type ChangesTurn = { turnId: string; seq: number; kind: 'turn' | 'background'; ordinal: number; prompt: string; startedAt: number; endedAt?: number; reason?: string }
export type ChangesUntracked = { seq: number; turnId: string; toolUseId: string; tool: string; reason: string; at: number }
export type ChangesAction = { seq: number; kind: 'keep' | 'undo-keep' | 'revert'; turnIds: string[]; key: string; path: string; at: number }
export type ChangesIndex = {
  turns: ChangesTurn[]
  edits: ChangesEdit[]
  agents: ChangesAgent[]
  actions: ChangesAction[]
  untracked: ChangesUntracked[]
  status: Record<string, 'pending' | 'kept' | 'reverted'>
  openTurnId?: string
  nextSeq: number
  nextOrdinal: number
  trimmed: Record<string, number>
}

// Where this session keeps its snapshots, and the repository it runs in.
// `token` and `writer`: this process's claim on the conversation's kept
// history (only the lease holder writes it); `launchedAt`: turns that started
// before it came from an earlier launch of the conversation.
export type ChangesSession = {
  sessionId: string
  store: string
  base: string
  platform: 'windows' | 'posix'
  root: string | null
  cwd: string
  token: string
  writer: boolean
  launchedAt: number
}

// The band after a turn that changed code; null hides it.
export type ChangesBand = { turnId: string; ordinal: number; files: number } | null

// A revert as the pane arms it: which change, how, and the words on its button.
export type ChangesRevertAsk = { turnId: string; key: string; path: string; mode: 'turn' | 'turnAndLater'; accept: boolean; label: string }

// What the pane shows: the selected turn and node, a revert waiting for its
// confirmation (until `until`), a follow-up the last refusal offers, the last
// outcome line, the files whose diffs show every line, and Revert all's
// confirmation and per-file offers.
export type ChangesView = {
  turnId: string | null
  node: string | null
  confirm: (ChangesRevertAsk & { until: number }) | null
  offer: ChangesRevertAsk | null
  notice: string | null
  expanded: string[]
  // Revert all for one turn, waiting for its confirmation (until `until`).
  confirmAll: { turnId: string; label: string; until: number } | null
  // After Revert all, each skipped file's own way on, shown on its row.
  offers: ChangesRevertAsk[]
}

declare module 'claude-code' {
  interface PluginState {
    changes: {
      index: ChangesIndex
      session: ChangesSession | null
      band: ChangesBand
      view: ChangesView
      paused: string | null
      storeFull: boolean
      autoOpened: boolean
      shellOff: boolean
      shellUnseen: boolean
      // A line for the pane about the kept history: unreadable, or read-only here.
      historyNote: string | null
      inactive: boolean
    }
  }
}
