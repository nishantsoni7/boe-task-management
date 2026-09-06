// What an administrator asks a batch to be, and the deterministic plan that
// asking turns into.
//
// PURE. No client, no DOM, no environment, no credential. Everything here is a
// function of one object, which is what lets the SCREEN and the ROUTE run the
// same validation and the same arithmetic instead of agreeing by coincidence —
// and it is why every number below is unit-testable without a database, a
// network or a provider.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// A batch used to be twelve reviews described by one paragraph of free text.
// The paragraph is still there and still does the describing; what it could
// never do is say HOW MANY of the batch should be Hinglish, or mention a city,
// or talk about delivery. Asking a model for "about a quarter in Hinglish"
// gets a different quarter every time and no way to check it afterwards. So
// the counts are computed here, from percentages, before the model is called,
// and the model is told which specific drafts carry which attribute.
//
// ── THE ONE ROUNDING RULE ──────────────────────────────────────────────────
//
// percentageToCount() is the only place a percentage becomes a count. Hinglish,
// locations, projects, staff, issues and every perspective share it. Two
// roundings that disagree would put a plan and a validation at odds over a
// single draft, and the batch would be refused after the call had been paid
// for.
//
// ── EVERY STRING IN HERE IS UNTRUSTED ──────────────────────────────────────
//
// City names, project names and staff names are typed by an administrator and
// end up in the user turn of a model request. They are length-capped and
// stripped of the control characters that could break the fence around them,
// exactly as the guidance paragraph is. They are NOT trusted to be safe: the
// output still has to pass validateDrafts().

// ─── The batch size ───────────────────────────────────────────────────────────

/**
 * SIX TO TWENTY, AND THE ADMINISTRATOR PICKS.
 *
 * It was twenty, then eight, then twelve — each time one number for everybody,
 * chosen by whoever last edited a constant. The number that is actually right
 * depends on how much work a candidate is being given this week, and that is
 * not a thing a constant knows.
 *
 * SIX is the floor because the composition still has to be meaningful: a batch
 * of six is four text and two image, and anything smaller stops being a batch
 * and becomes a handful of reviews with a distribution nobody can express as a
 * percentage. TWENTY is the ceiling because it is what one provider call can
 * produce inside its token budget without the reply being cut off mid-array —
 * a truncated reply is invalid JSON and the whole batch is refused after the
 * call has been paid for.
 *
 * TWELVE REMAINS THE DEFAULT, so an administrator who does not care gets
 * exactly what they got before this change.
 *
 * The range is pinned in three places that must agree: these constants, the
 * CHECK on customer_review_draft_batches.card_count, and the count guard inside
 * create_customer_review_draft_batch(). See 20261108000000.
 */
export const MIN_BATCH_SIZE = 6
export const MAX_BATCH_SIZE = 20
export const DEFAULT_BATCH_SIZE = 12

// ─── The percentage engine ────────────────────────────────────────────────────

/**
 * A percentage of a batch, as a whole number of reviews.
 *
 * THE ONLY CONVERSION IN THE MODULE. Every distribution control — language,
 * locations, projects, staff, issues, and each perspective in the review mix —
 * comes through here, so "25%" means the same number of reviews wherever it is
 * asked and a test of this function is a test of all of them.
 *
 * `Math.round` rather than floor or ceil, because the reading of the control is
 * "about this much of the batch" and rounding is what that means: 25% of 12 is
 * 3, 25% of 20 is 5, 40% of 20 is 8. Floor would quietly drop an attribute
 * altogether at small percentages that the administrator plainly asked for, and
 * ceil would over-deliver every one of them at once.
 *
 * THE TWO ENDS ARE EXACT AND THAT IS LOAD-BEARING. 0 is 0 and 100 is the whole
 * batch, at every size, with no rounding involved — a control set to nothing
 * must produce nothing, and a control set to everything must not leave one
 * review out.
 *
 * It is TOTAL rather than trusting: a caller that hands it nonsense gets a
 * number inside the batch rather than an exception, because this runs inside a
 * plan builder that has already validated its input and a second throw site
 * there would only obscure where the bad value came from.
 */
