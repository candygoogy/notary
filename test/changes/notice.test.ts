import { test } from 'node:test'
import assert from 'node:assert/strict'

import { revertAllNotice, revertAllPlanNotice, revertNotice } from '../../plugins/changes/hooks/ui/notice.ts'

const name = (id: string) => `#${id.slice(1)}`
const text = { hash: 'h', size: 1, kind: 'text' as const, eol: 'lf' as const, bom: false }

test('a landed revert names every turn it undid', () => {
  const outcome = { ok: true as const, refs: [{ turnId: 't12', key: 'k' }, { turnId: 't14', key: 'k' }], before: text, after: text }
  assert.equal(revertNotice(outcome, 'src/a.ts', name), 'Reverted src/a.ts (#12, #14).')
})

test('an earlier revert is "your earlier revert", never a turn id', () => {
  const notice = revertNotice({ ok: false, reason: 'user-changed-between', between: ['revert', 't14'] }, 'a.ts', name)
  assert.equal(notice, 'a.ts was changed outside Claude between your earlier revert and #14. Reverting also undoes that change.')
})

test('trimmed history and unverifiable links do not blame the person', () => {
  const trimmed = revertNotice({ ok: false, reason: 'history-trimmed', between: ['t1', 't2'] }, 'a.ts', name)
  const unverifiable = revertNotice({ ok: false, reason: 'unverifiable-link', between: ['t1', 't2'] }, 'a.ts', name)
  for (const notice of [trimmed, unverifiable]) assert.doesNotMatch(notice, /outside Claude|you /)
})

test('every refusal has its own words', () => {
  const reasons = ['changed-externally', 'too-large', 'no-snapshot', 'already-reverted', 'nothing-to-revert', 'io'] as const
  const notices = reasons.map(reason => revertNotice({ ok: false, reason }, 'a.ts', name))
  assert.equal(new Set(notices).size, reasons.length)
  assert.match(revertNotice({ ok: false, reason: 'changed-since', otherTurns: ['t3', 't4'] }, 'a.ts', name), /#3, #4/)
})

test('Revert all says how many files it reverted and why each skipped one was left', () => {
  const notice = revertAllNotice(
    {
      turn: '#12',
      reverted: ['src/a.ts', 'src/b.ts'],
      skipped: [
        { path: 'src/c.ts', why: { ok: false, reason: 'changed-since', otherTurns: ['t14'] } },
        { path: 'src/d.ts', why: 'kept' },
      ],
      stopped: null,
      notTried: 0,
    },
    name,
  )
  assert.equal(notice, 'Reverted 2 files of #12. Skipped 2 files: src/c.ts was also changed by #14. Revert those turns together, or none. src/d.ts is kept.')
})

test('Revert all that stopped at a write says where, and what it left alone', () => {
  const notice = revertAllNotice({ turn: '#3', reverted: ['a.ts'], skipped: [], stopped: 'b.ts', notTried: 1 }, name)
  assert.equal(notice, 'Reverted 1 file of #3. Stopped at b.ts: the write could not be confirmed, so 1 file more was left alone. Check that file before going on.')
})

test('the first press of Revert all explains a turn with nothing to revert', () => {
  const skipped = [{ path: 'a.ts', why: { ok: false as const, reason: 'changed-externally' as const } }]
  assert.equal(revertAllPlanNotice({ turn: '#5', skipped, writes: 0 }, name), "Nothing in #5 can be reverted. a.ts changed since Claude's last edit, so it was left alone.")
  assert.equal(revertAllPlanNotice({ turn: '#5', skipped: [], writes: 2 }, name), '')
  assert.match(revertAllPlanNotice({ turn: '#5', skipped, writes: 1 }, name), /^Revert all skips 1 of #5's files: a\.ts changed/)
})
