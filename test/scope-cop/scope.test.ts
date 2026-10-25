import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, decide, isBookkeepingPath, isLockfile, isScratchPath, isSecretPath, isTestPath, type Ctx, type Mode, type Where } from '../../plugins/scope-cop/hooks/core/scope.ts'
import { compilePatterns } from '../../shared/glob.ts'

const WIN: Ctx = { root: 'C:/work/app', claudeDir: 'C:/Users/me/.claude', tempDirs: ['C:/Users/me/AppData/Local/Temp'], isWindows: true }
const POSIX: Ctx = { root: '/home/me/app', claudeDir: '/home/me/.claude', tempDirs: ['/tmp'], isWindows: false }

const patterns = (list: string[], isWindows = true) => {
  const r = compilePatterns(list, isWindows)
  assert.ok('patterns' in r)
  return r.patterns
}
const AUTH = patterns(['src/auth/**', 'test/auth/**'])

test('a file under a scope pattern is in; a sibling folder is out, with its path under the root', () => {
  assert.deepEqual(classify('C:/work/app/src/auth/login.ts', WIN, AUTH), { kind: 'in' })
  assert.deepEqual(classify('C:\\work\\app\\src\\db\\pool.ts', WIN, AUTH), { kind: 'out', rel: 'src/db/pool.ts' })
})

test('on Windows the root and the patterns ignore case', () => {
  assert.deepEqual(classify('c:/WORK/app/SRC/Auth/login.ts', WIN, AUTH), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/SRC/Auth/x.ts', WIN, AUTH), { kind: 'in' })
  assert.deepEqual(classify('C:/WORK/APP/SRC/DB/x.ts', WIN, AUTH), { kind: 'out', rel: 'SRC/DB/x.ts' })
})

// realPathOf gives a file that doesn't exist yet its nearest folder's real
// path plus the rest as typed, so classify sees a path that isn't on disk.
test('a new file, in a folder that may not exist yet, classifies by where it would land', () => {
  assert.deepEqual(classify('C:/work/app/src/auth/new.ts', WIN, AUTH), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/src/auth/NewDir/Deeper/x.ts', WIN, AUTH), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/src/db/new.ts', WIN, AUTH), { kind: 'out', rel: 'src/db/new.ts' })
  assert.deepEqual(classify('C:/work/app/src/payments/new.ts', WIN, AUTH), { kind: 'out', rel: 'src/payments/new.ts' })
  assert.deepEqual(classify('C:/work/app/new.ts', WIN, AUTH), { kind: 'out', rel: 'new.ts' })
})

test('on POSIX case counts', () => {
  assert.deepEqual(classify('/home/me/app/src/Auth/a.ts', POSIX, patterns(['src/auth/**'], false)), { kind: 'out', rel: 'src/Auth/a.ts' })
})

test("a file outside the project is out, with no path under the root", () => {
  assert.deepEqual(classify('D:/elsewhere/x.ts', WIN, AUTH), { kind: 'out', rel: null })
  assert.deepEqual(classify('C:/work/app2/x.ts', WIN, AUTH), { kind: 'out', rel: null })
})

test("Claude's own files and temp folders are always allowed, wherever they are", () => {
  assert.deepEqual(classify('C:/Users/me/.claude/plans/p.md', WIN, AUTH), { kind: 'exempt', why: 'claude' })
  assert.deepEqual(classify('c:/users/ME/.CLAUDE/projects/x/memory/m.md', WIN, AUTH), { kind: 'exempt', why: 'claude' })
  assert.deepEqual(classify('C:/Users/me/AppData/Local/Temp/scratch.js', WIN, AUTH), { kind: 'exempt', why: 'temp' })
  assert.deepEqual(classify('/tmp/x/y.sh', POSIX, AUTH), { kind: 'exempt', why: 'temp' })
})

test('lockfiles are exempt by name, in any folder; other files named like them are not', () => {
  for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'bun.lockb', 'Gemfile.lock', 'composer.lock']) {
    assert.equal(isLockfile(`C:/work/app/sub/${name}`), true, name)
  }
  assert.equal(isLockfile('C:/work/app/package.json'), false)
  assert.equal(isLockfile('C:/work/app/src/lock.ts'), false)
  assert.deepEqual(classify('C:/work/app/package-lock.json', WIN, AUTH), { kind: 'exempt', why: 'lockfile' })
})

