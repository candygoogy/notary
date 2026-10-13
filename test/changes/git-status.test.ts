import { test } from 'node:test'
import assert from 'node:assert/strict'

import { changedPaths, dirtyPaths, parseStatus, type ShellSnapshot } from '../../plugins/changes/hooks/core/git-status.ts'

const z = (...entries: string[]) => entries.map(e => e + '\0').join('')

test('parseStatus reads modified, staged, untracked and deleted entries', () => {
  const status = parseStatus(z(' M src/a.ts', 'M  src/b.ts', 'A  new.ts', '?? notes.txt', ' D gone.ts', 'MM both.ts'))
  assert.deepEqual([...status.values()], [
    { path: 'src/a.ts', x: ' ', y: 'M' },
    { path: 'src/b.ts', x: 'M', y: ' ' },
    { path: 'new.ts', x: 'A', y: ' ' },
    { path: 'notes.txt', x: '?', y: '?' },
    { path: 'gone.ts', x: ' ', y: 'D' },
    { path: 'both.ts', x: 'M', y: 'M' },
  ])
})

test('parseStatus reads a rename as the new path with the old one after it', () => {
  const status = parseStatus(z('R  lib/new name.ts', 'lib/old name.ts', ' M after.ts'))
  assert.deepEqual(status.get('lib/new name.ts'), { path: 'lib/new name.ts', x: 'R', y: ' ', origPath: 'lib/old name.ts' })
  assert.deepEqual(status.get('after.ts'), { path: 'after.ts', x: ' ', y: 'M' })
  assert.equal(status.size, 2)
})

test('parseStatus keeps spaces and non-ASCII paths as they are', () => {
  const status = parseStatus(z('?? docs/çay ve 茶.md', ' M  leading space.ts'))
  assert.ok(status.has('docs/çay ve 茶.md'))
  assert.ok(status.has(' leading space.ts'))
})

test('parseStatus of empty output is empty', () => {
  assert.equal(parseStatus('').size, 0)
})

function snapshot(statusEntries: string[], stamps: Record<string, { size: number; mtimeMs: number; hash?: string } | null>, head = 'h1'): ShellSnapshot {
  return { head, status: parseStatus(z(...statusEntries)), stamps: new Map(Object.entries(stamps)) }
}

test('a clean file the command modified is a candidate whose before is in HEAD', () => {
  const before = snapshot([], {})
  const after = snapshot([' M src/a.ts'], { 'src/a.ts': { size: 5, mtimeMs: 2 } })
  assert.deepEqual(changedPaths(before, after), [{ path: 'src/a.ts', beforeFrom: 'head' }])
})

test('a new untracked file is a candidate from HEAD, where it is missing', () => {
  const before = snapshot([], {})
  const after = snapshot(['?? out.log'], { 'out.log': { size: 1, mtimeMs: 2 } })
  assert.deepEqual(changedPaths(before, after), [{ path: 'out.log', beforeFrom: 'head' }])
})

test('a clean file the command deleted is a candidate', () => {
  const before = snapshot([], {})
  const after = snapshot([' D old.ts'], { 'old.ts': null })
  assert.deepEqual(changedPaths(before, after), [{ path: 'old.ts', beforeFrom: 'head' }])
})

test('a dirty file whose stamp changed is a candidate from the snapshot', () => {
  const before = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1 } })
  const after = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 9 } })
  assert.deepEqual(changedPaths(before, after), [{ path: 'a.ts', beforeFrom: 'snapshot' }])
})

test('a dirty file staged with git add but not changed is no candidate', () => {
  const before = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1 } })
  const after = snapshot(['M  a.ts'], { 'a.ts': { size: 5, mtimeMs: 1 } })
  assert.deepEqual(changedPaths(before, after), [])
})

test('a dirty file committed, so now clean, is no candidate', () => {
  const before = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1 } }, 'h1')
  const after = snapshot([], { 'a.ts': { size: 5, mtimeMs: 1 } }, 'h2')
  assert.deepEqual(changedPaths(before, after), [])
})

