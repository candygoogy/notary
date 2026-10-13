import { test } from 'node:test'
import assert from 'node:assert/strict'

import { base64FromBytes, bytesFromBase64, describe } from '../../plugins/changes/hooks/core/content.ts'

const utf8 = (text: string) => new TextEncoder().encode(text)

test('plain LF text is text with lf endings and no BOM', () => {
  assert.deepEqual(describe(utf8('a\nb\n')), { kind: 'text', text: 'a\nb\n', size: 4, eol: 'lf', bom: false })
})

test('CRLF, mixed and no line endings are told apart', () => {
  assert.equal(describe(utf8('a\r\nb\r\n')).eol, 'crlf')
  assert.equal(describe(utf8('a\r\nb\n')).eol, 'mixed')
  assert.equal(describe(utf8('one line')).eol, 'none')
})

test('the BOM is kept in the text so a write gives the same bytes back', () => {
  const meta = describe(Uint8Array.of(0xef, 0xbb, 0xbf, 0x78, 0x0a))
  assert.deepEqual(meta, { kind: 'text', text: '﻿x\n', size: 5, eol: 'lf', bom: true })
})

test('the BOM is kept even by a decoder that drops it, as the mod runtime\'s does', () => {
  const dropsBom = new TextDecoder('utf-8', { fatal: true })
  const meta = describe(Uint8Array.of(0xef, 0xbb, 0xbf, 0x78, 0x0a), dropsBom)
  assert.deepEqual(meta, { kind: 'text', text: '﻿x\n', size: 5, eol: 'lf', bom: true })
})

test('a file that is only a BOM keeps it', () => {
  assert.deepEqual(describe(Uint8Array.of(0xef, 0xbb, 0xbf), new TextDecoder('utf-8', { fatal: true })), {
    kind: 'text',
    text: '﻿',
    size: 3,
    eol: 'none',
    bom: true,
  })
})

test('an empty file is empty text', () => {
  assert.deepEqual(describe(new Uint8Array(0)), { kind: 'text', text: '', size: 0, eol: 'none', bom: false })
})

test('non-ASCII UTF-8 is text', () => {
  const meta = describe(utf8('çay ☕ 茶\n'))
  assert.equal(meta.kind, 'text')
  assert.equal(meta.kind === 'text' && meta.text, 'çay ☕ 茶\n')
})

test('a NUL byte in the first 8 KB makes it binary', () => {
  assert.deepEqual(describe(Uint8Array.of(0x50, 0x4b, 0x00, 0x03)), { kind: 'binary', size: 4 })
})

test('a NUL byte past the first 8 KB does not', () => {
  const bytes = new Uint8Array(9000).fill(0x61)
  bytes[8500] = 0
  assert.equal(describe(bytes).kind, 'text')
})

test('invalid UTF-8 is binary', () => {
  assert.deepEqual(describe(Uint8Array.of(0x61, 0xff, 0x62)), { kind: 'binary', size: 3 })
})

test('Latin-1 text is binary, since a text write would change its bytes', () => {
  assert.equal(describe(Uint8Array.of(0x63, 0xe7, 0x61, 0x79)).kind, 'binary')
})

test('UTF-16 with a BOM is binary', () => {
  assert.equal(describe(Uint8Array.of(0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00)).kind, 'binary')
})

test('base64 round-trips every byte value and matches Node', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
  const encoded = base64FromBytes(bytes)
  assert.equal(encoded, Buffer.from(bytes).toString('base64'))
  assert.deepEqual(bytesFromBase64(encoded), bytes)
})

test('base64 of empty and short inputs matches Node', () => {
  for (const length of [0, 1, 2, 3, 4, 5]) {
    const bytes = Uint8Array.from({ length }, (_, i) => 250 - i)
    assert.equal(base64FromBytes(bytes), Buffer.from(bytes).toString('base64'))
    assert.deepEqual(bytesFromBase64(base64FromBytes(bytes)), bytes)
  }
})

test('base64 of a large input stays fast', () => {
  const bytes = new Uint8Array(4 * 1024 * 1024).map((_, i) => i & 0xff)
  const started = performance.now()
  assert.deepEqual(bytesFromBase64(base64FromBytes(bytes)), bytes)
  assert.ok(performance.now() - started < 3000)
})

test('review #9: base64 with characters outside the alphabet throws', () => {
  assert.throws(() => bytesFromBase64('QUJD!'))
  assert.throws(() => bytesFromBase64('QU JD'))
  assert.throws(() => bytesFromBase64('Q=JD'))
  assert.throws(() => bytesFromBase64('QUJDR'))
  assert.deepEqual(bytesFromBase64('QUI='), new TextEncoder().encode('AB'))
})
