// The engine beneath the plugin for kit tests: each event answered as core
// would, tool calls from a queue the test fills, appended rows and state
// writes recorded. Not a test file itself (no .test. in the name).

import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export type Answer = { result: unknown; text?: string; isError?: true } | { deny: string }

// `aliases` stands for the file system's own names: a key prefix the real path
// spells as its value (an 8.3 short name and its long name). `configRows: false`
// stands for a headless session: no plugin rows in /config.
export function world(
  on: On,
  { expectLogs = false, stopResult = {} as Record<string, unknown>, cwd = 'C:/work', aliases = {} as Record<string, string>, configRows = true } = {},
) {
  const answers: Answer[] = []
  const logs: string[] = []
  const writes: Array<{ key: string; value: unknown }> = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }) as never)
  on('fs.stat', (_$, e) => {
    // The engine hands the path on in the platform's spelling: backslashes on
    // Windows, and elsewhere made absolute first (/home/…/C:/Users/DEV~1/…),
    // so an alias may sit anywhere in it.
    const path = e.path.replace(/\\/g, '/')
    const alias = Object.keys(aliases).find(prefix => path.includes(prefix))
    const realPath = alias === undefined ? path : path.replace(alias, aliases[alias])
    return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath } } as never
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', () => (answers.shift() ?? { result: {}, text: '' }) as never)
  on('classic.Stop', () => stopResult as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  if (!configRows) {
    on('config.set', (_$, e) => {
      throw new Error(`$.config.set: no /config row with key ${e.key}`)
    })
  }
  on('state.set', (_$, e, next) => {
    writes.push({ key: e.key, value: e.value })
    return next(e)
  })
  // A failure inside Receipts goes to the debug log; here it fails the test,
  // unless the test expects one and reads `logs`.
  on('ui.log', (_$, e) => {
    if (!expectLogs) expect(`Receipts logged: ${e.text}`).toBe('')
    logs.push(e.text)
    return { value: undefined } as never
  })
  mock.clock(on, { now: 1_000 })
  const session = mock.session(on)
  const stamps = () =>
    session
      .appended()
      .filter(row => row.message.type === 'system')
      .flatMap(row => (row.message.content as Array<{ text?: string }>).map(block => block.text ?? ''))
  return { answers, writes, stamps, logs }
}

// Ends a turn the way the engine does: Stop with the answer, then, when nothing
// sent it back, turn.complete. Answers whether the stop was blocked.
export async function answer($: Engine, text: string, turnId = 't1'): Promise<string | undefined> {
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: text })
  if (stop.block !== undefined) return stop.block
  await $.turn.complete({ answer: text, durationMs: 5, isAborted: false, turnId, reason: 'answer' })
  return undefined
}

export const edit = { tool: 'Edit', file_path: 'C:/work/src/a.ts', old_string: 'a', new_string: 'b' } as const
export const npmTest = { tool: 'Bash', command: 'npm test' } as const
export const failing: Answer = { result: {}, text: 'Exit code 1\nTests: 1 failed, 41 passed', isError: true }
export const passing: Answer = { result: {}, text: 'Tests: 42 passed' }
export const landed: Answer = { result: {}, text: '' }
export const composer = { kind: 'composer' } as const
