// The engine beneath Changes for kit tests. Not a test file itself (no .test.
// in the name).

import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine beneath Changes for kit tests: an in-memory file system (the kit
// has none), the session's identity, tool calls that change files the way
// the real tools do, and every state write recorded.
export function world(on: On, { trackShell = false, expectLogs = false } = {}) {
  const logs: string[] = []
  const files = new Map<string, string>()
  const writes: Array<{ key: string; value: unknown }> = []
  const runs: Array<readonly string[]> = []
  // The tests' paths are Windows ones (C:/work/…). On Linux and macOS the
  // engine first makes them absolute (/home/…/C:/work/…), so that prefix goes.
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^.*\/(?=[A-Za-z]:\/)/, '')
  const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.root', () => ({ value: 'C:/work' }) as never)
  on('session.version', () => ({ value: { version: '2.1.296', base: '2.1.296', builtAt: '' } }) as never)
  on('env.get', (_$, e) => ({ value: ({ USERPROFILE: 'C:/Users/me', OS: 'Windows_NT' } as Record<string, string>)[e.name] }) as never)
  on('fs.exists', (_$, e) => ({ value: files.has(norm(e.path)) || [...files.keys()].some(k => k.startsWith(norm(e.path) + '/')) }) as never)
  on('fs.stat', (_$, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) return { deny: 'ENOENT' } as never
    return { value: { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: 1, isLink: false, ...(e.resolve ? { realPath: norm(e.path) } : {}) } } as never
  })
  on('fs.read', (_$, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) return { deny: 'ENOENT' } as never
    return { value: e.as === 'bytes' ? { base64: b64(text) } : text } as never
  })
  on('fs.write', (_$, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined } as never
  })
  on('fs.list', () => ({ value: [] }) as never)
  const opened: string[] = []
  // The engine's record of the open panes, as `$.ui.panes()` lists them.
  const panes = new Map<string, { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>()
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    panes.set(e.id, { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [...panes.values()] }) as never)
  // PowerShell as the restore runs it: replace or move the temp file into
  // place, remove a file. Git and everything else fail (no repository here).
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    const env = e.init?.env ?? {}
    const script = e.argv.join(' ')
    const answer = (exitCode: number) => ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (script.includes('[IO.File]::Replace') && !script.includes('WriteAllBytes')) {
      const text = files.get(norm(env.NOTARY_TMP))
      if (text === undefined) return answer(1)
      files.delete(norm(env.NOTARY_TMP))
      files.set(norm(env.NOTARY_TARGET), text)
      return answer(0)
    }
    if (script.includes('Remove-Item') && !script.includes('Get-ChildItem')) {
      files.delete(norm(env.NOTARY_TARGET))
      return answer(0)
    }
    return answer(1)
  })
  // Keys whose writes the host refuses, as it does a value over 4 MiB.
  const refuse = new Set<string>()
  on('state.set', (_$, e, next) => {
    if (refuse.has(e.key)) return { deny: `${e.key} is too large` } as never
    writes.push({ key: e.key, value: e.value })
    return next(e)
  })
  on('ui.log', (_$, e) => {
    if (!expectLogs) expect(`Changes logged: ${e.text}`).toBe('')
    logs.push(e.text)
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now: 1_000 })
  const session = mock.session(on)

  const last = (key: string) => [...writes].reverse().find(w => w.key === key)?.value as any
  return { files, writes, runs, last, trackShell, session, clock, refuse, logs, opened, panes }
}

export const PATH = 'C:/work/src/a.ts'

// The Edit tool beneath: it writes the new text, as the real one does.
export function editingTool(on: On, w: ReturnType<typeof world>) {
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') w.files.set(PATH, 'after\n')
    return { result: {}, text: '' } as never
  })
}

export async function editTurn($: Engine, turnId = 't1', text = 'fix a') {
  await $.turn.start({ text, turnId })
  await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'before', new_string: 'after' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId, reason: 'answer' })
}

