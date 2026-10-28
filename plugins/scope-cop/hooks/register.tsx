import type { EngineInterface as Engine, MatchedHook, Register } from 'claude-code'
import { update } from 'claude-code'

import { lastSeq, shellEditsSince } from './shared/changes-index.ts'
import { compilePatterns, type Pattern } from './shared/glob.ts'
import { waitingNote } from './shared/pane.ts'
import { ARGUMENT_HINT, DESCRIPTION, USAGE, parseScopeCommand } from './core/commands.ts'
import { MODE_TEXT, badPatternsReply, denyReason, scopeChangedReply, scopeClearedReply, scopeLine, scopeSetReply, tellLater, tellNow } from './core/copy.ts'
import { isApproved, namedAtTurnStart, namedOutside } from './core/named.ts'
import { classify, decide, type Ctx, type Mode, type Where } from './core/scope.ts'
import { shellWrites } from './core/shell.ts'
import { bandView } from './ui/band.tsx'
import { paneView } from './ui/pane.tsx'

// Wiring only (design note §3-§6): events in, core calls, state and rows out.
// Scope Cop only tightens: a guard returns the verdict beneath or a deny,
// never an allow, and anything that fails lets the call through.

const MIN_VERSION = [2, 1, 287] as const
const LOG_LIMIT = 200
const OUTSIDE_LIMIT = 50
const TOLD_LIMIT = 200
const PROMPT_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']

// State references: `plugin` and `key` must be literals in a const of this file.
const SCOPE = { plugin: 'scope-cop', key: 'scope' } as const
const SESSION = { plugin: 'scope-cop', key: 'session' } as const
const CURRENT_TURN = { plugin: 'scope-cop', key: 'currentTurn' } as const
const OUTSIDE = { plugin: 'scope-cop', key: 'outside' } as const
const LOG = { plugin: 'scope-cop', key: 'log' } as const
const TOLD = { plugin: 'scope-cop', key: 'told' } as const
const SHELL_SEEN = { plugin: 'scope-cop', key: 'shellSeen' } as const
const PENDING_TELL = { plugin: 'scope-cop', key: 'pendingTell' } as const
const INACTIVE = { plugin: 'scope-cop', key: 'inactive' } as const
// `/scope mode`, for this conversation: over the setting, which can't always be saved.
const MODE = { plugin: 'scope-cop', key: 'mode' } as const
// Files the last answer named outside the scope: approved in the next turn.
const NAMED = { plugin: 'scope-cop', key: 'named' } as const
// Changes' index, read only: its shell writes (shared/changes-index.ts).
const CHANGES_INDEX = { plugin: 'changes', key: 'index' } as const

const PANE = { id: 'scope', title: 'Scope' } as const

type Options = { enabled: boolean; mode: Mode }
// `sweep`: a change during the turn that no call explains (a shell command,
// or the person's own editor): logged in the pane only, never told to Claude.
// `approved`: a file the last answer named, edited in the next turn: in the
// pane only, never told.
type Flag = { at: number; turnId: string; path: string; rel: string | null; tool: string; via: 'tool' | 'shell' | 'sweep'; agentId?: string; outcome: 'flagged' | 'told' | 'denied' | 'approved' }
type Session = { cwd: string; root: string; claudeDir: string; tempDirs: string[]; isWindows: boolean }
type Active = { patterns: string[]; compiled: Pattern[]; session: Session; mode: Mode }

