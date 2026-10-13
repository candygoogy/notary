import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify } from '../../plugins/receipts/hooks/core/evidence.ts'
import type { RunInput } from '../../plugins/receipts/hooks/core/types.ts'

function run(command: string, text = '', more: Partial<RunInput> = {}): RunInput {
  return { tool: 'Bash', command, isError: false, text, backgrounded: false, ...more }
}

test('a passing npm test is strong evidence with its count', () => {
  assert.deepEqual(classify(run('npm test', 'Tests: 42 passed')), {
    strength: 'strong',
    outcome: 'pass',
    command: 'npm test',
    summary: 'npm test passed (42)',
  })
})

test('a failing npm test reports its exit code and failures', () => {
  const ev = classify(run('npm test', 'Exit code 1\n... 1 failed, 41 passed', { isError: true }))
  assert.equal(ev.outcome, 'fail')
  assert.equal(ev.summary, 'npm test exited 1 (1 failed)')
})

test('a piped runner hides its exit code, so the output decides', () => {
  const ev = classify(run('npm test 2>&1 | tail -5', 'Tests: 1 failed, 41 passed, 42 total'))
  assert.equal(ev.strength, 'strong')
  assert.equal(ev.outcome, 'fail')
  assert.equal(ev.summary, 'npm test failed (1 failed)')
})

test('a piped runner with no readable outcome is no evidence', () => {
  assert.equal(classify(run('npm test | tail -1', 'Done in 3.2s')).strength, 'none')
})

test('pytest that ran nothing is zero-tests', () => {
  assert.equal(classify(run('pytest -q', 'no tests ran in 0.01s')).outcome, 'zero-tests')
})

test('pytest exit code 5 with no tests is zero-tests, not fail', () => {
  const ev = classify(run('pytest', 'Exit code 5\ncollected 0 items\n\nno tests ran in 0.02s', { isError: true }))
  assert.equal(ev.outcome, 'zero-tests')
})

test('tsc --noEmit is medium; its own exit code decides, not words in the output', () => {
  assert.equal(classify(run('npx tsc --noEmit')).strength, 'medium')
  const text = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable"
  assert.equal(classify(run('npx tsc --noEmit', `Exit code 2\n${text}`, { isError: true })).outcome, 'fail')
  // Review: a clean, unmasked exit 0 is not overturned by output text.
  assert.equal(classify(run('npx tsc --noEmit', text)).outcome, 'pass')
})

// Review major 2: free text never overturns a known exit code.
for (const [command, text] of [
  ['npm test', ' ✓ returns 401 error without token\n Tests  12 passed (12)'],
  ['npm test', ' ✓ marks job dead after 3 failed attempts\n Tests  8 passed (8)'],
  ['npx eslint .', '✖ 3 problems (0 errors, 3 warnings)'],
  ['pytest -q', 'error: could not reach cache, continuing\n8 passed in 0.12s'],
] as const) {
  test(`exit 0 decides over words in the output: ${text.split('\n')[0]}`, () => {
    assert.equal(classify(run(command, text)).outcome, 'pass')
  })
}

test('masked: a lone ✓ or PASS is no evidence; a runner summary is', () => {
  assert.equal(classify(run('npm test | tail -2', ' ✓ adds\nPASS src/a.test.ts')).strength, 'none')
  assert.deepEqual(
    [classify(run('npm test | tail -2', ' Tests  4 passed (4)')).strength, classify(run('npm test | tail -2', ' Tests  4 passed (4)')).outcome],
    ['strong', 'pass'],
  )
})

test('a later step’s exit code does not overturn the runner’s passing summary', () => {
  const ev = classify(run('pnpm test && git commit -qm wip', 'Exit code 128\n      Tests  230 passed (230)\nfatal: not a git repository', { isError: true }))
  assert.deepEqual([ev.strength, ev.outcome], ['strong', 'pass'])
})

test('a recognized runner summary makes any command a test run', () => {
  assert.equal(classify(run('pnpm verify', '      Tests  422 passed (422)')).strength, 'strong')
  assert.equal(classify(run('timeout 120 pnpm exec vitest run', '      Tests  3 passed (3)')).strength, 'strong')
  // Reading an old log is no new run.
  assert.equal(classify(run('cat test-output.log', '      Tests  3 passed (3)')).strength, 'none')
})

for (const text of ['Exit code 124\nCommand timed out after 2m 0s', 'Exit code 130\nInterrupted by user']) {
  test(`a run that did not finish is no evidence: ${text.split('\n')[1]}`, () => {
    assert.equal(classify(run('npm test', text, { isError: true })).strength, 'none')
  })
}

