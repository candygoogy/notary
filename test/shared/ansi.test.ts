import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeNewlines, stripAnsi } from '../../shared/ansi.ts'

test('stripAnsi removes color codes', () => {
  assert.equal(stripAnsi('\u001b[31m1 failed\u001b[0m'), '1 failed')
})

test('stripAnsi removes OSC hyperlinks', () => {
  assert.equal(stripAnsi('\u001b]8;;https://x\u0007link\u001b]8;;\u0007'), 'link')
})

test('normalizeNewlines turns CRLF and CR into LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n')
})
