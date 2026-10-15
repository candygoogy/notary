import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkEntry, parseChecks } from '../../plugins/receipts/hooks/core/checks.ts'
import { findClaims } from '../../plugins/receipts/hooks/core/claims.ts'
import { checkKindOf, classify } from '../../plugins/receipts/hooks/core/evidence.ts'
import type { DeclaredCheck, RunInput } from '../../plugins/receipts/hooks/core/types.ts'

const CHECKS: DeclaredCheck[] = [
  { kind: 'tests', prefix: 'pnpm verify' },
  { kind: 'build', prefix: 'make ci' },
]
const bash = (command: string, isError = false, text = 'done'): RunInput => ({ tool: 'Bash', command, isError, text, backgrounded: false })
const shape = (run: RunInput, checks: DeclaredCheck[] = CHECKS) => {
  const ev = classify(run, checks)
  return { strength: ev.strength, outcome: ev.outcome }
}

test('parseChecks reads a list, or one text split by ; and new lines', () => {
  assert.deepEqual(parseChecks(['tests: pnpm verify', 'build:make ci']).checks, CHECKS)
  assert.deepEqual(parseChecks('tests: pnpm verify; build: make ci').checks, CHECKS)
  assert.deepEqual(parseChecks('Test: pnpm verify\nBUILD: make ci').checks, CHECKS)
})

test('parseChecks names entries in neither form, and ignores what is not text', () => {
  assert.deepEqual(parseChecks(['pnpm verify', 'lint: eslint .', 'tests:']), { checks: [], invalid: ['pnpm verify', 'lint: eslint .', 'tests:'] })
  assert.deepEqual(parseChecks(undefined), { checks: [], invalid: [] })
  assert.deepEqual(parseChecks([3, true]), { checks: [], invalid: [] })
})

test('checkEntry writes a check as the setting stores it', () => {
  assert.deepEqual(parseChecks(CHECKS.map(checkEntry)).checks, CHECKS)
})

test('a declared tests check is a test run: passing, failing, and with more arguments', () => {
  assert.deepEqual(shape(bash('pnpm verify')), { strength: 'strong', outcome: 'pass' })
  assert.deepEqual(shape(bash('pnpm verify --ci', true, 'Exit code 1\nverify failed')), { strength: 'strong', outcome: 'fail' })
  assert.deepEqual(shape(bash('make ci')), { strength: 'medium', outcome: 'pass' })
})

test('without the setting, the same commands are no evidence', () => {
  assert.deepEqual(shape(bash('pnpm verify'), []), { strength: 'none', outcome: 'pass' })
})

test('a declared check matches the whole command word, never a longer one', () => {
  assert.equal(classify(bash('pnpm verifyx'), CHECKS).strength, 'none')
  assert.equal(classify(bash('pnpm verify-docs'), CHECKS).strength, 'none')
})

test('a declared check follows the built-in rules: wrappers, chains, pipes, --help', () => {
  assert.deepEqual(shape(bash('timeout 300 pnpm verify')), { strength: 'strong', outcome: 'pass' })
  assert.deepEqual(shape(bash('cd app && pnpm verify')), { strength: 'strong', outcome: 'pass' })
  // Through a pipe with no summary, the exit code is not the check's: no evidence.
  assert.equal(classify(bash('pnpm verify 2>&1 | tail -5'), CHECKS).strength, 'none')
  assert.equal(classify(bash('pnpm verify --help'), CHECKS).strength, 'none')
})

test('a declared check never weakens a built-in runner or turns a failure into a pass', () => {
  const asBuild: DeclaredCheck[] = [{ kind: 'build', prefix: 'npm test' }]
  assert.deepEqual(shape(bash('npm test', true, 'Exit code 1\nTests: 1 failed, 2 passed'), asBuild), { strength: 'strong', outcome: 'fail' })
  assert.deepEqual(shape(bash('npm test', false, 'Tests: 2 passed'), asBuild), { strength: 'strong', outcome: 'pass' })
})

test('checkKindOf gives a declared check its kind', () => {
  assert.equal(checkKindOf('pnpm verify', CHECKS), 'tests')
  assert.equal(checkKindOf('make ci', CHECKS), 'build')
  assert.equal(checkKindOf('pnpm verify'), null)
})

test('a claim whose subject is a declared check in inline code takes its kind', () => {
  assert.deepEqual(findClaims('`pnpm verify` passes.', CHECKS).map(c => c.kind), ['tests'])
  assert.deepEqual(findClaims('`pnpm verify` passes.').map(c => c.kind), ['generic'])
})