test('a dirty file restored by git checkout is a candidate from the snapshot', () => {
  const before = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1 } })
  const after = snapshot([], { 'a.ts': { size: 3, mtimeMs: 7 } })
  assert.deepEqual(changedPaths(before, after), [{ path: 'a.ts', beforeFrom: 'snapshot' }])
})

test('an untracked file the command removed is a candidate from the snapshot', () => {
  const before = snapshot(['?? tmp.txt'], { 'tmp.txt': { size: 2, mtimeMs: 1 } })
  const after = snapshot([], { 'tmp.txt': null })
  assert.deepEqual(changedPaths(before, after), [{ path: 'tmp.txt', beforeFrom: 'snapshot' }])
})

test('a dirty file with no stamp after is treated as changed', () => {
  const before = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1 } })
  const after = snapshot([' M a.ts'], {})
  assert.deepEqual(changedPaths(before, after), [{ path: 'a.ts', beforeFrom: 'snapshot' }])
})

test('git mv yields both the new path and the old one', () => {
  const before = snapshot([], {})
  const after = snapshot(['R  b.ts', 'a.ts'], { 'b.ts': { size: 1, mtimeMs: 2 }, 'a.ts': null })
  assert.deepEqual(changedPaths(before, after), [
    { path: 'a.ts', beforeFrom: 'head' },
    { path: 'b.ts', beforeFrom: 'head' },
  ])
})

test('when HEAD moved, paths that differ between the heads are candidates if they were clean', () => {
  const before = snapshot([' M dirty.ts'], { 'dirty.ts': { size: 1, mtimeMs: 1 } }, 'h1')
  const after = snapshot([' M dirty.ts'], { 'dirty.ts': { size: 1, mtimeMs: 1 } }, 'h2')
  assert.deepEqual(changedPaths(before, after, ['switched.ts', 'dirty.ts']), [{ path: 'switched.ts', beforeFrom: 'head' }])
})

test('candidates are sorted and listed once', () => {
  const before = snapshot([' M z.ts'], { 'z.ts': { size: 1, mtimeMs: 1 } })
  const after = snapshot([' M z.ts', ' M m.ts'], { 'z.ts': { size: 2, mtimeMs: 2 }, 'm.ts': { size: 1, mtimeMs: 1 } })
  assert.deepEqual(changedPaths(before, after, ['m.ts', 'a.ts']), [
    { path: 'a.ts', beforeFrom: 'head' },
    { path: 'm.ts', beforeFrom: 'head' },
    { path: 'z.ts', beforeFrom: 'snapshot' },
  ])
})

test('review #7: a recreated rename source was absent before, so its before is the snapshot', () => {
  const before = snapshot(['R  new.ts', 'old.ts'], { 'new.ts': { size: 1, mtimeMs: 1 }, 'old.ts': null })
  const after = snapshot(['R  new.ts', 'old.ts', '?? old.ts'], { 'new.ts': { size: 1, mtimeMs: 1 }, 'old.ts': { size: 4, mtimeMs: 5 } })
  assert.deepEqual(changedPaths(before, after), [{ path: 'old.ts', beforeFrom: 'snapshot' }])
})

test('review #7: dirtyPaths lists rename sources so io snapshots and stamps them', () => {
  assert.deepEqual(dirtyPaths(snapshot(['R  new.ts', 'old.ts', ' M a.ts'], {})).sort(), ['a.ts', 'new.ts', 'old.ts'])
})

test('review #8: a same-size rewrite that keeps the mtime is seen through the hash', () => {
  const before = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1, hash: 'h1' } })
  const after = snapshot([' M a.ts'], { 'a.ts': { size: 5, mtimeMs: 1, hash: 'h2' } })
  assert.deepEqual(changedPaths(before, after), [{ path: 'a.ts', beforeFrom: 'snapshot' }])
})

test('review #8: without hashes (files over 1 MB) the same stamp still reads as unchanged', () => {
  const before = snapshot([' M big.bin'], { 'big.bin': { size: 5, mtimeMs: 1 } })
  const after = snapshot([' M big.bin'], { 'big.bin': { size: 5, mtimeMs: 1 } })
  assert.deepEqual(changedPaths(before, after), [])
})
