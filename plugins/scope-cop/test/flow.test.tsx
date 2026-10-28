import { expect, test } from 'claude-code/testing'

import { answer, bandShows, checkOf, editOf, paneShows, prompt, scope, shellCheck, shellEdit, start, world } from './world.tsx'

const OUT = 'C:/work/src/db/pool.ts'
const IN = 'C:/work/src/auth/login.ts'
const TELL = 'Scope Cop (a mod the user installed): src/db/pool.ts is outside the scope the user set for this task (src/auth/**). The edit went through. If it was not needed for the task, say so in your answer.'

// ------------------------------------------------------------ no scope

test('with no scope set nothing changes: the verdict, the result, the prompt', async ($, on) => {
  world(on)
  await start($)
  expect(await $.tool.check(checkOf(OUT))).toEqual({ decision: 'allow' })
  const r = await $.tool.call(editOf(OUT))
  expect((r as { context?: unknown }).context).toBeUndefined()
  expect(await prompt($)).toEqual([])
})

// ------------------------------------------------------------ the command

test('/scope sets the scope, and every prompt then carries it', async ($, on) => {
  world(on)
  await start($)
  expect(await scope($, 'src/auth/**')).toBe('Scope set: edit only src/auth/**. Ask before touching other files.')
  expect(await prompt($)).toEqual(['Scope Cop (a mod the user installed): for this task the user limited edits to src/auth/**. Ask before editing other files.'])
  expect(await prompt($)).toHaveLength(1)
})

test('/scope refuses a bad pattern and keeps the scope as it was', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect(await scope($, 'add ../other/**')).toBe('Scope not changed. "../other/**": `..` leaves the project. Patterns are relative to the project root, like src/auth/**.')
  expect((await prompt($))[0]).toContain('limited edits to src/auth/**.')
})

test('/scope add, remove and off', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect(await scope($, 'add test/auth/**')).toBe('Scope set: edit only src/auth/**, test/auth/**. Ask before touching other files.')
  expect(await scope($, 'remove src/auth/**')).toBe('Scope set: edit only test/auth/**. Ask before touching other files.')
  expect(await scope($, 'remove nope/**')).toBe('Not in the scope: nope/**. The scope is test/auth/**.')
  expect(await scope($, 'off')).toBe('Scope cleared: Claude may edit any file again.')
  expect(await prompt($)).toEqual([])
})

test('/scope mode holds at once for the conversation and writes no setting; a typo gets the usage', async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect(await scope($, 'mode c')).toBe(
    'Scope Cop mode C: edits outside the scope are blocked, and Claude is told why. This holds for this conversation; to keep it, change it in /config.',
  )
  expect(w.settings).toEqual([])
  expect((await $.tool.check(checkOf(OUT))).decision).toBe('deny')
  expect(await scope($, 'mode X')).toContain('Usage: /scope')
})

test('/scope alone opens the pane', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await scope($, '')).toBe('Scope pane opened.')
  expect(w.opened).toEqual(['scope'])
})

// ------------------------------------------------------------ mode B (default)

test('B: an edit outside the scope runs, and Claude is told on its result, once per file per turn', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  await $.turn.start({ text: 'fix login', turnId: 't1' })
  expect(await $.tool.check(checkOf(OUT))).toEqual({ decision: 'allow' })
  const first = await $.tool.call(editOf(OUT))
  expect((first as { context?: unknown }).context).toEqual([TELL])
  const again = await $.tool.call(editOf(OUT))
  expect((again as { context?: unknown }).context).toBeUndefined()
  const inside = await $.tool.call(editOf(IN))
  expect((inside as { context?: unknown }).context).toBeUndefined()
  await $.turn.start({ text: 'and again', turnId: 't2' })
  const nextTurn = await $.tool.call(editOf(OUT))
  expect((nextTurn as { context?: unknown }).context).toEqual([TELL])
})

test("B: a subagent's edit outside the scope is told too", async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  await $.turn.start({ text: 'fix login', turnId: 't1' })
  const r = await $.tool.call(editOf(OUT, 'agent-1'))
  expect((r as { context?: unknown }).context).toEqual([TELL])
})

