import { test } from 'node:test'
import assert from 'node:assert/strict'

import { waitingNote } from '../../shared/pane.ts'

test('waitingNote says nothing once the pane is drawn', () => {
  assert.equal(waitingNote('Changes', { isPlaced: true }), null)
})

test("waitingNote passes on the engine's reason, ending in one full stop", () => {
  assert.equal(
    waitingNote('Changes', { isPlaced: false, reason: 'the terminal is 80 columns wide; it is drawn from 110.' }),
    'Changes pane is ready but not shown yet: the terminal is 80 columns wide; it is drawn from 110.',
  )
  assert.equal(waitingNote('Receipts', { isPlaced: false, reason: 'no attached surface places panes' }), 'Receipts pane is ready but not shown yet: no attached surface places panes.')
})

test('waitingNote with no reason still says the pane waits', () => {
  assert.equal(waitingNote('Receipts', { isPlaced: false, reason: '  ' }), 'Receipts pane is ready but not shown yet.')
})