for (const command of ['pnpm -r test', 'npm --prefix web test', 'npm -w pkg test', 'make -j8 test', 'pnpm --filter api test']) {
  test(`a runner with workspace flags is recognised: ${command}`, () => {
    assert.equal(classify(run(command, 'ok')).strength, 'strong')
  })
}

for (const command of ['ls -la', 'git status', 'npm install', 'npm test --listTests', 'npm test || true', 'pytest --collect-only', 'cargo test --no-run', 'npm --version']) {
  test(`not a check: ${command}`, () => {
    assert.equal(classify(run(command, 'whatever')).strength, 'none')
  })
}

test('in a chain the strongest segment decides', () => {
  const ev = classify(run('npm run build && npm test', 'Tests: 3 passed'))
  assert.equal(ev.strength, 'strong')
  assert.equal(ev.command, 'npm test')
})

test('a leading cd, env assignment and npx are ignored', () => {
  assert.equal(classify(run('cd web && CI=1 npx vitest run', '✓ 3 passed')).strength, 'strong')
  assert.equal(classify(run('cmd /c npm.cmd test', 'Tests: 2 passed')).strength, 'strong')
})

test('quoted separators do not split the command', () => {
  assert.equal(classify(run('git commit -m "a && npm test"')).strength, 'none')
})

test('Pester output is always parsed', () => {
  const ev = classify(run('Invoke-Pester -Path tests', 'Tests Passed: 3, Failed: 1', { tool: 'PowerShell' }))
  assert.equal(ev.strength, 'strong')
  assert.equal(ev.outcome, 'fail')
  const ok = classify(run('Invoke-Pester -Path tests', 'Tests Passed: 4, Failed: 0, Skipped: 0', { tool: 'PowerShell' }))
  assert.equal(ok.outcome, 'pass')
})

test('dotnet test failure is found through ANSI colors', () => {
  const ev = classify(run('dotnet test', '\u001b[31mFailed!\u001b[0m - Failed: 2, Passed: 10', { tool: 'PowerShell' }))
  assert.equal(ev.outcome, 'fail')
})

test('cargo and go failures are found', () => {
  assert.equal(classify(run('cargo test', 'test result: FAILED. 3 passed; 1 failed')).outcome, 'fail')
  assert.equal(classify(run('go test ./...', '--- FAIL: TestParse (0.00s)\nFAIL\tex/parse\t0.01s')).outcome, 'fail')
  assert.equal(classify(run('go test ./...', 'ok  \tex/parse\t0.01s')).outcome, 'pass')
})

test('a localhost health check is medium, a public URL is not', () => {
  assert.equal(classify(run('curl -s http://localhost:3000/health', 'ok')).strength, 'medium')
  assert.equal(classify(run('curl https://example.com', '<html>')).strength, 'none')
})

test('a backgrounded run is pending', () => {
  assert.equal(classify(run('npm test', '', { backgrounded: true })).outcome, 'pending')
})

test('a long command is cut to 40 characters in the summary', () => {
  const ev = classify(run('npm run test:integration:very-long-suite-name-here', '5 passed'))
  // 40 characters in all, the ellipsis included.
  assert.equal(ev.summary, 'npm run test:integration:very-long-suit… passed (5)')
})

test('5 MB of output is classified from its tail in under 50 ms', () => {
  const big = 'x'.repeat(5 * 1024 * 1024) + '\n' + 'y'.repeat(500) + '\nTests: 1 failed, 9 passed\n' + 'z'.repeat(300)
  const started = performance.now()
  const ev = classify(run('npm test', big))
  const took = performance.now() - started
  assert.equal(ev.outcome, 'fail')
  assert.ok(took < 50, `took ${took.toFixed(1)} ms`)
})

test('a zero failure count is not a failure: "passed 268 failed 0"', () => {
  const ev = classify(run('cargo test | awk "{print}"', 'rust passed 268 failed 0\nℹ pass 44\nℹ fail 0'))
  assert.equal(ev.outcome, 'pass')
})

test('counts stay within one line', () => {
  assert.equal(classify(run('bun test', ' 12 pass\n 0 fail\n 30 expect() calls')).outcome, 'pass')
})

for (const command of [
  '.\\venv\\Scripts\\python.exe -m pytest -q',
  'venv/Scripts/python -m pytest -q',
  'node node_modules/vitest/vitest.mjs run',
  '~/.cargo/bin/cargo test',
  '(cd web && $V/pytest -q)',
]) {
  test(`a runner called by path is recognised: ${command}`, () => {
    assert.equal(classify(run(command, '3 passed')).strength, 'strong')
  })
}

