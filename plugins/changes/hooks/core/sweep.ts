// The turn sweep (spec §5.3 step 4): git status at turn.start and at
// turn.complete catches changes no tool call recorded (a background command,
// a tool we don't know, the person's editor during the turn).

import { sameContent, type Content, type Index } from './model.ts'

// The changes the index does not account for: a change is accounted for when
// the file's last recorded transition, in any turn, left exactly this content
// (an async agent files its edits under the turn that spawned it).
export function unexplained<T extends { key: string; after: Content }>(index: Index, changes: readonly T[]): T[] {
  return changes.filter(change => {
    let last: Content | undefined
    let lastSeq = -1
    for (const e of index.edits) {
      if (e.key === change.key && e.seq > lastSeq) {
        last = e.after
        lastSeq = e.seq
      }
    }
    return last === undefined || sameContent(last, change.after) !== true
  })
}
