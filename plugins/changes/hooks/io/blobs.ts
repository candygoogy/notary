// The snapshot store (spec §5.2, §5.6): content-addressed blobs under
// `<config>/plugin-data/notary-changes/<sessionId>/blobs/`, `<sha256>.txt`
// for text a write gives back byte for byte, `<sha256>.b64` for the rest.

import { base64FromBytes, bytesFromBase64, describe } from '../core/content.ts'
import type { Content } from '../core/model.ts'
import type { Platform, Ports } from './ports.ts'

// `$.fs` refuses reads over this.
export const MAX_READ_BYTES = 4 * 1024 * 1024

const slashes = (path: string) => path.replace(/\\/g, '/')

// The variables as register read them with `$.env.get` (names must be literals).
export type StoreEnv = { CLAUDE_CONFIG_DIR?: string; USERPROFILE?: string; HOME?: string }

export function storeDirOf(env: StoreEnv, sessionId: string): string {
  const home = env.USERPROFILE ?? env.HOME ?? '.'
  const config = env.CLAUDE_CONFIG_DIR ?? `${slashes(home).replace(/\/$/, '')}/.claude`
  return `${slashes(config).replace(/\/$/, '')}/plugin-data/notary-changes/${sessionId}`
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

// The bytes a session's new blobs may still take; `full` once one was refused.
export type StoreBudget = { used: number; cap: number; full: boolean }

// What the file holds now: absent, too large, unreadable, or its hash and
// kind, with the blob written unless `store` is false (a check, not a
// snapshot). A blob the budget has no room for is not written, and the
// capture is `{ unreadable: 'io' }`: never a hash that names no saved copy.
export async function capture(io: Ports, store: string, path: string, options: { store?: boolean; budget?: StoreBudget } = {}): Promise<Content> {
  try {
    if (!(await io.fs.exists(path))) return { absent: true }
    const stat = await io.fs.stat(path)
    if (stat.kind !== 'file') return { unreadable: 'io' }
    if (stat.size > MAX_READ_BYTES) return { unreadable: 'too-large' }
    const read = await io.fs.read(path, { as: 'bytes' })
    const bytes = bytesFromBase64(typeof read === 'string' ? read : read.base64)
    const meta = describe(bytes)
    const hash = await sha256Hex(bytes)
    if (options.store !== false) {
      const blob = `${store}/blobs/${hash}.${meta.kind === 'text' ? 'txt' : 'b64'}`
      if (!(await io.fs.exists(blob))) {
        const budget = options.budget
        if (budget !== undefined && budget.used + bytes.length > budget.cap) {
          budget.full = true
          return { unreadable: 'io' }
        }
        await io.fs.write(blob, meta.kind === 'text' ? meta.text : base64FromBytes(bytes))
        if (budget !== undefined) budget.used += bytes.length
      }
    }
    return meta.kind === 'text'
      ? { hash, size: meta.size, kind: 'text', eol: meta.eol, bom: meta.bom }
      : { hash, size: meta.size, kind: 'binary', eol: 'none', bom: false }
  } catch {
    return { unreadable: 'io' }
  }
}

export async function loadText(io: Ports, store: string, hash: string): Promise<string | null> {
  try {
    return (await io.fs.read(`${store}/blobs/${hash}.txt`)) as string
  } catch {
    return null
  }
}

export async function loadBase64(io: Ports, store: string, hash: string): Promise<string | null> {
  try {
    return (await io.fs.read(`${store}/blobs/${hash}.b64`)) as string
  } catch {
    return null
  }
}

// A file's identity across spellings: where the path really lands (links and
// `..` resolved; for a file not there yet, its folder's real path plus the
// name), lowercased on Windows, whose file system ignores case.
export async function keyOf(io: Ports, path: string, platform: Platform): Promise<string> {
  const normal = slashes(path)
  let real = normal
  try {
    const own = await io.fs.stat(path, { resolve: true })
    real = own.realPath ?? normal
  } catch {
    const cut = normal.lastIndexOf('/')
    if (cut > 0) {
      try {
        const folder = await io.fs.stat(normal.slice(0, cut), { resolve: true })
        if (folder.realPath) real = `${slashes(folder.realPath).replace(/\/$/, '')}${normal.slice(cut)}`
      } catch {
        // The folder is missing too: keep the spelling.
      }
    }
  }
  real = slashes(real)
  return platform === 'windows' ? real.toLowerCase() : real
}
