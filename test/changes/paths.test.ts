import { test } from 'node:test'
import assert from 'node:assert/strict'

import { relativeTo, shownPath } from '../../plugins/changes/hooks/core/paths.ts'

test('relativeTo strips the root, with forward slashes', () => {
  assert.equal(relativeTo('C:/repo', 'C:\\repo\\src\\a.ts', true), 'src/a.ts')
  assert.equal(relativeTo('/home/me/repo/', '/home/me/repo/a b.ts', false), 'a b.ts')
})

test('relativeTo ignores case on Windows only', () => {
  assert.equal(relativeTo('C:/Repo', 'c:/repo/a.ts', true), 'a.ts')
  assert.equal(relativeTo('/Repo', '/repo/a.ts', false), undefined)
})

test('relativeTo answers undefined outside the root, for the root itself, and for a sibling with the same prefix', () => {
  assert.equal(relativeTo('C:/repo', 'D:/other/a.ts', true), undefined)
  assert.equal(relativeTo('C:/repo', 'C:/repo', true), undefined)
  assert.equal(relativeTo('C:/repo', 'C:/repo2/a.ts', true), undefined)
})

test('shownPath is relative under the folder, else the full path', () => {
  assert.equal(shownPath('C:/proj', 'C:\\proj\\src\\a.ts', true), 'src/a.ts')
  assert.equal(shownPath('C:/proj', 'C:\\elsewhere\\b.ts', true), 'C:/elsewhere/b.ts')
})
