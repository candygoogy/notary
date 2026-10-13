// Regression tests for the independent review's findings #1 and #2.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyIndex, type Content } from '../../plugins/changes/hooks/core/model.ts'
import { addEdit, linkAgent, openTurn, recordRevert, type EditInput } from '../../plugins/changes/hooks/core/timeline.ts'
import { planRevert } from '../../plugins/changes/hooks/core/revert-plan.ts'

const text = (hash: string): Content => ({ hash, size: 1, kind: 'text', eol: 'lf', bom: false })

let clock = 0
function edit(key: string, before: Content, after: Content, over: Partial<EditInput> = {}): EditInput {
  clock += 10
  return { toolUseId: `tu${clock}`, tool: 'Edit', via: 'tool', path: key, key, before, after, startedAt: clock, at: clock + 1, ...over }
}

// ── #1: changes outside the chain ──

test('#1: turnAndLater refuses when the person changed the file between turns', () => {
  // t1 X→Y; the person edits Y→U between turns; t2 U→V; the disk is V.
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('U'), text('V')))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turn', text('V')), { ok: false, reason: 'changed-since', otherTurns: ['t2'] })
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V')), {
    ok: false,
    reason: 'user-changed-between',
    between: ['t1', 't2'],
  })
})

test('#1: a change outside the chain after a reverted turn is caught too', () => {
  // t1 X→Y; t2 Y→Z; t2 reverted (Z→Y); the person edits Y→U; t3 U→V.
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('Y'), text('Z')))
  index = recordRevert(index, { key: 'a', path: 'a', before: text('Z'), after: text('Y'), refs: [{ turnId: 't2', key: 'a' }], at: 60 })
  index = openTurn(index, { turnId: 't3', prompt: '', at: 3 })
  index = addEdit(index, edit('a', text('U'), text('V')))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V')), {
    ok: false,
    reason: 'user-changed-between',
    between: ['revert', 't3'],
  })
})

test('#1: the same chain with no outside change reverts t1 and t3, not the reverted t2', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('Y'), text('Z')))
  index = recordRevert(index, { key: 'a', path: 'a', before: text('Z'), after: text('Y'), refs: [{ turnId: 't2', key: 'a' }], at: 60 })
  index = openTurn(index, { turnId: 't3', prompt: '', at: 3 })
  index = addEdit(index, edit('a', text('Y'), text('V')))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V')), {
    ok: true,
    target: text('X'),
    restore: { kind: 'write-text', hash: 'X' },
    refs: [
      { turnId: 't1', key: 'a' },
      { turnId: 't3', key: 'a' },
    ],
  })
})

test('#1: a break inside one turn is refused too', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = addEdit(index, edit('a', text('U'), text('V')))
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turn', text('V')), {
    ok: false,
    reason: 'user-changed-between',
    between: ['t1', 't1'],
  })
})

test('#1: acceptOutsideChanges lets the person revert anyway', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('U'), text('V')))
  const plan = planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V'), { acceptOutsideChanges: true })
  assert.deepEqual(plan.ok && plan.restore, { kind: 'write-text', hash: 'X' })
})

test('#1: a link that cannot be compared is refused, not assumed', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), { unreadable: 'io' }))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('Y'), text('V')))
  // Re-review minor 3: not blamed on the person.
  assert.deepEqual(planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V')), {
    ok: false,
    reason: 'unverifiable-link',
    between: ['t1', 't2'],
  })
})

test('re-review 3: a git blob after a commit against a hash is unverifiable, and "Revert anyway" passes it', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', { git: { oid: 'o', commit: 'c' } }, text('V'), { tool: 'Bash', via: 'shell' }))
  const plan = planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V'))
  assert.equal(!plan.ok && plan.reason, 'unverifiable-link')
  assert.equal(planRevert(index, { turnId: 't1', key: 'a' }, 'turnAndLater', text('V'), { acceptOutsideChanges: true }).ok, true)
})

test('re-review 4: a break where Claude\'s edits were trimmed away is history-trimmed', () => {
  // An async agent spawned in t1 edits a file late; t1 is trimmed, so the
  // chain of a later turn has a hole where the agent's edit was.
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = linkAgent(index, { agentId: 'A', parentToolUseId: 's' })
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = addEdit(index, edit('a', text('Y'), text('Z'), { agentId: 'A' }))
  index = openTurn(index, { turnId: 't3', prompt: '', at: 3 })
  index = addEdit(index, edit('a', text('Z'), text('V')))
  // Drop t1 as the bounds would, with its agent ended.
  index = { ...index, agents: index.agents.map(a => ({ ...a, endedAt: 9 })) }
  const trimmedSeq = index.edits.find(e => e.agentId === 'A')!.seq
  index = {
    ...index,
    turns: index.turns.filter(t => t.turnId !== 't1'),
    edits: index.edits.filter(e => e.turnId !== 't1'),
    agents: [],
    trimmed: { a: trimmedSeq },
  }
  assert.deepEqual(planRevert(index, { turnId: 't2', key: 'a' }, 'turnAndLater', text('V')), {
    ok: false,
    reason: 'history-trimmed',
    between: ['t2', 't3'],
  })
})

// ── #2: edit order, not turn order ──

// Agent A, spawned in t1, edits W→X; t2 edits X→Y; A edits Y→Z. The disk is Z.
function asyncAgent() {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = linkAgent(index, { agentId: 'A', parentToolUseId: 'spawn' })
  index = addEdit(index, edit('a', text('W'), text('X'), { agentId: 'A' }))
  index = openTurn(index, { turnId: 't2', prompt: '', at: 2 })
  index = addEdit(index, edit('a', text('X'), text('Y')))
  index = addEdit(index, edit('a', text('Y'), text('Z'), { agentId: 'A' }))
  return index
}

test('#2: reverting the spawning turn alone is refused while another turn edited inside its span', () => {
  assert.deepEqual(planRevert(asyncAgent(), { turnId: 't1', key: 'a' }, 'turn', text('Z')), {
    ok: false,
    reason: 'changed-since',
    otherTurns: ['t2'],
  })
})

test('#2: turnAndLater from the spawning turn restores W and marks both turns', () => {
  assert.deepEqual(planRevert(asyncAgent(), { turnId: 't1', key: 'a' }, 'turnAndLater', text('Z')), {
    ok: true,
    target: text('W'),
    restore: { kind: 'write-text', hash: 'W' },
    refs: [
      { turnId: 't1', key: 'a' },
      { turnId: 't2', key: 'a' },
    ],
  })
})

test('#2: the later turn is changed-since its earlier turn, not changed-externally', () => {
  assert.deepEqual(planRevert(asyncAgent(), { turnId: 't2', key: 'a' }, 'turn', text('Z')), {
    ok: false,
    reason: 'changed-since',
    otherTurns: ['t1'],
  })
})

test('#2: turnAndLater from the later turn widens back to the agent\'s first edit, and says so', () => {
  assert.deepEqual(planRevert(asyncAgent(), { turnId: 't2', key: 'a' }, 'turnAndLater', text('Z')), {
    ok: true,
    target: text('W'),
    restore: { kind: 'write-text', hash: 'W' },
    refs: [
      { turnId: 't1', key: 'a' },
      { turnId: 't2', key: 'a' },
    ],
    // Re-review minor 1: the confirmation must name the earlier turn.
    widenedTo: ['t1'],
  })
})
