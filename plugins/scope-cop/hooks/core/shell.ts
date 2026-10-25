// The files a Bash or PowerShell command will write, read from its text
// before it runs (design note §4). Conservative: only literal targets of
// commands we know count. A variable, glob, substitution, escape, an unknown
// program or a relative path after a `cd` makes the command `unknown`, which
// is never denied and never flagged. Pure.

export type ShellWrites = { targets: string[]; unknown: boolean }

// `quoted`: the word began with a quote (in PowerShell, a string value, not a command).
type Token = { text: string; literal: boolean; quoted?: true; redirect?: 'out' | 'in' }
// What one command writes: literal paths, some of them only (`partial`), a
// change of directory, or nothing we can name.
type Found = string[] | { partial: string[] } | 'cd' | 'unknown'
type Segment = Token[]

export function shellWrites(command: string, tool: 'Bash' | 'PowerShell'): ShellWrites {
  const segments = tool === 'Bash' ? tokenizeBash(command) : tokenizePowerShell(command)
  if (segments === null) return { targets: [], unknown: true }
  const targets: string[] = []
  let unknown = false
  let moved = false
  const add = (path: string) => {
    if (moved && !isAbsolute(path)) unknown = true
    else if (!targets.includes(path)) targets.push(path)
  }
  for (const segment of segments) {
    for (const t of segment) {
      if (t.redirect !== 'out') continue
      if (!t.literal) unknown = true
      else if (!isNullDevice(t.text)) add(t.text)
    }
    const words = segment.filter(t => t.redirect === undefined)
    if (words.length === 0) continue
    const r = tool === 'Bash' ? bashCommand(words) : powerShellCommand(words)
    if (r === 'cd') moved = true
    else if (r === 'unknown') unknown = true
    else if (Array.isArray(r)) r.forEach(add)
    else {
      r.partial.forEach(add)
      unknown = true
    }
  }
  return { targets, unknown }
}

function isAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:|[/\\])/.test(path)
}

function isNullDevice(path: string): boolean {
  return /^(?:\/dev\/(?:null|stdout|stderr|tty)|nul|\$null)$/i.test(path)
}

// ---------------------------------------------------------------- Bash

const BASH_READERS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'wc', 'uniq', 'diff', 'cmp', 'echo',
  'printf', 'pwd', 'which', 'type', 'test', '[', 'true', 'false', 'stat', 'file', 'du', 'df', 'date', 'sleep', 'jq',
  'xxd', 'od', 'basename', 'dirname', 'realpath', 'readlink', 'tree', 'export', 'set', 'unset', 'exit', 'wait',
  'ps', 'whoami', 'uname', 'hostname', 'env', 'printenv', 'column', 'cut', 'tr', 'nl', 'rev', 'comm', 'md5sum',
  'sha256sum', 'shasum',
])
const GIT_READERS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'blame', 'fetch', 'remote', 'config', 'describe', 'shortlog', 'cat-file', 'ls-tree', 'branch'])
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nohup'])

function bashCommand(words: Token[]): Found {
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text) || WRAPPERS.has(words[i]!.text))) i++
  if (i >= words.length) return []
  if (!words[i]!.literal) return 'unknown'
  const name = words[i]!.text.replace(/^.*\//, '').toLowerCase()
  const args = words.slice(i + 1)
  if (name === 'cd' || name === 'pushd' || name === 'popd') return 'cd'
  if (name === 'git') {
    const sub = args.find(a => !a.text.startsWith('-'))
    return sub !== undefined && GIT_READERS.has(sub.text) ? [] : 'unknown'
  }
  if (name === 'sed') return sedTargets(args)
  if (name === 'awk') return args.some(a => a.text === '-i' || a.text.startsWith('-i')) ? 'unknown' : []
  if (name === 'sort') {
    const at = args.findIndex(a => a.text === '-o')
    return at < 0 ? [] : literals(args.slice(at + 1, at + 2))
  }
  if (name === 'find') return args.some(a => /^-(?:delete|exec|execdir|ok|fprint)/.test(a.text)) ? 'unknown' : []
  if (BASH_READERS.has(name)) return []
  const operands = args.filter(a => !a.text.startsWith('-') || !a.literal)
  switch (name) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'touch':
    case 'mkdir':
    case 'truncate':
      return literals(name === 'truncate' ? withoutValueOf(args, ['-s', '--size']) : operands)
    case 'cp':
    case 'mv': {
      const t = args.findIndex(a => a.text === '-t' || a.text === '--target-directory')
      if (t >= 0) {
        const dest = literals(args.slice(t + 1, t + 2))
        if (dest === 'unknown' || name === 'cp') return dest
        const sources = literals(operands.filter(a => a !== args[t + 1]))
        return sources === 'unknown' ? 'unknown' : [...dest, ...sources]
      }
      if (operands.length < 2) return 'unknown'
      return literals(name === 'cp' ? operands.slice(-1) : operands)
    }
    default:
      return 'unknown'
  }
}

