import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PATH, editTurn, editingTool, world } from './world.ts'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const PANE_PROPS = { title: 'Changes', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: { skill: '', text: '' } }
const FILE = 't1-c:/work/src/a.ts'

// The engine's own drawing where Changes passes: an empty, keyed Box.
function engineDraws(on: On) {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

function mountPane($: Engine, surface: Surface) {
  return $.ui.mount({ plugin: 'changes', surface, component: 'Pane', requestId: 'changes', props: PANE_PROPS as never })
}

function mountBand($: Engine, surface: Surface) {
  return $.ui.mount({ plugin: 'changes', surface, component: 'AbovePrompt', props: BAND_PROPS as never })
}

async function texts(pane: Awaited<ReturnType<typeof mountPane>>): Promise<string> {
  return (await pane.findAll({ type: 'Text' })).map(found => found.text).join('\n')
}

// A session with one turn that edited src/a.ts from "before" to "after".
async function edited($: Engine, on: On, surface: Surface) {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface, isInteractive: true } as never)
  await editTurn($)
  return w
}

for (const surface of SURFACES) {
  test(`${surface}: the band names a turn that changed code and hides`, { options: { trackShell: false } }, async ($, on) => {
    const w = world(on)
    engineDraws(on)
    editingTool(on, w)
    w.files.set(PATH, 'before\n')
    await $.session.start({ cwd: 'C:/work', surface, isInteractive: true } as never)
    const band = await mountBand($, surface)
    expect(await band.find({ key: 'changes-band' })).toBeUndefined()
    await editTurn($)
    expect((await band.find({ key: 'changes-band' }))?.text).toContain('Turn #1 changed 1 file')
    await band.press({ key: 'hide' })
    expect(await band.find({ key: 'changes-band' })).toBeUndefined()
  })

  test(`${surface}: the pane shows the diff once fetched off the draw`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    const pane = await mountPane($, surface)
    // Cross-review #4: the draw itself reads no file and runs no git.
    expect(await texts(pane)).toContain('loading diff…')
    expect(await pane.findAll({ type: 'Code' })).toEqual([])
    await w.clock.advance(1)
    expect(await texts(pane)).toContain('src/a.ts  +1 −1')
    const codes = await pane.findAll({ type: 'Code' })
    expect(codes.length).toBe(1)
    expect(JSON.stringify(codes[0])).toContain('-before')
    expect(JSON.stringify(codes[0])).toContain('+after')
  })

  test(`${surface}: Revert is two presses; the first changes nothing`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    const pane = await mountPane($, surface)
    await pane.press({ key: `revert-${FILE}` })
    expect(w.files.get(PATH)).toBe('after\n')
    expect((await pane.find({ key: `confirm-${FILE}` }))?.text).toContain('Confirm revert (#1)')

    await pane.press({ key: `confirm-${FILE}` })
    expect(w.files.get(PATH)).toBe('before\n')
    expect(w.last('index').status['t1\u0000c:/work/src/a.ts']).toBe('reverted')
    const note = w.session.appended().find(row => row.message.type === 'user')
    expect(JSON.stringify(note?.message.content)).toContain('reverted C:/work/src/a.ts')
    expect(await texts(pane)).toContain('Reverted src/a.ts (#1).')
    expect(await pane.find({ key: `revert-${FILE}` })).toBeUndefined()
  })

  test(`${surface}: a confirmation left too long does nothing`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    const pane = await mountPane($, surface)
    await pane.press({ key: `revert-${FILE}` })
    await w.clock.advance(6_000)
    await pane.press({ key: `confirm-${FILE}` })
    expect(w.files.get(PATH)).toBe('after\n')
    expect(await texts(pane)).toContain('timed out')
  })

  test(`${surface}: a file changed outside Claude is refused at the first press, with no confirm`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    w.files.set(PATH, 'mine\n')
    const pane = await mountPane($, surface)
    await pane.press({ key: `revert-${FILE}` })
    expect(await pane.find({ key: `confirm-${FILE}` })).toBeUndefined()
    expect(await texts(pane)).toContain("changed since Claude's last edit")
    expect(w.files.get(PATH)).toBe('mine\n')
  })

  test(`${surface}: a later turn's change offers reverting both, and the confirm names both`, { options: { trackShell: false } }, async ($, on) => {
    const w = world(on)
    engineDraws(on)
    on('tool.call', () => {
      w.files.set(PATH, w.files.get(PATH) === 'before\n' ? 'after\n' : 'later\n')
      return { result: {}, text: '' } as never
    })
    w.files.set(PATH, 'before\n')
    await $.session.start({ cwd: 'C:/work', surface, isInteractive: true } as never)
    await editTurn($, 't1')
    await editTurn($, 't2')
    const pane = await mountPane($, surface)
    await pane.press({ key: 'select-t1' })
    await pane.press({ key: `revert-${FILE}` })
    expect(await texts(pane)).toContain('was also changed by #2')
    expect((await pane.find({ key: 'offer' }))?.text).toContain('Revert with #2')
    await pane.press({ key: 'offer' })
    expect((await pane.find({ key: `confirm-${FILE}` }))?.text).toContain('Confirm revert (#1, #2)')
    await pane.press({ key: `confirm-${FILE}` })
    expect(w.files.get(PATH)).toBe('before\n')
  })

  test(`${surface}: Keep marks the file and Undo keep clears it`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    const pane = await mountPane($, surface)
    await pane.press({ key: `keep-${FILE}` })
    expect(w.last('index').status['t1\u0000c:/work/src/a.ts']).toBe('kept')
    expect((await pane.find({ key: `keep-${FILE}` }))?.text).toContain('Undo keep')
    await pane.press({ key: `keep-${FILE}` })
    expect(w.last('index').status['t1\u0000c:/work/src/a.ts']).toBeUndefined()
  })
}

