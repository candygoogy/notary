// Which paths a shell command may have changed, from `git status` before and
// after it (spec §5.3). Pure: the io layer runs git, stats files, reads
// snapshots and drops candidates whose content turns out unchanged.

export type StatusEntry = { path: string; x: string; y: string; origPath?: string }

// `hash` is set for dirty files small enough to read cheaply (io reads those
// up to 1 MB), so a same-size rewrite that keeps the mtime (`touch -r`,
// `cp -p`) is still seen; a larger one is missed, a documented limit.
export type FileStamp = { size: number; mtimeMs: number; hash?: string }

export type ShellSnapshot = {
  // `git rev-parse HEAD` at the time.
  head: string
  // Parsed `git status --porcelain=v1 -z --untracked-files=all`, by path.
  status: Map<string, StatusEntry>
  // Stats of the paths dirty in either snapshot (rename sources included,
  // see dirtyPaths); null when the file is missing.
  stamps: Map<string, FileStamp | null>
}

// Where a candidate's before comes from: the pre-command snapshot of a dirty
// or untracked file, or, for a file that was clean, the blob in the earlier
// HEAD (missing there means the file is new).
export type Candidate = { path: string; beforeFrom: 'snapshot' | 'head' }

// Porcelain v1 with -z: `XY path` per entry, NUL-ended, unquoted, relative to
// the repository root; a rename or copy is followed by its source path.
export function parseStatus(output: string): Map<string, StatusEntry> {
  const fields = output.split('\0')
  const entries = new Map<string, StatusEntry>()
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (field.length < 4) continue
    const entry: StatusEntry = { path: field.slice(3), x: field[0], y: field[1] }
    if (entry.x === 'R' || entry.x === 'C' || entry.y === 'R' || entry.y === 'C') entry.origPath = fields[++i]
    entries.set(entry.path, entry)
  }
  return entries
}

// `headChanged`: when HEAD moved, the paths that differ between the two heads
// (`git diff --name-only <before> <after>`), since a checkout can rewrite
// files that are clean both before and after.
export function changedPaths(before: ShellSnapshot, after: ShellSnapshot, headChanged: readonly string[] = []): Candidate[] {
  const found = new Map<string, Candidate>()
  const dirtyBefore = new Set(dirtyPaths(before))
  const wasDirty = (path: string) => dirtyBefore.has(path)

  // Dirty before: changed only if the file itself changed, whatever git now
  // says about the index (git add and git commit change status, not content).
  for (const path of dirtyBefore) {
    if (stampChanged(before.stamps.get(path), after.stamps.get(path))) found.set(path, { path, beforeFrom: 'snapshot' })
  }

  // Clean before: any appearance now is a candidate, the source of a rename too.
  const appeared = [
    ...after.status.keys(),
    ...[...after.status.values()].flatMap(e => (e.origPath === undefined ? [] : [e.origPath])),
    ...headChanged,
  ]
  for (const path of appeared) {
    if (!wasDirty(path)) found.set(path, { path, beforeFrom: 'head' })
  }

  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// The paths whose worktree state differs from HEAD in a snapshot: every entry,
// and the source of a staged rename, which is gone from the worktree (a file
// recreated there was absent before, not HEAD's blob). io snapshots and
// stamps exactly these.
export function dirtyPaths(snapshot: ShellSnapshot): string[] {
  const paths = new Set(snapshot.status.keys())
  for (const entry of snapshot.status.values()) if (entry.origPath !== undefined) paths.add(entry.origPath)
  return [...paths]
}

function stampChanged(before: FileStamp | null | undefined, after: FileStamp | null | undefined): boolean {
  if (before === undefined || after === undefined) return true
  if (before === null || after === null) return before !== after
  if (before.hash !== undefined && after.hash !== undefined && before.hash !== after.hash) return true
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs
}
