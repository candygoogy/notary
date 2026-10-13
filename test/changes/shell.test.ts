import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { fakeHost } from './fake-host.ts'
import { MAX_SHELL_CANDIDATES, MAX_SHELL_FILES, SHELL_BUDGET_MS, shellAfter, shellBefore, type ShellToken } from '../../plugins/changes/hooks/io/shell.ts'
import { unexplained } from '../../plugins/changes/hooks/core/sweep.ts'
import { emptyIndex, type Content } from '../../plugins/changes/hooks/core/model.ts'
import { addEdit, openTurn } from '../../plugins/changes/hooks/core/timeline.ts'

const ROOT = 'C:/repo'
const STORE = 'C:/store'
const ctx = { root: ROOT, store: STORE }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const textOf = (text: string): Content => ({ hash: sha(text), size: Buffer.byteLength(text), kind: 'text', eol: text.includes('\n') ? 'lf' : 'none', bom: false })

// A repository whose git answers come from `git`, changed between calls.
function repo() {
  const git = {
    ok: true,
    status: '',
    head: 'c1',
    blobs: {} as Record<string, string>,
    hashes: {} as Record<string, string>,
  }
  const host = fakeHost({
    onRun: ({ argv, init }) => {
      const sub = argv.slice(5)
      const fail = { exitCode: 1, stdout: '' }
      if (!git.ok) return fail
      const lines = (init?.stdin ?? '').split('\n').filter(l => l !== '')
      if (sub[0] === 'status') return { exitCode: 0, stdout: git.status }
      if (sub[0] === 'rev-parse' && sub[3] === 'HEAD') return git.head ? { exitCode: 0, stdout: git.head + '\n' } : fail
      if (sub[0] === 'cat-file' && sub[1] === '--batch-check') {
        return { exitCode: 0, stdout: lines.map(l => (git.blobs[l] ? `${git.blobs[l]} blob 5` : `${l} missing`)).join('\n') + '\n' }
      }
      if (sub[0] === 'hash-object' && sub[1] === '--stdin-paths') {
        return { exitCode: 0, stdout: lines.map(l => git.hashes[l] ?? 'fresh').join('\n') + '\n' }
      }
      return fail
    },
  })
  return { git, host, at: (rel: string) => `${ROOT}/${rel}` }
}

async function changesOf(host: ReturnType<typeof fakeHost>, token: ShellToken | null) {
  assert.ok(token !== null)
  const result = await shellAfter(host as any, ctx, token)
  assert.ok('changes' in result, JSON.stringify(result))
  return result.changes
}

test('a clean file the command modified comes back with its HEAD blob as before', async () => {
  const { git, host, at } = repo()
  host.put(at('a.ts'), 'old\n')
  const token = await shellBefore(host as any, ctx)
  host.put(at('a.ts'), 'new\n')
  git.status = ' M a.ts\0'
  git.blobs['c1:a.ts'] = 'o1'
  git.hashes['a.ts'] = 'o2'
  assert.deepEqual(await changesOf(host, token), [{ rel: 'a.ts', path: at('a.ts'), before: { git: { oid: 'o1', commit: 'c1' } }, after: textOf('new\n') }])
})

test('a clean file whose content still matches its blob is dropped (an index-only change)', async () => {
  const { git, host, at } = repo()
  host.put(at('a.ts'), 'same\n')
  const token = await shellBefore(host as any, ctx)
  git.status = 'M  a.ts\0'
  git.blobs['c1:a.ts'] = 'o1'
  git.hashes['a.ts'] = 'o1'
  assert.deepEqual(await changesOf(host, token), [])
})

test('a new untracked file has an absent before', async () => {
  const { git, host, at } = repo()
  const token = await shellBefore(host as any, ctx)
  host.put(at('out.log'), 'x')
  git.status = '?? out.log\0'
  const [change] = await changesOf(host, token)
  assert.deepEqual([change.before, change.after], [{ absent: true }, textOf('x')])
})

test('a dirty file the command changed has its snapshot as before, stored for revert', async () => {
  const { git, host, at } = repo()
  git.status = ' M a.ts\0'
  host.put(at('a.ts'), 'mine\n')
  const token = await shellBefore(host as any, ctx)
  assert.ok(host.files.has(`${STORE}/blobs/${sha('mine\n')}.txt`))
  host.put(at('a.ts'), 'script\n')
  const [change] = await changesOf(host, token)
  assert.deepEqual([change.before, change.after], [textOf('mine\n'), textOf('script\n')])
})

