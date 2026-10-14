import { expect, test } from 'claude-code/testing'

import { nudgeText, sendBackText, stampText } from '../hooks/core/copy.ts'
import type { Verdict } from '../hooks/core/types.ts'
import { answer, composer, edit, failing, landed, npmTest, passing, world } from './world.ts'
import type { Answer } from './world.ts'

const claim = { sentence: 'All tests pass.', kind: 'tests', certainty: 'sure' } as const
const contradicted: Verdict = {
  kind: 'contradicted',
  claim,
  evidence: { strength: 'strong', outcome: 'fail', command: 'npm test', summary: 'npm test exited 1 (1 failed)' },
}
const unverified: Verdict = { kind: 'unverified', claim, evidence: null }

test('a contradicted claim is sent back once, then the stop is allowed', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All tests pass.' })
  expect(first).toEqual({ block: sendBackText(contradicted) })
  const second = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'All tests pass.' })
  expect(second.block).toBeUndefined()
})

test('the send-back quotes the tests claim over a bare "Fixed."', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  expect(await answer($, 'Fixed. All tests pass.')).toBe(sendBackText(contradicted))
})

// The live -p smoke run: no stamp was kept, because it was appended from
// turn.complete, after the turn. The stamp is written at the allowed Stop.
test('only the answer that stands is stamped, at its Stop, before turn.complete', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing, passing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  expect(await answer($, 'Fixed. All tests pass.')).toBe(sendBackText(contradicted))
  expect(w.stamps()).toEqual([])
  await $.tool.call(npmTest)
  const final = 'Fixed the off-by-one. All tests pass now.'
  const stop = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: final })
  expect(stop.block).toBeUndefined()
  expect(w.stamps()).toEqual(['🧾 ✅ Verified · npm test passed (42)'])
  await $.turn.complete({ answer: final, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.stamps()).toEqual(['🧾 ✅ Verified · npm test passed (42)'])
})

test('mode B nudges an unverified claim with the next user prompt only', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  expect(await answer($, 'All tests pass.')).toBeUndefined()
  expect(w.stamps()).toEqual([stampText(unverified)])
  const next = await $.prompt.submit({ text: 'thanks', wait: false, origin: composer })
  expect(next.context).toEqual([nudgeText(unverified)])
  const after = await $.prompt.submit({ text: 'and now?', wait: false, origin: composer })
  expect(after.context ?? []).toEqual([])
})

// The band's verdict after each state write, as renderBand reads it.
const band = (w: { writes: Array<{ key: string; value: unknown }> }) => w.writes.filter(write => write.key === 'last').at(-1)?.value ?? null

test('mode B: the ⚠️ band goes when the turn its reminder rode on ends', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  expect(band(w)).toEqual(unverified)
  const next = await $.prompt.submit({ text: 'did you run them?', wait: false, origin: composer })
  expect(next.context).toEqual([nudgeText(unverified)])
  expect(band(w)).toEqual(unverified)
  await $.turn.start({ text: 'did you run them?', turnId: 't2' })
  await answer($, 'No, I did not run them yet.', 't2')
  expect(band(w)).toBeNull()
})

test('mode B: an interrupted reminder turn also takes the ⚠️ band down', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  await $.prompt.submit({ text: 'did you run them?', wait: false, origin: composer })
  await $.turn.start({ text: 'did you run them?', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(band(w)).toBeNull()
})

test('mode B: a newer verdict in the reminder turn takes the band', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  await $.prompt.submit({ text: 'run them', wait: false, origin: composer })
  await $.turn.start({ text: 'run them', turnId: 't2' })
  w.answers.push(passing)
  await $.tool.call(npmTest)
  await answer($, 'All tests pass.', 't2')
  expect((band(w) as Verdict | null)?.kind).toBe('verified')
})

test('mode B: without a reminder the ⚠️ band stays past a quiet turn', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  // A plugin's prompt carries no reminder, so its turn leaves the band.
  await $.prompt.submit({ text: 'auto', wait: false, origin: { kind: 'plugin', name: 'other' } as never })
  await $.turn.start({ text: 'auto', turnId: 't2' })
  await answer($, 'Looking.', 't2')
  expect(band(w)).toEqual(unverified)
})

