import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyIndex, type Content, type Index } from '../../plugins/changes/hooks/core/model.ts'
import {
  addAction,
  addEdit,
  closeTurn,
  linkAgent,
  MAX_TURNS,
  openTurn,
  setStatus,
  statusOf,
  timeline,
  turnFiles,
  type EditInput,
} from '../../plugins/changes/hooks/core/timeline.ts'

const text = (hash: string): Content => ({ hash, size: 1, kind: 'text', eol: 'lf', bom: false })
const ABSENT: Content = { absent: true }

let clock = 0
function edit(over: Partial<EditInput> & { key: string; before: Content; after: Content }): EditInput {
  clock += 10
  return { toolUseId: `tu${clock}`, tool: 'Edit', via: 'tool', path: over.key, startedAt: clock, at: clock + 1, ...over }
}

function turn(index: Index, turnId: string, prompt = turnId): Index {
  return openTurn(index, { turnId, prompt, at: ++clock })
}

test('opening turns numbers them and tracks the open one', () => {
  let index = turn(emptyIndex(), 't1')
  index = closeTurn(index, { turnId: 't1', at: 5, reason: 'answer' })
  index = turn(index, 't2')
  assert.deepEqual(index.turns.map(t => [t.turnId, t.ordinal, t.kind]), [['t1', 1, 'turn'], ['t2', 2, 'turn']])
  assert.equal(index.turns[0].endedAt, 5)
  assert.equal(index.turns[0].reason, 'answer')
  assert.equal(index.openTurnId, 't2')
})

test('closing a turn that is not the open one leaves the open one', () => {
  let index = turn(emptyIndex(), 't1')
  index = closeTurn(index, { turnId: 'other', at: 5, reason: 'answer' })
  assert.equal(index.openTurnId, 't1')
})

test('a main-loop edit belongs to the open turn and gets the next seq', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: text('h1') }))
  assert.equal(index.edits.length, 1)
  assert.equal(index.edits[0].turnId, 't1')
  assert.ok(index.edits[0].seq > index.turns[0].seq)
})

test('turnFiles joins a file\'s edits in one turn from first before to last after', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: text('h1') }))
  index = addEdit(index, edit({ key: 'b', before: ABSENT, after: text('b1') }))
  index = addEdit(index, edit({ key: 'a', before: text('h1'), after: text('h2') }))
  const files = turnFiles(index, 't1')
  assert.deepEqual(files.map(f => [f.key, f.before, f.after, f.edits.length]), [
    ['a', text('h0'), text('h2'), 2],
    ['b', ABSENT, text('b1'), 1],
  ])
  assert.equal(files[0].status, 'pending')
  assert.equal(files[0].isNoop, false)
  assert.equal(files[0].chainBroken, false)
  assert.equal(files[0].interleaved, false)
})

test('edits in different turns stay in their own turns', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: text('h1') }))
  index = turn(index, 't2')
  index = addEdit(index, edit({ key: 'a', before: text('h1'), after: text('h2') }))
  assert.deepEqual(turnFiles(index, 't1').map(f => f.after), [text('h1')])
  assert.deepEqual(turnFiles(index, 't2').map(f => f.before), [text('h1')])
})

test('a subagent\'s edits stay with the turn that spawned it, even after that turn ends', () => {
  let index = turn(emptyIndex(), 't1')
  index = linkAgent(index, { agentId: 'ag1', parentToolUseId: 'spawn1', label: 'research' })
  index = closeTurn(index, { turnId: 't1', at: ++clock, reason: 'answer' })
  index = turn(index, 't2')
  index = addEdit(index, edit({ key: 'a', agentId: 'ag1', before: text('h0'), after: text('h1') }))
  assert.equal(index.edits[0].turnId, 't1')
  assert.deepEqual(turnFiles(index, 't1')[0].agentIds, ['ag1'])
  assert.deepEqual(turnFiles(index, 't2'), [])
})

test('an agent spawned by an agent maps to its parent\'s turn', () => {
  let index = turn(emptyIndex(), 't1')
  index = linkAgent(index, { agentId: 'ag1', parentToolUseId: 'spawn1' })
  index = turn(index, 't2')
  index = linkAgent(index, { agentId: 'ag2', parentToolUseId: 'spawn2', spawnedBy: 'ag1' })
  index = addEdit(index, edit({ key: 'a', agentId: 'ag2', before: text('h0'), after: text('h1') }))
  assert.equal(index.edits[0].turnId, 't1')
  assert.equal(index.agents.find(a => a.agentId === 'ag2')?.parentAgentId, 'ag1')
})

test('an agent with no recorded spawn falls back to the open turn and stays there', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', agentId: 'ghost', before: text('h0'), after: text('h1') }))
  index = turn(index, 't2')
  index = addEdit(index, edit({ key: 'b', agentId: 'ghost', before: text('b0'), after: text('b1') }))
  assert.deepEqual(index.edits.map(e => e.turnId), ['t1', 't1'])
  assert.equal(index.agents.filter(a => a.agentId === 'ghost').length, 1)
})

