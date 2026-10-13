// What a shell command changed, read from git before and after it (spec
// §5.3). Thin: core/git-status.ts decides the candidates; this reads git,
// stats and snapshots files, and drops candidates whose content is the same.
//
// Bounded, because the Bash result waits on it: one wall-clock budget for
// before and after together, a cap on dirty files and on candidates, git
// batched (one process for all blobs, one for all hashes). Past a bound, or
// when HEAD moved (a checkout, reset, pull or commit), the call is reported
// untracked and nothing about it is recorded.

import { changedPaths, dirtyPaths, type FileStamp, type ShellSnapshot } from '../core/git-status.ts'
import { sameContent, type Content } from '../core/model.ts'
import { capture, type StoreBudget } from './blobs.ts'
import { blobsAt, gitBudget, hashObjects, headOf, statusOf, type GitBudget } from './git.ts'
import type { Ports } from './ports.ts'

// Per call: dirty files snapshotted, bytes read, candidates looked at.
export const MAX_SHELL_FILES = 200
export const MAX_SHELL_BYTES = 50 * 1024 * 1024
export const MAX_SHELL_CANDIDATES = 200
// Before and after together, measured on the clock; the command's own run
// time between them is not counted.
export const SHELL_BUDGET_MS = 2_000
// Dirty files up to this size are re-read on every call, so their stamp
// carries a hash, up to HASH_BUDGET_BYTES of them per call; the rest are
// snapshotted once per (mtime, size) and compared by stat alone.
export const HASH_STAMP_BYTES = 1024 * 1024
export const HASH_BUDGET_BYTES = 8 * 1024 * 1024

// `budget`: the session's room for new snapshots (blobs.ts StoreBudget).
export type ShellContext = { root: string; store: string; budget?: StoreBudget }

// Snapshots of larger dirty files by path, kept by register across calls.
export type SnapshotCache = Map<string, { mtimeMs: number; size: number; content: Content }>

// `hashed`: the paths whose stamps carry a hash; shellAfter hashes the same ones.
// `spentMs`: the budget the before half used. `slow`: a git call was killed
// at its timeout, so git is slow here and shell tracking should stop.
export type ShellToken =
  | { snapshot: ShellSnapshot; befores: Map<string, Content>; hashed: Set<string>; spentMs: number }
  | { untracked: string; slow?: true }

export type ShellChange = { rel: string; path: string; before: Content; after: Content }

export type ShellResult = { changes: ShellChange[] } | { untracked: string; slow?: true }

const TOO_LONG = 'took too long to read'
const SLOW = 'git is slow here'

// Why git answered nothing: slow (a call was killed), out of budget, or failed.
function gitFailed(budget: GitBudget, otherwise: string | null): { untracked: string; slow?: true } | null {
  if (budget.timedOut) return { untracked: SLOW, slow: true }
  if (budget.over) return { untracked: TOO_LONG }
  return otherwise === null ? null : { untracked: otherwise }
}

const absolute = (ctx: ShellContext, rel: string) => `${ctx.root.replace(/[\\/]$/, '')}/${rel}`

// Before the command: HEAD, status, and a stamp and snapshot of every dirty
// path. null when git can't answer (nothing tracked, nothing said).
export async function shellBefore(io: Ports, ctx: ShellContext, cache: SnapshotCache = new Map()): Promise<ShellToken | null> {
  const startedAt = await io.clock.now()
  const budget = gitBudget(startedAt, SHELL_BUDGET_MS)
  const status = await statusOf(io, ctx.root, budget)
  if (status === null) return gitFailed(budget, null)
  const head = (await headOf(io, ctx.root, budget)) ?? ''
  if (budget.timedOut || budget.over) return gitFailed(budget, null)
  const stamps = new Map<string, FileStamp | null>()
  const dirty = dirtyPaths({ head, status, stamps })
  if (dirty.length > MAX_SHELL_FILES) return { untracked: `too many uncommitted files to follow (${dirty.length})` }
  const befores = new Map<string, Content>()
  const hashed = new Set<string>()
  let bytes = 0
  let hashedBytes = 0
  for (const rel of dirty) {
    if ((await io.clock.now()) - startedAt > SHELL_BUDGET_MS) return { untracked: TOO_LONG }
    const path = absolute(ctx, rel)
    const stat = await statOf(io, path)
    if (stat === null) {
      stamps.set(rel, null)
      befores.set(rel, { absent: true })
      continue
    }
    if (bytes + stat.size > MAX_SHELL_BYTES) {
      stamps.set(rel, stat)
      befores.set(rel, { unreadable: 'io' })
      continue
    }
    bytes += stat.size
    const reread = stat.size <= HASH_STAMP_BYTES && hashedBytes + stat.size <= HASH_BUDGET_BYTES
    if (reread) {
      hashed.add(rel)
      hashedBytes += stat.size
    }
    const content = reread ? await capture(io, ctx.store, path, { budget: ctx.budget }) : await cachedSnapshot(io, ctx, path, stat, cache)
    befores.set(rel, content)
    stamps.set(rel, reread ? stampOf(stat, content) : stat)
  }
  return { snapshot: { head, status, stamps }, befores, hashed, spentMs: (await io.clock.now()) - startedAt }
}

