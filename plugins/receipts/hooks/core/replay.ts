// Replays Claude Code transcripts through the core: the release gate's CLI
// (tools/replay) and, later, `/receipts audit` share this one implementation.
// Pure: lines in, verdicts out. Reading files is the caller's.

import { findClaims } from './claims.ts'
import { isVerifiableEdit } from './edits.ts'
import { classify } from './evidence.ts'
import { emptyLedger, recordEdit, recordRun } from './ledger.ts'
import type { ClaimKind, Ledger, RunInput, VerdictKind } from './types.ts'
import { judge } from './verdict.ts'

// A prompt that stages a false claim on purpose (demos, probes): not judged.
const STAGED_PROMPT = /deliberately false|recording a demo|false success claim/i
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

export type ReplayEvent =
  | { at: string; kind: 'prompt'; text: string }
  | { at: string; kind: 'interrupt' }
  | { at: string; kind: 'answer'; text: string }
  | { at: string; kind: 'edit'; path: string; cwd: string }
  | { at: string; kind: 'run'; run: RunInput }

// Why a claim is unverified: an older edit carried over into the turn, a
// passing-looking check Receipts did not recognize, or no check after the last edit.
export type Reason = 'carried-over' | 'unrecognized-check-after' | 'nothing-checked-after'

export type TurnResult = {
  verdict: VerdictKind
  claimKind: ClaimKind
  claim: string
  evidence: string | null
  reason: Reason | null
  lastCommand: string | null
}

export type SessionReplay = { turns: number; claimTurns: number; staged: number; judged: TurnResult[] }

type Row = {
  type?: unknown
  timestamp?: unknown
  isMeta?: unknown
  cwd?: unknown
  toolUseResult?: { backgroundTaskId?: unknown }
  message?: { content?: unknown }
}
type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }

// Turns transcript lines into events. Subagent files contribute edits and runs
// only. Each edit keeps the row's `cwd`, so the edit rule is the live one.
export function makeParser(subagent: boolean) {
  const events: ReplayEvent[] = []
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>()
  function push(line: string): void {
    if (line.trim() === '') return
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      return
    }
    const message = row?.message
    if (message === undefined || message === null || typeof row.timestamp !== 'string') return
    const at = row.timestamp
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    const blocks = Array.isArray(message.content) ? (message.content as Block[]) : null
    if (row.type === 'assistant' && blocks !== null) {
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => String(b.text ?? ''))
        .join('\n')
        .trim()
      if (text !== '' && !subagent) events.push({ at, kind: 'answer', text })
      for (const block of blocks) {
        if (block.type === 'tool_use') pending.set(String(block.id), { name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> })
      }
      return
    }
    if (row.type !== 'user') return
    if (blocks !== null && blocks.some(b => b.type === 'tool_result')) {
      for (const block of blocks) {
        const call = block.type === 'tool_result' ? pending.get(String(block.tool_use_id)) : undefined
        if (call === undefined) continue
        pending.delete(String(block.tool_use_id))
        if (EDIT_TOOLS.has(call.name) && block.is_error !== true) {
          events.push({ at, kind: 'edit', path: String(call.input.file_path ?? call.input.notebook_path ?? ''), cwd })
        } else if (call.name === 'Bash' || call.name === 'PowerShell') {
          events.push({
            at,
            kind: 'run',
            run: {
              tool: call.name,
              command: String(call.input.command ?? ''),
              isError: block.is_error === true,
              text: textOf(block.content),
              backgrounded: call.input.run_in_background === true || typeof row.toolUseResult?.backgroundTaskId === 'string',
            },
          })
        }
      }
      return
    }
    if (subagent || row.isMeta === true) return
    const text = textOf(message.content).trim()
    if (/^\[Request interrupted/.test(text)) events.push({ at, kind: 'interrupt' })
    else if (text !== '' && !/^<(command-|local-command|system-reminder|task-notification)/.test(text)) events.push({ at, kind: 'prompt', text })
  }
  return { push, events }
}

