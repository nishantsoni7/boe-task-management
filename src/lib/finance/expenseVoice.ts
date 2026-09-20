// ── Turning a spoken sentence into a filled-in expense form ──────────────────
//
// "Paid 850 rupees to Ramesh for diesel by UPI, remark site visit."
//
// WHAT THIS IS. A small, deterministic, entirely offline parser. It reads a
// transcript the BROWSER produced (Web Speech API, feature-detected at the call
// site) and returns the fields it could identify. There is no model here, no
// API key, no network call, no audio: the component hands this function a
// string and throws the recognition result away.
//
// WHAT IT IS EMPHATICALLY NOT. A natural-language system. It recognises a small
// number of sentence shapes that people actually use for this, in English,
// Indian English and the common Hinglish connectors, and it says plainly when it
// could not find something. Widening it is a matter of adding a keyword, not of
// making it cleverer.
//
// ── THE FOUR RULES IT IS BUILT AROUND ───────────────────────────────────────
//
//   1. NOTHING IS EVER INVENTED. A field the sentence does not contain comes
//      back null and the form keeps whatever was already in it. "I could not
//      hear an amount" and "the amount is nothing" must never be the same
//      answer, which is why every field is nullable and none defaults.
//   2. NOTHING IS EVER SAVED. This produces a PATCH for a form somebody then
//      reads and submits themselves. Financial data is confirmed by a person.
//      There is no code path from here to a write.
//   3. AN UNKNOWN CATEGORY IS A SUGGESTION, NEVER A CREATION. resolveVoiceParse
//      matches the spoken words against the categories that exist,
//      case-insensitively; anything else comes back as `suggestedCategory`, for
//      the person to confirm or discard.
//   4. AN UNCLEAR TRANSCRIPT MUST NOT THROW. Every branch below degrades to
//      null. An empty string, a single word, pure punctuation and a sentence in
//      a language this does not know all return an empty parse with notes.
//
// ── HOW IT READS A SENTENCE ─────────────────────────────────────────────────
//
// Words are matched and CONSUMED in a fixed order, most-anchored first, so an
// earlier slot cannot swallow a later one's words:
//
//      remark → payment mode → date → amount → category → paid to
//
// "remark …" takes the rest of the sentence, so it goes first. The mode and the
// date are closed vocabularies, so they are safe to take next. The amount is the
// first number LEFT once any date has gone. The two free-text slots — category
// and paid-to — are read last, from what remains, each bounded by the keywords
// around it, so "to Sharma Ji for factory repair" splits where a reader would
// split it.

import {
  EXPENSE_PAYMENT_MODES,
  type ExpenseCategory,
  type ExpenseFormState,
  type ExpensePaymentMode,
  findCategoryByName,
  normalizeCategoryName,
} from './expenses'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * The phrase somebody actually says, and the mode it means. Multi-word phrases
 * are matched before their own first word, so "credit card" never resolves as
 * the bare "card".
 *
 * PAYTM, GPAY AND PHONEPE ARE UPI. On the expense side these are how a UPI
 * payment is described, not accounts money arrives into — unrelated to
 * finance_payment_requests' `paytm`, which names a BOE cash route.
 */
const MODE_PHRASES: { words: string[]; mode: ExpensePaymentMode }[] = [
  { words: ['credit', 'card'],   mode: 'credit_card' },
  { words: ['debit', 'card'],    mode: 'debit_card' },
  { words: ['bank', 'transfer'], mode: 'bank_transfer' },
  { words: ['net', 'banking'],   mode: 'bank_transfer' },
  { words: ['google', 'pay'],    mode: 'upi' },
  { words: ['phone', 'pay'],     mode: 'upi' },
  { words: ['upi'],              mode: 'upi' },
  { words: ['gpay'],             mode: 'upi' },
  { words: ['phonepe'],          mode: 'upi' },
  { words: ['paytm'],            mode: 'upi' },
  { words: ['neft'],             mode: 'bank_transfer' },
  { words: ['rtgs'],             mode: 'bank_transfer' },
  { words: ['imps'],             mode: 'bank_transfer' },
  { words: ['transfer'],         mode: 'bank_transfer' },
  { words: ['cheque'],           mode: 'cheque' },
  { words: ['check'],            mode: 'cheque' },
  { words: ['cash'],             mode: 'cash' },
  { words: ['nagad'],            mode: 'cash' },
  // Spoken rarely, but it keeps the vocabulary TOTAL: every value the form
  // offers has a spoken form, which the test asserts.
  { words: ['other'],            mode: 'other' },
]

