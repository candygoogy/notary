import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shellWrites } from '../../plugins/scope-cop/hooks/core/shell.ts'

// [command, literal targets, unknown]. Unknown means "might write somewhere
// we can't name": never denied, never flagged.
type Case = readonly [string, readonly string[], boolean]

const BASH: readonly Case[] = [
  // Readers write nothing.
  ['ls -la src', [], false],
  ['cat src/a.ts | grep foo', [], false],
  ['git status && git diff --stat', [], false],
  ['npm test 2>&1 | tail -20', [], true],
  ['grep -rn "x > y" src', [], false],
  ["sed -n '1,20p' src/a.ts", [], false],
  // Redirections.
  ['echo hi > src/db/a.ts', ['src/db/a.ts'], false],
  ['echo hi >> notes.txt', ['notes.txt'], false],
  ['echo hi>out.txt', ['out.txt'], false],
  ['node x.js > out.log 2>&1', ['out.log'], true],
  ['cmd 2> err.txt', ['err.txt'], true],
  ['ls &> all.txt', ['all.txt'], false],
  ['ls > /dev/null 2>&1', [], false],
  ['echo "a > b" > "my file.txt"', ['my file.txt'], false],
  ["echo x > 'q.txt'", ['q.txt'], false],
  // Heredocs: the body is not commands.
  ["cat > src/db/b.ts <<'EOF'\nexport const a = 1 > 0\nrm -rf /\nEOF\necho done", ['src/db/b.ts'], false],
  ['cat <<EOF > out.md\n# x\nEOF', ['out.md'], false],
  // tee, sed -i, cp, mv, rm, touch, mkdir.
  ['echo x | tee a.txt b.txt', ['a.txt', 'b.txt'], false],
  ['echo x | tee -a log.txt', ['log.txt'], false],
  ["sed -i 's/1/2/' src/db/c.js", ['src/db/c.js'], false],
  ["sed -i.bak -e 's/a/b/' x.txt y.txt", ['x.txt', 'y.txt'], false],
  ['cp src/a.ts lib/a.ts', ['lib/a.ts'], false],
  ['cp -r src/ backup/', ['backup/'], false],
  ['cp -t dest a b', ['dest'], false],
  ['mv old.ts new.ts', ['old.ts', 'new.ts'], false],
  ['rm -f a.ts b.ts', ['a.ts', 'b.ts'], false],
  ['rm -rf dist', ['dist'], false],
  ['touch a.ts && mkdir -p src/new', ['a.ts', 'src/new'], false],
  // Never guessed: variables, globs, substitutions, ~, escapes.
  ['echo x > $OUT', [], true],
  ['rm *.log', [], true],
  ['cp a.ts "$DEST/a.ts"', [], true],
  ['echo x > $(mktemp)', [], true],
  ['echo x > ~/notes.txt', [], true],
  ['rm src/{a,b}.ts', [], true],
  // Interpreters and scripts write where we can't see.
  ['python -c "open(\'x\',\'w\')"', [], true],
  ['node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"', [], true],
  ['npm install', [], true],
  ['git checkout -- src/a.ts', [], true],
  ['find . -name "*.tmp" -delete', [], true],
  ['xargs rm < list.txt', [], true],
  // After a cd, relative targets are unknown; absolute ones still count.
  ['cd src && echo x > a.ts', [], true],
  ['cd /tmp && echo x > /home/me/app/a.ts', ['/home/me/app/a.ts'], false],
  ['(cd sub && make) && touch built', [], true],
  // Assignments and wrappers in front.
  ['FOO=1 touch a.ts', ['a.ts'], false],
  ['sudo rm /etc/x', ['/etc/x'], false],
  // Comments are not commands.
  ['ls # > not-a-file', [], false],
]

const PS: readonly Case[] = [
  ['Get-Content src/a.ts | Select-String foo', [], false],
  ['Get-ChildItem -Recurse src', [], false],
  ["Set-Content -Path src/db/a.ts -Value 'x'", ['src/db/a.ts'], false],
  ["Set-Content src\\db\\a.ts 'x'", ['src\\db\\a.ts'], false],
  ["'x' | Out-File -FilePath out.txt -Encoding utf8", ['out.txt'], false],
  ["'x' | Out-File out.txt", ['out.txt'], false],
  ["Add-Content -LiteralPath 'my file.txt' -Value 'x'", ['my file.txt'], false],
  ['New-Item -ItemType File -Path src/new.ts -Force', ['src/new.ts'], false],
  ['ni src/x.ts', ['src/x.ts'], false],
  ['mkdir src/new', ['src/new'], false],
  ['Remove-Item -Recurse -Force dist', ['dist'], false],
  ['del a.ts', ['a.ts'], false],
  ['Copy-Item src/a.ts lib/a.ts', ['lib/a.ts'], false],
  ['Copy-Item -Path src/a.ts -Destination lib/', ['lib/'], false],
  ['Move-Item old.ts new.ts', ['old.ts', 'new.ts'], false],
  ['Rename-Item a.ts b.ts', ['a.ts'], true],
  ["'x' | Tee-Object -FilePath log.txt", ['log.txt'], false],
  ['echo x > out.txt', ['out.txt'], false],
  ['dir *> all.txt', ['all.txt'], false],
  ['npm test 2>&1 | Out-Null', [], true],
  ['ls > $null', [], false],
  ['Remove-Item a.ts -WhatIf', [], false],
  // Never guessed.
  ['Set-Content -Path $f -Value x', [], true],
  ['Set-Content "$dir/a.ts" x', [], true],
  ['Remove-Item *.log', [], true],
  ['Remove-Item a.ts, b.ts', [], true],
  ["[IO.File]::WriteAllText('a.ts', 'x')", [], true],
  ['Get-ChildItem | ForEach-Object { Remove-Item $_ }', [], true],
  ['Set-Content -Pa a.ts x', [], true],
  ['& ./build.ps1', [], true],
  ["@'\nline > not.txt\n'@ | Set-Content -Path here.md", ['here.md'], false],
  ['Set-Location src; Set-Content a.ts x', [], true],
  ['cd C:/tmp; Set-Content C:/work/app/a.ts x', ['C:/work/app/a.ts'], false],
  ['Get-Date # > nope.txt', [], false],
]

for (const [tool, cases] of [['Bash', BASH], ['PowerShell', PS]] as const) {
  for (const [command, targets, unknown] of cases) {
    test(`${tool}: ${JSON.stringify(command)}`, () => {
      assert.deepEqual(shellWrites(command, tool), { targets, unknown })
    })
  }
}

test('an empty or blank command writes nothing', () => {
  assert.deepEqual(shellWrites('', 'Bash'), { targets: [], unknown: false })
  assert.deepEqual(shellWrites('  \n ', 'PowerShell'), { targets: [], unknown: false })
})

test('an unclosed quote is unknown, never a guess', () => {
  assert.deepEqual(shellWrites('echo "x > a.txt', 'Bash'), { targets: [], unknown: true })
})
