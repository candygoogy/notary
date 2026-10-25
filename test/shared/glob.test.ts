import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compilePatterns, matchesAny, parsePattern } from '../../shared/glob.ts'

const scope = (patterns: string[], isWindows = false) => {
  const compiled = compilePatterns(patterns, isWindows)
  assert.ok('patterns' in compiled, JSON.stringify(compiled))
  return (path: string) => matchesAny(compiled.patterns, path)
}

test('** matches any depth, * stays inside one folder', () => {
  const inside = scope(['src/auth/**'])
  assert.equal(inside('src/auth/login.ts'), true)
  assert.equal(inside('src/auth/deep/er/token.ts'), true)
  assert.equal(inside('src/authz/login.ts'), false)
  assert.equal(inside('src/db/pool.ts'), false)
  const one = scope(['src/*.ts'])
  assert.equal(one('src/a.ts'), true)
  assert.equal(one('src/sub/a.ts'), false)
})

test('a plain folder name, with or without a trailing slash, covers everything under it', () => {
  for (const p of ['src/auth', 'src/auth/']) {
    const inside = scope([p])
    assert.equal(inside('src/auth/login.ts'), true, p)
    assert.equal(inside('src/auth/a/b.ts'), true, p)
    assert.equal(inside('src/authz/login.ts'), false, p)
  }
})

test('a plain file name matches that file only', () => {
  const inside = scope(['package.json'])
  assert.equal(inside('package.json'), true)
  assert.equal(inside('sub/package.json'), false)
})

test('patterns are anchored at the root; a leading / or ./ is the same pattern', () => {
  for (const p of ['src/**', '/src/**', './src/**']) {
    const inside = scope([p])
    assert.equal(inside('src/a.ts'), true, p)
    assert.equal(inside('lib/src/a.ts'), false, p)
  }
})

test('**/ in front matches at any depth, including the root', () => {
  const inside = scope(['**/*.test.ts'])
  assert.equal(inside('a.test.ts'), true)
  assert.equal(inside('src/x/a.test.ts'), true)
  assert.equal(inside('src/x/a.ts'), false)
})

test('? matches one character but never a slash', () => {
  const inside = scope(['src/v?.ts'])
  assert.equal(inside('src/v1.ts'), true)
  assert.equal(inside('src/v12.ts'), false)
  assert.equal(inside('src/v/.ts'), false)
})

test('! excludes, and the last pattern that matches decides', () => {
  const inside = scope(['src/**', '!src/generated/**'])
  assert.equal(inside('src/a.ts'), true)
  assert.equal(inside('src/generated/types.ts'), false)
  const back = scope(['src/**', '!src/generated/**', 'src/generated/keep.ts'])
  assert.equal(back('src/generated/keep.ts'), true)
})

test('an exclusion alone matches nothing', () => {
  assert.equal(scope(['!src/**'])('lib/a.ts'), false)
})

test('regex characters in a pattern are literal', () => {
  const inside = scope(['src/a+b (1).ts', 'lib/[x].ts'])
  assert.equal(inside('src/a+b (1).ts'), true)
  assert.equal(inside('src/aab (1).ts'), false)
  assert.equal(inside('lib/[x].ts'), true)
  assert.equal(inside('lib/x.ts'), false)
})

test('on Windows matching ignores case and accepts backslashes; elsewhere case counts', () => {
  const win = scope(['src\\Auth\\**'], true)
  assert.equal(win('SRC/auth/Login.ts'), true)
  assert.equal(win('src\\auth\\login.ts'), true)
  const posix = scope(['src/Auth/**'])
  assert.equal(posix('src/auth/login.ts'), false)
  assert.equal(posix('src/Auth/login.ts'), true)
})

test('parsePattern refuses what cannot be a pattern under the root', () => {
  for (const bad of ['', '   ', '!', '/', 'C:/work/src/**', 'c:\\x', '../other/**', 'src/../../x', '\\\\server\\share']) {
    const r = parsePattern(bad, true)
    assert.ok('error' in r, `${JSON.stringify(bad)} should be refused`)
  }
  const ok = parsePattern('  src/**  ', false)
  assert.ok(!('error' in ok))
  assert.equal(ok.pattern.source, 'src/**')
})

test('compilePatterns reports every bad pattern by its text', () => {
  const r = compilePatterns(['src/**', '../x', 'C:/y'], true)
  assert.ok('errors' in r)
  assert.deepEqual(r.errors.map(e => e.pattern), ['../x', 'C:/y'])
})
