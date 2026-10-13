// Release gate for Receipts: replays your own Claude Code transcripts through the
// real core and prints aggregate counts. Read-only, local, writes nothing.
//
//   npm run replay                      ~/.claude/projects
//   npm run replay -- <dir>             another projects folder
//   npm run replay -- --examples 10     also print redacted snippets (terminal only)
//   The quiet (default) and all verbosities are both reported.
//
// The replay itself lives in plugins/receipts/hooks/core/replay.ts; this file
// walks the folders and prints.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { makeParser, redact, replaySession } from '../../plugins/receipts/hooks/core/replay.ts'
import type { Reason, ReplayEvent, TurnResult } from '../../plugins/receipts/hooks/core/replay.ts'
import type { ClaimKind } from '../../plugins/receipts/hooks/core/types.ts'
import { visibility } from '../../plugins/receipts/hooks/core/visibility.ts'
import type { Verbosity } from '../../plugins/receipts/hooks/core/visibility.ts'

// Sessions the Notary team ran to demo or probe Receipts.
export const SKIP_PROJECTS = /notary-smoke|notary-tools-probe/i
const REASONS: readonly Reason[] = ['carried-over', 'unrecognized-check-after', 'nothing-checked-after']

// The options after the folder: a folder (first bare word) and --examples [n].
export function parseArgs(argv: readonly string[]): { root: string | null; examples: number } {
  const at = argv.indexOf('--examples')
  const count = at >= 0 && /^\d+$/.test(argv[at + 1] ?? '') ? Number(argv[at + 1]) : 10
  const root = argv.find((arg, i) => !arg.startsWith('--') && !(at >= 0 && i === at + 1 && /^\d+$/.test(arg))) ?? null
  return { root, examples: at < 0 ? 0 : count }
}

// Counts what reaches the person under a verbosity, in mode B: flags are ⚠️ or ❌ on
// the band, nudges go with ⚠️, send-backs with ❌.
export function shownAs(turns: readonly TurnResult[], verbosity: Verbosity) {
  const out = { flags: 0, stamps: 0, nudges: 0, sendBacks: 0 }
  for (const t of turns) {
    const v = visibility({ kind: t.verdict, claim: { kind: t.claimKind } }, t.reason === 'carried-over', verbosity)
    if (v.band && t.verdict !== 'verified') out.flags++
    if (v.stamp) out.stamps++
    if (v.nudge && t.verdict === 'unverified') out.nudges++
    if (v.sendBackEligible && t.verdict === 'contradicted') out.sendBacks++
  }
  return out
}

async function readSession(file: string, subagent: boolean): Promise<ReplayEvent[]> {
  const parser = makeParser(subagent)
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) parser.push(line)
  return parser.events
}

function user(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const root = args.root ?? join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) throw new Error(`No transcripts folder at ${root}`)
  const hide = (text: string) => redact(text, homedir(), user())

  const totals = { sessions: 0, turns: 0, claimTurns: 0, staged: 0 }
  const judged: Array<TurnResult & { project: number }> = []
  const projects = readdirSync(root).filter(name => !SKIP_PROJECTS.test(name) && statSync(join(root, name)).isDirectory())
  for (const [index, project] of projects.entries()) {
    const dir = join(root, project)
    for (const file of readdirSync(dir).filter(name => name.endsWith('.jsonl'))) {
      const events = await readSession(join(dir, file), false)
      const subagents = join(dir, file.replace(/\.jsonl$/, ''), 'subagents')
      if (existsSync(subagents)) {
        for (const sub of readdirSync(subagents).filter(name => name.endsWith('.jsonl'))) events.push(...(await readSession(join(subagents, sub), true)))
      }
      if (!events.some(e => e.kind === 'prompt')) continue
      const session = replaySession(events)
      totals.sessions++
      totals.turns += session.turns
      totals.claimTurns += session.claimTurns
      totals.staged += session.staged
      for (const turn of session.judged) judged.push({ ...turn, project: index + 1 })
    }
  }

  const count = (pick: (t: TurnResult) => boolean) => judged.filter(pick).length
  const pct = (n: number, of: number) => (of === 0 ? '-' : `${((100 * n) / of).toFixed(1)}%`)
  const unverified = judged.filter(t => t.verdict === 'unverified')
  const contradicted = count(t => t.verdict === 'contradicted')
  const claimTurns = totals.claimTurns - totals.staged

  console.log(`Receipts replay of ${hide(root)}`)
  console.log(`${totals.sessions} sessions, ${totals.turns} turns, ${claimTurns} with a success claim (${totals.staged} staged, skipped)\n`)
  console.log('Verdicts')
  console.log(`  judged        ${judged.length}`)
  console.log(`  ✅ verified    ${count(t => t.verdict === 'verified')}`)
  console.log(`  ⚠️ unverified  ${unverified.length}  (${pct(unverified.length, claimTurns)} of claim turns)`)
  console.log(`  ❌ contradicted ${contradicted}\n`)
  console.log('⚠️ by reason            tests  build  generic')
  for (const reason of REASONS) {
    const rows = unverified.filter(t => t.reason === reason)
    const by = (kind: ClaimKind) => rows.filter(t => t.claimKind === kind).length
    console.log(`  ${reason.padEnd(26)}${String(by('tests')).padStart(5)}${String(by('build')).padStart(7)}${String(by('generic')).padStart(9)}`)
  }
  const display = { quiet: shownAs(judged, 'quiet'), all: shownAs(judged, 'all') }
  console.log('\nWhat the person sees (mode B)  flags  per 20 claim turns  stamps  nudges  send-backs')
  for (const verbosity of ['quiet', 'all'] as const) {
    const d = display[verbosity]
    const row = [
      String(d.flags).padStart(6),
      (claimTurns === 0 ? '-' : ((20 * d.flags) / claimTurns).toFixed(2)).padStart(20),
      String(d.stamps).padStart(8),
      String(d.nudges).padStart(8),
      String(d.sendBacks).padStart(12),
    ]
    console.log(`  ${(verbosity === 'quiet' ? 'quiet (default)' : 'all').padEnd(29)}${row.join('')}`)
  }

  const visibleWarnings = display.quiet.flags - contradicted
  console.log('\nRelease gate (default: quiet)')
  console.log(`  visible ⚠️ on at most 1 in 20 claim turns: ${visibleWarnings <= claimTurns / 20 ? 'PASS' : 'FAIL'} (${visibleWarnings}, ${pct(visibleWarnings, claimTurns)})`)
  console.log(`  every ❌ and send-back hand-checked:      ${contradicted === 0 ? 'PASS (none)' : `CHECK ${contradicted} (run with --examples)`}`)

  if (args.examples > 0) {
    console.log('\nExamples (redacted, not saved)')
    const show = [...judged.filter(t => t.verdict === 'contradicted'), ...unverified.slice(0, args.examples)]
    for (const t of show) {
      console.log(`\n  ${t.verdict === 'contradicted' ? '❌' : '⚠️'} project ${t.project} · ${t.claimKind}${t.reason ? ` · ${t.reason}` : ''}`)
      console.log(`    claim:    ${hide(t.claim).slice(0, 160)}`)
      if (t.evidence !== null) console.log(`    evidence: ${hide(t.evidence).slice(0, 160)}`)
      if (t.lastCommand !== null) console.log(`    last run: ${hide(t.lastCommand).replace(/\s+/g, ' ').slice(0, 140)}`)
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