test('a prompt a plugin submitted gets no nudge, and the nudge waits', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  const fromPlugin = await $.prompt.submit({ text: 'auto', wait: false, origin: { kind: 'plugin', name: 'other' } as never })
  expect(fromPlugin.context ?? []).toEqual([])
  const fromUser = await $.prompt.submit({ text: 'hi', wait: false, origin: composer })
  expect(fromUser.context).toEqual([nudgeText(unverified)])
})

test('an interrupted turn is never judged', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await $.turn.complete({ answer: 'All tests pass.', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' })
  expect(w.stamps()).toEqual([])
  expect(w.writes.filter(write => write.key === 'history')).toEqual([])
  const next = await $.prompt.submit({ text: 'go on', wait: false, origin: composer })
  expect(next.context ?? []).toEqual([])
})

for (const [name, result] of [
  ['denied', { deny: 'no' }],
  ['errored', { result: undefined, text: 'File has not been read yet', isError: true }],
  ['staged', { result: { staged: true }, text: 'held for review' }],
] as const) {
  test(`an edit that was ${name} is not an edit`, async ($, on) => {
    const w = world(on)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    w.answers.push(result as Answer)
    await $.tool.call(edit)
    expect(await answer($, 'All tests pass.')).toBeUndefined()
    expect(w.stamps()).toEqual([])
  })
}

test("a subagent's passing tests after the main loop's edit verify the claim", async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, passing)
  await $.tool.call(edit)
  await $.tool.call({ ...npmTest, agentId: 'agent-7' } as never)
  await answer($, 'All tests pass.')
  expect(w.stamps()).toEqual(['🧾 ✅ Verified · npm test passed (42)'])
})

test("a subagent's own turn is not judged", async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await $.turn.complete({ answer: 'All tests pass.', durationMs: 5, isAborted: false, turnId: 't9', reason: 'answer', agentId: 'agent-7' })
  expect(w.writes.filter(write => write.key === 'history')).toEqual([])
})

test('mode A warns without sending back or nudging', { options: { mode: 'A' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  expect(await answer($, 'All tests pass.')).toBeUndefined()
  expect(w.stamps()).toEqual([stampText(contradicted)])
  const next = await $.prompt.submit({ text: 'ok', wait: false, origin: composer })
  expect(next.context ?? []).toEqual([])
})

test('mode A: the ⚠️ band stays until the next verdict', { options: { mode: 'A' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  await $.prompt.submit({ text: 'ok', wait: false, origin: composer })
  await $.turn.start({ text: 'ok', turnId: 't2' })
  await answer($, 'Sure.', 't2')
  expect(band(w)).toEqual(unverified)
})

test('mode C sends an unverified claim back', { options: { mode: 'C' } }, async ($, on) => {
  world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  expect(await answer($, 'All tests pass.')).toBe(sendBackText(unverified))
})

test('the stamp option off appends nothing', { options: { stamp: false } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  expect(w.stamps()).toEqual([])
  expect(w.writes.filter(write => write.key === 'history')).toHaveLength(1)
})

test('disabled, Receipts writes nothing and blocks nothing', { options: { enabled: false } }, async ($, on) => {
  const w = world(on)
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  expect(await answer($, 'All tests pass.')).toBeUndefined()
  expect(w.writes).toEqual([])
  expect(w.stamps()).toEqual([])
})

test('a later turn with nothing new is not judged', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, passing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  await answer($, 'All tests pass.')
  await $.turn.start({ text: 'commit it', turnId: 't2' })
  await answer($, 'Done.', 't2')
  expect(w.stamps()).toEqual(['🧾 ✅ Verified · npm test passed (42)'])
})

test('only code edits reopen verification: docs, memory and other projects do not', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'update the docs', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/README.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/Users/dev/.claude/projects/x/memory/m.json', content: '{}' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/elsewhere/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/work/dist/index.js', content: 'x' })
  expect(await answer($, 'Done. All tests pass.')).toBeUndefined()
  expect(w.stamps()).toEqual([])
  expect(w.writes.filter(write => write.key === 'history')).toEqual([])
})

