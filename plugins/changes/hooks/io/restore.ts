// Carries out a revert that core/revert-plan.ts decided, then checks that
// the disk holds what was meant (spec §5.4). `$.fs` writes text only and has
// no delete or rename, so bytes, renames and deletes go through a host
// command, paths in env.
//
// A write never truncates the file in place: the content goes to a temp file
// of its own, `<path>.notary-tmp-<random id>`, checked against its blob's hash
// first, then a rename replaces the file (File.Replace or Move on Windows,
// rename(2) on POSIX).

import { bytesFromBase64 } from '../core/content.ts'
import { sameContent, type Content, type Index } from '../core/model.ts'
import { planRevert, type Restore, type RevertOptions, type RevertPlan, type RevertRef } from '../core/revert-plan.ts'
import { capture, keyOf, loadBase64, loadText, sha256Hex } from './blobs.ts'
import { hashObject, restoreFrom } from './git.ts'
import type { Platform, Ports } from './ports.ts'

export type RestoreContext = {
  platform: Platform
  // The session's blob store.
  store: string
  // The repository root, when the session is in one.
  root?: string
}

// On success, `before` (stored as a blob, so a revert can itself be undone)
// and `after` are the disk transition for recordRevert.
export type RevertOutcome =
  | { ok: true; refs: RevertRef[]; before: Content; after: Content; widenedTo?: string[] }
  | Exclude<RevertPlan, { ok: true }>
  // `afterWrite`: the restore ran and did not land (or could not be
  // verified); without it, nothing was written.
  | { ok: false; reason: 'io'; afterWrite?: true }

// Starts every temp file's suffix, so a stray one is recognisable.
export const TMP_SUFFIX = '.notary-tmp'
const TMP_TRIES = 3
const COMMAND_TIMEOUT_MS = 20_000

const WINDOWS_MOVE =
  '$s=$env:NOTARY_TMP; $t=$env:NOTARY_TARGET; if ([IO.File]::Exists($t)) { [IO.File]::Replace($s, $t, [NullString]::Value) } else { [IO.File]::Move($s, $t) }'
const WINDOWS_WRITE_BYTES = `[IO.File]::WriteAllBytes($env:NOTARY_TMP,[Convert]::FromBase64String([Console]::In.ReadToEnd())); ${WINDOWS_MOVE}`
const WINDOWS_DELETE = 'Remove-Item -LiteralPath $env:NOTARY_TARGET -Force -ErrorAction Stop'
const POSIX_DECODE = 'if command -v base64 >/dev/null 2>&1; then base64 -d; else openssl base64 -d -A; fi'
const POSIX_WRITE_BYTES = `(${POSIX_DECODE}) > "$NOTARY_TMP" && mv -f -- "$NOTARY_TMP" "$NOTARY_TARGET"`

// `rel` is the path relative to the repository root, for a git restore.
export async function runRestore(io: Ports, ctx: RestoreContext, path: string, rel: string | undefined, restore: Restore): Promise<boolean> {
  // Set only once this run has its own temp path: nothing else is cleaned up.
  let tmp: string | null = null
  try {
    switch (restore.kind) {
      case 'none':
        return true
      case 'write-text': {
        const text = await loadText(io, ctx.store, restore.hash)
        if (text === null || (await sha256Hex(new TextEncoder().encode(text))) !== restore.hash) return false
        tmp = await tmpFor(io, path)
        if (tmp === null) return false
        await io.fs.write(tmp, text)
        return (await moveInto(io, ctx.platform, tmp, path)) || (await cleanUp(io, ctx.platform, tmp))
      }
      case 'write-bytes': {
        const base64 = await loadBase64(io, ctx.store, restore.hash)
        if (base64 === null || (await sha256Hex(bytesFromBase64(base64))) !== restore.hash) return false
        tmp = await tmpFor(io, path)
        if (tmp === null) return false
        // Makes the folders the path needs; the command fills the file in.
        await io.fs.write(tmp, '')
        const argv = ctx.platform === 'windows' ? powershell(WINDOWS_WRITE_BYTES) : ['sh', '-c', POSIX_WRITE_BYTES]
        return (await succeeds(io, argv, { NOTARY_TMP: tmp, NOTARY_TARGET: path }, base64)) || (await cleanUp(io, ctx.platform, tmp))
      }
      case 'delete':
        return await remove(io, ctx.platform, path)
      case 'git-restore':
        if (ctx.root === undefined || rel === undefined) return false
        return await restoreFrom(io, ctx.root, restore.commit, rel)
    }
  } catch {
    if (tmp !== null) await cleanUp(io, ctx.platform, tmp)
    return false
  }
}

