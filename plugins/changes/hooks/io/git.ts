// Git, by argv. Thin: each call answers its value or null and never throws;
// what the answers mean is decided in core/git-status.ts and core/revert-plan.ts.

import type { ProcessRunResult } from 'claude-code'

import { parseStatus, type StatusEntry } from '../core/git-status.ts'
import type { Ports } from './ports.ts'

export const GIT_TIMEOUT_MS = 5000

// Global options on every call: never take the index lock from a git the
// person is running, read paths literally (no globs), print paths unquoted.
const LEAD = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false']

// A deadline several git calls share (the shell budget, a diff fetch): each
// call's timeout is the time left, at most GIT_TIMEOUT_MS, and none starts
// once it has passed (`over`). A call killed at its timeout sets `timedOut`:
// git is slow here.
export type GitBudget = { deadline: number; over: boolean; timedOut: boolean }

export function gitBudget(now: number, ms: number): GitBudget {
  return { deadline: now + ms, over: false, timedOut: false }
}

export async function runGit(io: Ports, cwd: string, args: readonly string[], stdin?: string, budget?: GitBudget): Promise<ProcessRunResult | null> {
  let timeoutMs = GIT_TIMEOUT_MS
  if (budget !== undefined) {
    const left = budget.deadline - (await io.clock.now())
    if (left <= 0) {
      budget.over = true
      return null
    }
    timeoutMs = Math.min(timeoutMs, Math.ceil(left))
  }
  const startedAt = budget === undefined ? 0 : await io.clock.now()
  try {
    return await io.process.run(['git', ...LEAD, ...args], {
      cwd,
      env: { LC_ALL: 'C', LANGUAGE: '' },
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
    })
  } catch {
    if (budget !== undefined && (await io.clock.now()) - startedAt >= timeoutMs) budget.timedOut = true
    return null
  }
}

async function line(io: Ports, cwd: string, args: readonly string[], budget?: GitBudget): Promise<string | null> {
  const r = await runGit(io, cwd, args, undefined, budget)
  if (!r || r.exitCode !== 0) return null
  const out = r.stdout.trim()
  return out === '' ? null : out
}

export async function repoRootOf(io: Ports, cwd: string): Promise<string | null> {
  return line(io, cwd, ['rev-parse', '--show-toplevel'])
}

// null on an unborn HEAD (a repository with no commit yet).
export async function headOf(io: Ports, root: string, budget?: GitBudget): Promise<string | null> {
  return line(io, root, ['rev-parse', '--verify', '--quiet', 'HEAD'], budget)
}

// null when git failed or its answer was cut: a partial status would make
// files look clean that are not.
export async function statusOf(io: Ports, root: string, budget?: GitBudget): Promise<Map<string, StatusEntry> | null> {
  const r = await runGit(io, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], undefined, budget)
  if (!r || r.exitCode !== 0 || r.isStdoutTruncated) return null
  return parseStatus(r.stdout)
}

// The blob at `rel` in `commit`, or null when the commit has no such path.
export async function blobAt(io: Ports, root: string, commit: string, rel: string): Promise<string | null> {
  return line(io, root, ['rev-parse', '--verify', '--quiet', `${commit}:${rel}`])
}

// The blob at each `rel` in `commit` (null where the commit has none), from
// one git process. null when git fails.
export async function blobsAt(io: Ports, root: string, commit: string, rels: readonly string[], budget?: GitBudget): Promise<Map<string, string | null> | null> {
  if (rels.length === 0) return new Map()
  const r = await runGit(io, root, ['cat-file', '--batch-check'], rels.map(rel => `${commit}:${rel}`).join('\n') + '\n', budget)
  if (!r || r.exitCode !== 0 || r.isStdoutTruncated) return null
  const lines = r.stdout.split('\n').filter(l => l !== '')
  if (lines.length !== rels.length) return null
  return new Map(rels.map((rel, i) => [rel, / blob \d+$/.test(lines[i]) ? lines[i].split(' ')[0] : null]))
}

// The blob ids the working files would have (clean filters applied), from
// one git process; every path must exist. null when git fails.
export async function hashObjects(io: Ports, root: string, rels: readonly string[], budget?: GitBudget): Promise<Map<string, string> | null> {
  if (rels.length === 0) return new Map()
  const r = await runGit(io, root, ['hash-object', '--stdin-paths'], rels.join('\n') + '\n', budget)
  if (!r || r.exitCode !== 0 || r.isStdoutTruncated) return null
  const lines = r.stdout.split('\n').filter(l => l !== '')
  if (lines.length !== rels.length) return null
  return new Map(rels.map((rel, i) => [rel, lines[i].trim()]))
}

// The blob id the working file would have, clean filters (autocrlf) applied.
export async function hashObject(io: Ports, root: string, rel: string): Promise<string | null> {
  return line(io, root, ['hash-object', '--', rel])
}

// The blob's text as a checkout would write it (smudge filters applied).
export async function filteredText(io: Ports, root: string, commit: string, rel: string, budget?: GitBudget): Promise<string | null> {
  const r = await runGit(io, root, ['cat-file', '--filters', `${commit}:${rel}`], undefined, budget)
  if (!r || r.exitCode !== 0 || r.isStdoutTruncated) return null
  return r.stdout
}


// For a file `$.fs` can't read (over 4 MiB): its blob in HEAD when the
// working file is clean, so a revert can still come from git (spec §5.2).
export async function cleanBlobOf(io: Ports, root: string, rel: string): Promise<{ oid: string; commit: string } | null> {
  const head = await headOf(io, root)
  if (head === null) return null
  const r = await runGit(io, root, ['status', '--porcelain=v1', '-z', '--', rel])
  if (!r || r.exitCode !== 0 || r.stdout !== '') return null
  const oid = await blobAt(io, root, head, rel)
  return oid === null ? null : { oid, commit: head }
}

export async function namesBetween(io: Ports, root: string, from: string, to: string): Promise<string[] | null> {
  const r = await runGit(io, root, ['diff', '--name-only', '-z', '--no-renames', from, to])
  if (!r || r.exitCode !== 0 || r.isStdoutTruncated) return null
  return r.stdout.split('\0').filter(p => p !== '')
}

export async function restoreFrom(io: Ports, root: string, commit: string, rel: string): Promise<boolean> {
  const r = await runGit(io, root, ['restore', `--source=${commit}`, '--worktree', '--', rel])
  return r !== null && r.exitCode === 0
}
