// Pure updates and views over the Changes index (spec §3, §5.1, §5.2).
// Every update returns a new index and leaves the one it was given alone;
// no field is ever set to undefined, so the index survives `$.state` as is.

import {
  KEY_SEP,
  REVERT_TURN,
  sameContent,
  statusKey,
  type AgentNode,
  type Content,
  type EditRecord,
  type FileStatus,
  type Index,
  type TurnRecord,
  type UntrackedRecord,
  type UserAction,
  type Via,
} from './model.ts'

export const MAX_TURNS = 200
// About 450 characters each in $.state, so 5,000 stay near 2.3 MB.
export const MAX_EDITS = 5000
// Stored prompts are cut to this: the pane shows a line of them, and a long
// pasted prompt must not fill $.state.
export const PROMPT_CHARS = 200
export const MAX_UNTRACKED = 200

// An edit as the wiring reports it; the index assigns `seq` and, unless the
// caller names one (the turn sweep), the turn.
export type EditInput = Omit<EditRecord, 'seq' | 'turnId' | 'interleaved'> & { turnId?: string }

// One file in one turn: from the first edit's before to the last edit's after.
export type FileChange = {
  turnId: string
  key: string
  path: string
  before: Content
  after: Content
  edits: EditRecord[]
  agentIds: string[]
  status: FileStatus
  interleaved: boolean
  // Consecutive edits don't chain: something else changed the file between them.
  chainBroken: boolean
  isNoop: boolean
}

export type CallNode = { kind: 'call'; toolUseId: string; tool: string; via: Via; agentId?: string; seq: number; keys: string[] }
export type AgentTreeNode = {
  kind: 'agent'
  agentId: string
  label?: string
  parentToolUseId?: string
  seq: number
  keys: string[]
  children: TimelineNode[]
}
export type TimelineNode = CallNode | AgentTreeNode

export type TimelineRow =
  | { kind: 'turn'; turn: TurnRecord; nodes: TimelineNode[]; files: FileChange[]; untracked: UntrackedRecord[] }
  | { kind: 'action'; action: UserAction }

export function openTurn(index: Index, input: { turnId: string; prompt: string; at: number }): Index {
  const turn: TurnRecord = {
    turnId: input.turnId,
    seq: index.nextSeq,
    kind: 'turn',
    ordinal: index.nextOrdinal,
    prompt: input.prompt.slice(0, PROMPT_CHARS),
    startedAt: input.at,
  }
  return trim({
    ...index,
    turns: [...index.turns, turn],
    openTurnId: input.turnId,
    nextSeq: index.nextSeq + 1,
    nextOrdinal: index.nextOrdinal + 1,
  })
}

export function closeTurn(index: Index, input: { turnId: string; at: number; reason: string }): Index {
  const turns = index.turns.map(t => (t.turnId === input.turnId ? { ...t, endedAt: input.at, reason: input.reason } : t))
  if (index.openTurnId !== input.turnId) return { ...index, turns }
  const { openTurnId: _closed, ...rest } = index
  return { ...rest, turns }
}

// Records the agent an `Agent` tool call launched: it belongs to the turn of
// whoever spawned it (the open main turn, or the spawning agent's turn).
export function linkAgent(index: Index, input: { agentId: string; parentToolUseId?: string; spawnedBy?: string; label?: string }): Index {
  // The agent's first edit can land before its spawn's result does: it was
  // recorded then with no parent, so fill in what the spawn knows. Its turn
  // stays, since its edits are already filed under it.
  const known = index.agents.find(a => a.agentId === input.agentId)
  if (known) {
    const filled: AgentNode = { ...known }
    if (filled.parentToolUseId === undefined && input.parentToolUseId !== undefined) filled.parentToolUseId = input.parentToolUseId
    if (filled.parentAgentId === undefined && input.spawnedBy !== undefined) filled.parentAgentId = input.spawnedBy
    if (filled.label === undefined && input.label !== undefined) filled.label = input.label
    return { ...index, agents: index.agents.map(a => (a === known ? filled : a)) }
  }
  let next = index
  let turnId: string
  if (input.spawnedBy !== undefined) {
    ;({ index: next, turnId } = turnOfAgent(next, input.spawnedBy))
  } else {
    ;({ index: next, turnId } = turnForMain(next, input.agentId))
  }
  const agent: AgentNode = { agentId: input.agentId, turnId, seq: next.nextSeq }
  if (input.parentToolUseId !== undefined) agent.parentToolUseId = input.parentToolUseId
  if (input.spawnedBy !== undefined) agent.parentAgentId = input.spawnedBy
  if (input.label !== undefined) agent.label = input.label
  return { ...next, agents: [...next.agents, agent], nextSeq: next.nextSeq + 1 }
}