export const register: Register = (on, options) => {
  const opts: Options = {
    enabled: options.enabled !== false,
    mode: options.mode === 'A' || options.mode === 'C' ? options.mode : 'B',
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'scope', description: DESCRIPTION, argumentHint: ARGUMENT_HINT })
    } catch (error) {
      debug($, 'session.start', error)
    }
    if (!opts.enabled) return r
    try {
      const { base, version } = await $.session.version()
      if (isOlder(base ?? version, MIN_VERSION)) {
        await $.state.set(INACTIVE, true)
        $.ui.toast(`Scope Cop needs Claude Code ${MIN_VERSION.join('.')} or later; it is off for this session.`)
        return r
      }
      await $.state.set(SESSION, await sessionOf($))
    } catch (error) {
      debug($, 'session.start', error)
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    try {
      if (opts.enabled) await $.state.set(CURRENT_TURN, e.turnId)
      if (opts.enabled && e.agentId === undefined) await update($, NAMED, (named = null) => namedAtTurnStart(named, e.turnId))
    } catch (error) {
      debug($, 'turn.start', error)
    }
    return r
  })

  // The guard: a file tool, or (mode C) a shell command with a literal target,
  // outside the scope is denied before it runs. Tighten only, fail open.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'deny') return r
    const isEdit = EDIT_TOOLS.includes(e.tool)
    if (!isEdit && !SHELL_TOOLS.includes(e.tool)) return r
    const active = await activeScope($, opts)
    if (active === null || (!isEdit && active.mode !== 'C')) return r
    const input = (e.input ?? {}) as Record<string, unknown>
    if (isEdit) {
      const path = await absolute($, active.session, String(input.file_path ?? input.notebook_path ?? ''))
      if (path === '') return r
      const where = classify(path, ctxOf(active.session), active.compiled)
      if (!decide(active.mode, 'file', where).deny) return r
      const shown = shownPath(where, path)
      await flag($, { path: shown, rel: relOf(where), tool: e.tool, via: 'tool', agentId: e.agentId, outcome: 'denied' })
      return { decision: 'deny', reason: denyReason(shown, active.patterns) }
    }
    const writes = shellWrites(String(input.command ?? ''), e.tool === 'PowerShell' ? 'PowerShell' : 'Bash')
    // Only absolute targets: the shell's own directory can differ from the
    // session's (a `cd` in an earlier call), so a relative one is not judged
    // here; Changes still sees what it wrote.
    for (const target of writes.targets.filter(isAbsolute)) {
      const path = await realPathOf($, target)
      const where = classify(path, ctxOf(active.session), active.compiled)
      if (!decide(active.mode, 'shell-before', where).deny) continue
      const shown = shownPath(where, path)
      await flag($, { path: shown, rel: relOf(where), tool: e.tool, via: 'shell', agentId: e.agentId, outcome: 'denied' })
      return { decision: 'deny', reason: denyReason(shown, active.patterns) }
    }
    return r
  }).catch(($, e, next) => next(e))

  // An edit outside the scope that landed: flagged, and in mode B Claude is
  // told on the call's own result, once per file per turn. A file the last
  // answer named is approved instead: in the pane only.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!EDIT_TOOLS.includes(e.tool)) return r
    if (('deny' in r && r.deny !== undefined) || r.isError === true) return r
    if ((r.result as { staged?: boolean } | undefined)?.staged === true) return r
    try {
      const active = await activeScope($, opts)
      if (active === null) return r
      const call = e as unknown as { file_path?: string; notebook_path?: string; agentId?: string }
      const path = await absolute($, active.session, String(call.file_path ?? call.notebook_path ?? ''))
      if (path === '') return r
      const where = classify(path, ctxOf(active.session), active.compiled)
      const action = decide(active.mode, 'file', where)
      if (!action.flag) return r
      const shown = shownPath(where, path)
      if (await approved($, active, where)) {
        await flag($, { path: shown, rel: relOf(where), tool: e.tool, via: 'tool', agentId: call.agentId, outcome: 'approved' }, false)
        return r
      }
      const tell = action.tell === 'now' && (await firstTell($, shown))
      await flag($, { path: shown, rel: relOf(where), tool: e.tool, via: 'tool', agentId: call.agentId, outcome: tell ? 'told' : 'flagged' })
      if (tell) return { ...r, context: [...(r.context ?? []), tellNow(shown, active.patterns)] }
    } catch (error) {
      debug($, 'tool.call', error)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Shell writes, from Changes' index, at the end of each main-loop turn; then
  // the files the answer named outside the scope, for the next turn.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      await judgeShellWrites($, opts)
      const active = await activeScope($, opts)
      const paths = active === null ? [] : namedOutside(e.answer, active.session.cwd, ctxOf(active.session), active.compiled)
      await $.state.set(NAMED, paths.length === 0 ? null : { paths, turnId: null })
    } catch (error) {
      debug($, 'turn.complete', error)
    }
    return r
  })

  // Each prompt carries the scope (it survives compaction) and, once, what
  // shell commands wrote outside it. The band's list starts again.
  on('prompt.submit', async ($, e, next) => {
    if (!PROMPT_ORIGINS.includes(e.origin.kind)) return next(e)
    const context: string[] = []
    try {
      const active = await activeScope($, opts)
      if (active !== null) {
        await judgeShellWrites($, opts)
        context.push(scopeLine(active.patterns))
        await update($, PENDING_TELL, (pending = null) => {
          if (pending !== null) context.push(pending)
          return null
        })
        await $.state.set(OUTSIDE, [])
      }
    } catch (error) {
      debug($, 'prompt.submit', error)
    }
    return next(context.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...context] })
  }).catch(($, e, next) => next(e))

  // A new conversation (/clear, or the session's end) starts with no scope.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    try {
      await resetConversation($)
    } catch (error) {
      debug($, 'session.end', error)
    }
    return r
  })

  on('command.run', { command: 'scope' }, async ($, e) => {
    try {
      return await runCommand($, opts, e.args)
    } catch (error) {
      debug($, 'command', error)
      return { text: 'Scope Cop could not change the scope. Try again; the debug log has the details.' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => (opts.enabled ? renderBand($, opts, e, next) : next(e)))

  on('ui.render', { component: 'Pane', requestId: 'scope' }, ($, e, next) => (opts.enabled ? renderPane($, opts, e, next) : next(e)))

  // The band's [Details] shows only while the pane is shut.
  on('ui.close', { id: 'scope' }, async ($, e, next) => {
    const r = await next(e)
    $.ui.invalidate('ui.render')
    return r
  }).catch(($, e, next) => next(e))
}

type BandRender = Parameters<MatchedHook<'ui.render', { component: 'AbovePrompt' }>>
type PaneRender = Parameters<MatchedHook<'ui.render', { component: 'Pane'; requestId: 'scope' }>>

async function runCommand($: Engine, opts: Options, args: string): Promise<{ text: string }> {
  const command = parseScopeCommand(args)
  if (command.kind === 'error') return { text: `${command.message}\n${USAGE}` }
  if (!opts.enabled) return { text: 'Scope Cop is turned off. Turn it on in /config.' }
  if (command.kind === 'show') return { text: (await openPane($)) ?? 'Scope pane opened.' }
  if (command.kind === 'mode') {
    // Holds for this conversation. It never writes /config: the plugin
    // directory can't read a settings write, and /config keeps the lasting mode.
    await $.state.set(MODE, command.mode)
    $.ui.invalidate('ui.render')
    return { text: `Scope Cop mode ${MODE_TEXT[command.mode]}. This holds for this conversation; to keep it, change it in /config.` }
  }
  if (command.kind === 'off') {
    await $.state.set(SCOPE, null)
    await $.state.set(NAMED, null)
    await $.state.set(OUTSIDE, [])
    $.ui.invalidate('ui.render')
    return { text: scopeClearedReply() }
  }
  const { value: session = null } = await $.state.get(SESSION)
  const isWindows = session?.isWindows ?? false
  const { value: current = null } = await $.state.get(SCOPE)
  const before = current?.patterns ?? []
  const wanted = command.patterns.map(p => p.trim())
  let next: string[]
  if (command.kind === 'remove') {
    const missing = wanted.filter(p => !before.includes(p))
    if (missing.length > 0) return { text: `Not in the scope: ${missing.join(', ')}. The scope is ${before.length === 0 ? 'not set' : before.join(', ')}.` }
    next = before.filter(p => !wanted.includes(p))
  } else {
    const compiled = compilePatterns(wanted, isWindows)
    if ('errors' in compiled) return { text: badPatternsReply(compiled.errors) }
    next = command.kind === 'add' ? [...before, ...wanted.filter(p => !before.includes(p))] : [...new Set(wanted)]
  }
  if (next.length === 0) {
    await $.state.set(SCOPE, null)
    await $.state.set(NAMED, null)
    $.ui.invalidate('ui.render')
    return { text: scopeClearedReply() }
  }
  // Shell writes made before this scope are not judged against it.
  if (current === null) await $.state.set(SHELL_SEEN, lastSeq(await changesIndex($)))
  await $.state.set(SCOPE, { patterns: next, setAt: await $.clock.now() })
  // Names were judged against the old scope.
  await $.state.set(NAMED, null)
  $.ui.invalidate('ui.render')
  return { text: command.kind === 'set' ? scopeSetReply(next) : scopeChangedReply(next) }
}

// The scope and the session, when Scope Cop is on and a scope is set.
async function activeScope($: Engine, opts: Options): Promise<Active | null> {
  if (!opts.enabled) return null
  const { value: inactive = false } = await $.state.get(INACTIVE)
  if (inactive) return null
  const { value: scope = null } = await $.state.get(SCOPE)
  if (scope === null || scope.patterns.length === 0) return null
  const { value: stored = null } = await $.state.get(SESSION)
  const session = stored ?? (await sessionOf($))
  if (stored === null) await $.state.set(SESSION, session)
  const compiled = compilePatterns(scope.patterns, session.isWindows)
  if ('errors' in compiled) return null
  const { value: mode = null } = await $.state.get(MODE)
  return { patterns: scope.patterns, compiled: compiled.patterns, session, mode: mode ?? opts.mode }
}

// Files shell commands changed, as Changes recorded them (inside git only),
// since the last look: flagged, and queued for Claude in modes B and C, or
// approved when the last answer named them. A sweep is never approved.
async function judgeShellWrites($: Engine, opts: Options): Promise<void> {
  const active = await activeScope($, opts)
  if (active === null) return
  const index = await changesIndex($)
  const { value: seen = 0 } = await $.state.get(SHELL_SEEN)
  const edits = shellEditsSince(index, seen)
  const newest = lastSeq(index)
  if (newest > seen) await $.state.set(SHELL_SEEN, newest)
  const tell: string[] = []
  for (const edit of edits) {
    const path = await realPathOf($, edit.path)
    const where = classify(path, ctxOf(active.session), active.compiled)
    const action = decide(active.mode, 'shell', where)
    if (!action.flag) continue
    const shown = shownPath(where, path)
    if (edit.unattributed) {
      await flag($, { path: shown, rel: relOf(where), tool: edit.tool, via: 'sweep', agentId: edit.agentId, outcome: 'flagged' }, false)
      continue
    }
    if (await approved($, active, where)) {
      await flag($, { path: shown, rel: relOf(where), tool: edit.tool, via: 'shell', agentId: edit.agentId, outcome: 'approved' }, false)
      continue
    }
    await flag($, { path: shown, rel: relOf(where), tool: edit.tool, via: 'shell', agentId: edit.agentId, outcome: action.tell === null ? 'flagged' : 'told' })
    if (action.tell !== null && !tell.includes(shown)) tell.push(shown)
  }
  if (tell.length > 0) await $.state.set(PENDING_TELL, tellLater(tell, active.patterns))
}

// Changes' index, or undefined: Changes may not be installed, and the value
// is never trusted (shared/changes-index.ts reads it defensively).
async function changesIndex($: Engine): Promise<never | undefined> {
  try {
    return (await $.state.get(CHANGES_INDEX))?.value as never
  } catch (error) {
    debug($, 'changes index', error)
    return undefined
  }
}

// Whether an edit outside the scope is one the last answer named (core/named.ts).
async function approved($: Engine, active: Active, where: Where): Promise<boolean> {
  const { value: named = null } = await $.state.get(NAMED)
  return isApproved(named, active.mode, relOf(where), active.session.isWindows)
}

// Logged for the pane; on the band too unless `band` is false.
async function flag($: Engine, f: Omit<Flag, 'at' | 'turnId'>, band = true): Promise<void> {
  const at = await $.clock.now()
  const { value: turnId = null } = await $.state.get(CURRENT_TURN)
  const entry: Flag = { ...f, at, turnId: turnId ?? '' }
  if (entry.agentId === undefined) delete entry.agentId
  await update($, LOG, (log = []) => [...log, entry].slice(-LOG_LIMIT))
  if (band) await update($, OUTSIDE, (outside = []) => [...outside, entry].slice(-OUTSIDE_LIMIT))
  $.ui.invalidate('ui.render')
}

// Mode B tells Claude about a file once per turn.
async function firstTell($: Engine, path: string): Promise<boolean> {
  const { value: turnId = null } = await $.state.get(CURRENT_TURN)
  const key = `${turnId ?? ''}|${path}`
  let first = false
  await update($, TOLD, (told = []) => {
    if (told.includes(key)) return told
    first = true
    return [...told, key].slice(-TOLD_LIMIT)
  })
  return first
}

// The band: one row while a scope is set, then whatever is beneath it.
async function renderBand($: Engine, opts: Options, e: BandRender[1], next: BandRender[2]) {
  if (e.component !== 'AbovePrompt' || e.props.hasSurvey) return next(e)
  const active = await activeScope($, opts)
  if (active === null) return next(e)
  const { value: outside = [] } = await $.state.get(OUTSIDE)
  const newest = [...outside].reverse().find(f => f.rel !== null) ?? null
  const elements = $.ui.resolve(e)
  const mine = bandView(elements, active.patterns, outside, {
    onAllow: newest === null || newest.rel === null ? null : () => void allowFile($, newest.rel!),
    onDetails: (await paneIsUp($)) ? null : () => void openDetails($),
    onDismiss: () => void dismissOutside($),
    onClear: () => void clearScope($),
  })
  if (e.props.maxRows < 2) return mine
  const { Box } = elements
  const below = await next(e)
  return (
    <Box key="scope-cop-above-prompt" flexDirection="column">
      {mine}
      {below}
    </Box>
  )
}

async function renderPane($: Engine, opts: Options, e: PaneRender[1], next: PaneRender[2]) {
  if (e.component !== 'Pane' || e.requestId !== PANE.id) return next(e)
  const { value: scope = null } = await $.state.get(SCOPE)
  const { value: log = [] } = await $.state.get(LOG)
  const { value: mode = null } = await $.state.get(MODE)
  return paneView($.ui.resolve(e), scope?.patterns ?? null, mode ?? opts.mode, log, await $.clock.now(), pattern => void removePattern($, pattern))
}

// [Allow file]: the file joins the scope, and leaves the band's list.
async function allowFile($: Engine, rel: string): Promise<void> {
  try {
    await update($, SCOPE, (scope = null) => (scope === null || scope.patterns.includes(rel) ? scope : { ...scope, patterns: [...scope.patterns, rel] }))
    await update($, OUTSIDE, (outside = []) => outside.filter(f => f.rel !== rel))
    await $.state.set(NAMED, null)
    $.ui.invalidate('ui.render')
  } catch (error) {
    debug($, 'allow', error)
  }
}

async function removePattern($: Engine, pattern: string): Promise<void> {
  try {
    await update($, SCOPE, (scope = null) => {
      if (scope === null) return null
      const patterns = scope.patterns.filter(p => p !== pattern)
      return patterns.length === 0 ? null : { ...scope, patterns }
    })
    await $.state.set(NAMED, null)
    $.ui.invalidate('ui.render')
  } catch (error) {
    debug($, 'remove', error)
  }
}

async function dismissOutside($: Engine): Promise<void> {
  await $.state.set(OUTSIDE, [])
  $.ui.invalidate('ui.render')
}

async function clearScope($: Engine): Promise<void> {
  await $.state.set(SCOPE, null)
  await $.state.set(NAMED, null)
  await $.state.set(OUTSIDE, [])
  $.ui.invalidate('ui.render')
}

async function openPane($: Engine): Promise<string | null> {
  const opened = await $.ui.open({ id: PANE.id, title: PANE.title })
  $.ui.invalidate('ui.render')
  return waitingNote(PANE.title, opened)
}

async function openDetails($: Engine): Promise<void> {
  const note = await openPane($)
  if (note !== null) $.ui.toast(note)
}

async function paneIsUp($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE.id && pane.isPlaced)
  } catch (error) {
    debug($, 'panes', error)
    return false
  }
}

