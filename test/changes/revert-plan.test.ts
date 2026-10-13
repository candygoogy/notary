import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyIndex, type Content, type Index } from '../../plugins/changes/hooks/core/model.ts'
import { addEdit, openTurn, recordRevert, setStatus, type EditInput } from '../../plugins/changes/hooks/core/timeline.ts'
import { planRevert } from '../../plugins/changes/hooks/core/revert-plan.ts'

const text = (hash: string): Content => ({ hash, size: 1, kind: 'text', eol: 'lf', bom: false })
const binary = (hash: string): Content => ({ hash, size: 1, kind: 'binary', eol: 'none', bom: false })
const ABSENT: Content = { absent: true }

let clock = 0
function edit(key: string, before: Content, after: Content, over: Partial<EditInput> = {}): EditInput {
  clock += 10
  return { toolUseId: `tu${clock}`, tool: 'Edit', via: 'tool', path: key, key, before, after, startedAt: clock, at: clock + 1, ...over }
}

// Turn t1 edits a: h0 → h1; t2 edits a: h1 → h2; t3 edits a: h2 → h3.
function threeTurns(): Index {
  let index = emptyIndex()
  index = openTurn(index, { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('h0'), text('h1')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('h1'), text('h2')))
  index = openTurn(index, { turnId: 't3', prompt: '', at: 3 })
  index = addEdit(index, edit('a', text('h2'), text('h3')))
  return index
}

test('the latest turn reverts to its before when the disk matches its after', () => {
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't3', key: 'a' }, 'turn', text('h3')), {
    ok: true,
    target: text('h2'),
    restore: { kind: 'write-text', hash: 'h2' },
    refs: [{ turnId: 't3', key: 'a' }],
  })
})

test('an earlier turn with later changes is changed-since, naming the later turns', () => {
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't1', key: 'a' }, 'turn', text('h3')), {
    ok: false,
    reason: 'changed-since',
    otherTurns: ['t2', 't3'],
  })
})

test('turnAndLater restores the earliest before and marks every later change', () => {
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't1', key: 'a' }, 'turnAndLater', text('h3')), {
    ok: true,
    target: text('h0'),
    restore: { kind: 'write-text', hash: 'h0' },
    refs: [
      { turnId: 't1', key: 'a' },
      { turnId: 't2', key: 'a' },
      { turnId: 't3', key: 'a' },
    ],
  })
})

test('later turns already reverted no longer count', () => {
  let index = threeTurns()
  // Reverting t2 and t3 together took the disk from h3 back to h1.
  index = recordRevert(index, { key: 'a', path: 'a', before: text('h3'), after: text('h1'), refs: [{ turnId: 't2', key: 'a' }, { turnId: 't3', key: 'a' }], at: 50 })
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turn', text('h1')), {
    ok: true,
    target: text('h0'),
    restore: { kind: 'write-text', hash: 'h0' },
    refs: [{ turnId: 't1', key: 'a' }],
  })
})

test('kept later turns still count, since their content is on disk', () => {
  let index = threeTurns()
  index = setStatus(index, [{ turnId: 't3', key: 'a' }], 'kept')
  const plan = planRevert(index, { turnId: 't2', key: 'a' }, 'turn', text('h3'))
  assert.deepEqual(plan, { ok: false, reason: 'changed-since', otherTurns: ['t3'] })
})

test('a disk state no turn left is changed-externally', () => {
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't3', key: 'a' }, 'turn', text('someone-else')), {
    ok: false,
    reason: 'changed-externally',
  })
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't1', key: 'a' }, 'turnAndLater', text('someone-else')), {
    ok: false,
    reason: 'changed-externally',
  })
})

test('a file deleted outside Claude is changed-externally', () => {
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't3', key: 'a' }, 'turn', ABSENT), { ok: false, reason: 'changed-externally' })
})

