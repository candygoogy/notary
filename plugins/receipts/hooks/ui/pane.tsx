import type { Elements, RenderSurface } from 'claude-code'

import { CLAIM_CHARS, truncate } from '../core/text.ts'
import type { Verdict, VerdictKind } from '../core/types.ts'
import { VERDICT_COLOR } from './band.tsx'

type PaneElements = Pick<Elements[RenderSurface], 'Box' | 'Text'>
type Row = { turnId: string; at: number; verdict: Verdict }

const GLYPH: Record<VerdictKind, string> = { verified: '✅', unverified: '⚠️', contradicted: '❌' }

// The /receipts pane: every judged turn, newest first. Pure: register.tsx
// reads the history and the clock.
export function paneView({ Box, Text }: PaneElements, history: readonly Row[], now: number) {
  if (history.length === 0) {
    return (
      <Box key="receipts" flexDirection="column">
        <Text dimColor>No judged turns yet. Receipts judges an answer that claims success after an edit.</Text>
      </Box>
    )
  }
  return (
    <Box key="receipts" flexDirection="column">
      {[...history].reverse().map(row => (
        <Box key={`row-${row.turnId}-${row.at}`} flexDirection="column" marginBottom={1}>
          <Text color={VERDICT_COLOR[row.verdict.kind]}>
            {GLYPH[row.verdict.kind]} {truncate(row.verdict.claim.sentence, CLAIM_CHARS)}
          </Text>
          <Text dimColor>
            {'   '}
            {row.verdict.evidence?.summary ?? 'no check after the last edit'} · {ago(now - row.at)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
