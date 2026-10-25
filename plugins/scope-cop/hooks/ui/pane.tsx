import type { Elements, RenderSurface } from 'claude-code'

import { MODE_TEXT, NO_SCOPE_TEXT, OUTCOME_TEXT } from '../core/copy.ts'
import type { Mode } from '../core/scope.ts'

type PaneElements = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Text'>

export type PaneFlag = { at: number; path: string; tool: string; via: 'tool' | 'shell' | 'sweep'; agentId?: string; outcome: 'flagged' | 'told' | 'denied' | 'approved' }

const GLYPH = { flagged: '⚠', told: '⚠', denied: '⛔', approved: '✓' } as const

// The /scope pane: the patterns with [Remove], the mode, and every edit
// outside the scope this conversation, newest first. Pure.
export function paneView({ Box, Button, Text }: PaneElements, patterns: readonly string[] | null, mode: Mode, log: readonly PaneFlag[], now: number, onRemove: (pattern: string) => void) {
  return (
    <Box key="scope-cop" flexDirection="column">
      {patterns === null ? (
        <Text dimColor>{NO_SCOPE_TEXT}</Text>
      ) : (
        <Box key="patterns" flexDirection="column" marginBottom={1}>
          <Text bold>Scope</Text>
          {patterns.map(p => (
            <Box key={`pattern-${p}`} flexDirection="row" gap={1}>
              <Text>{p}</Text>
              <Button key={`remove-${p}`} label="Remove" onPress={() => onRemove(p)} />
            </Box>
          ))}
          <Text dimColor>Mode {MODE_TEXT[mode]}.</Text>
        </Box>
      )}
      {log.length === 0 ? (
        patterns === null ? null : <Text dimColor>Nothing outside the scope yet.</Text>
      ) : (
        [...log].reverse().map((f, i) => (
          <Text key={`flag-${f.at}-${i}`} color={f.outcome === 'denied' ? 'error' : f.outcome === 'approved' ? undefined : 'warning'} wrap="truncate-end">
            {GLYPH[f.outcome]} {f.path} · {f.via === 'shell' ? 'shell command' : f.via === 'sweep' ? 'changed during the turn (shell or you)' : f.tool}
            {f.agentId !== undefined ? ' (subagent)' : ''} · {OUTCOME_TEXT[f.outcome]} · {ago(now - f.at)}
          </Text>
        ))
      )}
    </Box>
  )
}

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
