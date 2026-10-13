// A file's diff for the pane: each side's text from the blob store, git (its
// filters applied, so line endings match the working copy) or nothing, then
// core/diff.ts. Thin: what can't be drawn comes back as a note.

import { diffText, limitHunks } from '../core/diff.ts'
import type { Content } from '../core/model.ts'
import { relativeTo } from '../core/paths.ts'
import { loadText } from './blobs.ts'
import { filteredText, type GitBudget } from './git.ts'
import type { Platform, Ports } from './ports.ts'

// As `/diff` draws them: 400 rows per file, then "show all"; no diff of a
// side over 1 MB.
export const MAX_DIFF_ROWS = 400
export const MAX_DIFF_BYTES = 1_000_000

export type DiffView =
  | { kind: 'diff'; hunks: string; added: number; removed: number; shownRows: number; totalRows: number; eolOnly?: true; bomChanged?: true; capped?: true }
  | { kind: 'note'; text: string }

export type DiffContext = { store: string; root: string | null; platform: Platform }

type Side = { text: string } | { note: string }

export async function sideText(io: Ports, ctx: DiffContext, content: Content, path: string, budget?: GitBudget): Promise<Side> {
  if ('absent' in content) return { text: '' }
  if ('unreadable' in content) return { note: content.unreadable === 'too-large' ? 'too large to show' : 'no saved copy to compare' }
  if ('git' in content) {
    const rel = ctx.root === null ? undefined : relativeTo(ctx.root, path, ctx.platform === 'windows')
    if (rel === undefined) return { note: 'no saved copy to compare' }
    const text = await filteredText(io, ctx.root!, content.git.commit, rel, budget)
    if (text === null) return { note: 'no saved copy to compare' }
    return text.length > MAX_DIFF_BYTES ? { note: 'too large to show' } : { text }
  }
  if (content.kind === 'binary') return { note: 'binary file' }
  if (content.size > MAX_DIFF_BYTES) return { note: 'too large to show' }
  const text = await loadText(io, ctx.store, content.hash)
  return text === null ? { note: 'no saved copy to compare' } : { text }
}

// `all` draws every row; otherwise the first MAX_DIFF_ROWS.
// `budget` bounds the git reads of a fetch that diffs several files.
export async function diffOf(io: Ports, ctx: DiffContext, file: { before: Content; after: Content; path: string }, all: boolean, budget?: GitBudget): Promise<DiffView> {
  const before = await sideText(io, ctx, file.before, file.path, budget)
  const after = await sideText(io, ctx, file.after, file.path, budget)
  if ('note' in before) return { kind: 'note', text: before.note }
  if ('note' in after) return { kind: 'note', text: after.note }
  const diff = diffText(before.text, after.text)
  const limited = all ? { hunks: diff.hunks, shownRows: 0, totalRows: 0 } : limitHunks(diff.hunks, MAX_DIFF_ROWS)
  const rows = all ? diff.hunks.split('\n').filter(r => r !== '' && !r.startsWith('@@')).length : limited.shownRows
  const view: DiffView = {
    kind: 'diff',
    hunks: limited.hunks,
    added: diff.added,
    removed: diff.removed,
    shownRows: rows,
    totalRows: all ? rows : limited.totalRows,
  }
  if (diff.eolOnly) view.eolOnly = true
  if (diff.bomChanged) view.bomChanged = true
  if (diff.capped) view.capped = true
  return view
}
