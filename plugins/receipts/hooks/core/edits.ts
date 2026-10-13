// Which edits reopen verification (spec: "only code edits"). Docs, Claude's
// own files, memory, scratch, build output and anything outside the project
// change nothing a test could check, so they never make a claim "unverified".

const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/
// Path segments whose files are Claude's, scratch, or generated.
const NOT_CODE_DIRS = new Set(['.claude', '.agent', 'scratch', 'target', 'dist', 'build', 'node_modules', '.cache', '__pycache__'])
const TEMP_ROOTS = [/^\/tmp\//, /^\/var\/folders\//, /^\/private\/var\/folders\//, /^[a-z]:\/(?:users\/[^/]+\/appdata\/local\/temp|windows\/temp)\//, /^[a-z]:\/tmp\//]

export function isVerifiableEdit(path: string, cwd: string): boolean {
  if (path.trim() === '') return false
  const root = normalize(cwd)
  const file = normalize(isAbsolute(path) ? path : `${cwd}/${path}`)
  if (PROSE.test(file)) return false
  // Outside the project is never verifiable; with no project known, temp dirs aren't either.
  // (A project that itself lives under a temp dir keeps its own files.)
  if (root !== '' && !file.startsWith(`${root}/`)) return false
  if (root === '' && TEMP_ROOTS.some(pattern => pattern.test(file))) return false
  const inside = root !== '' ? file.slice(root.length + 1) : file
  return !inside.split('/').some(segment => NOT_CODE_DIRS.has(segment))
}

function isAbsolute(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/])/.test(path)
}

// Forward slashes, no `.` or `..` segments, Git Bash's /c/ read as c:/, and
// lower case: Windows paths compare case-insensitively, and on the other
// systems a case clash in a project's own paths is rare enough to ignore.
function normalize(path: string): string {
  let p = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  p = p.replace(/^\/([a-zA-Z])\//, '$1:/')
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/').replace(/\/$/, '').toLowerCase()
}
