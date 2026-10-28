# Receipts

*Claude says the tests pass. Receipts checks.*

A Claude Code mod that flags turns where Claude claims success without a check to back it up. This page is the reference. For the overview, install and demo, see the [Notary README](../../README.md).

```
/plugin install receipts --marketplace candygoogy/notary
```

Needs Claude Code 2.1.287 or later. On an older version, Receipts shows one notice and stays off.

## When a turn is judged

At the end of each turn, Receipts judges the final answer only if both of these hold:

1. The answer contains at least one success claim.
2. Something needs checking: code was edited during this turn, or a code edit from an earlier turn had no passing check after it when this turn began.

So "Done." after answering a question gets no verdict. Neither does "Committed." right after a turn whose tests passed.

### Which edits count

An `Edit`, `Write` or `NotebookEdit` that landed counts when it changes code in the project. With the Changes mod installed, a file a shell command changed (`sed -i`, a codegen script, `git checkout`) counts too, inside a git repository only; a test run in that same command (`sed -i … && npm test`) still checks it. These don't count, because they can't break a test:
- prose and notes: `.md` files, `CLAUDE.md`, memory files, `.claude/` and `.agent/`;
- scratch and temp folders;
- build output such as `target/`, `dist/` and `node_modules/`;
- anything outside the session's working folder.

So "tests passed, then Claude updated `STATUS.md` and said *All tests pass*" stays ✅.

Turns that end by interruption, refusal or an API error are never judged. Neither is a subagent's own final report, but subagents' edits and test runs count toward the main conversation's claims.

## Verdicts

| Verdict | Rule |
|---|---|
| ✅ Verified | The latest qualifying check after the last edit passed. |
| ⚠️ Unverified | No qualifying check after the last edit. Checks still running in the background, and runs that found no tests, don't qualify. |
| ❌ Contradicted | The latest qualifying check after the last edit failed. |

When an answer has several claims, the worst verdict wins.

## What you see: verbosity

Every verdict goes into the `/receipts` pane. What reaches you unasked depends on the `verbosity` setting.

**`quiet`** (the default):

| Verdict | Band above the prompt | Stamp under the answer | Mode B | Mode C |
|---|---|---|---|---|
| ❌ any claim | until the next verdict | yes | sent back once | sent back once |
| ⚠️ tests or build claim, code edited this turn | until the next verdict; in mode B, until Claude has answered the reminder | yes | reminder with your next prompt | sent back once |
| ⚠️ general claim, or the edit was in an earlier turn | pane only | pane only | nothing | nothing |
| ✅ tests or build claim | until your next prompt | yes | nothing | nothing |
| ✅ general claim | pane only | pane only | nothing | nothing |

**Details** on the band opens the `/receipts` pane, and shows only while the pane is shut. **Dismiss** takes the band down at any time; the pane keeps the verdict.

**`all`**: every verdict shows on the band and gets a stamp, and every ⚠️ sends a reminder (mode B) or sends Claude back (mode C). This is how v0.1 behaved before the replay of real sessions showed it was too noisy.

Mode A never sends a reminder or sends Claude back.

## Claims

Receipts splits the answer into sentences and looks for phrases like these:

- "I've fixed / implemented / resolved / completed / added / updated …"
- "It's done / fixed / working", "Everything works", "The build succeeds"
- "All tests pass", "Tests are passing", "Tests: 673 pass"
- "No (type / lint / build) errors", "Verified that it works", "Ready to merge"
- a closing line on its own: "Done.", "Fixed.", "All set.", "✅"

Each claim has a kind, which decides what can back it:
- **tests**: mentions tests, specs or a suite. It needs a test run.
- **build**: mentions the build, compiling, types, `tsc`, lint or a linter. It's judged by build, type check and lint runs. A passing test run also backs it, since the code compiled. A failing test run says nothing about the build.
- **general**: anything else ("Fixed.", "It works"). Accepts a test run or a build, type check, lint or localhost check.

A claim that names an area, like "the website tests pass" or "parser tests", ignores failures from commands that don't mention that area. A Rust failure then doesn't contradict a claim about the website's tests.

A sentence is **not** a claim when it:

