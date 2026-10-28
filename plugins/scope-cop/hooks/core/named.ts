// Approved edits. With a scope set, Claude stops at its edge and names the
// file it would need ("this also needs `src/api/auth.ts`, which is outside
// your scope"); the person says yes, and the next turn edits it. That edit is
// approved: logged in the pane, not flagged. Pure: register.tsx keeps the
// names in state and acts.

import type { Pattern } from '../shared/glob.ts'
import { classify, type Ctx, type Mode } from './scope.ts'

// The files one answer named outside the scope, as paths under the root.
// `answered`: the person has sent a prompt since that answer (their yes).
// `turnId`: the turn they hold for: the first main-loop turn after that
// prompt; null until it starts.
export type Named = { paths: string[]; turnId: string | null; answered?: boolean }

// A path token: an optional drive, then names joined by `/` or `\`. It must
// start a word, so a URL's path is never one. Backticks, quotes, a line
// number (`src/api/users.ts:38`) and brackets fall outside it.
const TOKEN = /(?<![\w.@+~\-:/\\])(?:[A-Za-z]:)?[\w.@+~-]*(?:[\\/][\w.@+~-]+)+/g

// The files `answer` names that are outside the scope, under the root, each
// once, in order. Only a path with a folder and a file name with an extension
// (or a leading dot, `.env`) counts; relative ones are under `cwd`, like a
// tool's. A bare file name (`auth.ts`) names nothing: when the answer also
// gives its folder, that path is already here. Paths with `..`, files outside
// the project, in the scope or always allowed are left out.
export function namedOutside(answer: string, cwd: string, ctx: Ctx, patterns: readonly Pattern[]): string[] {
  const named: string[] = []
  const fold = (s: string) => (ctx.isWindows ? s.toLowerCase() : s)
  for (const [token] of answer.matchAll(TOKEN)) {
    const parts = token.replace(/\\/g, '/').replace(/\.+$/, '').split('/')
    if (parts.includes('..') || !/\.\w/.test(parts.at(-1) ?? '')) continue
    const path = parts.filter((part, i) => part !== '.' && (part !== '' || i === 0)).join('/')
    const full = /^(?:[A-Za-z]:)?\//.test(path) ? path : `${cwd.replace(/\/+$/, '')}/${path}`
    const where = classify(full, ctx, patterns)
    if (where.kind !== 'out' || where.rel === null) continue
    const rel = where.rel
    if (!named.some(p => fold(p) === fold(rel))) named.push(rel)
  }
  return named
}

// When the person sends a prompt: names still waiting count as answered.
export function namedOnPrompt(named: Named | null): Named | null {
  return named !== null && named.turnId === null ? { ...named, answered: true } : named
}

// At a main-loop turn's start: answered names hold for this turn; names an
// earlier turn held lapse, so they never outlive the turn after the yes. A
// turn that starts without a prompt from the person (a continuation) leaves
// waiting names waiting.
export function namedAtTurnStart(named: Named | null, turnId: string): Named | null {
  if (named === null || named.turnId !== null) return null
  return named.answered === true ? { ...named, turnId } : named
}

// An edit outside the scope, at `rel` under the root, is approved when the
// last answer named it and this is the turn after. Not in mode C, where
// approval is the band's [Allow file].
export function isApproved(named: Named | null, mode: Mode, rel: string | null, isWindows: boolean): boolean {
  if (named === null || named.turnId === null || mode === 'C' || rel === null) return false
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s)
  return named.paths.some(p => fold(p) === fold(rel))
}
