# Changes

*See what Claude changed, turn by turn. Keep it or send it back.*

A Claude Code mod with one pane, **Changes**. It shows what Claude changed in each turn of the session, including through subagents and shell commands, with a diff per file and **Keep** / **Revert** per file. This page is the reference. For the suite, see the [Notary README](../../README.md).

```
/plugin install changes --marketplace candygoogy/notary
```

Needs Claude Code 2.1.287 or later; on an older version, Changes shows one notice and stays off. Git is optional. Inside a git repository, Changes also finds files that shell commands changed.

## The Changes pane

`/changes` opens or closes the pane. In the fullscreen layout it docks beside the transcript; otherwise it opens inline.

- **Timeline**, newest turn first. Each row is a turn: its number, its prompt and how many files it changed. Selecting a turn expands its steps:
  - the tool calls that changed files;
  - the subagents it started, with their own calls;
  - *changed during this turn (shell or you)* for changes no tool call explains.
  
  Select a step to see only its files, or *all steps* for the whole turn.
- **Diffs**, one per file, with the lines added and removed, and **Keep** and **Revert** buttons. Notes appear where they apply:
  - *line endings only*;
  - *binary file*;
  - *too large to show*;
  - *edited by two agents at once*;
  - *changed outside Claude between edits; reverting this turn also undoes that*.

Edits made between turns are yours. They aren't listed, and the pane doesn't undo them.

After a turn that changed code, a line above the prompt says `Turn #12 changed 3 files  [Open] [Dismiss]`. **Open** shows only while the pane is shut. The line goes away at your next prompt, or right away with **Dismiss**, and comes back after the next turn that changes code. Turns that only touched docs, notes, logs, lockfiles or build folders don't show it. Those changes are still listed in the pane.

## Keep and Revert

**Keep** marks a file's change as reviewed and folds it away. **Undo keep** brings it back. Nothing on disk changes.

**Revert** puts the file back the way it was before that turn. It takes two presses:

1. The first press checks the file as it is now and writes nothing.
2. If the revert can go ahead, the button becomes **Confirm revert (#12)** for 5 seconds. It names every turn the revert covers. Press it to revert. A confirmation pressed too late does nothing and says so.

Changes only writes when the file on disk is exactly what Claude left. After writing, it reads the file back to make sure. When it can't be sure, it refuses and says why:

| You see | What it means | What you can do |
|---|---|---|
| *was also changed by #14. Revert those turns together, or none.* | A later (or, through a subagent, earlier) turn changed the same file. | **Revert with #14** reverts both turns' changes to the file. |
| *was changed outside Claude between #12 and #14* | Something else changed the file between Claude's edits, maybe you. | **Revert anyway** also undoes that change. |
| *Can't confirm nothing else changed it between #12 and #14* | The file was committed in between, so its versions can't be compared. | **Revert anyway**. |
| *The history … was trimmed* | The session is long, and older edits to the file are no longer kept. | **Revert anyway** also undoes what's no longer listed. |
| *changed since Claude's last edit, so it was left alone* | The file on disk isn't what Claude left. | Nothing to override: look at the file and decide yourself. |
| *is too large to restore* / *There is no saved copy* | No snapshot from before that turn (over 4 MiB, or unreadable). | Restore it with git or by hand. |

After a revert, Claude gets a short hidden note, for example *"The user reverted src/a.ts to its state before turn #12 using the Changes pane. Re-read the file before editing it."* Without it, Claude's next edit to that file would fail on text that's no longer there. The `tellClaude` setting turns the note off.

A revert is recorded too, as a row in the timeline. A later revert of the same file builds on it, so the history stays honest.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `enabled` | on | Turn Changes on or off. |
| `band` | on | The line above the prompt after a turn that changed code. |
| `autoOpen` | off | Open the pane by itself, once, when the first turn with code changes ends: only in the fullscreen layout, where it docks beside the transcript, and on a terminal at least 144 columns wide. |
| `tellClaude` | on | The hidden note to Claude after a revert. |
| `trackShell` | on | In a git repository, find the files Bash and PowerShell commands changed. |

Change them in the `/config` menu.

## How it works

- **Claude's own edits** (`Edit`, `Write`, `NotebookEdit`, in the main conversation or any subagent): Changes reads the file right before and right after each one, and saves a copy.
- **Subagents** belong to the turn that started them, even when they keep working after that turn ends.
- **Shell commands** (inside a git repository only): Changes compares `git status`, and the files it lists, before and after each command.
- **Copies** of files are stored once per content, under `~/.claude/plugin-data/notary-changes/<session>/`. They're deleted when the session ends. Folders left behind by a crash are swept after 7 days.

## How it differs from `/diff`

Claude Code's built-in `/diff` shows the working tree's git diff. Changes is per turn and can undo:

- It has **Revert**, with the checks above.
- It shows the contents of **new files**, not just their names.
- It sees **subagent edits**, and attributes them to the turn that started the subagent.
- Outside git, it still tracks Claude's own edits. Only shell tracking needs git.

## Limits

- **One conversation at a time.** `/clear` and `/resume` start the Changes history fresh; your files are untouched. So does a new session or `claude --resume`. Turns from before can't be reverted from the pane.
- **Per file, not per change.** Revert puts the whole file back to before the turn. You can't keep one hunk and revert another.
- **Shell changes only in git.** Outside a git repository, and in gitignored files, changes made by shell commands aren't seen.
  - A rename shows as a delete plus a new file.
  - A large file (over 1 MB) rewritten with the same size and timestamp can be missed.
  - Tracking a command never adds more than about 2 seconds to it. A command that changes more than 200 files, a checkout, reset, pull or commit, or a repository with more than 200 uncommitted files is shown as *not tracked*, with the reason, instead of being slowed down.
  - If git is too slow to answer in time, shell tracking turns off for the rest of the session, and the pane says so.
- **Reverts are yours, not Claude's.** A revert from the pane happens outside Claude's tool calls, so other mods that watch Claude's edits (Receipts, for one) don't count it as an edit. Claude is told about it with a hidden note.
- **Your edits during a turn.** If you edit a file in your editor while Claude is working, the change can appear as *changed during this turn (shell or you)*.
- **No merging.** If a file changed after Claude's edit, Revert refuses rather than guess.
- **Large files.** Files over 4 MiB can only be reverted if they were clean in git before the turn.
- **Folders.** Reverting a new file deletes the file, not the folders Claude created for it.
- **Long sessions.** The timeline keeps the last 200 turns and 5,000 edits. Older turns can't be reverted.
- **Big diffs.** A diff shows 400 lines, then **Show all**. A file whose diff is over 1 MB isn't drawn. Up to 12 files are drawn at once; select a step to narrow the list.
- **Desktop app.** The first click on an unfocused pane may only focus it. Selecting a turn or a step works on that first click, but **Keep**, **Revert** and **Confirm** always need a real click, so a stray focus never changes a file.

## Privacy

Changes runs entirely on your machine. It makes no network requests, collects no telemetry, and makes no model calls. Its saved copies of your files stay in your `~/.claude` folder and are deleted at the end of the session.
