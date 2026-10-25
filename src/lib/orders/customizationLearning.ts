// ── Customize image learns from approved rules and examples (Phase 1) ────────
//
// Nothing here retrains a model. An admin writes HOUSE RULES and approves
// EXAMPLES (a customization and the correct instruction for it) on the
// Learning page; every Check understanding is given all active rules and the
// few approved examples most like the request in hand. Tables:
// 20270420000000 (pi_customization_attempts / _rules / _examples).
//
// No React, no network: every rule is a function a test can pin.

import type { EffectivePermission } from '@/lib/permissions/types'

export const LEARNING_ACTION = 'train_customize_image'
export const LEARNING_PATH = '/orders/customize-learning'

/** At most this many rules and examples go into one Check understanding. */
export const MAX_RULES_IN_PROMPT = 40
export const MAX_EXAMPLES_IN_PROMPT = 3
export const MAX_KEYWORDS = 20

/**
 * Whether to SHOW the Learning link. It authorizes nothing: every Learning
 * route asks can_train_customize_image() of the database, as the person.
 */
export function canTrainCustomizeImage(role: string | null, orders: readonly EffectivePermission[]): boolean {
  if (role === 'admin') return true
  return orders.some(p => p.actionKey === LEARNING_ACTION && p.allowed)
}

// ── Finding similar requests ─────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'into', 'onto', 'instead', 'that', 'this', 'than', 'then', 'them', 'they',
  'should', 'would', 'could', 'will', 'want', 'wants', 'need', 'needs', 'make', 'made', 'keep', 'same', 'like',
  'also', 'only', 'just', 'very', 'more', 'less', 'all', 'any', 'one', 'two', 'but', 'not', 'are', 'was', 'has',
  'have', 'its', 'our', 'per', 'via', 'please', 'client', 'customer', 'required', 'change', 'changed', 'new',
  'hai', 'chahiye', 'kar', 'karna', 'wala', 'wali', 'aur', 'mein',
])

/** Lower-case content words of a text, singular, de-duplicated, in first-seen order. */
export function keywordsFrom(...texts: string[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || /^\d+$/.test(raw) || STOP_WORDS.has(raw)) continue
      const word = raw.length > 4 && raw.endsWith('es') && !raw.endsWith('ses') ? raw.slice(0, -2)
        : raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1)
        : raw
      if (STOP_WORDS.has(word)) continue
      seen.add(word)
      if (seen.size >= MAX_KEYWORDS) return [...seen]
    }
  }
  return [...seen]
}

/** Cleans keywords an admin typed (comma or space separated). */
export function normaliseKeywords(raw: string | readonly string[]): string[] {
  const text = Array.isArray(raw) ? raw.join(' ') : String(raw)
  return keywordsFrom(text.replace(/,/g, ' '))
}

export type LearningRule = { id: string; rule_text: string }
export type LearningExample = {
  id: string
  comment: string
  instruction: string
  product_name: string | null
  pi_dimensions: string | null
  keywords: readonly string[]
  created_at: string
}

/**
 * The approved examples most like this request: most shared keywords first,
 * newest first among equals. An example sharing no keyword is never chosen —
 * an unrelated example would only mislead.
 */
export function rankExamples<E extends LearningExample>(examples: readonly E[], requestKeywords: readonly string[], limit = MAX_EXAMPLES_IN_PROMPT): E[] {
  const wanted = new Set(requestKeywords)
  return examples
    .map(e => ({ e, score: e.keywords.filter(k => wanted.has(k)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.created_at.localeCompare(a.e.created_at))
    .slice(0, limit)
    .map(x => x.e)
}

/**
 * What is added to the Check understanding request. Empty when there is
 * nothing to add, so a database without the learning tables behaves exactly
 * as before.
 */
export function buildLearningContext(rules: readonly LearningRule[], examples: readonly LearningExample[]): string {
  const parts: string[] = []
  const r = rules.slice(0, MAX_RULES_IN_PROMPT)
  if (r.length > 0) {
    parts.push([
      'Company rules (follow them unless the salesperson clearly asks otherwise):',
      ...r.map((rule, i) => `${i + 1}. ${rule.rule_text.trim()}`),
    ].join('\n'))
  }
  const ex = examples.slice(0, MAX_EXAMPLES_IN_PROMPT)
  if (ex.length > 0) {
    parts.push([
      'Approved examples of similar requests (the instruction shown is what the company confirmed as correct):',
      ...ex.map((e, i) => [
        `Example ${i + 1}.`,
        e.product_name?.trim() ? `Product: ${e.product_name.trim()}.` : '',
        e.pi_dimensions?.trim() ? `PI size: ${e.pi_dimensions.trim()}.` : '',
        `Salesperson wrote: "${e.comment.trim()}"`,
        `Correct instruction: "${e.instruction.trim()}"`,
      ].filter(Boolean).join(' ')),
    ].join('\n'))
  }
  return parts.join('\n\n')
}

// ── What happened to an attempt ──────────────────────────────────────────────

/** What the salesperson's panel reports after Check understanding. */
export type AttemptEvent = 'used' | 'discarded' | 'refined' | 'correct' | 'wrong'
export const ATTEMPT_EVENTS: readonly AttemptEvent[] = ['used', 'discarded', 'refined', 'correct', 'wrong']

export const MAX_FEEDBACK_NOTE = 1000

/** The columns an event changes. 👍/👎 set feedback; the rest set the outcome. */
export function attemptPatchFor(event: AttemptEvent, note: string, now: string): Record<string, unknown> {
  if (event === 'correct' || event === 'wrong') {
    const n = note.trim().slice(0, MAX_FEEDBACK_NOTE)
    return { feedback: event, feedback_note: n === '' ? null : n, feedback_at: now, updated_at: now }
  }
  return { outcome: event, updated_at: now }
}

// ── Examples: where their pictures live ──────────────────────────────────────

/** The copy an example owns, so it outlives the PI it came from (matches the table's check). */
export function examplePicturePath(exampleId: string, which: 'before' | 'after', ext: 'jpg' | 'png' | 'webp'): string {
  return `customize-learning/examples/${exampleId.toLowerCase()}/${which}.${ext}`
}

export const RULE_MIN = 5
export const RULE_MAX = 500

export function ruleTextProblem(text: unknown): string | null {
  if (typeof text !== 'string') return 'Write the rule.'
  const n = text.trim().length
  if (n < RULE_MIN) return 'A rule needs at least a few words.'
  if (n > RULE_MAX) return `Keep a rule to ${RULE_MAX} characters or fewer.`
  return null
}