// Where the patterns are anchored (the repository root, else the session's
// folder), and the folders that are always allowed, all as real paths.
async function sessionOf($: Engine): Promise<Session> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const cwd = slashes(await realPathOf($, await $.session.cwd()))
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === '' ? '' : `${slashes(home).replace(/\/$/, '')}/.claude`)
  const temps = [await $.env.get('TEMP'), await $.env.get('TMP'), await $.env.get('TMPDIR'), isWindows ? undefined : '/tmp']
  const tempDirs: string[] = []
  for (const dir of temps) {
    if (dir === undefined || dir === '') continue
    const real = slashes(await realPathOf($, dir)).replace(/\/$/, '')
    if (!tempDirs.includes(real)) tempDirs.push(real)
  }
  return {
    cwd,
    root: await repoRootOf($, cwd),
    claudeDir: config === '' ? '' : slashes(await realPathOf($, config)).replace(/\/$/, ''),
    tempDirs,
    isWindows,
  }
}

// The nearest folder at or above the session's with a `.git`, else the session's.
async function repoRootOf($: Engine, cwd: string): Promise<string> {
  let dir = cwd.replace(/\/+$/, '')
  for (let i = 0; i < 64 && dir !== ''; i++) {
    if (await $.fs.exists(`${dir}/.git`)) return dir
    const up = dir.slice(0, dir.lastIndexOf('/'))
    if (up === dir || up === '' || /^[A-Za-z]:$/.test(dir)) break
    dir = up
  }
  return cwd
}

