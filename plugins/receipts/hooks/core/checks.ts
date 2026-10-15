// The `checks` setting: commands the person declares as checks, each written
// `tests: <command>` or `build: <command>`. Pure.

import type { DeclaredCheck } from './types.ts'

const ENTRY = /^(tests?|build)\s*:\s*(\S.*)$/i

// Reads the setting as stored: a list of entries (`/config`, the command), or
// one text with entries split by `;` or new lines. An entry in neither form
// is returned in `invalid`, so it can be named rather than silently ignored.
export function parseChecks(value: unknown): { checks: DeclaredCheck[]; invalid: string[] } {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const checks: DeclaredCheck[] = []
  const invalid: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[;\n]/)) {
      const entry = part.trim()
      if (entry === '') continue
      const match = ENTRY.exec(entry)
      if (match === null) {
        invalid.push(entry)
        continue
      }
      checks.push({ kind: match[1].toLowerCase().startsWith('test') ? 'tests' : 'build', prefix: match[2].trim() })
    }
  }
  return { checks, invalid }
}

// The entry as the setting stores it.
export function checkEntry(check: DeclaredCheck): string {
  return `${check.kind}: ${check.prefix}`
}
