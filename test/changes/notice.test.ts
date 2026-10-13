import { test } from 'node:test'
import assert from 'node:assert/strict'

import { revertNotice } from '../../plugins/changes/hooks/ui/notice.ts'

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
