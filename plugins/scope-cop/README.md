# Scope Cop

*Claude stays inside the scope you set, and asks before leaving it. Edits outside it are flagged, or blocked if you want.*

A Claude Code mod. This page is the reference. For the suite, see the [Notary README](../../README.md).

```
/plugin install scope-cop --marketplace candygoogy/notary
```

Needs Claude Code 2.1.287 or later. On an older version, Scope Cop shows one notice and stays off.

It is a guardrail, not a security boundary. Mods aren't sandboxed, and a shell command can write anywhere.

## Set a scope

```
/scope src/auth/** tests/auth/**
```

Every prompt you send after it tells Claude the scope (*"for this task the user limited edits to src/auth/\*\*, tests/auth/\*\*. Ask before editing other files."*), so it survives a compacted conversation. It holds until `/scope off`, `/clear` or the end of the session.

| Command | What it does |
|---|---|
| `/scope <pattern>...` | Sets the scope. |
| `/scope add <pattern>...` | Widens it. |
| `/scope remove <pattern>...` | Drops patterns. Removing the last one clears the scope. |
| `/scope off` | Clears it. |
| `/scope mode A`, `B` or `C` | Sets the mode (below). |
| `/scope` | Opens the **Scope** pane. |

**Patterns** are gitignore-style and start at the repository root (or the session's folder outside git):

- `*` and `?` match inside one folder, `**` across folders: `src/*.ts`, `**/*.test.ts`.
- A folder name covers everything under it: `src/auth` is the same as `src/auth/**`.
- `!pattern` excludes: `src/** !src/generated/**`. The last pattern that matches a file decides.
- On Windows, case doesn't matter and `\` works as well as `/`.
- Absolute paths and `..` are refused: a scope is always inside the project. Wrap a pattern with spaces in quotes.

**Always allowed**, whatever the scope: Claude's own files (`~/.claude`: memory, plans, todos), temp folders outside the project, scratch folders anywhere (`scratch`, `.scratch`, `*-scratch`, `tmp`, `.tmp`, `tmp-*`, `.tmp-*`, and `*.tmp.*` files), screenshot, agent and cache folders anywhere (`shots`, `.shots`, `screenshots`, `.agent`, `.cache`; secret-looking files in them like `.env*`, `*.pem`, `*.key` and `credentials*` are still flagged), and lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum` and the like).

**A scope includes its own tests.** With `src/auth/**`, `test/auth/login.test.ts`, `tests/auth/x.ts` and `src/auth/__tests__/x.ts` count as inside it. Other tests (`test/db/...`, `e2e/checkout.spec.ts`) don't: add them when a task needs them.

## Modes

| Mode | `Edit`, `Write`, `NotebookEdit` outside the scope | A shell command that wrote outside the scope |
|---|---|---|
| **A**: flag | Runs. Shown on the band and in the pane. | Shown on the band and in the pane. |
| **B**: flag and tell Claude (default) | Runs. Claude is told on the edit's own result, once per file per turn. | Claude is told with your next prompt. |
| **C**: block | Refused before it runs. Claude reads why and that it should ask you. | Claude is told with your next prompt. A command whose write target is a literal absolute path outside the scope is refused before it runs. |

What Claude is told states facts and names the mod: *"Scope Cop (a mod the user installed): src/db/pool.ts is outside the scope the user set for this task (src/auth/\*\*). The edit went through. If it was not needed for the task, say so in your answer."* In testing, Claude read an instruction-like note in a tool result as untrusted and ignored it, while it acknowledged this wording.

Scope Cop only tightens. It never turns a refusal from your settings, another hook or the permission mode into an allow, and if Scope Cop itself fails, the edit goes ahead as if it weren't installed.

**How mode C refuses.** Scope Cop sees each tool call before it runs. In mode C it refuses an `Edit`, `Write` or `NotebookEdit` whose file is outside the scope, and a `Bash` or `PowerShell` command whose literal absolute write target is: the call doesn't run, and Claude reads why. Scope Cop never approves a call and doesn't answer Claude Code's permission check, so your permission rules and prompts work as they do without it.

Subagents are covered: their edits go through the same checks.

**Approved edits.** When Claude stops at the scope's edge and names the file it would need (*"this also needs `src/api/auth.ts`, which is outside your scope"*) and you go on, an edit to that path in your next turn is approved: in modes A and B it's listed in the pane as *approved*, stays off the band and isn't told to Claude (mode C still blocks it; use **Allow file**). Only paths named with their folder count, and only for the turn your reply starts; a turn that starts without a prompt from you doesn't use them up.

## The band and the pane

While a scope is set, a line above the prompt shows it: `Scope: src/auth/** · nothing outside [Clear]`. After an edit outside it: `Scope: src/auth/** · 1 edit outside: src/db/pool.ts [Allow file] [Details] [Dismiss]`. **Allow file** adds that file to the scope. The list starts again at your next prompt.

The **Scope** pane (`/scope`, or **Details**) lists the patterns, each with **Remove**, the mode, and every edit outside the scope in this conversation, newest first.

## Shell commands

A mod sees a shell command's text before it runs, and nothing about what the process wrote. So:

- **With [Changes](../changes/README.md) installed, inside a git repository**, Scope Cop reads the files each shell command changed from Changes' record, at the end of the turn, and flags the ones outside the scope. Changes can revert them.
- **Before the run, in mode C only**, the literal write targets of commands it knows (`>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `touch`, `mkdir`; `Set-Content`, `Out-File`, `New-Item`, `Remove-Item`, `Copy-Item`, `Move-Item` and their aliases) are checked when they are absolute paths. A relative path isn't judged there, because the shell's folder can differ from the session's after an earlier `cd`.
- A change during the turn that no call explains (Changes' *changed during this turn (shell or you)*) is listed in the pane only. It may be your own edit, so it's never on the band or told to Claude.
- Anything it can't read for certain is never refused and never flagged: variables, globs, `$(...)`, scripts and interpreters (`python`, `node`, `npm run`), and relative paths after a `cd`.

## Settings

| Setting | Command | Default |
|---|---|---|
| Mode | `/scope mode A`, `B` or `C` for this conversation; `/config` to keep it | B |
| On or off | `/config` | on |

## Privacy

Scope Cop runs on your machine. It makes no network requests, collects no telemetry, and makes no model calls.

**What it reads.** The path each `Edit`, `Write` and `NotebookEdit` targets, the text of shell commands (to spot literal write targets), Claude's final answers (for the files it named before you said yes), and, with [Changes](../changes/README.md) installed, Changes' record of the files shell commands changed.

**What it keeps.** The scope, the mode and the list of edits outside the scope, in Claude Code's plugin state for the conversation. Nothing is written elsewhere.

**What reaches Claude.** The line with the scope that rides on each prompt, and in modes B and C the note about an edit outside the scope, are text Scope Cop adds to the conversation, so Claude reads them like the rest of it.

## Limits

- **It costs a round trip when the task needs a file outside the scope.** Claude stops at the edge and names the file; you say yes. In our eval (16 focused tasks, Sonnet), 9 of 32 scoped runs stopped this way; one yes was enough in all but one.
- **Not a security boundary.** Scripts, interpreters and network tools can write anywhere, and outside git (or without Changes) shell writes aren't seen at all.
- **Shell writes are seen after the fact.** Only literal absolute targets, in mode C, are stopped before they run.
- **One scope per conversation**, not per turn, and not kept across `/resume`.
- **File-writing MCP tools** aren't checked.
- **Claude Code's own deny rules** (`"deny": ["Edit(src/db/**)"]` in settings) block folders for good and stay in force with Scope Cop. They can't say "only this folder": `Edit(**)` with `Edit(!src/auth/**)` refuses every edit, `src/auth` included (checked on Claude Code 2.1.310).