test('a project inside the temp folder is still guarded: the root wins over temp', () => {
  const ctx: Ctx = { ...WIN, root: 'C:/Users/me/AppData/Local/Temp/proj' }
  assert.deepEqual(classify('C:/Users/me/AppData/Local/Temp/proj/src/db/a.ts', ctx, AUTH), { kind: 'out', rel: 'src/db/a.ts' })
  assert.deepEqual(classify('C:/Users/me/AppData/Local/Temp/other.ts', ctx, AUTH), { kind: 'exempt', why: 'temp' })
})

const OUT: Where = { kind: 'out', rel: 'src/db/a.ts' }
const NONE = { deny: false, flag: false, tell: null }

test('in scope or exempt: nothing happens, in any mode and for any kind', () => {
  for (const mode of ['A', 'B', 'C'] as Mode[]) {
    for (const kind of ['file', 'shell', 'shell-before'] as const) {
      assert.deepEqual(decide(mode, kind, { kind: 'in' }), NONE)
      assert.deepEqual(decide(mode, kind, { kind: 'exempt', why: 'lockfile' }), NONE)
    }
  }
})

test('out of scope, file tools: A flags, B flags and tells Claude now, C denies', () => {
  assert.deepEqual(decide('A', 'file', OUT), { deny: false, flag: true, tell: null })
  assert.deepEqual(decide('B', 'file', OUT), { deny: false, flag: true, tell: 'now' })
  assert.deepEqual(decide('C', 'file', OUT), { deny: true, flag: true, tell: null })
})

test('out of scope, a shell write seen after it ran: flagged in every mode, Claude told on the next prompt in B and C', () => {
  assert.deepEqual(decide('A', 'shell', OUT), { deny: false, flag: true, tell: null })
  assert.deepEqual(decide('B', 'shell', OUT), { deny: false, flag: true, tell: 'next-prompt' })
  assert.deepEqual(decide('C', 'shell', OUT), { deny: false, flag: true, tell: 'next-prompt' })
})

test('a literal shell target out of scope, before the run: denied in C only', () => {
  assert.deepEqual(decide('A', 'shell-before', OUT), NONE)
  assert.deepEqual(decide('B', 'shell-before', OUT), NONE)
  assert.deepEqual(decide('C', 'shell-before', OUT), { deny: true, flag: true, tell: null })
})

// --------------------------------------------------- bookkeeping folders

test('bookkeeping folders are exempt, at any depth, inside the project or outside it', () => {
  for (const folder of ['shots', '.shots', 'screenshots', '.agent', '.cache']) {
    for (const path of [`C:/work/app/${folder}/a.png`, `C:/work/app/web/e2e-out/${folder}/deep/a.json`, `D:/elsewhere/${folder}/a.txt`]) {
      assert.deepEqual(classify(path, WIN, AUTH), { kind: 'exempt', why: 'bookkeeping' }, path)
    }
    assert.deepEqual(classify(`/home/me/app/${folder}/a.png`, POSIX, AUTH), { kind: 'exempt', why: 'bookkeeping' }, folder)
  }
})

test('on Windows a bookkeeping folder matches in any case; on POSIX case counts', () => {
  for (const path of ['C:/work/app/Shots/a.png', 'C:/work/app/SCREENSHOTS/a.png', 'C:/work/app/.Cache/x', 'C:/work/app/.AGENT/notes.md']) {
    assert.deepEqual(classify(path, WIN, AUTH), { kind: 'exempt', why: 'bookkeeping' }, path)
  }
  assert.deepEqual(classify('/home/me/app/Shots/a.png', POSIX, AUTH), { kind: 'out', rel: 'Shots/a.png' })
  assert.equal(isBookkeepingPath('a/.CACHE/b', true), true)
  assert.equal(isBookkeepingPath('a/.CACHE/b', false), false)
})

test('only folders count: a file named like one, or a folder that only looks like one, is not', () => {
  for (const rel of ['src/shots', 'src/db/.cache', 'src/shotsy/a.ts', 'src/cache/a.ts', 'src/agent/a.ts', 'src/screenshot/a.ts', 'blender/x.blend.py']) {
    assert.deepEqual(classify(`C:/work/app/${rel}`, WIN, AUTH), { kind: 'out', rel }, rel)
  }
})

