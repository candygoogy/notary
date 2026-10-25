// What Claude and the user read. Pure.
//
// Claude-facing text states facts and names the mod: in testing, an
// instruction-like line in a tool result was ignored as untrusted, while this
// factual wording was acknowledged.

const WHO = 'Scope Cop (a mod the user installed)'
const MAX_PATTERNS = 5
const MAX_FILES = 8

export function listPatterns(patterns: readonly string[]): string {
  return cut(patterns, MAX_PATTERNS)
}

// Mode B, on the result of an out-of-scope Edit, Write or NotebookEdit.
export function tellNow(path: string, patterns: readonly string[]): string {
  return `${WHO}: ${path} is outside the scope the user set for this task (${listPatterns(patterns)}). The edit went through. If it was not needed for the task, say so in your answer.`
}

// Mode C: the error Claude reads instead of the tool's result.
export function denyReason(path: string, patterns: readonly string[]): string {
  return `${WHO}: ${path} is outside the scope the user set for this task (${listPatterns(patterns)}). The edit was not made. Ask the user before editing outside the scope; they can widen it with /scope add.`
}

// Modes B and C: shell writes seen after the turn, on the next user prompt.
export function tellLater(paths: readonly string[], patterns: readonly string[]): string {
  return `${WHO}: in your last turn, shell commands changed files outside the scope the user set for this task (${listPatterns(patterns)}): ${cut(paths, MAX_FILES)}. If they were not needed for the task, say so.`
}

// On every user prompt while a scope is set, so it survives compaction.
export function scopeLine(patterns: readonly string[]): string {
  return `${WHO}: for this task the user limited edits to ${listPatterns(patterns)}. Ask before editing other files.`
}

// The /scope command's reply, which Claude reads too.
export function scopeSetReply(patterns: readonly string[]): string {
  return `Scope set: edit only ${listPatterns(patterns)}. Ask before touching other files.`
}

function cut(items: readonly string[], max: number): string {
  const shown = items.length > max ? [...items.slice(0, max), `+${items.length - max} more`] : items
  return shown.join(', ')
}

// ---------------------------------------------------------- the person's

export type FlagView = { path: string; outcome: 'flagged' | 'told' | 'denied' | 'approved' }

export function bandText(patterns: readonly string[], outside: readonly FlagView[]): string {
  const scope = `Scope: ${listPatterns(patterns)}`
  if (outside.length === 0) return `${scope} · nothing outside`
  const paths = [...new Set(outside.map(f => f.path))]
  const blocked = outside.every(f => f.outcome === 'denied')
  const what = blocked ? 'blocked' : paths.length === 1 ? 'edit outside' : 'edits outside'
  return `${scope} · ${paths.length} ${what}: ${cut(paths, 2)}`
}

export const OUTCOME_TEXT: Record<FlagView['outcome'], string> = {
  flagged: 'flagged',
  told: 'flagged, Claude told',
  denied: 'blocked',
  // Named in Claude's last answer, edited in the next turn: not flagged.
  approved: 'approved',
}

export const MODE_TEXT = {
  A: 'A: edits outside the scope are flagged',
  B: 'B: edits outside the scope are flagged, and Claude is told',
  C: 'C: edits outside the scope are blocked, and Claude is told why',
} as const

export function scopeClearedReply(): string {
  return 'Scope cleared: Claude may edit any file again.'
}

export function scopeChangedReply(patterns: readonly string[]): string {
  return patterns.length === 0 ? scopeClearedReply() : scopeSetReply(patterns)
}

export function badPatternsReply(errors: ReadonlyArray<{ pattern: string; error: string }>): string {
  return `Scope not changed. ${errors.map(e => `"${e.pattern}": ${e.error}`).join('; ')}. Patterns are relative to the project root, like src/auth/**.`
}

export const NO_SCOPE_TEXT = 'No scope set. /scope src/auth/** limits Claude to that folder for this conversation.'
