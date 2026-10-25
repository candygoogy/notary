// The scope-cop state contract. `claude plugin validate` requires it to be
// self-contained (no imports), so the shapes below mirror hooks/core: change
// both together.

export type ScopeCopScope = { patterns: string[]; setAt: number }
export type ScopeCopFlag = {
  at: number
  turnId: string
  // As shown: under the project root, or the full path outside it.
  path: string
  // The path under the root; null for a file outside the project.
  rel: string | null
  tool: string
  // `sweep`: changed during the turn, no call explains it (shell or the person).
  via: 'tool' | 'shell' | 'sweep'
  agentId?: string
  // `approved`: named in Claude's last answer, edited in the next turn (modes A, B).
  outcome: 'flagged' | 'told' | 'denied' | 'approved'
}
// Files Claude's last answer named outside the scope, under the root.
// `turnId`: the turn they hold for, null until the next main-loop turn starts.
export type ScopeCopNamed = { paths: string[]; turnId: string | null }
export type ScopeCopSession = {
  cwd: string
  root: string
  claudeDir: string
  tempDirs: string[]
  isWindows: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'scope-cop': {
      scope: ScopeCopScope | null
      session: ScopeCopSession | null
      currentTurn: string | null
      // Edits outside the scope since the last prompt: the band's list.
      outside: ScopeCopFlag[]
      // Every flag of the conversation, newest last: the pane's log.
      log: ScopeCopFlag[]
      // `${turnId}|${path}` already told to Claude (mode B: once per file per turn).
      told: string[]
      // Changes' index seq judged up to (shell writes are read from it).
      shellSeen: number
      pendingTell: string | null
      inactive: boolean
      // `/scope mode`, for this conversation (over the setting).
      mode: 'A' | 'B' | 'C' | null
      // What the last answer named outside the scope: approved in the next turn.
      named: ScopeCopNamed | null
    }
    // Read only, defensively (shared/changes-index.ts): the index is Changes' own.
    changes: { index: unknown }
  }
}