test('an agent with no spawn and no open turn gets a background bucket', () => {
  let index = turn(emptyIndex(), 't1')
  index = closeTurn(index, { turnId: 't1', at: ++clock, reason: 'answer' })
  index = addEdit(index, edit({ key: 'a', agentId: 'ghost', before: text('h0'), after: text('h1') }))
  const bucket = index.turns.find(t => t.kind === 'background')
  assert.ok(bucket)
  assert.equal(bucket.turnId, 'background:ghost')
  assert.equal(index.edits[0].turnId, 'background:ghost')
})

test('an explicit turnId wins, as the turn sweep records it', () => {
  let index = turn(emptyIndex(), 't1')
  index = turn(index, 't2')
  index = addEdit(index, edit({ key: 'a', via: 'unattributed', turnId: 't1', before: text('h0'), after: text('h1') }))
  assert.equal(index.edits[0].turnId, 't1')
})

test('overlapping captures that do not chain are both interleaved', () => {
  let index = turn(emptyIndex(), 't1')
  index = linkAgent(index, { agentId: 'x', parentToolUseId: 's1' })
  index = linkAgent(index, { agentId: 'y', parentToolUseId: 's2' })
  // y's capture runs inside x's window; x read the file before y wrote it.
  index = addEdit(index, { toolUseId: 'y1', tool: 'Edit', via: 'tool', agentId: 'y', path: 'a', key: 'a', before: text('h0'), after: text('hy'), startedAt: 102, at: 103 })
  index = addEdit(index, { toolUseId: 'x1', tool: 'Edit', via: 'tool', agentId: 'x', path: 'a', key: 'a', before: text('h0'), after: text('hx'), startedAt: 101, at: 105 })
  assert.deepEqual(index.edits.map(e => e.interleaved), [true, true])
  assert.equal(turnFiles(index, 't1')[0].interleaved, true)
})

test('a break in the chain between non-overlapping edits is chainBroken, not interleaved', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: text('h1') }))
  index = addEdit(index, edit({ key: 'a', before: text('changed-by-someone'), after: text('h2') }))
  const [file] = turnFiles(index, 't1')
  assert.equal(file.interleaved, false)
  assert.equal(file.chainBroken, true)
  assert.deepEqual(index.edits.map(e => e.interleaved), [undefined, undefined])
})

test('unknown content never claims a broken chain', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: { unreadable: 'io' } }))
  index = addEdit(index, edit({ key: 'a', before: text('h5'), after: text('h6') }))
  assert.equal(turnFiles(index, 't1')[0].chainBroken, false)
})

test('a file changed and changed back in one turn is a no-op', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: text('h1') }))
  index = addEdit(index, edit({ key: 'a', before: text('h1'), after: text('h0') }))
  assert.equal(turnFiles(index, 't1')[0].isNoop, true)
})

test('status defaults to pending and is set per turn and file', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('h0'), after: text('h1') }))
  index = addEdit(index, edit({ key: 'b', before: text('b0'), after: text('b1') }))
  index = setStatus(index, [{ turnId: 't1', key: 'a' }], 'kept')
  assert.equal(statusOf(index, 't1', 'a'), 'kept')
  assert.equal(statusOf(index, 't1', 'b'), 'pending')
  assert.deepEqual(turnFiles(index, 't1').map(f => f.status), ['kept', 'pending'])
  index = setStatus(index, [{ turnId: 't1', key: 'a' }], 'pending')
  assert.equal(statusOf(index, 't1', 'a'), 'pending')
})

test('turnFiles narrows to one tool call or one agent and its children', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ toolUseId: 'main1', key: 'a', before: text('a0'), after: text('a1') }))
  index = linkAgent(index, { agentId: 'ag1', parentToolUseId: 'spawn1' })
  index = linkAgent(index, { agentId: 'ag2', parentToolUseId: 'spawn2', spawnedBy: 'ag1' })
  index = addEdit(index, edit({ toolUseId: 'c1', agentId: 'ag1', key: 'b', before: text('b0'), after: text('b1') }))
  index = addEdit(index, edit({ toolUseId: 'c2', agentId: 'ag2', key: 'c', before: text('c0'), after: text('c1') }))
  index = addEdit(index, edit({ toolUseId: 'main2', key: 'a', before: text('a1'), after: text('a2') }))
  assert.deepEqual(turnFiles(index, 't1', 'main1').map(f => [f.key, f.after]), [['a', text('a1')]])
  assert.deepEqual(turnFiles(index, 't1', 'ag1').map(f => f.key), ['b', 'c'])
  assert.deepEqual(turnFiles(index, 't1', 'ag2').map(f => f.key), ['c'])
})

