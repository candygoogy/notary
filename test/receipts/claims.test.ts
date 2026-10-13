import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findClaims } from '../../plugins/receipts/hooks/core/claims.ts'

test('a terse closer and a tests claim on one line give two claims', () => {
  const claims = findClaims('Fixed. All tests pass ✅')
  assert.equal(claims.length, 2)
  assert.deepEqual(claims[0], { sentence: 'Fixed.', kind: 'generic', certainty: 'sure' })
  assert.deepEqual(claims[1], { sentence: 'All tests pass ✅', kind: 'tests', certainty: 'sure' })
})

test('a first-person completion is a sure generic claim', () => {
  assert.deepEqual(findClaims("I've fixed the date parser."), [
    { sentence: "I've fixed the date parser.", kind: 'generic', certainty: 'sure' },
  ])
})

test('a curly apostrophe counts the same', () => {
  assert.equal(findClaims('I’ve fixed the date parser.').length, 1)
})

for (const text of ['This should fix it.', 'I think the tests pass now.', 'It probably works.']) {
  test(`a hedge gives no claim: ${text}`, () => {
    assert.deepEqual(findClaims(text), [])
  })
}

for (const text of ["I haven't run the tests, but the fix is done.", 'Untested: the build is fixed.']) {
  test(`a disclaimer gives no claim: ${text}`, () => {
    assert.deepEqual(findClaims(text), [])
  })
}

for (const text of ['The bug is not fixed yet.', 'Tests still fail.']) {
  test(`a negation gives no claim: ${text}`, () => {
    assert.deepEqual(findClaims(text), [])
  })
}

for (const text of ['Is it fixed?', 'Once tests pass, it will be done.']) {
  test(`a question or conditional gives no claim: ${text}`, () => {
    assert.deepEqual(findClaims(text), [])
  })
}

test('fenced code is ignored', () => {
  assert.deepEqual(findClaims('Run:\n```\nall tests pass\n```'), [])
})

test('inline code is ignored', () => {
  assert.deepEqual(findClaims('Type `done` to finish.'), [])
})

test('a blockquote line is ignored', () => {
  assert.deepEqual(findClaims('> All tests pass'), [])
})

test('a double-quoted span is ignored', () => {
  assert.deepEqual(findClaims('You said "it is fixed".'), [])
})

test('an unchecked checkbox is ignored', () => {
  assert.deepEqual(findClaims('- [ ] tests pass'), [])
})

test('a terse closing line is a generic claim', () => {
  assert.deepEqual(findClaims('Changes below.\n\nDone.'), [
    { sentence: 'Done.', kind: 'generic', certainty: 'sure' },
  ])
})

test('non-English text gives no claims (v1 is English-only)', () => {
  assert.deepEqual(findClaims('Düzelttim, testler geçiyor.'), [])
})

test('CRLF line endings split like LF', () => {
  const claims = findClaims('Fixed.\r\nAll tests pass.')
  assert.equal(claims.length, 2)
  assert.equal(claims[1].kind, 'tests')
})

test('a long compound sentence with a conjunction is a maybe claim', () => {
  const text =
    'I have updated the configuration loader so that it reads the new environment file first, ' +
    'but the legacy path is still consulted as a fallback when the new file is missing on older machines.'
  const claims = findClaims(text)
  assert.equal(claims.length, 1)
  assert.equal(claims[0].certainty, 'maybe')
})

test('plain prose without a claim gives nothing', () => {
  assert.deepEqual(findClaims('Here is how the parser reads dates. It splits on dashes.'), [])
})

test('a hedge in the next sentence does not cancel the claim before it', () => {
  assert.deepEqual(findClaims('Fixed. It should be faster now.'), [
    { sentence: 'Fixed.', kind: 'generic', certainty: 'sure' },
  ])
})

test('"working on" is not a claim', () => {
  assert.deepEqual(findClaims('The team is working on the parser.'), [])
})

test('an instruction is not a claim', () => {
  assert.deepEqual(findClaims('1. **Confirm the new tests pass**, then put the old logic back.'), [])
})

test('inline code as the subject keeps the claim and shows the code', () => {
  assert.deepEqual(findClaims('`pnpm verify` passes (422 unit tests).'), [
    { sentence: '`pnpm verify` passes (422 unit tests).', kind: 'tests', certainty: 'sure' },
  ])
})

test('a closer that opens a sentence is a claim; a condition after it keeps it', () => {
  assert.equal(findClaims('Fixed, if you want to rerun it.').length, 1)
})

test('a sentence ends after closing emphasis', () => {
  assert.equal(findClaims('**Every check passes.** No errors.').length, 2)
})

test('"It now passes" is a claim', () => {
  assert.equal(findClaims('It now passes: 1 test, 1 pass, 0 fail, exit code 0.').length, 1)
})

// Review 3a: an answer that discloses a failure has no claim to catch.
for (const text of [
  'The build succeeds. 3 tests are failing; I left them for you.',
  'Done, but the e2e tests are failing.',
  '1 test passed and 4 failed.',
  "Unit tests pass; the integration suite fails because Docker isn't running.",
]) {
  test(`an answer that discloses a failure has no claims: ${text}`, () => {
    assert.deepEqual(findClaims(text), [])
  })
}

test('fixing a past failure is no disclosure', () => {
  assert.equal(findClaims('I fixed the failing test. All tests pass.').length, 2)
})

// Review 3c and 4.
for (const text of [
  "I've added a failing test that reproduces the bug.",
  'Nothing is done yet.',
  'Before my change, all tests passed.',
  "I'll run the tests next, then it will be done.",
  'Tell me when steps 1 and 2 are done.',
  'Why it works on those two sites: the page reads like a letter.',
  'It is there because a redirect rule only runs on traffic that passes through Cloudflare.',
  'Here is what changed:',
]) {
  test(`not a claim: ${text}`, () => {
    assert.deepEqual(findClaims(text), [])
  })
}

test('a claim about the build is of kind build', () => {
  assert.equal(findClaims('The build succeeds.')[0].kind, 'build')
  assert.equal(findClaims('Lint and typecheck are clean.')[0].kind, 'build')
  assert.equal(findClaims('All tests pass and the build succeeds.')[0].kind, 'tests')
})

test('headings are not claims, but a bold closer still is', () => {
  assert.deepEqual(findClaims('## Everything works\n\nNotes follow.'), [])
  assert.deepEqual(findClaims("**What's working for you**\n\n- The settings load."), [])
  assert.equal(findClaims('**Done**').length, 1)
  assert.equal(findClaims('**Fixed!**').length, 1)
})

test('a claim with a breakdown after a colon still claims; a relative-clause label does not', () => {
  assert.equal(findClaims('All tests pass: 625 TypeScript, 67 Rust.').length, 1)
  assert.deepEqual(findClaims('The free path that works: your own receiver.'), [])
})

test('"test" as a verb does not make a tests claim', () => {
  const claims = findClaims("I've fixed the date picker and opened it to test.")
  assert.equal(claims.length, 1)
  assert.equal(claims[0].kind, 'generic')
  assert.equal(findClaims('Checks: 115 terminal tests pass.')[0].kind, 'tests')
  assert.equal(findClaims('The suite is green.')[0].kind, 'tests')
})