export function addEdit(index: Index, input: EditInput): Index {
  let next = index
  let turnId: string
  if (input.turnId !== undefined) turnId = input.turnId
  else if (input.agentId !== undefined) ({ index: next, turnId } = turnOfAgent(next, input.agentId))
  else ({ index: next, turnId } = turnForMain(next, 'main'))

  const record: EditRecord = { ...input, turnId, seq: next.nextSeq }
  let edits = next.edits

  // Interleaving: the last edit of this file finished after this one began,
  // and this one's before is not what that one left.
  const previous = lastEditOf(edits, input.key)
  if (previous && previous.at > input.startedAt && sameContent(previous.after, input.before) === false) {
    record.interleaved = true
    edits = edits.map(e => (e === previous ? { ...e, interleaved: true } : e))
  }
  return trim({ ...next, edits: [...edits, record], nextSeq: next.nextSeq + 1 })
}

// A call whose changes were not recorded: filed like an edit (its agent's
// turn, else the open turn), kept to the newest MAX_UNTRACKED.
export function addUntracked(index: Index, input: Omit<UntrackedRecord, 'seq' | 'turnId'> & { agentId?: string; turnId?: string }): Index {
  let next = index
  let turnId: string
  if (input.turnId !== undefined) turnId = input.turnId
  else if (input.agentId !== undefined) ({ index: next, turnId } = turnOfAgent(next, input.agentId))
  else ({ index: next, turnId } = turnForMain(next, 'main'))
  const record: UntrackedRecord = { seq: next.nextSeq, turnId, toolUseId: input.toolUseId, tool: input.tool, reason: input.reason, at: input.at }
  return { ...next, untracked: [...next.untracked, record].slice(-MAX_UNTRACKED), nextSeq: next.nextSeq + 1 }
}

export function addAction(index: Index, action: Omit<UserAction, 'seq'>): Index {
  return { ...index, actions: [...index.actions, { ...action, seq: index.nextSeq }], nextSeq: index.nextSeq + 1 }
}

export function setStatus(index: Index, refs: { turnId: string; key: string }[], status: FileStatus): Index {
  const next = { ...index.status }
  for (const ref of refs) {
    if (status === 'pending') delete next[statusKey(ref.turnId, ref.key)]
    else next[statusKey(ref.turnId, ref.key)] = status
  }
  return { ...index, status: next }
}

export function statusOf(index: Index, turnId: string, key: string): FileStatus {
  return index.status[statusKey(turnId, key)] ?? 'pending'
}

// The turn's files in the order first changed; `node` narrows to one tool
// call (its toolUseId) or one agent and the agents it spawned.
export function turnFiles(index: Index, turnId: string, node?: string): FileChange[] {
  let edits = index.edits.filter(e => e.turnId === turnId)
  if (node !== undefined) {
    const agents = agentAndDescendants(index, node)
    edits = edits.filter(e => e.toolUseId === node || (e.agentId !== undefined && agents.has(e.agentId)))
  }
  const byKey = new Map<string, EditRecord[]>()
  for (const e of edits) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e])
  return [...byKey.entries()].map(([key, list]) => {
    const first = list[0]!
    const last = list[list.length - 1]!
    const interleaved = list.some(e => e.interleaved === true)
    const chainBroken = !interleaved && list.some((e, i) => i > 0 && sameContent(list[i - 1]!.after, e.before) === false)
    return {
      turnId,
      key,
      path: last.path,
      before: first.before,
      after: last.after,
      edits: list,
      agentIds: [...new Set(list.flatMap(e => (e.agentId === undefined ? [] : [e.agentId])))],
      status: statusOf(index, turnId, key),
      interleaved,
      chainBroken,
      isNoop: sameContent(first.before, last.after) === true,
    }
  })
}

// Newest first: each turn (or background bucket) with its tree of calls and
// agents, and the person's actions between them.
export function timeline(index: Index): TimelineRow[] {
  const rows: (TimelineRow & { seq: number })[] = [
    ...index.turns.map(turn => ({
      kind: 'turn' as const,
      seq: turn.seq,
      turn,
      nodes: treeOf(index, turn.turnId),
      files: turnFiles(index, turn.turnId),
      untracked: index.untracked.filter(u => u.turnId === turn.turnId),
    })),
    ...index.actions.map(action => ({ kind: 'action' as const, seq: action.seq, action })),
  ]
  return rows.sort((a, b) => b.seq - a.seq).map(({ seq: _seq, ...row }) => row as TimelineRow)
}

