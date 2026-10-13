import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diffText, eolOf, limitHunks } from '../../plugins/changes/hooks/core/diff.ts'

const NO_EOL = '\\ No newline at end of file'

const lines = (...xs: string[]) => xs.join('\n')
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
const file = (xs: string[]) => xs.map(x => x + '\n').join('')

// Applies unified hunks to `before` and returns the resulting lines and final
// newline flag, checking every context and removed line against `before`, so
// a wrong header, a misplaced line or a wrong marker fails the test.
function apply(before: string, hunks: string): { lines: string[]; hasFinalNewline: boolean } {
  const source = splitForTest(before)
  if (hunks === '') return source
  const out: string[] = []
  // Per output line: whether it ends without a newline.
  const noEol: boolean[] = []
  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      out.push(source.lines[i])
      noEol.push(i === source.lines.length - 1 && !source.hasFinalNewline)
    }
  }
  let at = 0

  const rows = hunks.split('\n')
  let i = 0
  let lastMark = ''
  while (i < rows.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(rows[i])
    assert.ok(header, `expected a hunk header, got ${JSON.stringify(rows[i])}`)
    const [oldStart, oldLen, newStart, newLen] = header.slice(1).map(Number)
    const from = oldLen === 0 ? oldStart : oldStart - 1
    assert.ok(from >= at, 'hunks overlap or go backwards')
    copy(at, from)
    at = from
    const outStart = out.length
    let seenOld = 0
    i++
    while (i < rows.length && !rows[i].startsWith('@@')) {
      const row = rows[i]
      if (row === NO_EOL) {
        assert.ok(lastMark !== '', 'a marker with no line before it')
        if (lastMark !== '-') noEol[noEol.length - 1] = true
        i++
        continue
      }
      const mark = row[0]
      const text = row.slice(1)
      assert.ok(mark === ' ' || mark === '-' || mark === '+', `bad row ${JSON.stringify(row)}`)
      if (mark === ' ' || mark === '-') {
        assert.equal(text, source.lines[at], `line ${at + 1} of before does not match the hunk`)
        at++
        seenOld++
      }
      if (mark === ' ' || mark === '+') {
        out.push(text)
        noEol.push(false)
      }
      lastMark = mark
      i++
    }
    assert.equal(seenOld, oldLen, 'old length in header')
    assert.equal(out.length - outStart, newLen, 'new length in header')
    assert.equal(newLen === 0 ? newStart : newStart - 1, outStart, 'new start in header')
  }
  copy(at, source.lines.length)
  assert.ok(noEol.slice(0, -1).every(x => !x), 'only the last line may lack a newline')
  return { lines: out, hasFinalNewline: out.length === 0 || !noEol[noEol.length - 1] }
}

function splitForTest(text: string): { lines: string[]; hasFinalNewline: boolean } {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  if (body === '') return { lines: [], hasFinalNewline: true }
  const parts = body.split('\n').map(x => x.replace(/\r$/, ''))
  const hasFinalNewline = body.endsWith('\n')
  if (hasFinalNewline) parts.pop()
  return { lines: parts, hasFinalNewline }
}

test('identical texts give no hunks and no flags', () => {
  assert.deepEqual(diffText('a\nb\n', 'a\nb\n'), { hunks: '', added: 0, removed: 0 })
})

test('two empty texts give no hunks', () => {
  assert.deepEqual(diffText('', ''), { hunks: '', added: 0, removed: 0 })
})

test('a new file is one all-added hunk from 0,0', () => {
  assert.deepEqual(diffText('', 'a\nb\n'), {
    hunks: lines('@@ -0,0 +1,2 @@', '+a', '+b'),
    added: 2,
    removed: 0,
  })
})

test('emptying a file is one all-removed hunk to 0,0', () => {
  assert.deepEqual(diffText('a\nb\n', ''), {
    hunks: lines('@@ -1,2 +0,0 @@', '-a', '-b'),
    added: 0,
    removed: 2,
  })
})

test('a change in the middle gets three lines of context each side', () => {
  const before = numbered(10)
  const after = [...before]
  after[4] = 'changed'
  assert.equal(
    diffText(file(before), file(after)).hunks,
    lines('@@ -2,7 +2,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+changed', ' line 6', ' line 7', ' line 8'),
  )
})

test('a change on the first line has context only after it', () => {
  const before = numbered(10)
  const after = ['first', ...before.slice(1)]
  assert.equal(
    diffText(file(before), file(after)).hunks,
    lines('@@ -1,4 +1,4 @@', '-line 1', '+first', ' line 2', ' line 3', ' line 4'),
  )
})

test('an insertion at the end has context only before it', () => {
  const before = numbered(5)
  assert.equal(
    diffText(file(before), file([...before, 'tail'])).hunks,
    lines('@@ -3,3 +3,4 @@', ' line 3', ' line 4', ' line 5', '+tail'),
  )
})