test('review #8: a same-size rewrite keeping the mtime is caught for a small dirty file', async () => {
  const { git, host, at } = repo()
  git.status = ' M a.ts\0'
  host.put(at('a.ts'), 'aaaa', 500)
  const token = await shellBefore(host as any, ctx)
  host.put(at('a.ts'), 'bbbb', 500)
  const [change] = await changesOf(host, token)
  assert.deepEqual([change.before, change.after], [textOf('aaaa'), textOf('bbbb')])
})

test('a dirty file the command did not touch is no change, whatever git add did', async () => {
  const { git, host, at } = repo()
  git.status = ' M a.ts\0'
  host.put(at('a.ts'), 'mine\n')
  const token = await shellBefore(host as any, ctx)
  git.status = 'M  a.ts\0'
  assert.deepEqual(await changesOf(host, token), [])
})

test('a dirty file the command deleted has an absent after', async () => {
  const { git, host, at } = repo()
  git.status = ' M a.ts\0'
  host.put(at('a.ts'), 'mine\n')
  const token = await shellBefore(host as any, ctx)
  host.files.delete(at('a.ts'))
  git.status = ' D a.ts\0'
  const [change] = await changesOf(host, token)
  assert.deepEqual([change.before, change.after], [textOf('mine\n'), { absent: true }])
})

test('when git cannot answer before, nothing is tracked or said; after, the call is untracked', async () => {
  const { git, host } = repo()
  git.ok = false
  assert.equal(await shellBefore(host as any, ctx), null)
  git.ok = true
  const token = await shellBefore(host as any, ctx)
  git.ok = false
  assert.deepEqual(await shellAfter(host as any, ctx, token!), { untracked: 'git did not answer' })
})

test('small dirty files are hashed only up to the per-call budget; the rest use stat stamps', async () => {
  const { git, host, at } = repo()
  const rels = Array.from({ length: 10 }, (_, i) => `m${i}.bin`)
  git.status = rels.map(r => ` M ${r}\0`).join('')
  for (const r of rels) host.put(at(r), new Uint8Array(1024 * 1024).fill(r.charCodeAt(1)))
  const token = await shellBefore(host as any, ctx)
  assert.ok(token !== null && !('untracked' in token))
  assert.equal(token.hashed.size, 8)
  assert.equal(token.snapshot.stamps.get('m9.bin')?.hash, undefined)
})

test('on an unborn HEAD a new file is absent before and no blob is asked for', async () => {
  const { git, host, at } = repo()
  git.head = ''
  const token = await shellBefore(host as any, ctx)
  host.put(at('first.ts'), 'x')
  git.status = '?? first.ts\0'
  const [change] = await changesOf(host, token)
  assert.deepEqual(change.before, { absent: true })
  assert.ok(!host.runs.some(r => r.argv.includes('cat-file')))
})

// ── review 2 #1: bounded, batched, HEAD moves ──

test('review 2 #1: a moved HEAD makes the call untracked, with no per-file work', async () => {
  const { git, host, at } = repo()
  host.put(at('switched.ts'), 'branch a\n')
  const token = await shellBefore(host as any, ctx)
  host.put(at('switched.ts'), 'branch b\n')
  git.head = 'c2'
  const runsBefore = host.runs.length
  assert.deepEqual(await shellAfter(host as any, ctx, token!), { untracked: 'HEAD moved (a checkout, reset, pull or commit)' })
  assert.equal(host.runs.length - runsBefore, 2)
})

test(`review 2 #1: past ${MAX_SHELL_CANDIDATES} changed files the call is untracked`, async () => {
  const { git, host, at } = repo()
  const token = await shellBefore(host as any, ctx)
  const rels = Array.from({ length: MAX_SHELL_CANDIDATES + 1 }, (_, i) => `gen/f${i}.ts`)
  for (const r of rels) host.put(at(r), 'x')
  git.status = rels.map(r => `?? ${r}\0`).join('')
  assert.deepEqual(await shellAfter(host as any, ctx, token!), { untracked: `many files changed (${MAX_SHELL_CANDIDATES + 1})` })
})

