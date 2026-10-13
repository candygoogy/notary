// Text limits shared by the core: claims are shown at 80 characters, commands at 40.

export const CLAIM_CHARS = 80
export const COMMAND_CHARS = 40

// Cuts `text` to at most `max` characters, the ellipsis included.
export function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}