test('B: an edit that failed or was denied beneath is not flagged', async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  w.answers.push({ result: 'no', text: 'File has not been read yet', isError: true }, { deny: 'denied by a rule' })
  expect((await $.tool.call(editOf(OUT)) as { context?: unknown }).context).toBeUndefined()
  expect((await $.tool.call(editOf(OUT)) as { context?: unknown }).context).toBeUndefined()
})

test("Claude's own files, temp files and lockfiles are never flagged", async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  for (const path of ['C:/Users/me/.claude/plans/p.md', 'C:/Users/me/AppData/Local/Temp/x.js', 'C:/work/package-lock.json']) {
    expect((await $.tool.call(editOf(path)) as { context?: unknown }).context).toBeUndefined()
  }
})

// ------------------------------------------------------------ mode A

test('A: an edit outside the scope is flagged only: no deny, no note to Claude', { options: { mode: 'A' } }, async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect(await $.tool.check(checkOf(OUT))).toEqual({ decision: 'allow' })
  expect((await $.tool.call(editOf(OUT)) as { context?: unknown }).context).toBeUndefined()
})

// ------------------------------------------------------------ mode C

test('C: an edit outside the scope is denied with the reason Claude reads; inside keeps the verdict beneath', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  const denied = await $.tool.check(checkOf(OUT))
  expect(denied.decision).toBe('deny')
  expect(denied.reason).toBe(
    'Scope Cop (a mod the user installed): src/db/pool.ts is outside the scope the user set for this task (src/auth/**). The edit was not made. Ask the user before editing outside the scope; they can widen it with /scope add.',
  )
  w.verdicts.push({ decision: 'ask' })
  expect(await $.tool.check(checkOf(IN))).toEqual({ decision: 'ask' })
})

test('C: Scope Cop only tightens: a deny beneath stays a deny, never an allow', { options: { mode: 'C' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  w.verdicts.push({ decision: 'deny', reason: 'a settings rule' })
  expect(await $.tool.check(checkOf(IN))).toEqual({ decision: 'deny', reason: 'a settings rule' })
})

test('C: a shell command with an absolute target outside the scope is denied; a relative one is left to Changes', { options: { mode: 'C' } }, async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect((await $.tool.check(shellCheck('echo x > C:/work/src/db/a.ts'))).decision).toBe('deny')
  expect((await $.tool.check(shellCheck("Set-Content -Path C:\\work\\src\\db\\a.ts -Value 'x'", 'PowerShell'))).decision).toBe('deny')
  expect(await $.tool.check(shellCheck('echo x > src/db/a.ts'))).toEqual({ decision: 'allow' })
  expect(await $.tool.check(shellCheck('echo x > C:/work/src/auth/a.ts'))).toEqual({ decision: 'allow' })
  expect(await $.tool.check(shellCheck('npm test'))).toEqual({ decision: 'allow' })
})

test('C: a file in a bookkeeping folder is not denied; a .env there, or a source folder, still is', { options: { mode: 'C' } }, async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect(await $.tool.check(checkOf('C:/work/shots/after-login.png'))).toEqual({ decision: 'allow' })
  expect(await $.tool.check(checkOf('C:/work/web/.cache/build.json'))).toEqual({ decision: 'allow' })
  const secret = await $.tool.check(checkOf('C:/work/shots/.env'))
  expect(secret.decision).toBe('deny')
  expect(secret.reason).toContain('shots/.env is outside the scope')
  expect((await $.tool.check(checkOf('C:/work/blender/x.blend.py'))).decision).toBe('deny')
})

test('B: shell commands are never denied before they run', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  expect(await $.tool.check(shellCheck('echo x > C:/work/src/db/a.ts'))).toEqual({ decision: 'allow' })
})

// ------------------------------------------------------------ shell writes, via Changes

test("shell writes outside the scope, from Changes' index, are told once on the next prompt; earlier ones are not judged", async ($, on) => {
  const w = world(on)
  await start($)
  w.changes.index = { edits: [shellEdit(1, 'C:/work/src/db/before.ts')] }
  await scope($, 'src/auth/**')
  await $.turn.start({ text: 'go', turnId: 't1' })
  w.changes.index = { edits: [shellEdit(1, 'C:/work/src/db/before.ts'), shellEdit(2, 'C:/work/src/db/a.ts'), shellEdit(3, 'C:/work/src/auth/ok.ts')] }
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const context = await prompt($)
  expect(context).toHaveLength(2)
  expect(context[1]).toBe(
    'Scope Cop (a mod the user installed): in your last turn, shell commands changed files outside the scope the user set for this task (src/auth/**): src/db/a.ts. If they were not needed for the task, say so.',
  )
  expect(await prompt($)).toHaveLength(1)
})

