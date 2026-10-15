// Classifies a Bash or PowerShell run as evidence (spec §4, "Evidence classes").
// The engine reports a non-zero exit as isError with text starting "Exit code N".
// In Bash a pipe or a later `;` statement hides that code; in PowerShell a
// cmdlet pipe keeps it and only a later native command replaces it. Where it
// is hidden, an echoed status (`echo exit=$?`) or the output decides.

import { normalizeNewlines, stripAnsi } from '../shared/ansi.ts'
import { COMMAND_CHARS, truncate } from './text.ts'
import type { DeclaredCheck, Evidence, RunInput, Strength } from './types.ts'

const OUTPUT_CHARS = 65_536

const STRONG: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+|run-script\s+)?(?:test|t)(?:[:-][\w:.-]+)?(?:\s|$)/,
  /^(?:vitest|jest|mocha|ava|karma|playwright\s+test|cypress\s+run)\b/,
  /^(?:node|deno|bun)\s+(?:--test|test)\b/,
  /^(?:pytest|py\.test|tox|nox)\b/,
  /^(?:python[\d.]*|py)\s+(?:-\w+\s+)*-m\s+(?:pytest|unittest|tox|nox)\b/,
  /^cargo\s+(?:test|nextest)\b/,
  /^go\s+test\b/,
  /^dotnet\s+test\b/,
  /^gradlew?\b.*\s(?::?[\w-]+:)*(?:test|check)\b/,
  /^mvnw?\b.*\s(?:test|verify)\b/,
  /^(?:invoke-pester|[\w-]*pester)\b/,
  /^(?:rspec|phpunit|ctest)\b/,
  /^(?:make|mix|swift)\s+(?:test|check)\b/,
  /^(?:php\s+)?artisan\s+test\b/,
]

const MEDIUM: readonly RegExp[] = [
  /^(?:tsc|vue-tsc)(?:\s|$)/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|type-check|lint|check|tsc|compile)(?:[:-][\w:.-]+)?(?:\s|$)/,
  /^cargo\s+(?:build|check|clippy)\b/,
  /^go\s+(?:build|vet)\b/,
  /^dotnet\s+build\b/,
  /^(?:mypy|pyright|basedpyright|ruff|eslint|flake8|pylint)\b/,
  /^biome\s+(?:check|lint|ci)\b/,
  /^(?:next|vite|webpack|turbo|nx|astro)\b.*\bbuild\b/,
  /^gradlew?\b.*\s(?:assemble|build)\b/,
  /^mvnw?\b.*\s(?:package|install|compile)\b/,
  /^(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b.*(?:\blocalhost\b|\b127\.0\.0\.1\b|\[::1\]|\b0\.0\.0\.0\b)/,
]

// Flags that make a runner list, describe or build without running a check.
// Formatting checks neither back nor contradict a claim (lead's rule): code can
// be correct and unformatted, or formatted and broken.
const FORMAT_ONLY = /^(?:ruff\s+format|prettier|black|cargo\s+fmt|rustfmt|gofmt|dotnet\s+format|biome\s+format)\b/

// A build, type or lint tool's own all-clear line, which a failing run never
// prints. When a later step owns the exit code, it is the only pass we trust.
const TOOL_PASS_LINES: Readonly<Record<string, RegExp>> = {
  ruff: /^All checks passed!\s*$/m,
  pyright: /^\s*0 errors?, \d+ warnings?/m,
  basedpyright: /^\s*0 errors?, \d+ warnings?/m,
  mypy: /^Success: no issues found/m,
  cargo: /^\s*Finished\s+`?\w+`?\s+profile/m,
  dotnet: /^\s*Build succeeded\./m,
  gradle: /^BUILD SUCCESSFUL\b/m,
  gradlew: /^BUILD SUCCESSFUL\b/m,
  mvn: /\bBUILD SUCCESS\b/m,
  mvnw: /\bBUILD SUCCESS\b/m,
}

// `--select ALL` turns on every lint rule to explore, not to gate (lower-cased here).
const NOT_A_RUN = /(?:^|\s)--(?:version|help|collect-only|co|no-run|listtests|list-tests|list|dry-run|init|showconfig)\b|(?:^|\s)--select[ =]all\b/