function treeOf(index: Index, turnId: string): TimelineNode[] {
  const edits = index.edits.filter(e => e.turnId === turnId)
  const agents = index.agents.filter(a => a.turnId === turnId)
  const agentIds = new Set(agents.map(a => a.agentId))

  const callsOf = (agentId: string | undefined): CallNode[] => {
    const calls = new Map<string, CallNode>()
    for (const e of edits) {
      if (e.agentId !== agentId) continue
      const call = calls.get(e.toolUseId)
      if (call) {
        if (!call.keys.includes(e.key)) call.keys.push(e.key)
        continue
      }
      const node: CallNode = { kind: 'call', toolUseId: e.toolUseId, tool: e.tool, via: e.via, seq: e.seq, keys: [e.key] }
      if (e.agentId !== undefined) node.agentId = e.agentId
      calls.set(e.toolUseId, node)
    }
    return [...calls.values()]
  }

  const agentNode = (agent: AgentNode): AgentTreeNode => {
    const children = [
      ...callsOf(agent.agentId),
      ...agents.filter(a => a.parentAgentId === agent.agentId).map(agentNode),
    ].sort((a, b) => a.seq - b.seq)
    const node: AgentTreeNode = {
      kind: 'agent',
      agentId: agent.agentId,
      seq: agent.seq,
      keys: [...new Set(children.flatMap(c => c.keys))],
      children,
    }
    if (agent.label !== undefined) node.label = agent.label
    if (agent.parentToolUseId !== undefined) node.parentToolUseId = agent.parentToolUseId
    return node
  }

  const roots = agents.filter(a => a.parentAgentId === undefined || !agentIds.has(a.parentAgentId))
  return [...callsOf(undefined), ...roots.map(agentNode)].sort((a, b) => a.seq - b.seq)
}

function agentAndDescendants(index: Index, agentId: string): Set<string> {
  const found = new Set<string>()
  if (!index.agents.some(a => a.agentId === agentId)) return found
  const queue = [agentId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (found.has(id)) continue
    found.add(id)
    for (const a of index.agents) if (a.parentAgentId === id) queue.push(a.agentId)
  }
  return found
}

function lastEditOf(edits: EditRecord[], key: string): EditRecord | undefined {
  for (let i = edits.length - 1; i >= 0; i--) if (edits[i]!.key === key) return edits[i]
  return undefined
}

// The turn an agent's work belongs to; an agent with no recorded spawn is
// recorded now against the open turn, or a background bucket of its own.
function turnOfAgent(index: Index, agentId: string): { index: Index; turnId: string } {
  const known = index.agents.find(a => a.agentId === agentId)
  if (known) return { index, turnId: known.turnId }
  const { index: next, turnId } = turnForMain(index, agentId)
  const agent: AgentNode = { agentId, turnId, seq: next.nextSeq }
  return { index: { ...next, agents: [...next.agents, agent], nextSeq: next.nextSeq + 1 }, turnId }
}

// The open main turn, else the background bucket named for `owner`.
function turnForMain(index: Index, owner: string): { index: Index; turnId: string } {
  if (index.openTurnId !== undefined) return { index, turnId: index.openTurnId }
  const turnId = `background:${owner}`
  if (index.turns.some(t => t.turnId === turnId)) return { index, turnId }
  const bucket: TurnRecord = { turnId, seq: index.nextSeq, kind: 'background', ordinal: 0, prompt: '', startedAt: 0 }
  return { index: trim({ ...index, turns: [...index.turns, bucket], nextSeq: index.nextSeq + 1 }), turnId }
}

// Keeps at most MAX_TURNS turns and MAX_EDITS edits, dropping the oldest
// turns whole. A turn that is open, or whose agents are still running, is
// never dropped: their edits still arrive. A dropped turn's changes stop being
// revertible, and a later turn whose chain ran through them is refused by
// planRevert's link check, never restored wrongly.
function trim(index: Index): Index {
  let next = index
  while (next.turns.length > MAX_TURNS || next.edits.length > MAX_EDITS) {
    const dropped = dropOldest(next)
    if (dropped === null) break
    next = dropped
  }
  return next
}

