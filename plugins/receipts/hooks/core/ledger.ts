// The session's ordered record of edits and runs. Pure: every function returns
// a new ledger, so the value can live in `$.state` as it is.

import { lastSeq, shellEditsSince } from '../shared/changes-index.ts'
import type { ChangesIndexView, ShellEdit } from '../shared/changes-index.ts'
import { runnerOf } from './evidence.ts'
import type { ClaimKind, Evidence, Ledger, LedgerEntry } from './types.ts'

export const LEDGER_LIMIT = 500

export function emptyLedger(): Ledger {
  return { nextSeq: 0, entries: [] }
}

export function recordEdit(l: Ledger, path: string, at: number, agentId?: string): Ledger {
  return append(l, agentId === undefined ? { seq: l.nextSeq, at, kind: 'edit', path } : { seq: l.nextSeq, at, agentId, kind: 'edit', path })
}

export function recordRun(l: Ledger, ev: Evidence, at: number, agentId?: string, toolUseId?: string): Ledger {
  return append(l, {
    seq: l.nextSeq,
    at,
    ...(agentId === undefined ? {} : { agentId }),
    ...(toolUseId === undefined || toolUseId === '' ? {} : { toolUseId }),
    kind: 'run',
    evidence: ev,
  })
}

// A file a shell command changed (Changes' record of it). When the run of that
// same tool call is in the ledger already (`sed -i … && npm test`), the run
// checked the change: the edit goes in just before it, taking its seq, and the
// entries from the run on move one seq later. Otherwise it is appended.
export function recordShellEdit(l: Ledger, path: string, at: number, toolUseId: string, agentId?: string): Ledger {
  const i = toolUseId === '' ? -1 : l.entries.findIndex(entry => entry.kind === 'run' && entry.toolUseId === toolUseId)
  if (i < 0) return recordEdit(l, path, at, agentId)
  const seq = l.entries[i]!.seq
  const edit: LedgerEntry = agentId === undefined ? { seq, at, kind: 'edit', path } : { seq, at, agentId, kind: 'edit', path }
  const later = l.entries.slice(i).map(entry => ({ ...entry, seq: entry.seq + 1 }))
  return { nextSeq: l.nextSeq + 1, entries: limit([...l.entries.slice(0, i), edit, ...later]) }
}

// What to record from Changes' index (any value: it is Changes' own), read up
// to seq `seen` so far: the files shell commands changed since, oldest first,
// and the seq it is read up to now. The turn-end sweep's files are left out:
// no call explains them, and they may be the person's own edits. The first
// read (`seen` null), and one after Changes started a fresh index, take where
// it stands and record nothing older.
export function readShellIndex(index: unknown, seen: number | null): { seen: number; edits: ShellEdit[] } {
  const view = index as ChangesIndexView | undefined
  const newest = lastSeq(view)
  if (seen === null || newest < seen) return { seen: newest, edits: [] }
  return { seen: newest, edits: shellEditsSince(view, seen).filter(edit => !edit.unattributed) }
}

// True when the turn that started at `turnStartSeq` has something to answer for:
// an edit made during it, or an earlier edit no passing check had covered yet.
// Known v1 trade-off: any passing check covers an earlier edit, so a medium pass
// (tsc) makes a later turn's "all tests pass" go unjudged rather than ⚠️.
// Whether a code edit was made at or after `seq` (during the turn that started there).
// A verdict on a turn without one is about an edit carried over from earlier.
export function editedSince(l: Ledger, seq: number): boolean {
  return l.entries.some(entry => entry.kind === 'edit' && entry.seq >= seq)
}

export function needsJudging(l: Ledger, turnStartSeq: number): boolean {
  if (l.entries.some(entry => entry.kind === 'edit' && entry.seq >= turnStartSeq)) return true
  const before = l.entries.filter(entry => entry.seq < turnStartSeq)
  const lastEdit = lastEditSeq(before)
  if (lastEdit < 0) return false
  return !before.some(entry => entry.seq > lastEdit && entry.kind === 'run' && entry.evidence.outcome === 'pass' && entry.evidence.strength !== 'none')
}

// The latest pass or fail after the last edit that can back a claim of `kind`:
// a tests claim needs a strong run; a generic claim takes strong or medium; a
// build claim is judged by build, typecheck and lint runs (medium), and a
// passing test run backs it (it compiled) while a failing one says nothing
// about the build.
export function latestQualifyingRun(l: Ledger, kind: ClaimKind, isOutOfScope: (ev: Evidence) => boolean = () => false): Evidence | null {
  const lastEdit = lastEditSeq(l.entries)
  let testPass: Evidence | null = null
  for (let i = l.entries.length - 1; i >= 0; i--) {
    const entry = l.entries[i]!
    if (entry.seq <= lastEdit) break
    if (entry.kind !== 'run') continue
    const { strength, outcome } = entry.evidence
    if (outcome !== 'pass' && outcome !== 'fail') continue
    // A failure in another area than the claim's says nothing about it: look further back.
    if (outcome === 'fail' && isOutOfScope(entry.evidence)) continue
    // A failing run of part of the suite after a full pass of the same runner,
    // with no edit between, is a mutation check or a probe: the pass stands.
    if (outcome === 'fail' && entry.evidence.subset === true && passedBefore(l.entries, i, lastEdit, entry.evidence.command)) continue
    if (kind === 'build') {
      if (strength === 'medium') return entry.evidence
      if (strength === 'strong' && outcome === 'pass' && testPass === null) testPass = entry.evidence
      continue
    }
    if (strength === 'strong' || (strength === 'medium' && kind === 'generic')) return entry.evidence
  }
  return testPass
}

// Whether the same runner passed earlier than entry `index`, after the last edit.
function passedBefore(entries: readonly LedgerEntry[], index: number, lastEdit: number, command: string): boolean {
  const runner = runnerOf(command)
  return entries.slice(0, index).some(entry =>
    entry.seq > lastEdit && entry.kind === 'run' && entry.evidence.outcome === 'pass' && entry.evidence.strength !== 'none' && runnerOf(entry.evidence.command) === runner)
}

function lastEditSeq(entries: readonly LedgerEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.kind === 'edit') return entries[i]!.seq
  return -1
}

function append(l: Ledger, entry: LedgerEntry): Ledger {
  return { nextSeq: l.nextSeq + 1, entries: limit([...l.entries, entry]) }
}

function limit(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.length > LEDGER_LIMIT ? entries.slice(-LEDGER_LIMIT) : entries
}
