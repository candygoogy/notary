# Windows checklist: Receipts and Changes

Manual checks for Receipts on Windows, then for Changes ([below](#changes-checks)). The automated half is `plugins/receipts/test/windows.test.ts` (path spellings, PowerShell `npm.cmd test`, Pester without `-CI`, CRLF output). These checks need a real session, so run them before each release and record the result in the last column.

Each check uses a scratch project and a prompt that makes Claude do something predictable. The prompts tell Claude what to claim on purpose, so a check passes or fails on what Receipts does, not on what Claude decides.

## Setup

### Scratch project

Run in PowerShell 7. The folder name has a space on purpose.

```powershell
$dir = 'C:\Temp\receipts scratch'
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Location $dir
git init -q
'{ "name": "scratch", "private": true, "type": "module", "scripts": { "test": "node --test" } }' | Set-Content package.json
'export const add = (a, b) => a + b' | Set-Content add.js
@'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from './add.js'

test('adds', () => assert.equal(add(2, 2), 4))
'@ | Set-Content add.test.js
npm test
```

`npm test` should report `ℹ pass 1`. Reset the project between checks with `git checkout -- .` (commit once first).

### Load Receipts

From the scratch folder, with `<repo>` standing for your Notary checkout:

```powershell
claude --plugin-dir "<repo>\plugins\receipts"
```

Most checks start in mode A (warn only), so the verdict stays on screen: type `/receipts mode A` first. Set it back to `/receipts mode B` when you're done.

### Prompts

| Name | Prompt |
|---|---|
| **P-FAIL** | `In add.js make add return a - b. Run npm test. Then end your reply with exactly this sentence: All tests pass.` |
| **P-PASS** | `In add.js make add return a + b. Run npm test and tell me the result.` |
| **P-BG** | `In add.js make add return a + b. Run npm test with run_in_background, and without waiting for it, end your reply with exactly: All tests pass.` |

## Checks

| # | Check | Steps | Expected | Result |
|---|---|---|---|---|
| W1 | Terminal, PowerShell tool, a path with a space | Mode A. Send P-FAIL. | The band shows `❌ Contradicted: "All tests pass." · npm test exited 1 …`. A stamp line starting `🧾 ❌` appears under the answer. Claude's turn ends normally. | |
| W2 | Passing run | Reset. Mode A. Send P-PASS. | No ⚠️ or ❌. If Claude's answer claims success, the band and stamp show `✅ Verified · npm test passed …`. The ✅ band hides after your next prompt. | |
| W3 | Send-back (mode B) | Reset. `/receipts mode B`. Send P-FAIL. | Claude keeps working once, with the Receipts reason (`Receipts: you claimed "All tests pass.", but …`). It is sent back at most once, never in a loop. The final stamp matches Claude's final answer. | |
| W4 | Git Bash tool | Reset. Mode A. Send P-FAIL plus `Use the Bash tool, not PowerShell.` | Same as W1. | |
| W5 | Background run | Reset. Mode A. Send P-BG. | `⚠️ Unverified: no receipts · no check ran after the last edit`. A pending run is not evidence. In mode B the next prompt carries the nudge (no visible change, but Claude mentions verifying). In mode C Claude is sent back once. | |
| W6 | Desktop app (short PATH) | Add `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "<repo>\\plugins\\receipts" }` to `~/.claude/settings.json`. Open the scratch folder in the Desktop app's Code tab. Mode A. Send P-FAIL. | The band draws on the desktop surface with the same text as W1. If `npm` is not found because of the shorter PATH, Receipts still never breaks the session; record the verdict shown. The first click on an unfocused band button only focuses it (a known engine quirk); a second click works. Remove the setting afterwards. | |
| W7 | Long path (over 260 characters) | Copy the scratch project into a folder nested deep enough that `add.js` has a full path longer than 260 characters (for example, 12 nested folders named `a-rather-long-folder-name`). Start a session there. Mode A. Send P-FAIL. | Same as W1. If Claude's own Edit tool can't write the file, note it: that's an engine limit, not Receipts. | |
| W8 | Non-ASCII folder and file names | Copy the project to `C:\Temp\çalışma İşlem`, rename `add.js` to `toplamı.js`, and fix the import. Mode A. Send P-FAIL with the new file name. | Same as W1. Turkish characters in the pane and band show correctly, not as `?` or mojibake. | |
| W9 | Path spellings | Reset. Mode A. Send: `Edit C:/TEMP/RECEIPTS SCRATCH/add.js so add returns a + b, then run npm test from c:\temp\receipts scratch and end with: All tests pass.` | `✅ Verified`. One edit, closed by the passing run, whatever the drive-letter case, slash direction or name case. | |
| W10 | 8.3 short path | Get the short name with `cmd /c for %I in ("C:\Temp\receipts scratch") do @echo %~sI`. Start `claude` from that short path. Mode A. Send P-FAIL. | Same as W1. | |
| W11 | Pester without `-CI` | Needs Pester 5 (`Install-Module Pester -Scope CurrentUser`). Add `add.Tests.ps1` containing `Describe 'math' { It 'adds' { 2 + 2 \| Should -Be 5 } }`. Mode A. Send: `Run Invoke-Pester -Path . (without -CI), then end with: All tests pass.` | `❌ Contradicted`, even though Pester exits 0 without `-CI`. | |
| W12 | OEM code page and Turkish output | `chcp 857`, then start the session. Rename the test to `test('toplamı doğru', …)`. Mode A. Send P-FAIL. | Same verdict as W1. The band's summary is readable or at least not broken. Record what the test name looks like. | |
| W13 | CRLF files | `git config core.autocrlf true`, re-check out the files so they have CRLF, then repeat W1 and W2. | Same results as W1 and W2. | |
| W14 | Turkish answer (English-only v1) | Reset. Mode A. Send P-FAIL, but ask for the closing sentence `Düzelttim, testler geçiyor.` instead. | No verdict, no band, no stamp. v1 detects English claims only, and the README says so. | |
| W15 | Interrupted turn | Reset. Mode B. Send P-FAIL and press Esc while `npm test` runs. | No verdict, no stamp, no send-back. | |
| W16 | Tests run by a subagent | Reset. Mode A. Send: `Make add return a + b. Then use a subagent to run npm test. End with: All tests pass.` | `✅ Verified`: the subagent's passing run counts for the main claim. | |
| W17 | Another plugin hooks `turn.complete` | On a machine where another plugin hooks `turn.complete` (this one has `cc-plugin-agents-md`), run W1. | One stamp line, with no plugin-name prefix. The other plugin works as before. | |
| W18 | Commands | `/receipts` opens the pane. `/receipts mode C`, then `/receipts mode Z`. `/receipts off`, P-FAIL, `/receipts on`. | The pane lists judged turns, newest first. Mode C is confirmed; mode Z answers with the usage text. While off: no band, stamp or send-back. | |
| W19 | Hot reload keeps state | After W1, with the band showing, save any file under `plugins/receipts/hooks/` unchanged. | The module reloads. The band and pane still show the last verdict. | |
| W20 | Version guard | On Claude Code older than 2.1.287, if one is available, start a session with Receipts. | One toast saying Receipts needs a newer Claude Code. Nothing else happens. Skip if no old build is at hand. | |

## Changes checks

Changes keeps a copy of each file before Claude changes it, and Revert writes it back. On Windows, the risk is getting the bytes slightly wrong: line endings, a BOM, a binary file, a path. Every check below compares bytes with `Format-Hex`, not by eye.

### Setup

Use the scratch project from above, add four special files, and commit, so git tracks everything:

```powershell
Set-Location 'C:\Temp\receipts scratch'
[IO.File]::WriteAllText("$PWD\crlf.txt", "one`r`ntwo`r`n")
[IO.File]::WriteAllText("$PWD\bom.txt", "uno`r`ndue`r`n", [Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllBytes("$PWD\bin.dat", [byte[]](0, 255, 13, 10, 137))
[IO.File]::WriteAllText("$PWD\utf16.txt", "ciao`r`n", [Text.Encoding]::Unicode)
git add -A; git commit -qm "changes baseline"
```

Load Changes from the scratch folder with `claude --plugin-dir "<repo>\plugins\changes"`. Reset between checks with `git checkout -- .; git clean -fd`, in the scratch folder only.

Every revert is: `/changes`, select the turn, **Revert** on the file, then **Confirm revert (#N)**. "Exact" means `Format-Hex <file>` shows the same bytes as before the turn, and `git status --short` shows the file clean.

| # | Check | Steps | Expected | Result |
|---|---|---|---|---|
| RW1 | CRLF text | Ask: `In crlf.txt replace two with three.` Revert. | Exact: `6F 6E 65 0D 0A 74 77 6F 0D 0A`. No line shown as changed except `two`. | |
| RW2 | BOM | Ask: `In bom.txt replace due with tre.` Revert. | Exact: starts `EF BB BF`, keeps `0D 0A`. | |
| RW3 | Binary file changed by the shell | Ask: `Using PowerShell, overwrite bin.dat with the bytes 1, 2, 3.` Revert. | The pane lists `bin.dat` under the PowerShell step, marked *binary file*. Exact: `00 FF 0D 0A 89`. | |
| RW4 | UTF-16 file | Ask: `In utf16.txt replace ciao with salve.` (If Edit can't, let Claude use PowerShell.) Revert. | Shown as *binary file*. Exact: starts `FF FE`. | |
| RW5 | A new file | Ask: `Create src\notes.js exporting const notes = [].` Revert. | `notes.js` is deleted. The `src` folder Claude created stays, as documented. | |
| RW6 | A locked file | Ask Claude to edit `crlf.txt`. Then, in another PowerShell window: `$h = [IO.File]::Open('C:\Temp\receipts scratch\crlf.txt', 'Open', 'ReadWrite', 'None')`. Revert. Then `$h.Close()` and revert again. | While locked, the revert fails with a message, the file is unchanged, and the session carries on. After `Close()`, the revert works and is exact. | |
| RW7 | `git checkout` while Claude works | Ask: `Add a comment line to add.js, then run Start-Sleep 20, then add a second comment line to add.js.` During the sleep, in another window: `git checkout -- add.js`. Revert the turn. | The turn's `add.js` carries the note *changed outside Claude between edits; reverting this turn also undoes that*. Revert offers **Revert anyway**. After confirming, `add.js` is exactly as committed. | |
| RW8 | `git checkout` after Claude's edit | Ask Claude to edit `add.js`. After the turn, run `git checkout -- add.js` yourself. Revert. | Refused: *changed since Claude's last edit, so it was left alone*. Nothing is written. | |
| RW9 | Long path | In a folder whose files have paths over 260 characters (see W7), ask Claude to edit a file there. Revert. | Exact. If Claude's own Edit fails, note it: that's an engine limit, not Changes. | |
| RW10 | Spaces and non-ASCII | In `C:\Temp\çalışma İşlem` (see W8), ask Claude to edit `toplamı.js`. Revert. | Exact. The pane shows the name correctly. | |
| RW11 | autocrlf and a clean file | `git config core.autocrlf true`, commit a file with LF endings, check it out again (it becomes CRLF). Ask Claude, through PowerShell, to append a line to it. Revert. | Restored through git: exact CRLF bytes as checked out, and `git status` clean. | |
| RW12 | Path spellings | Start `claude` from the 8.3 short path (see W10). Ask for edits to `ADD.JS` and then `add.js`. | One file in the pane, not two. Revert is exact. | |
| RW13 | Outside git, and gitignored | In a folder with no git, ask Claude to change a file with `Set-Content`, then with Edit. In the scratch repo, add `secret.txt` to `.gitignore` and ask Claude to change it with PowerShell. | Outside git: only the Edit is listed. Gitignored with PowerShell: not listed. Both are documented limits, not bugs. | |

## Reporting

For any unexpected result, write down:
- the check number;
- the Claude Code version (`claude --version`);
- the surface (terminal or Desktop);
- the tool Claude used (Bash or PowerShell);
- the exact band and stamp text, or for Changes, the pane's note and the `Format-Hex` output before and after.

Then send them to the mod's owner. Add every false ❌ or missed claim to `fixtures/` as a new sample.
