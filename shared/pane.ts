// What to tell the person when a pane they asked for opens but waits undrawn
// (`$.ui.open` answered `isPlaced: false`): the engine's own reason, which
// names the width floor and the width now, or the surface that places no
// panes. Null once the pane is drawn, so nothing shows then.

export type Opened = { isPlaced: true } | { isPlaced: false; reason: string }

export function waitingNote(title: string, opened: Opened): string | null {
  if (opened.isPlaced) return null
  const why = opened.reason.trim().replace(/[\s.]+$/, '')
  return why === '' ? `${title} pane is ready but not shown yet.` : `${title} pane is ready but not shown yet: ${why}.`
}