function ctxOf(session: Session): Ctx {
  return { root: session.root, claudeDir: session.claudeDir, tempDirs: session.tempDirs, isWindows: session.isWindows }
}

// An absolute, real path for a tool's file argument (relative ones are under
// the session's folder).
async function absolute($: Engine, session: Session, path: string): Promise<string> {
  if (path === '') return ''
  const full = isAbsolute(path) ? path : `${session.cwd}/${path}`
  return realPathOf($, full)
}

// A path as the file system names it (8.3 names expanded, links and `..`
// resolved, the real case), with forward slashes. A file that doesn't exist
// yet takes its nearest existing folder's real path.
async function realPathOf($: Engine, path: string): Promise<string> {
  const normal = slashes(path)
  const parts = normal.split('/')
  for (let keep = parts.length; keep > 0; keep--) {
    const head = parts.slice(0, keep).join('/')
    if (head === '' || /^[A-Za-z]:$/.test(head)) break
    try {
      const real = (await $.fs.stat(head, { resolve: true })).realPath
      if (real !== undefined) return [slashes(real), ...parts.slice(keep)].join('/')
    } catch {
      // Not there yet: try the folder above.
    }
  }
  return normal
}

function isAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
}

function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}

function relOf(where: Where): string | null {
  return where.kind === 'out' ? where.rel : null
}

function shownPath(where: Where, path: string): string {
  return where.kind === 'out' && where.rel !== null ? where.rel : path
}

function isOlder(version: string, min: readonly number[]): boolean {
  const parts = version.split(/[.-]/).map(Number)
  for (let i = 0; i < min.length; i++) {
    const part = parts[i] ?? 0
    if (Number.isNaN(part)) return false
    if (part !== min[i]!) return part < min[i]!
  }
  return false
}

async function resetConversation($: Engine): Promise<void> {
  await $.state.set(SCOPE, null)
  await $.state.set(NAMED, null)
  await $.state.set(CURRENT_TURN, null)
  await $.state.set(OUTSIDE, [])
  await $.state.set(LOG, [])
  await $.state.set(TOLD, [])
  await $.state.set(SHELL_SEEN, 0)
  await $.state.set(PENDING_TELL, null)
  await $.state.set(MODE, null)
}

function debug($: Engine, where: string, error: unknown): void {
  $.ui.log(`scope-cop: ${where} failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}
