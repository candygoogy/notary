import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sameContent, type Content } from '../../plugins/changes/hooks/core/model.ts'

const text = (hash: string): Content => ({ hash, size: 1, kind: 'text', eol: 'lf', bom: false })

test('sameContent compares hashes, git blobs and absence', () => {
  assert.equal(sameContent(text('a'), text('a')), true)
  assert.equal(sameContent(text('a'), text('b')), false)
  assert.equal(sameContent({ git: { oid: 'o', commit: 'c' } }, { git: { oid: 'o', commit: 'd' } }), true)
  assert.equal(sameContent({ absent: true }, { absent: true }), true)
  assert.equal(sameContent({ absent: true }, text('a')), false)
})

test('sameContent cannot tell a git blob from a hash', () => {
  assert.equal(sameContent({ git: { oid: 'o', commit: 'c' } }, text('a')), null)
})

test('review #5: absent against unreadable is unknown, not different', () => {
  assert.equal(sameContent({ absent: true }, { unreadable: 'io' }), null)
  assert.equal(sameContent({ unreadable: 'too-large' }, { absent: true }), null)
  assert.equal(sameContent({ unreadable: 'io' }, text('a')), null)
})
