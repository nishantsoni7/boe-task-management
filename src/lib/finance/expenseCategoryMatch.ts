// ── Smart suggestion: which category this expense probably belongs to ────────
//
// "Paid 900 to Bharat Petroleum for diesel" → Fuel, because eleven earlier
// expenses whose purpose said diesel or petrol were filed under Fuel.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// THERE IS NO MODEL HERE. No OpenAI, no Anthropic, no Hugging Face, no hosted
// inference of any kind, no API key, no network call, no embedding, no
// telemetry. This file is a few hundred lines of string comparison over rows the
// person can already see, and it runs in their browser. The UI calls it "Smart
// suggestion" and says nothing about artificial intelligence, because nothing
// here is.
//
// It also decides NOTHING. It returns an ordered list of EXISTING categories
// with a short reason each; the form shows them as chips and the person taps one
// or ignores all three. No code path from this file selects a category, creates
// one, or writes anything.
//
// ── WHY IT GETS BETTER ON ITS OWN ───────────────────────────────────────────
//
// Its only training data is the company's own finalized expenses. Every expense
// somebody files teaches it one more association between the words they wrote
// and the category they chose, so the suggestions sharpen as the log grows,
// without anybody maintaining a rule. The keyword map below is a COLD START — it
// carries the first few weeks, when there is no history to learn from — and its
// influence never overrides an existing category that history actually supports.
//
// ── WHAT IT REFUSES TO LEARN FROM ───────────────────────────────────────────
//
// Only FINALIZED, NON-DELETED expenses. A soft-deleted expense was a mistake and
// teaching from it would make the mistake self-perpetuating; an unfinished draft
// is a sentence somebody spoke into a phone and has not yet checked. Callers
// pass rows through `learnableHistory` (or filter equivalently) and this file
// re-applies the rule itself, so a caller that forgets cannot poison it.
//
// ── THE FOUR RULES THE SCORING IS BUILT AROUND ──────────────────────────────
//
//   1. PURPOSE OUTWEIGHS PAYEE, always. "What was this for" is the question a
//      category answers; who received the money is a weaker clue — a hardware
//      shop sells both a welding rod and a kettle. Enforced arithmetically:
//      everything a payee can contribute is capped BELOW what a single shared
//      purpose word is worth. See PAYEE_SCORE_CEILING.
//   2. FREQUENCY IS A TIE-BREAK, NEVER A REASON. The most-used category must not
//      float to the top of an unrelated expense. Frequency is added only to a
//      category that already scored on its own content, and is capped below the
//      suggestion threshold, so it can reorder suggestions but can never create
//      one.
//   3. AN EXISTING CATEGORY BEATS A NEW ONE. A new category is proposed only
//      when NOTHING existing reaches the threshold, and the proposal carries the
//      near-misses with it so the person sees what they nearly matched.
//   4. NOTHING IS CREATED OR SELECTED HERE. A new-category proposal is a name
//      and a reason. Creating it is a separate, deliberate tap in the form.

import {
  categoryKey,
  normalizeCategoryName,
  type ExpenseCategory,
} from './expenses'

// ── Normalizing words ────────────────────────────────────────────────────────

/**
 * Words that carry no signal about what an expense was for.
 *
 * Deliberately SHORT. A stop-word list that grows tends to swallow real terms —
 * "water" and "power" are stop-words in a general corpus and categories here.
 * These are connectives, the filler these sentences are full of, and the
 * transaction verbs that appear in every single remark.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by',
  'with', 'from', 'as', 'is', 'was', 'were', 'be', 'been', 'this', 'that',
  'it', 'its', 'we', 'our', 'us', 'i', 'my', 'me', 'he', 'she', 'they', 'them',
  'paid', 'pay', 'payment', 'payments', 'spent', 'given', 'gave', 'amount',
  'rupees', 'rupee', 'rs', 'inr', 'cash', 'total', 'bill', 'billed',
  'ko', 'ka', 'ke', 'ki', 'liye', 'diya', 'kiya', 'hai', 'tha',
])

/**
 * THE BOE KEYWORD MAP — the cold start, and nothing more.
 *
 * Each entry maps words people here actually write to a CANONICAL CONCEPT. The
 * concept is not a category: it is a bucket that lets "diesel", "petrol" and
 * "HSD" recognise each other, and lets any of them recognise an existing
 * category called Fuel, Diesel, Vehicle Fuel or Fuel & Diesel.
 *
 * ITS ONLY TWO JOBS. (a) Two different words for one thing match each other, in
 * history and in a category name alike. (b) When there is no history at all and
 * nothing existing fits, CANONICAL_NEW_NAME below proposes a sensible broad
 * name instead of a fragment of somebody's sentence.
 *
 * IT NEVER OVERRIDES AN EXISTING CATEGORY. A canonical hit scores exactly like a
 * shared word, so a company that files fuel under "Vehicle Running" keeps being
 * offered Vehicle Running — history outvotes the map as soon as history exists.
 */
