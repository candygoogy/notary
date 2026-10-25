# Contributing to Notary

Thanks for helping. The most useful contributions are exact bug reports: for Changes, **a revert that wrote the wrong bytes**; for Receipts, **a wrong verdict with the text that caused it**. Code changes are welcome too.

## Reporting a bad revert (Changes)

Open an issue with:

- the pane's note or refusal, word for word;
- the file's bytes before the turn and after the revert, if you have them (`Format-Hex` on Windows, `xxd` elsewhere): line endings and BOMs matter;
- whether the file was changed by Claude, a subagent or a shell command, whether you're in a git repository, your OS, and `claude --version`.

## Reporting a wrong verdict (Receipts)

Open an issue with:

- the band or stamp text Receipts showed;
- the sentence from Claude's answer that was judged (or that should have been);
- the command Claude ran and its output (the last 30 lines are usually enough);
- whether Claude used the Bash or PowerShell tool, your OS, and `claude --version`.

Remove anything private first. Each report becomes a sample in `fixtures/`, so the fix stays fixed.

## Setup

You need Node 24 or later and Claude Code 2.1.287 or later. There are no npm dependencies to install.

```
git clone https://github.com/candygoogy/notary
cd notary
npm run check
```

To try a mod in a session from your checkout:

```
claude --plugin-dir plugins/changes
claude --plugin-dir plugins/receipts
claude --plugin-dir plugins/scope-cop
```

Saving a file under the plugin folder reloads it in that session.

## Tests

| Command | What it runs |
|---|---|
| `npm run test:unit` | `node --test` over `test/`: the pure core of each mod and the fixture corpus |
| `npm run test:mods` | Each mod's `plugins/<mod>/test/` files against the engine's test kit (`claude plugin test`) |
| `npm run validate` | The marketplace, and each mod's manifest and hooks module, as the engine reads them |
| `npm run check` | Shared-copy check, unit tests and validate, as CI runs them |

CI runs all of them on Windows, macOS and Linux.

Two places for tests, because the two runners can't share a file:

- `test/` holds Node tests. They can read files, so the core is tested against the JSON corpus in `fixtures/`.
- `plugins/<mod>/test/` holds `claude plugin test` files. They import only `claude-code/testing` and run without file access, so they embed what they need. A file there that imports `node:test` breaks the mod's test run.

### Adding a corpus sample

`fixtures/claims.json` holds answer text and the claims expected in it. `fixtures/runs.json` holds commands, their output, and the expected strength and outcome. Add the sample with a short `note`, and set `source` to `real` (from a real session, redacted) or `constructed`. If the right behavior isn't implemented yet, add a `todo` field saying why. The sample then runs and reports, but doesn't fail the suite.

## Code rules

These come from how the Mods engine loads a plugin:

- A mod's code can only import files inside its own plugin folder. Shared helpers live in `/shared` and are copied into each plugin's `hooks/shared/` by `npm run sync`. Never edit the copies; CI fails if they drift.
- Import plugin files with an explicit `.ts` or `.tsx` extension. That works for both the engine and Node.
- A helper that receives `$` must be a top-level `function` declaration.
- Every `$.state` key a mod uses is declared in its `types/index.d.ts`.
- Logic that can be pure goes in `hooks/core/`, without `$`, and is tested from `test/` with Node. Only the wiring and the UI touch `$`.
- A mod must never break a session. Observer hooks return what `next` resolved to. A failure inside a mod means "not judged", never a blocked tool or a stuck turn.
- No network, no telemetry, and no model calls unless the user turns on a setting that says so.
- Files use LF line endings (`.gitattributes` enforces it).

On Windows, run the manual checks in [docs/windows-checklist.md](docs/windows-checklist.md) for changes that touch paths, shells or output parsing.

## Pull requests

Keep them small and focused, with a test that fails before the change. Describe what you ran: the commands and their results. For a wrong verdict, the fixture sample is the test.

## Releasing

Claude Code tells installed copies apart by the `version` in each mod's `plugin.json`. A change that users should get needs a version bump in that mod's manifest, or `Update marketplace` leaves them on the old copy. Bump only the mod that changed, tag the release `<mod>-v<version>` (for example `changes-v0.1.1`), and say in the release notes what changed for users.
