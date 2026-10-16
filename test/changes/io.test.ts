import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { fakeHost, base64FromBytes, bytesFromBase64, type Run, type RunResult } from './fake-host.ts'
import { capture, keyOf, loadBase64, loadText, storeDirOf } from '../../plugins/changes/hooks/io/blobs.ts'
import { blobAt, blobsAt, cleanBlobOf, hashObject, hashObjects, headOf, repoRootOf, restoreFrom, runGit, statusOf } from '../../plugins/changes/hooks/io/git.ts'
import { planTurn, revertFile, revertTurn, runRestore } from '../../plugins/changes/hooks/io/restore.ts'
import { platformOf } from '../../plugins/changes/hooks/io/ports.ts'
import { emptyIndex, type Index } from '../../plugins/changes/hooks/core/model.ts'
import { addEdit, openTurn, recordRevert, statusOf as fileStatus } from '../../plugins/changes/hooks/core/timeline.ts'

const STORE = 'C:/Users/me/.claude/plugin-data/notary-changes/s1'
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

// ── blobs ──

test('the store lives under CLAUDE_CONFIG_DIR when set, else the home folder', () => {
  assert.equal(storeDirOf({ CLAUDE_CONFIG_DIR: 'D:/cfg' }, 's1'), 'D:/cfg/plugin-data/notary-changes/s1')
  assert.equal(storeDirOf({ USERPROFILE: 'C:\\Users\\me' }, 's1'), 'C:/Users/me/.claude/plugin-data/notary-changes/s1')
  assert.equal(storeDirOf({ HOME: '/home/me' }, 's1'), '/home/me/.claude/plugin-data/notary-changes/s1')
})

test('capturing a text file hashes its bytes and stores the text once', async () => {
  const host = fakeHost()
  host.put('C:/p/a.ts', '\uFEFFa\r\nb\r\n')
  const first = await capture(host as any, STORE, 'C:/p/a.ts')
  const hash = sha(new TextEncoder().encode('\uFEFFa\r\nb\r\n'))
  assert.deepEqual(first, { hash, size: 9, kind: 'text', eol: 'crlf', bom: true })
  assert.equal(host.text(`${STORE}/blobs/${hash}.txt`), '\uFEFFa\r\nb\r\n')
  const writes = host.files.size
  await capture(host as any, STORE, 'C:/p/a.ts')
  assert.equal(host.files.size, writes)
  assert.equal(await loadText(host as any, STORE, hash), '\uFEFFa\r\nb\r\n')
})

test('capturing a binary file stores base64', async () => {
  const host = fakeHost()
  const bytes = Uint8Array.of(0x89, 0x50, 0x00, 0xff)
  host.put('C:/p/img.png', bytes)
  const content = await capture(host as any, STORE, 'C:/p/img.png')
  assert.deepEqual(content, { hash: sha(bytes), size: 4, kind: 'binary', eol: 'none', bom: false })
  assert.equal(await loadBase64(host as any, STORE, sha(bytes)), base64FromBytes(bytes))
})

test('a missing file is absent and a folder is unreadable', async () => {
  const host = fakeHost()
  host.put('C:/p/dir/x', 'x')
  assert.deepEqual(await capture(host as any, STORE, 'C:/p/nope.ts'), { absent: true })
  assert.deepEqual(await capture(host as any, STORE, 'C:/p/dir'), { unreadable: 'io' })
})

test('a file over 4 MiB is too large and is not read', async () => {
  const host = fakeHost()
  host.put('C:/p/big.bin', new Uint8Array(4 * 1024 * 1024 + 1))
  assert.deepEqual(await capture(host as any, STORE, 'C:/p/big.bin'), { unreadable: 'too-large' })
})

test('capture with store: false hashes without writing a blob', async () => {
  const host = fakeHost()
  host.put('C:/p/a.ts', 'a\n')
  const content = await capture(host as any, STORE, 'C:/p/a.ts', { store: false })
  assert.equal('hash' in content && content.hash, sha('a\n'))
  assert.equal(host.files.size, 1)
})

test('keyOf resolves the real path and folds case on Windows', async () => {
  const host = fakeHost()
  host.put('C:/Proj/Src/A.ts', 'a')
  assert.equal(await keyOf(host as any, 'C:\\Proj\\Src\\A.ts', 'windows'), 'c:/proj/src/a.ts')
  assert.equal(await keyOf(host as any, 'C:/Proj/Src/A.ts', 'posix'), 'C:/Proj/Src/A.ts')
})