// After the command: its changes, each with its before and its after, or
// why it is not tracked.
export async function shellAfter(io: Ports, ctx: ShellContext, token: ShellToken): Promise<ShellResult> {
  if ('untracked' in token) return token
  const startedAt = await io.clock.now()
  const left = Math.max(0, SHELL_BUDGET_MS - token.spentMs)
  const budget = gitBudget(startedAt, left)
  const overBudget = async () => (await io.clock.now()) - startedAt > left
  const status = await statusOf(io, ctx.root, budget)
  if (status === null) return gitFailed(budget, 'git did not answer')!
  const head = (await headOf(io, ctx.root, budget)) ?? ''
  if (budget.timedOut || budget.over) return gitFailed(budget, 'git did not answer')!
  const before = token.snapshot
  if (head !== before.head) return { untracked: 'HEAD moved (a checkout, reset, pull or commit)' }

  const stamps = new Map<string, FileStamp | null>()
  for (const rel of dirtyPaths(before)) {
    if (await overBudget()) return { untracked: TOO_LONG }
    const path = absolute(ctx, rel)
    const stat = await statOf(io, path)
    if (stat === null) stamps.set(rel, null)
    else if (token.hashed.has(rel)) stamps.set(rel, stampOf(stat, await capture(io, ctx.store, path, { store: false })))
    else stamps.set(rel, stat)
  }

  const candidates = changedPaths(before, { head, status, stamps })
  if (candidates.length > MAX_SHELL_CANDIDATES) return { untracked: `many files changed (${candidates.length})` }

  // The befores of files that were clean: their blobs in HEAD, in one process.
  const fromHead = candidates.filter(c => c.beforeFrom === 'head').map(c => c.path)
  const blobs = before.head === '' ? new Map<string, string | null>() : await blobsAt(io, ctx.root, before.head, fromHead, budget)
  if (blobs === null) return gitFailed(budget, 'git did not answer')!

  const afters = new Map<string, Content>()
  for (const candidate of candidates) {
    if (await overBudget()) return { untracked: TOO_LONG }
    afters.set(candidate.path, await capture(io, ctx.store, absolute(ctx, candidate.path), { budget: ctx.budget }))
  }

  // A clean file whose content still matches its old blob did not change (an
  // index-only change named it): one process hashes every such file.
  const toHash = fromHead.filter(rel => (blobs.get(rel) ?? null) !== null && !('absent' in afters.get(rel)!))
  const hashes = await hashObjects(io, ctx.root, toHash, budget)
  if (hashes === null) return gitFailed(budget, 'git did not answer')!

  const changes: ShellChange[] = []
  for (const candidate of candidates) {
    const rel = candidate.path
    const after = afters.get(rel)!
    let was: Content
    if (candidate.beforeFrom === 'snapshot') {
      was = token.befores.get(rel) ?? { unreadable: 'io' }
    } else {
      const oid = blobs.get(rel) ?? null
      was = oid === null ? { absent: true } : { git: { oid, commit: before.head } }
      if (oid !== null && hashes.get(rel) === oid) continue
    }
    if (sameContent(was, after) === true) continue
    changes.push({ rel, path: absolute(ctx, rel), before: was, after })
  }
  return { changes }
}

async function statOf(io: Ports, path: string): Promise<FileStamp | null> {
  try {
    if (!(await io.fs.exists(path))) return null
    const stat = await io.fs.stat(path)
    return stat.kind === 'file' ? { size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

async function cachedSnapshot(io: Ports, ctx: ShellContext, path: string, stat: FileStamp, cache: SnapshotCache): Promise<Content> {
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.content
  const content = await capture(io, ctx.store, path, { budget: ctx.budget })
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, content })
  return content
}

function stampOf(stat: FileStamp, content: Content): FileStamp {
  return 'hash' in content ? { ...stat, hash: content.hash } : stat
}