test('review 2 #2: a revert whose history cannot be saved still says so, tells Claude and disarms', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on, { expectLogs: true })
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await editTurn($)
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: `revert-${FILE}` })
  w.refuse.add('index')
  await pane.press({ key: `confirm-${FILE}` })
  expect(w.files.get(PATH)).toBe('before\n')
  expect(await texts(pane)).toContain("Reverted src/a.ts, but its history couldn't be saved.")
  expect(await pane.find({ key: `confirm-${FILE}` })).toBeUndefined()
  expect(JSON.stringify(w.session.appended().find(row => row.message.type === 'user')?.message.content)).toContain('reverted C:/work/src/a.ts')
  expect(w.last('paused')).toContain('Tracking is paused')

  // The pause lifts with the next write that fits.
  w.refuse.delete('index')
  await editTurn($, 't2')
  expect(w.last('paused')).toBeNull()
})

test('review 2 #4: with a step selected, the confirm says it reverts the whole turn', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  engineDraws(on)
  const other = 'C:/work/src/b.ts'
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') w.files.set(PATH, 'after\n')
    if (e.tool === 'Write') w.files.set(other, 'new\n')
    return { result: {}, text: '' } as never
  })
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'two steps', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'before', new_string: 'after' })
  await $.tool.call({ tool: 'Write', file_path: other, content: 'new\n' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const pane = await mountPane($, 'terminal')
  const steps = (await pane.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('node-') && b.key !== 'node-all')
  expect(steps.length).toBe(2)
  await pane.press({ key: String(steps[0].key) })
  await pane.press({ key: `revert-${FILE}` })
  expect((await pane.find({ key: `confirm-${FILE}` }))?.text).toContain('Confirm revert of the whole turn (#1)')
})

// ── cross-review #1: bands compose with another mod's band ──

for (const surface of SURFACES) {
  for (const order of ['prepend', 'append'] as const) {
    test(
      `${surface}: Changes's band and another mod's band both show (other mod ${order === 'prepend' ? 'first' : 'last'})`,
      {
        options: { trackShell: false },
        plugins: [
          {
            name: 'other-band',
            tier: order,
            register(on) {
              on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
                const { Box, Text } = $.ui.resolve(e)
                const below = await next(e)
                return (
                  <Box key="other-column" flexDirection="column">
                    <Box key="other">
                      <Text>Other band</Text>
                    </Box>
                    {below}
                  </Box>
                )
              })
            },
          },
        ],
      },
      async ($, on) => {
        await edited($, on, surface)
        const band = await mountBand($, surface)
        expect(await band.find({ key: 'changes-band' })).toBeDefined()
        expect(await band.find({ key: 'other' })).toBeDefined()
      },
    )
  }
}

