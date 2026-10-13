import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isVerifiableEdit } from '../../plugins/receipts/hooks/core/edits.ts'

const WIN = 'C:\\Users\\dev\\code\\shop'
const NIX = '/home/dev/code/shop'

const table: Array<[string, string, boolean, string]> = [
  // Code inside the project.
  [`${WIN}\\src\\cart.ts`, WIN, true, 'Windows source file'],
  ['C:/Users/dev/code/shop/src/cart.ts', WIN, true, 'forward slashes'],
  ['c:\\users\\DEV\\Code\\Shop\\src\\cart.ts', WIN, true, 'case differs on Windows'],
  ['/c/Users/dev/code/shop/src/cart.ts', WIN, true, 'Git Bash /c/ path'],
  ['src/cart.ts', WIN, true, 'relative path'],
  [`${NIX}/src/cart.py`, NIX, true, 'Linux source file'],
  [`${NIX}/package.json`, NIX, true, 'config at the root'],
  [`${NIX}/src/../lib/a.ts`, NIX, true, 'dot-dot inside the project'],
  ['C:\\Users\\dev\\AppData\\Local\\Temp\\notary-smoke\\add.js', 'C:\\Users\\dev\\AppData\\Local\\Temp\\notary-smoke', true, 'a project that lives in temp keeps its files'],
  // Docs and prose.
  [`${WIN}\\README.md`, WIN, false, 'README'],
  [`${NIX}/docs/guide.mdx`, NIX, false, 'mdx'],
  [`${NIX}/NOTES.TXT`, NIX, false, 'txt, upper case'],
  [`${NIX}/docs/api.rst`, NIX, false, 'rst'],
  [`${NIX}/docs/manual.adoc`, NIX, false, 'adoc'],
  [`${NIX}/CLAUDE.md`, NIX, false, 'CLAUDE.md'],
  [`${NIX}/AGENTS.md`, NIX, false, 'AGENTS.md'],
  // Claude's own files and memory.
  [`${NIX}/.claude/settings.json`, NIX, false, 'project .claude/'],
  [`${NIX}/.agent/plan.json`, NIX, false, 'project .agent/'],
  ['C:\\Users\\dev\\.claude\\projects\\x\\memory\\note.json', WIN, false, 'Claude memory'],
  ['~/.claude/skills/x/SKILL.json', NIX, false, 'home .claude'],
  // Outside the project, temp and scratch.
  ['C:\\Users\\dev\\code\\other\\src\\a.ts', WIN, false, 'another project'],
  ['C:\\Users\\dev\\code\\shop-old\\a.ts', WIN, false, 'a sibling that shares a prefix'],
  ['C:\\Users\\dev\\AppData\\Local\\Temp\\x.js', WIN, false, '%TEMP%'],
  ['/tmp/check.py', NIX, false, '/tmp'],
  ['/tmp/check.py', '', false, '/tmp with no project known'],
  [`${NIX}/scratch/try.ts`, NIX, false, 'scratch/'],
  // Build and cache output.
  [`${NIX}/target/debug/build.rs`, NIX, false, 'target/'],
  [`${NIX}/dist/index.js`, NIX, false, 'dist/'],
  [`${NIX}/build/out.js`, NIX, false, 'build/'],
  [`${NIX}/node_modules/x/index.js`, NIX, false, 'node_modules/'],
  [`${NIX}/.cache/vite/dep.js`, NIX, false, '.cache/'],
  [`${NIX}/pkg/__pycache__/a.pyc`, NIX, false, '__pycache__'],
  ['', NIX, false, 'no path'],
]

for (const [path, cwd, expected, note] of table) {
  test(`isVerifiableEdit: ${note}`, () => {
    assert.equal(isVerifiableEdit(path, cwd), expected, `${path} in ${cwd}`)
  })
}

test('a directory named like a build dir only counts as a whole segment', () => {
  assert.equal(isVerifiableEdit(`${NIX}/src/builder/a.ts`, NIX), true)
  assert.equal(isVerifiableEdit(`${NIX}/src/distance.ts`, NIX), true)
})