test('keyOf places a file not there yet under its folder', async () => {
  const host = fakeHost()
  host.put('C:/Proj/Src/A.ts', 'a')
  assert.equal(await keyOf(host as any, 'C:/Proj/Src/New.ts', 'windows'), 'c:/proj/src/new.ts')
})

// ── git ──

function gitHost(answers: Record<string, RunResult>) {
  return fakeHost({
    onRun: ({ argv }) => {
      const sub = argv.slice(argv.indexOf('-c') + 2).join(' ')
      for (const [prefix, answer] of Object.entries(answers)) if (sub.startsWith(prefix)) return answer
      return { exitCode: 1, stdout: '' }
    },
  })
}

test('git runs without optional locks, with quotePath off, in the C locale', async () => {
  const host = gitHost({ 'status': { exitCode: 0, stdout: '' } })
  await runGit(host as any, 'C:/repo', ['status'])
  const [run] = host.runs
  assert.deepEqual(run.argv, ['git', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', 'status'])
  assert.equal(run.init?.cwd, 'C:/repo')
  assert.deepEqual(run.init?.env, { LC_ALL: 'C', LANGUAGE: '' })
  assert.equal(run.init?.timeoutMs, 5000)
})

test('repoRootOf and headOf answer null outside a repository or on an unborn HEAD', async () => {
  const ok = gitHost({ 'rev-parse --show-toplevel': { exitCode: 0, stdout: 'C:/repo\n' }, 'rev-parse --verify --quiet HEAD': { exitCode: 0, stdout: 'abc\n' } })
  assert.equal(await repoRootOf(ok as any, 'C:/repo/src'), 'C:/repo')
  assert.equal(await headOf(ok as any, 'C:/repo'), 'abc')
  const none = gitHost({})
  assert.equal(await repoRootOf(none as any, 'C:/x'), null)
  assert.equal(await headOf(none as any, 'C:/x'), null)
})

test('statusOf parses porcelain -z, and a failed or cut answer is null', async () => {
  const host = gitHost({ 'status --porcelain=v1 -z --untracked-files=all': { exitCode: 0, stdout: ' M a.ts\0?? b.ts\0' } })
  const status = await statusOf(host as any, 'C:/repo')
  assert.deepEqual([...(status?.keys() ?? [])], ['a.ts', 'b.ts'])
  assert.equal(await statusOf(gitHost({}) as any, 'C:/repo'), null)
  const cut = fakeHost({ onRun: () => ({ exitCode: 0, stdout: ' M a\0', isStdoutTruncated: true }) as any })
  assert.equal(await statusOf(cut as any, 'C:/repo'), null)
})

test('blobAt, hashObject and restoreFrom pass the path after --', async () => {
  const host = gitHost({
    'rev-parse --verify --quiet c1:src/a b.ts': { exitCode: 0, stdout: 'oid1\n' },
    'hash-object -- src/a b.ts': { exitCode: 0, stdout: 'oid2\n' },
    'restore --source=c1 --worktree -- src/a b.ts': { exitCode: 0, stdout: '' },
  })
  assert.equal(await blobAt(host as any, 'C:/repo', 'c1', 'src/a b.ts'), 'oid1')
  assert.equal(await hashObject(host as any, 'C:/repo', 'src/a b.ts'), 'oid2')
  assert.equal(await restoreFrom(host as any, 'C:/repo', 'c1', 'src/a b.ts'), true)
  assert.equal(await blobAt(host as any, 'C:/repo', 'c1', 'missing.ts'), null)
})

test('review 2 #8: cleanBlobOf gives a large clean file its HEAD blob, and nothing for a dirty one', async () => {
  const answers = (statusOut: string) =>
    gitHost({
      'rev-parse --verify --quiet HEAD': { exitCode: 0, stdout: 'c1\n' },
      'status --porcelain=v1 -z -- big.bin': { exitCode: 0, stdout: statusOut },
      'rev-parse --verify --quiet c1:big.bin': { exitCode: 0, stdout: 'ob\n' },
    })
  assert.deepEqual(await cleanBlobOf(answers('') as any, 'C:/repo', 'big.bin'), { oid: 'ob', commit: 'c1' })
  assert.equal(await cleanBlobOf(answers(' M big.bin\0') as any, 'C:/repo', 'big.bin'), null)
})

test('blobsAt and hashObjects read one line per path, and refuse a short answer', async () => {
  const host = fakeHost({
    onRun: ({ argv, init }) => {
      const lines = (init?.stdin ?? '').split('\n').filter(Boolean)
      if (argv.includes('--batch-check')) return { exitCode: 0, stdout: lines.map(l => (l.endsWith('a.ts') ? 'oa blob 3' : `${l} missing`)).join('\n') + '\n' }
      if (argv.includes('--stdin-paths')) return { exitCode: 0, stdout: 'h1\n' }
      return { exitCode: 1, stdout: '' }
    },
  })
  assert.deepEqual([...(await blobsAt(host as any, 'C:/repo', 'c1', ['a.ts', 'new.ts']))!], [['a.ts', 'oa'], ['new.ts', null]])
  assert.deepEqual([...(await hashObjects(host as any, 'C:/repo', ['a.ts']))!], [['a.ts', 'h1']])
  assert.equal(await hashObjects(host as any, 'C:/repo', ['a.ts', 'b.ts']), null)
  assert.deepEqual(host.runs[0].init?.stdin, 'c1:a.ts\nc1:new.ts\n')
})

// ── restore ──

test('platformOf reads the OS variable', () => {
  assert.equal(platformOf('Windows_NT'), 'windows')
  assert.equal(platformOf(undefined), 'posix')
})

// A host whose process runs act on its files the way the real commands do:
// PowerShell's WriteAllBytes and Replace/Move, sh's decode-then-mv, mv, rm.
// `fails`: while it answers true, every command fails (a full or locked disk).
function actingHost(env: Record<string, string> = {}, fails: () => boolean = () => false) {
  let host: ReturnType<typeof fakeHost>
  const move = (from: string, to: string) => {
    const bytes = host.files.get(from)
    if (bytes === undefined) return { exitCode: 1, stdout: '' }
    host.files.delete(from)
    host.put(to, bytes)
    return { exitCode: 0, stdout: '' }
  }
  host = fakeHost({
    env,
    onRun: ({ argv, init }: Run) => {
      if (fails()) return { exitCode: 1, stdout: '' }
      const tmp = init?.env?.NOTARY_TMP
      const target = init?.env?.NOTARY_TARGET
      const script = argv.join(' ')
      if (script.includes('WriteAllBytes') || (argv[0] === 'sh' && script.includes('base64 -d'))) {
        host.put(tmp!, bytesFromBase64(init!.stdin!))
        return move(tmp!, target!)
      }
      if (script.includes('[IO.File]::Replace')) return move(tmp!, target!)
      if (script.includes('Remove-Item')) {
        host.files.delete(target!)
        return { exitCode: 0, stdout: '' }
      }
      if (argv[0] === 'mv') return move(argv[3], argv[4])
      if (argv[0] === 'rm') {
        host.files.delete(argv[argv.length - 1])
        return { exitCode: 0, stdout: '' }
      }
      return { exitCode: 1, stdout: '' }
    },
  })
  return host
}

const shaOf = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
// The temp files a restore of `path` would use, left on the host.
const tmpsOf = (host: ReturnType<typeof fakeHost>, path: string) => [...host.files.keys()].filter(k => k.startsWith(`${path}.notary-tmp-`))
const TMP_OF = (path: string) => new RegExp(`^${path.replace(/[.]/g, '\\.')}\\.notary-tmp-[0-9a-f-]{36}$`)

test('write-text writes the stored text through a temp file and a rename', async () => {
  const host = actingHost()
  const text = '\uFEFFold\r\n'
  const hash = shaOf(new TextEncoder().encode(text))
  host.put(`${STORE}/blobs/${hash}.txt`, text)
  host.put('C:/p/a.ts', 'new')
  assert.equal(await runRestore(host as any, { platform: 'windows', store: STORE }, 'C:/p/a.ts', undefined, { kind: 'write-text', hash }), true)
  assert.equal(host.text('C:/p/a.ts'), text)
  assert.deepEqual(tmpsOf(host, 'C:/p/a.ts'), [])
  assert.ok(host.runs[0].argv[4].includes('[IO.File]::Replace'))
  assert.match(host.runs[0].init?.env?.NOTARY_TMP ?? '', TMP_OF('C:/p/a.ts'))
})

test('review 2 #5: a blob whose content does not match its hash is never written', async () => {
  const host = actingHost()
  host.put(`${STORE}/blobs/${'0'.repeat(64)}.txt`, 'corrupt')
  host.put('C:/p/a.ts', 'mine')
  assert.equal(await runRestore(host as any, { platform: 'windows', store: STORE }, 'C:/p/a.ts', undefined, { kind: 'write-text', hash: '0'.repeat(64) }), false)
  assert.equal(host.text('C:/p/a.ts'), 'mine')
  assert.equal(host.runs.length, 0)
})

test('write-bytes on Windows writes the temp file and replaces the target in one PowerShell run', async () => {
  const host = actingHost()
  const bytes = Uint8Array.of(0, 255, 13, 10)
  host.put(`${STORE}/blobs/${shaOf(bytes)}.b64`, base64FromBytes(bytes))
  assert.equal(await runRestore(host as any, { platform: 'windows', store: STORE }, 'C:/p/x.bin', undefined, { kind: 'write-bytes', hash: shaOf(bytes) }), true)
  const run = host.runs[0]
  assert.equal(run.argv[0], 'powershell')
  assert.deepEqual(Object.keys(run.init?.env ?? {}), ['NOTARY_TMP', 'NOTARY_TARGET'])
  assert.match(run.init?.env?.NOTARY_TMP ?? '', TMP_OF('C:/p/x.bin'))
  assert.equal(run.init?.env?.NOTARY_TARGET, 'C:/p/x.bin')
  assert.equal(run.init?.stdin, base64FromBytes(bytes))
  assert.deepEqual(host.files.get('C:/p/x.bin'), bytes)
  assert.deepEqual(tmpsOf(host, 'C:/p/x.bin'), [])
})

test('review 2 #5: write-bytes on POSIX decodes into the temp file before replacing the target', async () => {
  const host = actingHost()
  const bytes = Uint8Array.of(1, 2)
  host.put(`${STORE}/blobs/${shaOf(bytes)}.b64`, base64FromBytes(bytes))
  await runRestore(host as any, { platform: 'posix', store: STORE }, '/p/x.bin', undefined, { kind: 'write-bytes', hash: shaOf(bytes) })
  const run = host.runs[0]
  assert.equal(run.argv[0], 'sh')
  assert.match(run.argv[2], /> "\$NOTARY_TMP" && mv -f -- "\$NOTARY_TMP" "\$NOTARY_TARGET"/)
  assert.match(run.argv[2], /openssl base64 -d -A/)
  assert.deepEqual(host.files.get('/p/x.bin'), bytes)
})

test('review 2 #5: a failed write-bytes leaves neither a temp file nor an empty target', async () => {
  const host = fakeHost({ onRun: ({ argv }) => (argv.join(' ').includes('Remove-Item') ? { exitCode: 0, stdout: '' } : { exitCode: 1, stdout: '' }) })
  const bytes = Uint8Array.of(7)
  host.put(`${STORE}/blobs/${shaOf(bytes)}.b64`, base64FromBytes(bytes))
  assert.equal(await runRestore(host as any, { platform: 'windows', store: STORE }, 'C:/p/new.bin', undefined, { kind: 'write-bytes', hash: shaOf(bytes) }), false)
  assert.equal(host.files.has('C:/p/new.bin'), false)
  const cleanup = host.runs.find(r => r.argv.join(' ').includes('Remove-Item'))
  assert.match(cleanup?.init?.env?.NOTARY_TARGET ?? '', TMP_OF('C:/p/new.bin'))
  assert.equal(cleanup?.init?.env?.NOTARY_TARGET, host.runs[0].init?.env?.NOTARY_TMP)
})

test('a file already named like a temp file is never written over or removed', async t => {
  const text = 'old\n'
  const hash = shaOf(text)
  const setUp = (host: ReturnType<typeof fakeHost>) => {
    host.put(`${STORE}/blobs/${hash}.txt`, text)
    host.put('C:/p/a.ts', 'new')
    host.put('C:/p/a.ts.notary-tmp', 'mine')
    host.put('C:/p/a.ts.notary-tmp-taken', 'mine too')
  }
  const untouched = (host: ReturnType<typeof fakeHost>) => {
    assert.equal(host.text('C:/p/a.ts.notary-tmp'), 'mine')
    assert.equal(host.text('C:/p/a.ts.notary-tmp-taken'), 'mine too')
  }
  // The random names handed out in turn, the last one again and again. The
  // first is one already on disk: it is passed by.
  let names: string[] = []
  t.mock.method(crypto, 'randomUUID', () => (names.length > 1 ? names.shift() : names[0]))
  const ids = (...list: string[]) => (names = list)
  const ctx = { platform: 'windows' as const, store: STORE }

  ids('taken', 'ours')
  const ok = actingHost()
  setUp(ok)
  assert.equal(await runRestore(ok as any, ctx, 'C:/p/a.ts', undefined, { kind: 'write-text', hash }), true)
  assert.equal(ok.text('C:/p/a.ts'), text)
  assert.equal(ok.runs[0].init?.env?.NOTARY_TMP, 'C:/p/a.ts.notary-tmp-ours')
  untouched(ok)

  // The rename fails: only this revert's own temp file is removed.
  ids('taken', 'ours')
  const failed = fakeHost({ onRun: ({ argv, init }) => (argv.join(' ').includes('Remove-Item') ? (failed.files.delete(init!.env!.NOTARY_TARGET!), { exitCode: 0, stdout: '' }) : { exitCode: 1, stdout: '' }) })
  setUp(failed)
  assert.equal(await runRestore(failed as any, ctx, 'C:/p/a.ts', undefined, { kind: 'write-text', hash }), false)
  assert.equal(failed.text('C:/p/a.ts'), 'new')
  assert.deepEqual(failed.runs.filter(r => r.argv.join(' ').includes('Remove-Item')).map(r => r.init?.env?.NOTARY_TARGET), ['C:/p/a.ts.notary-tmp-ours'])
  assert.equal(failed.files.has('C:/p/a.ts.notary-tmp-ours'), false)
  untouched(failed)

  // No free name: refused before anything is written.
  ids('taken')
  const full = actingHost()
  setUp(full)
  assert.equal(await runRestore(full as any, ctx, 'C:/p/a.ts', undefined, { kind: 'write-text', hash }), false)
  assert.equal(full.runs.length, 0)
  assert.equal(full.text('C:/p/a.ts'), 'new')
  untouched(full)
})

test('two restores of one file at once use their own temp files, and neither removes the other', async () => {
  const [a, b] = ['from a\n', 'from b\n']
  // The rename of a's temp file fails; b's goes through.
  let aTmp: string | undefined
  const host = actingHost({}, () => {
    const run = host.runs[host.runs.length - 1]
    if (!run.argv.join(' ').includes('[IO.File]::Replace') || host.text(run.init!.env!.NOTARY_TMP!) !== a) return false
    aTmp = run.init!.env!.NOTARY_TMP
    return true
  })
  for (const text of [a, b]) host.put(`${STORE}/blobs/${shaOf(text)}.txt`, text)
  host.put('C:/p/a.ts', 'new')
  // No command runs until both temp files are written.
  const run = host.process.run
  let release!: () => void
  const bothWritten = new Promise<void>(resolve => (release = resolve))
  let calls = 0
  host.process.run = async (argv, init) => {
    if (++calls === 2) release()
    await bothWritten
    return run(argv, init)
  }
  const ctx = { platform: 'windows' as const, store: STORE }
  const results = await Promise.all([a, b].map(text => runRestore(host as any, ctx, 'C:/p/a.ts', undefined, { kind: 'write-text', hash: shaOf(text) })))
  assert.deepEqual(results, [false, true])
  assert.equal(host.text('C:/p/a.ts'), b)
  const moves = host.runs.filter(r => r.argv.join(' ').includes('[IO.File]::Replace')).map(r => r.init?.env?.NOTARY_TMP)
  assert.equal(moves.length, 2)
  assert.notEqual(moves[0], moves[1])
  for (const tmp of moves) assert.match(tmp ?? '', TMP_OF('C:/p/a.ts'))
  const removed = host.runs.filter(r => r.argv.join(' ').includes('Remove-Item')).map(r => r.init?.env?.NOTARY_TARGET)
  assert.deepEqual(removed, [aTmp])
  assert.deepEqual(tmpsOf(host, 'C:/p/a.ts'), [])
})

test('delete uses PowerShell on Windows and rm on POSIX', async () => {
  const win = actingHost()
  win.put('C:/p/new.ts', 'x')
  assert.equal(await runRestore(win as any, { platform: 'windows', store: STORE }, 'C:/p/new.ts', undefined, { kind: 'delete' }), true)
  assert.equal(win.files.has('C:/p/new.ts'), false)
  const posix = actingHost()
  posix.put('/p/new.ts', 'x')
  await runRestore(posix as any, { platform: 'posix', store: STORE }, '/p/new.ts', undefined, { kind: 'delete' })
  assert.deepEqual(posix.runs[0].argv, ['rm', '-f', '--', '/p/new.ts'])
  assert.equal(posix.files.has('/p/new.ts'), false)
})

test('git-restore needs the repository and the root-relative path', async () => {
  const host = gitHost({ 'restore --source=c1 --worktree -- src/a.ts': { exitCode: 0, stdout: '' } })
  const ctx = { platform: 'windows' as const, store: STORE, root: 'C:/repo' }
  assert.equal(await runRestore(host as any, ctx, 'C:/repo/src/a.ts', 'src/a.ts', { kind: 'git-restore', commit: 'c1', oid: 'o1' }), true)
  assert.equal(await runRestore(host as any, { ...ctx, root: undefined }, 'C:/repo/src/a.ts', 'src/a.ts', { kind: 'git-restore', commit: 'c1', oid: 'o1' }), false)
})

test('none does nothing and succeeds', async () => {
  const host = actingHost()
  assert.equal(await runRestore(host as any, { platform: 'windows', store: STORE }, 'C:/p/a.ts', undefined, { kind: 'none' }), true)
  assert.equal(host.runs.length, 0)
})

// ── revertFile: plan, restore, verify ──

// One turn edited `path`; the edit's key is what keyOf gives on Windows.
async function editedIndex(host: ReturnType<typeof fakeHost>, path: string, before: string | null, after: string) {
  if (before !== null) host.put(path, before)
  const pre = await capture(host as any, STORE, path)
  host.put(path, after)
  const post = await capture(host as any, STORE, path)
  const key = await keyOf(host as any, path, 'windows')
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, { toolUseId: 'tu', tool: 'Edit', via: 'tool', path, key, before: pre, after: post, startedAt: 1, at: 2 })
  return { index, key }
}

const WIN = { platform: 'windows' as const, store: STORE }

test('revertFile restores the before, verifies it and names the changes to mark', async () => {
  const host = actingHost()
  const { index, key } = await editedIndex(host, 'C:/p/a.ts', 'old\r\n', 'new\r\n')
  const result = await revertFile(host as any, WIN, index, { turnId: 't1', key }, 'turn', 'C:/p/a.ts')
  assert.deepEqual(result.ok && result.refs, [{ turnId: 't1', key }])
  // The transition recordRevert files: from what was on disk to the target.
  assert.deepEqual(result.ok && [result.before, result.after], [index.edits[0].after, index.edits[0].before])
  assert.equal(host.text('C:/p/a.ts'), 'old\r\n')
})

test('review 2 #5: the content a revert replaces is stored, so the revert can be undone', async () => {
  const host = actingHost()
  const { index, key } = await editedIndex(host, 'C:/p/a.ts', 'old\n', 'new\n')
  host.files.delete(`${STORE}/blobs/${shaOf('new\n')}.txt`)
  await revertFile(host as any, WIN, index, { turnId: 't1', key }, 'turn', 'C:/p/a.ts')
  assert.equal(host.text(`${STORE}/blobs/${shaOf('new\n')}.txt`), 'new\n')
})

test('review 2 #5: a path that no longer lands on the planned file is left alone', async () => {
  const host = actingHost()
  const { index } = await editedIndex(host, 'C:/p/a.ts', 'old\n', 'new\n')
  const result = await revertFile(host as any, WIN, index, { turnId: 't1', key: 'c:/p/a.ts' }, 'turn', 'C:/p/a.ts')
  assert.equal(result.ok, true)
  // Its saved copies are on this disk too: only the path's target moved.
  const elsewhere = actingHost()
  const moved = await editedIndex(elsewhere, 'C:/q/b.ts', 'old\n', 'new\n')
  ;(elsewhere.fs as any).stat = async (path: string, opts?: { resolve?: boolean }) => ({ kind: 'file', size: 4, mtimeMs: 1, isLink: true, ...(opts?.resolve ? { realPath: 'D:/other/b.ts' } : {}) })
  const refused = await revertFile(elsewhere as any, WIN, moved.index, { turnId: 't1', key: moved.key }, 'turn', 'C:/q/b.ts')
  assert.deepEqual(refused, { ok: false, reason: 'changed-externally' })
  assert.equal(elsewhere.text('C:/q/b.ts'), 'new\n')
})

test('revertFile deletes a file Claude created', async () => {
  const host = actingHost()
  const { index, key } = await editedIndex(host, 'C:/p/new.ts', null, 'hello\n')
  const result = await revertFile(host as any, WIN, index, { turnId: 't1', key }, 'turn', 'C:/p/new.ts')
  assert.equal(result.ok, true)
  assert.equal(host.files.has('C:/p/new.ts'), false)
})

test('revertFile refuses when the file changed outside Claude and writes nothing', async () => {
  const host = actingHost()
  const { index, key } = await editedIndex(host, 'C:/p/a.ts', 'old\n', 'new\n')
  host.put('C:/p/a.ts', 'mine\n')
  const result = await revertFile(host as any, WIN, index, { turnId: 't1', key }, 'turn', 'C:/p/a.ts')
  assert.deepEqual(result, { ok: false, reason: 'changed-externally' })
  assert.equal(host.text('C:/p/a.ts'), 'mine\n')
})

test('revertFile reports io when the restore did not land', async () => {
  const host = fakeHost({ onRun: () => ({ exitCode: 1, stdout: '' }) })
  const { index, key } = await editedIndex(host, 'C:/p/new.ts', null, 'hello\n')
  const result = await revertFile(host as any, WIN, index, { turnId: 't1', key }, 'turn', 'C:/p/new.ts')
  // Marked: the restore ran, so a whole-turn revert stops here.
  assert.deepEqual(result, { ok: false, reason: 'io', afterWrite: true })
})

// ── revertTurn: a whole turn, file by file ──

// One turn that edited each file from its before (null: created) to its after.
async function turnIndex(host: ReturnType<typeof fakeHost>, files: Array<{ path: string; before: string | null; after: string; agentId?: string }>) {
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  const keyed: Array<{ turnId: string; key: string; path: string }> = []
  for (const [i, f] of files.entries()) {
    if (f.before !== null) host.put(f.path, f.before)
    const pre = await capture(host as any, STORE, f.path)
    host.put(f.path, f.after)
    const post = await capture(host as any, STORE, f.path)
    const key = await keyOf(host as any, f.path, 'windows')
    index = addEdit(index, { toolUseId: `tu${i}`, tool: 'Edit', via: 'tool', path: f.path, key, before: pre, after: post, startedAt: 1, at: 2, ...(f.agentId ? { agentId: f.agentId } : {}) })
    keyed.push({ turnId: 't1', key, path: f.path })
  }
  return { index, files: keyed }
}

// The index as the pane saves it after each landed revert.
function recorder(start: Index) {
  let index = start
  const recorded: string[] = []
  const record = async (file: { key: string; path: string }, outcome: { before: any; after: any; refs: any[] }) => {
    index = recordRevert(index, { key: file.key, path: file.path, before: outcome.before, after: outcome.after, refs: outcome.refs, at: 9 })
    recorded.push(file.path)
    return index
  }
  return { record, recorded, index: () => index }
}

test('revertTurn writes every revertible file and records each one', async () => {
  const host = actingHost()
  const { index, files } = await turnIndex(host, [
    { path: 'C:/p/a.ts', before: 'a1\n', after: 'a2\n' },
    { path: 'C:/p/b.ts', before: 'b1\n', after: 'b2\n' },
  ])
  const r = recorder(index)
  const result = await revertTurn(host as any, WIN, index, files, r.record)
  assert.deepEqual(result.reverted.map(x => x.file.path), ['C:/p/a.ts', 'C:/p/b.ts'])
  assert.deepEqual(r.recorded, ['C:/p/a.ts', 'C:/p/b.ts'])
  assert.equal(host.text('C:/p/a.ts'), 'a1\n')
  assert.equal(host.text('C:/p/b.ts'), 'b1\n')
  assert.equal(result.stopped, null)
  for (const f of files) assert.equal(fileStatus(r.index(), 't1', f.key), 'reverted')
})

test('revertTurn skips a file changed outside Claude and still writes the rest', async () => {
  const host = actingHost()
  const { index, files } = await turnIndex(host, [
    { path: 'C:/p/a.ts', before: 'a1\n', after: 'a2\n' },
    { path: 'C:/p/b.ts', before: 'b1\n', after: 'b2\n' },
  ])
  host.put('C:/p/a.ts', 'edited by hand\n')
  const r = recorder(index)
  const result = await revertTurn(host as any, WIN, index, files, r.record)
  assert.deepEqual(result.skipped.map(x => [x.file.path, x.outcome.reason]), [['C:/p/a.ts', 'changed-externally']])
  assert.deepEqual(result.reverted.map(x => x.file.path), ['C:/p/b.ts'])
  assert.equal(host.text('C:/p/a.ts'), 'edited by hand\n')
  assert.equal(host.text('C:/p/b.ts'), 'b1\n')
})

test('revertTurn deletes a file the turn created, and reverts a subagent\'s edit with the turn', async () => {
  const host = actingHost()
  const { index, files } = await turnIndex(host, [
    { path: 'C:/p/new.ts', before: null, after: 'hello\n' },
    { path: 'C:/p/b.ts', before: 'b1\n', after: 'b2\n', agentId: 'agent-1' },
  ])
  const result = await revertTurn(host as any, WIN, index, files, recorder(index).record)
  assert.equal(result.reverted.length, 2)
  assert.equal(host.text('C:/p/new.ts'), undefined)
  assert.equal(host.text('C:/p/b.ts'), 'b1\n')
})

test('revertTurn stops at a write that did not land and leaves the rest alone', async () => {
  let failing = false
  const host = actingHost({}, () => failing)
  const { index, files } = await turnIndex(host, [
    { path: 'C:/p/a.ts', before: 'a1\n', after: 'a2\n' },
    { path: 'C:/p/new.ts', before: null, after: 'x\n' },
    { path: 'C:/p/c.ts', before: 'c1\n', after: 'c2\n' },
  ])
  const r = recorder(index)
  const record = async (file: any, outcome: any) => {
    failing = true
    return r.record(file, outcome)
  }
  const result = await revertTurn(host as any, WIN, index, files, record)
  assert.deepEqual(result.reverted.map(x => x.file.path), ['C:/p/a.ts'])
  assert.equal(result.stopped?.path, 'C:/p/new.ts')
  assert.deepEqual(result.notTried.map(f => f.path), ['C:/p/c.ts'])
  assert.equal(host.text('C:/p/c.ts'), 'c2\n')
  assert.deepEqual(r.recorded, ['C:/p/a.ts'])
})

test('revertTurn restores a large file from git', async () => {
  let hashed = 'other'
  const host = fakeHost({
    onRun: ({ argv }) => {
      const sub = argv.slice(5).join(' ')
      if (sub.startsWith('restore')) {
        hashed = 'o1'
        return { exitCode: 0, stdout: '' }
      }
      if (sub.startsWith('hash-object')) return { exitCode: 0, stdout: hashed + '\n' }
      return { exitCode: 1, stdout: '' }
    },
  })
  host.put('C:/repo/big.bin', 'after\n')
  const post = await capture(host as any, STORE, 'C:/repo/big.bin')
  const key = 'c:/repo/big.bin'
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, { toolUseId: 'tu', tool: 'Write', via: 'tool', path: 'C:/repo/big.bin', key, before: { git: { oid: 'o1', commit: 'c1' } }, after: post, startedAt: 1, at: 2 })
  const ctx = { platform: 'windows' as const, store: STORE, root: 'C:/repo' }
  const result = await revertTurn(host as any, ctx, index, [{ turnId: 't1', key, path: 'C:/repo/big.bin', rel: 'big.bin' }], recorder(index).record)
  assert.deepEqual(result.reverted.map(x => x.outcome.after), [{ git: { oid: 'o1', commit: 'c1' } }])
})

