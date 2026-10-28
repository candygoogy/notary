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
  // What the engine answers an open: drawn, or waiting with its reason (set
  // `placement.reason` to make the next opens wait).
  const placement: { reason: string | null } = { reason: null }
  const toasts: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    const isPlaced = placement.reason === null
    panes.set(e.id, { id: e.id, title: e.title ?? e.id, isShown: isPlaced, isFocused: false, isPlaced })
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: placement.reason } } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
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
  return { opened, settings, panes, placement, toasts }
}

const WAITS = 'the window is 80 columns wide; widen it to 110'

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

  test(`${surface}: [Details] on a pane that waits undrawn says why, once`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    const s = screen(on)
    await contradictedTurn($, w)
    s.placement.reason = WAITS
    const band = await mountBand($, surface)
    await band.press({ key: 'details' })
    expect(s.toasts).toEqual([`Receipts pane is ready but not shown yet: ${WAITS}.`])
  })

  test(`${surface}: [Details] on a pane that is drawn says nothing`, { options: { mode: 'A' } }, async ($, on) => {
    const w = world(on)
    const s = screen(on)
    await contradictedTurn($, w)
    const band = await mountBand($, surface)
    await band.press({ key: 'details' })
    expect(s.opened).toEqual(['receipts'])
    expect(s.toasts).toEqual([])
  })

  test(`${surface}: /receipts answers why the pane waits, or that it opened`, async ($, on) => {
    const s = screen(on)
    s.placement.reason = WAITS
    const waiting = await $.command.run({ command: 'receipts', args: '', origin: composer, presentation: {} as never })
    expect(waiting.text).toBe(`Receipts pane is ready but not shown yet: ${WAITS}.`)
    s.placement.reason = null
    const drawn = await $.command.run({ command: 'receipts', args: '', origin: composer, presentation: {} as never })
    expect(drawn.text).toBe('Receipts pane opened.')
    expect(s.toasts).toEqual([])
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

const HOLDS = ' This holds for this conversation; to keep it, change it in /config.'

test('/receipts mode C holds for the conversation and writes no setting; a bad argument answers the usage', async ($, on) => {
  const s = screen(on)
  const ok = await $.command.run({ command: 'receipts', args: 'mode C', origin: composer, presentation: {} as never })
  expect(ok.text).toBe(`Receipts mode is now C.${HOLDS}`)
  const bad = await $.command.run({ command: 'receipts', args: 'mode Z', origin: composer, presentation: {} as never })
  expect(bad.text).toBe(USAGE)
  expect(s.settings).toEqual([])
})

test('/receipts off and smart on write no settings', async ($, on) => {
  const s = screen(on)
  await $.command.run({ command: 'receipts', args: 'off', origin: composer, presentation: {} as never })
  await $.command.run({ command: 'receipts', args: 'smart on', origin: composer, presentation: {} as never })
  expect(s.settings).toEqual([])
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

test('/receipts verbosity all holds for the conversation; a bad value answers the usage', async ($, on) => {
  const s = screen(on)
  const ok = await $.command.run({ command: 'receipts', args: 'verbosity all', origin: composer, presentation: {} as never })
  expect(s.settings).toEqual([])
  expect(ok.text).toBe(`Receipts verbosity is now all.${HOLDS}`)
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

const run = ($: Engine, args: string) => $.command.run({ command: 'receipts', args, origin: composer, presentation: {} as never })

test('/receipts check add, list and remove change the checks for the conversation', { options: { checks: ['build: make ci'] } }, async ($, on) => {
  const s = screen(on)
  expect((await run($, 'checks')).text).toBe('Receipts checks:\n  build: make ci')
  expect((await run($, 'check add "pnpm verify" tests')).text).toBe(`Receipts now counts pnpm verify as a test check.${HOLDS}`)
  expect((await run($, 'checks')).text).toBe('Receipts checks:\n  build: make ci\n  tests: pnpm verify')
  expect((await run($, 'check remove make ci')).text).toBe(`Receipts no longer counts make ci as a check.${HOLDS}`)
  expect((await run($, 'checks')).text).toBe('Receipts checks:\n  tests: pnpm verify')
  expect(s.settings).toEqual([])
  expect((await run($, 'check remove nope')).text).toBe('No check named nope.')
  expect((await run($, 'check add pnpm verify')).text).toBe(USAGE)
})

test('a check entry in neither form is named once, at session start', { options: { checks: ['pnpm verify'] } }, async ($, on) => {
  const s = screen(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.296', base: '2.1.296', builtAt: '' } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
  expect(s.toasts).toEqual(['Receipts ignored a check not written as "tests: <command>" or "build: <command>": pnpm verify'])
})