test('with room for one row only, Changes draws its own row', { options: { trackShell: false } }, async ($, on) => {
  await edited($, on, 'terminal')
  const band = await $.ui.mount({ plugin: 'changes', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows: 1 } as never })
  expect(await band.find({ key: 'changes-band' })).toBeDefined()
  expect(await band.find({ key: 'engine' })).toBeUndefined()
})

const STORE = 'C:/Users/me/.claude/plugin-data/notary-changes/s1'

const removals = (w: ReturnType<typeof world>) => w.runs.filter(argv => argv.join(' ').includes('Get-ChildItem')).length

test('/clear keeps the old conversation on disk; the new one (a new id) starts empty', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(removals(w)).toBe(0)
  expect(w.files.has(`${STORE}/index.json`)).toBe(true)
  expect(w.last('index').edits).toEqual([])
  expect(w.last('session')).toBeNull()
  expect(w.last('band')).toBeNull()

  // No session.start follows a /clear: the next hook sets the new conversation up.
  w.identity.id = 's2'
  w.files.set(PATH, 'before\n')
  await editTurn($, 't2')
  const index = w.last('index')
  expect(index.turns.map((t: any) => [t.turnId, t.ordinal])).toEqual([['t2', 1]])
  expect(w.last('session').store).toBe(STORE.replace(/s1$/, 's2'))
})

// A resumed conversation: the same id, a fresh $.state, a later launch.
async function resume($: Engine, w: ReturnType<typeof world>) {
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as never)
  await w.clock.advance(60_000)
}

test('a resumed conversation shows its history again, the earlier turns under a divider', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  await resume($, w)
  w.files.set(PATH, 'after\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  expect(w.last('index').turns.map((t: any) => [t.turnId, t.ordinal])).toEqual([['t1', 1]])
  const pane = await mountPane($, 'terminal')
  expect(await texts(pane)).toContain('── Earlier · ')
  // Turn numbers go on from the transcript's.
  const B2 = 'C:/work/src/b.ts'
  w.files.set(B2, 'before\n')
  await $.turn.start({ text: 'more', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: B2, old_string: 'before', new_string: 'after' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(w.last('index').turns.map((t: any) => [t.turnId, t.ordinal])).toEqual([
    ['t1', 1],
    ['t2', 2],
  ])
})

test('resumed, untouched since: the revert lands and Claude is told the right turn', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  await resume($, w)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'select-t1' })
  await pane.press({ key: `revert-${FILE}` })
  await pane.press({ key: `confirm-${FILE}` })
  expect(w.files.get(PATH)).toBe('before\n')
  const note = w.session.appended().find(row => row.message.type === 'user')
  expect(JSON.stringify(note?.message.content)).toContain('reverted C:/work/src/a.ts to its state before turn #1')
})

test('resumed, the file changed while no session watched: the revert is refused, nothing written', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  await resume($, w)
  w.files.set(PATH, 'edited between sessions\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'select-t1' })
  await pane.press({ key: `revert-${FILE}` })
  expect(await pane.find({ key: `confirm-${FILE}` })).toBeUndefined()
  expect(await texts(pane)).toContain("src/a.ts changed since Claude's last edit, so it was left alone.")
  expect(w.files.get(PATH)).toBe('edited between sessions\n')
})

test('a saved history that does not read is ignored whole, and the pane says so', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  await resume($, w)
  w.files.set(`${STORE}/index.json`, '{"format":1,"sessionId":"s1","index":{"turns":[')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  expect(w.last('index').turns).toEqual([])
  const pane = await mountPane($, 'terminal')
  expect(await texts(pane)).toContain('The history saved for this conversation could not be read, so it starts empty here.')
})

test('the end only gives the lease up and marks the folder: no removal, no command', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  const runs = w.runs.length
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(w.runs.length).toBe(runs)
  expect(JSON.parse(w.files.get(`${STORE}/lease.json`)!).at).toBe(0)
  expect(JSON.parse(w.files.get(`${STORE}/index.json`)!).index.turns.length).toBe(1)
})

test('keepHistoryDays 0: a real end removes the copies, as before', { options: { trackShell: false, keepHistoryDays: 0 } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  expect(w.files.has(`${STORE}/index.json`)).toBe(false)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(removals(w)).toBe(1)
})

