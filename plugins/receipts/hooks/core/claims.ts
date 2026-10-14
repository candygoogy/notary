// Finds success claims in an answer (spec §4, "Lexicon"). Pure and English-only.
// Precision first: a sentence that hedges, disclaims, negates, asks or
// conditions is not a claim, so Receipts stays quiet rather than nag.

import { normalizeNewlines } from '../shared/ansi.ts'
import type { Claim } from './types.ts'

// Each pattern is a way of saying "the work is finished".
const CLAIMS: readonly RegExp[] = [
  /\bI(?:'ve|\s+have)\s+(?:now\s+|just\s+|also\s+|already\s+|successfully\s+)?(?:fixed|implemented|resolved|completed|added|updated|finished|verified|confirmed)\b/i,
  /\bI\s+(?:fixed|resolved|implemented|completed|finished)\b/i,
  /(?:\b(?:is|are)|'s|'re)\s+(?:now\s+)?(?:all\s+)?(?:fixed|done|working(?!\s+(?:on|through|towards?)\b)|passing|green|resolved|complete|completed|finished)\b/i,
  /\b(?:tests?|specs?|suites?|checks?)\s+(?:now\s+|all\s+|still\s+)?(?:pass|passes|passed|passing|succeed|succeeds|succeeded)\b/i,
  // "Tests: 673 pass", "**Tests:** 673 pass".
  /\btests?\b[*:\s]*\d+\s+(?:pass|passes|passed|passing)\b/i,
  // "every TypeScript test and the site build passed", "All the unit tests in X pass".
  /\b(?:every|all)\b[^.;]{0,60}?\b(?:tests?|checks?|builds?)\b[^.;]{0,60}?\b(?:pass|passes|passed|succeeded)\b/i,
  /\b(?:builds?|compiles?)\s+(?:now\s+)?(?:cleanly|successfully|succeeds?|passes|fine)\b/i,
  /\b(?:builds?|build\s+checks?|lint|typecheck|type-check|ci)\s+(?:all\s+|still\s+|now\s+)?(?:passed|passes|succeeded)\b/i,
  /\b(?:lint|typecheck|type-check|types|build|tsc|eslint|ruff)\b[^.;]{0,30}?\bclean\b/i,
  /\bno\s+(?:more\s+)?(?:type\s+|lint\s+|compile\s+|compiler\s+|build\s+|typescript\s+|page\s+)?errors\b/i,
  /\b(?:verified|confirmed)\s+(?:that\s+)?(?:it|this|everything|the\s+\w+)\s+works?\b/i,
  /^(?:verified|confirmed)(?:\s+so\s+far)?\s*:/i,
  // "It now passes", but not "traffic that passes through Cloudflare".
  /\b(?:it|this|that|everything)\s+(?:now\s+)?(?:works|passes)\b(?!\s+(?:through|to|the|a|an|on|in|into|over|by|for|from|with|along|via)\b)/i,
  /\bready\s+(?:to|for)\s+(?:merge|ship|deploy|release)\b/i,
  // An inline-code command as the subject: "`pnpm verify` passes (422 tests)".
  /\d+\s+(?:now\s+|still\s+)?(?:passes|passed|succeeds|succeeded|is\s+green|is\s+clean)\b/,
]

// Whole-sentence closers ("Done.", "**Fixed!**", "All set ✅").
const TERSE = new Set(['done', 'fixed', 'all set', 'all done', 'all good', 'all fixed', 'complete', 'completed', 'finished', 'resolved'])
// A closer that opens a longer sentence: "Fixed, if you want…", "Fixed and live (…)".
const TERSE_LEAD = /^(?:done|fixed|all\s+set|all\s+done|all\s+fixed|finished|resolved)(?=\s*[,;:]|\s+and\s|\s+[—–-]\s)/i
// An instruction, not a report: "Confirm the new tests pass, then…".
const IMPERATIVE = /^(?:confirm|make\s+sure|ensure|check|verify|run|try|let's|let\s+me)\b/i

const HEDGE = /\b(?:should|probably|likely|might|may|maybe|perhaps|hopefully|presumably|i\s+think|i\s+believe|i\s+guess|seems?|appears?|ought\s+to|in\s+theory)\b/i
const DISCLAIMER =
  /\b(?:haven't|have\s+not|hasn't|didn't|did\s+not|couldn't|could\s+not|can't|cannot|wasn't\s+able\s+to|unable\s+to)\s+(?:yet\s+)?(?:run|test|tested|verify|verified|check|checked|execute|confirm|confirmed)\b|\buntested\b|\bunverified\b|\bnot\s+(?:yet\s+)?(?:been\s+)?(?:tested|verified|run)\b|\byou(?:'ll|\s+will)?\s+(?:need|want|have)\s+to\s+(?:run|test|verify)\b|\bplease\s+(?:run|test|verify)\b/i
const NEGATION =
  /(?:\bnot|\bnever|n't)\s+(?:(?:yet|been|be|fully|quite|all|actually|really)\s+)*(?:fixed|done|working|passing|passed|green|resolved|complete|completed|pass|work|works|succeed|succeeded)\b|\bstill\s+(?:fails?|failing|broken|red|errors?|erroring)\b|\bno\s+longer\s+(?:pass|passes|works?)\b|\bnothing\s+(?:\w+\s+)?(?:is|was|has\s+been)\b|\bnot\s+(?:\w+\s+){0,2}yet\b/i
const FUTURE = /\bwill\s+(?:now\s+)?(?:be|pass|work|succeed)\b|\bgoing\s+to\b|\bI(?:'ll|\s+will)\b|\bnext\b/i
// A condition, or past context, only counts when it comes before the claim
// ("if the tests pass", "before my change, all tests passed"), not after it
// ("Fixed, if you want to rerun it").
const CONDITION =
  /\b(?:if|once|when|whenever|while|unless|until|whether|assuming|as\s+soon\s+as)\b|\bbefore\s+(?:my|the|this|your|our)\s+(?:change|changes|edit|edits|fix|refactor|patch)\b|\bafter\s+(?:you|we)\b/i
// A success phrase someone did not say, not a report of success: "My last
// message didn't say the tests passed", "I'm not claiming the build is fixed".
// Only when the frame leads into the claim within one clause: "I never said
// otherwise: all tests pass" and "I didn't break anything, all tests pass"
// still claim.
const DENIED_REPORT =
  /(?:\bnot|\bnever|n't)\s+(?:\w+\s+){0,2}?(?:say|said|saying|claim|claimed|claiming|state|stated|stating|tell|told|telling|report|reported|reporting|mean|meant|suggest|suggested|imply|implied|promise|promised|mention|mentioned)\b(?=[^,;:—–]*$)/i
// An explanation or an introduction, not a report: "Why it works on those two
// sites:", "Here's how it works:", "This is why the build passes."
const EXPLANATION = /^(?:why|how|what|here(?:'s|\s+is)\s+(?:why|how|what)|this\s+is\s+(?:why|how)|that's\s+(?:why|how)|the\s+reason)\b/i
// An instruction after a leading phrase: "Before the push, check that … passed".
const LEADING_PHRASE = /^[^,;:]{1,40},\s*/
// A TDD step, not a success: "I've added a failing test that reproduces the bug."
const FAILING_TEST_ADDED = /\b(?:added|wrote|written|writing|created|adding)\s+(?:a|an|the|two|three|\d+)?\s*(?:new\s+)?(?:failing|red)\s+(?:unit\s+|regression\s+)?tests?\b/i
// The answer itself says something is failing: Claude already told the person,
// so there is nothing to catch ("3 tests are failing; I left them for you",
// "the integration suite fails because Docker isn't running", "1 passed and 4 failed").
// A sentence about fixing a past failure ("fixed the failing test") is no disclosure.
const DISCLOSES_FAILURE: readonly RegExp[] = [
  /\b(?:is|are|still|keeps?)\s+(?:\w+\s+){0,2}?(?:failing|broken|red)\b/i,
  /\b(?:tests?|suites?|specs?|builds?|e2e|checks?|lint|typecheck)\s+(?:\w+\s+){0,3}?(?:fails|fail|failing)\b(?!\s+(?:before|without))/i,
  /\b[1-9]\d*\s+(?:\w+\s+)?(?:tests?\s+)?(?:failed|failing|fail)\b/i,
]
const PAST_FAILURE = /\b(?:fix(?:ed|es|ing)?|resolv\w*|repair\w*|previously|used\s+to|was|were|before|without|reproduc\w*)\b/i

// A claim about tests names them as a result: tests/specs/a suite with a pass
// or fail verb, "N tests", or "Tests: N". The verb ("I opened it to test")
// is not enough.
const TESTS_KIND =
  /\b(?:tests?|specs?|suites?)\b[^.;]{0,40}?\b(?:pass|passes|passed|passing|green|succeed\w*|fail\w*)\b|\b(?:pass|passes|passed|passing)\b[^.;]{0,20}?\b(?:tests?|specs?)\b|\b\d+\s+(?:[\w-]+\s+){0,2}(?:tests?|specs?)\b|\btests?:[*\s]*\d+/i
// A claim about the build, types or lint, judged by build runs, not by tests.
const BUILD_KIND = /\b(?:builds?|compiles?|compiled|typechecks?|type-checks?|type\s+check|types|tsc|lint|linter|linting|eslint|ruff|clippy)\b/i
const CONJUNCTION = /\b(?:but|although|except)\b/i
const MAYBE_WORDS = 25

export function findClaims(text: string): Claim[] {
  const { prose, codes } = blankIgnored(text)
  const all = sentences(prose)
  if (all.some(disclosesFailure)) return []
  const claims: Claim[] = []
  for (const sentence of all) {
    const claim = asClaim(sentence, codes)
    if (claim !== null) claims.push(claim)
  }
  return claims
}

function disclosesFailure(sentence: string): boolean {
  return DISCLOSES_FAILURE.some(pattern => pattern.test(sentence)) && !PAST_FAILURE.test(sentence)
}

function asClaim(sentence: string, codes: readonly string[]): Claim | null {
  const lead = sentence.replace(/^[\s*_✓✔✅]+/u, '')
  if (IMPERATIVE.test(lead) || IMPERATIVE.test(lead.replace(LEADING_PHRASE, ''))) return null
  if (EXPLANATION.test(lead) || FAILING_TEST_ADDED.test(sentence)) return null
  // A line that introduces what follows ("Here is what changed:") reports nothing.
  if (/:\s*$/.test(sentence)) return null
  const at = TERSE_LEAD.test(lead) ? 0 : claimIndex(sentence)
  if (at < 0) return null
  if (sentence.endsWith('?')) return null
  if (HEDGE.test(sentence) || DISCLAIMER.test(sentence) || NEGATION.test(sentence) || FUTURE.test(sentence)) return null
  if (CONDITION.test(sentence.slice(0, at)) || DENIED_REPORT.test(sentence.slice(0, at))) return null
  const words = sentence.split(/\s+/).filter(Boolean).length
  return {
    sentence: sentence.replace(/(\d+)/g, (_, i: string) => `\`${codes[Number(i)]}\``),
    kind: TESTS_KIND.test(sentence) ? 'tests' : BUILD_KIND.test(sentence) ? 'build' : 'generic',
    certainty: words > MAYBE_WORDS && CONJUNCTION.test(sentence) ? 'maybe' : 'sure',
  }
}

// Where the claim starts in the sentence, or -1 when there is none.
function claimIndex(sentence: string): number {
  if (isTerse(sentence)) return 0
  let first = -1
  for (const pattern of CLAIMS) {
    const match = pattern.exec(sentence)
    if (match === null) continue
    // A label, not a report: "The free path that works: …". ("All tests pass: 625
    // TypeScript, 67 Rust" still claims; only a relative clause before the colon labels.)
    if (/^(?:that|which)\b/i.test(match[0]) && /^[*_]*\s*:/.test(sentence.slice(match.index + match[0].length))) continue
    if (first < 0 || match.index < first) first = match.index
  }
  return first
}

function isTerse(sentence: string): boolean {
  const hadCheck = /✅|✔/u.test(sentence)
  const core = sentence
    .replace(/[*_#]/g, '')
    .replace(/✅|✔️?|☑️?|🎉/gu, '')
    .replace(/[\s.!:]+$/, '')
    .trim()
    .toLowerCase()
  return TERSE.has(core) || (core === '' && hadCheck)
}

// Blanks what is not the answer's own prose: code blocks, quotes, unchecked
// to-dos, headings. Inline code becomes a placeholder, so "`pnpm verify` passes" keeps
// its subject while the code's own words never count.
function blankIgnored(text: string): { prose: string; codes: string[] } {
  const lines = normalizeNewlines(text).replace(/[‘’]/g, "'").split('\n')
  const codes: string[] = []
  const kept: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (opener !== null && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null
      kept.push('')
      continue
    }
    if (opener !== null) {
      fence = opener[1]
      kept.push('')
      continue
    }
    if (/^\s*>/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s+\[\s\]/.test(line) || isHeading(line)) {
      kept.push('')
      continue
    }
    const unquoted = line.replace(/`([^`]*)`/g, (_, code: string) => `${codes.push(code) - 1}`)
    kept.push(unquoted.replace(/"[^"]*"|“[^”]*”/g, ' '))
  }
  return { prose: kept.join('\n'), codes }
}

// A heading names a section, it reports nothing: "## Results", or a whole line
// in bold with no sentence end ("**What's working for you**"). A bold closer
// ("**Done**", "**Fixed!**") is still one.
function isHeading(line: string): boolean {
  if (/^\s*#{1,6}\s/.test(line)) return true
  const bold = /^\s*(?:\*\*|__)([^*_]+)(?:\*\*|__)\s*:?\s*$/.exec(line)
  return bold !== null && !/[.!?]\s*$/.test(bold[1]) && !isTerse(bold[1])
}

// Splits after . ! ? (and any closing emphasis or quote: "passes.**") and at newlines.
function sentences(text: string): string[] {
  const found: string[] = []
  for (const line of text.split('\n')) {
    for (const piece of line.split(/(?<=[.!?][*_)"'”’]*)\s+/)) {
      const sentence = piece.replace(/^\s*(?:[-*+]\s+(?:\[[xX]\]\s+)?|\d+[.)]\s+|#+\s+)/, '').trim()
      if (sentence !== '') found.push(sentence)
    }
  }
  return found
}