function sedTargets(args: Token[]): string[] | 'unknown' {
  const inPlace = args.some(a => /^(?:-i|--in-place)/.test(a.text) || /^-[a-hj-z]*i/.test(a.text))
  if (!inPlace) return []
  let script = !args.some(a => a.text === '-e' || a.text === '-f' || a.text === '--expression' || a.text === '--file')
  const files: Token[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.text === '-e' || a.text === '-f' || a.text === '--expression' || a.text === '--file') {
      i++
      continue
    }
    if (a.literal && a.text.startsWith('-')) continue
    if (script) {
      script = false
      continue
    }
    files.push(a)
  }
  return files.length === 0 ? 'unknown' : literals(files)
}

function withoutValueOf(args: Token[], options: string[]): Token[] {
  const out: Token[] = []
  for (let i = 0; i < args.length; i++) {
    if (options.includes(args[i]!.text)) i++
    else if (!args[i]!.text.startsWith('-')) out.push(args[i]!)
  }
  return out
}

function literals(tokens: Token[]): string[] | 'unknown' {
  if (tokens.length === 0) return []
  return tokens.every(t => t.literal) ? tokens.map(t => t.text) : 'unknown'
}

// Words per segment, split on ; && || | & newlines and ( ) { }, quotes kept
// whole. A word is literal unless it holds an expansion. Heredoc bodies and
// comments are skipped. Null for an unclosed quote.
function tokenizeBash(command: string): Segment[] | null {
  const segments: Segment[] = []
  let segment: Segment = []
  let text = ''
  let literal = true
  let inWord = false
  let pending: Token['redirect'] | 'skip' | null = null
  const heredocs: string[] = []
  const endWord = () => {
    if (!inWord) return
    if (pending === 'skip') pending = null
    else {
      segment.push(pending === null ? { text, literal } : { text, literal, redirect: pending })
      pending = null
    }
    text = ''
    literal = true
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  let i = 0
  const n = command.length
  while (i < n) {
    const c = command[i]
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1)
      if (close < 0) return null
      const inner = command.slice(i + 1, close)
      if (c === '"' && /[$`\\]/.test(inner)) literal = false
      text += inner
      inWord = true
      i = close + 1
      continue
    }
    if (c === '\\') {
      if (command[i + 1] === '\n') {
        i += 2
        continue
      }
      literal = false
      text += command.slice(i, i + 2)
      inWord = true
      i += 2
      continue
    }
    if (c === '$' || c === '`') {
      literal = false
      inWord = true
      if (command.startsWith('$(', i) || c === '`') {
        const end = c === '`' ? command.indexOf('`', i + 1) : closingParen(command, i + 1)
        if (end < 0) return null
        text += command.slice(i, end + 1)
        i = end + 1
        continue
      }
      text += c
      i++
      continue
    }
    if (c === '#' && !inWord) {
      while (i < n && command[i] !== '\n') i++
      continue
    }
    if (c === '\n') {
      endSegment()
      i++
      for (const delimiter of heredocs.splice(0)) {
        while (i < n) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol < 0 ? n : eol)
          i = eol < 0 ? n : eol + 1
          if (line.replace(/^\t+/, '').trim() === delimiter) break
        }
      }
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    if (c === '<') {
      endWord()
      if (command.startsWith('<<<', i)) {
        pending = 'skip'
        i += 3
        continue
      }
      if (command.startsWith('<<', i)) {
        i += 2
        if (command[i] === '-') i++
        while (command[i] === ' ' || command[i] === '\t') i++
        const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(i))
        if (m === null) return null
        heredocs.push(m[2]!)
        i += m[0].length
        continue
      }
      pending = 'skip'
      i++
      continue
    }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(text) && literal) {
        text = ''
        inWord = false
      } else endWord()
      i += c === '&' ? 2 : 1
      if (command[i] === '>' || command[i] === '|') i++
      if (command[i] === '&') {
        i++
        while (/[\d-]/.test(command[i] ?? '')) i++
        continue
      }
      pending = 'out'
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || ((c === '{' || c === '}') && !inWord)) {
      endSegment()
      i += command.startsWith('&&', i) || command.startsWith('||', i) || command.startsWith('|&', i) || command.startsWith(';;', i) ? 2 : 1
      continue
    }
    if (c === '*' || c === '?' || c === '[' || c === '{' || (c === '~' && !inWord)) literal = false
    text += c
    inWord = true
    i++
  }
  endSegment()
  return segments
}

