// The session folders under `<config>/plugin-data/notary-changes/` (spec §5.6):
// a `.touch` file marks a folder alive; session.end removes its own folder,
// session.start removes folders untouched for a week (a crash skips the end).

import type { Platform, Ports } from './ports.ts'

export const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Snapshots one session may keep; past it, new ones are not saved.
export const STORE_CAP_BYTES = 500 * 1024 * 1024
const REMOVE_TIMEOUT_MS = 20_000
const OURS = '/plugin-data/notary-changes/'

export async function touch(io: Ports, store: string, now: number): Promise<void> {
  try {
    await io.fs.write(`${store}/.touch`, String(now))
  } catch {
    // Best effort: an untouched folder only ages sooner.
  }
}

// The session folders under `base` last touched (or, with no mark, last
// changed) before `now - STALE_MS`, never `keep` (this session's own).
export async function staleSessions(io: Ports, base: string, keep: string, now: number): Promise<string[]> {
  let entries: Awaited<ReturnType<Ports['fs']['list']>>
  try {
    entries = await io.fs.list(base)
  } catch {
    return []
  }
  const stale: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const dir = `${base}/${entry.name}`
    if (dir === keep) continue
    try {
      const mark = (await io.fs.exists(`${dir}/.touch`)) ? await io.fs.stat(`${dir}/.touch`) : await io.fs.stat(dir)
      if (mark.mtimeMs > 0 && mark.mtimeMs < now - STALE_MS) stale.push(dir)
    } catch {
      // Unreadable: leave it.
    }
  }
  return stale
}

// The bytes of saved copies in a session's store.
export async function storeUsage(io: Ports, store: string): Promise<number> {
  try {
    return (await io.fs.list(`${store}/blobs`)).reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0)
  } catch {
    return 0
  }
}

// Whether `path` is a session folder of ours: under the plugin's data folder,
// with a name of its own. Nothing else is ever removed.
export function isSessionFolder(path: string): boolean {
  const normal = path.replace(/\\/g, '/')
  const at = normal.indexOf(OURS)
  const name = at < 0 ? '' : normal.slice(at + OURS.length)
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/')
}

// Deletes a session folder and everything in it ($.fs has no delete), its
// `.touch` last: a delete cut short leaves a marked folder the sweep finds.
export async function removeTree(io: Ports, platform: Platform, path: string): Promise<boolean> {
  if (!isSessionFolder(path)) return false
  const argv =
    platform === 'windows'
      ? [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-ChildItem -LiteralPath $env:NOTARY_TARGET -Force | Where-Object { $_.Name -ne '.touch' } | Remove-Item -Recurse -Force -ErrorAction Stop; Remove-Item -LiteralPath $env:NOTARY_TARGET -Recurse -Force -ErrorAction Stop",
        ]
      : ['sh', '-c', 'find "$NOTARY_TARGET" -mindepth 1 -maxdepth 1 ! -name .touch -exec rm -rf -- {} + && rm -rf -- "$NOTARY_TARGET"']
  try {
    const r = await io.process.run(argv, { env: { NOTARY_TARGET: path }, timeoutMs: REMOVE_TIMEOUT_MS })
    return r.exitCode === 0
  } catch {
    return false
  }
}
