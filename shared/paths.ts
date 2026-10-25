// Paths as git, the panes and scopes want them. Pure: forward slashes, and on
// Windows a case-insensitive prefix test, since its file system ignores case.

export function relativeTo(root: string, path: string, isWindows: boolean): string | undefined {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const full = path.replace(/\\/g, '/')
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s)
  if (!fold(full).startsWith(fold(base) + '/')) return undefined
  const rest = full.slice(base.length + 1)
  return rest === '' ? undefined : rest
}

// For display: relative to the session's folder when under it, else as given.
export function shownPath(cwd: string, path: string, isWindows: boolean): string {
  return relativeTo(cwd, path, isWindows) ?? path.replace(/\\/g, '/')
}