test('a secret-looking file in a bookkeeping folder is still flagged', () => {
  assert.deepEqual(classify('C:/work/app/shots/.env', WIN, AUTH), { kind: 'out', rel: 'shots/.env' })
  assert.deepEqual(classify('C:/work/app/.cache/server.pem', WIN, AUTH), { kind: 'out', rel: '.cache/server.pem' })
  assert.deepEqual(classify('D:/elsewhere/.agent/credentials.json', WIN, AUTH), { kind: 'out', rel: null })
  for (const rel of ['.env', 'app/.env.local', 'certs/server.pem', 'x.key', 'a.p12', 'a.PFX', '.ssh/id_rsa', 'id_rsa.pub', 'release.keystore', 'credentials.json', 'aws/credentials', 'config/secrets.yml']) {
    assert.equal(isSecretPath(rel), true, rel)
  }
  for (const rel of ['src/env.ts', 'keys.ts', 'src/key/index.ts', 'docs/secrets-guide.md', 'notes.environment']) assert.equal(isSecretPath(rel), false, rel)
})

test('a project that lives in a bookkeeping folder is still guarded: only the part under the root counts', () => {
  const ctx: Ctx = { ...WIN, root: 'D:/.cache/proj' }
  assert.deepEqual(classify('D:/.cache/proj/src/db/a.ts', ctx, AUTH), { kind: 'out', rel: 'src/db/a.ts' })
  assert.deepEqual(classify('D:/.cache/proj/shots/a.png', ctx, AUTH), { kind: 'exempt', why: 'bookkeeping' })
})

// ------------------------------------------------------ scratch folders

test('scratch folders count as temp, inside the project or outside it', () => {
  for (const path of [
    'C:/work/app/scratch/a.js',
    'C:/work/app/.scratch/a.js',
    'C:/work/app/tools/perf-scratch/run.py',
    'C:/work/app/tmp/out.txt',
    'C:/work/app/.tmp/out.txt',
    'C:/work/app/tmp-3c/x.ts',
    'C:/work/app/.tmp-3c/x.ts',
    'C:/work/app/src/db/pool.tmp.ts',
    'C:/tmp/probe.ps1',
    'D:/Workspace/Claude/scratch/fix.mjs',
    'D:/Workspace/.SCRATCH/fix.mjs',
  ]) {
    assert.deepEqual(classify(path, WIN, AUTH), { kind: 'exempt', why: 'temp' }, path)
  }
  assert.deepEqual(classify('/tmp/x.sh', { ...POSIX, tempDirs: [] }, AUTH), { kind: 'exempt', why: 'temp' })
})

test('names that only look like scratch are not, and on POSIX case counts', () => {
  for (const path of ['C:/work/app/src/scratchpad/a.ts', 'C:/work/app/src/tmpl/a.ts', 'C:/work/app/src/temp/a.ts', 'C:/work/app/src/db/tmp.ts', 'C:/work/app/src/db/a.tmp']) {
    assert.equal(classify(path, WIN, AUTH).kind, 'out', path)
  }
  assert.deepEqual(classify('/home/me/app/Scratch/a.js', POSIX, AUTH), { kind: 'out', rel: 'Scratch/a.js' })
  assert.deepEqual(classify('/home/me/app/scratch/a.js', POSIX, AUTH), { kind: 'exempt', why: 'temp' })
  assert.equal(isScratchPath('a/TMP/b', true), true)
  assert.equal(isScratchPath('a/TMP/b', false), false)
})

test('a project that lives in a scratch folder is still guarded: only the part under the root counts', () => {
  const ctx: Ctx = { ...WIN, root: 'D:/Workspace/Claude/scratch/proj' }
  assert.deepEqual(classify('D:/Workspace/Claude/scratch/proj/src/db/a.ts', ctx, AUTH), { kind: 'out', rel: 'src/db/a.ts' })
  assert.deepEqual(classify('D:/Workspace/Claude/scratch/proj/src/auth/a.ts', ctx, AUTH), { kind: 'in' })
})

// ------------------------------------------------- a scope's own tests

const SRC_AUTH = patterns(['src/auth/**'])