export function percentageToCount(batchSize: number, percentage: number): number {
  if (!Number.isFinite(batchSize) || !Number.isFinite(percentage)) return 0
  const size = Math.max(0, Math.trunc(batchSize))
  if (size === 0) return 0
  const pct = Math.min(100, Math.max(0, percentage))
  const count = Math.round((size * pct) / 100)
  return Math.min(size, Math.max(0, count))
}

/**
 * WHICH drafts carry an attribute, given how many of them do.
 *
 * NOT 1, 2, 3. If every attribute started at the first draft, the first three
 * reviews in every batch would be the Hinglish ones that mention a city and
 * name a staff member, and a reader would see the pattern before they finished
 * the page. The offset moves each attribute to a different starting point and
 * the stride spreads it across the batch.
 *
 * DETERMINISTIC, and deliberately so. There is no randomness here and no seed:
 * the same settings produce the same plan every time, which is what makes the
 * distribution testable and a failed generation reproducible. Spreading is a
 * readability property, not a secrecy one — nobody is guessing these.
 *
 * Returns ascending indexes, 0-based, never longer than the batch.
 */
export function spreadIndexes(batchSize: number, count: number, offset: number): number[] {
  const size = Math.max(0, Math.trunc(batchSize))
  const wanted = Math.min(size, Math.max(0, Math.trunc(count)))
  if (size === 0 || wanted === 0) return []
  if (wanted >= size) return Array.from({ length: size }, (_, i) => i)

  const step = size / wanted
  const start = ((Math.trunc(offset) % size) + size) % size
  const picked = new Set<number>()
  for (let i = 0; i < wanted; i++) {
    let index = Math.floor(start + i * step) % size
    // A collision only happens when two strides land on the same floor, which
    // the walk forward resolves without ever exceeding the batch: `picked` is
    // strictly smaller than `size` on every iteration.
    while (picked.has(index)) index = (index + 1) % size
    picked.add(index)
  }
  return [...picked].sort((a, b) => a - b)
}

// ─── How long a review may be ─────────────────────────────────────────────────

/**
 * WHAT THE DATABASE WILL ACTUALLY STORE. These are the column CHECKs on
 * public.customer_review_test_cards, from 20261017000000:
 *
 *   test_title   length(test_title) <= 120
 *   test_body    length(test_body) between 20 and 900
 *
 * They live here rather than in ./draftGeneration because the form needs them
 * too and this module imports nothing, so there is no cycle to arrange around.
 * draftGeneration re-exports them, which is how every existing caller still
 * reads them from where it always did.
 */
export const MAX_TITLE = 120
export const MAX_BODY = 900

/**
 * THE STORAGE FLOOR AND THE APPLICATION FLOOR ARE NOT THE SAME NUMBER, and a
 * comment in this module used to claim they were.
 *
 * The column admits a 20-character body. validateDrafts() and validateDraftText()
 * refuse anything under 40, because twenty characters is a phrase rather than a
 * review and a batch of them is not worth a verifier's time. That is an
 * APPLICATION JUDGEMENT sitting inside the storage rule, and it is safe in the
 * direction it errs: everything the application accepts, the column accepts.
 */
export const STORAGE_MIN_BODY = 20
export const MIN_BODY = 40

/**
 * WHAT AN ADMINISTRATOR MAY ASK FOR — AND IT IS NOT A CONVERSION.
 *
 * THE HARD RULE IS AND REMAINS `length(test_body) <= 900`. That check lives in
 * the column, and validateDrafts()/validateDraftText() apply the same ceiling
 * before anything is written. Nothing below relaxes it, replaces it or predicts
 * it.
 *
 * THE WORD RANGE IS A TARGET GIVEN TO A LANGUAGE MODEL. Nothing counts the
 * words in a returned draft, and nothing should. So the only job these two
 * numbers have is to stop the form OFFERING a target that is structurally
 * unrealistic under 900 characters — a request for 150-word reviews is a
 * request for drafts that will mostly be refused after the call has been paid
 * for.
 *
 * ── WHY 100, AND WHY NOT 900 ÷ SOMETHING ──────────────────────────────────
 *
 * An earlier version set the ceiling to `floor(900 / 6)` = 150 and called six
 * characters per word the average for English prose. That is roughly true and
 * completely useless here, because an AVERAGE IS NOT A BOUND: half of all
 * drafts sit above it by construction. A 150-word conversational review runs
 * past 900 characters more often than not, so the form was offering a setting
 * that quietly wasted generations.
 *
 * 100 IS A CONSERVATIVE CAP, CHOSEN ONCE, NOT COMPUTED. Conversational Indian
 * English and Hinglish of the kind this module produces runs roughly five to
 * seven characters a word including the following space, and longer once
 * punctuation and the occasional long noun are counted. A hundred words leaves
 * real headroom under 900 even for a draft that runs wordy, which is the
 * property wanted: the ceiling should be comfortably satisfiable, not
 * arithmetically exact. NO CLAIM IS MADE that 100 words is 900 characters, or
 * that a 100-word draft always fits — a draft that overruns is still refused by
 * the checks above, which is the point of having them.
 *
 * TEN IS THE FLOOR for the same kind of reason at the other end: fewer than ten
 * words is a phrase rather than a review, and a ten-word review reliably clears
 * the 40-character application floor without the form having to reason about it.
 *
 * IF EITHER NUMBER NEEDS TO MOVE, move it here, deliberately, with the reason
 * written down — do not re-derive it from a character count.
 */
