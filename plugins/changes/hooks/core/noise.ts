// Which changed files are worth a line above the prompt. Everything is
// tracked and shown in the pane; the band speaks only for code, so a turn
// that only touched notes, docs, logs, data or lockfiles stays quiet.

import { relativeTo } from './paths.ts'

const PROSE = /\.(md|mdx|markdown|rst|adoc|org)$/i
// Text files that are code or build input, not notes.
const TEXT_CODE = /^(cmakelists\.txt|(requirements|constraints)([-_.][\w.-]*)?\.txt|robots\.txt)$/i
const QUIET_EXT = /\.(txt|log|out|csv|tsv|lock)$/i
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'bun.lockb',
  'go.sum',
  'packages.lock.json',
])
// Matched only below the repository root or the session's folder, never on
// the absolute path (a project living under C:/Work/Build/ is still code).
const QUIET_FOLDERS = /(^|\/)(docs?|notes|\.claude|node_modules|dist|build|out|coverage|\.next|target)\//i

export function isCodePath(path: string, bases: readonly string[] = [], isWindows = false): boolean {
  const normal = path.replace(/\\/g, '/')
  const name = normal.slice(normal.lastIndexOf('/') + 1).toLowerCase()
  if (TEXT_CODE.test(name)) return true
  if (PROSE.test(name) || QUIET_EXT.test(name) || LOCKFILES.has(name)) return false
  for (const base of bases) {
    const rel = relativeTo(base, normal, isWindows)
    if (rel !== undefined) return !QUIET_FOLDERS.test(rel)
  }
  return true
}