test('a subagent ending its run does not read the shell writes; the main turn does', async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  w.changes.index = { edits: [shellEdit(2, 'C:/work/src/db/a.ts')] }
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't9', reason: 'answer', agentId: 'agent-1' })
  // Read anyway at the next prompt.
  expect(await prompt($)).toHaveLength(2)
})

test('A: shell writes are flagged but Claude is not told', { options: { mode: 'A' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  w.changes.index = { edits: [shellEdit(2, 'C:/work/src/db/a.ts')] }
  expect(await prompt($)).toHaveLength(1)
})

test("an index Scope Cop can't read is ignored, never a failure", async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  w.changes.index = { edits: 'not a list' }
  expect(await prompt($)).toHaveLength(1)
})

// ------------------------------------------------------------ approved edits

const ASKS = 'POST /login does not pass it through yet. That needs an edit to `src/api/auth.ts`, which is outside your scope. Should I make it?'

test('B: a file the last answer named outside the scope is approved in the next turn: in the pane, not on the band, not told; others are flagged as before', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  await $.turn.start({ text: 'add remember me', turnId: 't1' })
  await answer($, 't1', ASKS)
  await prompt($, 'yes')
  await $.turn.start({ text: 'yes', turnId: 't2' })
  const named = await $.tool.call(editOf('C:/work/src/api/auth.ts'))
  expect((named as { context?: unknown }).context).toBeUndefined()
  expect(await bandShows($)).toContain('nothing outside')
  expect(await paneShows($)).toContain('✓ src/api/auth.ts · Edit · approved')
  const other = await $.tool.call(editOf(OUT))
  expect((other as { context?: unknown }).context).toEqual([TELL])
  expect(await bandShows($)).toContain('1 edit outside: src/db/pool.ts')
  expect(await paneShows($)).toContain('src/db/pool.ts · Edit · flagged, Claude told')
  // Only the next turn: an answer that names nothing ends the approval.
  await answer($, 't2', 'Done.')
  await $.turn.start({ text: 'one more thing', turnId: 't3' })
  expect((await $.tool.call(editOf('C:/work/src/api/auth.ts')) as { context?: unknown }).context).toEqual([TELL.replace('src/db/pool.ts', 'src/api/auth.ts')])
})

test('B: a shell write to a named file is approved too, and not told on the next prompt', async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  await answer($, 't1', ASKS)
  await $.turn.start({ text: 'yes', turnId: 't2' })
  w.changes.index = { edits: [shellEdit(2, 'C:/work/src/api/auth.ts')] }
  await answer($, 't2', 'Done.')
  expect(await prompt($)).toHaveLength(1)
  expect(await paneShows($)).toContain('src/api/auth.ts · shell command · approved')
})

// ------------------------------------------------------------ lifetime

test('the end of the conversation clears the scope', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  await $.session.end({ sessionId: 's1', reason: 'clear' } as never)
  expect(await prompt($)).toEqual([])
})

test('turned off in its settings, Scope Cop does nothing and says so', { options: { enabled: false } }, async ($, on) => {
  world(on)
  await start($)
  expect(await scope($, 'src/auth/**')).toBe('Scope Cop is turned off. Turn it on in /config.')
  expect(await prompt($)).toEqual([])
})

test("a change no call explains (the turn's sweep) is logged in the pane, but never told to Claude", async ($, on) => {
  const w = world(on)
  await start($)
  await scope($, 'src/auth/**')
  w.changes.index = { edits: [shellEdit(2, 'C:/work/notes.txt', 'unattributed'), shellEdit(3, 'C:/work/src/db/a.ts')] }
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const context = await prompt($)
  expect(context[1]).toContain('changed files outside the scope the user set for this task (src/auth/**): src/db/a.ts. If')
  expect(context[1]).not.toContain('notes.txt')
})
