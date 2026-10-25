import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyIndex, type Content } from '../../plugins/changes/hooks/core/model.ts'
import { addEdit, openTurn } from '../../plugins/changes/hooks/core/timeline.ts'
import { lastSeq, shellEditsSince, type ChangesIndexView } from '../../shared/changes-index.ts'

const edit = (seq: number, via: string, path: string, extra: Record<string, unknown> = {}) => ({ seq, turnId: 't1', toolUseId: `u${seq}`, tool: 'Bash', via, path, ...extra })

test('shell and unattributed edits after the seq, oldest first', () => {
  const index: ChangesIndexView = {
    edits: [edit(1, 'shell', 'C:/w/a.ts'), edit(2, 'tool', 'C:/w/b.ts'), edit(4, 'unattributed', 'C:/w/c.ts'), edit(3, 'shell', 'C:/w/d.ts')],
  }
  assert.deepEqual(
    shellEditsSince(index, 1).map(e => [e.seq, e.path]),
    [
      [3, 'C:/w/d.ts'],
      [4, 'C:/w/c.ts'],
    ],
  )
})

test('keeps the call, turn and agent of each edit', () => {
  const [only] = shellEditsSince({ edits: [edit(5, 'shell', 'C:/w/a.ts', { agentId: 'ag1' })] }, 0)
  assert.deepEqual(only, { seq: 5, turnId: 't1', toolUseId: 'u5', tool: 'Bash', path: 'C:/w/a.ts', unattributed: false, agentId: 'ag1' })
})

test('a missing, empty or malformed index gives nothing, never a throw', () => {
  for (const index of [undefined, null, {}, { edits: null }, { edits: 'x' }, { edits: [null, 1, { seq: 'a', via: 'shell', path: 'p' }, { seq: 2, via: 'shell' }] }]) {
    assert.deepEqual(shellEditsSince(index as never, 0), [])
  }
})

// The contract from Changes' side: an index Changes itself builds reads the
// same way. A change to Changes' EditRecord that breaks this fails here.

test('an index built by Changes reads through the view', () => {
  const c = (hash: string): Content => ({ hash, size: 1, kind: 'text', eol: 'lf', bom: false })
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: 'p', at: 1 })
  index = addEdit(index, { toolUseId: 'u1', tool: 'Edit', via: 'tool', path: 'C:/w/a.ts', key: 'c:/w/a.ts', before: c('0'), after: c('1'), startedAt: 2, at: 3 })
  index = addEdit(index, { toolUseId: 'u2', tool: 'Bash', via: 'shell', path: 'C:/w/b.ts', key: 'c:/w/b.ts', before: c('0'), after: c('1'), startedAt: 4, at: 5 })
  index = addEdit(index, { toolUseId: 'u3', tool: 'Bash', via: 'shell', path: 'C:/w/c.ts', key: 'c:/w/c.ts', before: c('0'), after: c('1'), startedAt: 6, at: 7, agentId: 'ag' })
  const seen = shellEditsSince(index, 0)
  assert.deepEqual(seen.map(e => [e.tool, e.path, e.turnId, e.agentId ?? null]), [
    ['Bash', 'C:/w/b.ts', 't1', null],
    ['Bash', 'C:/w/c.ts', seen[1].turnId, 'ag'],
  ])
  assert.deepEqual(shellEditsSince(index, seen[0].seq).map(e => e.path), ['C:/w/c.ts'])
})

test('lastSeq is the newest seq of any edit, 0 for nothing readable', () => {
  assert.equal(lastSeq({ edits: [edit(3, 'tool', 'a'), edit(7, 'shell', 'b'), edit(5, 'revert', 'c')] }), 7)
  for (const index of [undefined, null, {}, { edits: 'x' }, { edits: [null, { seq: 'x' }] }]) assert.equal(lastSeq(index as never), 0)
})