- hedges: should, probably, likely, might, I think, hopefully;
- disclaims: "I haven't run", "untested", "you'll need to run";
- negates: "not fixed yet", "still fails", "no longer passes";
- asks a question, or puts a condition before the claim ("If the tests pass, …", "Tell me when it's done");
- talks about the future: "will pass", "going to";
- tells someone what to do: "Confirm the tests pass, then …";
- explains or introduces rather than reports: "Why it works:", "Here is what changed:", "I'll …", "Next, …";
- sits in an answer that reports a current failure honestly: "The build succeeds, 3 tests are still failing."

Code blocks, inline code, `>` quotes, double-quoted text and unchecked `- [ ]` items are ignored. A checked `- [x] tests pass` is a claim.

A sentence over 25 words that also contains "but", "although" or "except" is uncertain. It is skipped, unless smart check is on.

## Checks

Every Bash and PowerShell command Claude runs is classified by what it can prove.

**Test runs** back any claim:
- npm, pnpm, yarn or bun `test`
- vitest, jest, mocha, `playwright test`
- `node --test`, `bun test`, `deno test`
- pytest, `python -m pytest` or `unittest`, tox, nox
- `cargo test` and `cargo nextest`, `go test`, `dotnet test`
- `gradle test` or `check`, `mvn test` or `verify`
- Invoke-Pester, rspec, phpunit, ctest, `make test` or `make check`

**Builds and checks** back general claims:
- tsc and vue-tsc
- `npm run build`, `typecheck` or `lint`
- `cargo build`, `check` or `clippy`
- `go build`, `go vet`, `dotnet build`
- mypy, pyright, ruff, eslint, biome
- curl, wget, iwr or Invoke-RestMethod against localhost

**Not evidence:**
- reading, listing and git commands
- installs
- formatting checks: `prettier --check`, `ruff format --check`, `black --check`, `cargo fmt --check`, `gofmt -l`, `dotnet format --verify-no-changes`. An unformatted file is not a broken fix.
- `ruff check --select ALL`: it turns on every rule, so it's exploratory, not a project check
- `--version`, `--help`, `--collect-only`, `--no-run`, `--listTests`, `--dry-run`
- anything ending in `|| true`, `|| exit 0` or `|| :`
- runs that timed out, were interrupted, or that you rejected

Runners are recognized however they're called: `npx vitest`, `node node_modules/vitest/vitest.mjs`, `.\venv\Scripts\python.exe -m pytest`, `~/.cargo/bin/cargo test`, `timeout 120 pnpm exec vitest`, `timeout -k 10 300 npm test`, `gtimeout 120 cargo test`.

### Your own checks

If your project runs its tests or build through its own command (`pnpm verify`, `make ci`, `./check.sh`), tell Receipts with the `checks` setting. Each entry is `tests: <command>` or `build: <command>`:

```
/receipts check add "pnpm verify" tests
/receipts check add "make ci" build
/receipts checks
/receipts check remove "make ci"
```

You can also edit the list in `/config`. A declared check follows the same rules as the runners above: it matches its command with any arguments after it, through the same wrappers, and in chains and pipes. Its exit code or summary decides pass or fail. A failing `tests:` check counts like a failing test run, so it can contradict a claim and send Claude back. A declared check never weakens a runner Receipts already knows.

When a claim names the command itself ("`pnpm verify` passes"), it is judged as a tests or build claim by the same list.

In a chain like `npm run build && npm test`, the strongest check that actually ran decides, and of several, the last. If an early step fails, the steps after it never ran. When one command runs the same test runner twice, its last summary decides. That covers the common "run one test, fix, run the suite" pattern.

### Pass or fail

- The runner's exit code decides. A test *named* "fails without the fix" doesn't fail a passing run.
- When the exit code is hidden, the runner's own summary line decides ("Tests  1 failed | 41 passed", `test result: FAILED. 30 passed; 1 failed`, "Tests Passed: 3, Failed: 1"). Zero counts ("0 failed", "ℹ fail 0") are passes. Color codes are stripped, and only the last 64 KB is read.
- **Bash:** a pipe (`npm test | tail -5`) hides the exit code. `set -o pipefail` restores it.
- **PowerShell:** a pipe into a cmdlet (`npm test | Select-Object -Last 5`) does *not* hide the native command's exit code. A later statement that runs another program does.
- Output with no tests ("no tests ran", "No tests found") counts as no evidence. So does a command that never started ("command not found", "is not recognized as a name of a cmdlet").

