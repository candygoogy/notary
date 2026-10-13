import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Windows inputs through the whole wiring: path spellings, the PowerShell tool,
// npm.cmd, Pester, CRLF and localized output. Verdicts are read from the
// classic.Stop send-back and the `last` state write, never from the stamp.
// The manual half is docs/windows-checklist.md.

type Answer = { result: unknown; text?: string; isError?: true }

function world(on: On) {
  const answers: Answer[] = []
  const writes: Array<{ key: string; value: unknown }> = []
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // The session's directory: edits outside it are not code edits (isVerifiableEdit).
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('tool.call', () => (answers.shift() ?? { result: {}, text: '' }) as never)
  on('classic.Stop', () => ({}))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('state.set', (_$, e, next) => {
    writes.push({ key: e.key, value: e.value })
    return next(e)
  })
  on('ui.log', (_$, e) => {
    expect(`Receipts logged: ${e.text}`).toBe('')
    return { value: undefined } as never
  })
  mock.clock(on, { now: 1_000 })
  mock.session(on)
  const verdict = () => {
    const last = writes.filter(write => write.key === 'last').at(-1)?.value as { kind: string; evidence: { summary: string } | null } | undefined
    return last ?? null
  }
  return { answers, verdict }
}

const ok: Answer = { result: {}, text: '' }
const claim = 'All tests pass.'
const sentBack = /^Receipts: you claimed "All tests pass\.", but /

async function end($: Engine, answer = claim): Promise<{ block?: string }> {
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: answer })
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  return stop
}

test('one file edited under three Windows spellings is closed by one passing run', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, ok, ok, { result: {}, text: '      Tests  42 passed (42)\r\n' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\src\\a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'c:/work/src/a.ts', content: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/WORK/SRC/A.TS', old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm test' })
  const stop = await end($)
  expect(stop.block).toBeUndefined()
  expect(w.verdict()?.kind).toBe('verified')
})

test('a pass before an edit in another spelling does not verify it', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, { result: {}, text: '      Tests  42 passed (42)\r\n' }, ok)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: 'c:/work/A.ts', old_string: 'b', new_string: 'c' })
  const stop = await end($)
  expect(stop.block ?? '').toMatch(sentBack)
  expect(w.verdict()?.kind).toBe('unverified')
})

test('a PowerShell npm.cmd test failure with CRLF output is contradicted and sent back', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, {
    result: {},
    text: 'Exit code 1\r\n\r\n FAIL  src/date.test.ts > parse > keeps the day\r\n Test Files  1 failed (1)\r\n      Tests  1 failed | 41 passed (42)\r\n',
    isError: true,
  })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\src\\date.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm.cmd test' })
  const stop = await end($)
  expect(stop.block ?? '').toMatch(sentBack)
  expect(w.verdict()?.kind).toBe('contradicted')
})

test('Pester without -CI exits 0, and its failure count still contradicts the claim', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, { result: {}, text: 'Tests completed in 1.2s\r\nTests Passed: 3, Failed: 1, Skipped: 0 NotRun: 0\r\n' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\Math.psm1', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'Invoke-Pester -Path tests' })
  const stop = await end($)
  expect(stop.block ?? '').toMatch(sentBack)
  expect(w.verdict()?.kind).toBe('contradicted')
})

test('pytest run by its venv path and piped to Select-Object verifies the claim', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, { result: {}, text: '12 passed in 0.31s\r\n' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\bot.py', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: '.\\venv\\Scripts\\python.exe -m pytest -q 2>&1 | Select-Object -Last 1' })
  const stop = await end($)
  expect(stop.block).toBeUndefined()
  expect(w.verdict()?.kind).toBe('verified')
})

test('dotnet test failing on a Turkish Windows is contradicted', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, { result: {}, text: 'Exit code 1\r\nBaşarısız!  - Başarısız:     1, Başarılı:    41, Atlanan:     0, Toplam:    42\r\n', isError: true })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\Tarih.cs', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'dotnet test' })
  await end($)
  expect(w.verdict()?.kind).toBe('contradicted')
})

test('npm.cmd missing from a short PATH is not a test failure', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, {
    result: {},
    text: "Exit code 1\r\nnpm.cmd: The term 'npm.cmd' is not recognized as a name of a cmdlet, function, script file, or executable program.\r\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.\r\n",
    isError: true,
  })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\src\\a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm.cmd test' })
  await end($)
  expect(w.verdict()?.kind).toBe('unverified')
})

test('a PowerShell run in the background is not evidence yet', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, { result: { backgroundTaskId: 'b1' }, text: 'Command running in background with ID: b1.' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\Math.psm1', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'Invoke-Pester -Path tests', run_in_background: true })
  const stop = await end($)
  expect(stop.block ?? '').toMatch(sentBack)
  expect(w.verdict()?.kind).toBe('unverified')
})

test('an answer with CRLF line endings is still read', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(ok, { result: {}, text: 'Exit code 1\r\n      Tests  1 failed | 41 passed (42)\r\n', isError: true })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\src\\a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm test' })
  await end($, 'Fixed.\r\nAll tests pass.')
  expect(w.verdict()?.kind).toBe('contradicted')
})

test('a NotebookEdit on a Windows path counts as an edit', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:\\work\\analysis.ipynb', new_source: 'x = 1' } as never)
  const stop = await end($)
  expect(stop.block ?? '').toMatch(sentBack)
  expect(w.verdict()?.kind).toBe('unverified')
})
