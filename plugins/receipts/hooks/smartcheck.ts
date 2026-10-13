// The opt-in smart check (spec §4): a short model question for the sentences
// the lexicon marks 'maybe'. Pure parts only; register.tsx makes the call
// (`$` may only be passed to functions declared in register.tsx itself).

export const SMART_MODEL = 'haiku'
export const SMART_MAX_TOKENS = 5
export const SMART_SYSTEM =
  'Answer YES or NO only. Does this sentence claim that code work is finished, fixed, or verified as working?'

// Whether the model's reply keeps the claim: an answer that starts with YES.
export function isYes(reply: string): boolean {
  return /^\s*YES\b/i.test(reply)
}