const KEYWORD_CANONICAL: Record<string, string> = {
  // Fuel
  diesel: 'fuel', petrol: 'fuel', fuel: 'fuel', hsd: 'fuel', cng: 'fuel',
  lpg: 'fuel', gas: 'fuel', kerosene: 'fuel', oil: 'fuel', pump: 'fuel',
  // Transport
  tempo: 'transport', freight: 'transport', delivery: 'transport',
  transport: 'transport', transportation: 'transport', courier: 'transport',
  cartage: 'transport', carriage: 'transport', truck: 'transport',
  lorry: 'transport', loading: 'transport', unloading: 'transport',
  shipping: 'transport', logistics: 'transport', parcel: 'transport',
  // Factory maintenance
  repair: 'maintenance', repairing: 'maintenance', welding: 'maintenance',
  maintenance: 'maintenance', servicing: 'maintenance', spare: 'maintenance',
  spares: 'maintenance', machine: 'maintenance', machinery: 'maintenance',
  fitting: 'maintenance', grinding: 'maintenance', lathe: 'maintenance',
  breakdown: 'maintenance', overhaul: 'maintenance', bearing: 'maintenance',
  motor: 'maintenance', plumbing: 'maintenance', electrician: 'maintenance',
  wiring: 'maintenance', painting: 'maintenance', carpentry: 'maintenance',
  // Staff refreshments
  tea: 'refreshments', snack: 'refreshments', snacks: 'refreshments',
  lunch: 'refreshments', dinner: 'refreshments', breakfast: 'refreshments',
  food: 'refreshments', refreshment: 'refreshments', canteen: 'refreshments',
  pantry: 'refreshments', biscuit: 'refreshments', biscuits: 'refreshments',
  sweets: 'refreshments', coffee: 'refreshments', samosa: 'refreshments',
  // Travel
  hotel: 'travel', flight: 'travel', taxi: 'travel', cab: 'travel',
  train: 'travel', travel: 'travel', travelling: 'travel', ticket: 'travel',
  lodging: 'travel', boarding: 'travel', fare: 'travel', bus: 'travel',
  toll: 'travel', airfare: 'travel', trip: 'travel', visit: 'travel',
  // Stationery and office
  stationery: 'stationery', printing: 'stationery', print: 'stationery',
  printout: 'stationery', cartridge: 'stationery', toner: 'stationery',
  paper: 'stationery', xerox: 'stationery', photocopy: 'stationery',
  pen: 'stationery', register: 'stationery', file: 'stationery',
  // Labour
  labour: 'labour', labor: 'labour', mazdoor: 'labour', worker: 'labour',
  workers: 'labour', coolie: 'labour', helper: 'labour', wages: 'labour',
  // Utilities
  electricity: 'utilities', power: 'utilities', internet: 'utilities',
  broadband: 'utilities', recharge: 'utilities', mobile: 'utilities',
  telephone: 'utilities', wifi: 'utilities',
  // Packing
  packing: 'packing', packaging: 'packing', carton: 'packing',
  cartons: 'packing', tape: 'packing', wrapping: 'packing',
}

/**
 * The broad, reusable name proposed for a concept when NOTHING existing fits.
 *
 * "Prefer broader reusable categories over narrow one-time categories" is the
 * whole of this table: a concept maps to the name a company would still be using
 * in a year, never to the words of the sentence in front of us.
 */
const CANONICAL_NEW_NAME: Record<string, string> = {
  fuel: 'Fuel',
  transport: 'Transport',
  maintenance: 'Factory Maintenance',
  refreshments: 'Staff Refreshments',
  travel: 'Travel',
  stationery: 'Stationery',
  labour: 'Labour',
  utilities: 'Utilities',
  packing: 'Packing Material',
}