export const MIN_WORDS_FLOOR = 10
export const MAX_WORDS_CEILING = 100

/**
 * A target length for each draft, spread across the range the administrator set.
 *
 * NOT EVENLY SPACED AND NOT CLUSTERED IN THE MIDDLE, which are the two failures
 * worth naming. Even spacing produces a batch whose lengths climb in a straight
 * line — 45, 52, 59, 66 — and a reader notices that faster than they notice
 * repeated words. Clustering happens on its own: told "between 45 and 110", a
 * model writes almost everything between 70 and 85.
 *
 * The additive golden-ratio sequence below is the standard cheap answer to
 * "spread n points over an interval without a pattern". Successive values are
 * far apart, the set fills the range, and it is completely deterministic — the
 * same batch size gets the same lengths every time, which is what keeps this
 * testable.
 *
 * IT IS A TARGET, NOT A CONTRACT. Nothing validates a draft's word count: the
 * model is asked to aim for these and the length rules that are actually
 * enforced are MIN_BODY and MAX_BODY in characters. A model that writes 62
 * words where 58 was asked for has done nothing wrong.
 */
const GOLDEN = 0.6180339887498949

export function wordTargets(batchSize: number, minWords: number, maxWords: number): number[] {
  const size = Math.max(0, Math.trunc(batchSize))
  const low = Math.min(minWords, maxWords)
  const high = Math.max(minWords, maxWords)
  const span = high - low
  return Array.from({ length: size }, (_, i) => {
    if (span <= 0) return low
    const fraction = (0.5 + (i + 1) * GOLDEN) % 1
    return low + Math.round(fraction * span)
  })
}

// ─── What a batch may be told about ───────────────────────────────────────────

/**
 * The product categories BOE actually makes, as a fixed list.
 *
 * A CONSTANT RATHER THAN A TABLE, and that is a deliberate refusal. These are
 * ten strings that change when the business changes what it manufactures, which
 * is not often and is not a thing anybody administers from a screen. A master
 * table would need a migration, a CRUD surface, a permission, and a policy, to
 * hold a list that a code change edits more safely than a form would.
 *
 * The value is the label. There is no key/label pair because the label is what
 * goes into the prompt and a second identifier would only be a thing to keep in
 * step.
 */
export const BOE_PRODUCT_CATEGORIES = [
  'Dining Chairs',
  'Dining Tables',
  'High Chairs / Bar Chairs',
  'High Tables',
  'Lounge Sofas',
  'Booth Sofas',
  'Outdoor Furniture',
  'Hotel Room Furniture',
  'Lobby Furniture',
  'Customized Hospitality Furniture',
] as const

export type BoeProductCategory = (typeof BOE_PRODUCT_CATEGORIES)[number]

/**
 * The approved facts about the company, for the SYSTEM turn.
 *
 * IN THE SYSTEM TURN BECAUSE THEY ARE NOT USER INPUT. Everything an
 * administrator types goes in the user turn behind a fence and is treated as
 * data; these are the things BOE has already decided are true and safe to say,
 * so they belong with the rules rather than beside the guidance.
 *
 * AND THEY COME WITH A RESTRAINT, which is the more important half. A model
 * handed a paragraph of company facts will put the company facts in every
 * review, and twelve reviews that all mention Jodhpur and a 1.2 lakh sq. ft.
 * factory read as twelve advertisements written by one person — which is
 * exactly what this whole module exists not to produce. The restraint is
 * stated as a rule in buildSystemPrompt(), not as a hope.
 */
