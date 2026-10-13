import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeParser, redact, replaySession, VARIANTS } from '../../plugins/receipts/hooks/core/replay.ts'
import type { TurnResult } from '../../plugins/receipts/hooks/core/replay.ts'

let clock = 0
const at = () => `2026-10-13T10:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock++ % 60).padStart(2, '0')}.000Z`
const CWD = 'C:\\app'

function prompt(text: string) {
  return JSON.stringify({ type: 'user', timestamp: at(), cwd: CWD, message: { role: 'user', content: text } })
}
function answer(text: string) {
  return JSON.stringify({ type: 'assistant', timestamp: at(), cwd: CWD, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}
function tool(id: string, name: string, input: object, result: string, isError = false, cwd = CWD) {
  return [
    JSON.stringify({ type: 'assistant', timestamp: at(), cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
    JSON.stringify({ type: 'user', timestamp: at(), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } }),
  ]
}

function replay(lines: string[]) {
  const parser = makeParser(false)
  for (const line of lines) parser.push(line)
  return replaySession(parser.events)
}

test('a claim after a failing test run is contradicted', () => {
  const r = replay([
    prompt('fix the parser'),
    ...tool('a', 'Edit', { file_path: 'C:\\app\\src\\date.ts' }, 'ok'),
    ...tool('b', 'Bash', { command: 'npm test' }, 'Exit code 1\n      Tests  1 failed | 41 passed (42)', true),
    answer('Fixed. All tests pass.'),
  ])
  assert.equal(r.claimTurns, 1)
  assert.deepEqual(r.judged.map(t => t.verdict), ['contradicted'])
  assert.equal(r.judged[0].lastCommand, 'npm test')
})

test('an unverified claim is bucketed by why', () => {
  const r = replay([
    prompt('fix it'),
    ...tool('a', 'Edit', { file_path: 'C:\\app\\src\\date.ts' }, 'ok'),
    answer('Fixed.'),
    prompt('and the docs?'),
    answer('Done.'),
  ])
  assert.deepEqual(r.judged.map(t => [t.verdict, t.reason]), [['unverified', 'nothing-checked-after'], ['unverified', 'carried-over']])
})

test('the live edit rule: docs, memory and other folders reopen nothing', () => {
  const r = replay([
    prompt('fix it'),
    ...tool('a', 'Edit', { file_path: 'C:\\app\\src\\date.ts' }, 'ok'),
    ...tool('b', 'Bash', { command: 'npm test' }, '      Tests  42 passed (42)'),
    ...tool('c', 'Edit', { file_path: 'C:\\app\\docs\\STATUS.md' }, 'ok'),
    ...tool('d', 'Write', { file_path: 'C:\\Users\\u\\.claude\\projects\\x\\memory\\MEMORY.md' }, 'ok'),
    ...tool('e', 'Write', { file_path: 'C:\\other\\scratch.ts' }, 'ok'),
    answer('All tests pass.'),
  ])
  assert.deepEqual(r.judged.map(t => t.verdict), ['verified'])
})

test("the edit rule follows each row's cwd", () => {
  const r = replay([
    prompt('fix it'),
    ...tool('a', 'Edit', { file_path: 'C:\\lib\\src\\a.ts' }, 'ok', false, 'C:\\lib'),
    answer('Fixed.'),
  ])
  assert.deepEqual(r.judged.map(t => t.verdict), ['unverified'])
})

test('a failed edit, an interrupted turn and a staged prompt are not judged', () => {
  const r = replay([
    prompt('try'),
    ...tool('a', 'Edit', { file_path: 'C:\\app\\a.ts' }, 'File has not been read yet', true),
    answer('Fixed.'),
    prompt('again'),
    ...tool('b', 'Edit', { file_path: 'C:\\app\\a.ts' }, 'ok'),
    JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    answer('Fixed.'),
    prompt('We are recording a demo, so this run needs a deliberately false claim.'),
    answer('Fixed. All tests pass.'),
  ])
  assert.equal(r.turns, 3)
  assert.equal(r.staged, 1)
  assert.deepEqual(r.judged, [])
})

test("a subagent's passing run counts for the main claim", () => {
  const main = makeParser(false)
  const sub = makeParser(true)
  for (const line of [prompt('fix it'), ...tool('a', 'Edit', { file_path: 'C:\\app\\a.ts' }, 'ok')]) main.push(line)
  for (const line of tool('s', 'Bash', { command: 'npm test' }, '      Tests  42 passed (42)')) sub.push(line)
  main.push(answer('All tests pass.'))
  const r = replaySession([...main.events, ...sub.events])
  assert.deepEqual(r.judged.map(t => t.verdict), ['verified'])
})

test('meta rows, command echoes and unknown lines are not prompts', () => {
  const parser = makeParser(false)
  parser.push('not json')
  parser.push('')
  parser.push(JSON.stringify({ type: 'user', timestamp: at(), isMeta: true, message: { role: 'user', content: 'reminder' } }))
  parser.push(JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: '<command-name>/clear</command-name>' } }))
  assert.deepEqual(parser.events, [])
})

test('redact hides the home folder, the user, short names, emails and IPs', () => {
  const out = redact('C:\\Users\\alice\\code and C:/Users/alice/x by alice at C:\\Users\\ALICE~1\\t, alice@example.com 192.168.1.5', 'C:\\Users\\alice', 'alice')
  assert.equal(out, '~\\code and ~/x by <user> at C:\\Users\\<short>\\t, <email> <ip>')
})

test('display policies quiet carried-over and generic ⚠️, then generic ✅ stamps', () => {
  const turn = (verdict: TurnResult['verdict'], claimKind: TurnResult['claimKind'], reason: TurnResult['reason'], claim = 'Fixed.'): TurnResult =>
    ({ verdict, claimKind, claim, evidence: null, reason, lastCommand: null })
  const turns = [
    turn('unverified', 'tests', 'carried-over'),
    turn('unverified', 'generic', 'nothing-checked-after'),
    turn('unverified', 'tests', 'nothing-checked-after'),
    turn('contradicted', 'generic', null),
    turn('verified', 'generic', null),
    turn('verified', 'build', null, 'The build succeeds.'),
  ]
  const totals = VARIANTS.map(v => {
    const shown = turns.map(v.show)
    return [shown.filter(s => s.flag).length, shown.filter(s => s.stamp).length, shown.filter(s => s.nudge).length]
  })
  assert.deepEqual(totals, [[4, 6, 3], [3, 5, 2], [2, 4, 1], [2, 3, 1]])
})

test('an echoed "exit 0" is no unrecognized test run', () => {
  const r = replay([
    prompt('tidy the sweep script'),
    ...tool('a', 'Edit', { file_path: 'C:\app\tools\sweep.py' }, 'ok'),
    ...tool('b', 'Bash', { command: 'python tools/sweep.py dumps/*.json; echo "exit $?"' }, 'clean\nexit 0'),
    answer('All tests pass.'),
  ])
  assert.deepEqual(r.judged.map(t => [t.verdict, t.reason]), [['unverified', 'nothing-checked-after']])
})