/**
 * One word, reduced to its comparison form.
 *
 * Case and punctuation go, then a tiny, wholly deterministic suffix strip so
 * "repairs" reads as "repair" and "welding" as "weld"… which is exactly why the
 * ORDER matters: the canonical map is consulted on the word BEFORE stemming as
 * well as after, so "welding" resolves through the map rather than through a
 * stem that no entry names.
 *
 * NO STEMMER LIBRARY, AND NO CLEVERNESS. Aggressive stemming collapses words
 * that mean different things ("repair" and "repairing" are the same; "packing"
 * and "packet" are not), and every collapse it gets wrong shows up as a
 * confidently wrong suggestion. Three suffixes, longest first, minimum length
 * guarded.
 */
export function normalizeWord(raw: string): string {
  const word = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  if (word === '') return ''
  const mapped = KEYWORD_CANONICAL[word]
  if (mapped !== undefined) return mapped
  const stem = stemWord(word)
  return KEYWORD_CANONICAL[stem] ?? stem
}

function stemWord(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * A phrase, as the set of comparison words it contributes.
 *
 * A SET, not a list: a remark that says "diesel diesel diesel" is one piece of
 * evidence, not three, and a category must not be pushed up the list by
 * repetition.
 *
 * Pure digits are dropped — an invoice number, a vehicle number or an amount
 * inside a remark says nothing about what the money was for, and matching on one
 * would tie two unrelated expenses together because both mention "2024".
 */
export function phraseTerms(raw: string | null | undefined): Set<string> {
  const terms = new Set<string>()
  if (typeof raw !== 'string') return terms
  for (const piece of raw.split(/[^\p{L}\p{N}]+/u)) {
    if (piece === '') continue
    if (/^\d+$/.test(piece)) continue
    const word = normalizeWord(piece)
    if (word === '' || word.length < 2) continue
    if (STOP_WORDS.has(word) || STOP_WORDS.has(piece.toLowerCase())) continue
    terms.add(word)
  }
  return terms
}

/** The surface words of a phrase, keyed by comparison word, for the reason line. */
function surfaceByTerm(raw: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof raw !== 'string') return map
  for (const piece of raw.split(/[^\p{L}\p{N}]+/u)) {
    if (piece === '') continue
    if (/^\d+$/.test(piece)) continue
    const word = normalizeWord(piece)
    if (word === '' || word.length < 2) continue
    if (STOP_WORDS.has(word) || STOP_WORDS.has(piece.toLowerCase())) continue
    if (!map.has(word)) map.set(word, piece.toLowerCase())
  }
  return map
}