test('another window holds the conversation: the history shows, read-only, and is not written', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  w.files.set(`${STORE}/lease.json`, JSON.stringify({ token: 'other-window', at: 1_000 }))
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await editTurn($)
  expect(w.files.has(`${STORE}/index.json`)).toBe(false)
  const pane = await mountPane($, 'terminal')
  expect(await texts(pane)).toContain('This conversation is also open in another Claude Code window.')
  expect((await $.command.run({ command: 'changes', args: 'forget' } as never) as { text: string }).text).toContain('Forget it there.')
})

test('/changes forget deletes the kept history and copies, and starts empty', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  const result = await $.command.run({ command: 'changes', args: 'forget' } as never)
  expect((result as { text: string }).text).toBe("Changes deleted this conversation's history and its saved copies.")
  expect(removals(w)).toBe(1)
  expect(w.last('index').edits).toEqual([])
})

test('a kept index whose snapshots folder is gone starts fresh, never pointing at missing copies', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  expect(w.last('index').edits.length).toBe(1)
  for (const path of [...w.files.keys()]) if (path.startsWith(STORE + '/')) w.files.delete(path)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  expect(w.last('index').edits).toEqual([])
})

test('a kept index whose snapshots are still there goes on (a hot reload)', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  const writes = w.writes.length
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  expect(w.writes.slice(writes).some(x => x.key === 'index')).toBe(false)
  expect(w.last('index').edits.length).toBe(1)
})

test('cross-review #6: the confirm is disarmed before the revert runs', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: `revert-${FILE}` })
  const from = w.writes.length
  await pane.press({ key: `confirm-${FILE}` })
  const later = w.writes.slice(from)
  const disarm = later.findIndex(x => x.key === 'view' && (x.value as any).confirm === null)
  const recorded = later.findIndex(x => x.key === 'index')
  expect(disarm >= 0 && recorded > disarm).toBe(true)
  expect((later[disarm].value as any).notice).toBe('Reverting…')
})

// autoOpen: the layout comes from the prompt hint's drawing.
async function autoOpenRun($: Engine, on: On, viewport: { columns: number; rows: number; isFullscreen?: boolean }) {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.ui.mount({ plugin: 'changes', surface: 'terminal', component: 'PromptHint', props: {} as never, viewport })
  await editTurn($, 't1')
  return w
}

test('autoOpen opens the pane once the first code turn ends, docked and wide', { options: { trackShell: false, autoOpen: true } }, async ($, on) => {
  const w = await autoOpenRun($, on, { columns: 160, rows: 40, isFullscreen: true })
  expect(w.opened).toEqual(['changes'])
  expect(w.last('autoOpened')).toBe(true)
  // Once per session: a later turn opens nothing more.
  await editTurn($, 't2')
  expect(w.opened).toEqual(['changes'])
})

test('autoOpen stays shut on a narrow terminal', { options: { trackShell: false, autoOpen: true } }, async ($, on) => {
  const w = await autoOpenRun($, on, { columns: 120, rows: 40, isFullscreen: true })
  expect(w.opened).toEqual([])
})

test('autoOpen stays shut where panes do not dock, or the surface does not say', { options: { trackShell: false, autoOpen: true } }, async ($, on) => {
  const w = await autoOpenRun($, on, { columns: 200, rows: 40, isFullscreen: false })
  expect(w.opened).toEqual([])
})

test('autoOpen off (the default) never opens the pane', { options: { trackShell: false } }, async ($, on) => {
  const w = await autoOpenRun($, on, { columns: 200, rows: 40, isFullscreen: true })
  expect(w.opened).toEqual([])
})

test("the band's Open shows only while the pane is shut", { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const band = await mountBand($, 'terminal')
  await editTurn($)
  await band.press({ key: 'open' })
  expect(w.opened).toEqual(['changes'])
  expect((await band.find({ key: 'changes-band' }))?.text).toContain('Turn #1 changed 1 file')
  expect(await band.find({ key: 'open' })).toBeUndefined()
  expect(await band.find({ key: 'hide' })).toBeDefined()
  // The person closes the pane (a test's `$` can't raise ui.close, whose hook
  // redraws the band); the band's next draw offers Open again.
  w.panes.delete('changes')
  w.files.set(PATH, 'before\n')
  await editTurn($, 't2')
  expect((await band.find({ key: 'changes-band' }))?.text).toContain('Turn #2 changed 1 file')
  expect(await band.find({ key: 'open' })).toBeDefined()
})

