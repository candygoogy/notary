// The /receipts command, parsed into a plan. Pure: register.tsx carries it out
// (`$` may only be passed to functions declared in register.tsx itself).

export const COMMAND = 'receipts'
export const ARGUMENT_HINT = '[mode A|B|C | verbosity quiet|all | on | off | smart on|off | checks | check add <command> tests|build | check remove <command>]'
export const DESCRIPTION = 'Receipts: show judged claims, or change the mode'
export const USAGE = `Usage: /receipts ${ARGUMENT_HINT}`

import { checkEntry } from './core/checks.ts'
import type { DeclaredCheck } from './core/types.ts'

export type CommandPlan =
  | { kind: 'open' }
  | { kind: 'checks'; action: 'list' }
  | { kind: 'checks'; action: 'add'; check: DeclaredCheck }
  | { kind: 'checks'; action: 'remove'; prefix: string }
  | { kind: 'set'; key: 'receipts.mode' | 'receipts.verbosity' | 'receipts.enabled' | 'receipts.smartCheck'; value: string | boolean; done: string }
  | { kind: 'usage' }

export function parseCommand(args: string): CommandPlan {
  const checks = parseCheckCommand(args.trim())
  if (checks !== null) return checks
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [first, second] = words
  if (words.length === 0) return { kind: 'open' }
  if (words.length === 2 && first === 'mode' && ['a', 'b', 'c'].includes(second)) {
    const mode = second.toUpperCase()
    return { kind: 'set', key: 'receipts.mode', value: mode, done: `Receipts mode is now ${mode}.` }
  }
  if (words.length === 2 && first === 'verbosity' && (second === 'quiet' || second === 'all')) {
    return { kind: 'set', key: 'receipts.verbosity', value: second, done: `Receipts verbosity is now ${second}.` }
  }
  if (words.length === 1 && (first === 'on' || first === 'off')) {
    return { kind: 'set', key: 'receipts.enabled', value: first === 'on', done: `Receipts is now ${first}.` }
  }
  if (words.length === 2 && first === 'smart' && (second === 'on' || second === 'off')) {
    return { kind: 'set', key: 'receipts.smartCheck', value: second === 'on', done: `Receipts smart check is now ${second}.` }
  }
  return { kind: 'usage' }
}

// `checks`, `check list`, `check add <command> tests|build`, `check remove
// <command>`; the command as typed (case kept), in quotes or not.
function parseCheckCommand(args: string): CommandPlan | null {
  const match = /^(checks|check)(?:\s+(list|add|remove))?\s*(.*)$/i.exec(args)
  if (match === null) return null
  const action = (match[2] ?? 'list').toLowerCase()
  const rest = match[3].trim()
  if (action === 'list') return rest === '' ? { kind: 'checks', action: 'list' } : { kind: 'usage' }
  if (action === 'remove') {
    const prefix = unquote(rest)
    return prefix === '' ? { kind: 'usage' } : { kind: 'checks', action: 'remove', prefix }
  }
  const add = /^(.*\S)\s+(tests?|build)$/i.exec(rest)
  const prefix = add === null ? '' : unquote(add[1])
  if (add === null || prefix === '') return { kind: 'usage' }
  return { kind: 'checks', action: 'add', check: { kind: add[2].toLowerCase().startsWith('test') ? 'tests' : 'build', prefix } }
}

function unquote(text: string): string {
  return text.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
}

// What a checks plan does to the setting's checks: the list to store, if it
// changes, and the words to answer with. Pure.
export function editChecks(current: readonly DeclaredCheck[], plan: Extract<CommandPlan, { kind: 'checks' }>): { value?: string[]; text: string } {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (plan.action === 'list') {
    return current.length === 0
      ? { text: 'No checks declared. Add one with /receipts check add <command> tests|build.' }
      : { text: ['Receipts checks:', ...current.map(c => `  ${checkEntry(c)}`)].join('\n') }
  }
  if (plan.action === 'add') {
    const others = current.filter(c => !same(c.prefix, plan.check.prefix))
    return { value: [...others, plan.check].map(checkEntry), text: `Receipts now counts ${plan.check.prefix} as a ${plan.check.kind === 'tests' ? 'test' : 'build'} check.` }
  }
  const kept = current.filter(c => !same(c.prefix, plan.prefix))
  if (kept.length === current.length) return { text: `No check named ${plan.prefix}.` }
  return { value: kept.map(checkEntry), text: `Receipts no longer counts ${plan.prefix} as a check.` }
}
