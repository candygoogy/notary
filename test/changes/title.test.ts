import { test } from 'node:test'
import assert from 'node:assert/strict'

import { turnTitle } from '../../plugins/changes/hooks/core/title.ts'

const sixty = 'a'.repeat(28) + ' ' + 'b'.repeat(31)

test('turnTitle keeps a short prompt whole, in quotes', () => {
  assert.equal(turnTitle('fix the parser'), '"fix the parser"')
})

test('turnTitle shows an empty prompt as empty quotes', () => {
  assert.equal(turnTitle(''), '""')
  assert.equal(turnTitle(' \n\t '), '""')
})

test('turnTitle keeps exactly 60 characters whole, with no ellipsis', () => {
  assert.equal(sixty.length, 60)
  assert.equal(turnTitle(sixty), `"${sixty}"`)
})

test('turnTitle cuts at the last word that fits and adds an ellipsis', () => {
  const prompt = 'Please read the README and the contributing guide first. Then end your turn with a summary.'
  assert.equal(turnTitle(prompt), '"Please read the README and the contributing guide first…"')
})

test('turnTitle keeps a word that ends right at 60 characters', () => {
  assert.equal(turnTitle(`${sixty} and more`), `"${sixty}…"`)
})

test('turnTitle cuts a long single word where it stands', () => {
  const word = 'x'.repeat(100)
  assert.equal(turnTitle(word), `"${'x'.repeat(60)}…"`)
  assert.equal(turnTitle(`go ${word}`), `"go ${'x'.repeat(57)}…"`)
})

test('turnTitle drops a comma, colon or full stop left at the cut', () => {
  const prompt = `${'w'.repeat(40)} first, second third fourth fifth sixth`
  assert.equal(turnTitle(prompt), `"${'w'.repeat(40)} first, second third…"`)
  assert.equal(turnTitle(`${'w'.repeat(50)} first: second third`), `"${'w'.repeat(50)} first…"`)
})

test('turnTitle puts a multi-line prompt on one line', () => {
  assert.equal(turnTitle('line one\r\nline two\n\n  line three'), '"line one line two line three"')
})

test('turnTitle shows quotes and backslashes as typed, never JSON escapes', () => {
  assert.equal(turnTitle('say "hi" to C:\\Users'), '"say "hi" to C:\\Users"')
})

test('turnTitle drops terminal escapes and other control characters', () => {
  assert.equal(turnTitle('\u001b[31mred\u001b[0m text\u0007'), '"red text"')
})

test('turnTitle counts non-ASCII letters as one character each', () => {
  const turkish = 'Şu dosyadaki hataları düzelt ve tüm testlerin geçtiğini doğrula lütfen'
  assert.equal(turnTitle(turkish), '"Şu dosyadaki hataları düzelt ve tüm testlerin geçtiğini…"')
  assert.equal(turnTitle('ğ'.repeat(60)), `"${'ğ'.repeat(60)}"`)
})

test('turnTitle never splits an emoji', () => {
  const title = turnTitle('😀'.repeat(70))
  assert.equal(title, `"${'😀'.repeat(60)}…"`)
})
