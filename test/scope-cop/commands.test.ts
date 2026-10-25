import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseScopeCommand } from '../../plugins/scope-cop/hooks/core/commands.ts'

test('no arguments opens the pane', () => {
  assert.deepEqual(parseScopeCommand(''), { kind: 'show' })
  assert.deepEqual(parseScopeCommand('   '), { kind: 'show' })
})

test('patterns set the scope, split on spaces', () => {
  assert.deepEqual(parseScopeCommand('src/auth/** tests/auth/**'), { kind: 'set', patterns: ['src/auth/**', 'tests/auth/**'] })
  assert.deepEqual(parseScopeCommand('  src/auth   !src/auth/gen/** '), { kind: 'set', patterns: ['src/auth', '!src/auth/gen/**'] })
})

test('quotes keep a pattern with spaces whole', () => {
  assert.deepEqual(parseScopeCommand('"docs/my notes/**" src'), { kind: 'set', patterns: ['docs/my notes/**', 'src'] })
  assert.deepEqual(parseScopeCommand("add 'a b/**'"), { kind: 'add', patterns: ['a b/**'] })
})

test('add, remove, off and mode', () => {
  assert.deepEqual(parseScopeCommand('add lib/**'), { kind: 'add', patterns: ['lib/**'] })
  assert.deepEqual(parseScopeCommand('remove lib/** src'), { kind: 'remove', patterns: ['lib/**', 'src'] })
  assert.deepEqual(parseScopeCommand('off'), { kind: 'off' })
  assert.deepEqual(parseScopeCommand('OFF'), { kind: 'off' })
  assert.deepEqual(parseScopeCommand('mode c'), { kind: 'mode', mode: 'C' })
  assert.deepEqual(parseScopeCommand('mode B'), { kind: 'mode', mode: 'B' })
})

test('mistakes answer with what to type, never a guess', () => {
  for (const [args, hint] of [
    ['add', /add <pattern>/],
    ['remove', /remove <pattern>/],
    ['mode', /mode A, B or C/],
    ['mode D', /mode A, B or C/],
    ['off now', /off/],
    ['"src/auth', /quote/],
  ] as const) {
    const r = parseScopeCommand(args)
    assert.equal(r.kind, 'error', args)
    assert.match((r as { message: string }).message, hint, args)
  }
})

test('a folder literally named like a word is still a pattern when written as a path', () => {
  assert.deepEqual(parseScopeCommand('./off'), { kind: 'set', patterns: ['./off'] })
  assert.deepEqual(parseScopeCommand('mode/**'), { kind: 'set', patterns: ['mode/**'] })
})