// A temp path beside `path` for one write, `<path>.notary-tmp-<random id>`.
// `$.fs` cannot create a file exclusively, so a name already taken is never
// used: another file there is not written over, moved or removed. Null when
// no free name is found.
export async function tmpFor(io: Ports, path: string): Promise<string | null> {
  for (let i = 0; i < TMP_TRIES; i++) {
    const tmp = `${path}${TMP_SUFFIX}-${crypto.randomUUID()}`
    if (!(await io.fs.exists(tmp))) return tmp
  }
  return null
}

// Whether the file on disk now is `target`.
export async function holds(io: Ports, ctx: RestoreContext, path: string, rel: string | undefined, target: Content): Promise<boolean> {
  if ('git' in target) {
    if (ctx.root === undefined || rel === undefined) return false
    return (await hashObject(io, ctx.root, rel)) === target.git.oid
  }
  return sameContent(await capture(io, ctx.store, path, { store: false }), target) === true
}

// Plan from the file as it is now, restore, verify. The caller passes the
// outcome to core's recordRevert and tells Claude.
export async function revertFile(
  io: Ports,
  ctx: RestoreContext,
  index: Index,
  ref: RevertRef,
  mode: 'turn' | 'turnAndLater',
  path: string,
  rel?: string,
  options: RevertOptions = {},
): Promise<RevertOutcome> {
  // Stored: the content a revert replaces stays restorable.
  const current = await capture(io, ctx.store, path)
  const plan = await planFile(io, ctx, index, ref, mode, current, options)
  if (!plan.ok) return plan
  // The path must still land on the file the plan is for (a link retargeted
  // since would send the write elsewhere).
  if ((await keyOf(io, path, ctx.platform)) !== ref.key) return { ok: false, reason: 'changed-externally' }
  if (!(await runRestore(io, ctx, path, rel, plan.restore))) return { ok: false, reason: 'io', afterWrite: true }
  if (!(await holds(io, ctx, path, rel, plan.target))) return { ok: false, reason: 'io', afterWrite: true }
  return { ok: true, refs: plan.refs, before: current, after: plan.target, ...(plan.widenedTo ? { widenedTo: plan.widenedTo } : {}) }
}

// planRevert, and the saved copy it would write back is still on disk: a
// copy gone from the folder (deleted by hand, a sweep cut short, a history
// kept from an earlier launch) is refused as no-snapshot while planning,
// before anything is written.
export async function planFile(
  io: Ports,
  ctx: RestoreContext,
  index: Index,
  ref: RevertRef,
  mode: 'turn' | 'turnAndLater',
  current: Content,
  options: RevertOptions = {},
): Promise<RevertPlan> {
  const plan = planRevert(index, ref, mode, current, options)
  if (!plan.ok || (plan.restore.kind !== 'write-text' && plan.restore.kind !== 'write-bytes')) return plan
  const copy = `${ctx.store}/blobs/${plan.restore.hash}.${plan.restore.kind === 'write-text' ? 'txt' : 'b64'}`
  try {
    return (await io.fs.exists(copy)) ? plan : { ok: false, reason: 'no-snapshot' }
  } catch {
    return { ok: false, reason: 'no-snapshot' }
  }
}