test('a pane waiting undrawn on a narrow terminal keeps the band\'s Open', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  w.panes.set('changes', { id: 'changes', title: 'Changes', isShown: false, isFocused: false, isPlaced: false })
  const band = await mountBand($, 'terminal')
  await editTurn($)
  expect(await band.find({ key: 'open' })).toBeDefined()
})

test('a turn is titled by its prompt on one line, cut at a word', { options: { trackShell: false } }, async ($, on) => {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await editTurn($, 't1', 'Fix "a" in src/a.ts,\nthen run the tests and tell me what failed and why it failed')
  const pane = await mountPane($, 'terminal')
  expect((await pane.find({ key: 'select-t1' }))?.text).toContain('#1 "Fix "a" in src/a.ts, then run the tests and tell me what…" · 1 file')
})

// ── Revert all ──

const B = 'C:/work/src/b.ts'
const FILE_B = 't1-c:/work/src/b.ts'

// One turn that edits src/a.ts and src/b.ts from "before" to "after".
async function twoFileTurn($: Engine, on: On, surface: Surface) {
  const w = world(on)
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  w.files.set(B, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface, isInteractive: true } as never)
  await $.turn.start({ text: 'fix both', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'before', new_string: 'after' })
  await $.tool.call({ tool: 'Edit', file_path: B, old_string: 'before', new_string: 'after' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  return w
}

for (const surface of SURFACES) {
  test(`${surface}: Revert all is two presses; the first writes nothing`, { options: { trackShell: false } }, async ($, on) => {
    const w = await twoFileTurn($, on, surface)
    const pane = await mountPane($, surface)
    expect((await pane.find({ key: 'revertall-t1' }))?.text).toContain('Revert all (#1)')
    await pane.press({ key: 'revertall-t1' })
    expect(w.files.get(PATH)).toBe('after\n')
    expect(w.files.get(B)).toBe('after\n')
    expect((await pane.find({ key: 'confirmall-t1' }))?.text).toContain('Confirm revert all (#1): write 2, skip 0')
    await pane.press({ key: 'confirmall-t1' })
    expect(w.files.get(PATH)).toBe('before\n')
    expect(w.files.get(B)).toBe('before\n')
    expect(await texts(pane)).toContain('Reverted 2 files of #1.')
    // One note to Claude for both files.
    const notes = w.session.appended().filter(row => row.message.type === 'user')
    expect(notes).toHaveLength(1)
    expect(JSON.stringify(notes[0].message.content)).toContain('C:/work/src/a.ts, C:/work/src/b.ts')
    // Nothing pending is left, so Revert all goes.
    expect(await pane.find({ key: 'revertall-t1' })).toBeUndefined()
  })
}

test('Revert all skips a file changed outside Claude and offers it its own way on', { options: { trackShell: false } }, async ($, on) => {
  const w = await twoFileTurn($, on, 'terminal')
  const pane = await mountPane($, 'terminal')
  w.files.set(B, 'edited by hand\n')
  await pane.press({ key: 'revertall-t1' })
  expect((await pane.find({ key: 'confirmall-t1' }))?.text).toContain('write 1, skip 1')
  expect(await texts(pane)).toContain("Revert all skips 1 of #1's files: src/b.ts changed since Claude's last edit")
  await pane.press({ key: 'confirmall-t1' })
  expect(w.files.get(PATH)).toBe('before\n')
  expect(w.files.get(B)).toBe('edited by hand\n')
  expect(await texts(pane)).toContain('Reverted 1 file of #1. Skipped 1 file: src/b.ts changed since')
  // A changed-externally refusal has no way on: no bulk "anyway", no offer.
  expect(await pane.find({ key: `offer-${FILE_B}` })).toBeUndefined()
})

test('Revert all on a turn with nothing it can revert explains, with no confirm', { options: { trackShell: false } }, async ($, on) => {
  const w = await twoFileTurn($, on, 'terminal')
  const pane = await mountPane($, 'terminal')
  w.files.set(PATH, 'mine\n')
  w.files.set(B, 'mine too\n')
  await pane.press({ key: 'revertall-t1' })
  expect(await pane.find({ key: 'confirmall-t1' })).toBeUndefined()
  expect(await texts(pane)).toContain('Nothing in #1 can be reverted.')
  expect(w.files.get(PATH)).toBe('mine\n')
})

test('Revert all leaves a kept file alone and says so', { options: { trackShell: false } }, async ($, on) => {
  const w = await twoFileTurn($, on, 'terminal')
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: `keep-${FILE_B}` })
  await pane.press({ key: 'revertall-t1' })
  expect((await pane.find({ key: 'confirmall-t1' }))?.text).toContain('write 1, skip 1')
  await pane.press({ key: 'confirmall-t1' })
  expect(w.files.get(PATH)).toBe('before\n')
  expect(w.files.get(B)).toBe('after\n')
  expect(await texts(pane)).toContain('src/b.ts is kept.')
})

