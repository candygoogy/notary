// Live smoke test: one real headless Claude session with the mods loaded, on a
// fresh scratch repo whose test fails until Claude fixes add.js.
//
//   npm run smoke
//
// Costs a little haiku usage per run: run it by hand, once. Not for CI.
// Nothing is staged: the prompt asks for honest work, so the run should end
// with exactly one `🧾 ✅ Verified` stamp and no send-back.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS = ['receipts', 'changes'].map(name => join(repo, 'plugins', name))
const PROMPT =
  "Add the comment '// math helpers' as the first line of add.js, fix whatever makes the tests fail, run npm test, and tell me the result."
const TIMEOUT_MS = 5 * 60_000

const FILES = {
  'add.js': 'export function add(a, b) { return a - b }\n',
  'add.test.js': [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { add } from './add.js'",
    "test('adds', () => assert.equal(add(2, 3), 5))",
    '',
  ].join('\n'),
  'package.json': '{ "name": "smoke", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

// 1. A fresh scratch repo whose one test fails.
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const scratch = join(tmpdir(), `notary-smoke-${stamp}`)
mkdirSync(scratch, { recursive: true })
for (const [name, text] of Object.entries(FILES)) writeFileSync(join(scratch, name), text)
run('git', ['init', '-q'], { cwd: scratch })
run('git', ['add', '-A'], { cwd: scratch })
run('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@localhost', 'commit', '-qm', 'scratch'], { cwd: scratch })
const before = run('node', ['--test'], { cwd: scratch })
if (before.status === 0) throw new Error('the scratch test passes before Claude ran: the fixture is wrong')

// 2. One headless session with both mods.
const debugFile = join(tmpdir(), `notary-smoke-${stamp}-debug.txt`)
const args = [
  '-p',
  '--model', 'haiku',
  ...PLUGINS.flatMap(dir => ['--plugin-dir', dir]),
  '--allowedTools', 'Edit', 'Read', 'Write', 'Bash', 'PowerShell',
  '--output-format', 'json',
  '--debug-file', debugFile,
  '--',
  PROMPT,
]
console.log(`Scratch repo: ${scratch}`)
console.log('Running claude -p (haiku)…')
const started = Date.now()
const session = run('claude', args, { cwd: scratch, timeout: TIMEOUT_MS })
const seconds = ((Date.now() - started) / 1000).toFixed(0)
if (session.error) throw session.error
let result
try {
  result = JSON.parse(session.stdout)
} catch {
  throw new Error(`claude printed no JSON result (exit ${session.status}):\n${session.stdout.slice(0, 500)}\n${session.stderr.slice(0, 500)}`)
}
check('claude finished without an error', session.status === 0 && result.is_error !== true, `exit ${session.status}`)

// 3. The session's transcript, found by its id under the projects folder.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const projects = join(configDir, 'projects')
const transcript = readdirSync(projects)
  .map(project => join(projects, project, `${result.session_id}.jsonl`))
  .find(path => existsSync(path))
if (transcript === undefined) throw new Error(`no transcript for session ${result.session_id} under ${projects}`)
const rows = readFileSync(transcript, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return {}
    }
  })
const textOf = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => b.text ?? '').join('\n') : '')

const stamps = rows.filter(row => row.type === 'system').map(row => textOf(row.content ?? row.message?.content)).filter(text => text.startsWith('🧾'))
const verified = stamps.filter(text => text.startsWith('🧾 ✅ Verified'))
check('exactly one 🧾 ✅ Verified stamp', verified.length === 1 && stamps.length === 1, stamps.length === 0 ? 'no stamp' : stamps.join(' | '))

const sendBacks = rows
  .filter(row => row.type === 'user')
  .map(row => textOf(row.message?.content))
  .filter(text => /Stop hook feedback/i.test(text) && /Receipts:/.test(text))
check('no Receipts send-back', sendBacks.length === 0, sendBacks[0]?.slice(0, 160) ?? '')

const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
// Without this, "nothing skipped" would pass for a mod that never loaded.
const notLoaded = ['receipts', 'changes'].filter(name => !new RegExp(`hooks module ${name}@\\S+ loaded`).test(debug))
check('both mods loaded', notLoaded.length === 0, notLoaded.length > 0 ? `not loaded: ${notLoaded.join(', ')}` : '')
const problems = debug.split('\n').filter(line => /\b(?:receipts|changes)\b/i.test(line) && /\b(?:skipped|refused)\b/i.test(line))
check('no hook skipped or tree refused for either mod', debug !== '' && problems.length === 0, debug === '' ? 'no debug log' : problems.slice(0, 3).join('\n    '))

const after = run('node', ['--test'], { cwd: scratch })
check('add.js is fixed (node --test passes)', after.status === 0)
const firstLine = readFileSync(join(scratch, 'add.js'), 'utf8').split(/\r?\n/)[0]
const hasComment = firstLine.trim() === '// math helpers'

// Summary.
const answer = String(result.result ?? '').replace(/\s+/g, ' ').trim()
console.log(`\nSession ${result.session_id} · ${seconds}s · $${Number(result.total_cost_usd ?? 0).toFixed(4)}`)
console.log(`Answer: ${answer.slice(0, 300)}${answer.length > 300 ? '…' : ''}`)
console.log(`Stamps: ${stamps.length === 0 ? '(none)' : stamps.join(' | ')}\n`)
for (const { name, ok, detail } of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n    ${detail}` : ''}`)
if (!hasComment) console.log("  note  Claude did not put '// math helpers' first (the model's choice, not a mod check)")
console.log(`\nTranscript: ${transcript}\nDebug log:  ${debugFile}`)
const failed = checks.filter(c => !c.ok).length
console.log(failed === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failed} of ${checks.length} checks)`)
process.exitCode = failed === 0 ? 0 : 1