// A fallback that swallows the result: `|| true`, `|| exit 0`, `|| :`.
const SWALLOW = /^(?:true|:|\$true|exit(?:\s+\/b)?\s+0|exit)$/i

// PowerShell statements that run no native command, so leave $LASTEXITCODE be:
// cmdlets (Verb-Noun), common aliases and keywords, variables, strings, blocks.
const PS_NOT_NATIVE = /^(?:[$"'@[({}#%?.]|[a-z]+-[a-z]+\b|(?:cd|ls|dir|echo|cat|type|cp|copy|mv|move|rm|del|ri|ni|mkdir|pwd|sleep|select|where|sort|foreach|if|else|elseif|for|while|try|catch|finally|return|exit|write|sl|gci|gc|sc|iwr|irm|cls|clear|param|function)\b)/i

// A test runner's own failure lines, and a build's or type check's.
const TEST_FAIL_MARKERS: readonly RegExp[] = [
  /test result: FAILED/,
  /--- FAIL:/,
  /^\s*FAIL\b/m,
  /^FAILED\s/m,
  /\bFailed!/,
  /\bTests run:.*\bFailures: [1-9]/,
  /^\s*[✗✕×✖]\s/m,
]
const BUILD_FAIL_MARKERS: readonly RegExp[] = [
  /\berror TS\d+/,
  /\bBUILD FAILED\b|\bBUILD FAILURE\b|FAILURE: Build failed/,
  /^error(?:\[E\d+\])?:/m,
  /\bcould not compile\b/,
]
const ZERO_MARKERS =
  /\bno tests? (?:ran|found|to run|were found|collected|executed)\b|\bcollected 0 items\b|\bno test files? found\b|\brunning 0 tests\b|\bTotal tests: 0\b|\bTests:\s+0 total\b|\bRan 0 tests\b|\bTests Passed: 0, Failed: 0\b|\bTests\s+no tests\b/i
// The shell failed before any runner spoke: a PowerShell error record, a missing command.
const SHELL_FAILURE = /^\s*Line \|$|^(?:\w+\.)*\w*Exception:|: command not found\b|is not recognized as (?:(?:the|a) name of a cmdlet|an internal or external command)/m

// "no tests" because the test file itself broke (an import that failed) is a failure.
const ZERO_BUT_BROKEN = /^\s*(?:\w*Error|Error):/m

// Counts bound to their own word: "3 failed" and "failed: 3", never the "268"
// of "passed 268 failed 0". Within one line: " 0 fail\n 30 expect() calls"
// holds no "fail 30".
const FAIL_COUNTS = [
  /(?<!\b(?:passed|pass|ok)[:=]?[ \t]+)\b(\d+)[ \t]+(?:failed|failing|failures?)\b/gi,
  /\b(?:failed|fail|failures?|failing)[:=]?[ \t]+(\d+)\b/gi,
]
const PASS_COUNTS = [
  /(?<!\b(?:failed|fail)[:=]?[ \t]+)\b(\d+)[ \t]+(?:passed|passing)\b/gi,
  /\b(?:passed|pass)[:=]?[ \t]+(\d+)\b/gi,
]
const ERROR_COUNTS = [/\b(\d+)[ \t]+errors?\b/gi]
// A test summary line: where a runner run twice in one command last reported.
const SUMMARY_LINE = /\b\d+[ \t]+(?:passed|failed|failing|passing)\b|\b(?:passed|failed):[ \t]*\d+/i
// Steps before a runner that cannot stop it: cd, set, export, echo, source.
const TRIVIAL_STEP = /^(?:cd|pushd|popd|set|export|echo|source|\.|set-location|sl)(?:\s|$)/i

type Segment = { text: string; connector: string }

// A test runner's own summary line, recognized by its shape whatever command
// ran it (`pnpm verify`, `timeout 120 pnpm exec vitest`, a heredoc script).
// Only these lines are read for a verdict: never words inside test names.
const RUNNER_SUMMARIES: readonly RegExp[] = [
  /^\s*Tests\s+(?:\d+\s+(?:passed|failed|skipped|todo)\b|no tests\b)/, // vitest
  /^\s*Test Files\s+\d+\s+(?:passed|failed)\b/, // vitest
  /^\s*Tests:\s+\d+\s+(?:passed|failed|skipped|todo|total)\b/, // jest
  /^\s*\d+\s+(?:passed|failed|flaky)\s+\(\d+(?:\.\d+)?m?s\)/, // playwright
  /^\s*\d+\s+(?:failed|flaky|interrupted|did not run)\s*$/, // playwright line reporter
  /^=*\s*(?:\d+\s+(?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected),?\s+)+in\s+[\d.]+s\b/, // pytest
  /^test result: (?:ok|FAILED)\. \d+ passed/, // cargo test
  /^(?:ok|FAIL)\s+\S+\s+(?:\(cached\)|[\d.]+s)/, // go test
  /^[ℹ#] (?:pass|fail) \d+\s*$/, // node --test, TAP
  /^\s*(?:Passed|Failed)!\s+-\s+Failed:\s+\d+/, // dotnet test
  /Tests Passed: \d+, Failed: \d+/, // Pester
  /^\s*\d+ (?:passing|failing)(?: \(\d|\s*$)/, // mocha
  /^\s*\d+ (?:pass|fail)\s*$/, // bun test
  /^Ran \d+ tests? in [\d.]+s\s*$/, // unittest
]
const SUMMARY_FAILS: readonly RegExp[] = [
  /(?<!\b(?:passed|pass|ok)[:=]?[ \t]+)\b[1-9]\d*[ \t]+(?:failed|failing|fail|errors?|interrupted)\b/i,
  /\b(?:failed|fail|failures?)[:=]?[ \t]+[1-9]\d*/i,
  /^test result: FAILED/,
  /^FAIL\s/,
  /^\s*Failed!/,
]
// A run that covered only part of the suite: the runner says so ("114 filtered
// out", "3 deselected"), or the command picks tests by name (`-k`, `-t`,
// `--filter`, `-run`, `--grep`, `-g`, `--testNamePattern`, or cargo's `-- <name>`).
const SUBSET_OUTPUT = /\b[1-9]\d*\s+(?:filtered out|deselected)\b/
const SUBSET_COMMAND = /\s(?:-k|-t|-g|--filter|-run|--run|--grep|--testnamepattern|--test-name-pattern)(?:[ =]|$)|\s--\s+[a-z_]/
// A runner's line for one failing file or test: jest and vitest, go.
const RUNNER_FAIL_LINES: readonly RegExp[] = [/^\s*FAIL {1,2}\S+\.(?:test|spec)\.[cm]?[jt]sx?\b/m, /^\s*--- FAIL: \S+/m]
// Commands that only show what an earlier run wrote: a summary they print is old news.
const READER = /^(?:cat|type|less|more|head|tail|grep|rg|findstr|awk|sed|get-content|gc|select-string|sls|jq)\b/i
// The run never finished: a timeout, an interrupt, or a call the person turned down.
const NOT_FINISHED = /\bCommand timed out\b|\btimed out after\b|\bInterrupted by user\b|\[Request interrupted|\bdoesn't want to proceed with this tool use\b|\btool use was rejected\b/i

// `checks`: commands the person declared as checks (core/checks.ts), read as
// a test run (tests) or a build run (build) where nothing built in is stronger.
export function classify(run: RunInput, checks: readonly DeclaredCheck[] = []): Evidence {
  const segments = split(run.command)
  // The last of the strongest segments decides: in `a; npm test; echo $?` that is the run whose status is shown.
  let best: { index: number; strength: Strength } = { index: -1, strength: 'none' }
  for (const [index, segment] of segments.entries()) {
    const strength = strengthOf(segment.text, checks)
    if (strength !== 'none' && rank(strength) >= rank(best.strength)) best = { index, strength }
  }
  const whole = normalizeNewlines(stripAnsi(run.text.length > OUTPUT_CHARS ? run.text.slice(-OUTPUT_CHARS) : run.text))
  // A runner's own summary makes the run a test run, whatever its command was.
  const steps = segments.filter(segment => !TRIVIAL_STEP.test(display(segment.text)))
  const readsOnly = steps.length > 0 && steps.every(segment => READER.test(coreOf(segment.text)))
  if (best.strength !== 'strong' && !readsOnly && runnerSummaries(whole).length > 0) {
    const index = best.index >= 0 ? best.index : segments.indexOf(steps[0] ?? segments[0])
    best = { index, strength: 'strong' }
  }
  const command = best.index < 0 ? display(run.command) : display(segments[best.index].text)
  const shown = truncate(command, COMMAND_CHARS)
  if (best.strength === 'none' || isSwallowed(segments, best.index)) {
    return { strength: 'none', outcome: run.isError ? 'fail' : 'pass', command, summary: `${shown}: not a check` }
  }
  if (run.backgrounded) return { strength: best.strength, outcome: 'pending', command, summary: `${shown} is still running` }

  // A runner run twice in one command (break the code, test, restore, test): its last summary decides.
  const out = isRepeated(segments, best.index) ? fromLastSummary(whole) : whole
  const summaries = runnerSummaries(out)
  const failing = summaries.filter(line => SUMMARY_FAILS.some(pattern => pattern.test(line)))
  const summaryPass = largest(summaries.join('\n'), PASS_COUNTS)
  const summaryFail = largest(failing.join('\n'), FAIL_COUNTS)
  const isZero = ZERO_MARKERS.test(out)
  const echoed = echoedStatus(run, segments, best.index, out)
  const exitCode = echoed ?? (run.isError ? (/^Exit code (\d+)/.exec(run.text.slice(0, 40))?.[1] ?? null) : '0')
  // A failing run of part of the suite (a mutation check, one test by name) is
  // marked, so it cannot overturn an earlier full pass (ledger.ts).
  const isSubset = SUBSET_OUTPUT.test(out) || SUBSET_COMMAND.test(coreOf(segments[best.index].text))
  const result = (outcome: Evidence['outcome'], summary: string, strength: Strength = best.strength): Evidence =>
    outcome === 'fail' && isSubset && strength !== 'none' ? { strength, outcome, command, summary, subset: true } : { strength, outcome, command, summary }
  const failed = (detail: string | null) =>
    (exitCode !== null && exitCode !== '0' ? `${shown} exited ${exitCode}` : `${shown} failed`) + (detail !== null ? ` (${detail})` : '')
  const passedText = summaryPass > 0 ? `${shown} passed (${summaryPass})` : `${shown} passed`
  const zero = () => (ZERO_BUT_BROKEN.test(out) ? result('fail', failed('no tests ran')) : result('zero-tests', `${shown} ran no tests`))

  // It never finished, or never started: no evidence either way.
  if (run.isError && summaries.length === 0 && NOT_FINISHED.test(out)) return result('fail', `${shown}: did not finish`, 'none')
  if (run.isError && summaries.length === 0 && !isZero && SHELL_FAILURE.test(out)) return result('fail', `${shown}: did not run`, 'none')

  // The chain stopped before the runner: an earlier step failed and the runner said nothing.
  const runnerSpoke = summaries.length > 0 || isZero || TEST_FAIL_MARKERS.some(pattern => pattern.test(out))
  const before = stepsBefore(run.command, segments, best.index)
  if (run.isError && best.strength === 'strong' && before.length > 0 && !runnerSpoke) {
    const build = before.findLast(segment => strengthOf(segment.text, checks) !== 'none')
    const errorCount = largest(out, ERROR_COUNTS)
    const buildMarker = BUILD_FAIL_MARKERS.map(pattern => pattern.exec(out)?.[0].trim()).find(found => found !== undefined)
    if (build === undefined || (errorCount === 0 && buildMarker === undefined)) return result('fail', `${shown}: did not run`, 'none')
    const buildCommand = display(build.text)
    const buildShown = truncate(buildCommand, COMMAND_CHARS)
    const head = exitCode !== null && exitCode !== '0' ? `${buildShown} exited ${exitCode}` : `${buildShown} failed`
    const detail = errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : truncate(buildMarker ?? '', COMMAND_CHARS)
    return { strength: strengthOf(build.text, checks), outcome: 'fail', command: buildCommand, summary: `${head} (${detail})` }
  }

  // A runner's own summary that reports failures is its verdict, whatever the
  // exit code (Pester exits 0 on failures without -CI; a wrapper may swallow it).
  if (failing.length > 0) return result('fail', failed(summaryFail > 0 ? `${summaryFail} failed` : truncate(failing[0].trim(), COMMAND_CHARS)))

  // The exit code is the runner's (nothing after it can replace it, or it was
  // echoed right after): it decides. Words in the output (a test named "returns
  // 401 error", eslint warnings) never overturn it. Counts shown are cosmetic.
  if (exitCode !== null && ownsExitCode(run, segments, best.index, echoed, exitCode)) {
    if (exitCode === '0') {
      if (isZero && summaryPass === 0) return zero()
      const count = summaryPass > 0 ? summaryPass : largest(out, PASS_COUNTS)
      return result('pass', count > 0 ? `${shown} passed (${count})` : `${shown} passed`)
    }
    if (isZero && summaryPass === 0) return zero()
    const count = largest(out, FAIL_COUNTS)
    return result('fail', failed(count > 0 ? `${count} failed` : null))
  }

  // Otherwise only the runner's own lines decide: its summary, a per-file
  // failure line (` FAIL  src/a.test.ts > …`, `--- FAIL: TestX`), or an
  // anchored compile failure (`error[E0432]:`, `could not compile`, `error TS2322:`).
  const fileFailure = RUNNER_FAIL_LINES.map(pattern => pattern.exec(out)?.[0].trim()).find(found => found !== undefined)
  if (fileFailure !== undefined) return result('fail', failed(truncate(fileFailure, COMMAND_CHARS)))
  if (summaryPass > 0) return result('pass', passedText)
  if (isZero) return zero()
  const compile = BUILD_FAIL_MARKERS.map(pattern => pattern.exec(out)?.[0].trim()).find(found => found !== undefined)
  if (compile !== undefined) return result('fail', failed(truncate(compile, COMMAND_CHARS)))
  // A build, type or lint tool's own all-clear line. Its failure lines are not
  // read here: a later step (`ruff check --select ALL`) may have printed them.
  const toolPass = TOOL_PASS_LINES[coreOf(segments[best.index].text).split(/\s+/)[0]]
  if (best.strength === 'medium' && toolPass !== undefined && toolPass.test(out)) return result('pass', `${shown} passed`)
  return result('pass', `${shown}: exit code hidden`, 'none')
}

// A medium run that is no build: a request to a local server.
const PROBE = /^(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/

// What a command checks, in a claim's words: a test runner backs a tests
// claim; a build, type or lint tool a build claim; anything else, nothing.
// For "`npm test` passes", whose subject is the command itself.
export function checkKindOf(command: string, checks: readonly DeclaredCheck[] = []): 'tests' | 'build' | null {
  let kind: 'tests' | 'build' | null = null
  for (const segment of split(command)) {
    const strength = strengthOf(segment.text, checks)
    if (strength === 'strong') return 'tests'
    if (strength === 'medium' && !PROBE.test(coreOf(segment.text))) kind = 'build'
  }
  return kind
}

function runnerSummaries(out: string): string[] {
  return out.split('\n').filter(line => RUNNER_SUMMARIES.some(pattern => pattern.test(line)))
}

// Whether the reported exit code is the runner's own: echoed right after it,
// or nothing after it could replace it. After `npm test && git commit` an
// exit 0 means both passed, but a non-zero one may be the commit's.
function ownsExitCode(run: RunInput, segments: Segment[], index: number, echoed: string | null, exitCode: string): boolean {
  if (echoed !== null) return true
  if (isMasked(run, segments, index)) return false
  if (exitCode === '0') return true
  let next = index + 1
  while (next < segments.length && segments[next - 1].connector === '|') next++
  return segments.slice(next).every(segment => TRIVIAL_STEP.test(display(segment.text)))
}

// Whether the deciding runner runs more than once in the command, whatever
// its arguments: red-green in one command (`vitest run test/a.test.ts`, fix,
// `vitest run`) ends with the last invocation, whose summary decides.
function isRepeated(segments: Segment[], index: number): boolean {
  const runner = runnerOf(segments[index].text)
  return segments.filter(segment => runnerOf(segment.text) === runner).length > 1
}

// A runner's identity: its program and subcommand, without paths or flags
// (`vitest run test/x.test.ts` and `vitest run` are one runner).
export function runnerOf(segment: string): string {
  const words = coreOf(segment)
    .split(/\s+/)
    .filter(word => word !== '' && !word.startsWith('-') && !/[/\\.]/.test(word))
  return words.slice(0, 2).join(' ')
}

function fromLastSummary(out: string): string {
  const lines = out.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (SUMMARY_LINE.test(lines[i])) return lines.slice(i).join('\n')
  return out
}

// The non-trivial steps that must succeed before the runner starts: those
// joined to it by &&, or by ; under `set -e`.
function stepsBefore(command: string, segments: Segment[], index: number): Segment[] {
  const stopsOnError = /\bset\s+-\w*e/.test(command)
  const steps: Segment[] = []
  for (let i = index - 1; i >= 0; i--) {
    const connector = segments[i].connector
    if (connector !== '&&' && !(connector === ';' && stopsOnError)) break
    if (!TRIVIAL_STEP.test(display(segments[i].text))) steps.unshift(segments[i])
  }
  return steps
}

function strengthOf(segment: string, checks: readonly DeclaredCheck[] = []): Strength {
  const core = coreOf(segment)
  if (core === '' || NOT_A_RUN.test(core) || FORMAT_ONLY.test(core)) return 'none'
  const builtIn: Strength = STRONG.some(pattern => pattern.test(core)) ? 'strong' : MEDIUM.some(pattern => pattern.test(core)) ? 'medium' : 'none'
  const declared = declaredStrength(core, checks)
  // A declared check only ever raises a run's weight; what the run says
  // (exit code, summary) decides its outcome either way.
  return rank(declared) > rank(builtIn) ? declared : builtIn
}

// A declared check matches the command it names and that command with more
// arguments, after the same wrappers come off both (`timeout 300 pnpm verify --ci`
// is `pnpm verify`), never a longer word (`pnpm verifyx`).
function declaredStrength(core: string, checks: readonly DeclaredCheck[]): Strength {
  let strength: Strength = 'none'
  for (const check of checks) {
    const prefix = coreOf(check.prefix)
    if (prefix === '' || (core !== prefix && !core.startsWith(`${prefix} `))) continue
    const own: Strength = check.kind === 'tests' ? 'strong' : 'medium'
    if (rank(own) > rank(strength)) strength = own
  }
  return strength
}

// The segment reduced to the tool that runs and its arguments, lower-cased:
// env assignments, `cmd /c`, the call operator, npx and friends taken off the
// front; the program named by its basename (`.\venv\Scripts\python.exe` is
// `python`); and `node node_modules/vitest/vitest.mjs` read as `vitest`.
function coreOf(segment: string): string {
  let core = display(segment).toLowerCase()
  for (;;) {
    const before = core
    core = core
      .replace(/^(?:[a-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
      .replace(/^(?:cmd(?:\.exe)?\s+\/c\s+|&\s+|call\s+|time\s+|env\s+|command\s+|exec\s+)/, '')
      .replace(/^g?timeout\s+(?:(?:-[ks]|--kill-after|--signal)\s+\S+\s+|-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/, '')
      // Workspace and output flags between the package manager and its script.
      .replace(/^(npm|pnpm|yarn|bun)\s+(?:(?:-r|--recursive|-s|--silent|--if-present|-ws|--workspaces|(?:--prefix|-C|--dir|--filter|-F|-w|--workspace)(?:=|\s+)\S+)\s+)+/, '$1 ')
      .replace(/^make\s+(?:(?:-j\d*|--jobs(?:=\d+)?|-k|-s|-C\s+\S+)\s+)+/, 'make ')
      .replace(/^(?:npx(?:\.cmd)?(?:\s+(?:--yes|-y))?\s+|pnpm\s+(?:dlx|exec)\s+|bunx\s+|yarn\s+(?:dlx|exec)\s+|npm\s+exec\s+(?:--\s+)?|(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+|bundle\s+exec\s+)/, '')
      .replace(/^(?:yarn|pnpm)\s+(?=(?:vitest|jest|mocha|tsc|vue-tsc|eslint|playwright|biome)\b)/, '')
    const [first = '', ...rest] = words(core)
    const program = basename(first)
    if (program === 'node' && rest.length > 0 && /[/\\]/.test(rest[0])) {
      const pkg = /node_modules[/\\](?:@([^/\\]+)[/\\])?([^/\\]+)/.exec(rest[0])
      core = [pkg !== null ? (pkg[1] ?? pkg[2]) : basename(rest[0]), ...rest.slice(1)].join(' ')
    } else {
      core = [program, ...rest].join(' ')
    }
    if (core === before) return core
  }
}

function basename(word: string): string {
  return word
    .replace(/^["']|["']$/g, '')
    .split(/[/\\]/)
    .pop()!
    .replace(/\.(?:exe|cmd|bat|ps1|mjs|cjs|js)$/, '')
}

function words(text: string): string[] {
  return text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

// The segment as shown: trimmed, with redirections such as `2>&1` and a
// subshell's parentheses taken out.
function display(segment: string): string {
  return segment
    .replace(/\s+(?:\d|\*)?>>?(?:&\d|\s*\S+)/g, '')
    .replace(/^\(+\s*|\s*\)+$/g, '')
    .replace(/^&\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Splits on && || | ; & and newlines outside quotes. `>&` and `&>` are redirections.
function split(command: string): Segment[] {
  const segments: Segment[] = []
  let text = ''
  let quote: string | null = null
  const push = (connector: string) => {
    segments.push({ text: text.trim(), connector })
    text = ''
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote !== null) {
      if (c === quote) quote = null
      text += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      text += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push(two)
      i++
      continue
    }
    if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>' || text.trim() === '')) {
      text += c
      continue
    }
    if (c === '|' || c === ';' || c === '\n' || c === '&') {
      push(c === '\n' ? ';' : c)
      continue
    }
    text += c
  }
  push('')
  return segments.filter(segment => segment.text !== '')
}

// Whether the run's exit code can be someone else's by the time the tool reports it.
function isMasked(run: RunInput, segments: Segment[], index: number): boolean {
  if (segments.slice(index).some(segment => segment.connector === '||')) return true
  if (run.tool === 'PowerShell') {
    return segments.slice(index + 1).some((segment, i) => segments[index + i].connector !== '|' && !PS_NOT_NATIVE.test(display(segment.text)))
  }
  const connector = segments[index].connector
  if (connector === '|') return !/\bpipefail\b/.test(run.command)
  return connector === ';' || connector === '&'
}

// An exit status the command printed itself: `npm test; echo exit=$?` printing
// "exit=0", or PowerShell's `"build: $LASTEXITCODE"`. Read only where the echo
// directly follows the run's statement. In Bash, `$?` after `npm test | grep`
// is grep's status (without pipefail), so it says nothing about the runner.
function echoedStatus(run: RunInput, segments: Segment[], index: number, out: string): string | null {
  if (run.tool === 'Bash' && segments[index].connector === '|' && !/\bpipefail\b/.test(run.command)) return null
  let next = index + 1
  while (next < segments.length && segments[next - 1].connector === '|') next++
  const echo = segments[next]
  if (echo === undefined) return null
  const variable = run.tool === 'PowerShell' ? /\$LASTEXITCODE\b/i : /\$\?/
  const found = variable.exec(echo.text)
  if (found === null) return null
  const label = echo.text
    .slice(0, found.index)
    .replace(/^(?:echo|write-output|write-host|printf)\s+/i, '')
    .replace(/^["']/, '')
  if (label.trim() === '') return null
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}\\s*(\\d+)\\s*$`, 'm').exec(out)?.[1] ?? null
}

function isSwallowed(segments: Segment[], index: number): boolean {
  for (let i = index; i < segments.length - 1; i++) {
    if (segments[i].connector === '||' && SWALLOW.test(segments[i + 1].text)) return true
  }
  return false
}

function largest(text: string, patterns: readonly RegExp[]): number {
  let most = 0
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) most = Math.max(most, Number(match[1]))
  }
  return most
}

function rank(strength: Strength): number {
  return strength === 'strong' ? 2 : strength === 'medium' ? 1 : 0
}