// Review 1: the same short answer after a passing rerun is judged afresh.
test('a repeated answer after a passing rerun is stamped ✅, not the old ❌', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing, passing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  expect(await answer($, 'All tests pass.')).toBe(sendBackText(contradicted))
  await $.tool.call(npmTest)
  const stop = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'All tests pass.' })
  expect(stop.block).toBeUndefined()
  expect(w.stamps()).toEqual(['🧾 ✅ Verified · npm test passed (42)'])
})

// Review 8.
test('the same answer is stamped once even if Stop runs again', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, passing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All tests pass.' })
  await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'All tests pass.' })
  expect(w.stamps()).toHaveLength(1)
})

test('a hook beneath that stops the session gets no stamp and no send-back', async ($, on) => {
  const w = world(on, { stopResult: { preventContinuation: true, stopReason: 'budget' } })
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All tests pass.' })
  expect(stop.block).toBeUndefined()
  expect(w.stamps()).toEqual([])
})

// Review 7.
test('a /clear starts the conversation clean: no nudge, nothing to judge', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  const next = await $.prompt.submit({ text: 'new topic', wait: false, origin: composer })
  expect(next.context ?? []).toEqual([])
  await $.turn.start({ text: 'new topic', turnId: 't2' })
  await answer($, 'Done.', 't2')
  expect(w.stamps()).toHaveLength(1)
})

// Review 11.
test('two prompts at once: only one carries the nudge', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  const [a, b] = await Promise.all([
    $.prompt.submit({ text: 'one', wait: false, origin: composer }),
    $.prompt.submit({ text: 'two', wait: false, origin: composer }),
  ])
  expect([...(a.context ?? []), ...(b.context ?? [])]).toEqual([nudgeText(unverified)])
})

// Review 3a end to end: an honest partial report is neither stamped ❌ nor sent back.
test('an answer that discloses a failure is not sent back', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  expect(await answer($, 'The build succeeds. 1 test is still failing; I left it for you.')).toBeUndefined()
  expect(w.stamps()).toEqual([])
})

// Lead's defaults (quiet): only what matters reaches the person; the pane keeps all.
test('quiet: a generic ⚠️ goes to the pane only (no stamp, no nudge)', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  expect(await answer($, 'Fixed.')).toBeUndefined()
  expect(w.stamps()).toEqual([])
  expect(w.writes.filter(write => write.key === 'history')).toHaveLength(1)
  const next = await $.prompt.submit({ text: 'ok', wait: false, origin: composer })
  expect(next.context ?? []).toEqual([])
})

test('quiet: a carried-over ⚠️ goes to the pane only', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await $.turn.complete({ answer: 'Looking into it.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'and?', turnId: 't2' })
  expect(await answer($, 'All tests pass.', 't2')).toBeUndefined()
  expect(w.stamps()).toEqual([])
  const next = await $.prompt.submit({ text: 'ok', wait: false, origin: composer })
  expect(next.context ?? []).toEqual([])
})

test('quiet: a generic ✅ is not stamped', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, passing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  await answer($, 'Fixed.')
  expect(w.stamps()).toEqual([])
  expect(w.writes.filter(write => write.key === 'history')).toHaveLength(1)
})

test('quiet, mode C: a generic ⚠️ is not sent back', { options: { mode: 'C' } }, async ($, on) => {
  world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  expect(await answer($, 'Fixed.')).toBeUndefined()
})

test('verbosity all: every verdict is stamped and every ⚠️ nudged', { options: { verbosity: 'all' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'Fixed.')
  expect(w.stamps()).toEqual(['🧾 ⚠️ Unverified: no receipts · no check ran after the last edit'])
  const next = await $.prompt.submit({ text: 'ok', wait: false, origin: composer })
  expect(next.context?.length).toBe(1)
})

// Windows: the session may run from an 8.3 short path (C:\Users\JOHNDO~1\…)
// while Claude edits through the long one. Both resolve to one real path.
test('an edit through the long spelling of a short-name cwd is inside the project', async ($, on) => {
  const w = world(on, { cwd: 'C:/Users/DEV~1/app', aliases: { 'C:/Users/DEV~1': 'C:/Users/Developer' } })
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  w.answers.push(landed, failing)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/Users/Developer/app/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call(npmTest)
  expect(await answer($, 'All tests pass.')).toBe(sendBackText(contradicted))
})