test('changes more than six lines apart are separate hunks', () => {
  const before = numbered(20)
  const after = [...before]
  after[1] = 'two'
  after[15] = 'sixteen'
  const { hunks } = diffText(file(before), file(after))
  assert.equal(hunks.split('\n').filter(r => r.startsWith('@@')).length, 2)
  assert.match(hunks, /^@@ -1,5 \+1,5 @@/)
  assert.match(hunks, /\n@@ -13,7 \+13,7 @@\n/)
})

test('changes six or fewer lines apart share one hunk', () => {
  const before = numbered(20)
  const after = [...before]
  after[4] = 'five'
  after[11] = 'twelve'
  const { hunks } = diffText(file(before), file(after))
  assert.equal(hunks.split('\n').filter(r => r.startsWith('@@')).length, 1)
  assert.match(hunks, /^@@ -2,14 \+2,14 @@/)
})

test('a replaced block lists removals before additions', () => {
  assert.equal(
    diffText('a\nb\nc\nd\n', 'a\nx\ny\nd\n').hunks,
    lines('@@ -1,4 +1,4 @@', ' a', '-b', '-c', '+x', '+y', ' d'),
  )
})

test('the edit script is minimal', () => {
  const result = diffText('a\nb\nc\na\nb\nb\na\n', 'c\nb\na\nb\na\nc\n')
  assert.equal(result.added + result.removed, 5)
})

test('a last line without a newline is marked on both sides', () => {
  assert.equal(
    diffText('a\nb', 'a\nc').hunks,
    lines('@@ -1,2 +1,2 @@', ' a', '-b', NO_EOL, '+c', NO_EOL),
  )
})

test('adding the final newline shows the last line as changed', () => {
  assert.deepEqual(diffText('a', 'a\n'), {
    hunks: lines('@@ -1,1 +1,1 @@', '-a', NO_EOL, '+a'),
    added: 1,
    removed: 1,
  })
})

test('an unchanged last line without a newline is marked as context', () => {
  assert.equal(
    diffText('a\nb\nc', 'x\nb\nc').hunks,
    lines('@@ -1,3 +1,3 @@', '-a', '+x', ' b', ' c', NO_EOL),
  )
})

test('CRLF files diff by content and hunks carry no carriage returns', () => {
  assert.equal(diffText('a\r\nb\r\n', 'a\r\nc\r\n').hunks, lines('@@ -1,2 +1,2 @@', ' a', '-b', '+c'))
})

test('a change of line endings alone is eolOnly with no hunks', () => {
  assert.deepEqual(diffText('a\r\nb\r\n', 'a\nb\n'), { hunks: '', added: 0, removed: 0, eolOnly: true })
})

test('a change of one line ending alone is eolOnly', () => {
  assert.deepEqual(diffText('a\nb\n', 'a\r\nb\n'), { hunks: '', added: 0, removed: 0, eolOnly: true })
})

test('a removed BOM is bomChanged with no hunks', () => {
  assert.deepEqual(diffText('﻿a\n', 'a\n'), { hunks: '', added: 0, removed: 0, bomChanged: true })
})

test('a BOM change does not hide a content change', () => {
  assert.deepEqual(diffText('a\n', '﻿b\n'), {
    hunks: lines('@@ -1,1 +1,1 @@', '-a', '+b'),
    added: 1,
    removed: 1,
    bomChanged: true,
  })
})

test('context can be set to zero', () => {
  const before = numbered(10)
  const after = [...before]
  after[4] = 'changed'
  assert.equal(diffText(file(before), file(after), { context: 0 }).hunks, lines('@@ -5,1 +5,1 @@', '-line 5', '+changed'))
})

test('a pure insertion with zero context names the line it follows', () => {
  assert.equal(diffText('a\nb\n', 'a\nx\nb\n', { context: 0 }).hunks, lines('@@ -1,0 +2,1 @@', '+x'))
})

test('past the edit-distance cap the changed middle becomes one replace hunk', () => {
  const before = file(['head', 'a1', 'a2', 'a3', 'a4', 'tail'])
  const after = file(['head', 'b1', 'b2', 'b3', 'b4', 'tail'])
  assert.deepEqual(diffText(before, after, { maxEditLength: 2 }), {
    hunks: lines('@@ -1,6 +1,6 @@', ' head', '-a1', '-a2', '-a3', '-a4', '+b1', '+b2', '+b3', '+b4', ' tail'),
    added: 4,
    removed: 4,
    capped: true,
  })
})

test('the cap is not hit when the distance is within it', () => {
  const result = diffText('a\nb\n', 'a\nc\n', { maxEditLength: 2 })
  assert.equal(result.capped, undefined)
})

