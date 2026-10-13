import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isYes } from '../../plugins/receipts/hooks/smartcheck.ts'

test('a reply that starts with YES keeps the claim', () => {
  for (const reply of ['YES', 'YES.', ' yes', 'Yes, it does']) assert.equal(isYes(reply), true, reply)
})

test('anything else drops it', () => {
  for (const reply of ['NO', '', 'Maybe', 'YESTERDAY', 'I think YES']) assert.equal(isYes(reply), false, reply)
})
