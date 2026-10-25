// What a revert must do, decided from the index and the file as it is on
// disk now (spec §5.4). Pure: the io layer executes the plan and verifies.
//
// A file's history is its chain of transitions in edit order (seq), across
// turns: Claude's edits and the reverts already run from the pane. A revert
// restores the before of the first transition it undoes, so it is only safe
// when every transition from there on links to the next (nothing outside
// that chain changed the file) and the disk holds the last one's after.

import { REVERT_TURN, sameContent, type Content, type EditRecord, type Index } from './model.ts'
import { statusOf } from './timeline.ts'

export type Restore =
  | { kind: 'write-text'; hash: string }
  | { kind: 'write-bytes'; hash: string }
  | { kind: 'delete' }
  | { kind: 'git-restore'; commit: string; oid: string }
  // The disk already holds the target; only the statuses change.
  | { kind: 'none' }

export type RevertRef = { turnId: string; key: string }

export type RevertPlan =
  // `widenedTo`: turns that started before this one and were pulled in by
  // 'turnAndLater' (an async agent's earlier edits); the confirmation names
  // every turn in `refs`.
  | { ok: true; target: Content; restore: Restore; refs: RevertRef[]; widenedTo?: string[] }
  // Other turns changed the file inside this change's span, before or after
  // it in time; 'turnAndLater' reverts them together.
  | { ok: false; reason: 'changed-since'; otherTurns: string[] }
  // Two transitions in the span don't link, so reverting would also undo
  // whatever happened between them; `acceptOutsideChanges` goes ahead anyway.
  // Why, as far as the index can tell:
  //   history-trimmed      Claude's edits between them were trimmed away;
  //   unverifiable-link    the two sides can't be compared (a git blob
  //                        against a hash, after a commit; an unreadable capture);
  //   user-changed-between something outside Claude changed the file.
  // `between` names the two sides' turns; REVERT_TURN is an earlier revert.
  | { ok: false; reason: 'user-changed-between' | 'unverifiable-link' | 'history-trimmed'; between: [string, string] }
  | {
      ok: false
      reason: 'changed-externally' | 'too-large' | 'no-snapshot' | 'io' | 'already-reverted' | 'nothing-to-revert'
    }

export type RevertOptions = {
  // The person confirmed that changes outside the chain may be undone too.
  acceptOutsideChanges?: boolean
}

// mode 'turn' undoes this turn's change to the file alone, and only when no
// other turn's live edit to it falls inside the span; 'turnAndLater' undoes
// everything from the change's first edit on, pulling in every turn with a
// live edit in that span (an async agent's turn can start before it).
export function planRevert(
  index: Index,
  ref: RevertRef,
  mode: 'turn' | 'turnAndLater',
  current: Content,
  options: RevertOptions = {},
): RevertPlan {
  const history = index.edits.filter(e => e.key === ref.key).sort((a, b) => a.seq - b.seq)
  const own = history.filter(e => e.turnId === ref.turnId && e.via !== 'revert')
  if (own.length === 0) return { ok: false, reason: 'nothing-to-revert' }
  if (statusOf(index, ref.turnId, ref.key) === 'reverted') return { ok: false, reason: 'already-reverted' }
  if ('unreadable' in current) return { ok: false, reason: current.unreadable === 'too-large' ? 'too-large' : 'io' }

  const isLive = (e: EditRecord) => e.via !== 'revert' && statusOf(index, e.turnId, e.key) !== 'reverted'
  const firstLiveSeq = (turnId: string) => Math.min(...history.filter(e => e.turnId === turnId && isLive(e)).map(e => e.seq))

  let start = own[0]!.seq
  const involved = new Set([ref.turnId])
  if (mode === 'turnAndLater') {
    // Widen to the first live edit of every turn with a live edit in the span,
    // until no turn reaches further back.
    for (let widened = true; widened; ) {
      widened = false
      for (const e of history) {
        if (e.seq < start || !isLive(e) || involved.has(e.turnId)) continue
        involved.add(e.turnId)
        const first = firstLiveSeq(e.turnId)
        if (first < start) {
          start = first
          widened = true
        }
      }
    }
  }

  const span = history.filter(e => e.seq >= start)
  const others = [...new Set(span.filter(e => isLive(e) && !involved.has(e.turnId)).map(e => e.turnId))]
  if (others.length > 0) return { ok: false, reason: 'changed-since', otherTurns: others }

  if (!options.acceptOutsideChanges) {
    for (let i = 1; i < span.length; i++) {
      const link = sameContent(span[i - 1]!.after, span[i]!.before)
      if (link === true) continue
      const between: [string, string] = [span[i - 1]!.turnId, span[i]!.turnId]
      if ((index.trimmed[ref.key] ?? 0) > span[i - 1]!.seq) return { ok: false, reason: 'history-trimmed', between }
      return { ok: false, reason: link === null ? 'unverifiable-link' : 'user-changed-between', between }
    }
  }

  if (sameContent(current, span[span.length - 1]!.after) !== true) return { ok: false, reason: 'changed-externally' }

  const target = span[0]!.before
  if (mode === 'turn' && span.length === own.length && sameContent(target, current) === true) {
    return { ok: false, reason: 'nothing-to-revert' }
  }
  const refs = [...involved]
    .filter(turnId => turnId !== REVERT_TURN && span.some(e => e.turnId === turnId && isLive(e)))
    .sort((a, b) => firstLiveSeq(a) - firstLiveSeq(b))
    .map(turnId => ({ turnId, key: ref.key }))
  const widenedTo = refs.map(r => r.turnId).filter(turnId => firstLiveSeq(turnId) < own[0]!.seq)
  const plan = (restore: Restore): RevertPlan =>
    widenedTo.length > 0 ? { ok: true, target, restore, refs, widenedTo } : { ok: true, target, restore, refs }

  if (sameContent(current, target) === true) return plan({ kind: 'none' })
  if ('absent' in target) return plan({ kind: 'delete' })
  if ('git' in target) return plan({ kind: 'git-restore', commit: target.git.commit, oid: target.git.oid })
  if ('hash' in target) return plan({ kind: target.kind === 'text' ? 'write-text' : 'write-bytes', hash: target.hash })
  return { ok: false, reason: target.unreadable === 'too-large' ? 'too-large' : 'no-snapshot' }
}