test('timeline is newest first, with the tree of calls and agents per turn', () => {
  let index = turn(emptyIndex(), 't1', 'fix login')
  index = addEdit(index, edit({ toolUseId: 'main1', key: 'a', before: text('a0'), after: text('a1') }))
  index = linkAgent(index, { agentId: 'ag1', parentToolUseId: 'spawn1', label: 'tests' })
  index = addEdit(index, edit({ toolUseId: 'c1', agentId: 'ag1', key: 'b', before: text('b0'), after: text('b1') }))
  index = addEdit(index, edit({ toolUseId: 'c1', agentId: 'ag1', key: 'c', before: ABSENT, after: text('c1') }))
  index = turn(index, 't2', 'rename')
  index = addEdit(index, edit({ toolUseId: 'sh1', tool: 'Bash', via: 'shell', key: 'd', before: text('d0'), after: ABSENT }))

  const rows = timeline(index)
  assert.deepEqual(rows.map(r => (r.kind === 'turn' ? r.turn.turnId : r.kind)), ['t2', 't1'])
  const t1 = rows[1]
  assert.equal(t1.kind, 'turn')
  if (t1.kind !== 'turn') return
  assert.equal(t1.files.length, 3)
  assert.deepEqual(t1.nodes, [
    { kind: 'call', toolUseId: 'main1', tool: 'Edit', via: 'tool', seq: t1.nodes[0].seq, keys: ['a'] },
    {
      kind: 'agent',
      agentId: 'ag1',
      label: 'tests',
      parentToolUseId: 'spawn1',
      seq: t1.nodes[1].seq,
      keys: ['b', 'c'],
      children: [{ kind: 'call', toolUseId: 'c1', tool: 'Edit', via: 'tool', agentId: 'ag1', seq: (t1.nodes[1] as any).children[0].seq, keys: ['b', 'c'] }],
    },
  ])
})

test('user actions sit on the timeline in order', () => {
  let index = turn(emptyIndex(), 't1')
  index = addEdit(index, edit({ key: 'a', before: text('a0'), after: text('a1') }))
  index = addAction(index, { kind: 'revert', turnIds: ['t1'], key: 'a', path: 'a', at: ++clock })
  index = turn(index, 't2')
  assert.deepEqual(timeline(index).map(r => r.kind), ['turn', 'action', 'turn'])
})

test(`only the last ${MAX_TURNS} turns are kept, with their edits and statuses`, () => {
  let index = emptyIndex()
  for (let i = 1; i <= MAX_TURNS + 2; i++) {
    index = turn(index, `t${i}`)
    index = addEdit(index, edit({ key: 'a', before: text(`h${i - 1}`), after: text(`h${i}`) }))
    index = setStatus(index, [{ turnId: `t${i}`, key: 'a' }], 'kept')
  }
  assert.equal(index.turns.length, MAX_TURNS)
  assert.equal(index.turns[0].turnId, 't3')
  assert.ok(index.edits.every(e => e.turnId !== 't1' && e.turnId !== 't2'))
  assert.equal(statusOf(index, 't1', 'a'), 'pending')
  assert.equal(Object.keys(index.status).length, MAX_TURNS)
})

test('updates never change the index they were given', () => {
  const start = turn(emptyIndex(), 't1')
  const frozen = structuredClone(start)
  addEdit(start, edit({ key: 'a', before: text('a0'), after: text('a1') }))
  linkAgent(start, { agentId: 'ag', parentToolUseId: 's' })
  setStatus(start, [{ turnId: 't1', key: 'a' }], 'kept')
  closeTurn(start, { turnId: 't1', at: 1, reason: 'answer' })
  addAction(start, { kind: 'keep', turnIds: ['t1'], key: 'a', path: 'a', at: 1 })
  assert.deepEqual(start, frozen)
})

test('the index survives a JSON round trip unchanged, as $.state stores it', () => {
  let index = turn(emptyIndex(), 't1')
  index = linkAgent(index, { agentId: 'ag', parentToolUseId: 's' })
  index = addEdit(index, edit({ key: 'a', agentId: 'ag', before: ABSENT, after: text('a1') }))
  index = closeTurn(index, { turnId: 't1', at: 9, reason: 'answer' })
  index = addEdit(index, edit({ key: 'b', agentId: 'ghost', before: text('b0'), after: text('b1') }))
  assert.deepEqual(JSON.parse(JSON.stringify(index)), index)
})

test('review #4: a spawn result after the agent\'s first edit fills in its parent and label', () => {
  let index = turn(emptyIndex(), 't1')
  index = linkAgent(index, { agentId: 'parent', parentToolUseId: 's0' })
  index = addEdit(index, edit({ key: 'a', agentId: 'child', before: text('h0'), after: text('h1') }))
  index = linkAgent(index, { agentId: 'child', parentToolUseId: 's1', spawnedBy: 'parent', label: 'tests' })
  const child = index.agents.find(a => a.agentId === 'child')
  assert.equal(child?.parentToolUseId, 's1')
  assert.equal(child?.parentAgentId, 'parent')
  assert.equal(child?.label, 'tests')
  assert.equal(child?.turnId, 't1')
  assert.equal(index.agents.length, 2)
})
