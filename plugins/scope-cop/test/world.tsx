// The engine beneath Scope Cop for kit tests: a Windows session in C:/work (a
// git repository), tool calls and core's permission verdict from queues,
// Changes' index as the test sets it, and the UI's side recorded. Not a test
// file itself (no .test. in the name).

import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export type Answer = { result: unknown; text?: string; isError?: true; context?: string[] } | { deny: string }
export type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

// `configRows: false` stands for a headless session: no plugin rows in /config.
export function world(on: On, { expectLogs = false, configRows = true } = {}) {
  const answers: Answer[] = []
  const verdicts: Verdict[] = []
  const logs: string[] = []
  const settings: Array<{ key: string; value: unknown }> = []
  const opened: string[] = []
  const toasts: string[] = []
  // Changes' index, as another plugin's state: what `$.state.get` reads.
  const changes: { index: unknown } = { index: undefined }
  const env: Record<string, string> = { OS: 'Windows_NT', USERPROFILE: 'C:/Users/me', TEMP: 'C:/Users/me/AppData/Local/Temp' }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.version', () => ({ value: { version: '2.1.310', base: '2.1.310', builtAt: '' } }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('env.get', (_$, e) => ({ value: env[e.name] }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('C:/work/.git') }) as never)
  // Every path resolves to itself (the engine hands it on with backslashes on
  // Windows, and elsewhere made absolute first: /home/…/C:/work/…).
  on('fs.stat', (_$, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/^.*\/(?=[A-Za-z]:\/)/, '')
    return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: path } } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.check', () => (verdicts.shift() ?? { decision: 'allow' }) as never)
  on('tool.call', () => (answers.shift() ?? { result: {}, text: '' }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('state.get', (_$, e, next) => (e.plugin === 'changes' && e.key === 'index' ? ({ value: { value: changes.index, version: 1 } } as never) : next(e)))
  on('command.register', () => ({ value: undefined }) as never)
  on('config.set', (_$, e) => {
    if (!configRows) throw new Error(`$.config.set: no /config row with key ${e.key}`)
    settings.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  // The engine's own drawing where Scope Cop passes: an empty, keyed Box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  // A failure inside Scope Cop goes to the debug log; here it fails the test.
  on('ui.log', (_$, e) => {
    if (!expectLogs) expect(`Scope Cop logged: ${e.text}`).toBe('')
    logs.push(e.text)
    return { value: undefined } as never
  })
  mock.clock(on, { now: 1_000 })
  mock.session(on)
  return { answers, verdicts, logs, settings, opened, toasts, changes, env }
}

export const composer = { kind: 'composer' } as const

export async function start($: Engine) {
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
}

export async function scope($: Engine, args: string): Promise<string> {
  const r = await $.command.run({ command: 'scope', args, origin: composer, presentation: {} as never })
  return r.text ?? ''
}

export async function prompt($: Engine, text = 'go on'): Promise<readonly string[]> {
  const r = await $.prompt.submit({ text, wait: false, origin: composer })
  return (r as { context?: readonly string[] }).context ?? []
}

// The end of a main-loop turn, with Claude's answer.
export async function answer($: Engine, turnId: string, text: string) {
  await $.turn.complete({ answer: text, durationMs: 5, isAborted: false, turnId, reason: 'answer' })
}

// What the band and the pane show, as text.
export async function bandShows($: Engine): Promise<string> {
  const props = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: { skill: '', text: '' } }
  const band = await $.ui.mount({ plugin: 'scope-cop', surface: 'terminal', component: 'AbovePrompt', props: props as never })
  const text = (await band.find({ key: 'scope-cop-band' }))?.text ?? ''
  await band.unmount()
  return text
}

export async function paneShows($: Engine): Promise<string> {
  const props = { title: 'Scope', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } }
  const pane = await $.ui.mount({ plugin: 'scope-cop', surface: 'terminal', component: 'Pane', requestId: 'scope', props: props as never })
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  await pane.unmount()
  return text
}

export const editOf =(path: string, agentId?: string) => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId === undefined ? {} : { agentId }) })
export const checkOf = (path: string) => ({ tool: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } })
export const shellCheck = (command: string, tool: 'Bash' | 'PowerShell' = 'Bash') => ({ tool, input: { command } })
export const shellCall = (command: string, tool: 'Bash' | 'PowerShell' = 'Bash') => ({ tool, command })
// The refusal a tool.call result carries, if any.
export const refusalOf = (r: unknown) => (r as { deny?: string }).deny

// An index as Changes keeps it: only the fields Scope Cop reads.
export const shellEdit = (seq: number, path: string, via = 'shell') => ({ seq, turnId: 't1', toolUseId: `u${seq}`, tool: via === 'shell' ? 'Bash' : 'unknown', via, path, key: path.toLowerCase() })
