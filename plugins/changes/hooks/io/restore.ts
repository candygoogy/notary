// Carries out a revert that core/revert-plan.ts decided, then checks that
// the disk holds what was meant (spec §5.4). `$.fs` writes text only and has
// no delete or rename, so bytes, renames and deletes go through a host
// command, paths in env.
//
// A write never truncates the file in place: the content goes to
// `<path>.notary-tmp`, checked against its blob's hash first, then a rename
// replaces the file (File.Replace or Move on Windows, rename(2) on POSIX).

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
  | { ok: false; reason: 'io' }

export const TMP_SUFFIX = '.notary-tmp'
const COMMAND_TIMEOUT_MS = 20_000

const WINDOWS_MOVE =
  '$s=$env:NOTARY_TMP; $t=$env:NOTARY_TARGET; if ([IO.File]::Exists($t)) { [IO.File]::Replace($s, $t, [NullString]::Value) } else { [IO.File]::Move($s, $t) }'
const WINDOWS_WRITE_BYTES = `[IO.File]::WriteAllBytes($env:NOTARY_TMP,[Convert]::FromBase64String([Console]::In.ReadToEnd())); ${WINDOWS_MOVE}`
const WINDOWS_DELETE = 'Remove-Item -LiteralPath $env:NOTARY_TARGET -Force -ErrorAction Stop'
const POSIX_DECODE = 'if command -v base64 >/dev/null 2>&1; then base64 -d; else openssl base64 -d -A; fi'
const POSIX_WRITE_BYTES = `(${POSIX_DECODE}) > "$NOTARY_TMP" && mv -f -- "$NOTARY_TMP" "$NOTARY_TARGET"`

// `rel` is the path relative to the repository root, for a git restore.
export async function runRestore(io: Ports, ctx: RestoreContext, path: string, rel: string | undefined, restore: Restore): Promise<boolean> {
  const tmp = path + TMP_SUFFIX
  try {
    switch (restore.kind) {
      case 'none':
        return true
      case 'write-text': {
        const text = await loadText(io, ctx.store, restore.hash)
        if (text === null || (await sha256Hex(new TextEncoder().encode(text))) !== restore.hash) return false
        await io.fs.write(tmp, text)
        return (await moveInto(io, ctx.platform, tmp, path)) || (await cleanUp(io, ctx.platform, tmp))
      }
      case 'write-bytes': {
        const base64 = await loadBase64(io, ctx.store, restore.hash)
        if (base64 === null || (await sha256Hex(bytesFromBase64(base64))) !== restore.hash) return false
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
    await cleanUp(io, ctx.platform, tmp)
    return false
  }
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
  const plan = planRevert(index, ref, mode, current, options)
  if (!plan.ok) return plan
  // The path must still land on the file the plan is for (a link retargeted
  // since would send the write elsewhere).
  if ((await keyOf(io, path, ctx.platform)) !== ref.key) return { ok: false, reason: 'changed-externally' }
  if (!(await runRestore(io, ctx, path, rel, plan.restore))) return { ok: false, reason: 'io' }
  if (!(await holds(io, ctx, path, rel, plan.target))) return { ok: false, reason: 'io' }
  return { ok: true, refs: plan.refs, before: current, after: plan.target, ...(plan.widenedTo ? { widenedTo: plan.widenedTo } : {}) }
}

function powershell(script: string): string[] {
  return ['powershell', '-NoProfile', '-NonInteractive', '-Command', script]
}

async function moveInto(io: Ports, platform: Platform, tmp: string, target: string): Promise<boolean> {
  const argv = platform === 'windows' ? powershell(WINDOWS_MOVE) : ['mv', '-f', '--', tmp, target]
  return succeeds(io, argv, { NOTARY_TMP: tmp, NOTARY_TARGET: target })
}

async function remove(io: Ports, platform: Platform, path: string): Promise<boolean> {
  const argv = platform === 'windows' ? powershell(WINDOWS_DELETE) : ['rm', '-f', '--', path]
  return succeeds(io, argv, { NOTARY_TARGET: path })
}

// Removes a leftover temp file; always answers false, the restore having failed.
async function cleanUp(io: Ports, platform: Platform, tmp: string): Promise<false> {
  try {
    if (await io.fs.exists(tmp)) await remove(io, platform, tmp)
  } catch {
    // Best effort: a stray .notary-tmp is harmless.
  }
  return false
}

async function succeeds(io: Ports, argv: string[], env: Record<string, string>, stdin?: string): Promise<boolean> {
  const r = await io.process.run(argv, { env, timeoutMs: COMMAND_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) })
  return r.exitCode === 0
}
