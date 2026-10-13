import type { EngineInterface as Engine, Hook, Register } from 'claude-code'
import { update } from 'claude-code'

import { emptyIndex, statusKey, type Content, type Index } from './core/model.ts'
import { isCodePath } from './core/noise.ts'
import { relativeTo, shownPath } from './core/paths.ts'
import { unexplained } from './core/sweep.ts'
import { planRevert } from './core/revert-plan.ts'
import {
  addAction,
  addEdit,
  addUntracked,
  appendedSize,
  closeAgent,
  closeTurn,
  fitToSize,
  linkAgent,
  openTurn,
  recordRevert,
  setStatus,
  STATE_BUDGET_CHARS,
  timeline,
  turnFiles,
  type FileChange,
} from './core/timeline.ts'
import { capture, keyOf, storeDirOf, type StoreBudget } from './io/blobs.ts'
import { diffOf, type DiffView } from './io/diffs.ts'
import { cleanBlobOf, gitBudget, repoRootOf } from './io/git.ts'
import { platformOf, type Ports } from './io/ports.ts'
import { revertFile, type RevertOutcome } from './io/restore.ts'
import { shellAfter, shellBefore, type ShellToken, type SnapshotCache } from './io/shell.ts'
import { removeTree, staleSessions, STORE_CAP_BYTES, storeUsage, touch } from './io/store.ts'
import { bandView } from './ui/band.tsx'
import { revertNotice } from './ui/notice.ts'
import { paneView } from './ui/pane.tsx'

// Wiring only (spec §5): events in, core and io calls, state out. Observers
// always hand back what `next` resolved to; a failure here means "this change
// is not tracked", never a blocked or altered tool call.

const MIN_VERSION = [2, 1, 287] as const
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']
const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']
const AGENT_TOOLS: readonly string[] = ['Agent', 'Task']
const TOUCH_EVERY_MS = 60_000
// autoOpen opens the pane only as a sidebar, and only this wide (as /diff does).
const AUTO_OPEN_COLUMNS = 144

// State references: `plugin` and `key` must be literals in a const of this file.
const INDEX = { plugin: 'changes', key: 'index' } as const
const SESSION = { plugin: 'changes', key: 'session' } as const
const BAND = { plugin: 'changes', key: 'band' } as const
const VIEW = { plugin: 'changes', key: 'view' } as const
const PAUSED = { plugin: 'changes', key: 'paused' } as const
const INACTIVE = { plugin: 'changes', key: 'inactive' } as const
const STORE_FULL = { plugin: 'changes', key: 'storeFull' } as const
const AUTO_OPENED = { plugin: 'changes', key: 'autoOpened' } as const
const SHELL_OFF = { plugin: 'changes', key: 'shellOff' } as const

const PANE = { id: 'changes', title: 'Changes' } as const

type Options = { enabled: boolean; band: boolean; autoOpen: boolean; tellClaude: boolean; trackShell: boolean }
type Session = { sessionId: string; store: string; base: string; platform: 'windows' | 'posix'; root: string | null; cwd: string }
type Render = Parameters<Hook<'ui.render'>>

// Per module copy, rebuilt after a hot reload: the turn sweep's baseline (a
// lost one skips that turn's sweep), large-file snapshots by mtime, the last
// touch of the store, and whether the pane opened by itself yet.
let sweepToken: ShellToken | null = null
const snapshotCache: SnapshotCache = new Map()
let lastTouch = 0
// The layout as the last drawing saw it (a render hook can't write state);
// unknown until something draws, and then nothing opens by itself.
let layout: { columns: number; isFullscreen?: boolean } | null = null
// Room left for this session's snapshots, re-measured at each turn.start and
// at the first capture after a load.
const storeBudget: StoreBudget = { used: 0, cap: STORE_CAP_BYTES, full: false }
let storeMeasured = false
// A revert running from the pane: a second press while it runs is refused. A
// reload resets it, and the confirm was disarmed before the revert began.
let reverting = false
// The index's JSON size as of the last full measure (-1: unknown since a
// load), and the saves since; appends are added on, a full measure redone on
// any other change and every FULL_MEASURE_EVERY saves.
let indexSize = -1
let savesSinceMeasure = 0
const FULL_MEASURE_EVERY = 100
const SHELL_OFF_NOTE = "git is slow here; shell changes aren't tracked this session"

