// Where a written path falls against the scope, and what each mode does about
// it (design note §2-§3). Pure: register.tsx resolves real paths and acts.

import type { Pattern } from '../shared/glob.ts'
import { relativeTo } from '../shared/paths.ts'

export type Mode = 'A' | 'B' | 'C'

export type Ctx = {
  // The repository root, or the session's folder outside git: patterns are
  // anchored here.
  root: string
  // ~/.claude (or CLAUDE_CONFIG_DIR): memory, plans, todos.
  claudeDir: string
  tempDirs: readonly string[]
  isWindows: boolean
}

export type Where =
  | { kind: 'in' }
  // `bookkeeping`: under a screenshot, agent or cache folder (isBookkeepingPath).
  | { kind: 'exempt'; why: 'claude' | 'temp' | 'lockfile' | 'bookkeeping' }
  // `rel`: the path under the root, or null for a file outside the project.
  | { kind: 'out'; rel: string | null }

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'cargo.lock',
  'poetry.lock',
  'pdm.lock',
  'uv.lock',
  'pipfile.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'packages.lock.json',
  'podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'flake.lock',
])

export function isLockfile(path: string): boolean {
  const normal = path.replace(/\\/g, '/')
  return LOCKFILES.has(normal.slice(normal.lastIndexOf('/') + 1).toLowerCase())
}

// Claude's own files, then lockfiles, then scratch, then bookkeeping folders
// (secrets aside), then the project; temp folders only outside the project,
// so a project that lives in temp is still guarded.
export function classify(path: string, ctx: Ctx, patterns: readonly Pattern[]): Where {
  if (under(ctx.claudeDir, path, ctx.isWindows)) return { kind: 'exempt', why: 'claude' }
  if (isLockfile(path)) return { kind: 'exempt', why: 'lockfile' }
  const rel = relativeTo(ctx.root, path, ctx.isWindows)
  // Inside the project only the part under the root counts, so a project
  // that itself lives in a scratch or bookkeeping folder is still guarded.
  if (isScratchPath(rel ?? path, ctx.isWindows)) return { kind: 'exempt', why: 'temp' }
  if (isBookkeepingPath(rel ?? path, ctx.isWindows) && !isSecretPath(path)) return { kind: 'exempt', why: 'bookkeeping' }
  if (rel !== undefined) return inScope(patterns, rel, ctx.isWindows) ? { kind: 'in' } : { kind: 'out', rel }
  if (ctx.tempDirs.some(dir => under(dir, path, ctx.isWindows))) return { kind: 'exempt', why: 'temp' }
  return { kind: 'out', rel: null }
}

// Scratch outside the system temp counts as temp: a folder named `scratch`,
// `.scratch`, `*-scratch`, `tmp`, `.tmp`, `tmp-*` or `.tmp-*` (which covers
// the roots `/tmp` and `C:/tmp`), or a file name containing `.tmp.`. Case
// counts except on Windows.
const SCRATCH_FOLDER = /^(?:\.?scratch|.+-scratch|\.?tmp|\.?tmp-.*)$/

export function isScratchPath(path: string, isWindows: boolean): boolean {
  const parts = path.replace(/\\/g, '/').split('/')
  const name = parts.pop() ?? ''
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s)
  return parts.some(part => SCRATCH_FOLDER.test(fold(part))) || fold(name).includes('.tmp.')
}

// Bookkeeping folders: screenshots, an agent's notes, caches. A path under a
// folder named `shots`, `.shots`, `screenshots`, `.agent` or `.cache` is
// exempt, inside the project or outside it. Case counts except on Windows.
const BOOKKEEPING_FOLDERS = new Set(['shots', '.shots', 'screenshots', '.agent', '.cache'])

export function isBookkeepingPath(path: string, isWindows: boolean): boolean {
  const parts = path.replace(/\\/g, '/').split('/').slice(0, -1)
  return parts.some(part => BOOKKEEPING_FOLDERS.has(isWindows ? part.toLowerCase() : part))
}

// Secret-looking files: flagged even in a bookkeeping folder, so a stray
// secret write still shows. By name, any case.
const SECRET_NAME = /^(?:\.env|\.env\..*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|.*\.keystore|credentials.*|secrets\..*)$/i

export function isSecretPath(path: string): boolean {
  const normal = path.replace(/\\/g, '/')
  return SECRET_NAME.test(normal.slice(normal.lastIndexOf('/') + 1))
}

// ---------------------------------------------------- the scope and its tests

