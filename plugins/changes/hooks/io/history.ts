// A conversation's history kept on disk, so a resumed conversation
// (`claude --resume`, `--continue`, `/resume`) shows its turns again
// (docs/notes/changes-history-persist.md). It lives next to the copies, in
// `<config>/plugin-data/notary-changes/<sessionId>/index.json`.
//
// One process writes it at a time: the holder of `lease.json`. A second
// process on the same conversation shows the history but never writes it.

import type { Index } from '../core/model.ts'
import { MAX_READ_BYTES } from './blobs.ts'
import type { Platform, Ports } from './ports.ts'
import { moveInto, TMP_SUFFIX } from './restore.ts'

export const HISTORY_FORMAT = 1
// A lease not renewed for this long belongs to a process that is gone (a
// crash, a killed terminal): a live holder renews it every LEASE_RENEW_MS.
export const LEASE_STALE_MS = 10 * 60 * 1000
export const LEASE_RENEW_MS = 60 * 1000

const historyFile = (store: string) => `${store}/index.json`
const leaseFile = (store: string) => `${store}/lease.json`

export type Loaded = { index: Index } | { unreadable: 'corrupt' | 'format' | 'other-session' } | null

// Writes the history as one file in one rename: the text goes to a temp file,
// which then replaces index.json, so a crash leaves the old file or the new,
// never half of one. Refused (false) when it would be too large to read back.
export async function saveHistory(io: Ports, platform: Platform, store: string, sessionId: string, index: Index, now: number): Promise<boolean> {
  const text = JSON.stringify({ format: HISTORY_FORMAT, sessionId, savedAt: now, index })
  if (new TextEncoder().encode(text).length > MAX_READ_BYTES) return false
  const tmp = `${historyFile(store)}${TMP_SUFFIX}`
  try {
    await io.fs.write(tmp, text)
    return await moveInto(io, platform, tmp, historyFile(store))
  } catch {
    return false
  }
}

// The history saved for this conversation: null when there is none; a file
// that does not parse, is of another format or another conversation, or does
// not hold an index of the right shape, is refused whole, never half-loaded.
export async function loadHistory(io: Ports, store: string, sessionId: string): Promise<Loaded> {
  let text: string
  try {
    if (!(await io.fs.exists(historyFile(store)))) return null
    text = String(await io.fs.read(historyFile(store)))
  } catch {
    return { unreadable: 'corrupt' }
  }
  let saved: unknown
  try {
    saved = JSON.parse(text)
  } catch {
    return { unreadable: 'corrupt' }
  }
  if (!isRecord(saved)) return { unreadable: 'corrupt' }
  if (saved.format !== HISTORY_FORMAT) return { unreadable: 'format' }
  if (saved.sessionId !== sessionId) return { unreadable: 'other-session' }
  return isIndex(saved.index) ? { index: saved.index } : { unreadable: 'corrupt' }
}

export type Lease = { token: string; at: number }

// Takes the lease, or answers that another live process holds it. A lease
// that is missing, released (at 0), our own, or not renewed within
// LEASE_STALE_MS is taken. The write is read back: of two processes taking
// it at once, the one that reads another token is not the holder. A holder
// checks the lease again before each save (holdsLease), so a takeover is
// seen before anything is written.
export async function takeLease(io: Ports, store: string, token: string, now: number): Promise<boolean> {
  const current = await readLease(io, store)
  if (current !== null && current.token !== token && current.at > 0 && now - current.at < LEASE_STALE_MS) return false
  try {
    await io.fs.write(leaseFile(store), JSON.stringify({ token, at: now }))
  } catch {
    return false
  }
  return (await readLease(io, store))?.token === token
}

export async function holdsLease(io: Ports, store: string, token: string): Promise<boolean> {
  return (await readLease(io, store))?.token === token
}

// Renews the lease (a heartbeat), only while it is still ours.
export async function renewLease(io: Ports, store: string, token: string, now: number): Promise<boolean> {
  if (!(await holdsLease(io, store, token))) return false
  try {
    await io.fs.write(leaseFile(store), JSON.stringify({ token, at: now }))
    return true
  } catch {
    return false
  }
}

// Gives the lease up at the session's end (one small write), so the next
// process takes it at once.
export async function releaseLease(io: Ports, store: string, token: string): Promise<void> {
  try {
    if (await holdsLease(io, store, token)) await io.fs.write(leaseFile(store), JSON.stringify({ token, at: 0 }))
  } catch {
    // Best effort: an unreleased lease goes stale on its own.
  }
}

async function readLease(io: Ports, store: string): Promise<Lease | null> {
  try {
    if (!(await io.fs.exists(leaseFile(store)))) return null
    const lease: unknown = JSON.parse(String(await io.fs.read(leaseFile(store))))
    return isRecord(lease) && typeof lease.token === 'string' && typeof lease.at === 'number' ? { token: lease.token, at: lease.at } : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The shape the pane and the planner read; anything else is refused.
function isIndex(value: unknown): value is Index {
  if (!isRecord(value)) return false
  const arrays = ['turns', 'edits', 'agents', 'actions', 'untracked'] as const
  if (!arrays.every(key => Array.isArray(value[key]))) return false
  if (!isRecord(value.status) || !isRecord(value.trimmed)) return false
  if (typeof value.nextSeq !== 'number' || typeof value.nextOrdinal !== 'number') return false
  const turns = value.turns as unknown[]
  const edits = value.edits as unknown[]
  const isTurn = (t: unknown) => isRecord(t) && typeof t.turnId === 'string' && typeof t.ordinal === 'number' && typeof t.seq === 'number' && typeof t.prompt === 'string'
  const isContent = (c: unknown) => isRecord(c) && ('hash' in c || 'git' in c || 'absent' in c || 'unreadable' in c)
  const isEdit = (e: unknown) =>
    isRecord(e) && typeof e.seq === 'number' && typeof e.turnId === 'string' && typeof e.key === 'string' && typeof e.path === 'string' && isContent(e.before) && isContent(e.after)
  return turns.every(isTurn) && edits.every(isEdit)
}
