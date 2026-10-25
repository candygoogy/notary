// The /scope command's arguments. Pure: register.tsx checks the patterns
// (shared/glob.ts parsePattern) and acts.
//
//   /scope                      open the pane
//   /scope <pattern>...         set the scope
//   /scope add <pattern>...     widen it
//   /scope remove <pattern>...  drop patterns
//   /scope off                  clear it
//   /scope mode A|B|C           warn, warn and tell Claude, block

import type { Mode } from './scope.ts'

export type ScopeCommand =
  | { kind: 'show' }
  | { kind: 'set' | 'add' | 'remove'; patterns: string[] }
  | { kind: 'off' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'error'; message: string }

export function parseScopeCommand(args: string): ScopeCommand {
  const words = split(args)
  if (words === null) return { kind: 'error', message: 'A quote is not closed. Wrap a pattern with spaces in "quotes".' }
  if (words.length === 0) return { kind: 'show' }
  const [first = '', ...rest] = words
  switch (first.toLowerCase()) {
    case 'add':
    case 'remove':
      if (rest.length === 0) return { kind: 'error', message: `Usage: /scope ${first.toLowerCase()} <pattern>...` }
      return { kind: first.toLowerCase() as 'add' | 'remove', patterns: rest }
    case 'off':
      if (rest.length > 0) return { kind: 'error', message: 'Usage: /scope off (no patterns).' }
      return { kind: 'off' }
    case 'mode': {
      const mode = rest.length === 1 ? rest[0]!.toUpperCase() : ''
      if (mode !== 'A' && mode !== 'B' && mode !== 'C') return { kind: 'error', message: 'Usage: /scope mode A, B or C (warn; warn and tell Claude; block).' }
      return { kind: 'mode', mode }
    }
    default:
      return { kind: 'set', patterns: words }
  }
}

// Words split on whitespace; "double" or 'single' quotes keep spaces. Null
// when a quote is left open.
function split(args: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: string | null = null
  for (const ch of args) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += ch
      inWord = true
    }
  }
  if (quote !== null) return null
  if (inWord) words.push(current)
  return words
}

export const ARGUMENT_HINT = '[<pattern>... | add <pattern>... | remove <pattern>... | off | mode A|B|C]'
export const DESCRIPTION = 'Scope Cop: limit which files Claude edits in this conversation'
export const USAGE = `Usage: /scope ${ARGUMENT_HINT}`
