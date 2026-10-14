// A turn's title in the pane: its prompt on one line, in quotes, cut at a
// word near `max` characters with "…" when cut (a stop or comma left at the
// cut goes). Pure.

import { stripAnsi } from '../shared/ansi.ts'

export const TITLE_CHARS = 60

export function turnTitle(prompt: string, max = TITLE_CHARS): string {
  const text = stripAnsi(prompt)
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim()
  // By code point, so a cut never splits an emoji's surrogate pair.
  const chars = Array.from(text)
  if (chars.length <= max) return `"${text}"`
  // The last space at or before `max` (one right after the 60th character
  // keeps that word whole); a word too long to keep whole (no space in the
  // first half) is cut where it stands.
  const space = chars.lastIndexOf(' ', max)
  const cut = chars.slice(0, space >= max / 2 ? space : max).join('')
  return `"${cut.replace(/[\s.,;:]+$/, '')}…"`
}
