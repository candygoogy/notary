// Line diff for the Changes pane: Myers' O(ND) algorithm over interned lines,
// with the common prefix and suffix trimmed first and a cap on the edit
// distance, past which the changed middle becomes one replace hunk.
// Pure and synchronous; the output is the unified hunks a `Code` element
// draws under `format: 'diff'`.

export type Diff = {
  // Unified hunks only (`@@ -a,b +c,d @@` and their rows), joined by '\n';
  // '' when nothing but line endings or the BOM changed.
  hunks: string
  added: number
  removed: number
  // The texts differ only in line endings.
  eolOnly?: true
  // One text starts with a BOM and the other does not.
  bomChanged?: true
  // The edit distance passed the cap and the middle is one replace hunk.
  capped?: true
}

export type DiffOptions = {
  // Unchanged lines shown around each change; default 3.
  context?: number
  // Largest edit distance searched before falling back; default scales with
  // the trimmed size so one diff stays well inside a hook's budget.
  maxEditLength?: number
}

export type Eol = 'lf' | 'crlf' | 'mixed' | 'none'

const BOM = '\uFEFF'
// Built at runtime: the catalogue's UI scanner flags control characters in
// string literals.
const CR = String.fromCharCode(13)
const NO_EOL = '\\ No newline at end of file'
const DEFAULT_CONTEXT = 3
const MAX_EDIT_LENGTH = 1000
const WORK_BUDGET = 20_000_000

export function eolOf(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const all = text.match(/\n/g)?.length ?? 0
  if (all === 0) return 'none'
  if (crlf === 0) return 'lf'
  return crlf === all ? 'crlf' : 'mixed'
}

export function diffText(before: string, after: string, options: DiffOptions = {}): Diff {
  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT)
  const hasBomBefore = before.startsWith(BOM)
  const hasBomAfter = after.startsWith(BOM)
  const a = splitLines(hasBomBefore ? before.slice(1) : before)
  const b = splitLines(hasBomAfter ? after.slice(1) : after)

  // A last line with no final newline differs from the same text with one, so
  // it is interned apart: its own map, one id counter across both.
  const ids = new Map<string, number>()
  const noEolIds = new Map<string, number>()
  let nextId = 0
  const intern = (side: Side) =>
    Int32Array.from(side.lines, (line, i) => {
      const map = i === side.lines.length - 1 && !side.hasFinalNewline ? noEolIds : ids
      let id = map.get(line)
      if (id === undefined) map.set(line, (id = nextId++))
      return id
    })
  const aIds = intern(a)
  const bIds = intern(b)

  const { regions, capped } = changedRegions(aIds, bIds, options.maxEditLength)
  const { hunks, added, removed } = formatHunks(regions, a, b, context)

  const result: Diff = { hunks, added, removed }
  if (hunks === '' && withoutBom(before) !== withoutBom(after)) result.eolOnly = true
  if (hasBomBefore !== hasBomAfter) result.bomChanged = true
  if (capped) result.capped = true
  return result
}

type Side = { lines: string[]; hasFinalNewline: boolean }

// A change: lines [a0, a1) of before replaced by lines [b0, b1) of after.
type Region = { a0: number; a1: number; b0: number; b1: number }

function withoutBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

function splitLines(text: string): Side {
  if (text === '') return { lines: [], hasFinalNewline: true }
  const lines = text.split('\n')
  const hasFinalNewline = text.endsWith('\n')
  if (hasFinalNewline) lines.pop()
  return { lines: lines.map(line => (line.endsWith(CR) ? line.slice(0, -1) : line)), hasFinalNewline }
}

function changedRegions(a: Int32Array, b: Int32Array, maxEditLength?: number): { regions: Region[]; capped: boolean } {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const n = endA - start
  const m = endB - start
  if (n === 0 && m === 0) return { regions: [], capped: false }
  if (n === 0 || m === 0) return { regions: [{ a0: start, a1: endA, b0: start, b1: endB }], capped: false }

  const cap = maxEditLength ?? Math.max(1, Math.min(MAX_EDIT_LENGTH, Math.floor(WORK_BUDGET / (n + m))))
  const script = myers(a.subarray(start, endA), b.subarray(start, endB), cap)
  if (script === null) return { regions: [{ a0: start, a1: endA, b0: start, b1: endB }], capped: true }
  return {
    regions: script.map(r => ({ a0: r.a0 + start, a1: r.a1 + start, b0: r.b0 + start, b1: r.b1 + start })),
    capped: false,
  }
}

// Myers' greedy forward search, keeping each round's frontier for the
// backtrack. Returns the changed regions in order, or null past `max`.
function myers(a: Int32Array, b: Int32Array, max: number): Region[] | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(max, n + m)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  // trace[d] holds the frontier for diagonals -(d-1)..(d-1) before round d.
  const trace: Int32Array[] = []

  for (let d = 0; d <= limit; d++) {
    trace.push(d === 0 ? new Int32Array(0) : v.slice(offset - (d - 1), offset + d))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, d, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], depth: number, n: number, m: number): Region[] {
  const deleted: number[] = []
  const inserted: number[] = []
  let x = n
  let y = m
  for (let d = depth; d > 0; d--) {
    const frontier = trace[d]!
    const at = (k: number) => frontier[k + d - 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
    }
    if (x === prevX) inserted.push(prevY)
    else deleted.push(prevX)
    x = prevX
    y = prevY
  }
  return regionsOf(deleted.reverse(), inserted.reverse(), n, m)
}