test('control characters are drawn as control pictures', () => {
  assert.equal(diffText('a\n', 'b\u001b[0m\u0000\u007f\tc\n').hunks, lines('@@ -1,1 +1,1 @@', '-a', '+b␛[0m␀␡\tc'))
})

test('a lone carriage return inside a line is drawn as a control picture', () => {
  assert.equal(diffText('a\n', 'a\rb\n').hunks, lines('@@ -1,1 +1,1 @@', '-a', '+a␍b'))
})

test('eolOf names the line-ending style', () => {
  assert.equal(eolOf(''), 'none')
  assert.equal(eolOf('one line'), 'none')
  assert.equal(eolOf('a\nb\n'), 'lf')
  assert.equal(eolOf('a\r\nb\r\n'), 'crlf')
  assert.equal(eolOf('a\r\nb\n'), 'mixed')
})

test('a large file with one change diffs quickly through trimming', () => {
  const before = numbered(200_000)
  const after = [...before]
  after[100_000] = 'changed'
  const started = performance.now()
  const result = diffText(file(before), file(after))
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.ok(performance.now() - started < 2000)
})

test('an unrelated large rewrite falls back under the default cap in bounded time', () => {
  const before = Array.from({ length: 50_000 }, (_, i) => `a${i}`)
  const after = Array.from({ length: 50_000 }, (_, i) => `b${i}`)
  const started = performance.now()
  const result = diffText(file(before), file(after))
  assert.equal(result.capped, true)
  assert.equal(result.added, 50_000)
  assert.equal(result.removed, 50_000)
  assert.ok(performance.now() - started < 3000)
})

// Property: for random texts, applying the hunks to `before` gives `after`,
// and the counts match the rows.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomText(next: () => number, eol: string): string {
  const count = Math.floor(next() * 12)
  const rows = Array.from({ length: count }, () => 'abcde'[Math.floor(next() * 5)])
  const body = rows.join(eol)
  return count > 0 && next() < 0.7 ? body + eol : body
}

test('property: applying the hunks to before gives after', () => {
  const next = rng(42)
  for (let round = 0; round < 3000; round++) {
    const before = randomText(next, next() < 0.5 ? '\n' : '\r\n')
    const after = randomText(next, next() < 0.5 ? '\n' : '\r\n')
    const context = Math.floor(next() * 4)
    const maxEditLength = next() < 0.2 ? Math.floor(next() * 4) : undefined
    const result = diffText(before, after, { context, maxEditLength })
    const applied = apply(before, result.hunks)
    const expected = splitForTest(after)
    const label = JSON.stringify({ before, after, context, maxEditLength, hunks: result.hunks })
    assert.deepEqual(applied.lines, expected.lines, label)
    if (expected.lines.length > 0) assert.equal(applied.hasFinalNewline, expected.hasFinalNewline, label)
    const rows = result.hunks.split('\n')
    assert.equal(result.added, rows.filter(r => r.startsWith('+')).length, label)
    assert.equal(result.removed, rows.filter(r => r.startsWith('-')).length, label)
  }
})

test('review #6: a last line without a newline never matches a line ending in NUL', () => {
  const result = diffText('x', 'x\u0000\n')
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
})

// ── limitHunks ──

test('limitHunks keeps whole hunks while they fit', () => {
  const before = numbered(40)
  const after = [...before]
  after[2] = 'x'
  after[30] = 'y'
  const { hunks } = diffText(file(before), file(after))
  const limited = limitHunks(hunks, 8)
  assert.equal(limited.totalRows, 15)
  assert.equal(limited.shownRows, 7)
  assert.equal(limited.hunks.split('\n').filter(r => r.startsWith('@@')).length, 1)
  assert.deepEqual(apply(file(before), limited.hunks).lines.slice(0, 5), ['line 1', 'line 2', 'x', 'line 4', 'line 5'])
})

test('limitHunks cuts an oversized first hunk and recounts its header', () => {
  const after = Array.from({ length: 10 }, (_, i) => `n${i}`)
  const { hunks } = diffText('', file(after))
  const limited = limitHunks(hunks, 4)
  assert.equal(limited.hunks.split('\n')[0], '@@ -0,0 +1,4 @@')
  assert.equal(limited.shownRows, 4)
  assert.equal(limited.totalRows, 10)
  assert.deepEqual(apply('', limited.hunks).lines, ['n0', 'n1', 'n2', 'n3'])
})

test('limitHunks of a removal-only cut keeps a drawable header', () => {
  const before = Array.from({ length: 10 }, (_, i) => `o${i}`)
  const limited = limitHunks(diffText(file(before), '').hunks, 3)
  assert.equal(limited.hunks.split('\n')[0], '@@ -1,3 +0,0 @@')
})

test('limitHunks of nothing is nothing', () => {
  assert.deepEqual(limitHunks('', 400), { hunks: '', shownRows: 0, totalRows: 0 })
})
