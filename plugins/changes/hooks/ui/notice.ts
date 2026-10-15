// The line the pane shows after a revert, in the spec's words (§5.4, §6).
// Pure: `turnName` turns a turn id into what the person sees ("#12").

import { REVERT_TURN } from '../core/model.ts'
import type { RevertOutcome } from '../io/restore.ts'

export function revertNotice(outcome: RevertOutcome, path: string, turnName: (turnId: string) => string): string {
  const side = (turnId: string) => (turnId === REVERT_TURN ? 'your earlier revert' : turnName(turnId))
  const turns = (ids: readonly string[]) => ids.map(turnName).join(', ')
  if (outcome.ok) return `Reverted ${path} (${turns(outcome.refs.map(r => r.turnId))}).`
  switch (outcome.reason) {
    case 'changed-since':
      return `${path} was also changed by ${turns(outcome.otherTurns)}. Revert those turns together, or none.`
    case 'user-changed-between':
      return `${path} was changed outside Claude between ${side(outcome.between[0])} and ${side(outcome.between[1])}. Reverting also undoes that change.`
    case 'history-trimmed':
      return `The history of ${path} between ${side(outcome.between[0])} and ${side(outcome.between[1])} was trimmed. Reverting also undoes what is no longer listed.`
    case 'unverifiable-link':
      return `Can't confirm nothing else changed ${path} between ${side(outcome.between[0])} and ${side(outcome.between[1])} (it may have been committed in between).`
    case 'changed-externally':
      return `${path} changed since Claude's last edit, so it was left alone.`
    case 'too-large':
      return `${path} is too large to restore (over 4 MiB, not clean in git before).`
    case 'no-snapshot':
      return `There is no saved copy of ${path} from before that turn.`
    case 'already-reverted':
      return `${path} was already reverted for that turn.`
    case 'nothing-to-revert':
      return `${path} has nothing to revert there.`
    case 'io':
      return `Reverting ${path} could not be confirmed: check the file before going on.`
  }
}

// A whole-turn revert, as planned at the first press or done at the second.
// `path` turns a file's path into what the pane shows.
export type TurnRevertSummary = {
  turn: string
  reverted: string[]
  // Each skipped file with why: a refusal's own words, or that it is kept.
  skipped: Array<{ path: string; why: RevertOutcome | 'kept' }>
  stopped: string | null
  notTried: number
}

export function revertAllNotice(s: TurnRevertSummary, turnName: (turnId: string) => string): string {
  const parts: string[] = []
  const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`
  parts.push(s.reverted.length > 0 ? `Reverted ${files(s.reverted.length)} of ${s.turn}.` : `Nothing in ${s.turn} was reverted.`)
  if (s.stopped !== null) {
    parts.push(`Stopped at ${s.stopped}: the write could not be confirmed, so ${files(s.notTried)} more ${s.notTried === 1 ? 'was' : 'were'} left alone. Check that file before going on.`)
  }
  if (s.skipped.length > 0) parts.push(`Skipped ${files(s.skipped.length)}: ${skippedWords(s.skipped, turnName)}`)
  return parts.join(' ')
}

// The first press: what the second will do, before anything is written.
export function revertAllPlanNotice(s: Pick<TurnRevertSummary, 'turn' | 'skipped'> & { writes: number }, turnName: (turnId: string) => string): string {
  if (s.writes === 0) return `Nothing in ${s.turn} can be reverted. ${skippedWords(s.skipped, turnName)}`
  return s.skipped.length === 0 ? '' : `Revert all skips ${s.skipped.length} of ${s.turn}'s files: ${skippedWords(s.skipped, turnName)}`
}

function skippedWords(skipped: TurnRevertSummary['skipped'], turnName: (turnId: string) => string): string {
  return skipped.map(({ path, why }) => (why === 'kept' ? `${path} is kept.` : revertNotice(why, path, turnName))).join(' ')
}
