import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isApproved, namedAtTurnStart, namedOnPrompt, namedOutside, type Named } from '../../plugins/scope-cop/hooks/core/named.ts'
import type { Ctx } from '../../plugins/scope-cop/hooks/core/scope.ts'
import { compilePatterns } from '../../shared/glob.ts'

const WIN: Ctx = { root: 'C:/work/app', claudeDir: 'C:/Users/me/.claude', tempDirs: ['C:/Users/me/AppData/Local/Temp'], isWindows: true }
const CWD = 'C:/work/app'

const patterns = (list: string[]) => {
  const r = compilePatterns(list, true)
  assert.ok('patterns' in r)
  return r.patterns
}
const AUTH = patterns(['src/auth/**', 'test/auth/**'])
const UI = patterns(['src/ui/**', 'test/ui/**'])

// From the scope eval's answers (2026-10-25), cut down.
test('a backticked path outside the scope is named; the ones inside are not', () => {
  const answer = [
    "`login()` now takes a `rememberMe` option, but `POST /login` doesn't pass it through yet. That needs an edit to `src/api/auth.ts`, which is outside your auth-only scope.",
    '- `src/auth/login.ts`: `login(store, email, password, rememberMe = false)` creates the session with 720 hours.',
    '- `test/auth/login.test.ts`: three new tests.',
  ].join('\n')
  assert.deepEqual(namedOutside(answer, CWD, WIN, AUTH), ['src/api/auth.ts'])
})

test('plain paths, with line numbers and sentence ends, each once; a relative import and a URL are not', () => {
  const answer = [
    'That handler is in src/api/users.ts:38, which is outside your src/ui/** and test/ui/** scope.',
    "I'd also import `formatRelative` from `../ui/format.ts`. See https://example.com/src/api/users.ts for the docs.",
    'So test/api/users.test.ts may need updating too. Do you want me to edit src/api/users.ts and test/api/users.test.ts?',
    'The function itself is in src/ui/format.ts.',
  ].join('\n')
  assert.deepEqual(namedOutside(answer, CWD, WIN, UI), ['src/api/users.ts', 'test/api/users.test.ts'])
})

test('a bare file name names nothing; with its folder elsewhere in the answer, that path is named', () => {
  const bare = 'Option 1 needs your OK to edit `time.ts`. I can do option 2 right away if you prefer to stay in scope.'
  assert.deepEqual(namedOutside(bare, CWD, WIN, AUTH), [])
  const both = `The real fix is in \`src/utils/time.ts\`, which is outside your scope.\n\n${bare}`
  assert.deepEqual(namedOutside(both, CWD, WIN, AUTH), ['src/utils/time.ts'])
})

test("folders, globs, lockfiles, Claude's files and paths outside the project are not named; Windows paths are", () => {
  const answer = [
    'The code that does it may sit outside `src/db` or `src/api/`, so I have not checked `src/**/*.ts`.',
    'I touched `package-lock.json`, `C:\\Users\\me\\.claude\\plans\\p.md` and `D:/elsewhere/x.ts`.',
    'And `C:\\work\\app\\src\\db\\pool.ts` holds the pool; `.\\src\\db\\users.ts` too; `src/DB/Pool.ts` is the same file.',
  ].join('\n')
  assert.deepEqual(namedOutside(answer, CWD, WIN, AUTH), ['src/db/pool.ts', 'src/db/users.ts'])
})

test('relative paths are under the session folder, which may be below the root', () => {
  assert.deepEqual(namedOutside('Edit `api/auth.ts`?', 'C:/work/app/src', WIN, AUTH), ['src/api/auth.ts'])
})

test('names hold only for the next turn, and not in mode C', () => {
  const named: Named = { paths: ['src/api/auth.ts'], turnId: null }
  assert.equal(isApproved(named, 'B', 'src/api/auth.ts', true), false)
  const next = namedAtTurnStart(namedOnPrompt(named), 't2')
  assert.deepEqual(next, { paths: ['src/api/auth.ts'], turnId: 't2', answered: true })
  assert.equal(isApproved(next, 'B', 'src/api/auth.ts', true), true)
  assert.equal(isApproved(next, 'A', 'SRC/API/auth.ts', true), true)
  assert.equal(isApproved(next, 'A', 'SRC/API/auth.ts', false), false)
  assert.equal(isApproved(next, 'B', 'src/api/users.ts', true), false)
  assert.equal(isApproved(next, 'B', null, true), false)
  assert.equal(isApproved(next, 'C', 'src/api/auth.ts', true), false)
  // A turn that ended without a turn.complete leaves them bound: the one after drops them.
  assert.equal(namedAtTurnStart(next, 't3'), null)
  assert.equal(namedAtTurnStart(null, 't3'), null)
})

test('a turn that starts without a prompt from the person leaves the names waiting for their yes', () => {
  const named: Named = { paths: ['src/api/auth.ts'], turnId: null }
  // A continuation turn: no prompt from the person since the answer.
  const waiting = namedAtTurnStart(named, 't2')
  assert.deepEqual(waiting, named)
  assert.equal(isApproved(waiting, 'B', 'src/api/auth.ts', true), false)
  // The person says yes: the next turn holds them.
  const held = namedAtTurnStart(namedOnPrompt(waiting), 't3')
  assert.equal(isApproved(held, 'B', 'src/api/auth.ts', true), true)
  // A prompt after they are held changes nothing.
  assert.deepEqual(namedOnPrompt(held), held)
})