// Replays one session's events (main loop and subagents, in time order) through
// the core, as live judging would have: code edits only, sure claims only.
export function replaySession(events: readonly ReplayEvent[]): SessionReplay {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at))
  const out: SessionReplay = { turns: 0, claimTurns: 0, staged: 0, judged: [] }
  const commands = new Map<number, RunInput>()
  let ledger: Ledger = emptyLedger()
  let turn: { startSeq: number; answer: string | null; interrupted: boolean; staged: boolean } | null = null

  function close(): void {
    if (turn === null) return
    out.turns++
    if (turn.answer === null || turn.interrupted) return
    const claims = findClaims(turn.answer).filter(claim => claim.certainty === 'sure')
    if (claims.length === 0) return
    out.claimTurns++
    if (turn.staged) {
      out.staged++
      return
    }
    const verdict = judge(claims, ledger, turn.startSeq)
    if (verdict === null) return
    const lastRun = ledger.entries.filter(entry => entry.kind === 'run').at(-1)
    out.judged.push({
      verdict: verdict.kind,
      claimKind: verdict.claim.kind,
      claim: verdict.claim.sentence,
      evidence: verdict.evidence?.summary ?? null,
      reason: verdict.kind === 'unverified' ? reasonOf(ledger, turn.startSeq, commands) : null,
      lastCommand: lastRun === undefined ? null : (commands.get(lastRun.seq)?.command ?? null),
    })
  }

  for (const event of sorted) {
    if (event.kind === 'prompt') {
      close()
      turn = { startSeq: ledger.nextSeq, answer: null, interrupted: false, staged: STAGED_PROMPT.test(event.text) }
    } else if (event.kind === 'interrupt') {
      if (turn !== null) turn.interrupted = true
    } else if (event.kind === 'answer') {
      if (turn !== null) turn.answer = event.text
    } else if (event.kind === 'edit') {
      if (isVerifiableEdit(event.path, event.cwd)) ledger = recordEdit(ledger, event.path, 0)
    } else {
      commands.set(ledger.nextSeq, event.run)
      ledger = recordRun(ledger, classify(event.run), 0)
    }
  }
  close()
  return out
}

// Test-pass wording a run printed that Receipts did not take as a check: the
// "unrecognized-check-after" bucket. Only test signals; an echoed "exit 0",
// "0 errors" or a linter's all-clear is no sign of an unrecognized test run.
const PASS_LOOKING = /\b\d+ (?:passed|pass)\b|Tests +\d+ passed|\bpass \d+|\bOK \(/i

export function reasonOf(ledger: Ledger, startSeq: number, commands: ReadonlyMap<number, RunInput>): Reason {
  const edits = ledger.entries.filter(entry => entry.kind === 'edit')
  if (!edits.some(entry => entry.seq >= startSeq)) return 'carried-over'
  const last = edits.at(-1)!
  const after = ledger.entries.filter(entry => entry.kind === 'run' && entry.seq > last.seq)
  if (after.some(entry => PASS_LOOKING.test(commands.get(entry.seq)?.text ?? ''))) return 'unrecognized-check-after'
  return 'nothing-checked-after'
}

// What the person sees for a judged turn under a display policy: a ⚠️ or ❌ in
// the band or stamp (flag), a stamp line of any kind, and a mode-B nudge.
export type Shown = { flag: boolean; stamp: boolean; nudge: boolean }

export const VARIANTS: ReadonlyArray<{ name: string; show: (t: TurnResult) => Shown }> = [
  { name: '(a) as built', show: t => ({ flag: t.verdict !== 'verified', stamp: true, nudge: t.verdict === 'unverified' }) },
  { name: '(b) no carried-over ⚠️', show: t => quiet(t, t.reason === 'carried-over') },
  { name: '(c) (b) + generic ⚠️ pane-only', show: t => quiet(t, t.reason === 'carried-over' || (t.verdict === 'unverified' && t.claimKind === 'generic')) },
  {
    name: '(d) (c) + test/build ✅ only',
    show: t => {
      const shown = quiet(t, t.reason === 'carried-over' || (t.verdict === 'unverified' && t.claimKind === 'generic'))
      return t.verdict === 'verified' && t.claimKind === 'generic' ? { ...shown, stamp: false } : shown
    },
  },
]

// An unverified turn the policy keeps to the pane: no band flag, stamp or nudge.
function quiet(t: TurnResult, paneOnly: boolean): Shown {
  if (t.verdict === 'unverified' && paneOnly) return { flag: false, stamp: false, nudge: false }
  return { flag: t.verdict !== 'verified', stamp: true, nudge: t.verdict === 'unverified' }
}

// Keeps a shown example from saying who or where: the home folder, the user
// name, 8.3 short names, emails and IP addresses. The caller supplies home and
// user (the CLI from `os`, the mod from `$.env`).
export function redact(text: string, home: string, user: string): string {
  let out = text
  for (const h of [home, home.replace(/\\/g, '/')]) if (h.length > 3) out = out.split(h).join('~')
  out = out
    .replace(/\b[A-Z0-9]{1,6}~\d\b/g, '<short>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
  if (user.length > 2) out = out.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>')
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Block[])
      .filter(b => b.type === 'text')
      .map(b => String(b.text ?? ''))
      .join('\n')
  }
  return ''
}