/**
 * "card" ON ITS OWN IS NOT A MODE, AND IS NOT GUESSED.
 *
 * "Paid 2400 by card" does not say credit or debit, and picking one would be
 * inventing a fact about a payment. The phrase is still CONSUMED — so it cannot
 * end up inside the payee's name — and the ambiguity is reported, so the form
 * can ask the one short question instead of silently choosing.
 */
const AMBIGUOUS_MODE_WORDS = new Set(['card'])

/** Words that introduce the mode, and are swallowed with it. */
const MODE_PREPOSITIONS = new Set(['by', 'via', 'through', 'mode', 'using', 'with', 'in', 'se'])

/**
 * Introduces the category.
 *
 * `ke` is here only so "ke liye" (Hinglish "for") is reachable. On its own it is
 * an ordinary particle, so the capture below REQUIRES `liye` to follow it —
 * "Ramesh ke haath" does not start a category.
 */
const CATEGORY_MARKERS = new Set(['category', 'categories', 'for', 'ke'])

/** Introduces the payee. `ko` is the Hinglish "to". */
const PAYEE_MARKERS = new Set(['to', 'ko'])

/** Introduces a free-text remark, which runs to the end of the sentence. */
const REMARK_MARKERS = new Set(['remark', 'remarks', 'note', 'notes', 'narration'])

/**
 * A free-text capture stops when it reaches one of these. Everything that
 * introduces another slot, plus the filler around it.
 *
 * "ji" IS DELIBERATELY ABSENT — "Sharma Ji" is a name, and cutting it would be a
 * rudeness as well as a bug.
 */
const BOUNDARY_WORDS = new Set([
  ...MODE_PREPOSITIONS, ...CATEGORY_MARKERS, ...PAYEE_MARKERS, ...REMARK_MARKERS,
  'paid', 'pay', 'payment', 'spent', 'given', 'gave', 'diya', 'kiya', 'liye',
  'rupees', 'rupee', 'rs', 'inr', 'and', 'today', 'yesterday', 'on', 'dated', 'date',
])

/** Dropped wherever they appear: they carry no field of their own. */
const FILLER_WORDS = new Set(['paid', 'pay', 'payment', 'spent', 'given', 'gave', 'the', 'a', 'an'])

const CURRENCY_WORDS = new Set(['rupees', 'rupee', 'rs', 'rs.', 'inr', '₹'])

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
}

// ── Tokens ───────────────────────────────────────────────────────────────────

type Token = {
  /** The word as spoken, punctuation stripped — this is what a name is built from. */
  text: string
  /** Lower-cased, for every comparison. */
  lower: string
  /** True when the word was followed by , ; . ! or ? — a natural phrase break. */
  breakAfter: boolean
  consumed: boolean
}