export const BOE_COMPANY_FACTS = [
  'The company is Best of Exports, a hospitality furniture manufacturer based in Jodhpur, Rajasthan.',
  'It manufactures in-house in a factory of roughly 1.2 lakh square feet.',
  'It specialises in indoor and outdoor furniture for restaurants, hotels, cafes and resorts.',
  'Its categories are chairs, tables, high chairs, high tables, lounge sofas, booth sofas, outdoor furniture, complete hotel room furniture and lobby furniture.',
  'It works mainly on projects in metro cities and some Tier-2 cities, with a large share of its project volume in South India.',
] as const

// ─── The settings ─────────────────────────────────────────────────────────────

/** The perspectives a review can be written from, and what each one is about. */
export const REVIEW_FOCUSES = ['product', 'customisation', 'service', 'delivery'] as const
export type ReviewFocus = (typeof REVIEW_FOCUSES)[number]

export const REVIEW_FOCUS_META: Record<ReviewFocus, { label: string; brief: string }> = {
  product: {
    label: 'Product',
    brief: 'the furniture itself — how it is built, how it has held up, how it looks and feels in use',
  },
  customisation: {
    label: 'Customisation / Design',
    brief: 'design help, customisation, finishes, dimensions, materials and how the piece was developed',
  },
  service: {
    label: 'Service / Team',
    brief: 'communication, coordination and the help the customer got from people at the company',
  },
  delivery: {
    label: 'Delivery / Execution',
    brief: 'execution of the project, timelines, packing, dispatch and delivery coordination',
  },
}

/** One named person a review may legitimately refer to. */
export type StaffReference = { name: string; role: string }

/**
 * Everything the generation form collects, after validation.
 *
 * PERCENTAGES, NOT COUNTS, and that is the whole reason this survives a
 * variable batch size. "Three Hinglish reviews" is a correct instruction for a
 * batch of twelve and a nonsense one for a batch of six; "25% Hinglish" is
 * correct for both and the arithmetic is done in one place.
 */
export type GenerationSettings = {
  batchSize: number
  minWords: number
  maxWords: number
  /** 0–100. English is the remainder and is never stored separately. */
  hinglishPct: number
  locations: string[]
  locationPct: number
  projects: string[]
  projectPct: number
  products: string[]
  staff: StaffReference[]
  staffPct: number
  /**
   * The real issue-and-resolution story, if there is one. EMPTY MEANS THERE IS
   * NONE, and an empty one forces issuePct to zero — a generated complaint is a
   * fabricated customer experience, which is the one thing this module must
   * never produce.
   */
  issueContext: string
  issuePct: number
  /** Perspective shares. They do NOT have to total 100: a review can cover two. */
  focusPct: Record<ReviewFocus, number>
  /** The employee this lot is intended for. Context and a prefill; NOT an assignment. */
  intendedFor: string | null
}

export const MAX_LOCATIONS = 4
export const MAX_PROJECTS = 2
export const MAX_STAFF = 12
export const MAX_REFERENCE_NAME = 60
export const MAX_ISSUE_CONTEXT = 600

/**
 * WHAT THE FORM STARTS ON — AND EVERY VALUE IS THE OLD BEHAVIOUR, NOT A GUESS.
 *
 * A previous version of this file opened on 25% Hinglish and a Product 40 /
 * Customisation 25 / Service 20 / Delivery 15 mix. Nobody at BOE decided those
 * numbers; they were invented to make the form look populated, and an invented
 * default is worse than a blank one because it silently becomes the house style
 * of every batch anybody generates without thinking about it.
 *
 * The rule applied here: A DEFAULT MUST EITHER REPRODUCE THE BEHAVIOUR THAT
 * ALREADY EXISTED OR BE NEUTRAL. Each one below says which it is.
 *
 *   batchSize    12 — REPRODUCES. The fixed size every batch had before the
 *                count became a choice.
 *   minWords/    the full derived span — REPRODUCES. There was no word control;
 *   maxWords     the model was told the character limits and asked to vary the
 *                length. The full span is that, expressed in the new control,
 *                and it leaves the admin to narrow it deliberately.
 *   hinglishPct  0 — NEUTRAL. No Hinglish was ever requested, so asking for
 *                some is an opt-in.
 *   focusPct     all 0 — NEUTRAL. With nothing selected the prompt asks for a
 *                spread of subjects, which is what the old prompt asked for.
 *                Any non-zero value here is a distribution somebody chose.
 *   everything   0 or empty — NEUTRAL, and load-bearing for the factual rules:
 *   else         a location, project, staff or issue percentage above zero is
 *                meaningless without the facts to go with it, and is refused.
 */