test(`review 2 #1: past ${MAX_SHELL_FILES} dirty files before, the call is untracked`, async () => {
  const { git, host } = repo()
  git.status = Array.from({ length: MAX_SHELL_FILES + 1 }, (_, i) => ` M f${i}.ts\0`).join('')
  assert.deepEqual(await shellBefore(host as any, ctx), { untracked: `too many uncommitted files to follow (${MAX_SHELL_FILES + 1})` })
})

test('review 2 #1: past the wall-clock budget the call is untracked', async () => {
  const { git, host, at } = repo()
  git.status = ' M a.ts\0 M b.ts\0'
  host.put(at('a.ts'), 'a')
  host.put(at('b.ts'), 'b')
  host.step = SHELL_BUDGET_MS
  assert.deepEqual(await shellBefore(host as any, ctx), { untracked: 'took too long to read' })
})

test('cross-review #2: a command that runs long is still tracked; only our own reading counts', async () => {
  const { git, host, at } = repo()
  const token = await shellBefore(host as any, ctx)
  host.time += 30_000 // the command itself: a long npm test
  host.put(at('out.txt'), 'x')
  git.status = '?? out.txt\0'
  const changes = await changesOf(host, token)
  assert.equal(changes.length, 1)
})

test('cross-review #2: every git call is timed out at the time left, and a killed one means git is slow', async () => {
  const { git, host } = repo()
  const token = await shellBefore(host as any, ctx)
  const timeouts: number[] = []
  const slow = fakeHost({
    onRun: ({ init }) => {
      timeouts.push(init?.timeoutMs ?? 0)
      slow.time += init?.timeoutMs ?? 0
      throw new Error('timed out')
    },
  })
  slow.time = host.time
  assert.deepEqual(await shellAfter(slow as any, ctx, token!), { untracked: 'git is slow here', slow: true })
  assert.ok(timeouts.every(t => t > 0 && t <= SHELL_BUDGET_MS), JSON.stringify(timeouts))
  assert.equal(timeouts.length, 1)
  void git
})

test('cross-review #2: no git call starts once the budget is spent', async () => {
  const { git, host, at } = repo()
  git.status = ' M a.ts\0'
  host.put(at('a.ts'), 'a')
  const token = await shellBefore(host as any, ctx)
  assert.ok(token !== null && !('untracked' in token))
  token.spentMs = SHELL_BUDGET_MS
  const before = host.runs.length
  assert.deepEqual(await shellAfter(host as any, ctx, token), { untracked: 'took too long to read' })
  assert.equal(host.runs.length, before)
})

test('review 2 #1: blobs and hashes for many clean files take one git process each', async () => {
  const { git, host, at } = repo()
  const rels = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`)
  for (const r of rels) host.put(at(r), 'old')
  const token = await shellBefore(host as any, ctx)
  for (const r of rels) {
    host.put(at(r), 'new')
    git.blobs[`c1:${r}`] = `o-${r}`
  }
  git.status = rels.map(r => ` M ${r}\0`).join('')
  const changes = await changesOf(host, token)
  assert.equal(changes.length, 50)
  assert.equal(host.runs.filter(r => r.argv.includes('cat-file')).length, 1)
  assert.equal(host.runs.filter(r => r.argv.includes('hash-object')).length, 1)
})

// ── the turn sweep ──

test('unexplained keeps only changes whose content no recorded transition left', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, { toolUseId: 'e', tool: 'Edit', via: 'tool', path: 'a', key: 'a', before: textOf('0'), after: textOf('1'), startedAt: 1, at: 2 })
  assert.deepEqual(unexplained(index, [{ key: 'a', after: textOf('1') }, { key: 'a2', after: textOf('x') }]).map(c => c.key), ['a2'])
  assert.deepEqual(unexplained(index, [{ key: 'a', after: textOf('2') }]).map(c => c.key), ['a'])
})

test('unexplained accounts for an async agent\'s edit filed under an earlier turn', () => {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, { toolUseId: 'e', tool: 'Edit', via: 'tool', agentId: 'A', path: 'a', key: 'a', before: textOf('0'), after: textOf('1'), startedAt: 1, at: 2 })
  index = openTurn(index, { turnId: 't2', prompt: '', at: 3 })
  assert.deepEqual(unexplained(index, [{ key: 'a', after: textOf('1') }]), [])
})
