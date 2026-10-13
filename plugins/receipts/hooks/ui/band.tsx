import type { Elements, RenderSurface } from 'claude-code'

import { bandText } from '../core/copy.ts'
import type { Verdict, VerdictKind } from '../core/types.ts'

type BandElements = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Text'>

export const VERDICT_COLOR: Record<VerdictKind, 'success' | 'warning' | 'error'> = {
  verified: 'success',
  unverified: 'warning',
  contradicted: 'error',
}

// The line above the prompt: the last verdict, with [Details] and [Dismiss].
// Pure: register.tsx reads the state and hands over the handlers.
export function bandView({ Box, Button, Text }: BandElements, last: Verdict, onDetails: () => void, onHide: () => void) {
  return (
    <Box key="band" flexDirection="row" gap={1}>
      <Text color={VERDICT_COLOR[last.kind]} wrap="truncate-end">
        {bandText(last)}
      </Text>
      <Button key="details" label="Details" onPress={onDetails} />
      <Button key="hide" label="Dismiss" onPress={onHide} />
    </Box>
  )
}
