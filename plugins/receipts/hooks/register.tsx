import type { EngineInterface as Engine, Hook, Register } from 'claude-code'
import { update } from 'claude-code'

import { findClaims } from './core/claims.ts'
import { stampText } from './core/copy.ts'
import { isVerifiableEdit } from './core/edits.ts'
import { classify } from './core/evidence.ts'
import { editedSince, emptyLedger, recordEdit, recordRun } from './core/ledger.ts'
import type { Claim, Mode, Verdict } from './core/types.ts'
import { decide, judge } from './core/verdict.ts'
import { bandStays, visibility } from './core/visibility.ts'
import type { Verbosity, Visibility } from './core/visibility.ts'
import { SMART_MAX_TOKENS, SMART_MODEL, SMART_SYSTEM, isYes } from './smartcheck.ts'
import { ARGUMENT_HINT, DESCRIPTION, USAGE, parseCommand } from './commands.ts'
import { bandView } from './ui/band.tsx'
import { paneView } from './ui/pane.tsx'

// Wiring only (spec §5): events in, core calls, state and rows out. Observers
// always hand back what `next` resolved to; a bug here means "not judged".

const MIN_VERSION = [2, 1, 287] as const
const HISTORY_LIMIT = 200
const SENT_BACK_LIMIT = 50
const NUDGE_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

// State references: `plugin` and `key` must be literals in a const of this file.
const LEDGER = { plugin: 'receipts', key: 'ledger' } as const
const CURRENT_TURN = { plugin: 'receipts', key: 'currentTurn' } as const
const JUDGED = { plugin: 'receipts', key: 'judged' } as const
const SENT_BACK = { plugin: 'receipts', key: 'sentBack' } as const
const LAST = { plugin: 'receipts', key: 'last' } as const
const BAND_HIDDEN = { plugin: 'receipts', key: 'bandHidden' } as const
const HISTORY = { plugin: 'receipts', key: 'history' } as const
const PENDING_NUDGE = { plugin: 'receipts', key: 'pendingNudge' } as const
const REMINDED = { plugin: 'receipts', key: 'reminded' } as const
const INACTIVE = { plugin: 'receipts', key: 'inactive' } as const
const STAMPED = { plugin: 'receipts', key: 'stamped' } as const

const PANE = { id: 'receipts', title: 'Receipts' } as const

type Options = { mode: Mode; stamp: boolean; enabled: boolean; smartCheck: boolean; verbosity: Verbosity }

