import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { USAGE } from '../hooks/commands.ts'
import { answer, composer, edit, failing, landed, npmTest, passing, world } from './world.ts'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 3 },
  view: { skill: '', text: '' },
}
const PANE_PROPS = { title: 'Receipts', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } }

// The engine's side of the UI: pane opens and setting writes, recorded.
function screen(on: On) {
  const opened: string[] = []
  const settings: Array<{ key: string; value: unknown }> = []
  on('command.register', () => ({ value: undefined }) as never)
  // The engine's own drawing where Receipts passes: an empty, keyed Box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
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
  on('config.set', (_$, e) => {
    settings.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  return { opened, settings, panes }
}

function mountBand($: Engine, surface: Surface) {
  return $.ui.mount({ plugin: 'receipts', surface, component: 'AbovePrompt', props: BAND_PROPS as never })
}

function mountPane($: Engine, surface: Surface) {
  return $.ui.mount({ plugin: 'receipts', surface, component: 'Pane', requestId: 'receipts', props: PANE_PROPS as never })
}

async function contradictedTurn($: Engine, w: ReturnType<typeof world>, turnId = 't1') {
  await $.turn.start({ text: 'fix it', turnId })
  w.answers.push(landed, failing)
  await $.tool.call(edit)
  await $.tool.call(npmTest)
  await answer($, 'All tests pass.', turnId)
}

for (const surface of SURFACES) {
  test(`${surface}: the band is empty with no verdict and shows a contradiction`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    screen(on)
    const band = await mountBand($, surface)
    expect(await band.find({ key: 'band' })).toBeUndefined()
    await contradictedTurn($, w)
    await band.redraw()
    const shown = await band.find({ key: 'band' })
    expect(shown?.text).toContain('❌ Contradicted: "All tests pass." · npm test exited 1 (1 failed)')
  })

  test(`${surface}: [Dismiss] empties the band until the next verdict`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    screen(on)
    await contradictedTurn($, w)
    const band = await mountBand($, surface)
    await band.press({ key: 'hide' })
    await band.redraw()
    expect(await band.find({ key: 'band' })).toBeUndefined()
    await contradictedTurn($, w, 't2')
    await band.redraw()
    expect(await band.find({ key: 'band' })).toBeDefined()
  })

  test(`${surface}: [Details] opens the pane`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    const s = screen(on)
    await contradictedTurn($, w)
    const band = await mountBand($, surface)
    await band.press({ key: 'details' })
    expect(s.opened).toEqual(['receipts'])
  })

  test(`${surface}: [Details] shows only while the pane is shut`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    const s = screen(on)
    await contradictedTurn($, w)
    const band = await mountBand($, surface)
    await band.press({ key: 'details' })
    expect((await band.find({ key: 'band' }))?.text).toContain('❌ Contradicted')
    expect(await band.find({ key: 'details' })).toBeUndefined()
    expect(await band.find({ key: 'hide' })).toBeDefined()
    // The person closes the pane (a test's `$` can't raise ui.close, whose
    // hook redraws the band); the band's next draw offers Details again.
    s.panes.delete('receipts')
    await band.redraw()
    expect(await band.find({ key: 'details' })).toBeDefined()
  })

  test(`${surface}: a pane waiting undrawn keeps the band's [Details]`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    const s = screen(on)
    s.panes.set('receipts', { id: 'receipts', title: 'Receipts', isShown: false, isFocused: false, isPlaced: false })
    await contradictedTurn($, w)
    const band = await mountBand($, surface)
    expect(await band.find({ key: 'details' })).toBeDefined()
  })

  test(`${surface}: ✅ shows until the next prompt`, async ($, on) => {
    const w = world(on)
    screen(on)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    w.answers.push(landed, passing)
    await $.tool.call(edit)
    await $.tool.call(npmTest)
    await answer($, 'All tests pass.')
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'band' }))?.text).toContain('✅ Verified · npm test passed (42)')
    await $.prompt.submit({ text: 'thanks', wait: false, origin: composer })
    await band.redraw()
    expect(await band.find({ key: 'band' })).toBeUndefined()
  })

  test(`${surface}: the pane lists judged turns newest first`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    screen(on)
    await contradictedTurn($, w, 't1')
    await $.turn.start({ text: 'again', turnId: 't2' })
    w.answers.push(landed, passing)
    await $.tool.call(edit)
    await $.tool.call(npmTest)
    await answer($, "I've fixed the parser.", 't2')
    const pane = await mountPane($, surface)
    const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.findIndex(text => text.includes("I've fixed the parser."))).toBeLessThan(texts.findIndex(text => text.includes('All tests pass.')))
    expect(texts.some(text => text.startsWith("✅ I've fixed the parser."))).toBe(true)
    expect(texts.some(text => text.startsWith('❌ All tests pass.'))).toBe(true)
  })
}