// The index with its oldest droppable turn removed, or null when none is.
function dropOldest(index: Index): Index | null {
  const running = new Set(index.agents.filter(a => a.endedAt === undefined).map(a => a.turnId))
  const victim = [...index.turns]
    .sort((a, b) => a.seq - b.seq)
    .find(t => t.turnId !== index.openTurnId && !running.has(t.turnId))
  if (!victim) return null
  const gone = victim.turnId
  const turns = index.turns.filter(t => t.turnId !== gone)
  // Reverts older than every remaining turn have nothing left to chain to.
  const oldest = Math.min(...turns.map(t => t.seq), index.nextSeq)
  const status: Record<string, FileStatus> = {}
  for (const [k, v] of Object.entries(index.status)) if (k.slice(0, k.indexOf(KEY_SEP)) !== gone) status[k] = v
  const keep = (e: EditRecord) => (e.via === 'revert' ? e.seq > oldest : e.turnId !== gone)
  const trimmed = { ...index.trimmed }
  for (const e of index.edits) if (!keep(e)) trimmed[e.key] = Math.max(trimmed[e.key] ?? 0, e.seq)
  return {
    ...index,
    turns,
    trimmed,
    edits: index.edits.filter(keep),
    agents: index.agents.filter(a => a.turnId !== gone),
    untracked: index.untracked.filter(u => u.turnId !== gone),
    actions: index.actions
      .map(a => ({ ...a, turnIds: a.turnIds.filter(id => id !== gone) }))
      .filter(a => a.turnIds.length > 0),
    status,
  }
}

// What `$.state` holds per value is 4,194,304 characters; this leaves room.
export const STATE_BUDGET_CHARS = 4_000_000

// The index trimmed until its JSON fits `budget`; `fits` false when nothing
// droppable is left and it still doesn't (the caller then skips the write).
// Measured on the JSON itself: a count of records says nothing about a long
// path or prompt.
export function fitToSize(index: Index, budget = STATE_BUDGET_CHARS): { index: Index; fits: boolean } {
  let next = index
  while (JSON.stringify(next).length > budget) {
    const dropped = dropOldest(next)
    if (dropped === null) return { index: next, fits: false }
    next = dropped
  }
  return { index: next, fits: true }
}

// The JSON characters `next` adds to `prev` when it only appended records
// (and changed statuses or counters), so a save can skip measuring the whole
// index; null when anything else changed (a trim, a record replaced at either
// end) and only a full measure can tell. A record replaced in the middle (an
// `interleaved` flag) is missed by a few characters: the caller re-measures
// in full every so often.
export function appendedSize(prev: Index, next: Index): number | null {
  if (prev.trimmed !== next.trimmed) return null
  let size = 64
  for (const list of ['turns', 'edits', 'agents', 'actions', 'untracked'] as const) {
    const before: readonly unknown[] = prev[list]
    const after: readonly unknown[] = next[list]
    if (before === after) continue
    if (after.length < before.length) return null
    if (before.length > 0 && (after[0] !== before[0] || after[before.length - 1] !== before[before.length - 1])) return null
    for (let i = before.length; i < after.length; i++) size += JSON.stringify(after[i]).length + 1
  }
  if (prev.status !== next.status) size += Math.max(0, JSON.stringify(next.status).length - JSON.stringify(prev.status).length)
  return size
}

// The agent's run completed (its turn.complete carried its agentId).
export function closeAgent(index: Index, agentId: string, at: number): Index {
  if (!index.agents.some(a => a.agentId === agentId && a.endedAt === undefined)) return index
  return trim({ ...index, agents: index.agents.map(a => (a.agentId === agentId ? { ...a, endedAt: at } : a)) })
}

// A revert that landed: the disk transition joins the file's chain, the
// reverted changes are marked, and the action goes on the timeline.
export function recordRevert(
  index: Index,
  input: { key: string; path: string; before: Content; after: Content; refs: { turnId: string; key: string }[]; at: number },
): Index {
  const transition: EditRecord = {
    seq: index.nextSeq,
    turnId: REVERT_TURN,
    toolUseId: `revert:${index.nextSeq}`,
    tool: 'Changes',
    via: 'revert',
    path: input.path,
    key: input.key,
    before: input.before,
    after: input.after,
    startedAt: input.at,
    at: input.at,
  }
  let next: Index = { ...index, edits: [...index.edits, transition], nextSeq: index.nextSeq + 1 }
  next = setStatus(next, input.refs, 'reverted')
  next = addAction(next, { kind: 'revert', turnIds: [...new Set(input.refs.map(r => r.turnId))], key: input.key, path: input.path, at: input.at })
  return trim(next)
}