export const register: Register = (on, options) => {
  const opts: Options = {
    mode: options.mode === 'A' || options.mode === 'C' ? options.mode : 'B',
    stamp: options.stamp !== false,
    enabled: options.enabled !== false,
    smartCheck: options.smartCheck === true,
    verbosity: options.verbosity === 'all' ? 'all' : 'quiet',
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'receipts', description: DESCRIPTION, argumentHint: ARGUMENT_HINT })
    } catch (error) {
      debug($, 'session.start', error)
    }
    if (!opts.enabled) return r
    try {
      const { base, version } = await $.session.version()
      if (isOlder(base ?? version, MIN_VERSION)) {
        await $.state.set(INACTIVE, true)
        $.ui.toast(`Receipts needs Claude Code ${MIN_VERSION.join('.')} or later; it is off for this session.`)
      }
    } catch (error) {
      debug($, 'session.start', error)
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (!(await isActive($, opts))) return r
    try {
      const { value: ledger = emptyLedger() } = await $.state.get(LEDGER)
      await $.state.set(CURRENT_TURN, { turnId: e.turnId, startSeq: ledger.nextSeq })
    } catch (error) {
      debug($, 'turn.start', error)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!(await isActive($, opts))) return r
    try {
      await record($, e, r)
    } catch (error) {
      debug($, 'tool.call', error)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Judges the answer Claude wants to stop on. A contradicted (or, in mode C,
  // unverified) claim is sent back once; the answer that is allowed to stand
  // gets the stamp here, inside the turn: a row appended from turn.complete,
  // after the turn, is not kept in a headless (-p) session's transcript.
  on('classic.Stop', async ($, e, next) => {
    if (!(await isActive($, opts))) return next(e)
    let verdict: Verdict | null = null
    let shown: Visibility | null = null
    let sendBack: string | null = null
    let turnId = ''
    try {
      const turn = (await $.state.get(CURRENT_TURN)).value ?? null
      turnId = turn?.turnId ?? ''
      const startSeq = turn?.startSeq ?? 0
      verdict = await judgeOnce($, opts, turnId, startSeq, e.last_assistant_message ?? '')
      if (verdict !== null) {
        shown = await shownFor($, opts, verdict, startSeq)
        const { value: sent = [] } = await $.state.get(SENT_BACK)
        if (shown.sendBackEligible) sendBack = decide(verdict, opts.mode, sent.includes(turnId), e.stop_hook_active).sendBack
      }
    } catch (error) {
      debug($, 'classic.Stop', error)
    }
    const r = await next(e)
    // A settings Stop hook beneath keeps the turn going (this answer is not the
    // last), or stops the session: either way, no send-back and no stamp.
    if (r.block !== undefined || r.preventContinuation === true) return r
    if (sendBack !== null) {
      await update($, SENT_BACK, (sent = []) => [...sent, turnId].slice(-SENT_BACK_LIMIT))
      return { ...r, block: sendBack }
    }
    if (verdict !== null && shown?.stamp === true && opts.stamp) {
      try {
        await stampOnce($, `${turnId}:${hashText(e.last_assistant_message ?? '')}`, stampText(verdict))
      } catch (error) {
        debug($, 'classic.Stop', error)
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || !(await isActive($, opts))) return r
    try {
      // The turn of a prompt that carried the reminder ends, answered or not.
      const { value: reminded = false } = await $.state.get(REMINDED)
      if (reminded) await $.state.set(REMINDED, false)
      const judged = e.reason === 'answer' ? await settle($, opts, e.turnId, e.answer) : false
      const { value: last = null } = await $.state.get(LAST)
      if (last !== null && !bandStays(last.kind, { at: 'turn-end', reminded, judged })) await $.state.set(LAST, null)
    } catch (error) {
      debug($, 'turn.complete', error)
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (!NUDGE_ORIGINS.includes(e.origin.kind)) return next(e)
    if (!(await isActive($, opts))) {
      try {
        await clearStale($)
      } catch (error) {
        debug($, 'prompt.submit', error)
      }
      return next(e)
    }
    // Taken and cleared in one step, so two prompts never both carry it.
    const taken: { nudge: string | null } = { nudge: null }
    try {
      await update($, PENDING_NUDGE, (pending = null) => {
        taken.nudge = pending
        return null
      })
    } catch (error) {
      debug($, 'prompt.submit', error)
    }
    // Marked before the prompt goes on: its turn may end before `next` resolves.
    if (taken.nudge !== null) await markReminded($, true)
    const r = await next(taken.nudge === null ? e : { ...e, context: [...(e.context ?? []), taken.nudge] })
    if (taken.nudge !== null && r.drop !== undefined) await markReminded($, false)
    try {
      const { value: last = null } = await $.state.get(LAST)
      if (last !== null && !bandStays(last.kind, { at: 'prompt' })) await $.state.set(LAST, null)
    } catch (error) {
      debug($, 'prompt.submit', error)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Review 7: a new conversation (/clear, or the session's end) starts clean.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (!opts.enabled) return r
    try {
      await resetConversation($)
    } catch (error) {
      debug($, 'session.end', error)
    }
    return r
  })

  on('command.run', { command: 'receipts' }, ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => (opts.enabled ? renderBand($, e, next) : next(e)))

  on('ui.render', { component: 'Pane', requestId: 'receipts' }, ($, e, next) => (opts.enabled ? renderPane($, e, next) : next(e)))

  // The band's [Details] shows only while the pane is shut: closing it (the
  // person's close mark or key) draws the band again.
  on('ui.close', { id: 'receipts' }, async ($, e, next) => {
    const r = await next(e)
    $.ui.invalidate('ui.render')
    return r
  }).catch(($, e, next) => next(e))
}

type Render = Parameters<Hook<'ui.render'>>

// `/receipts` opens the pane; its subcommands write the plugin's settings.
async function runCommand($: Engine, args: string): Promise<{ text: string }> {
  const plan = parseCommand(args)
  if (plan.kind === 'usage') return { text: USAGE }
  if (plan.kind === 'open') {
    await openPane($)
    return { text: 'Receipts pane opened.' }
  }
  const result = await $.config.set({ key: plan.key, value: plan.value })
  return 'deny' in result && result.deny !== undefined ? { text: `Receipts could not change ${plan.key}: ${result.deny}` } : { text: plan.done }
}

// The band, for as long as bandStays (core/visibility.ts) keeps it, or [Dismiss].
// It shares the space above the prompt: Receipts' row goes first and whatever
// is beneath (another mod's band, the engine's own) is drawn under it, so
// neither hides the other. With room for one row only, Receipts' row stands.
async function renderBand($: Engine, e: Render[1], next: Render[2]) {
  if (e.component !== 'AbovePrompt' || e.props.hasSurvey) return next(e)
  const { value: last = null } = await $.state.get(LAST)
  const { value: hidden = false } = await $.state.get(BAND_HIDDEN)
  if (last === null || hidden) return next(e)
  const elements = $.ui.resolve(e)
  const mine = bandView(
    elements,
    last,
    (await paneIsUp($)) ? null : () => void openPane($),
    () => void $.state.set(BAND_HIDDEN, true),
  )
  if (e.props.maxRows < 2) return mine
  const { Box } = elements
  const below = await next(e)
  return (
    <Box key="above-prompt" flexDirection="column">
      {mine}
      {below}
    </Box>
  )
}

// Opens the pane, then draws the band again without its [Details].
async function openPane($: Engine): Promise<void> {
  await $.ui.open({ id: PANE.id, title: PANE.title })
  $.ui.invalidate('ui.render')
}

// Whether the pane is open and drawn, by the engine's record: one waiting
// undrawn (a narrow terminal) still needs the band's [Details]. A tab behind
// another pane counts as up: no event says when tabs switch.
async function paneIsUp($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE.id && pane.isPlaced)
  } catch (error) {
    debug($, 'panes', error)
    return false
  }
}

async function renderPane($: Engine, e: Render[1], next: Render[2]) {
  if (e.component !== 'Pane' || e.requestId !== PANE.id) return next(e)
  const { value: history = [] } = await $.state.get(HISTORY)
  return paneView($.ui.resolve(e), history, await $.clock.now())
}

async function isActive($: Engine, opts: Options): Promise<boolean> {
  if (!opts.enabled) return false
  const { value: inactive = false } = await $.state.get(INACTIVE)
  return !inactive
}

// Records a finished tool call in the ledger: an edit that landed, or a shell run.
async function record($: Engine, e: { tool: string; agentId?: string } & Record<string, unknown>, r: Record<string, unknown>): Promise<void> {
  if ('deny' in r && r.deny !== undefined) return
  const at = await $.clock.now()
  if (EDIT_TOOLS.includes(e.tool)) {
    const result = r.result as { staged?: boolean } | undefined
    if (r.isError === true || result?.staged === true) return
    const path = await realPathOf($, String(e.file_path ?? e.notebook_path ?? ''))
    // Only code reopens verification: docs, Claude's files, scratch and build output don't.
    if (!isVerifiableEdit(path, await projectDir($))) return
    await update($, LEDGER, (ledger = emptyLedger()) => recordEdit(ledger, path, at, e.agentId))
    return
  }
  if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return
  const result = r.result as { backgroundTaskId?: string } | undefined
  const evidence = classify({
    tool: e.tool,
    command: String(e.command ?? ''),
    isError: r.isError === true,
    text: typeof r.text === 'string' ? r.text : '',
    backgrounded: typeof result?.backgroundTaskId === 'string' || e.run_in_background === true,
  })
  await update($, LEDGER, (ledger = emptyLedger()) => recordRun(ledger, evidence, at, e.agentId))
}

// Judges an answer once: classic.Stop and turn.complete share the verdict for
// the same text, and an answer rewritten after a send-back is judged afresh.
async function judgeOnce($: Engine, opts: Options, turnId: string, startSeq: number, answer: string): Promise<Verdict | null> {
  const { value: ledger = emptyLedger() } = await $.state.get(LEDGER)
  // The same answer after another run (a rerun after a send-back) is judged afresh.
  const key = `${turnId}:${ledger.nextSeq}:${answer.length}:${answer.slice(0, 64)}`
  const { value: judged = null } = await $.state.get(JUDGED)
  if (judged !== null && judged.key === key) return judged.verdict
  const claims = await confirmClaims($, opts, findClaims(answer))
  const verdict = judge(claims, ledger, startSeq)
  await $.state.set(JUDGED, { key, verdict })
  return verdict
}

// The turn ended with an answer: keep its verdict for the band and the pane,
// and queue the nudge. The stamp was written at classic.Stop. Answers whether
// the turn gave a verdict.
async function settle($: Engine, opts: Options, turnId: string, answer: string): Promise<boolean> {
  const turn = (await $.state.get(CURRENT_TURN)).value ?? null
  const startSeq = turn !== null && turn.turnId === turnId ? turn.startSeq : 0
  const verdict = await judgeOnce($, opts, turnId, startSeq, answer)
  if (verdict === null) return false
  const shown = await shownFor($, opts, verdict, startSeq)
  const at = await $.clock.now()
  // A newer verdict replaces the band's, shown or not.
  await $.state.set(LAST, shown.band ? verdict : null)
  await $.state.set(BAND_HIDDEN, false)
  await update($, HISTORY, (history = []) => [...history, { turnId, at, verdict }].slice(-HISTORY_LIMIT))
  await $.state.set(PENDING_NUDGE, shown.nudge ? decide(verdict, opts.mode, true, true).nudge : null)
  return true
}

// Whether the prompt now entering carried the reminder (a refused one did not).
async function markReminded($: Engine, reminded: boolean): Promise<void> {
  try {
    await $.state.set(REMINDED, reminded)
  } catch (error) {
    debug($, 'prompt.submit', error)
  }
}

// What this verdict shows (core/visibility.ts): carried over when no code edit
// was made during the turn.
async function shownFor($: Engine, opts: Options, verdict: Verdict, startSeq: number): Promise<Visibility> {
  const { value: ledger = emptyLedger() } = await $.state.get(LEDGER)
  return visibility(verdict, !editedSince(ledger, startSeq), opts.verbosity)
}

// Keeps every 'sure' claim. A 'maybe' claim is kept only with the smart check
// on and a model answering YES; an unanswered question or a failure drops it.
async function confirmClaims($: Engine, opts: Options, claims: Claim[]): Promise<Claim[]> {
  const kept: Claim[] = []
  for (const claim of claims) {
    if (claim.certainty === 'sure') {
      kept.push(claim)
      continue
    }
    if (!opts.smartCheck) continue
    try {
      const reply = await $.model.complete({ model: SMART_MODEL, maxTokens: SMART_MAX_TOKENS, system: SMART_SYSTEM, prompt: claim.sentence })
      if (reply.isAnswered && isYes(reply.text)) kept.push(claim)
    } catch (error) {
      debug($, 'smart check', error)
    }
  }
  return kept
}

function isOlder(version: string, min: readonly number[]): boolean {
  const parts = version.split(/[.-]/).map(Number)
  for (let i = 0; i < min.length; i++) {
    const part = parts[i] ?? 0
    if (Number.isNaN(part)) return false
    if (part !== min[i]) return part < min[i]
  }
  return false
}

// A path as the file system names it: Windows 8.3 short names expanded
// (C:\Users\JOHNDO~1 is C:\Users\JohnDoe), links and `..` resolved, the
// real case. Measured on Claude Code 2.1.296. The spelling as given
// when it does not resolve.
async function realPathOf($: Engine, path: string): Promise<string> {
  if (path === '') return path
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

// The session's directory, resolved once per spelling (a /cd brings a new one).
const REAL_DIRS = new Map<string, string>()

async function projectDir($: Engine): Promise<string> {
  const cwd = await $.session.cwd()
  const known = REAL_DIRS.get(cwd)
  if (known !== undefined) return known
  const real = await realPathOf($, cwd)
  REAL_DIRS.set(cwd, real)
  return real
}

// Appends the stamp unless this very answer of this turn was stamped already
// (a hook above that sends the answer back after us makes Stop run again).
async function stampOnce($: Engine, key: string, text: string): Promise<void> {
  const { value: stamped = null } = await $.state.get(STAMPED)
  if (stamped === key) return
  await $.state.set(STAMPED, key)
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
}

// Receipts was turned off: drop a verdict and a nudge left from before.
async function clearStale($: Engine): Promise<void> {
  const { value: nudge = null } = await $.state.get(PENDING_NUDGE)
  if (nudge !== null) await $.state.set(PENDING_NUDGE, null)
  const { value: reminded = false } = await $.state.get(REMINDED)
  if (reminded) await $.state.set(REMINDED, false)
  const { value: last = null } = await $.state.get(LAST)
  if (last !== null) await $.state.set(LAST, null)
}

async function resetConversation($: Engine): Promise<void> {
  await $.state.set(LEDGER, emptyLedger())
  await $.state.set(CURRENT_TURN, null)
  await $.state.set(JUDGED, null)
  await $.state.set(SENT_BACK, [])
  await $.state.set(LAST, null)
  await $.state.set(PENDING_NUDGE, null)
  await $.state.set(REMINDED, false)
  await $.state.set(STAMPED, null)
}

// A short, stable fingerprint of a text (FNV-1a), for dedupe keys.
function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

function debug($: Engine, where: string, error: unknown): void {
  $.ui.log(`receipts: ${where} failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}
