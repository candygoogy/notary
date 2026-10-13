import type { Elements, RenderSurface } from 'claude-code'

type BandElements = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Text'>
export type BandState = { turnId: string; ordinal: number; files: number }

// The line above the prompt after a turn that changed code. Pure:
// register.tsx reads the state and hands over the handlers.
export function bandView({ Box, Button, Text }: BandElements, band: BandState, onOpen: () => void, onHide: () => void) {
  return (
    <Box key="changes-band" flexDirection="row" gap={1}>
      <Text wrap="truncate-end">
        Turn #{band.ordinal} changed {band.files} {band.files === 1 ? 'file' : 'files'}
      </Text>
      <Button key="open" label="Open" onPress={onOpen} />
      <Button key="hide" label="Dismiss" onPress={onHide} />
    </Box>
  )
}
