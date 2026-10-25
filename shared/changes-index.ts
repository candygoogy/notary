// Another mod's view of Changes' index (`{ plugin: 'changes', key: 'index' }`):
// only the fields read here, read defensively, since the index belongs to
// Changes and a mod can't trust another's shape. Pure.

export type ChangesEditView = {
  seq: number
  turnId: string
  toolUseId: string
  tool: string
  via: string
  path: string
  agentId?: string
}

export type ChangesIndexView = { edits: readonly ChangesEditView[] }

export type ShellEdit = {
  seq: number
  turnId: string
  toolUseId: string
  tool: string
  path: string
  // Found by the turn's sweep: no single call explains it.
  unattributed: boolean
  agentId?: string
}

// Files that shell commands (or the turn's sweep) changed after `seq`, oldest
// first. Changes records them only inside a git repository.
export function shellEditsSince(index: ChangesIndexView | null | undefined, seq: number): ShellEdit[] {
  const edits: unknown = (index as { edits?: unknown } | null | undefined)?.edits
  if (!Array.isArray(edits)) return []
  const out: ShellEdit[] = []
  for (const e of edits as unknown[]) {
    if (typeof e !== 'object' || e === null) continue
    const r = e as Record<string, unknown>
    if (typeof r.seq !== 'number' || r.seq <= seq || typeof r.path !== 'string') continue
    if (r.via !== 'shell' && r.via !== 'unattributed') continue
    out.push({
      seq: r.seq,
      turnId: String(r.turnId ?? ''),
      toolUseId: String(r.toolUseId ?? ''),
      tool: String(r.tool ?? ''),
      path: r.path,
      unattributed: r.via === 'unattributed',
      ...(typeof r.agentId === 'string' ? { agentId: r.agentId } : {}),
    })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

// The newest seq in the index, of any edit: a scope set now judges only what
// comes after it.
export function lastSeq(index: ChangesIndexView | null | undefined): number {
  const edits: unknown = (index as { edits?: unknown } | null | undefined)?.edits
  if (!Array.isArray(edits)) return 0
  let last = 0
  for (const e of edits as unknown[]) {
    const seq = (e as { seq?: unknown } | null)?.seq
    if (typeof seq === 'number' && seq > last) last = seq
  }
  return last
}