function tokenize(transcript: string): Token[] {
  const tokens: Token[] = []
  // Split on whitespace only, so punctuation stays attached and can be read as
  // a phrase break before it is stripped.
  for (const raw of transcript.split(/\s+/)) {
    if (raw === '') continue
    const breakAfter = /[,;.!?]$/.test(raw)
    // Trailing punctuation goes, INCLUDING the full stop — "cash." has to match
    // the word `cash`, and "Rs." has to match `rs`. A decimal amount is safe:
    // "850.50" ends in a digit, and "850." loses only the stop.
    const text = raw.replace(/^[^\p{L}\p{N}₹]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
    if (text === '') continue
    tokens.push({ text, lower: text.toLowerCase(), breakAfter, consumed: false })
  }
  return tokens
}

function consume(tokens: Token[], from: number, to: number): void {
  for (let i = from; i <= to && i < tokens.length; i++) tokens[i].consumed = true
}

// ── Amount ───────────────────────────────────────────────────────────────────

/**
 * The numeric value of a spoken amount token, as the string the form should
 * hold — or null.
 *
 * Grouping commas and a rupee sign are removed because they cannot change the
 * figure; NOTHING ELSE IS. A transcript of "1000.005" comes back as "1000.005"
 * and the form's own validation refuses it and says why, exactly as it would if
 * it had been typed. Voice must not be a route by which an amount is rounded.
 */
export function spokenAmount(word: string): string | null {
  const cleaned = word.replace(/[₹,]/g, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null
  // A leading zero run ("007") is a recognition artefact, not a figure.
  const normalized = cleaned.replace(/^0+(?=\d)/, '')
  return normalized
}

// ── Dates ────────────────────────────────────────────────────────────────────

function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  at.setUTCDate(at.getUTCDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

function iso(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}`
}

/** "12th" → 12, "5" → 5, anything else → null. */
function dayNumber(word: string): number | null {
  const match = /^(\d{1,2})(st|nd|rd|th)?$/.exec(word)
  if (!match) return null
  const n = Number(match[1])
  return n >= 1 && n <= 31 ? n : null
}

/**
 * The date the sentence names, in YYYY-MM-DD — or null when it names none.
 *
 * NULL IS THE COMMON ANSWER AND THE RIGHT ONE. Most of these sentences are
 * spoken about a payment made minutes ago and say no date at all; the form is
 * already on today, and returning today here rather than null would be
 * indistinguishable from the speaker having said "today". Only an explicit
 * mention moves the field.
 *
 * A DATE WITH NO YEAR IS THE MOST RECENT ONE. "on 5 September" in January means
 * last September, not a date eight months in the future: an expense is a thing
 * that has already happened.
 */
function extractDate(tokens: Token[], todayIso: string): string | null {
  const year = Number(todayIso.slice(0, 4))

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].consumed) continue
    const w = tokens[i].lower

    // "day before yesterday"
    if (w === 'day' && tokens[i + 1]?.lower === 'before' && tokens[i + 2]?.lower === 'yesterday') {
      consume(tokens, i, i + 2)
      return shiftDays(todayIso, -2)
    }
    if (w === 'yesterday' || w === 'kal') {
      // "kal" is tomorrow as often as yesterday in speech; it is only read as
      // yesterday when it stands beside a past-tense verb the sentence already
      // uses. Simpler and safer: treat only the unambiguous English word.
      if (w === 'kal') continue
      consume(tokens, i, i)
      return shiftDays(todayIso, -1)
    }
    if (w === 'today' || w === 'aaj') {
      consume(tokens, i, i)
      return todayIso
    }

    // 12/09/2026, 12-9-26, 2026-09-12
    const numeric = /^(\d{1,4})[/-](\d{1,2})[/-](\d{2,4})$/.exec(w)
    if (numeric) {
      const a = Number(numeric[1]), b = Number(numeric[2]), c = Number(numeric[3])
      // A four-digit leading field is a year; otherwise day-month-year, which is
      // how a date is spoken and written in India.
      const [y, m, d] = numeric[1].length === 4
        ? [a, b, c]
        : [c < 100 ? 2000 + c : c, b, a]
      if (isRealDate(y, m, d)) {
        consume(tokens, i, i)
        return iso(y, m, d)
      }
      continue
    }

    // "5 September", "5th September 2026", "September 5"
    const day = dayNumber(w)
    const monthAfter = tokens[i + 1] && !tokens[i + 1].consumed ? MONTHS[tokens[i + 1].lower] : undefined
    if (day !== null && monthAfter !== undefined) {
      const explicitYear = /^\d{4}$/.test(tokens[i + 2]?.lower ?? '') ? Number(tokens[i + 2].lower) : null
      const resolved = resolveDayMonth(day, monthAfter, explicitYear, year, todayIso)
      if (resolved) {
        consume(tokens, i, explicitYear !== null ? i + 2 : i + 1)
        // "on" immediately before the date is filler that belongs to it.
        if (i > 0 && tokens[i - 1].lower === 'on') consume(tokens, i - 1, i - 1)
        return resolved
      }
    }
    const monthHere = MONTHS[w]
    const dayAfter = tokens[i + 1] && !tokens[i + 1].consumed ? dayNumber(tokens[i + 1].lower) : null
    if (monthHere !== undefined && dayAfter !== null) {
      const explicitYear = /^\d{4}$/.test(tokens[i + 2]?.lower ?? '') ? Number(tokens[i + 2].lower) : null
      const resolved = resolveDayMonth(dayAfter, monthHere, explicitYear, year, todayIso)
      if (resolved) {
        consume(tokens, i, explicitYear !== null ? i + 2 : i + 1)
        if (i > 0 && tokens[i - 1].lower === 'on') consume(tokens, i - 1, i - 1)
        return resolved
      }
    }
  }
  return null
}

function resolveDayMonth(
  day: number, month: number, explicitYear: number | null, currentYear: number, todayIso: string,
): string | null {
  if (explicitYear !== null) {
    return isRealDate(explicitYear, month, day) ? iso(explicitYear, month, day) : null
  }
  if (!isRealDate(currentYear, month, day)) return null
  const thisYear = iso(currentYear, month, day)
  if (thisYear <= todayIso) return thisYear
  // Already past in this year → the same date last year.
  return isRealDate(currentYear - 1, month, day) ? iso(currentYear - 1, month, day) : null
}

// ── Free-text capture ────────────────────────────────────────────────────────

/**
 * The words after `start`, up to the first boundary — a consumed token, a
 * keyword belonging to another slot, or a phrase break.
 *
 * Returns the captured text and the last index taken, so the caller can consume
 * exactly what it read and no more.
 */
function captureAfter(tokens: Token[], start: number): { text: string; end: number } | null {
  const words: string[] = []
  let end = start - 1
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.consumed) break
    if (BOUNDARY_WORDS.has(t.lower)) break
    if (FILLER_WORDS.has(t.lower) && words.length === 0) { end = i; continue }
    // A bare number in the middle of a name is the amount, misplaced — stop
    // rather than absorbing a figure into a payee.
    if (words.length === 0 && spokenAmount(t.lower) !== null) break
    words.push(t.text)
    end = i
    if (t.breakAfter) break
    if (words.length >= 8) break
  }
  if (words.length === 0) return null
  return { text: words.join(' '), end }
}

// ── The parse ────────────────────────────────────────────────────────────────

export type ExpenseVoiceParse = {
  /** What was heard, verbatim. Always shown to the person. */
  transcript: string
  /** The amount as text, exactly as spoken. Never rounded here. */
  amount: string | null
  paidTo: string | null
  paymentMode: ExpensePaymentMode | null
  /** The spoken category words, whatever they were. Not yet matched to a row. */
  categoryText: string | null
  /** YYYY-MM-DD, only when the sentence actually named a date. */
  date: string | null
  remark: string | null
  /**
   * Plain-language notes about what the sentence did not settle — an ambiguous
   * "card", most often. Shown beside the transcript; never an error.
   */
  notes: string[]
}

const EMPTY_PARSE = (transcript: string, notes: string[] = []): ExpenseVoiceParse => ({
  transcript, amount: null, paidTo: null, paymentMode: null,
  categoryText: null, date: null, remark: null, notes,
})

/**
 * Read one spoken sentence.
 *
 * `todayIso` is injected rather than read from the clock, so "yesterday" is
 * testable and so it is the READER's local date rather than UTC's.
 *
 * NEVER THROWS. Any input that is not a usable string returns an empty parse.
 */
export function parseExpenseSpeech(transcript: string, todayIso: string): ExpenseVoiceParse {
  if (typeof transcript !== 'string') return EMPTY_PARSE('')
  const trimmed = transcript.trim()
  if (trimmed === '') return EMPTY_PARSE('')

  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return EMPTY_PARSE(trimmed)

  const notes: string[] = []

  // ── 1. Remark: takes the rest of the sentence ──
  let remark: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    if (!REMARK_MARKERS.has(tokens[i].lower)) continue
    const words = tokens.slice(i + 1).filter(t => !t.consumed).map(t => t.text)
    consume(tokens, i, tokens.length - 1)
    const text = words.join(' ').trim()
    remark = text === '' ? null : text
    break
  }

  // ── 2. Payment mode: a closed vocabulary, longest phrase first ──
  let paymentMode: ExpensePaymentMode | null = null
  outer: for (const phrase of MODE_PHRASES) {
    for (let i = 0; i + phrase.words.length <= tokens.length; i++) {
      if (tokens[i].consumed) continue
      let matched = true
      for (let k = 0; k < phrase.words.length; k++) {
        const t = tokens[i + k]
        if (!t || t.consumed || t.lower !== phrase.words[k]) { matched = false; break }
      }
      if (!matched) continue
      paymentMode = phrase.mode
      consume(tokens, i, i + phrase.words.length - 1)
      // The preposition that introduced it belongs to it.
      if (i > 0 && MODE_PREPOSITIONS.has(tokens[i - 1].lower)) consume(tokens, i - 1, i - 1)
      break outer
    }
  }
  if (paymentMode === null) {
    // A bare "card" — consumed so it cannot land in the payee, but never guessed.
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].consumed || !AMBIGUOUS_MODE_WORDS.has(tokens[i].lower)) continue
      consume(tokens, i, i)
      if (i > 0 && MODE_PREPOSITIONS.has(tokens[i - 1].lower)) consume(tokens, i - 1, i - 1)
      notes.push('Heard "card" — choose Credit Card or Debit Card.')
      break
    }
  }

  // ── 3. Date: before the amount, so a date's digits are never read as money ──
  const date = extractDate(tokens, todayIso)

  // ── 4. Amount: the first number left ──
  let amount: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].consumed) continue
    const value = spokenAmount(tokens[i].lower)
    if (value === null) continue
    amount = value
    consume(tokens, i, i)
    // "500 rupees" and "rupees 500" — the currency word goes with the figure.
    if (tokens[i + 1] && !tokens[i + 1].consumed && CURRENCY_WORDS.has(tokens[i + 1].lower)) {
      consume(tokens, i + 1, i + 1)
    } else if (i > 0 && !tokens[i - 1].consumed && CURRENCY_WORDS.has(tokens[i - 1].lower)) {
      consume(tokens, i - 1, i - 1)
    }
    break
  }

  // ── 5. Category, then 6. payee — the two free-text slots, from what is left ──
  let categoryText: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].consumed || !CATEGORY_MARKERS.has(tokens[i].lower)) continue
    // `ke` is a category marker ONLY as the pair "ke liye".
    if (tokens[i].lower === 'ke' && tokens[i + 1]?.lower !== 'liye') continue
    let start = i + 1
    // "category of maintenance", "ke liye diesel"
    if (tokens[start] && !tokens[start].consumed && (tokens[start].lower === 'of' || tokens[start].lower === 'liye')) start += 1
    const captured = captureAfter(tokens, start)
    if (!captured) continue
    categoryText = captured.text
    consume(tokens, i, captured.end)
    break
  }

  let paidTo: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].consumed || !PAYEE_MARKERS.has(tokens[i].lower)) continue
    const captured = captureAfter(tokens, i + 1)
    if (!captured) continue
    paidTo = captured.text
    consume(tokens, i, captured.end)
    break
  }

  return { transcript: trimmed, amount, paidTo, paymentMode, categoryText, date, remark, notes }
}

// ── Resolving a parse against the categories that exist ──────────────────────

export type ExpenseVoiceResult = {
  parsed: ExpenseVoiceParse
  /** Only the fields the sentence actually settled. Applied over the form as-is. */
  patch: Partial<ExpenseFormState>
  /** The existing category the spoken words named, case-insensitively. */
  matchedCategory: ExpenseCategory | null
  /**
   * A category name that does NOT exist yet. Offered for confirmation; nothing
   * here creates it, and the form does not select one until the person says so.
   */
  suggestedCategory: string | null
  /**
   * What the person still has to supply or check, in plain words — the amount,
   * the payee, the category, an ambiguous mode. Rendered as the highlight over
   * the form, and the reason Save is not something this function can reach.
   */
  needsAttention: string[]
}

/**
 * Turn a parse into a form patch, against the categories this person can see.
 *
 * THE PATCH IS SPARSE, DELIBERATELY. A field the sentence did not settle is
 * absent, so applying the patch leaves whatever the form already had — the
 * date's default of today, a mode already chosen, a payee half-typed. Voice
 * ADDS to the form; it never blanks it.
 */
export function resolveVoiceParse(
  parsed: ExpenseVoiceParse,
  categories: readonly ExpenseCategory[],
  form: ExpenseFormState,
): ExpenseVoiceResult {
  const patch: Partial<ExpenseFormState> = {}
  if (parsed.amount !== null) patch.amount = parsed.amount
  if (parsed.paidTo !== null) patch.paidTo = parsed.paidTo
  if (parsed.paymentMode !== null) patch.paymentMode = parsed.paymentMode
  if (parsed.date !== null) patch.expenseDate = parsed.date
  if (parsed.remark !== null) patch.remark = parsed.remark

  let matchedCategory: ExpenseCategory | null = null
  let suggestedCategory: string | null = null
  if (parsed.categoryText !== null) {
    matchedCategory = findCategoryByName(categories, parsed.categoryText)
    if (matchedCategory) patch.categoryId = matchedCategory.id
    else suggestedCategory = normalizeCategoryName(parsed.categoryText)
  }

  // What is still missing, judged against the form AS IT WILL BE once the patch
  // lands — so a field the person had already filled is not reported as absent
  // merely because the sentence did not repeat it.
  const after = { ...form, ...patch }
  const needsAttention: string[] = [...parsed.notes]
  if (after.amount.trim() === '') needsAttention.push('No amount heard — enter it.')
  if (after.paidTo.trim() === '') needsAttention.push('No payee heard — enter who was paid.')
  if (after.categoryId === '') {
    needsAttention.push(suggestedCategory !== null
      ? `"${suggestedCategory}" is not a category yet — add it or pick another.`
      : 'No category heard — choose one.')
  }

  return { parsed, patch, matchedCategory, suggestedCategory, needsAttention }
}

/** The example read out under the microphone, so the shape is learned by using it. */
export const VOICE_EXAMPLE_PHRASE =
  'Paid 850 rupees to Ramesh for diesel by UPI, remark site visit.'

/** Shown when the browser has no speech recognition, or the microphone is refused. */
export const VOICE_UNSUPPORTED_MESSAGE =
  'Voice entry is not available in this browser. Fill the form as usual — everything still works.'
export const VOICE_DENIED_MESSAGE =
  'Microphone access was refused, so voice entry is off. Fill the form as usual — everything still works.'

/** The modes a spoken word can resolve to. Exported for the vocabulary test. */
export const VOICE_MODE_VOCABULARY: readonly string[] =
  MODE_PHRASES.map(p => p.words.join(' '))

/** Every mode in EXPENSE_PAYMENT_MODES is reachable by voice. Asserted in the test. */
export const VOICE_REACHABLE_MODES: ReadonlySet<ExpensePaymentMode> =
  new Set(MODE_PHRASES.map(p => p.mode))

// Referenced so the mode list and the vocabulary cannot drift apart unnoticed:
// the test asserts every value in EXPENSE_PAYMENT_MODES is in VOICE_REACHABLE_MODES.
export const ALL_EXPENSE_MODES: readonly ExpensePaymentMode[] =
  EXPENSE_PAYMENT_MODES.map(m => m.value)
