import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fakeHost } from './fake-host.ts'
import { capture } from '../../plugins/changes/hooks/io/blobs.ts'
import { isSessionFolder, overTotalCap, removeTree, STALE_MS, staleSessions, storeUsage, touch } from '../../plugins/changes/hooks/io/store.ts'

const BASE = 'C:/cfg/plugin-data/notary-changes'
const DAY = 24 * 60 * 60 * 1000

test('touch marks the session folder with the time', async () => {
  const host = fakeHost()
  await touch(host as any, `${BASE}/s1`, 123)
  assert.equal(host.text(`${BASE}/s1/.touch`), '123')
})

test('staleSessions lists folders untouched for a week, never this session\'s own', async () => {
  const host = fakeHost()
  const now = 100 * DAY
  host.put(`${BASE}/old/.touch`, 'x', now - STALE_MS - 1)
  host.put(`${BASE}/fresh/.touch`, 'x', now - DAY)
  host.put(`${BASE}/mine/.touch`, 'x', now - STALE_MS - 1)
  ;(host.fs as any).list = async () =>
    ['old', 'fresh', 'mine'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })).concat([{ name: 'stray.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false }])
  assert.deepEqual(await staleSessions(host as any, BASE, `${BASE}/mine`, now), [`${BASE}/old`])
})

test('review 2 #6: a folder with no .touch is aged by its own modification time', async () => {
  const host = fakeHost()
  const now = 100 * DAY
  host.put(`${BASE}/unmarked-old/blobs/a.txt`, 'x')
  host.put(`${BASE}/unmarked-new/blobs/a.txt`, 'x')
  ;(host.fs as any).list = async () => ['unmarked-old', 'unmarked-new'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
  const realStat = host.fs.stat.bind(host.fs)
  ;(host.fs as any).stat = async (path: string, opts?: any) => {
    if (path === `${BASE}/unmarked-old`) return { kind: 'dir', size: 0, mtimeMs: now - STALE_MS - 1, isLink: false }
    if (path === `${BASE}/unmarked-new`) return { kind: 'dir', size: 0, mtimeMs: now - DAY, isLink: false }
    return realStat(path, opts)
  }
  assert.deepEqual(await staleSessions(host as any, BASE, `${BASE}/s1`, now), [`${BASE}/unmarked-old`])
})

test('staleSessions of a missing base is empty', async () => {
  const host = fakeHost()
  ;(host.fs as any).list = async () => {
    throw new Error('ENOENT')
  }
  assert.deepEqual(await staleSessions(host as any, BASE, `${BASE}/s1`, 0), [])
})

test('review 2 #6: removeTree deletes the folder\'s contents first and its .touch last', async () => {
  const win = fakeHost()
  assert.equal(await removeTree(win as any, 'windows', `${BASE}/old`), true)
  const script = win.runs[0].argv[4]
  assert.ok(script.indexOf("$_.Name -ne '.touch'") < script.lastIndexOf('Remove-Item -LiteralPath $env:NOTARY_TARGET -Recurse'))
  assert.equal(win.runs[0].init?.env?.NOTARY_TARGET, `${BASE}/old`)
  const posix = fakeHost()
  await removeTree(posix as any, 'posix', '/home/me/.claude/plugin-data/notary-changes/old')
  assert.equal(posix.runs[0].argv[0], 'sh')
  assert.match(posix.runs[0].argv[2], /! -name \.touch -exec rm -rf -- \{\} \+ && rm -rf -- "\$NOTARY_TARGET"/)
})

test('review 2 #6: removeTree refuses anything but one of our session folders', async () => {
  const host = fakeHost()
  for (const path of ['C:/Users/me', `${BASE}`, `${BASE}/`, `${BASE}/..`, `${BASE}/a/b`, 'C:/elsewhere/plugin-data/other/x']) {
    assert.equal(await removeTree(host as any, 'windows', path), false, path)
  }
  assert.equal(host.runs.length, 0)
  assert.equal(isSessionFolder(`${BASE}/9f1c-session`), true)
})

test('removeTree reports a failed delete', async () => {
  const host = fakeHost({ onRun: () => ({ exitCode: 1, stdout: '' }) })
  assert.equal(await removeTree(host as any, 'windows', `${BASE}/x`), false)
})

test('review 2 #6: storeUsage sums the blobs, and a full budget stops new snapshots', async () => {
  const host = fakeHost()
  ;(host.fs as any).list = async () => [
    { name: 'a.txt', kind: 'file', size: 300, mtimeMs: 1, isLink: false },
    { name: 'b.b64', kind: 'file', size: 200, mtimeMs: 1, isLink: false },
  ]
  assert.equal(await storeUsage(host as any, `${BASE}/s1`), 500)

  const budget = { used: 0, cap: 10, full: false }
  host.put('C:/p/small.ts', 'tiny')
  host.put('C:/p/big.ts', 'much more than ten bytes')
  const small = await capture(host as any, `${BASE}/s1`, 'C:/p/small.ts', { budget })
  assert.equal('hash' in small, true)
  assert.equal(budget.used, 4)
  assert.deepEqual(await capture(host as any, `${BASE}/s1`, 'C:/p/big.ts', { budget }), { unreadable: 'io' })
  assert.equal(budget.full, true)
  // A check (no snapshot) is never refused.
  assert.equal('hash' in (await capture(host as any, `${BASE}/s1`, 'C:/p/big.ts', { store: false, budget })), true)
})

test('staleSessions takes the kept-history window (keepHistoryDays) in place of a week', async () => {
  const host = fakeHost()
  const now = 100 * DAY
  host.put(`${BASE}/three-days/.touch`, 'x', now - 3 * DAY)
  host.put(`${BASE}/ten-days/.touch`, 'x', now - 10 * DAY)
  ;(host.fs as any).list = async () => ['three-days', 'ten-days'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
  assert.deepEqual(await staleSessions(host as any, BASE, `${BASE}/mine`, now, 2 * DAY), [`${BASE}/three-days`, `${BASE}/ten-days`])
  assert.deepEqual(await staleSessions(host as any, BASE, `${BASE}/mine`, now, 7 * DAY), [`${BASE}/ten-days`])
})

test('overTotalCap drops the oldest-used histories until all fit, never this session\'s own', async () => {
  const host = fakeHost()
  const sizes: Record<string, number> = { oldest: 400, middle: 300, newest: 200, mine: 500 }
  const used: Record<string, number> = { oldest: 1, middle: 2, newest: 3, mine: 0 }
  for (const name of Object.keys(sizes)) host.put(`${BASE}/${name}/.touch`, 'x', used[name])
  ;(host.fs as any).list = async (path: string) => {
    if (path === BASE) return Object.keys(sizes).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
    const name = path.slice(BASE.length + 1).replace(/\/blobs$/, '')
    return [{ name: 'a.txt', kind: 'file', size: sizes[name], mtimeMs: 0, isLink: false }]
  }
  // 1400 in all: under a cap of 1000 the oldest-used (400) goes; under 600 all three
  // others go (this session's own 500 alone is left).
  assert.deepEqual(await overTotalCap(host as any, BASE, `${BASE}/mine`, 1000), [`${BASE}/oldest`])
  assert.deepEqual(await overTotalCap(host as any, BASE, `${BASE}/mine`, 600), [`${BASE}/oldest`, `${BASE}/middle`, `${BASE}/newest`])
  assert.deepEqual(await overTotalCap(host as any, BASE, `${BASE}/mine`, 2000), [])
})
