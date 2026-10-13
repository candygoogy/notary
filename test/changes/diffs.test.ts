import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fakeHost } from './fake-host.ts'
import { capture } from '../../plugins/changes/hooks/io/blobs.ts'
import { diffOf, MAX_DIFF_ROWS } from '../../plugins/changes/hooks/io/diffs.ts'

const STORE = 'C:/store'
const ctx = { store: STORE, root: 'C:/repo', platform: 'windows' as const }

async function stored(host: ReturnType<typeof fakeHost>, text: string | Uint8Array) {
  host.put('C:/tmp/x', text)
  return capture(host as any, STORE, 'C:/tmp/x')
}

test('a text change becomes drawable hunks with counts', async () => {
  const host = fakeHost()
  const view = await diffOf(host as any, ctx, { before: await stored(host, 'a\nb\n'), after: await stored(host, 'a\nc\n'), path: 'C:/repo/f.ts' }, false)
  assert.deepEqual(view, { kind: 'diff', hunks: '@@ -1,2 +1,2 @@\n a\n-b\n+c', added: 1, removed: 1, shownRows: 3, totalRows: 3 })
})

test('a new file diffs against nothing', async () => {
  const host = fakeHost()
  const view = await diffOf(host as any, ctx, { before: { absent: true }, after: await stored(host, 'x\n'), path: 'C:/repo/n.ts' }, false)
  assert.equal(view.kind === 'diff' && view.hunks, '@@ -0,0 +1,1 @@\n+x')
})

test('a long diff shows its first rows unless asked for all', async () => {
  const host = fakeHost()
  const many = Array.from({ length: MAX_DIFF_ROWS + 50 }, (_, i) => `l${i}\n`).join('')
  const file = { before: { absent: true } as const, after: await stored(host, many), path: 'C:/repo/big.ts' }
  const cut = await diffOf(host as any, ctx, file, false)
  assert.equal(cut.kind === 'diff' && cut.shownRows, MAX_DIFF_ROWS)
  assert.equal(cut.kind === 'diff' && cut.totalRows, MAX_DIFF_ROWS + 50)
  const all = await diffOf(host as any, ctx, file, true)
  assert.equal(all.kind === 'diff' && all.shownRows, MAX_DIFF_ROWS + 50)
  assert.equal(all.kind === 'diff' && all.totalRows, MAX_DIFF_ROWS + 50)
})

test('a git before is read through git with its filters', async () => {
  const host = fakeHost({
    onRun: ({ argv }) => (argv.includes('cat-file') && argv.includes('c1:src/f.ts') ? { exitCode: 0, stdout: 'a\r\nb\r\n' } : { exitCode: 1, stdout: '' }),
  })
  const view = await diffOf(host as any, ctx, { before: { git: { oid: 'o', commit: 'c1' } }, after: await stored(host, 'a\r\nc\r\n'), path: 'C:/repo/src/f.ts' }, false)
  assert.equal(view.kind === 'diff' && view.hunks, '@@ -1,2 +1,2 @@\n a\n-b\n+c')
})

test('binary, unreadable and unsaved sides are notes', async () => {
  const host = fakeHost()
  const bin = await stored(host, Uint8Array.of(0, 1, 2))
  const text = await stored(host, 't\n')
  const note = async (before: any) => {
    const view = await diffOf(host as any, ctx, { before, after: text, path: 'C:/repo/f' }, false)
    return view.kind === 'note' ? view.text : 'diff'
  }
  assert.equal(await note(bin), 'binary file')
  assert.equal(await note({ unreadable: 'too-large' }), 'too large to show')
  assert.equal(await note({ unreadable: 'io' }), 'no saved copy to compare')
  assert.equal(await note({ hash: 'missing', size: 1, kind: 'text', eol: 'lf', bom: false }), 'no saved copy to compare')
  assert.equal(await note({ hash: 'h', size: 2_000_000, kind: 'text', eol: 'lf', bom: false }), 'too large to show')
})

test('a line-endings-only change is flagged with no hunks', async () => {
  const host = fakeHost()
  const view = await diffOf(host as any, ctx, { before: await stored(host, 'a\r\n'), after: await stored(host, 'a\n'), path: 'C:/repo/f' }, false)
  assert.deepEqual(view, { kind: 'diff', hunks: '', added: 0, removed: 0, shownRows: 0, totalRows: 0, eolOnly: true })
})
