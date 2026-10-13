// Regression tests for the independent review's finding #3 (an unbounded
// index), plus closeAgent and recordRevert.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyIndex, statusKey, type Content, type Index } from '../../plugins/changes/hooks/core/model.ts'
import {
  addEdit,
  addUntracked,
  appendedSize,
  closeAgent,
  closeTurn,
  fitToSize,
  linkAgent,
  MAX_EDITS,
  openTurn,
  recordRevert,
  statusOf,
  timeline,
  turnFiles,
  type EditInput,
} from '../../plugins/changes/hooks/core/timeline.ts'

const text = (hash: string): Content => ({ hash, size: 1, kind: 'text', eol: 'lf', bom: false })

let clock = 0
function edit(key: string, over: Partial<EditInput> = {}): EditInput {
  clock += 10
  return { toolUseId: `tu${clock}`, tool: 'Edit', via: 'tool', path: key, key, before: text(`b${clock}`), after: text(`a${clock}`), startedAt: clock, at: clock + 1, ...over }
}

// `turns` closed turns of `perTurn` edits each.
function filled(turns: number, perTurn: number, index: Index = emptyIndex()): Index {
  for (let t = 1; t <= turns; t++) {
    index = openTurn(index, { turnId: `t${t}`, prompt: '', at: t })
    for (let i = 0; i < perTurn; i++) index = addEdit(index, edit(`f${i}`))
    index = closeTurn(index, { turnId: `t${t}`, at: t, reason: 'answer' })
  }
  return index
}

test(`#3: edits are capped at ${MAX_EDITS}, the oldest turns going first`, () => {
  const index = filled(12, 500)
  assert.ok(index.edits.length <= MAX_EDITS)
  assert.equal(index.turns[0].turnId, 't3')
  assert.ok(index.edits.every(e => e.turnId !== 't1' && e.turnId !== 't2'))
})

test('re-review 4: trimming records, per file, the highest seq it dropped', () => {
  const index = filled(12, 500)
  const droppedMax = 2 * 500 // t1 and t2 went, 500 edits each, seqs interleaved with turn starts
  assert.ok(index.trimmed['f0'] > 0)
  assert.ok(Object.values(index.trimmed).every(seq => seq <= droppedMax + 10))
  assert.ok(Object.values(index.trimmed).every(seq => index.edits.every(e => e.seq > seq)))
})

test('#3: the open turn is never trimmed, even past the cap', () => {
  let index = openTurn(emptyIndex(), { turnId: 'big', prompt: '', at: 1 })
  for (let i = 0; i < MAX_EDITS + 10; i++) index = addEdit(index, edit('f'))
  assert.equal(index.edits.length, MAX_EDITS + 10)
  assert.equal(index.turns.length, 1)
})

test('#3: a turn whose agent still runs is kept; once the agent ends it can go', () => {
  let index = openTurn(emptyIndex(), { turnId: 'spawner', prompt: '', at: 1 })
  index = linkAgent(index, { agentId: 'slow', parentToolUseId: 's' })
  index = addEdit(index, edit('x', { agentId: 'slow' }))
  index = closeTurn(index, { turnId: 'spawner', at: 2, reason: 'answer' })
  index = filled(11, 500, index)
  assert.ok(index.turns.some(t => t.turnId === 'spawner'))
  assert.equal(index.agents.find(a => a.agentId === 'slow')?.turnId, 'spawner')

  // Once it ends, the spawning turn is the oldest and goes at the next trim.
  index = closeAgent(index, 'slow', 99)
  const oldestOther = index.turns.find(t => t.turnId !== 'spawner')!.turnId
  for (let i = 0; i < 600; i++) index = addEdit(index, edit('more'))
  assert.ok(!index.turns.some(t => t.turnId === 'spawner'))
  assert.ok(index.turns.some(t => t.turnId === oldestOther) || index.edits.length <= MAX_EDITS)
})

test('#3: a background bucket whose agent still runs is kept', () => {
  let index = addEdit(emptyIndex(), edit('x', { agentId: 'ghost' }))
  index = filled(11, 500, index)
  assert.ok(index.turns.some(t => t.turnId === 'background:ghost'))
})

