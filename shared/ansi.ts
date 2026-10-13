// Suite-wide pure helpers for terminal output. Source of truth: /shared.
// Copied into each plugin's hooks/shared by scripts/sync-shared.mjs.

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\x5c)/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}
