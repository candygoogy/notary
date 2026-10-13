import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isCodePath } from '../../plugins/changes/hooks/core/noise.ts'

const ROOT = ['C:/proj']

test('source files are code', () => {
  for (const path of ['C:/proj/src/a.ts', 'C:\\proj\\lib\\b.py', 'C:/proj/main.go', 'C:/proj/Dockerfile', 'C:/proj/package.json', 'C:/proj/.github/workflows/ci.yml', 'C:/proj/src/docs.ts']) {
    assert.equal(isCodePath(path, ROOT, true), true, path)
  }
})

test('prose, logs, data and lockfiles are not', () => {
  for (const path of ['README.md', 'notes.txt', 'CHANGELOG.MD', 'guide.mdx', 'run.log', 'data.csv', 'package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'yarn.lock', 'pubspec.lock', 'Podfile.lock', 'poetry.lock']) {
    assert.equal(isCodePath(`C:/proj/${path}`, ROOT, true), false, path)
  }
})

test('review 2 #7: text files that are build input are code', () => {
  for (const name of ['CMakeLists.txt', 'requirements.txt', 'requirements-dev.txt', 'constraints.txt']) {
    assert.equal(isCodePath(`C:/proj/${name}`, ROOT, true), true, name)
  }
})

test('docs, notes, build output and dependency folders under the root are not code', () => {
  for (const path of ['docs/api.ts', 'doc/x.html', 'notes/todo.ts', '.claude/settings.json', 'node_modules/x/index.js', 'dist/app.js', 'coverage/lcov.info', 'target/debug/x']) {
    assert.equal(isCodePath(`C:/proj/${path}`, ROOT, true), false, path)
  }
})

test('review 2 #7: quiet folders are matched below the root, not on the absolute path', () => {
  assert.equal(isCodePath('C:/Work/Build/app/src/a.ts', ['C:/Work/Build/app'], true), true)
  assert.equal(isCodePath('C:/Work/Build/app/build/a.js', ['C:/Work/Build/app'], true), false)
  // Outside every base, only the file name counts.
  assert.equal(isCodePath('D:/elsewhere/docs/a.ts', ['C:/proj'], true), true)
})