/** A payee, reduced to one comparison key: "Bharat  Petroleum." → "bharat petroleum". */
export function payeeKey(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

// ── What the matcher may learn from ──────────────────────────────────────────

/**
 * One earlier expense, as the matcher reads it.
 *
 * `deleted_at` is part of the SHAPE rather than something the caller is trusted
 * to have filtered: see learnableHistory.
 */
export type ExpenseHistoryEntry = {
  category_id: string
  paid_to: string
  remark: string | null
  deleted_at?: string | null
}

/**
 * The rows the matcher is allowed to learn from.
 *
 * SOFT-DELETED EXPENSES ARE EXCLUDED HERE AND AGAIN INSIDE suggestCategories, so
 * a caller that forgets the filter cannot teach the matcher from a mistake
 * somebody deliberately removed. Drafts never reach this function at all —
 * they live in a different table and are not expenses.
 */
export function learnableHistory(
  rows: readonly ExpenseHistoryEntry[],
): ExpenseHistoryEntry[] {
  return rows.filter(r => r != null && r.deleted_at == null && typeof r.category_id === 'string' && r.category_id !== '')
}

// ── Scores ───────────────────────────────────────────────────────────────────

/**
 * ONE SHARED PURPOSE WORD, and the ceiling on everything a payee can say.
 *
 * The gap between them is the arithmetic form of "purpose outweighs payee": a
 * category supported by a single shared purpose word (6) outranks one supported
 * by the most emphatic possible payee evidence (5), and no amount of payee
 * agreement closes the gap because the payee total is CLAMPED at the ceiling
 * before it is added.
 */
const PURPOSE_TERM_SCORE = 6
const PAYEE_SCORE_CEILING = 5

/** An exact payee match — the same shop, written the same way. */
const PAYEE_EXACT_SCORE = 5
/** A shared word in the payee's name: "Sharma Auto" against "Sharma Traders". */
const PAYEE_TERM_SCORE = 1.5

/** A word shared with the CATEGORY'S OWN NAME, directly or through the map. */
const NAME_TERM_SCORE = 4.5

/** Purpose agreement is capped so one much-used category cannot run away with it. */
const PURPOSE_SCORE_CEILING = 18

/**
 * THE MOST FREQUENCY CAN EVER BE WORTH — and it is deliberately below
 * MIN_SUGGESTION_SCORE, so a category that scored nothing on content cannot be
 * lifted over the threshold by popularity alone. It orders ties; it never
 * creates a suggestion.
 */
const FREQUENCY_SCORE_CEILING = 0.9

/**
 * What a category must reach to be offered at all.
 *
 * 3 sits above a single shared payee word (1.5) and below every real signal: a
 * category-name match (4.5), an exact payee (5), one shared purpose word (6). So
 * "Ramesh" appearing in two payee names is not a suggestion, and one shared word
 * about what the money was for is.
 */
export const MIN_SUGGESTION_SCORE = 3

/** Three at most: a fourth chip is a list, and a list is not a suggestion. */
export const MAX_SUGGESTIONS = 3

// ── The result ───────────────────────────────────────────────────────────────

export type CategorySuggestionReason =
  | 'payee'
  | 'similar_payments'
  | 'keyword'

export type CategorySuggestion = {
  categoryId: string
  categoryName: string
  /** Rounded to 2dp so a test can assert it and a render can key on it. */
  score: number
  reason: CategorySuggestionReason
  /** The words that caused a `keyword` match, lower-cased, at most two. */
  terms: string[]
  /** The sentence shown under the chip. */
  reasonText: string
}

export type NewCategoryProposal = {
  /** The cleaned, broad name — "Fuel", never "Diesel for the Bolero on Tuesday". */
  name: string
  /** Existing categories worth looking at first. Shown ABOVE the proposal. */
  similar: { categoryId: string; categoryName: string }[]
  reasonText: string
}

export type SmartSuggestionResult = {
  /** Existing categories, strongest first, never more than three. */
  suggestions: CategorySuggestion[]
  /**
   * A category that does not exist yet — offered ONLY when `suggestions` is
   * empty. Null the rest of the time, which is most of the time.
   */
  newCategory: NewCategoryProposal | null
}

export const EMPTY_SUGGESTIONS: SmartSuggestionResult = { suggestions: [], newCategory: null }

type Accumulator = {
  purpose: number
  payee: number
  name: number
  purposeTerms: Map<string, string>
  nameTerms: Map<string, string>
  payeeExact: boolean
  count: number
}

/**
 * The suggestions for what is typed so far.
 *
 * PURE, AND CHEAP ENOUGH TO RUN ON EVERY KEYSTROKE. It is O(history × terms)
 * over rows already in memory — the list this screen loaded — with no I/O and no
 * allocation per candidate beyond one accumulator per category.
 *
 * @param input      what the person has typed: the payee and the purpose/remark.
 * @param categories every category, active or retired. Retired ones are dropped
 *                   here: suggesting a category the picker will not offer is a
 *                   dead end.
 * @param history    earlier expenses. Soft-deleted rows are ignored whatever the
 *                   caller passed.
 */
export function suggestCategories(
  input: { paidTo: string; purpose: string },
  categories: readonly ExpenseCategory[],
  history: readonly ExpenseHistoryEntry[],
): SmartSuggestionResult {
  const active = categories.filter(c => c.is_active)
  const byId = new Map(active.map(c => [c.id, c]))

  const purposeSurface = surfaceByTerm(input.purpose)
  const purposeTerms = new Set(purposeSurface.keys())
  const payeeSurface = surfaceByTerm(input.paidTo)
  const payeeTerms = new Set(payeeSurface.keys())
  const paidToKey = payeeKey(input.paidTo)

  // NOTHING TYPED, NOTHING SUGGESTED. An empty form is not a question, and
  // filling it with the three most-used categories is exactly the "most
  // frequently used" failure this is built to avoid.
  if (purposeTerms.size === 0 && payeeTerms.size === 0) return EMPTY_SUGGESTIONS

  const rows = learnableHistory(history)
  const acc = new Map<string, Accumulator>()
  const bump = (id: string): Accumulator => {
    let a = acc.get(id)
    if (!a) {
      a = { purpose: 0, payee: 0, name: 0, purposeTerms: new Map(), nameTerms: new Map(), payeeExact: false, count: 0 }
      acc.set(id, a)
    }
    return a
  }

  // ── 1. The category's OWN NAME, read as words ──
  // "diesel" typed against a category called Fuel matches through the keyword
  // map; "transport" typed against a category called Transport matches
  // directly. This is what carries a company with no history yet.
  for (const category of active) {
    const nameSurface = surfaceByTerm(category.name)
    const a = bump(category.id)
    for (const [term, surface] of nameSurface) {
      if (purposeTerms.has(term)) {
        a.name += NAME_TERM_SCORE
        a.nameTerms.set(term, purposeSurface.get(term) ?? surface)
      }
    }
  }

  // ── 2. History ──
  for (const row of rows) {
    if (!byId.has(row.category_id)) continue
    const a = bump(row.category_id)
    a.count += 1

    // PURPOSE FIRST, and worth the most. Each purpose word this expense shares
    // with an earlier one scores once PER EARLIER EXPENSE, so a category used
    // for eleven diesel payments outranks one used for a single diesel payment.
    const rowPurpose = surfaceByTerm(row.remark)
    for (const [term, surface] of rowPurpose) {
      if (!purposeTerms.has(term)) continue
      a.purpose += PURPOSE_TERM_SCORE
      if (!a.purposeTerms.has(term)) a.purposeTerms.set(term, purposeSurface.get(term) ?? surface)
    }

    // THE PAYEE, second and capped. An exact match is strong evidence — the
    // same shop, filed the same way before — but it is still only about who,
    // not about what.
    const rowPayeeKey = payeeKey(row.paid_to)
    if (paidToKey !== '' && rowPayeeKey === paidToKey) {
      a.payee += PAYEE_EXACT_SCORE
      a.payeeExact = true
    } else if (payeeTerms.size > 0) {
      const rowPayeeTerms = phraseTerms(row.paid_to)
      let shared = 0
      for (const term of payeeTerms) if (rowPayeeTerms.has(term)) shared += 1
      if (shared > 0) a.payee += PAYEE_TERM_SCORE * shared
    }
  }

  // ── 3. Totals ──
  const maxCount = Math.max(1, ...[...acc.values()].map(a => a.count))
  const scored: CategorySuggestion[] = []

  for (const [id, a] of acc) {
    const category = byId.get(id)
    if (!category) continue

    const purpose = Math.min(a.purpose, PURPOSE_SCORE_CEILING)
    // CLAMPED BEFORE IT IS ADDED — this single line is what makes "purpose
    // outweighs payee" true however much payee agreement there is.
    const payee = Math.min(a.payee, PAYEE_SCORE_CEILING)
    const content = purpose + payee + a.name
    if (content <= 0) continue

    // Frequency, last and smallest. Only reachable because `content` is already
    // positive — rule 2 in the header, in one condition.
    const frequency = (a.count / maxCount) * FREQUENCY_SCORE_CEILING
    const score = content + frequency
    if (score < MIN_SUGGESTION_SCORE) continue

    // THE REASON IS THE SIGNAL THAT ACTUALLY DOMINATED, not a fixed sentence.
    // Named words come first when they carry the match, because "Matches
    // 'diesel'" tells somebody why in a way "used for similar payments" cannot.
    let reason: CategorySuggestionReason
    let terms: string[] = []
    if (a.name >= purpose && a.name >= payee && a.nameTerms.size > 0) {
      reason = 'keyword'
      terms = [...a.nameTerms.values()].slice(0, 2)
    } else if (purpose >= payee && purpose > 0) {
      reason = 'similar_payments'
      terms = [...a.purposeTerms.values()].slice(0, 2)
    } else if (a.payeeExact) {
      reason = 'payee'
    } else if (purpose > 0) {
      reason = 'similar_payments'
      terms = [...a.purposeTerms.values()].slice(0, 2)
    } else {
      reason = 'payee'
    }

    scored.push({
      categoryId: id,
      categoryName: category.name,
      score: Math.round(score * 100) / 100,
      reason,
      terms,
      reasonText: suggestionReasonText(reason, terms),
    })
  }

  // Strongest first; ties broken by name so the order is STABLE between renders
  // — a chip that swaps places under somebody's thumb is worse than no chip.
  scored.sort((a, b) =>
    b.score - a.score || a.categoryName.localeCompare(b.categoryName, 'en-IN', { sensitivity: 'base' }))

  const suggestions = scored.slice(0, MAX_SUGGESTIONS)

  return {
    suggestions,
    // RULE 3: a new category is proposed only when nothing existing fits.
    newCategory: suggestions.length > 0
      ? null
      : proposeNewCategory(input, active, purposeSurface, payeeTerms),
  }
}

/** The sentence under a suggestion chip. */
export function suggestionReasonText(
  reason: CategorySuggestionReason,
  terms: readonly string[],
): string {
  if (reason === 'payee') return 'Previously used for this payee'
  if (reason === 'keyword') {
    if (terms.length >= 2) return `Matches “${terms[0]}” and “${terms[1]}”`
    if (terms.length === 1) return `Matches “${terms[0]}”`
    return 'Matches this kind of expense'
  }
  if (terms.length >= 2) return `Used for similar payments — “${terms[0]}”, “${terms[1]}”`
  if (terms.length === 1) return `Used for similar payments — “${terms[0]}”`
  return 'Used for similar payments'
}

// ── Proposing a category that does not exist ─────────────────────────────────

/** A proposed name is a LABEL, not a sentence. Two words, thirty characters. */
export const PROPOSED_NAME_MAX_WORDS = 2
export const PROPOSED_NAME_MAX_LENGTH = 30

/**
 * PAST THIS MANY CONTENT WORDS, THE PURPOSE IS A SENTENCE AND NOTHING IS
 * PROPOSED — including through the keyword map.
 *
 * Found by the test, not by reasoning: "replacement of the main gate hinge near
 * the loading bay entrance" contains the word "loading", which the map reads as
 * Transport, so the map-first branch confidently proposed Transport for a
 * maintenance job. In a short phrase a mapped word IS the subject; in a long
 * sentence it is as likely to be scenery ("the loading bay", "the travel desk",
 * "the tea room"). Six is comfortably above every real phrase this sees —
 * "diesel for the generator at the factory" is five — and below anything that
 * reads as prose.
 */
export const PROPOSAL_SENTENCE_WORD_MAX = 6

/**
 * How close two words must start out to count as a near miss.
 *
 * FOR THE "similar existing categories" LIST ONLY — never for scoring, where an
 * approximate match would produce confidently wrong suggestions. Here the job is
 * the opposite: cast wide enough that somebody about to create "Stationery"
 * beside an existing "Stationary Items" is shown it first. Seven characters of
 * shared opening is loose enough for a misspelling, a plural oddity or a shared
 * root, and tight enough that "Travel" and "Transport" do not pair up.
 */
const NEAR_MISS_PREFIX = 7

/**
 * Words that must never become a category, whatever the sentence looks like.
 *
 * Honorifics and relationship words are how a person is named, and "a category
 * named after a person" is the single most common way an expense log turns into
 * an unusable list of one-off buckets.
 */
const PERSON_MARKERS = new Set([
  'ji', 'sir', 'madam', 'mr', 'mrs', 'ms', 'shri', 'smt', 'bhai', 'bhaiya',
  'uncle', 'aunty', 'saheb', 'sahab', 'kumar', 'singh', 'lal', 'devi',
])

/** Words that describe a document or a figure rather than a purpose. */
const DOCUMENT_MARKERS = new Set([
  'invoice', 'bill', 'receipt', 'voucher', 'challan', 'no', 'number', 'ref',
  'reference', 'gst', 'gstin', 'pan', 'cheque', 'txn', 'utr', 'order',
])

/**
 * A broad, reusable name for an expense nothing existing covers — or null.
 *
 * NULL IS A PERFECTLY GOOD ANSWER, and the common one. When the purpose is a
 * person's name, an invoice number, an amount or a whole sentence with no usable
 * noun in it, this proposes nothing and the person picks a category themselves.
 * A bad proposal is worse than none: somebody in a hurry taps it, and the log
 * grows a category called "Vikram" that will never be used again.
 */
export function proposeNewCategoryName(
  input: { paidTo: string; purpose: string },
): string | null {
  const purpose = typeof input.purpose === 'string' ? input.purpose : ''

  // ── A SENTENCE IS NOT A CATEGORY, AND IS NOT MINED FOR ONE ──
  // Checked before the keyword map, not after it: in prose a mapped word is as
  // likely to be scenery as subject. See PROPOSAL_SENTENCE_WORD_MAX.
  const contentWords = purpose.split(/[^\p{L}\p{N}]+/u).filter(piece => {
    if (piece === '') return false
    const lower = piece.toLowerCase()
    return !STOP_WORDS.has(lower) && !STOP_WORDS.has(normalizeWord(piece))
  })
  if (contentWords.length > PROPOSAL_SENTENCE_WORD_MAX) return null

  // ── THE MAP FIRST, always. It is the only source of a name that is broad by
  // construction: "diesel for the generator" proposes Fuel, not "Diesel
  // Generator", and the same concept proposes the same name every time.
  for (const piece of purpose.split(/[^\p{L}\p{N}]+/u)) {
    if (piece === '') continue
    const canonical = normalizeWord(piece)
    const name = CANONICAL_NEW_NAME[canonical]
    if (name) return name
  }

  // ── Otherwise, the content words of the purpose — at most two.
  // The payee's own words are excluded, so "paid Vikram for Vikram work" cannot
  // produce "Vikram": a category is what the money was for, never who took it.
  const payeeWords = phraseTerms(input.paidTo)
  const candidates: string[] = []
  for (const piece of purpose.split(/[^\p{L}\p{N}]+/u)) {
    if (piece === '') continue
    const lower = piece.toLowerCase()
    // An amount, an invoice number, a date fragment — none is a category.
    if (/\d/.test(lower)) return null
    if (PERSON_MARKERS.has(lower) || DOCUMENT_MARKERS.has(lower)) return null
    const term = normalizeWord(piece)
    if (term === '' || term.length < 3) continue
    if (STOP_WORDS.has(term) || STOP_WORDS.has(lower)) continue
    if (payeeWords.has(term)) continue
    if (candidates.some(c => c.toLowerCase() === lower)) continue
    candidates.push(piece)
    if (candidates.length > PROPOSED_NAME_MAX_WORDS) break
  }

  // MORE CONTENT WORDS THAN A LABEL CAN HOLD MEANS THIS IS A SENTENCE. Taking
  // the first two of "repair of the main gate hinge near the loading bay" would
  // invent a category nobody would ever pick again, so it proposes nothing.
  if (candidates.length === 0 || candidates.length > PROPOSED_NAME_MAX_WORDS) return null

  const name = normalizeCategoryName(
    candidates.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '))
  if (name.length > PROPOSED_NAME_MAX_LENGTH) return null
  return name
}

function proposeNewCategory(
  input: { paidTo: string; purpose: string },
  active: readonly ExpenseCategory[],
  purposeSurface: Map<string, string>,
  payeeTerms: ReadonlySet<string>,
): NewCategoryProposal | null {
  const name = proposeNewCategoryName(input)
  if (name === null) return null

  // ALREADY EXISTS — then it is not new, and proposing it would invite a
  // duplicate the database would refuse anyway. The near-miss list below is
  // what the person should see instead.
  const key = categoryKey(name)
  if (active.some(c => categoryKey(c.name) === key)) return null

  // ── THE NEAR MISSES, SHOWN FIRST ──
  //
  // MATCHED LOOSELY ON PURPOSE, and this is the one place in the file where
  // that is right. An exact word match would find nothing here by construction:
  // a category sharing a word with what was typed scored 4.5 and is already a
  // SUGGESTION, so it never reaches this list. What is left — and what this
  // list exists for — is the category that is nearly the same word: an existing
  // "Stationary Items" when somebody is about to create "Stationery", a
  // "Maintenence" somebody typed once. A wrong guess here costs nothing (it is
  // shown, not chosen) and a missed one costs a duplicate category forever.
  const wanted = new Set<string>([...purposeSurface.keys(), ...phraseTerms(name), ...payeeTerms])
  const nearMiss = (term: string) => {
    for (const w of wanted) {
      if (w === term) return true
      if (term.length >= NEAR_MISS_PREFIX && w.length >= NEAR_MISS_PREFIX
          && term.slice(0, NEAR_MISS_PREFIX) === w.slice(0, NEAR_MISS_PREFIX)) return true
    }
    return false
  }
  const similar = active
    .filter(c => {
      for (const term of phraseTerms(c.name)) if (nearMiss(term)) return true
      return false
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' }))
    .slice(0, 3)
    .map(c => ({ categoryId: c.id, categoryName: c.name }))

  return {
    name,
    similar,
    reasonText: similar.length > 0
      ? 'No existing category matched well. Check the ones below first.'
      : 'No existing category matched this expense.',
  }
}