function closingParen(command: string, open: number): number {
  let depth = 0
  for (let i = open; i < command.length; i++) {
    const c = command[i]
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1)
      if (close < 0) return -1
      i = close
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

// ---------------------------------------------------------- PowerShell

const PS_READERS = new Set([
  'get-content', 'gc', 'cat', 'type', 'get-childitem', 'gci', 'ls', 'dir', 'select-string', 'sls', 'write-output',
  'echo', 'write', 'write-host', 'test-path', 'get-item', 'gi', 'resolve-path', 'measure-object', 'select-object',
  'where-object', 'sort-object', 'format-table', 'format-list', 'out-host', 'out-null', 'out-string', 'get-date',
  'start-sleep', 'get-location', 'pwd', 'gl', 'get-command', 'gcm', 'join-path', 'split-path', 'convertto-json',
  'convertfrom-json', 'get-process', 'get-filehash', 'compare-object', 'get-itemproperty',
])
const PS_CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'push-location', 'pushd', 'pop-location', 'popd'])

// Each writer: its canonical name, and which positional parameters name the
// paths it writes (`dest` written, `source` written too for a move).
type Writer = { positions: readonly string[]; writes: readonly string[] }
const CONTENT: Writer = { positions: ['path', 'value'], writes: ['path', 'literalpath'] }
const PS_WRITERS: Record<string, Writer> = {
  'set-content': CONTENT,
  sc: CONTENT,
  'add-content': CONTENT,
  ac: CONTENT,
  'clear-content': CONTENT,
  clc: CONTENT,
  'out-file': { positions: ['filepath'], writes: ['filepath', 'literalpath'] },
  'tee-object': { positions: ['filepath'], writes: ['filepath', 'literalpath'] },
  tee: { positions: ['filepath'], writes: ['filepath', 'literalpath'] },
  'new-item': { positions: ['path'], writes: ['path'] },
  ni: { positions: ['path'], writes: ['path'] },
  mkdir: { positions: ['path'], writes: ['path'] },
  md: { positions: ['path'], writes: ['path'] },
  'remove-item': { positions: ['path'], writes: ['path', 'literalpath'] },
  ri: { positions: ['path'], writes: ['path', 'literalpath'] },
  rm: { positions: ['path'], writes: ['path', 'literalpath'] },
  del: { positions: ['path'], writes: ['path', 'literalpath'] },
  erase: { positions: ['path'], writes: ['path', 'literalpath'] },
  rd: { positions: ['path'], writes: ['path', 'literalpath'] },
  rmdir: { positions: ['path'], writes: ['path', 'literalpath'] },
  'copy-item': { positions: ['path', 'destination'], writes: ['destination'] },
  copy: { positions: ['path', 'destination'], writes: ['destination'] },
  cp: { positions: ['path', 'destination'], writes: ['destination'] },
  cpi: { positions: ['path', 'destination'], writes: ['destination'] },
  'move-item': { positions: ['path', 'destination'], writes: ['path', 'literalpath', 'destination'] },
  move: { positions: ['path', 'destination'], writes: ['path', 'literalpath', 'destination'] },
  mv: { positions: ['path', 'destination'], writes: ['path', 'literalpath', 'destination'] },
  mi: { positions: ['path', 'destination'], writes: ['path', 'literalpath', 'destination'] },
  'rename-item': { positions: ['path', 'newname'], writes: ['path', 'literalpath'] },
  ren: { positions: ['path', 'newname'], writes: ['path', 'literalpath'] },
  rni: { positions: ['path', 'newname'], writes: ['path', 'literalpath'] },
}
const PS_SWITCHES = new Set(['force', 'recurse', 'nonewline', 'append', 'passthru', 'confirm', 'noclobber', 'asbytestream', 'raw', 'container'])
const PS_VALUES = new Set(['path', 'literalpath', 'filepath', 'destination', 'value', 'encoding', 'itemtype', 'name', 'filter', 'include', 'exclude', 'width', 'inputobject', 'stream', 'newname'])

