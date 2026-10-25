import { test } from 'node:test'
import assert from 'node:assert/strict'

import { badPatternsReply, bandText, denyReason, listPatterns, scopeChangedReply, scopeLine, scopeSetReply, tellLater, tellNow } from '../../plugins/scope-cop/hooks/core/copy.ts'

const AUTH = ['src/auth/**', 'test/auth/**']

test('the pattern list is joined, and long lists end in "+N more"', () => {
  assert.equal(listPatterns(AUTH), 'src/auth/**, test/auth/**')
  assert.equal(listPatterns(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b, c, d, e, +2 more')
})

test("the note after an edit is the wording the probe saw Claude acknowledge: facts, the mod named, no blame", () => {
  assert.equal(
    tellNow('src/db/pool.ts', AUTH),
    'Scope Cop (a mod the user installed): src/db/pool.ts is outside the scope the user set for this task (src/auth/**, test/auth/**). The edit went through. If it was not needed for the task, say so in your answer.',
  )
})

test('the deny reason says what happened and how the user widens the scope', () => {
  const reason = denyReason('src/db/pool.ts', AUTH)
  assert.match(reason, /^Scope Cop \(a mod the user installed\): src\/db\/pool\.ts is outside the scope the user set for this task \(src\/auth\/\*\*, test\/auth\/\*\*\)\./)
  assert.match(reason, /\/scope add/)
  assert.doesNotMatch(reason, /must|never|immediately/i)
})

test('shell writes are told once, on the next prompt, with every file', () => {
  assert.equal(
    tellLater(['src/db/a.ts', 'C:/elsewhere/b.ts'], AUTH),
    'Scope Cop (a mod the user installed): in your last turn, shell commands changed files outside the scope the user set for this task (src/auth/**, test/auth/**): src/db/a.ts, C:/elsewhere/b.ts. If they were not needed for the task, say so.',
  )
})

test('many shell files are cut to a count', () => {
  const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`)
  assert.match(tellLater(files, AUTH), /f0\.ts, .*f7\.ts, \+4 more\./)
})

test('the scope line rides on each prompt; the command reply is what Claude reads when the scope is set', () => {
  assert.equal(scopeLine(AUTH), 'Scope Cop (a mod the user installed): for this task the user limited edits to src/auth/**, test/auth/**. Ask before editing other files.')
  assert.equal(scopeSetReply(AUTH), 'Scope set: edit only src/auth/**, test/auth/**. Ask before touching other files.')
})

test('the band names the scope, and what went outside it since the last prompt', () => {
  assert.equal(bandText(AUTH, []), 'Scope: src/auth/**, test/auth/** · nothing outside')
  assert.equal(bandText(AUTH, [{ path: 'src/db/a.ts', outcome: 'told' }]), 'Scope: src/auth/**, test/auth/** · 1 edit outside: src/db/a.ts')
  assert.equal(
    bandText(AUTH, [{ path: 'a.ts', outcome: 'flagged' }, { path: 'b.ts', outcome: 'told' }, { path: 'a.ts', outcome: 'told' }, { path: 'c.ts', outcome: 'flagged' }]),
    'Scope: src/auth/**, test/auth/** · 3 edits outside: a.ts, b.ts, +1 more',
  )
  assert.equal(bandText(AUTH, [{ path: 'a.ts', outcome: 'denied' }]), 'Scope: src/auth/**, test/auth/** · 1 blocked: a.ts')
})

test('replies: a bad pattern names itself and why; an emptied scope is cleared', () => {
  assert.equal(badPatternsReply([{ pattern: '../x', error: '`..` leaves the project' }]), 'Scope not changed. "../x": `..` leaves the project. Patterns are relative to the project root, like src/auth/**.')
  assert.equal(scopeChangedReply([]), 'Scope cleared: Claude may edit any file again.')
  assert.equal(scopeChangedReply(['src/**']), 'Scope set: edit only src/**. Ask before touching other files.')
})