export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  batchSize: DEFAULT_BATCH_SIZE,
  minWords: MIN_WORDS_FLOOR,
  maxWords: MAX_WORDS_CEILING,
  hinglishPct: 0,
  locations: [],
  locationPct: 0,
  projects: [],
  projectPct: 0,
  products: [],
  staff: [],
  staffPct: 0,
  issueContext: '',
  issuePct: 0,
  focusPct: { product: 0, customisation: 0, service: 0, delivery: 0 },
  intendedFor: null,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One short reference name, made safe to sit inside a fenced prompt block.
 *
 * NEWLINES AND CONTROL CHARACTERS ARE REMOVED rather than rejected. A city name
 * with a stray line break in it is a paste, not an attack, and refusing the
 * whole form over one would be unkind; a name that spans lines could however
 * carry a forged `--- END ---` marker, and collapsing it to one line is what
 * takes that away. What remains is still data, still fenced, and still only
 * reaches a model that has the rules in its system turn.
 */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function cleanList(raw: unknown, limit: number): { ok: true; list: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, list: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'That list could not be read.' }
  const list: string[] = []
  for (const item of raw) {
    const name = cleanName(item)
    if (!name) continue
    if (name.length > MAX_REFERENCE_NAME) {
      return { ok: false, error: `A name is limited to ${MAX_REFERENCE_NAME} characters.` }
    }
    // Case-insensitive, because "Chennai" and "chennai" are one place and
    // sending both would spend a slot in the plan on a duplicate.
    if (!list.some(existing => existing.toLowerCase() === name.toLowerCase())) list.push(name)
  }
  if (list.length > limit) {
    return { ok: false, error: `At most ${limit} may be supplied.` }
  }
  return { ok: true, list }
}

function readPercentage(raw: unknown, what: string): { ok: true; value: number } | { ok: false; error: string } {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100) {
    return { ok: false, error: `${what} must be a whole number between 0 and 100.` }
  }
  return { ok: true, value }
}

export type SettingsCheck =
  | { ok: true; settings: GenerationSettings }
  | { ok: false; error: string }

/**
 * The generation form, validated. THE SERVER RUNS THIS; the screen runs it too.
 *
 * THE SCREEN RUNNING IT IS A CONVENIENCE AND NOTHING MORE. The route calls this
 * on the request body before it claims anything, spends anything or writes
 * anything, and the database checks the batch size and the composition a second
 * time inside create_customer_review_draft_batch(). A caller who posts straight
 * to the route with a batch size of 500 is refused here; one who gets past a
 * hypothetical bug here is refused by the CHECK.
 *
 * THE COMBINATION RULES ARE THE POINT. "40% of reviews mention a location" with
 * no location supplied is not a small mistake to round down to zero — it is an
 * instruction to invent city names, which is the exact failure mode this module
 * is built to prevent. Each one is refused with a sentence naming the field.
 */
