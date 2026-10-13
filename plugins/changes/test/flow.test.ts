import { expect, test } from 'claude-code/testing'

import { PATH, editTurn, editingTool, world } from './world.ts'

test('an Edit in a turn is recorded with its before and after, and the band names the turn', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await editTurn($)

  const index = w.last('index')
  expect(index.turns.map((t: any) => t.turnId)).toEqual(['t1'])
  expect(index.edits.length).toBe(1)
  const [edit] = index.edits
  expect(edit.via).toBe('tool')
  expect(edit.key).toBe('c:/work/src/a.ts')
  expect(edit.before.kind).toBe('text')
  expect(edit.after.kind).toBe('text')
  expect(edit.before.hash === edit.after.hash).toBe(false)
  expect(w.last('band')).toEqual({ turnId: 't1', ordinal: 1, files: 1 })

  // The before was snapshotted where the session keeps its blobs.
  const blob = `C:/Users/me/.claude/plugin-data/notary-changes/s1/blobs/${edit.before.hash}.txt`
  expect(w.files.get(blob)).toBe('before\n')
})

test('a docs-only turn is tracked but keeps the band quiet', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  const doc = 'C:/work/README.md'
  w.files.set(doc, 'old\n')
  on('tool.call', () => {
    w.files.set(doc, 'new\n')
    return { result: {}, text: '' } as never
  })
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'notes', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: doc, content: 'new\n' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.last('index').edits.length).toBe(1)
  expect(w.writes.some(x => x.key === 'band' && x.value !== null)).toBe(false)
})

test('a denied or failed edit is not recorded', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  w.files.set(PATH, 'before\n')
  on('tool.call', () => ({ result: undefined, text: 'Error', isError: true }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'a', new_string: 'b' })
  expect((w.last('index')?.edits ?? []).length).toBe(0)
})

test('a staged edit (held for review) is not recorded', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  w.files.set(PATH, 'before\n')
  on('tool.call', () => ({ result: { staged: true }, text: '' }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'a', new_string: 'b' })
  expect((w.last('index')?.edits ?? []).length).toBe(0)
})

test('an Agent call links the subagent to the spawning turn', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { isAsync: true, status: 'async_launched', agentId: 'ag1' }, text: '' }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'spawn', turnId: 't1' })
  await $.tool.call({ tool: 'Agent', description: 'tests', prompt: 'run tests', subagent_type: 'general-purpose' } as never)
  const agent = w.last('index').agents[0]
  expect(agent).toEqual({ agentId: 'ag1', turnId: 't1', seq: agent.seq, parentToolUseId: agent.parentToolUseId, label: 'tests' })
})

test('the tool call is never altered: the result passes through untouched', { options: { trackShell: false } }, async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { filePath: PATH }, text: 'ok' }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const r = await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'a', new_string: 'b' })
  expect((r as any).text).toBe('ok')
  expect((r as any).result).toEqual({ filePath: PATH })
})