test('/receipts opens the pane', async ($, on) => {
  const s = screen(on)
  const result = await $.command.run({ command: 'receipts', args: '', origin: composer, presentation: {} as never })
  expect(s.opened).toEqual(['receipts'])
  expect(result.text).toBe('Receipts pane opened.')
})

test('/receipts mode C writes the setting; a bad argument answers the usage', async ($, on) => {
  const s = screen(on)
  const ok = await $.command.run({ command: 'receipts', args: 'mode C', origin: composer, presentation: {} as never })
  expect(s.settings).toEqual([{ key: 'receipts.mode', value: 'C' }])
  expect(ok.text).toBe('Receipts mode is now C.')
  const bad = await $.command.run({ command: 'receipts', args: 'mode Z', origin: composer, presentation: {} as never })
  expect(bad.text).toBe(USAGE)
  expect(s.settings).toHaveLength(1)
})

test('/receipts off and smart on write their settings', async ($, on) => {
  const s = screen(on)
  await $.command.run({ command: 'receipts', args: 'off', origin: composer, presentation: {} as never })
  await $.command.run({ command: 'receipts', args: 'smart on', origin: composer, presentation: {} as never })
  expect(s.settings).toEqual([
    { key: 'receipts.enabled', value: false },
    { key: 'receipts.smartCheck', value: true },
  ])
})

// Review 6: off draws nothing.
for (const surface of SURFACES) {
  test(`${surface}: off, the band and the pane draw nothing of Receipts`, { options: { enabled: false } }, async ($, on) => {
    world(on)
    screen(on)
    const band = await mountBand($, surface)
    expect(await band.find({ key: 'band' })).toBeUndefined()
    const pane = await mountPane($, surface)
    expect(await pane.find({ key: 'receipts' })).toBeUndefined()
  })
}

test('/receipts verbosity all writes the setting; a bad value answers the usage', async ($, on) => {
  const s = screen(on)
  const ok = await $.command.run({ command: 'receipts', args: 'verbosity all', origin: composer, presentation: {} as never })
  expect(s.settings).toEqual([{ key: 'receipts.verbosity', value: 'all' }])
  expect(ok.text).toBe('Receipts verbosity is now all.')
  const bad = await $.command.run({ command: 'receipts', args: 'verbosity loud', origin: composer, presentation: {} as never })
  expect(bad.text).toBe(USAGE)
})

// Cross-review #1: two mods drawing above the prompt must not hide each other,
// whichever is first in the chain.
for (const surface of SURFACES) {
  for (const order of ['prepend', 'append'] as const) {
    test(
      `${surface}: Receipts' band and another mod's band both show (other mod ${order === 'prepend' ? 'first' : 'last'})`,
      {
        options: { mode: 'A' },
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
        const w = world(on)
        screen(on)
        await contradictedTurn($, w)
        const band = await mountBand($, surface)
        expect(await band.find({ key: 'band' })).toBeDefined()
        expect(await band.find({ key: 'other' })).toBeDefined()
      },
    )
  }
}

test('with room for one row only, Receipts draws its own row', { options: { mode: 'A' } }, async ($, on) => {
  const w = world(on)
  screen(on)
  await contradictedTurn($, w)
  const band = await $.ui.mount({ plugin: 'receipts', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows: 1 } as never })
  expect(await band.find({ key: 'band' })).toBeDefined()
  expect(await band.find({ key: 'engine' })).toBeUndefined()
})
