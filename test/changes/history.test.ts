import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fakeHost, type Run } from './fake-host.ts'
import { capture, keyOf } from '../../plugins/changes/hooks/io/blobs.ts'
import { holdsLease, LEASE_STALE_MS, loadHistory, releaseLease, renewLease, saveHistory, takeLease } from '../../plugins/changes/hooks/io/history.ts'
import { planTurn, revertFile } from '../../plugins/changes/hooks/io/restore.ts'
import { emptyIndex, type Index } from '../../plugins/changes/hooks/core/model.ts'
import { addEdit, openTurn } from '../../plugins/changes/hooks/core/timeline.ts'

const STORE = 'C:/Users/me/.claude/plugin-data/notary-changes/s1'
const WIN = { platform: 'windows' as const, store: STORE }

// A host whose moves and deletes act on its files, as PowerShell's do; it
// records every path written directly, and `failMoves` makes renames fail.
function movingHost() {
  const written: string[] = []
  let failMoves = false
  const host = fakeHost({
    onRun: ({ argv, init }: Run) => {
      const script = argv.join(' ')
      const tmp = init?.env?.NOTARY_TMP
      const target = init?.env?.NOTARY_TARGET
      if (script.includes('[IO.File]::Replace') && !script.includes('WriteAllBytes')) {
        if (failMoves) return { exitCode: 1, stdout: '' }
        const bytes = host.files.get(tmp!)
        if (bytes === undefined) return { exitCode: 1, stdout: '' }
        host.files.delete(tmp!)
        host.put(target!, bytes)
        return { exitCode: 0, stdout: '' }
      }
      if (script.includes('Remove-Item') && !script.includes('Get-ChildItem')) {
        host.files.delete(target!)
        return { exitCode: 0, stdout: '' }
      }
      return { exitCode: 1, stdout: '' }
    },
  })
  const write = host.fs.write
  host.fs.write = async (path: string, text: string) => {
    written.push(path)
    return write(path, text)
  }
  return Object.assign(host, { written, failMoves: (on: boolean) => (failMoves = on) })
}

// One turn that edited `path` from `before` to `after`, its copies stored.
async function edited(host: ReturnType<typeof movingHost>, path: string, before: string, after: string, turnId = 't1', index = openTurn(emptyIndex(), { turnId, prompt: 'fix it', at: 1 })) {
  host.put(path, before)
  const pre = await capture(host as any, STORE, path)
  host.put(path, after)
  const post = await capture(host as any, STORE, path)
  const key = await keyOf(host as any, path, 'windows')
  return { index: addEdit(index, { toolUseId: `tu-${turnId}`, tool: 'Edit', via: 'tool', path, key, before: pre, after: post, startedAt: 1, at: 2 }), key }
}

// ── index.json: written in one rename, read back whole or not at all ──

test('saveHistory writes a temp file and renames it into place, and loadHistory reads it back', async () => {
  const host = movingHost()
  const { index } = await edited(host, 'C:/p/a.ts', 'old\n', 'new\n')
  assert.equal(await saveHistory(host as any, 'windows', STORE, 's1', index, 5), true)
  assert.ok(!host.written.includes(`${STORE}/index.json`), 'never written in place')
  assert.ok(host.written.includes(`${STORE}/index.json.notary-tmp`))
  assert.equal(host.text(`${STORE}/index.json.notary-tmp`), undefined)
  assert.deepEqual(await loadHistory(host as any, STORE, 's1'), { index })
})

test('a rename that fails leaves the saved history as it was', async () => {
  const host = movingHost()
  const first = await edited(host, 'C:/p/a.ts', 'old\n', 'new\n')
  await saveHistory(host as any, 'windows', STORE, 's1', first.index, 5)
  const before = host.text(`${STORE}/index.json`)
  host.failMoves(true)
  const later = openTurn(first.index, { turnId: 't2', prompt: 'more', at: 9 })
  assert.equal(await saveHistory(host as any, 'windows', STORE, 's1', later, 9), false)
  assert.equal(host.text(`${STORE}/index.json`), before)
})

test('no saved history is null; one that is corrupt, of another format or conversation, or misshapen is refused whole', async () => {
  const host = movingHost()
  assert.equal(await loadHistory(host as any, STORE, 's1'), null)
  host.put(`${STORE}/index.json`, '{"format":1,"sessionId":"s1","index":{"turns":[')
  assert.deepEqual(await loadHistory(host as any, STORE, 's1'), { unreadable: 'corrupt' })
  host.put(`${STORE}/index.json`, JSON.stringify({ format: 2, sessionId: 's1', index: emptyIndex() }))
  assert.deepEqual(await loadHistory(host as any, STORE, 's1'), { unreadable: 'format' })
  host.put(`${STORE}/index.json`, JSON.stringify({ format: 1, sessionId: 's2', index: emptyIndex() }))
  assert.deepEqual(await loadHistory(host as any, STORE, 's1'), { unreadable: 'other-session' })
  host.put(`${STORE}/index.json`, JSON.stringify({ format: 1, sessionId: 's1', index: { ...emptyIndex(), edits: [{ seq: 1 }] } }))
  assert.deepEqual(await loadHistory(host as any, STORE, 's1'), { unreadable: 'corrupt' })
  host.put(`${STORE}/index.json`, JSON.stringify([1, 2]))
  assert.deepEqual(await loadHistory(host as any, STORE, 's1'), { unreadable: 'corrupt' })
})