export const register: Register = (on, options) => {
  const opts: Options = {
    enabled: options.enabled !== false,
    band: options.band !== false,
    autoOpen: options.autoOpen === true,
    tellClaude: options.tellClaude !== false,
    trackShell: options.trackShell !== false,
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'changes', description: 'Open the Changes pane: what Claude changed, turn by turn, with keep and revert.' })
    } catch (error) {
      debug($, 'session.start', error)
    }
    if (!opts.enabled) return r
    try {
      const { base, version } = await $.session.version()
      if (isOlder(base ?? version, MIN_VERSION)) {
        await $.state.set(INACTIVE, true)
        $.ui.toast(`Changes needs Claude Code ${MIN_VERSION.join('.')} or later; it is off for this session.`)
        return r
      }
      await startSession($, opts)
    } catch (error) {
      debug($, 'session.start', error)
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    const session = await activeSession($, opts)
    if (session === null) return r
    try {
      const at = await $.clock.now()
      await saveIndex($, index => openTurn(index, { turnId: e.turnId, prompt: e.text, at }))
      await $.state.set(BAND, null)
      await touch(portsOf($), session.store, at)
      lastTouch = at
      storeBudget.used = await storeUsage(portsOf($), session.store)
      storeMeasured = true
      sweepToken = null
      if (await shellTracked($, opts, session)) {
        const token = await shellBefore(portsOf($), shellContext(session), snapshotCache)
        if (token !== null && 'slow' in token) await stopShellTracking($)
        else sweepToken = token
      }
    } catch (error) {
      debug($, 'turn.start', error)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const session = await activeSession($, opts)
    if (session === null) return next(e)
    if (EDIT_TOOLS.includes(e.tool)) return recordEditCall($, session, e, next)
    if (SHELL_TOOLS.includes(e.tool) && (await shellTracked($, opts, session))) return recordShellCall($, session, e, next)
    const r = await next(e)
    if (AGENT_TOOLS.includes(e.tool)) {
      try {
        await linkSpawn($, e, r)
      } catch (error) {
        debug($, 'tool.call', error)
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const session = await activeSession($, opts)
    if (session === null) return r
    try {
      const at = await $.clock.now()
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        await saveIndex($, index => closeAgent(index, agentId, at))
        return r
      }
      await saveIndex($, index => closeTurn(index, { turnId: e.turnId, at, reason: e.reason }))
      await sweepTurn($, session, e.turnId)
      await showBand($, opts, session, e.turnId)
    } catch (error) {
      debug($, 'turn.complete', error)
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.state.set(BAND, null)
    } catch (error) {
      debug($, 'prompt.submit', error)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    // Every end, a /clear and a resume included, ends this session's history:
    // its snapshots go, and so does the index, whether or not the host would
    // have kept $.state. A /clear or resume goes on in the same process, so
    // the next hook starts a fresh session (no session.start follows a /clear).
    try {
      const { value: session = null } = await $.state.get(SESSION)
      if (session !== null) await removeTree(portsOf($), session.platform, session.store)
      if (e.reason === 'clear' || e.reason === 'resume') await resetHistory($)
    } catch (error) {
      debug($, 'session.end', error)
    }
    return r
  })

  on('command.run', { command: 'changes' }, async $ => {
    await $.ui.open({ id: PANE.id, title: PANE.title })
    return { text: 'Changes pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => renderBand($, opts, e, next))

  // The prompt hint draws on every surface: it tells autoOpen the layout.
  on('ui.render', { component: 'PromptHint' }, (_$, e, next) => {
    noteLayout(e.viewport)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'changes' }, ($, e, next) => renderPane($, opts, e, next))

  on('ui.focus', { requestId: 'changes' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.origin.kind === 'person' && e.element !== undefined) await focusSelects($, e.element)
    } catch (error) {
      debug($, 'ui.focus', error)
    }
    return r
  }).catch(($, e, next) => next(e))
}

// The loader follows `$` only within this file, so io/ gets closures over it.
function portsOf($: Engine): Ports {
  return {
    fs: {
      read: ((path: string, options?: { as?: 'text' | 'bytes' }) => $.fs.read(path, options as never)) as Ports['fs']['read'],
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      stat: (path, options) => $.fs.stat(path, options),
      list: path => $.fs.list(path),
    },
    process: { run: (argv, init) => $.process.run(argv, init) },
    clock: { now: () => $.clock.now() },
  }
}

// Where snapshots go and which repository the session runs in; old session
// folders a crash left behind are removed.
async function startSession($: Engine, opts: Options): Promise<void> {
  const io = portsOf($)
  // A session already set up (a hot reload) goes on while its snapshots do.
  // One whose folder is gone, or none at all, starts a fresh history: an
  // index is never kept pointing at snapshots that no longer exist.
  const { value: existing = null } = await $.state.get(SESSION)
  if (existing !== null && (await io.fs.exists(existing.store))) {
    const now = await $.clock.now()
    await touch(io, existing.store, now)
    lastTouch = now
    storeBudget.used = await storeUsage(io, existing.store)
    storeMeasured = true
    return
  }
  const sessionId = (await $.session.id()).trim()
  // No id, no folder of our own: nothing is tracked (and nothing deleted).
  if (sessionId === '') return
  await resetHistory($)
  const env = {
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
  }
  const store = storeDirOf(env, sessionId)
  const base = store.slice(0, store.lastIndexOf('/'))
  const platform = platformOf(await $.env.get('OS'))
  const cwd = (await $.session.root()).replace(/\\/g, '/')
  const root = opts.trackShell ? await repoRootOf(io, cwd) : null
  await $.state.set(SESSION, { sessionId, store, base, platform, root, cwd })
  const now = await $.clock.now()
  await touch(io, store, now)
  lastTouch = now
  storeBudget.used = await storeUsage(io, store)
  storeMeasured = true
  for (const dir of await staleSessions(io, base, store, now)) await removeTree(io, platform, dir)
}

// Shell writes are tracked in a repository, with the setting on, until git
// proves slow here.
async function shellTracked($: Engine, opts: Options, session: Session): Promise<boolean> {
  if (!opts.trackShell || session.root === null) return false
  const { value: off = false } = await $.state.get(SHELL_OFF)
  return !off
}

// A git call was killed at its timeout: stop shell tracking for the session
// rather than slow every Bash call; the pane says so.
async function stopShellTracking($: Engine): Promise<void> {
  const { value: off = false } = await $.state.get(SHELL_OFF)
  if (!off) await $.state.set(SHELL_OFF, true)
}

// After a hot reload the snapshot budget is measured again before the first
// capture counts against it.
async function measureStore($: Engine, session: Session): Promise<void> {
  if (storeMeasured) return
  storeBudget.used = await storeUsage(portsOf($), session.store)
  storeMeasured = true
}

async function activeSession($: Engine, opts: Options): Promise<Session | null> {
  if (!opts.enabled) return null
  const { value: inactive = false } = await $.state.get(INACTIVE)
  if (inactive) return null
  const { value: session = null } = await $.state.get(SESSION)
  if (session !== null) return session
  // No session: after a /clear or a resume (no session.start follows), or
  // state the host reset. The first hook sets up a fresh one.
  await startSession($, opts)
  const { value: started = null } = await $.state.get(SESSION)
  return started
}

// An empty history: no index, view or band, no session folder, nothing
// cached. The next hook starts a session again.
async function resetHistory($: Engine): Promise<void> {
  await $.state.set(INDEX, emptyIndex())
  await $.state.set(VIEW, NO_VIEW)
  await $.state.set(BAND, null)
  await $.state.set(SESSION, null)
  await $.state.set(PAUSED, null)
  await $.state.set(STORE_FULL, false)
  indexSize = -1
  savesSinceMeasure = 0
  sweepToken = null
  snapshotCache.clear()
  diffCache.clear()
  storeBudget.used = 0
  storeBudget.full = false
  storeMeasured = false
}

// Writes the index through `update` (parallel subagents' calls retry on a
// version miss), trimmed to fit `$.state`. A change that can't fit is not
// written and tracking shows as paused; the pause lifts once a write fits.
// Answers whether the change was saved.
async function saveIndex($: Engine, change: (index: Index) => Index): Promise<boolean> {
  let fits = true
  let size: number | null = null
  let quick = false
  try {
    await update($, INDEX, (index = emptyIndex()) => {
      const prev = index as Index
      const next = change(prev)
      // Appends are added onto the size known; anything else, an unknown
      // size, a size near the budget, or every FULL_MEASURE_EVERY saves, is
      // measured in full and trimmed to fit.
      const added = indexSize >= 0 && savesSinceMeasure < FULL_MEASURE_EVERY ? appendedSize(prev, next) : null
      if (added !== null && indexSize + added <= STATE_BUDGET_CHARS * 0.9) {
        fits = true
        quick = true
        size = indexSize + added
        return next
      }
      const fitted = fitToSize(next)
      fits = fitted.fits
      quick = false
      const kept = fitted.fits ? fitted.index : prev
      size = JSON.stringify(kept).length
      return kept
    })
    if (size !== null) {
      indexSize = size
      savesSinceMeasure = quick ? savesSinceMeasure + 1 : 0
    }
  } catch (error) {
    fits = false
    indexSize = -1
    debug($, 'save', error)
  }
  const { value: paused = null } = await $.state.get(PAUSED)
  const wanted = fits ? null : 'Tracking is paused: the history is too large to save.'
  if (paused !== wanted) await $.state.set(PAUSED, wanted)
  return fits
}

function shellContext(session: Session) {
  return { root: session.root!, store: session.store, budget: storeBudget }
}

// Once the snapshot budget is spent, the pane says so.
async function noteStoreFull($: Engine): Promise<void> {
  if (!storeBudget.full) return
  const { value: full = false } = await $.state.get(STORE_FULL)
  if (!full) await $.state.set(STORE_FULL, true)
}

type ToolEvent = Parameters<Hook<'tool.call'>>[1]
type ToolNext = Parameters<Hook<'tool.call'>>[2]

// Edit, Write, NotebookEdit: the file before and after, around the call.
async function recordEditCall($: Engine, session: Session, e: ToolEvent, next: ToolNext) {
  const input = e as unknown as { file_path?: string; notebook_path?: string; agentId?: string; tool_use_id: string; tool: string }
  const path = input.file_path ?? input.notebook_path
  if (path === undefined) return next(e)
  const io = portsOf($)
  let key = path
  let before: Content = { unreadable: 'io' }
  const startedAt = await $.clock.now()
  try {
    await measureStore($, session)
    key = await keyOf(io, path, session.platform)
    before = await capture(io, session.store, path, { budget: storeBudget })
    before = await gitBeforeIfLarge(io, session, path, before)
  } catch (error) {
    debug($, 'tool.call', error)
  }
  const r = await next(e)
  try {
    const result = (r as { result?: { staged?: boolean } }).result
    if ('deny' in r && r.deny !== undefined) return r
    if ((r as { isError?: boolean }).isError === true || result?.staged === true) return r
    const after = await capture(io, session.store, path, { budget: storeBudget })
    const at = await $.clock.now()
    await saveIndex($, index =>
      addEdit(index, { toolUseId: input.tool_use_id, tool: input.tool, via: 'tool', path, key, before, after, startedAt, at, ...agentOf(input) }),
    )
    await noteStoreFull($)
    await touchStore($, session, at)
  } catch (error) {
    debug($, 'tool.call', error)
  }
  return r
}

// Bash, PowerShell: what git says the command changed.
async function recordShellCall($: Engine, session: Session, e: ToolEvent, next: ToolNext) {
  const input = e as unknown as { agentId?: string; tool_use_id: string; tool: string }
  const io = portsOf($)
  const ctx = shellContext(session)
  const startedAt = await $.clock.now()
  let token: ShellToken | null = null
  try {
    await measureStore($, session)
    token = await shellBefore(io, ctx, snapshotCache)
  } catch (error) {
    debug($, 'tool.call', error)
  }
  const r = await next(e)
  if (token === null || ('deny' in r && r.deny !== undefined)) return r
  try {
    const result = await shellAfter(io, ctx, token)
    const at = await $.clock.now()
    if ('untracked' in result) {
      // Too big, a HEAD move, or git too slow: said on the turn, nothing
      // recorded; a slow git stops shell tracking for the session.
      if (result.slow) await stopShellTracking($)
      const reason = result.slow ? SHELL_OFF_NOTE : result.untracked
      await saveIndex($, index => addUntracked(index, { toolUseId: input.tool_use_id, tool: input.tool, reason, at, ...agentOf(input) }))
      return r
    }
    if (result.changes.length === 0) return r
    const keyed = await Promise.all(result.changes.map(async c => ({ ...c, key: await keyOf(io, c.path, session.platform) })))
    await saveIndex($, index =>
      keyed.reduce(
        (acc, c) => addEdit(acc, { toolUseId: input.tool_use_id, tool: input.tool, via: 'shell', path: c.path, key: c.key, before: c.before, after: c.after, startedAt, at, ...agentOf(input) }),
        index,
      ),
    )
    await noteStoreFull($)
    await touchStore($, session, at)
  } catch (error) {
    debug($, 'tool.call', error)
  }
  return r
}

// An Agent call launched a subagent: it belongs to the spawning turn (spec §5.1).
async function linkSpawn($: Engine, e: ToolEvent, r: unknown): Promise<void> {
  const result = (r as { result?: { agentId?: unknown } }).result
  if (typeof result?.agentId !== 'string') return
  const agentId = result.agentId
  const input = e as unknown as { tool_use_id: string; agentId?: string; description?: string }
  await saveIndex($, index =>
    linkAgent(index, {
      agentId,
      parentToolUseId: input.tool_use_id,
      ...(input.agentId !== undefined ? { spawnedBy: input.agentId } : {}),
      ...(typeof input.description === 'string' ? { label: input.description } : {}),
    }),
  )
}

// Changes during the turn that no recorded call explains (spec §5.3 step 4).
async function sweepTurn($: Engine, session: Session, turnId: string): Promise<void> {
  const token = sweepToken
  sweepToken = null
  if (token === null || session.root === null) return
  const io = portsOf($)
  const result = await shellAfter(io, shellContext(session), token)
  const at = await $.clock.now()
  const { value: current = emptyIndex() } = await $.state.get(INDEX)
  if ('untracked' in result) {
    if (result.slow) await stopShellTracking($)
    // A call of the turn already said why (a commit, a big checkout): the
    // sweep adds nothing more to say.
    if (!current.untracked.some(u => u.turnId === turnId)) {
      const reason = result.slow ? SHELL_OFF_NOTE : result.untracked
      await saveIndex($, index => addUntracked(index, { turnId, toolUseId: `sweep:${turnId}`, tool: 'turn sweep', reason, at }))
    }
    return
  }
  if (result.changes.length === 0) return
  const keyed = await Promise.all(result.changes.map(async c => ({ ...c, key: await keyOf(io, c.path, session.platform) })))
  const left = unexplained(current as Index, keyed)
  if (left.length === 0) return
  await saveIndex($, index =>
    left.reduce(
      (acc, c) => addEdit(acc, { turnId, toolUseId: `sweep:${turnId}`, tool: 'unknown', via: 'unattributed', path: c.path, key: c.key, before: c.before, after: c.after, startedAt: at, at }),
      index,
    ),
  )
}

// The band speaks only for a turn whose recorded calls changed code: docs,
// notes and changes only the turn sweep found stay quiet.
async function showBand($: Engine, opts: Options, session: Session, turnId: string): Promise<void> {
  const { value: index = emptyIndex() } = await $.state.get(INDEX)
  const bases = session.root === null ? [session.cwd] : [session.root, session.cwd]
  const files = turnFiles(index as Index, turnId).filter(
    f => !f.isNoop && f.edits.some(e => e.via !== 'unattributed') && isCodePath(f.path, bases, session.platform === 'windows'),
  )
  const turn = index.turns.find(t => t.turnId === turnId)
  if (files.length === 0 || turn === undefined) return
  if (opts.band) await $.state.set(BAND, { turnId, ordinal: turn.ordinal, files: files.length })
  // Once per session (in state, so a hot reload doesn't open it again), and
  // only where the pane docks beside the transcript in a wide enough terminal.
  if (opts.autoOpen && layout?.isFullscreen === true && layout.columns >= AUTO_OPEN_COLUMNS) {
    const { value: opened = false } = await $.state.get(AUTO_OPENED)
    if (!opened) {
      await $.state.set(AUTO_OPENED, true)
      await $.ui.open({ id: PANE.id, title: PANE.title })
    }
  }
}

// A file `$.fs` can't read (over 4 MiB) that was clean in git: git holds
// its before, so a revert can still come from there (spec §5.2).
async function gitBeforeIfLarge(io: Ports, session: Session, path: string, before: Content): Promise<Content> {
  if (!('unreadable' in before) || before.unreadable !== 'too-large' || session.root === null) return before
  const rel = relativeTo(session.root, path, session.platform === 'windows')
  if (rel === undefined) return before
  const blob = await cleanBlobOf(io, session.root, rel)
  return blob === null ? before : { git: blob }
}

async function touchStore($: Engine, session: Session, now: number): Promise<void> {
  if (now - lastTouch < TOUCH_EVERY_MS) return
  lastTouch = now
  await touch(portsOf($), session.store, now)
}

// Keep, undo keep and revert, as the pane's buttons call them.
async function keepFile($: Engine, turnId: string, key: string, path: string, kept: boolean): Promise<void> {
  const at = await $.clock.now()
  await saveIndex($, index => addAction(setStatus(index, [{ turnId, key }], kept ? 'kept' : 'pending'), { kind: kept ? 'keep' : 'undo-keep', turnIds: [turnId], key, path, at }))
}

async function revertFromPane(
  $: Engine,
  opts: Pick<Options, 'tellClaude'>,
  ref: { turnId: string; key: string },
  mode: 'turn' | 'turnAndLater',
  acceptOutsideChanges: boolean,
): Promise<{ outcome: RevertOutcome; saved: boolean } | null> {
  const { value: session = null } = await $.state.get(SESSION)
  if (session === null) return null
  const { value: stored = emptyIndex() } = await $.state.get(INDEX)
  const index = stored as Index
  const last = [...index.edits].reverse().find(e => e.key === ref.key)
  if (last === undefined) return null
  const rel = session.root === null ? undefined : relativeTo(session.root, last.path, session.platform === 'windows')
  const ctx = { platform: session.platform, store: session.store, ...(session.root !== null ? { root: session.root } : {}) }
  const outcome = await revertFile(portsOf($), ctx, index, ref, mode, last.path, rel, { acceptOutsideChanges })
  if (!outcome.ok) return { outcome, saved: true }
  // The file changed back: whatever happens to the history, Claude is told.
  const at = await $.clock.now()
  const saved = await saveIndex($, current => recordRevert(current, { key: ref.key, path: last.path, before: outcome.before, after: outcome.after, refs: outcome.refs, at }))
  if (opts.tellClaude) {
    try {
      // The history starts fresh at every /clear, so its turn numbers are
      // the conversation's own; a background agent's bucket has none.
      const turns = outcome.refs
        .map(r => index.turns.find(t => t.turnId === r.turnId))
        .filter(t => t !== undefined && t.kind === 'turn')
        .map(t => `#${t!.ordinal}`)
      const before = turns.length === outcome.refs.length && turns.length > 0 ? `turn ${turns.join(', ')}` : 'an earlier turn'
      const text = `The user reverted ${last.path} to its state before ${before} using the Changes pane. Re-read the file before editing it.`
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    } catch (error) {
      debug($, 'revert note', error)
    }
  }
  return { outcome, saved }
}

function noteLayout(viewport: { columns: number; isFullscreen?: boolean } | undefined): void {
  if (viewport !== undefined) layout = { columns: viewport.columns, ...(viewport.isFullscreen !== undefined ? { isFullscreen: viewport.isFullscreen } : {}) }
}

async function renderBand($: Engine, opts: Options, e: Render[1], next: Render[2]) {
  noteLayout(e.viewport)
  if (!opts.band || e.component !== 'AbovePrompt' || e.props.hasSurvey) return next(e)
  const { value: band = null } = await $.state.get(BAND)
  if (band === null) return next(e)
  const elements = $.ui.resolve(e)
  const mine = bandView(
    elements,
    band,
    () => void openOnTurn($, band.turnId),
    () => void $.state.set(BAND, null),
  )
  // Other mods' bands draw beneath ours, never hidden by it, while there is
  // room for both (Receipts composes the same way).
  if (e.props.maxRows < 2) return mine
  const { Box } = elements
  const below = await next(e)
  return (
    <Box key="changes-above-prompt" flexDirection="column">
      {mine}
      {below}
    </Box>
  )
}

async function openOnTurn($: Engine, turnId: string): Promise<void> {
  await update($, VIEW, (v = NO_VIEW) => ({ ...v, turnId, node: null, confirm: null, offer: null }))
  await $.ui.open({ id: PANE.id, title: PANE.title })
}

async function renderPane($: Engine, opts: Options, e: Render[1], next: Render[2]) {
  if (e.component !== 'Pane' || e.requestId !== PANE.id) return next(e)
  const { value: stored = emptyIndex() } = await $.state.get(INDEX)
  const { value: session = null } = await $.state.get(SESSION)
  const { value: view = NO_VIEW } = await $.state.get(VIEW)
  const { value: paused = null } = await $.state.get(PAUSED)
  const { value: storeFull = false } = await $.state.get(STORE_FULL)
  const index = stored as Index
  const rows = timeline(index)
  const selected = view.turnId ?? rows.find(r => r.kind === 'turn' && r.files.length > 0)?.turn.turnId ?? null
  const files = selected === null ? [] : turnFiles(index, selected, view.node ?? undefined)
  // A draw only reads diffs already computed: the rest show as loading, and
  // one fetch runs off the draw, then draws again.
  const { diffs, missing } = cachedDiffs(files, view.expanded)
  if (session !== null && missing.length > 0 && !fetchingDiffs) {
    fetchingDiffs = true
    $.clock.after(0, () => void fetchDiffs($, session, missing))
  }
  const { value: shellOff = false } = await $.state.get(SHELL_OFF)
  const notes = [
    paused,
    storeFull ? 'Snapshots are paused: this session saved 500 MB of copies. New changes are listed but cannot be reverted.' : null,
    shellOff ? `Shell commands: ${SHELL_OFF_NOTE}.` : null,
  ].filter((n): n is string => n !== null)
  return paneView($.ui.resolve(e), {
    rows,
    selected,
    node: view.node,
    files,
    diffs,
    expanded: view.expanded,
    confirm: view.confirm,
    offer: view.offer,
    notice: view.notice,
    paused: notes.length > 0 ? notes.join(' ') : null,
    cwd: session?.cwd ?? '',
    isWindows: session?.platform === 'windows',
    onSelect: turnId => void selectTurn($, turnId),
    onNode: node => void selectNode($, node),
    onKeep: file => void keepFile($, file.turnId, file.key, file.path, file.status !== 'kept'),
    onRevert: file => void armRevert($, { turnId: file.turnId, key: file.key, path: file.path }, 'turn', false),
    onConfirm: file => void confirmRevert($, opts, file),
    onOffer: () => void armOffer($),
    onShowAll: file => void update($, VIEW, (v = NO_VIEW) => ({ ...v, expanded: [...new Set([...v.expanded, statusKey(file.turnId, file.key)])] })),
  })
}

const NO_VIEW = { turnId: null, node: null, confirm: null, offer: null, notice: null, expanded: [] as string[] }
const MAX_DIFF_FILES = 12
const MAX_DIFF_CHARS = 80_000
const CONFIRM_MS = 5_000

// Diffs by (before, after, all rows?), across draws; dropped on reload.
const diffCache = new Map<string, DiffView>()
// One diff fetch at a time, each within FETCH_BUDGET_MS of git.
let fetchingDiffs = false
const FETCH_BUDGET_MS = 5_000
const LOADING: DiffView = { kind: 'note', text: 'loading diff…' }

type DiffWanted = { id: string; file: FileChange; all: boolean }

function diffId(file: FileChange, all: boolean): string {
  return `${contentId(file.before)}|${contentId(file.after)}|${all ? 'all' : 'cut'}`
}

// What a draw can show now, from the cache alone, and what is still missing.
function cachedDiffs(files: FileChange[], expanded: readonly string[]): { diffs: Record<string, DiffView>; missing: DiffWanted[] } {
  const diffs: Record<string, DiffView> = {}
  const missing: DiffWanted[] = []
  let chars = 0
  for (const [i, file] of files.entries()) {
    if (i >= MAX_DIFF_FILES || chars > MAX_DIFF_CHARS) {
      diffs[file.key] = { kind: 'note', text: 'diff not drawn here: select a step above to narrow the list' }
      continue
    }
    const all = expanded.includes(statusKey(file.turnId, file.key))
    const id = diffId(file, all)
    const view = diffCache.get(id)
    if (view === undefined) {
      missing.push({ id, file, all })
      diffs[file.key] = LOADING
      continue
    }
    diffs[file.key] = view
    if (view.kind === 'diff') chars += view.hunks.length
  }
  return { diffs, missing }
}

// Off the draw: compute what was missing, within one git budget, then draw
// again. A file whose git was too slow is cached as such, never retried in a
// loop; one cut short by the budget is fetched on the next round.
async function fetchDiffs($: Engine, session: Session, wanted: DiffWanted[]): Promise<void> {
  try {
    const io = portsOf($)
    const ctx = { store: session.store, root: session.root, platform: session.platform }
    const budget = gitBudget(await $.clock.now(), FETCH_BUDGET_MS)
    for (const want of wanted) {
      if (budget.over) break
      const view = await diffOf(io, ctx, want.file, want.all, budget)
      if (budget.over && !budget.timedOut) break
      if (diffCache.size > 200) diffCache.clear()
      diffCache.set(want.id, budget.timedOut && view.kind === 'note' ? { kind: 'note', text: 'diff unavailable: git is slow here' } : view)
      if (budget.timedOut) break
    }
  } catch (error) {
    debug($, 'diff', error)
  } finally {
    fetchingDiffs = false
    $.ui.invalidate('ui.render')
  }
}

function contentId(content: Content): string {
  if ('hash' in content) return content.hash
  if ('git' in content) return `git:${content.git.oid}`
  return 'absent' in content ? 'absent' : `unreadable:${content.unreadable}`
}

async function selectTurn($: Engine, turnId: string): Promise<void> {
  await update($, VIEW, (v = NO_VIEW) => (v.turnId === turnId ? v : { ...v, turnId, node: null, confirm: null, offer: null }))
}

async function selectNode($: Engine, node: string | null): Promise<void> {
  await update($, VIEW, (v = NO_VIEW) => (v.node === node ? v : { ...v, node, confirm: null }))
}

// The first press of Revert: plan it against the file as it is now. A plan
// that would land arms the confirmation, naming every turn it reverts; a
// refusal says why and, where one exists, offers the way on.
async function armRevert($: Engine, ask: { turnId: string; key: string; path: string }, mode: 'turn' | 'turnAndLater', accept: boolean): Promise<void> {
  const { value: session = null } = await $.state.get(SESSION)
  if (session === null) return
  const { value: stored = emptyIndex() } = await $.state.get(INDEX)
  const index = stored as Index
  const current = await capture(portsOf($), session.store, ask.path, { store: false })
  const plan = planRevert(index, { turnId: ask.turnId, key: ask.key }, mode, current, { acceptOutsideChanges: accept })
  const name = turnNamer(index)
  const shown = shownPath(session.cwd, ask.path, session.platform === 'windows')
  const now = await $.clock.now()
  const { value: view = NO_VIEW } = await $.state.get(VIEW)
  if (plan.ok) {
    // With a step selected the pane shows that step's diff, but a revert
    // undoes the whole turn's change to the file: the button says so.
    const turns = plan.refs.map(r => name(r.turnId)).join(', ')
    const label = view.node !== null ? `Confirm revert of the whole turn (${turns})` : `Confirm revert (${turns})`
    const notice = plan.widenedTo ? `This also reverts ${plan.widenedTo.map(name).join(', ')}: an agent it started edited ${shown} later.` : null
    await update($, VIEW, (v = NO_VIEW) => ({ ...v, confirm: { ...ask, mode, accept, label, until: now + CONFIRM_MS }, offer: null, notice: notice ?? v.notice }))
    return
  }
  const notice = revertNotice(plan, shown, name)
  const isLink = plan.reason === 'user-changed-between' || plan.reason === 'unverifiable-link' || plan.reason === 'history-trimmed'
  const offer =
    plan.reason === 'changed-since'
      ? { ...ask, mode: 'turnAndLater' as const, accept, label: `Revert with ${plan.otherTurns.map(name).join(', ')}` }
      : isLink
        ? { ...ask, mode, accept: true, label: 'Revert anyway' }
        : null
  await update($, VIEW, (v = NO_VIEW) => ({ ...v, confirm: null, offer, notice }))
}

// A refusal's offer pressed: plan again with its mode, then confirm as usual.
async function armOffer($: Engine): Promise<void> {
  const { value: view = NO_VIEW } = await $.state.get(VIEW)
  if (view.offer === null) return
  await armRevert($, view.offer, view.offer.mode, view.offer.accept)
}

// The second press: the armed revert runs, within its few seconds, for the
// file its button belongs to, and one at a time. The confirmation is disarmed
// before the revert starts, so nothing stays armed if the module reloads
// mid-revert, and the outcome replaces the "Reverting…" line after.
async function confirmRevert($: Engine, opts: Options, file: { turnId: string; key: string }): Promise<void> {
  const { value: view = NO_VIEW } = await $.state.get(VIEW)
  const ask = view.confirm
  if (ask === null || ask.turnId !== file.turnId || ask.key !== file.key) return
  if (reverting) return
  reverting = true
  let notice: string
  try {
    const isLate = (await $.clock.now()) > ask.until
    await update($, VIEW, (v = NO_VIEW) => ({ ...v, confirm: null, offer: null, notice: isLate ? v.notice : 'Reverting…' }))
    if (isLate) {
      notice = 'The confirmation timed out: press Revert again.'
    } else {
      const done = await revertFromPane($, opts, { turnId: ask.turnId, key: ask.key }, ask.mode, ask.accept)
      const { value: session = null } = await $.state.get(SESSION)
      const { value: stored = emptyIndex() } = await $.state.get(INDEX)
      const shown = session === null ? ask.path : shownPath(session.cwd, ask.path, session.platform === 'windows')
      if (done === null) notice = `Nothing to revert for ${shown}.`
      else if (done.outcome.ok && !done.saved) notice = `Reverted ${shown}, but its history couldn't be saved.`
      else notice = revertNotice(done.outcome, shown, turnNamer(stored as Index))
    }
  } catch (error) {
    debug($, 'revert', error)
    notice = 'The revert stopped with an error: check the file before going on.'
  } finally {
    reverting = false
  }
  await update($, VIEW, (v = NO_VIEW) => ({ ...v, confirm: null, offer: null, notice }))
}

function turnNamer(index: Index): (turnId: string) => string {
  return turnId => {
    const turn = index.turns.find(t => t.turnId === turnId)
    return turn === undefined ? 'an earlier turn' : turn.kind === 'background' ? 'a background agent' : `#${turn.ordinal}`
  }
}

// Desktop's first click on an unfocused pane fires only ui.focus: for the
// turn rows and steps, which only select, focus does what the press would.
// Keep, Revert and Confirm always need a real press.
async function focusSelects($: Engine, element: string): Promise<void> {
  if (element.startsWith('select-')) await selectTurn($, element.slice('select-'.length))
  else if (element === 'node-all') await selectNode($, null)
  else if (element.startsWith('node-')) await selectNode($, element.slice('node-'.length))
}

function agentOf(input: { agentId?: string }): { agentId?: string } {
  return input.agentId === undefined ? {} : { agentId: input.agentId }
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

function debug($: Engine, where: string, error: unknown): void {
  $.ui.log(`changes: ${where} failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}