test('a new file reverts by deleting it', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('n', ABSENT, text('n1')))
  const plan = planRevert(index, { turnId: 't1', key: 'n' }, 'turn', text('n1'))
  assert.deepEqual(plan, { ok: true, target: ABSENT, restore: { kind: 'delete' }, refs: [{ turnId: 't1', key: 'n' }] })
})

test('a file the shell deleted reverts by writing it back', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('d', text('d0'), ABSENT, { tool: 'Bash', via: 'shell' }))
  const plan = planRevert(index, { turnId: 't1', key: 'd' }, 'turn', ABSENT)
  assert.deepEqual(plan, { ok: true, target: text('d0'), restore: { kind: 'write-text', hash: 'd0' }, refs: [{ turnId: 't1', key: 'd' }] })
})

test('binary content restores through the bytes path', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('img', binary('b0'), binary('b1')))
  const plan = planRevert(index, { turnId: 't1', key: 'img' }, 'turn', binary('b1'))
  assert.equal(plan.ok && plan.restore.kind, 'write-bytes')
})

test('a before known only to git restores from git', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('g', { git: { oid: 'abc123', commit: 'c0ffee' } }, text('g1'), { tool: 'Bash', via: 'shell' }))
  const plan = planRevert(index, { turnId: 't1', key: 'g' }, 'turn', text('g1'))
  assert.deepEqual(plan.ok && plan.restore, { kind: 'git-restore', commit: 'c0ffee', oid: 'abc123' })
})

test('an unreadable before cannot be restored', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('big', { unreadable: 'too-large' }, text('x')))
  index = addEdit(index, edit('lost', { unreadable: 'io' }, text('y')))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'big' }, 'turn', text('x')), { ok: false, reason: 'too-large' })
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'lost' }, 'turn', text('y')), { ok: false, reason: 'no-snapshot' })
})

test('an unreadable after can still be reverted when the disk can be read now', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('h0'), { unreadable: 'io' }))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turn', text('anything')), { ok: false, reason: 'changed-externally' })
})

test('a disk that cannot be read now is reported as such', () => {
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't3', key: 'a' }, 'turn', { unreadable: 'too-large' }), { ok: false, reason: 'too-large' })
  assert.deepEqual(planRevert(threeTurns(), { turnId: 't3', key: 'a' }, 'turn', { unreadable: 'io' }), { ok: false, reason: 'io' })
})

test('a disk already at the target only needs marking', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('h0'), text('h1')))
  index = addEdit(index, edit('b', text('b0'), text('b1')))
  // a is back at h0 already, through a later turn that wrote h0 again.
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('h1'), text('h0')))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('h0')), {
    ok: true,
    target: text('h0'),
    restore: { kind: 'none' },
    refs: [{ turnId: 't1', key: 'a' }, { turnId: 't2', key: 'a' }],
  })
})

test('an already reverted change, a no-op, and an unknown file are refused', () => {
  let index = threeTurns()
  index = setStatus(index, [{ turnId: 't3', key: 'a' }], 'reverted')
  assert.deepEqual(planRevert(index, { turnId: 't3', key: 'a' }, 'turn', text('h2')), { ok: false, reason: 'already-reverted' })
  assert.deepEqual(planRevert(index, { turnId: 't3', key: 'zzz' }, 'turn', text('h2')), { ok: false, reason: 'nothing-to-revert' })

  let noop = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  noop = addEdit(noop, edit('a', text('h0'), text('h1')))
  noop = addEdit(noop, edit('a', text('h1'), text('h0')))
  assert.deepEqual(planRevert(noop, { turnId: 't1', key: 'a' }, 'turn', text('h0')), { ok: false, reason: 'nothing-to-revert' })
})

test('other files and other turns\' files are not touched', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('a0'), text('a1')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('b', text('b0'), text('b1')))
  const plan = planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('a1'))
  assert.deepEqual(plan.ok && plan.refs, [{ turnId: 't1', key: 'a' }])
})
