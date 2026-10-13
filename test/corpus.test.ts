// Asserts the Receipts core against the labeled corpus in /fixtures: real
// Claude Code answers and tool outputs (redacted) plus constructed cases.
// A sample with `todo` records the behavior we want but don't have yet: it
// runs and reports, but doesn't fail the suite.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { findClaims } from '../plugins/receipts/hooks/core/claims.ts'
import { isVerifiableEdit } from '../plugins/receipts/hooks/core/edits.ts'
import { classify } from '../plugins/receipts/hooks/core/evidence.ts'
import { emptyLedger, recordEdit, recordRun } from '../plugins/receipts/hooks/core/ledger.ts'
import { judge } from '../plugins/receipts/hooks/core/verdict.ts'
import type { ClaimKind, Outcome, RunInput, Strength } from '../plugins/receipts/hooks/core/types.ts'

type Source = 'real' | 'constructed'
type ClaimSample = {
  text: string
  expect: { kind: ClaimKind; certainty: 'sure' | 'maybe' }[]
  note: string
  source: Source
  todo?: string
}
type RunSample = {
  run: RunInput
  expect: { strength: Strength; outcome?: Outcome }
  note: string
  source: Source
  todo?: string
}

function load<T>(name: string): T[] {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T[]
}

const claims = load<ClaimSample>('claims.json')
const runs = load<RunSample>('runs.json')

describe('claims corpus', () => {
  for (const [i, s] of claims.entries()) {
    test(`#${i} ${s.note}`, { todo: s.todo }, () => {
      const found = findClaims(s.text).map(c => ({ kind: c.kind, certainty: c.certainty }))
      assert.deepEqual(found, s.expect, JSON.stringify(s.text))
    })
  }
})

describe('runs corpus', () => {
  for (const [i, s] of runs.entries()) {
    test(`#${i} ${s.note}`, { todo: s.todo }, () => {
      const ev = classify(s.run)
      // Outcome is only labeled for evidence that counts; strength none leaves it free.
      const got = s.expect.outcome === undefined ? { strength: ev.strength } : { strength: ev.strength, outcome: ev.outcome }
      assert.deepEqual(got, s.expect, `${s.run.tool}: ${s.run.command.slice(0, 120)}`)
    })
  }
})

// Whole-turn samples: edits and runs in order, then the answer, judged from seq 0.
type VerdictSample = {
  steps: Array<{ edit: string } | { run: RunInput }>
  answer: string
  expect: 'verified' | 'unverified' | 'contradicted' | null
  note: string
  source: Source
  todo?: string
}

const verdicts = load<VerdictSample>('verdicts.json')

describe('verdicts corpus', () => {
  for (const [i, s] of verdicts.entries()) {
    test(`#${i} ${s.note}`, { todo: s.todo }, () => {
      let ledger = emptyLedger()
      for (const [at, step] of s.steps.entries()) {
        // As register.tsx does, less the session directory, which the samples don't carry.
        if ('edit' in step) {
          if (isVerifiableEdit(step.edit, '')) ledger = recordEdit(ledger, step.edit, at)
        } else {
          ledger = recordRun(ledger, classify(step.run), at)
        }
      }
      const claims = findClaims(s.answer).filter(claim => claim.certainty === 'sure')
      assert.equal(judge(claims, ledger, 0)?.kind ?? null, s.expect, s.answer)
    })
  }
})

test('the corpus is big enough and mixes real and Windows samples', () => {
  assert.ok(claims.length >= 60, `claims: ${claims.length}`)
  assert.ok(runs.length >= 60, `runs: ${runs.length}`)
  assert.ok(claims.filter(s => s.source === 'real').length >= 30)
  assert.ok(runs.filter(s => s.source === 'real').length >= 30)
  assert.ok(runs.filter(s => s.run.tool === 'PowerShell').length >= 15)
  assert.ok(runs.some(s => s.run.text.includes('\r\n')))
  assert.ok(runs.some(s => s.run.text.includes('\u001b[')))
})
