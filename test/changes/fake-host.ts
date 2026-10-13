// An in-memory stand-in for the parts of `$` the Changes io layer uses:
// fs (paths normalized to forward slashes), process.run and env.

import { base64FromBytes, bytesFromBase64 } from '../../plugins/changes/hooks/core/content.ts'

export type Run = { argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } }
export type RunResult = { exitCode: number; stdout: string; stderr?: string }

export function fakeHost(options: { env?: Record<string, string>; onRun?: (run: Run) => RunResult } = {}) {
  const files = new Map<string, Uint8Array>()
  const mtimes = new Map<string, number>()
  const runs: Run[] = []
  let tick = 1
  const norm = (p: string) => p.replace(/\\/g, '/')
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })

  const host = {
    files,
    runs,
    // `mtimeMs` keeps a given modification time (as `touch -r` or `cp -p` do).
    put(path: string, content: string | Uint8Array, mtimeMs?: number) {
      files.set(norm(path), typeof content === 'string' ? new TextEncoder().encode(content) : content)
      mtimes.set(norm(path), mtimeMs ?? tick++)
    },
    mtimeOf(path: string): number | undefined {
      return mtimes.get(norm(path))
    },
    text(path: string): string | undefined {
      const bytes = files.get(norm(path))
      return bytes && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    },
    fs: {
      async read(path: string, opts?: { as?: 'text' | 'bytes' }) {
        const bytes = files.get(norm(path))
        if (!bytes) throw enoent(path)
        if (bytes.length > 4 * 1024 * 1024) throw new Error('over 4 MiB')
        return opts?.as === 'bytes' ? { base64: base64FromBytes(bytes) } : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
      },
      async write(path: string, text: string) {
        host.put(path, text)
      },
      async exists(path: string) {
        const p = norm(path)
        return files.has(p) || [...files.keys()].some(k => k.startsWith(p.replace(/\/$/, '') + '/'))
      },
      async stat(path: string, opts?: { resolve?: boolean }) {
        const p = norm(path)
        const bytes = files.get(p)
        if (!bytes) {
          const isDir = [...files.keys()].some(k => k.startsWith(p.replace(/\/$/, '') + '/'))
          if (!isDir) throw enoent(path)
          return { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, ...(opts?.resolve ? { realPath: p } : {}) }
        }
        return { kind: 'file' as const, size: bytes.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false, ...(opts?.resolve ? { realPath: p } : {}) }
      },
      async list() {
        return []
      },
    },
    process: {
      async run(argv: readonly string[], init?: Run['init']) {
        runs.push({ argv, init })
        const result = options.onRun?.({ argv, init }) ?? { exitCode: 0, stdout: '' }
        return { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...result }
      },
    },
    env: {
      async get(name: string) {
        return options.env?.[name]
      },
    },
    // `time` is what the clock reads; each read then moves it on by `step`.
    time: 0,
    step: 0,
    clock: {
      async now() {
        const now = host.time
        host.time += host.step
        return now
      },
    },
  }
  return host
}

export { base64FromBytes, bytesFromBase64 }
