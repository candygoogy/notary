// What a snapshot's bytes are: text that `$.fs.write` gives back byte for
// byte, or binary that only the bytes path restores. Pure and synchronous.

import { eolOf, type Eol } from './diff.ts'

export type ContentMeta =
  | { kind: 'text'; text: string; size: number; eol: Eol; bom: boolean }
  | { kind: 'binary'; size: number }

// As git decides: a NUL byte in the first 8 KB means binary.
const SNIFF_BYTES = 8000

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Text is valid UTF-8 with no NUL in its head; the BOM stays in `text`, so
// writing `text` back as UTF-8 reproduces the bytes exactly. The BOM is put
// back by hand: the mod runtime's decoder drops it even with `ignoreBOM`
// (the io probe caught a restore missing it).
export function describe(bytes: Uint8Array, decoder: TextDecoder = DECODER): ContentMeta {
  const size = bytes.length
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'binary', size }
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return { kind: 'binary', size }
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (bom && !text.startsWith('﻿')) text = '﻿' + text
  return { kind: 'text', text, size, eol: eolOf(text), bom }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CODES = new Uint8Array(128).fill(255)
for (let i = 0; i < ALPHABET.length; i++) CODES[ALPHABET.charCodeAt(i)] = i

// `$.fs.read(path, { as: 'bytes' })` answers base64, and the bytes path of a
// restore sends base64; both directions without relying on atob or Buffer.
export function base64FromBytes(bytes: Uint8Array): string {
  const chunks: string[] = []
  const CHUNK = 0x6000
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK)
    let out = ''
    for (let i = start; i < end; i += 3) {
      const b0 = bytes[i]
      const b1 = i + 1 < end ? bytes[i + 1] : 0
      const b2 = i + 2 < end ? bytes[i + 2] : 0
      out +=
        ALPHABET[b0 >> 2] +
        ALPHABET[((b0 & 3) << 4) | (b1 >> 4)] +
        (i + 1 < end ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
        (i + 2 < end ? ALPHABET[b2 & 63] : '=')
    }
    chunks.push(out)
  }
  return chunks.join('')
}

// Throws on anything but the alphabet with up to two '=' at the end: a
// corrupt blob must fail a restore, not write different bytes.
export function bytesFromBase64(base64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) throw new Error('not base64')
  const clean = base64.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = CODES[clean.charCodeAt(i)]
    const c1 = CODES[clean.charCodeAt(i + 1)]
    const c2 = i + 2 < clean.length ? CODES[clean.charCodeAt(i + 2)] : 0
    const c3 = i + 3 < clean.length ? CODES[clean.charCodeAt(i + 3)] : 0
    out[o++] = (c0 << 2) | (c1 >> 4)
    if (i + 2 < clean.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (i + 3 < clean.length) out[o++] = ((c2 & 3) << 6) | c3
  }
  return out.subarray(0, o)
}