export function validateGenerationSettings(raw: unknown): SettingsCheck {
  const body = (raw ?? {}) as Record<string, unknown>

  // ── Batch size ────────────────────────────────────────────────────────────
  const size = typeof body.batchSize === 'number' ? body.batchSize : Number(body.batchSize)
  if (!Number.isFinite(size) || !Number.isInteger(size) || size < MIN_BATCH_SIZE || size > MAX_BATCH_SIZE) {
    return { ok: false, error: `Choose between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE} reviews.` }
  }

  // ── Length ────────────────────────────────────────────────────────────────
  const minWords = typeof body.minWords === 'number' ? body.minWords : Number(body.minWords)
  const maxWords = typeof body.maxWords === 'number' ? body.maxWords : Number(body.maxWords)
  for (const [value, label] of [[minWords, 'Minimum words'], [maxWords, 'Maximum words']] as const) {
    if (!Number.isFinite(value) || !Number.isInteger(value)
      || value < MIN_WORDS_FLOOR || value > MAX_WORDS_CEILING) {
      return {
        ok: false,
        error: `${label} must be a whole number between ${MIN_WORDS_FLOOR} and ${MAX_WORDS_CEILING}.`,
      }
    }
  }
  if (minWords > maxWords) {
    return { ok: false, error: 'Minimum words cannot be more than maximum words.' }
  }

  // ── Language ──────────────────────────────────────────────────────────────
  const hinglish = readPercentage(body.hinglishPct, 'Hinglish %')
  if (!hinglish.ok) return hinglish

  // ── Locations ─────────────────────────────────────────────────────────────
  const locations = cleanList(body.locations, MAX_LOCATIONS)
  if (!locations.ok) return { ok: false, error: `Locations: ${locations.error}` }
  const locationPct = readPercentage(body.locationPct, 'Reviews mentioning location %')
  if (!locationPct.ok) return locationPct
  if (locationPct.value > 0 && locations.list.length === 0) {
    return { ok: false, error: 'Add at least one city before asking for reviews that mention a location.' }
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  const projects = cleanList(body.projects, MAX_PROJECTS)
  if (!projects.ok) return { ok: false, error: `Projects: ${projects.error}` }
  const projectPct = readPercentage(body.projectPct, 'Reviews mentioning project %')
  if (!projectPct.ok) return projectPct
  if (projectPct.value > 0 && projects.list.length === 0) {
    return { ok: false, error: 'Add at least one project name before asking for reviews that mention a project.' }
  }

  // ── Products ──────────────────────────────────────────────────────────────
  //
  // AN UNKNOWN PRODUCT IS REFUSED RATHER THAN PASSED THROUGH. The list is the
  // one place a free-text field would let an administrator put an arbitrary
  // sentence into the factual half of the prompt, so it is a closed set.
  const products = cleanList(body.products, BOE_PRODUCT_CATEGORIES.length)
  if (!products.ok) return { ok: false, error: `Products: ${products.error}` }
  for (const product of products.list) {
    if (!(BOE_PRODUCT_CATEGORIES as readonly string[]).includes(product)) {
      return { ok: false, error: 'That is not one of the BOE product categories.' }
    }
  }

  // ── Staff ─────────────────────────────────────────────────────────────────
  const staff: StaffReference[] = []
  const rawStaff = body.staff
  if (rawStaff !== undefined && rawStaff !== null) {
    if (!Array.isArray(rawStaff)) return { ok: false, error: 'The team member list could not be read.' }
    for (const item of rawStaff) {
      const entry = (item ?? {}) as Record<string, unknown>
      const name = cleanName(entry.name)
      if (!name) continue
      const role = cleanName(entry.role)
      if (name.length > MAX_REFERENCE_NAME || role.length > MAX_REFERENCE_NAME) {
        return { ok: false, error: `A team member's name and role are limited to ${MAX_REFERENCE_NAME} characters.` }
      }
      if (!staff.some(existing => existing.name.toLowerCase() === name.toLowerCase())) {
        staff.push({ name, role })
      }
    }
    if (staff.length > MAX_STAFF) {
      return { ok: false, error: `At most ${MAX_STAFF} team members may be selected.` }
    }
  }
  const staffPct = readPercentage(body.staffPct, 'Staff mention %')
  if (!staffPct.ok) return staffPct
  if (staffPct.value > 0 && staff.length === 0) {
    return { ok: false, error: 'Select at least one team member before asking for reviews that mention one.' }
  }

  // ── The issue story ───────────────────────────────────────────────────────
  const issueContext = typeof body.issueContext === 'string' ? body.issueContext.trim() : ''
  if (issueContext.length > MAX_ISSUE_CONTEXT) {
    return { ok: false, error: `The issue and resolution notes are limited to ${MAX_ISSUE_CONTEXT} characters.` }
  }
  const issuePct = readPercentage(body.issuePct, 'Issue resolved %')
  if (!issuePct.ok) return issuePct
  if (issuePct.value > 0 && !issueContext) {
    return {
      ok: false,
      error: 'Describe the real issue and how it was resolved, or set Issue resolved to 0. A complaint is never invented.',
    }
  }

  // ── The mix ───────────────────────────────────────────────────────────────
  const rawFocus = (body.focusPct ?? {}) as Record<string, unknown>
  const focusPct = {} as Record<ReviewFocus, number>
  for (const focus of REVIEW_FOCUSES) {
    const checked = readPercentage(rawFocus[focus] ?? 0, `${REVIEW_FOCUS_META[focus].label} %`)
    if (!checked.ok) return checked
    focusPct[focus] = checked.value
  }

  // ── The intended candidate ────────────────────────────────────────────────
  //
  // A UUID OR NOTHING, AND IT AUTHORIZES NOTHING. It is stored on the batch so
  // the assignment step can offer the right name, and the database checks that
  // the person can actually use the module before it accepts one. No policy
  // reads it: a candidate sees a review because `assigned_to` names them, which
  // only assign_customer_review_batch() ever writes.
  let intendedFor: string | null = null
  if (typeof body.intendedFor === 'string' && body.intendedFor) {
    if (!UUID_RE.test(body.intendedFor)) {
      return { ok: false, error: 'That candidate could not be read.' }
    }
    intendedFor = body.intendedFor
  }

  return {
    ok: true,
    settings: {
      batchSize: size,
      minWords,
      maxWords,
      hinglishPct: hinglish.value,
      locations: locations.list,
      locationPct: locationPct.value,
      projects: projects.list,
      projectPct: projectPct.value,
      products: products.list,
      staff,
      staffPct: staffPct.value,
      issueContext,
      issuePct: issuePct.value,
      focusPct,
      intendedFor,
    },
  }
}

// ─── The plan ─────────────────────────────────────────────────────────────────

/** What one draft in the batch has been asked to be. */
export type PlannedReview = {
  /** 1-based, because it is what the prompt calls the draft. */
  position: number
  language: 'english' | 'hinglish'
  words: number
  /**
   * EVERY PERSPECTIVE THIS DRAFT COVERS — none, one, or several.
   *
   * It was a single exclusive `focus` with a 'general' fallback, and that was
   * wrong. The five perspective controls are INDEPENDENT distributions, not
   * slices of one pie: Product 70%, Customisation 60% and Service 50% of a
   * batch of twenty is 14, 12 and 10 reviews, which is 36 assignments across
   * 20 drafts and is exactly what the administrator asked for. An exclusive
   * field could not represent that, so it quietly dropped whichever
   * perspective arrived second — the requested count silently became smaller
   * than the requested percentage.
   */
  focuses: ReviewFocus[]
  location: string | null
  project: string | null
  staff: StaffReference | null
  issue: boolean
}

/**
 * Turn the settings into a per-draft instruction sheet, before anything is sent.
 *
 * WHY A PLAN AND NOT JUST PERCENTAGES IN THE PROMPT. "Make about a quarter of
 * them Hinglish" produces a different quarter each time, and no way to tell
 * afterwards whether it happened. Naming the drafts — "3, 7 and 11 are the
 * Hinglish ones" — is an instruction a model can follow exactly and a reader
 * can check.
 *
 * OFFSETS ARE FIXED AND DISTINCT so that the attributes do not pile onto the
 * same drafts. Hinglish starts at 0, locations at 2, projects at 5, staff at 1,
 * issues at 3 — arbitrary, deterministic, and enough that the Hinglish reviews
 * are not automatically the ones naming a city.
 *
 * A DRAFT MAY CARRY SEVERAL ATTRIBUTES, and that is intended: a real review
 * that mentions a city, names the person who helped and talks about delivery is
 * one review, not three. NOTHING HERE IS EXCLUSIVE — including the
 * perspectives, which each get their own independent spread.
 *
 * EVERY REQUESTED COUNT IS DELIVERED IN FULL. Each attribute is placed by its
 * own call to spreadIndexes() over the whole batch, so a perspective never
 * loses a draft because another perspective got there first. Overlap is the
 * expected outcome once the percentages add past 100, and overlap is what an
 * independent distribution means.
 *
 * THE VALUES CYCLE. Four cities across five location slots means one city
 * appears twice, which is right — cities are not required to be used equally
 * and forcing them to be would be a pattern of its own.
 */
export function buildGenerationPlan(settings: GenerationSettings): PlannedReview[] {
  const size = settings.batchSize
  const words = wordTargets(size, settings.minWords, settings.maxWords)

  const hinglish = new Set(spreadIndexes(size, percentageToCount(size, settings.hinglishPct), 0))
  const withStaff = spreadIndexes(size, settings.staff.length ? percentageToCount(size, settings.staffPct) : 0, 1)
  const withLocation = spreadIndexes(size, settings.locations.length ? percentageToCount(size, settings.locationPct) : 0, 2)
  const withIssue = new Set(spreadIndexes(size, settings.issueContext ? percentageToCount(size, settings.issuePct) : 0, 3))
  const withProject = spreadIndexes(size, settings.projects.length ? percentageToCount(size, settings.projectPct) : 0, 5)

  const locationAt = new Map<number, string>()
  withLocation.forEach((index, n) => locationAt.set(index, settings.locations[n % settings.locations.length]))
  const projectAt = new Map<number, string>()
  withProject.forEach((index, n) => projectAt.set(index, settings.projects[n % settings.projects.length]))
  const staffAt = new Map<number, StaffReference>()
  withStaff.forEach((index, n) => staffAt.set(index, settings.staff[n % settings.staff.length]))

  // ── THE PERSPECTIVES, EACH SPREAD INDEPENDENTLY ──────────────────────────
  //
  // NO FIRST-WINS AND NO NORMALISATION. Each perspective is placed across the
  // whole batch by its own spread, so each realises exactly
  // percentageToCount(size, pct) drafts whatever the others asked for. Where
  // two spreads land on the same draft, that draft covers both subjects — a
  // review that talks about the finish AND the delivery is one review.
  //
  // THE OFFSETS ARE CONSECUTIVE, and that is the arrangement that survives the
  // arithmetic rather than the one that looks most spread out.
  //
  // A stride of `size / count` has only `floor(stride)` distinct phases: six of
  // twelve steps by two, so there are exactly TWO possible selections — the odd
  // drafts and the even ones — and no choice of offsets produces four. An
  // earlier version used offsets 1, 4, 7, 10, which look well separated and in
  // that case put Product and Service on the identical six drafts, because both
  // offsets are odd. Consecutive offsets guarantee the achievable property
  // instead: ADJACENT PERSPECTIVES ALWAYS DIFFER, so two controls used together
  // never collapse onto one set of drafts.
  //
  // They start at 7 to stay clear of the offsets the other attributes use
  // above, so a perspective does not automatically land on the Hinglish drafts.
  const focusesAt = new Map<number, ReviewFocus[]>()
  REVIEW_FOCUSES.forEach((focus, n) => {
    for (const index of spreadIndexes(size, percentageToCount(size, settings.focusPct[focus]), 7 + n)) {
      const already = focusesAt.get(index)
      if (already) already.push(focus)
      else focusesAt.set(index, [focus])
    }
  })

  return Array.from({ length: size }, (_, i) => ({
    position: i + 1,
    language: hinglish.has(i) ? ('hinglish' as const) : ('english' as const),
    words: words[i],
    // A COPY, so a caller that sorts or pushes cannot reach back into the plan.
    focuses: [...(focusesAt.get(i) ?? [])],
    location: locationAt.get(i) ?? null,
    project: projectAt.get(i) ?? null,
    staff: staffAt.get(i) ?? null,
    issue: withIssue.has(i),
  }))
}

/**
 * The counts a plan actually realised, for the screen and for the tests.
 *
 * `focus` COUNTS SUM TO MORE THAN THE BATCH when the perspective percentages
 * add past 100, and that is the correct answer rather than a bug to clamp: they
 * are five independent distributions over the same drafts.
 */
export type PlanTotals = {
  hinglish: number
  english: number
  location: number
  project: number
  staff: number
  issue: number
  focus: Record<ReviewFocus, number>
}

export function planTotals(plan: readonly PlannedReview[]): PlanTotals {
  const focus = {} as Record<ReviewFocus, number>
  for (const name of REVIEW_FOCUSES) {
    focus[name] = plan.filter(p => p.focuses.includes(name)).length
  }
  return {
    hinglish: plan.filter(p => p.language === 'hinglish').length,
    english: plan.filter(p => p.language === 'english').length,
    location: plan.filter(p => p.location !== null).length,
    project: plan.filter(p => p.project !== null).length,
    staff: plan.filter(p => p.staff !== null).length,
    issue: plan.filter(p => p.issue).length,
    focus,
  }
}