test('a scope includes its tests: the mirrored test folders are in, other tests are out', () => {
  for (const rel of ['test/auth/login.test.ts', 'tests/auth/x.ts', 'src/auth/__tests__/x.ts', 'src/auth/login.test.ts', 'test/auth/deep/fixtures/a.json', 'spec/auth/login.spec.ts', 'e2e/auth/login.spec.ts', 'TEST/Auth/Login.test.ts']) {
    assert.deepEqual(classify(`C:/work/app/${rel}`, WIN, SRC_AUTH), { kind: 'in' }, rel)
  }
  for (const rel of ['test/db/x.test.ts', 'e2e/checkout.spec.ts', 'test/authz/x.test.ts', 'test/x.test.ts', 'src/db/pool.test.ts', 'lib/auth/x.test.ts', 'test/auth.test.ts']) {
    assert.deepEqual(classify(`C:/work/app/${rel}`, WIN, SRC_AUTH), { kind: 'out', rel }, rel)
  }
})

test('a test file is one by name or by folder; a mirrored non-test file stays out', () => {
  for (const rel of ['a/b.test.ts', 'a/b.spec.js', 'pkg/test_login.py', 'pkg/login_test.py', 'pkg/login_test.go', 'test/helpers.ts', 'a/__tests__/b.ts', 'e2e/flow.ts', 'spec/x.rb']) {
    assert.equal(isTestPath(rel, false), true, rel)
  }
  for (const rel of ['a/testing.ts', 'a/latest.ts', 'contest/a.ts', 'a/test.ts', 'a/b_test.rs', 'pkg/test_login.go']) assert.equal(isTestPath(rel, false), false, rel)
  assert.deepEqual(classify('C:/work/app/auth/login.ts', WIN, SRC_AUTH), { kind: 'out', rel: 'auth/login.ts' })
})

test('Python and Go test names mirror like folders do', () => {
  const billing = patterns(['src/billing/**'])
  assert.deepEqual(classify('C:/work/app/tests/billing/test_invoice.py', WIN, billing), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/billing/invoice_test.go', WIN, billing), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/tests/test_invoice.py', WIN, billing), { kind: 'out', rel: 'tests/test_invoice.py' })
})

test('a one-folder scope like src/** takes in every test; a glob-led pattern mirrors nothing', () => {
  for (const rel of ['test/db/x.test.ts', 'e2e/checkout.spec.ts', 'tests/test_a.py']) {
    assert.deepEqual(classify(`C:/work/app/${rel}`, WIN, patterns(['src/**'])), { kind: 'in' }, rel)
  }
  assert.deepEqual(classify('C:/work/app/test/db/x.test.ts', WIN, patterns(['**/*.ts'])), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/test/db/x.test.js', WIN, patterns(['**/*.ts'])), { kind: 'out', rel: 'test/db/x.test.js' })
  assert.deepEqual(classify('C:/work/app/test/db/x.test.ts', WIN, patterns(['src/*.ts'])), { kind: 'out', rel: 'test/db/x.test.ts' })
  assert.deepEqual(classify('C:/work/app/test/auth/x.test.ts', WIN, patterns(['src/*/auth/**'])), { kind: 'out', rel: 'test/auth/x.test.ts' })
})

test('a scope without src/ mirrors the same way; a scope may name the tests folder itself', () => {
  assert.deepEqual(classify('C:/work/app/test/auth/x.test.ts', WIN, patterns(['auth/**'])), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/src/auth/x.test.ts', WIN, patterns(['test/auth/**'])), { kind: 'in' })
  assert.deepEqual(classify('C:/work/app/src/auth/x.ts', WIN, patterns(['test/auth/**'])), { kind: 'out', rel: 'src/auth/x.ts' })
})

test('a negated pattern still wins over a mirrored test', () => {
  const legacy = patterns(['src/auth/**', '!src/auth/legacy/**'])
  assert.deepEqual(classify('C:/work/app/test/auth/legacy/x.test.ts', WIN, legacy), { kind: 'out', rel: 'test/auth/legacy/x.test.ts' })
  assert.deepEqual(classify('C:/work/app/test/auth/login.test.ts', WIN, legacy), { kind: 'in' })
  const noTests = patterns(['src/auth/**', '!**/*.test.ts'])
  assert.deepEqual(classify('C:/work/app/test/auth/login.test.ts', WIN, noTests), { kind: 'out', rel: 'test/auth/login.test.ts' })
})

test('on POSIX the mirror counts case', () => {
  const posixAuth = patterns(['src/auth/**'], false)
  assert.deepEqual(classify('/home/me/app/test/auth/a.test.ts', POSIX, posixAuth), { kind: 'in' })
  assert.deepEqual(classify('/home/me/app/test/Auth/a.test.ts', POSIX, posixAuth), { kind: 'out', rel: 'test/Auth/a.test.ts' })
})