Pester only sets an exit code with `-CI`, so its summary is always read.

## Settings

| Setting | Values | Default | Command |
|---|---|---|---|
| `mode` | A (warn), B (warn, nudge, send back on ❌), C (send back on ⚠️ or ❌) | B | `/receipts mode A\|B\|C` |
| `enabled` | on or off | on | `/receipts on`, `/receipts off` |
| `smartCheck` | on or off | off | `/receipts smart on\|off` |
| `verbosity` | quiet (flag ❌ and unchecked tests or build claims; the rest goes to the pane) or all | quiet | `/receipts verbosity quiet\|all` |
| `stamp` | on or off | on | `/config` |
| `checks` | your own check commands, each `tests: <command>` or `build: <command>` | none | `/receipts check add <command> tests\|build`, `/receipts check remove <command>`, `/receipts checks` |

A `/receipts` command changes a setting for the current conversation only. To keep a setting for every session, change it in `/config`.

`/receipts` with no arguments opens the pane. If the window is too narrow for it, the pane waits, and `/receipts` or the band's **Details** says so and why, once.

## Sending back and nudging

- **Send back** stops Claude from ending the turn and gives it the reason, for example: `Receipts: you claimed "All tests pass.", but npm test exited 1 (1 failed). Fix it and verify before claiming success.` It happens at most once per turn, and never while Claude is already continuing because of a stop hook. If another hook sends Claude back at the same moment, its reason is used and Receipts adds none.
- **Nudge** (mode B, ⚠️) attaches a short note to your next prompt that only Claude sees: `Receipts: your previous claim '…' was not verified by any check run after your last edit. Verify before claiming success.` It is attached only to prompts you type (terminal, Remote Control, or `claude -p`), never to prompts another plugin sends.

## Privacy

Receipts runs on your machine. It makes no network requests and collects no telemetry.

**What it reads.** The tool calls of the conversation and their output, and Claude's final answers, through Claude Code's hooks. With [Changes](../changes/README.md) installed, it also reads Changes' record of the files shell commands changed.

**What it keeps.** A short record of the conversation's edits and test runs, and the last verdicts, in Claude Code's plugin state. Nothing is written elsewhere.

**What reaches Claude.** A nudge or a send-back is text Receipts adds to the conversation, so Claude reads it like the rest of the conversation.

**Smart check** (off unless you turn it on): for a sentence the phrase rules can't settle, Receipts asks a small model (Haiku) whether it claims success. Only that sentence is sent, through your own Claude Code session, and it counts toward your usage. With smart check off, Receipts makes no model calls.

## Limits

- **English only.** Claims in other languages are not judged.
- **It checks that checks ran, not what they cover.** A passing suite that doesn't test your change still counts as ✅.
- **Shell edits count only with Changes, inside git.** Without the Changes mod, or outside a git repository, files changed by `sed -i`, `Set-Content` or a script don't reopen verification.
  - A deliberate "break it, run one test (by name, or with `N filtered out`), put it back" check after a full pass doesn't overturn that pass.
  - The flip side: a script that breaks the code and *doesn't* restore it leaves the earlier ✅ standing.
- **A revert from the Changes pane isn't an edit to Receipts.** It changes files outside Claude's tool calls, so a ✅ given before the revert still stands until Claude edits again.
- **Background runs** with no result yet are not evidence (⚠️ until they finish).
- **Long, mixed sentences** ("Fixed the parser, but the timezone case is left") are skipped unless smart check is on.
- **Subagents' own reports** aren't judged. Their edits and test runs count toward the main conversation's claims.
- **Desktop app.** The Code tab doesn't show the stamp line under the answer. The band, the pane and the reminder to Claude work there.

## Failure is quiet

Receipts never blocks a tool, and its own errors never stop Claude. If something inside Receipts fails, the turn just isn't judged, and the reason goes to the debug log (`claude --debug`). If Receipts ever keeps a turn from ending when it shouldn't, `/receipts off` turns it off at once.

## Windows

Receipts is tested on Windows with the PowerShell and Git Bash tools. The tests cover:
- CRLF output and CRLF answers
- drive letters and path case
- `npm.cmd`
- Pester without `-CI`
- localized `dotnet test` output
- runners missing from a short PATH (the desktop app)

The manual checklist is in [docs/windows-checklist.md](../../docs/windows-checklist.md).
