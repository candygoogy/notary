// What io/ may do to the machine, handed in by register.tsx. The loader
// follows `$` only into functions of the file that uses it, never across an
// import, so register builds these closures over `$` and io/ never sees `$`.

import type { EngineInterface } from 'claude-code'

export type Ports = {
  fs: Pick<EngineInterface['fs'], 'read' | 'write' | 'exists' | 'stat' | 'list'>
  process: Pick<EngineInterface['process'], 'run'>
  clock: Pick<EngineInterface['clock'], 'now'>
}

export type Platform = 'windows' | 'posix'

// From `$.env.get('OS')`, read in register (env names must be literals).
export function platformOf(os: string | undefined): Platform {
  return os === 'Windows_NT' ? 'windows' : 'posix'
}
