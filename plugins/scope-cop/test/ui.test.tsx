import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { editOf, prompt, scope, start, world } from './world.tsx'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: { skill: '', text: '' } }
const PANE_PROPS = { title: 'Scope', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } }

function mountBand($: Engine, surface: Surface, props: Record<string, unknown> = {}) {
  return $.ui.mount({ plugin: 'scope-cop', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, ...props } as never })
}

function mountPane($: Engine, surface: Surface) {
  return $.ui.mount({ plugin: 'scope-cop', surface, component: 'Pane', requestId: 'scope', props: PANE_PROPS as never })
}

for (const surface of SURFACES) {
  test(`${surface}: no band without a scope; with one, a quiet row and the engine's drawing beneath`, async ($, on) => {
    world(on)
    await start($)
    const none = await mountBand($, surface)
    expect(await none.find({ key: 'scope-cop-band' })).toBeUndefined()
    await scope($, 'src/auth/**')
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'scope-cop-band' }))?.text).toContain('Scope: src/auth/** · nothing outside')
    expect(await band.find({ key: 'clear' })).toBeDefined()
    expect(await band.find({ key: 'engine' })).toBeDefined()
  })

  test(`${surface}: after an edit outside, the band names it; Allow file widens the scope`, async ($, on) => {
    world(on)
    await start($)
    await scope($, 'src/auth/**')
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call(editOf('C:/work/src/db/pool.ts'))
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'scope-cop-band' }))?.text).toContain('1 edit outside: src/db/pool.ts')
    await band.press({ key: 'allow' })
    expect((await mountBand($, surface).then(b => b.find({ key: 'scope-cop-band' })))?.text).toContain('Scope: src/auth/**, src/db/pool.ts · nothing outside')
    expect((await prompt($))[0]).toContain('src/auth/**, src/db/pool.ts')
  })

  test(`${surface}: Dismiss empties the list; the next prompt does too`, async ($, on) => {
    world(on)
    await start($)
    await scope($, 'src/auth/**')
    await $.tool.call(editOf('C:/work/src/db/pool.ts'))
    const band = await mountBand($, surface)
    await band.press({ key: 'dismiss' })
    expect((await (await mountBand($, surface)).find({ key: 'scope-cop-band' }))?.text).toContain('nothing outside')
    await $.tool.call(editOf('C:/work/src/db/other.ts'))
    await prompt($)
    expect((await (await mountBand($, surface)).find({ key: 'scope-cop-band' }))?.text).toContain('nothing outside')
  })

  test(`${surface}: Clear on the band clears the scope`, async ($, on) => {
    world(on)
    await start($)
    await scope($, 'src/auth/**')
    await (await mountBand($, surface)).press({ key: 'clear' })
    expect(await (await mountBand($, surface)).find({ key: 'scope-cop-band' })).toBeUndefined()
    expect(await prompt($)).toEqual([])
  })

  test(`${surface}: a file outside the project can't be allowed by a pattern: no Allow file`, async ($, on) => {
    world(on)
    await start($)
    await scope($, 'src/auth/**')
    await $.tool.call(editOf('D:/elsewhere/x.ts'))
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'scope-cop-band' }))?.text).toContain('1 edit outside: D:/elsewhere/x.ts')
    expect(await band.find({ key: 'allow' })).toBeUndefined()
  })
}

test('with room for one row only, the band draws its own row alone', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  const band = await mountBand($, 'terminal', { maxRows: 1 })
  expect(await band.find({ key: 'scope-cop-band' })).toBeDefined()
  expect(await band.find({ key: 'engine' })).toBeUndefined()
})

test('a survey above the prompt is left alone', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/**')
  const band = await mountBand($, 'terminal', { hasSurvey: true })
  expect(await band.find({ key: 'scope-cop-band' })).toBeUndefined()
})

test('the pane without a scope says how to set one', async ($, on) => {
  world(on)
  await start($)
  const empty = await mountPane($, 'terminal')
  expect((await empty.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('No scope set.')
})

test('the pane lists the patterns, the mode and the log, newest first; Remove drops a pattern', async ($, on) => {
  world(on)
  await start($)
  await scope($, 'src/auth/** test/auth/**')
  await $.tool.call(editOf('C:/work/src/db/a.ts'))
  await $.tool.call(editOf('C:/work/src/db/b.ts', 'agent-1'))
  const pane = await mountPane($, 'terminal')
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).toContain('Mode B: edits outside the scope are flagged, and Claude is told.')
  expect(text.indexOf('src/db/b.ts')).toBeLessThan(text.indexOf('src/db/a.ts'))
  expect(text).toContain('src/db/b.ts · Edit (subagent) · flagged, Claude told')
  await pane.press({ key: 'remove-test/auth/**' })
  expect((await prompt($))[0]).toContain('limited edits to src/auth/**.')
})