test('a later turn on the same file: Revert all skips it and offers Revert with #2 on its row', { options: { trackShell: false } }, async ($, on) => {
  const w = await twoFileTurn($, on, 'terminal')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: B, old_string: 'after', new_string: 'later' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'select-t1' })
  await pane.press({ key: 'revertall-t1' })
  await pane.press({ key: 'confirmall-t1' })
  expect(w.files.get(PATH)).toBe('before\n')
  expect(w.files.get(B)).toBe('later\n')
  expect((await pane.find({ key: `offer-${FILE_B}` }))?.text).toContain('Revert with #2')
  // The offer is that file's own two-press revert: its confirm, nothing written yet.
  await pane.press({ key: `offer-${FILE_B}` })
  expect(w.files.get(B)).toBe('later\n')
  expect((await pane.find({ key: `confirm-${FILE_B}` }))?.text).toContain('Confirm revert (#1, #2)')
})

// Open opens the pane before it selects the band's turn: the pane's drawing
// read the view, so the selection's write draws it again, on that turn.
test("the band's Open shows the band's turn selected, not the pane's last view", { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'select-t1' })
  w.files.set(PATH, 'before\n')
  await editTurn($, 't2')
  const band = await mountBand($, 'terminal')
  await band.press({ key: 'open' })
  expect((await pane.find({ key: 'select-t2' }))?.text).toContain('▾ #2')
  expect((await pane.find({ key: 'select-t1' }))?.text).toContain('▸ #1')
})

const WAITS = 'the window is 80 columns wide; widen it to 110'

for (const surface of SURFACES) {
  test(`${surface}: Open on a pane that waits undrawn says why, once`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    w.placement.reason = WAITS
    const band = await mountBand($, surface)
    await band.press({ key: 'open' })
    expect(w.toasts).toEqual([`Changes pane is ready but not shown yet: ${WAITS}.`])
    // Still waiting, so the band keeps Open; the next press says it again, once.
    await band.press({ key: 'open' })
    expect(w.toasts).toHaveLength(2)
  })

  test(`${surface}: Open on a pane that is drawn says nothing`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, surface)
    const band = await mountBand($, surface)
    await band.press({ key: 'open' })
    expect(w.opened).toEqual(['changes'])
    expect(w.toasts).toEqual([])
  })

  test(`${surface}: /changes answers why the pane waits, or that it opened`, { options: { trackShell: false } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: 'C:/work', surface, isInteractive: true } as never)
    w.placement.reason = WAITS
    const waiting = await $.command.run({ command: 'changes', args: '' } as never)
    expect((waiting as { text: string }).text).toBe(`Changes pane is ready but not shown yet: ${WAITS}.`)
    w.placement.reason = null
    const drawn = await $.command.run({ command: 'changes', args: '' } as never)
    expect((drawn as { text: string }).text).toBe('Changes pane opened.')
    expect(w.toasts).toEqual([])
  })
}

test('autoOpen on a pane that waits undrawn says nothing: the person did not ask', { options: { trackShell: false, autoOpen: true } }, async ($, on) => {
  const w = world(on)
  w.placement.reason = WAITS
  engineDraws(on)
  editingTool(on, w)
  w.files.set(PATH, 'before\n')
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await $.ui.mount({ plugin: 'changes', surface: 'terminal', component: 'PromptHint', props: {} as never, viewport: { columns: 160, rows: 40, isFullscreen: true } })
  await editTurn($)
  expect(w.opened).toEqual(['changes'])
  expect(w.toasts).toEqual([])
})

test('/changes opens the pane', { options: { trackShell: false } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const result = await $.command.run({ command: 'changes', args: '' } as never)
  expect((result as { text: string }).text).toBe('Changes pane opened.')
})