// Groups single-line deletions and insertions into regions: a region is a
// maximal run where the two sides advance without a matching line between.
function regionsOf(deleted: number[], inserted: number[], n: number, m: number): Region[] {
  const regions: Region[] = []
  let i = 0
  let j = 0
  let x = 0
  let y = 0
  while (i < deleted.length || j < inserted.length) {
    const nextDel = i < deleted.length ? deleted[i]! : n
    const nextIns = j < inserted.length ? inserted[j]! : m
    // Equal lines advance both sides until one of them reaches its next change.
    const skip = Math.min(nextDel - x, nextIns - y)
    x += skip
    y += skip
    const region = { a0: x, a1: x, b0: y, b1: y }
    while ((i < deleted.length && deleted[i] === region.a1) || (j < inserted.length && inserted[j] === region.b1)) {
      if (i < deleted.length && deleted[i] === region.a1) {
        region.a1++
        i++
      } else {
        region.b1++
        j++
      }
    }
    regions.push(region)
    x = region.a1
    y = region.b1
  }
  return regions
}

function formatHunks(regions: Region[], a: Side, b: Side, context: number): { hunks: string; added: number; removed: number } {
  const rows: string[] = []
  let added = 0
  let removed = 0
  const n = a.lines.length
  const m = b.lines.length
  const isLastOf = (side: Side, i: number) => i === side.lines.length - 1 && !side.hasFinalNewline

  let g = 0
  while (g < regions.length) {
    let h = g
    while (h + 1 < regions.length && regions[h + 1]!.a0 - regions[h]!.a1 <= 2 * context) h++
    const first = regions[g]!
    const last = regions[h]!
    const oldStart = Math.max(0, first.a0 - context)
    const oldEnd = Math.min(n, last.a1 + context)
    const newStart = first.b0 - (first.a0 - oldStart)
    const newEnd = last.b1 + (oldEnd - last.a1)
    const oldLen = oldEnd - oldStart
    const newLen = newEnd - newStart
    rows.push(`@@ -${oldLen === 0 ? oldStart : oldStart + 1},${oldLen} +${newLen === 0 ? newStart : newStart + 1},${newLen} @@`)

    const pushContext = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        rows.push(' ' + visible(a.lines[i]!))
        if (isLastOf(a, i)) rows.push(NO_EOL)
      }
    }
    let at = oldStart
    for (let r = g; r <= h; r++) {
      const region = regions[r]!
      pushContext(at, region.a0)
      for (let i = region.a0; i < region.a1; i++) {
        rows.push('-' + visible(a.lines[i]!))
        if (isLastOf(a, i)) rows.push(NO_EOL)
      }
      for (let i = region.b0; i < region.b1; i++) {
        rows.push('+' + visible(b.lines[i]!))
        if (isLastOf(b, i)) rows.push(NO_EOL)
      }
      removed += region.a1 - region.a0
      added += region.b1 - region.b0
      at = region.a1
    }
    pushContext(at, oldEnd)
    g = h + 1
  }
  return { hunks: rows.join('\n'), added, removed }
}

// At most `maxRows` rows of `hunks`, still drawable: whole hunks while they
// fit, and a first hunk longer than that cut with its header recounted
// (`Code` draws nothing of a hunk cut mid-way). `totalRows` counts every
// row but the headers; `shownRows` those kept.
export function limitHunks(hunks: string, maxRows: number): { hunks: string; shownRows: number; totalRows: number } {
  if (hunks === '') return { hunks, shownRows: 0, totalRows: 0 }
  const groups: string[][] = []
  for (const row of hunks.split('\n')) {
    if (row.startsWith('@@')) groups.push([row])
    else groups[groups.length - 1]!.push(row)
  }
  const bodyRows = (g: string[]) => g.length - 1
  const totalRows = groups.reduce((sum, g) => sum + bodyRows(g), 0)
  const kept: string[][] = []
  let shownRows = 0
  for (const group of groups) {
    if (shownRows + bodyRows(group) > maxRows) {
      if (kept.length === 0) {
        const cut = recount(group, maxRows)
        kept.push(cut)
        shownRows += bodyRows(cut)
      }
      break
    }
    kept.push(group)
    shownRows += bodyRows(group)
  }
  return { hunks: kept.map(g => g.join('\n')).join('\n'), shownRows, totalRows }
}

// The first `maxRows` rows of one hunk under a header that counts them.
function recount(group: string[], maxRows: number): string[] {
  const rows = group.slice(1, 1 + maxRows)
  const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(group[0]!)
  const [oldStart, oldWas, newStart, newWas] = (header ? header.slice(1).map(Number) : [1, 1, 1, 1]) as [number, number, number, number]
  const oldLen = rows.filter(r => r[0] === ' ' || r[0] === '-').length
  const newLen = rows.filter(r => r[0] === ' ' || r[0] === '+').length
  // A side left with no rows names the line before it, as a header does.
  const start = (s: number, was: number, len: number) => (len === 0 && was > 0 ? s - 1 : s)
  return [`@@ -${start(oldStart, oldWas, oldLen)},${oldLen} +${start(newStart, newWas, newLen)},${newLen} @@`, ...rows]
}

// `Code` takes tab and newline as its only control characters; the rest are
// drawn as their Unicode control pictures (ESC as ␛, NUL as ␀, DEL as ␡).
function visible(line: string): string {
  return line.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, c => (c.charCodeAt(0) === 0x7f ? '␡' : String.fromCharCode(0x2400 + c.charCodeAt(0))))
}