// ── the lease: one writer per conversation ──

test('the first process takes the lease; a second is refused while it is fresh', async () => {
  const host = movingHost()
  assert.equal(await takeLease(host as any, STORE, 'A', 1_000), true)
  assert.equal(await takeLease(host as any, STORE, 'B', 2_000), false)
  assert.equal(await holdsLease(host as any, STORE, 'A'), true)
  assert.equal(await renewLease(host as any, STORE, 'B', 3_000), false)
  assert.equal(await renewLease(host as any, STORE, 'A', 3_000), true)
})

test('a lease not renewed for LEASE_STALE_MS (a crashed holder) is taken over, and the old holder sees it', async () => {
  const host = movingHost()
  await takeLease(host as any, STORE, 'A', 1_000)
  assert.equal(await takeLease(host as any, STORE, 'B', 1_000 + LEASE_STALE_MS - 1), false)
  assert.equal(await takeLease(host as any, STORE, 'B', 1_000 + LEASE_STALE_MS), true)
  assert.equal(await holdsLease(host as any, STORE, 'A'), false)
  assert.equal(await renewLease(host as any, STORE, 'A', 1_000 + LEASE_STALE_MS + 1), false)
})

test('a released lease, or an unreadable one, is taken at once', async () => {
  const host = movingHost()
  await takeLease(host as any, STORE, 'A', 1_000)
  await releaseLease(host as any, STORE, 'A')
  assert.equal(await takeLease(host as any, STORE, 'B', 1_001), true)
  host.put(`${STORE}/lease.json`, 'not json')
  assert.equal(await takeLease(host as any, STORE, 'C', 1_002), true)
})

// ── a saved copy gone from the folder: refused while planning ──

test('a missing copy is refused as no-snapshot while planning, and nothing is written', async () => {
  const host = movingHost()
  const { index, key } = await edited(host, 'C:/p/a.ts', 'old\n', 'new\n')
  const copies = [...host.files.keys()].filter(path => path.startsWith(`${STORE}/blobs/`))
  for (const copy of copies) host.files.delete(copy)
  const runsBefore = host.runs.length
  const plans = await planTurn(host as any, WIN, index, [{ turnId: 't1', key, path: 'C:/p/a.ts' }])
  assert.deepEqual(plans.map(p => (p.plan.ok ? 'ok' : p.plan.reason)), ['no-snapshot'])
  const result = await revertFile(host as any, WIN, index, { turnId: 't1', key }, 'turn', 'C:/p/a.ts')
  assert.deepEqual(result, { ok: false, reason: 'no-snapshot' })
  assert.equal(host.text('C:/p/a.ts'), 'new\n')
  assert.equal(host.runs.length, runsBefore)
})

// ── reverting a history saved by an earlier launch ──

// The history as a resumed launch sees it: saved, then read back from disk.
async function resumed(host: ReturnType<typeof movingHost>, index: Index): Promise<Index> {
  await saveHistory(host as any, 'windows', STORE, 's1', index, 5)
  const loaded = await loadHistory(host as any, STORE, 's1')
  assert.ok(loaded !== null && 'index' in loaded)
  return loaded.index
}

test('resumed history, file untouched since: the revert lands', async () => {
  const host = movingHost()
  const { index, key } = await edited(host, 'C:/p/a.ts', 'old\n', 'new\n')
  const back = await resumed(host, index)
  const result = await revertFile(host as any, WIN, back, { turnId: 't1', key }, 'turn', 'C:/p/a.ts')
  assert.equal(result.ok, true)
  assert.equal(host.text('C:/p/a.ts'), 'old\n')
})

test('resumed history, file changed while no session watched: refused, nothing written', async () => {
  const host = movingHost()
  const { index, key } = await edited(host, 'C:/p/a.ts', 'old\n', 'new\n')
  const back = await resumed(host, index)
  host.put('C:/p/a.ts', 'edited between sessions\n')
  const result = await revertFile(host as any, WIN, back, { turnId: 't1', key }, 'turn', 'C:/p/a.ts')
  assert.deepEqual(result, { ok: false, reason: 'changed-externally' })
  assert.equal(host.text('C:/p/a.ts'), 'edited between sessions\n')
})

test('resumed history, committed in between: the link cannot be confirmed, as today', async () => {
  const host = movingHost()
  const first = await edited(host, 'C:/p/a.ts', 'old\n', 'new\n')
  // After a commit, the next turn's shell edit has git's copy as its before.
  host.put('C:/p/a.ts', 'newer\n')
  const post = await capture(host as any, STORE, 'C:/p/a.ts')
  let index = openTurn(first.index, { turnId: 't2', prompt: 'more', at: 3 })
  index = addEdit(index, { toolUseId: 'sh', tool: 'Bash', via: 'shell', path: 'C:/p/a.ts', key: first.key, before: { git: { oid: 'o1', commit: 'c1' } }, after: post, startedAt: 3, at: 4 })
  const back = await resumed(host, index)
  const result = await revertFile(host as any, WIN, back, { turnId: 't1', key: first.key }, 'turnAndLater', 'C:/p/a.ts')
  assert.deepEqual(result, { ok: false, reason: 'unverifiable-link', between: ['t1', 't2'] })
  assert.equal(host.text('C:/p/a.ts'), 'newer\n')
})