test('#3: fitToSize trims until the JSON fits, and says when it cannot', () => {
  const index = filled(10, 200)
  const budget = Math.floor(JSON.stringify(index).length / 2)
  const fitted = fitToSize(index, budget)
  assert.equal(fitted.fits, true)
  assert.ok(JSON.stringify(fitted.index).length <= budget)
  assert.ok(fitted.index.turns.length < index.turns.length)

  let open = openTurn(emptyIndex(), { turnId: 'open', prompt: '', at: 1 })
  for (let i = 0; i < 50; i++) open = addEdit(open, edit('f'))
  assert.equal(fitToSize(open, 100).fits, false)
})

test('#3: a small index passes fitToSize untouched', () => {
  const index = filled(2, 3)
  assert.equal(fitToSize(index).index, index)
})

test('review 2 #2b: a long pasted prompt is stored cut to 200 characters', () => {
  const index = openTurn(emptyIndex(), { turnId: 't1', prompt: 'x'.repeat(120_000), at: 1 })
  assert.equal(index.turns[0].prompt.length, 200)
})

test('review 2 #2a: fitToSize measures characters, not records', () => {
  // Few records, many characters: long paths in every edit.
  let index = openTurn(emptyIndex(), { turnId: 't0', prompt: '', at: 0 })
  index = closeTurn(index, { turnId: 't0', at: 0, reason: 'answer' })
  for (let t = 1; t <= 40; t++) {
    index = openTurn(index, { turnId: `t${t}`, prompt: '', at: t })
    index = addEdit(index, edit(`f${t}`, { path: 'p'.repeat(120_000) }))
    index = closeTurn(index, { turnId: `t${t}`, at: t, reason: 'answer' })
  }
  assert.ok(JSON.stringify(index).length > 4_000_000)
  const fitted = fitToSize(index)
  assert.equal(fitted.fits, true)
  assert.ok(JSON.stringify(fitted.index).length <= 4_000_000)
})

test('addUntracked files a call on its turn and the timeline shows it there', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addUntracked(index, { toolUseId: 'b1', tool: 'Bash', reason: 'many files changed (5123)', at: 2 })
  assert.deepEqual(index.untracked.map(u => [u.turnId, u.reason]), [['t1', 'many files changed (5123)']])
  const row = timeline(index)[0]
  assert.equal(row.kind === 'turn' && row.untracked.length, 1)
})

test('cross-review #8: appendedSize tracks the JSON growth of an append to within its slack', () => {
  let prev = openTurn(emptyIndex(), { turnId: 't1', prompt: 'p', at: 1 })
  for (let i = 0; i < 20; i++) prev = addEdit(prev, edit(`f${i}`))
  const next = addEdit(prev, edit('g', { path: 'x'.repeat(5000) }))
  const added = appendedSize(prev, next)
  const real = JSON.stringify(next).length - JSON.stringify(prev).length
  assert.ok(added !== null && added >= real && added - real <= 100, `${added} vs ${real}`)
})

test('cross-review #8: appendedSize gives up on anything but an append', () => {
  const prev = filled(3, 2)
  // Closing an existing turn replaces its record.
  assert.equal(appendedSize(prev, closeTurn(prev, { turnId: 't1', at: 99, reason: 'aborted' })), null)
  const trimmed = { ...prev, edits: prev.edits.slice(1) }
  assert.equal(appendedSize(prev, trimmed), null)
  assert.equal(appendedSize(prev, { ...prev, trimmed: { a: 1 } }), null)
})

test('closeAgent marks the agent ended once', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = linkAgent(index, { agentId: 'A', parentToolUseId: 's' })
  index = closeAgent(index, 'A', 5)
  assert.equal(index.agents[0].endedAt, 5)
  assert.equal(closeAgent(index, 'A', 9), index)
})

test('recordRevert adds the transition, marks the refs and logs the action, outside every turn', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', { before: text('X'), after: text('Y') }))
  index = recordRevert(index, { key: 'a', path: 'a', before: text('Y'), after: text('X'), refs: [{ turnId: 't1', key: 'a' }], at: 70 })
  const transition = index.edits[index.edits.length - 1]
  assert.equal(transition.via, 'revert')
  assert.equal(transition.turnId, 'revert')
  assert.equal(statusOf(index, 't1', 'a'), 'reverted')
  assert.equal(index.status[statusKey('t1', 'a')], 'reverted')
  assert.deepEqual(index.actions.map(a => [a.kind, a.turnIds]), [['revert', ['t1']]])
  assert.equal(turnFiles(index, 't1').length, 1)
  assert.deepEqual(timeline(index).map(r => r.kind), ['action', 'turn'])
})