function powerShellCommand(words: Token[]): Found {
  const first = words[0]!
  const args = words.slice(1)
  if (first.quoted) return []
  if (!first.literal) return 'unknown'
  const name = first.text.toLowerCase()
  if (PS_CD.has(name)) return 'cd'
  if (PS_READERS.has(name)) return []
  const writer = PS_WRITERS[name]
  if (writer === undefined) return 'unknown'
  const named = new Map<string, Token>()
  const positional: Token[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const m = a.literal ? /^-([A-Za-z]+)(?::(.*))?$/.exec(a.text) : null
    if (m === null) {
      positional.push(a)
      continue
    }
    const param = m[1]!.toLowerCase()
    if (param === 'whatif') return []
    if (PS_SWITCHES.has(param)) continue
    if (!PS_VALUES.has(param)) return 'unknown'
    if (m[2] !== undefined) named.set(param, { text: m[2], literal: true })
    else if (i + 1 < args.length) named.set(param, args[++i]!)
    else return 'unknown'
  }
  if (name === 'new-item' || name === 'ni') {
    if (named.has('name')) return 'unknown'
  }
  const free = [...writer.positions].filter(p => !named.has(p) && !(p === 'path' && named.has('literalpath')) && !(p === 'filepath' && named.has('literalpath')))
  positional.forEach((t, k) => {
    if (k < free.length) named.set(free[k]!, t)
  })
  if (positional.length > free.length) return 'unknown'
  const out: Token[] = writer.writes.map(p => named.get(p)).filter((t): t is Token => t !== undefined)
  if (out.length === 0) return 'unknown'
  if (out.some(t => t.text.includes(','))) return 'unknown'
  const paths = literals(out)
  if (paths === 'unknown') return paths
  // A rename's new name sits beside the old one: written, but not named here.
  return name === 'rename-item' || name === 'ren' || name === 'rni' ? { partial: paths } : paths
}

function tokenizePowerShell(command: string): Segment[] | null {
  const segments: Segment[] = []
  let segment: Segment = []
  let text = ''
  let literal = true
  let inWord = false
  let quoted = false
  let pending: Token['redirect'] | null = null
  const endWord = () => {
    if (!inWord) return
    segment.push({ text, literal, ...(quoted ? { quoted: true as const } : {}), ...(pending === null ? {} : { redirect: pending }) })
    pending = null
    text = ''
    literal = true
    quoted = false
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  let i = 0
  const n = command.length
  while (i < n) {
    const c = command[i]!
    if ((command.startsWith("@'", i) || command.startsWith('@"', i)) && command[i + 2] === '\n') {
      const close = command.indexOf(`\n${command[i + 1]}@`, i + 2)
      if (close < 0) return null
      if (command[i + 1] === '"') literal = false
      if (!inWord) quoted = true
      text += command.slice(i + 3, close)
      inWord = true
      i = close + 3
      continue
    }
    if (c === "'") {
      let j = i + 1
      let inner = ''
      for (;;) {
        const close = command.indexOf("'", j)
        if (close < 0) return null
        inner += command.slice(j, close)
        if (command[close + 1] === "'") {
          inner += "'"
          j = close + 2
          continue
        }
        i = close + 1
        break
      }
      if (!inWord) quoted = true
      text += inner
      inWord = true
      continue
    }
    if (c === '"') {
      const close = command.indexOf('"', i + 1)
      if (close < 0) return null
      const inner = command.slice(i + 1, close)
      if (/[$`]/.test(inner)) literal = false
      if (!inWord) quoted = true
      text += inner
      inWord = true
      i = close + 1
      continue
    }
    if (c === '`' || c === '$') {
      literal = false
      if (command.startsWith('$null', i) && !/[\w]/.test(command[i + 5] ?? '')) literal = true
      text += c
      inWord = true
      i++
      continue
    }
    if (command.startsWith('<#', i)) {
      const close = command.indexOf('#>', i + 2)
      i = close < 0 ? n : close + 2
      continue
    }
    if (c === '#' && !inWord) {
      while (i < n && command[i] !== '\n') i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === '>' || ((c === '*' || /\d/.test(c)) && command[i + 1] === '>' && !inWord)) {
      endWord()
      i += c === '>' ? 1 : 2
      if (command[i] === '>') i++
      if (command[i] === '&') {
        i++
        while (/\d/.test(command[i] ?? '')) i++
        continue
      }
      pending = 'out'
      continue
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      endSegment()
      const double = command.startsWith('&&', i) || command.startsWith('||', i)
      // `& prog`: the call operator runs something we can't name.
      if (c === '&' && !double) segments.push([{ text: '&', literal: false }])
      i += double ? 2 : 1
      continue
    }
    if (c === '[' && !inWord) literal = false
    if (c === '*' || c === '?' || c === '[') literal = false
    if (c === '@' && !inWord) literal = false
    text += c
    inWord = true
    i++
  }
  endSegment()
  return segments
}
