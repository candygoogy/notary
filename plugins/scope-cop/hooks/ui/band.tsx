import type { Elements, RenderSurface } from 'claude-code'

import { bandText, type FlagView } from '../core/copy.ts'

type BandElements = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Text'>

export type BandHandlers = {
  // Adds the newest outside file to the scope; null when it has no path
  // under the project (a pattern can't name it).
  onAllow: (() => void) | null
  // Null while the pane is open.
  onDetails: (() => void) | null
  onDismiss: () => void
  onClear: () => void
}

// One row while a scope is set (design note §5): the scope, and what went
// outside it since the last prompt. Pure: register.tsx reads the state.
export function bandView({ Box, Button, Text }: BandElements, patterns: readonly string[], outside: readonly FlagView[], on: BandHandlers) {
  const quiet = outside.length === 0
  return (
    <Box key="scope-cop-band" flexDirection="row" gap={1}>
      <Text color={quiet ? undefined : 'warning'} dimColor={quiet} wrap="truncate-end">
        {bandText(patterns, outside)}
      </Text>
      {!quiet && on.onAllow !== null ? <Button key="allow" label="Allow file" onPress={on.onAllow} /> : null}
      {!quiet && on.onDetails !== null ? <Button key="details" label="Details" onPress={on.onDetails} /> : null}
      {quiet ? <Button key="clear" label="Clear" onPress={on.onClear} /> : <Button key="dismiss" label="Dismiss" onPress={on.onDismiss} />}
    </Box>
  )
}
