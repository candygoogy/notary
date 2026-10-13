import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SMART_MAX_TOKENS, SMART_MODEL, SMART_SYSTEM } from '../hooks/smartcheck.ts'
import { answer, edit, world } from './world.ts'

// Over 25 words with "but": the lexicon marks it 'maybe'.
const MAYBE =
  'I have updated the configuration loader so that it reads the new environment file first, ' +
  'but the legacy path is still consulted as a fallback when the new file is missing on older machines.'

type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: string } | 'throw'

function model(on: On, reply: Reply) {
  const asked: Array<{ model: string; maxTokens?: number; system?: string; prompt: string }> = []
  on('model.complete', (_$, e) => {
    asked.push({ model: e.model, maxTokens: e.maxTokens, system: e.system, prompt: e.prompt })
    if (reply === 'throw') throw new Error('the model is down')
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { ...reply, usage } } as never
  })
  return asked
}

test('smart check off: a maybe claim is dropped and no model is asked', async ($, on) => {
  const w = world(on)
  const asked = model(on, { isAnswered: true, text: 'YES' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, MAYBE)
  expect(asked).toEqual([])
  expect(w.stamps()).toEqual([])
})

test('smart check on: a YES keeps the maybe claim', { options: { smartCheck: true, verbosity: 'all' } }, async ($, on) => {
  const w = world(on)
  const asked = model(on, { isAnswered: true, text: 'YES' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, MAYBE)
  expect(asked).toEqual([{ model: SMART_MODEL, maxTokens: SMART_MAX_TOKENS, system: SMART_SYSTEM, prompt: MAYBE }])
  expect(w.stamps()).toEqual(['🧾 ⚠️ Unverified: no receipts · no check ran after the last edit'])
})

test('smart check on: a NO drops it', { options: { smartCheck: true } }, async ($, on) => {
  const w = world(on)
  model(on, { isAnswered: true, text: 'NO' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, MAYBE)
  expect(w.stamps()).toEqual([])
})

test('smart check on: an unanswered question drops it', { options: { smartCheck: true } }, async ($, on) => {
  const w = world(on)
  model(on, { isAnswered: false, reason: 'api-error' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, MAYBE)
  expect(w.stamps()).toEqual([])
})

test('smart check on: a model that throws drops it, and the turn still completes', { options: { smartCheck: true } }, async ($, on) => {
  const w = world(on, { expectLogs: true })
  model(on, 'throw')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit)
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: MAYBE })
  expect(stop.block).toBeUndefined()
  const done = await $.turn.complete({ answer: MAYBE, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(done.text).toBe(MAYBE)
  expect(w.stamps()).toEqual([])
  expect(w.logs.some(line => line.startsWith('receipts: smart check failed'))).toBe(true)
})

test('smart check on: sure claims are kept without asking', { options: { smartCheck: true } }, async ($, on) => {
  const w = world(on)
  const asked = model(on, { isAnswered: true, text: 'NO' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit)
  await answer($, 'All tests pass.')
  expect(asked).toEqual([])
  expect(w.stamps()).toHaveLength(1)
})