test('planTurn writes nothing and says what each file would do', async () => {
  const host = actingHost()
  const { index, files } = await turnIndex(host, [
    { path: 'C:/p/a.ts', before: 'a1\n', after: 'a2\n' },
    { path: 'C:/p/b.ts', before: 'b1\n', after: 'b2\n' },
  ])
  host.put('C:/p/b.ts', 'edited by hand\n')
  const plans = await planTurn(host as any, WIN, index, files)
  assert.deepEqual(plans.map(p => (p.plan.ok ? 'ok' : p.plan.reason)), ['ok', 'changed-externally'])
  assert.equal(host.text('C:/p/a.ts'), 'a2\n')
})

test('revertFile verifies a git restore with hash-object', async () => {
  let hashed = 'other'
  const host = fakeHost({
    onRun: ({ argv }) => {
      const sub = argv.slice(5).join(' ')
      if (sub.startsWith('restore')) {
        hashed = 'o1'
        return { exitCode: 0, stdout: '' }
      }
      if (sub.startsWith('hash-object')) return { exitCode: 0, stdout: hashed + '\n' }
      return { exitCode: 1, stdout: '' }
    },
  })
  host.put('C:/repo/src/a.ts', 'changed by a script\n')
  const post = await capture(host as any, STORE, 'C:/repo/src/a.ts')
  const key = 'c:/repo/src/a.ts'
  let index = openTurn(emptyIndex(), { turnId: 't1', prompt: '', at: 1 })
  index = addEdit(index, { toolUseId: 'sh', tool: 'Bash', via: 'shell', path: 'C:/repo/src/a.ts', key, before: { git: { oid: 'o1', commit: 'c1' } }, after: post, startedAt: 1, at: 2 })
  const ctx = { platform: 'windows' as const, store: STORE, root: 'C:/repo' }
  const result = await revertFile(host as any, ctx, index, { turnId: 't1', key }, 'turn', 'C:/repo/src/a.ts', 'src/a.ts')
  assert.deepEqual(result.ok && result.refs, [{ turnId: 't1', key }])
  assert.deepEqual(result.ok && result.after, { git: { oid: 'o1', commit: 'c1' } })
})