test('a PowerShell cmdlet pipe keeps the exit code; a Bash pipe hides it', () => {
  const ps = classify(run('pnpm build | Select-Object -Last 1', '[build] Complete!', { tool: 'PowerShell' }))
  assert.deepEqual([ps.strength, ps.outcome], ['medium', 'pass'])
  assert.equal(classify(run('pnpm build | tail -1', '[build] Complete!')).strength, 'none')
})

test('a later native PowerShell statement hides the exit code', () => {
  assert.equal(classify(run('pnpm build; git status', 'nothing to commit', { tool: 'PowerShell' })).strength, 'none')
})

test('an echoed exit status is read: echo exit=$?', () => {
  assert.equal(classify(run('npm test > log 2>&1; echo exit=$?', 'exit=0')).outcome, 'pass')
  assert.equal(classify(run('npm test > log 2>&1; echo exit=$?', 'exit=1')).outcome, 'fail')
})

test('a shell error before the runner ran is no evidence', () => {
  const text = 'Exit code 1\nException: \r\nLine |\r\n  14 |  throw "missing"'
  assert.equal(classify(run('throw "missing"; pytest -q', text, { tool: 'PowerShell', isError: true })).strength, 'none')
})

test('red-green in one command: a later run of the same runner with other arguments decides', () => {
  const text = '      Tests  1 failed | 4 passed (5)\nok\n      Tests  98 passed (98)'
  const ev = classify(run('npx vitest run test/config.test.ts | grep Tests; sed -i s/a/b/ src/a.ts; npx vitest run | grep Tests', text))
  assert.deepEqual([ev.strength, ev.outcome], ['strong', 'pass'])
})

test('ruff check --select ALL explores; it is no check', () => {
  assert.equal(classify(run('ruff check --select ALL bot.py', 'Exit code 1\nFound 40 errors.', { isError: true })).strength, 'none')
  assert.equal(classify(run('ruff check .', 'All checks passed!')).strength, 'medium')
})

// Lead's rule: formatting checks neither back nor contradict a claim.
for (const command of [
  'ruff format --check .',
  'npx prettier --check src',
  'pnpm exec prettier --list-different .',
  'black --check .',
  'cargo fmt --check',
  'gofmt -l .',
  'dotnet format --verify-no-changes',
]) {
  test(`a formatting check is no check: ${command}`, () => {
    assert.equal(classify(run(command, 'Exit code 1\n1 file would be reformatted', { isError: true })).strength, 'none')
    assert.equal(classify(run(command, '')).strength, 'none')
  })
}

test('the bot.py chain: the type check and the lint passed; format and --select ALL prove nothing', () => {
  const command =
    '& "$v\\Scripts\\basedpyright.exe" bot.py; & "$v\\Scripts\\ruff.exe" check bot.py; ' +
    '& "$v\\Scripts\\ruff.exe" format --check bot.py; & "$v\\Scripts\\ruff.exe" check --select ALL bot.py 2>$null | Select-Object -Last 12'
  const text = 'Exit code 1\n0 errors, 0 warnings, 0 notes\nAll checks passed!\n1 file would be reformatted\nbot.py:93:5: T201 `print` found\nFound 10 errors.'
  const ev = classify(run(command, text, { tool: 'PowerShell', isError: true }))
  assert.deepEqual([ev.strength, ev.outcome], ['medium', 'pass'])
  assert.equal(ev.command, '"$v\\Scripts\\ruff.exe" check bot.py')
})

test('masked, a lint step with no all-clear line of its own is no evidence', () => {
  const ev = classify(run('mypy .; git status', 'Found 2 errors in 1 file\nnothing to commit'))
  assert.equal(ev.strength, 'none')
})

test('a failing run of part of the suite is marked subset', () => {
  assert.equal(classify(run('cargo test -p terminal x', 'Exit code 101\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 114 filtered out', { isError: true })).subset, true)
  assert.equal(classify(run('pytest -k parser', 'Exit code 1\n1 failed, 3 deselected in 0.1s', { isError: true })).subset, true)
  assert.equal(classify(run('npx vitest run -t "parses dates"', 'Exit code 1\n      Tests  1 failed (1)', { isError: true })).subset, true)
  assert.equal(classify(run('npm test', 'Exit code 1\n      Tests  1 failed | 41 passed (42)', { isError: true })).subset, undefined)
})