// A scope includes its tests, silently. A test file is one named `*.test.*`,
// `*.spec.*`, `test_*.py`, `*_test.py` or `*_test.go`, or one under a folder
// named `test`, `tests`, `__tests__`, `spec` or `e2e`. Its folder is compared
// with each pattern's folder after both drop those test folders and a leading
// `src/`: the test is in when its folder is under (or is) the pattern's, or
// when the pattern is a plain folder (`src/**`) left empty by that. So with
// `src/auth/**`, `test/auth/login.test.ts` and `tests/auth/x.ts` are in, and
// `test/db/x.test.ts` and `e2e/checkout.spec.ts` are not. Only patterns whose
// folder part is literal mirror (`src/auth/**`, `src/auth/*.ts`; not
// `src/*/auth/**`). A pattern matches a test file directly or by mirror, and
// the last pattern that matches decides, so `!src/auth/legacy/**` still keeps
// `test/auth/legacy/x.test.ts` out.
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e'])
const TEST_NAME = /(?:\.test\.|\.spec\.|^test_.*\.py$|_test\.py$|_test\.go$)/

export function isTestPath(rel: string, isWindows: boolean): boolean {
  const parts = rel.replace(/\\/g, '/').split('/')
  const name = parts.pop() ?? ''
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s)
  return TEST_NAME.test(fold(name)) || parts.some(part => TEST_FOLDERS.has(fold(part)))
}

// `rel` is relative to the root the patterns are anchored at.
export function inScope(patterns: readonly Pattern[], rel: string, isWindows: boolean): boolean {
  const path = rel.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')
  const test = isTestPath(path, isWindows) ? mirrorFolder(path.split('/').slice(0, -1), isWindows) : null
  let inside = false
  for (const p of patterns) if (p.re.test(path) || (test !== null && mirrors(p, test, isWindows))) inside = !p.negate
  return inside
}

function mirrors(pattern: Pattern, test: string[], isWindows: boolean): boolean {
  const folder = patternFolder(pattern.source)
  if (folder === null) return false
  const scope = mirrorFolder(folder.parts, isWindows)
  if (scope.length === 0) return folder.plain
  return scope.length <= test.length && scope.every((part, i) => part === test[i])
}

// A pattern's literal folder: its segments before the first with a glob
// character, all of them for a plain folder (`src/auth`, `src/auth/`,
// `src/auth/**`). `plain`: the pattern names a folder and nothing more.
function patternFolder(source: string): { parts: string[]; plain: boolean } | null {
  let body = source.trim().replace(/\\/g, '/').replace(/^!/, '').replace(/^(\.\/|\/)+/, '')
  if (body.endsWith('/**')) body = body.slice(0, -3)
  const parts = body.split('/').filter(s => s !== '' && s !== '.')
  const glob = parts.findIndex(s => /[*?[]/.test(s))
  if (glob < 0) return { parts, plain: true }
  if (glob === 0) return null
  return { parts: parts.slice(0, glob), plain: false }
}

// A folder with its test folders dropped, then a leading `src`; folded on Windows.
function mirrorFolder(parts: readonly string[], isWindows: boolean): string[] {
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s)
  const kept = parts.map(fold).filter(s => s !== '' && !TEST_FOLDERS.has(s))
  return kept[0] === 'src' ? kept.slice(1) : kept
}

// `file`: Edit, Write or NotebookEdit, before it runs. `shell`: a file a shell
// command changed, seen after the run. `shell-before`: a literal write target
// parsed from a command, before the run.
export type Kind = 'file' | 'shell' | 'shell-before'

// `tell`: when Claude hears about it. `now` rides on the call's result;
// `next-prompt` on the next user prompt. A deny's reason is Claude's error.
export type Action = { deny: boolean; flag: boolean; tell: 'now' | 'next-prompt' | null }

const NOTHING: Action = { deny: false, flag: false, tell: null }

export function decide(mode: Mode, kind: Kind, where: Where): Action {
  if (where.kind !== 'out') return NOTHING
  if (kind === 'shell-before') return mode === 'C' ? { deny: true, flag: true, tell: null } : NOTHING
  if (kind === 'shell') return { deny: false, flag: true, tell: mode === 'A' ? null : 'next-prompt' }
  if (mode === 'C') return { deny: true, flag: true, tell: null }
  return { deny: false, flag: true, tell: mode === 'B' ? 'now' : null }
}

function under(dir: string, path: string, isWindows: boolean): boolean {
  return dir !== '' && relativeTo(dir, path, isWindows) !== undefined
}
