// The /receipts command, parsed into a plan. Pure: register.tsx carries it out
// (`$` may only be passed to functions declared in register.tsx itself).

export const COMMAND = 'receipts'
export const ARGUMENT_HINT = '[mode A|B|C | verbosity quiet|all | on | off | smart on|off]'
export const DESCRIPTION = 'Receipts: show judged claims, or change the mode'
export const USAGE = `Usage: /receipts ${ARGUMENT_HINT}`

export type CommandPlan =
  | { kind: 'open' }
  | { kind: 'set'; key: 'receipts.mode' | 'receipts.verbosity' | 'receipts.enabled' | 'receipts.smartCheck'; value: string | boolean; done: string }
  | { kind: 'usage' }

export function parseCommand(args: string): CommandPlan {
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