// One file of a turn, as a whole-turn revert names it.
export type TurnFile = { turnId: string; key: string; path: string; rel?: string }
export type Reverted = Extract<RevertOutcome, { ok: true }>
export type Refused = Exclude<RevertOutcome, { ok: true }>

// What reverting each file of the turn would do now, written nothing: the
// first press of Revert all.
export async function planTurn(io: Ports, ctx: RestoreContext, index: Index, files: readonly TurnFile[]): Promise<Array<{ file: TurnFile; plan: RevertPlan }>> {
  const plans: Array<{ file: TurnFile; plan: RevertPlan }> = []
  for (const file of files) {
    const current = await capture(io, ctx.store, file.path, { store: false })
    plans.push({ file, plan: await planFile(io, ctx, index, { turnId: file.turnId, key: file.key }, 'turn', current) })
  }
  return plans
}

export type TurnRevert = {
  reverted: Array<{ file: TurnFile; outcome: Reverted }>
  skipped: Array<{ file: TurnFile; outcome: Refused }>
  // A write that did not land: the run stopped there, and `notTried` were left alone.
  stopped: TurnFile | null
  notTried: TurnFile[]
}

// Reverts a turn file by file, each planned afresh from the disk and checked
// as a single revert is. A refusal skips that file and nothing is written to
// it. A write that did not land stops the run: the disk is not as expected
// (full, locked, permissions), so no more files are written into it.
// `record` saves each landed revert before the next file is tried and answers
// the index the next one is planned from, so the history stays one chain.
export async function revertTurn(
  io: Ports,
  ctx: RestoreContext,
  index: Index,
  files: readonly TurnFile[],
  record: (file: TurnFile, outcome: Reverted) => Promise<Index>,
): Promise<TurnRevert> {
  const result: TurnRevert = { reverted: [], skipped: [], stopped: null, notTried: [] }
  let current = index
  for (const [i, file] of files.entries()) {
    const outcome = await revertFile(io, ctx, current, { turnId: file.turnId, key: file.key }, 'turn', file.path, file.rel)
    if (outcome.ok) {
      result.reverted.push({ file, outcome })
      current = await record(file, outcome)
    } else if (outcome.reason === 'io' && 'afterWrite' in outcome) {
      result.stopped = file
      result.notTried = files.slice(i + 1)
      break
    } else {
      result.skipped.push({ file, outcome })
    }
  }
  return result
}

function powershell(script: string): string[] {
  return ['powershell', '-NoProfile', '-NonInteractive', '-Command', script]
}

// Moves `tmp` over `target` in one rename, so a reader never sees half a file.
export async function moveInto(io: Ports, platform: Platform, tmp: string, target: string): Promise<boolean> {
  const argv = platform === 'windows' ? powershell(WINDOWS_MOVE) : ['mv', '-f', '--', tmp, target]
  return succeeds(io, argv, { NOTARY_TMP: tmp, NOTARY_TARGET: target })
}

async function remove(io: Ports, platform: Platform, path: string): Promise<boolean> {
  const argv = platform === 'windows' ? powershell(WINDOWS_DELETE) : ['rm', '-f', '--', path]
  return succeeds(io, argv, { NOTARY_TARGET: path })
}

// Removes the temp file a failed write left; always answers false. Only ever
// given a path from tmpFor, so it removes nothing this write did not create.
export async function cleanUp(io: Ports, platform: Platform, tmp: string): Promise<false> {
  try {
    if (await io.fs.exists(tmp)) await remove(io, platform, tmp)
  } catch {
    // Best effort: a stray .notary-tmp-<id> is ours and in no one's way.
  }
  return false
}

async function succeeds(io: Ports, argv: string[], env: Record<string, string>, stdin?: string): Promise<boolean> {
  const r = await io.process.run(argv, { env, timeoutMs: COMMAND_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) })
  return r.exitCode === 0
}
