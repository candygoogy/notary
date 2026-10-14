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

for (const reason of ['clear', 'resume'] as const) {
  test(`/${reason} removes the snapshots and starts the history fresh; the next turn is tracked again`, { options: { trackShell: false } }, async ($, on) => {
    const w = await edited($, on, 'terminal')
    const removals = () => w.runs.filter(argv => argv.join(' ').includes('Get-ChildItem')).length
    await $.session.end({ reason, sessionId: 's1' } as never)
    expect(removals()).toBe(1)
    expect(w.last('index').edits).toEqual([])
    expect(w.last('session')).toBeNull()
    expect(w.last('band')).toBeNull()

    // No session.start follows a /clear: the next hook sets the session up.
    w.files.set(PATH, 'before\n')
    await editTurn($, 't2')
    const index = w.last('index')
    expect(index.edits.length).toBe(1)
    expect(index.turns.map((t: any) => [t.turnId, t.ordinal])).toEqual([['t2', 1]])
    expect(w.last('session').store).toBe(STORE)
  })
}

test('a real end removes the snapshots too', { options: { trackShell: false } }, async ($, on) => {
  const w = await edited($, on, 'terminal')
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  expect(w.runs.filter(argv => argv.join(' ').includes('Get-ChildItem')).length).toBe(1)
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

test('/changes opens the pane', { options: { trackShell: false } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const result = await $.command.run({ command: 'changes', args: '' } as never)
  expect((result as { text: string }).text).toBe('Changes pane opened.')
})
