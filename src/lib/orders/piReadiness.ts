/**
 * IS THIS PI READY — asked once, in one place, for every surface that asks it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Manual testing hit this: a workbook imported without a client name, a PI
 * detail screen showing "Not provided", and then a dead end — no payment could
 * be added, because add_pi_submission_payment refuses with
 * ORDER_SUBMISSION_NO_CLIENT. The reader was told one thing was wrong, fixed
 * nothing (there was no way to), and could not proceed.
 *
 * Two separate problems sat behind that. This module addresses the second.
 *
 *   1. There was no way to supply the missing value. That needs an editor, and
 *      an editor needs a server-side write path with its own authority rules.
 *   2. Each surface discovered missing data on its own, one field at a time, at
 *      the moment of refusal. Submitting told you about the client name; fixing
 *      that told you about a product line; fixing that told you about an image.
 *      Every round trip is a fresh disappointment, and no screen could say what
 *      the whole remaining distance was.
 *
 * So: ONE answer, computed from data the caller already has, listing everything
 * missing at once. Every surface reads the same list, which is what stops them
 * disagreeing about whether a record is ready.
 *
 * ── WHAT IS AND IS NOT REQUIRED ───────────────────────────────────────────
 *
 * Every requirement below is DERIVED FROM AN EXISTING DATABASE GATE, and each
 * one names the gate it mirrors. Nothing here invents a requirement:
 *
 *   client name        add_pi_submission_payment  -> ORDER_SUBMISSION_NO_CLIENT
 *                      submit_pi_for_review       -> ORDER_SUBMISSION_INCOMPLETE
 *   workbook           submit_pi_for_review       -> ORDER_SUBMISSION_INCOMPLETE
 *   product lines      submit_pi_for_review       -> ORDER_SUBMISSION_INCOMPLETE
 *   line completeness  submit_pi_for_review       -> ORDER_SUBMISSION_INCOMPLETE
 *   parse issues       submit_pi_for_review       -> ORDER_SUBMISSION_BLOCKED
 *
 * and, from 20261225000000, the six things a PI must say about itself before
 * it is finalized — every one of them re-derived by
 * assert_order_submission_finalizable, which submit_pi_for_review runs first:
 *
 *   creation date      assert_order_submission_finalizable -> ORDER_SUBMISSION_INCOMPLETE
 *   salesperson        assert_order_submission_finalizable -> ORDER_SUBMISSION_INCOMPLETE
 *   salesperson phone  assert_order_submission_finalizable -> ORDER_SUBMISSION_INCOMPLETE
 *   client city        assert_order_submission_finalizable -> ORDER_SUBMISSION_INCOMPLETE
 *   fabric answer      assert_order_submission_finalizable -> ORDER_SUBMISSION_INCOMPLETE
 *   commercial terms   assert_order_submission_finalizable -> ORDER_SUBMISSION_INCOMPLETE
 *
 * THIS IS NOT THE ENFORCEMENT and must never be mistaken for it. The database
 * re-derives every one of these under a row lock. What this buys is that the
 * reader learns the whole list before they start, instead of one item per
 * refusal.
 *
 * Optional fields are NOT listed. The CLIENT's phone number, either GST
 * number, the full billing and shipping addresses, the ship-to party and the
 * billing percentage are all legitimately absent, and a screen that nags about
 * them teaches people to ignore it.
 *
 * THE CONTACT NUMBER MOVED SIDES, and it is worth saying why rather than
 * leaving the change to look like a reversal. order_submissions.contact_number
 * is the BOE-side number the workbook carries at G22, beside the BOE GST at
 * B22 — it is the SALESPERSON's number, not the client's, and a PI is sent out
 * with it printed on. The client's own numbers are bill_to_phone and
 * ship_to_phone, and those stay optional exactly as they were.
 */

/** What a surface is about to do, which decides how much has to be true. */
export type PiReadinessPurpose = 'payment' | 'submission'

/**
 * THE COMMERCIAL FIELDS, CLASSIFIED — read from the parser, not assumed.
 *
 * This lives here rather than in an editor because it is the answer to a
 * question every surface asks: which of these numbers did a human supply, and
 * which did something compute?
 *
 * The classification is not a judgement call. src/lib/pi/masterSheetParser.ts
 * shows exactly what BOE does with each figure, and it is not what one would
 * guess: MOST OF THESE TOTALS ARE READ FROM NAMED WORKBOOK CELLS, not derived.
 * `subtotal_after_discount` comes from I116, `total_before_gst` from I120,
 * `grand_total` from I122. The parser derives only two things —
 * `grossProductAmount` as the sum of the line totals, and `expectedSubtotal` as
 * gross minus discount — and when its arithmetic disagrees with the workbook's
 * figure it raises a WARNING and keeps the workbook's. The workbook computes;
 * BOE transcribes and flags disagreement.
 *
 * That is why `derivable` is a smaller set than `derived`. A figure can be
 * something no human should type AND something BOE has never known how to
 * compute — `total_before_gst` is exactly that, because the relationship
 * between the subtotal, fabric, packing and transport lives in a spreadsheet
 * formula this system has never read, and transport is as often the words "as
 * applicable" as it is a number.
 */
export const PI_COMMERCIAL_FIELDS = {
  /** Direct human inputs. Safe to edit; nothing else depends on how they arose. */
  input: [
    'discount_amount',
    'fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text',
    'packing_cost', 'packing_cost_meaning', 'packing_cost_text',
    'transportation_amount', 'transportation_text',
  ],
  /** Never a text box. Calculated or transcribed, and owned elsewhere. */
  derived: [
    'gross_product_amount',
    'subtotal_after_discount',
    'total_before_gst',
    'gst_amount',
    'grand_total',
  ],
  /**
   * The subset of `derived` whose arithmetic THIS SYSTEM actually knows,
   * because the parser already computes it to check the workbook against.
   * Anything in `derived` but not here cannot be recomputed without inventing
   * arithmetic BOE has never had.
   */
  derivable: [
    'gross_product_amount',    // Σ line totals, or Σ quantity × rate
    'subtotal_after_discount', // gross − discount
  ],
} as const

/**
 * There is NO GST RATE anywhere in this system.
 *
 * Not a column, not a parser field, not a constant. `gst_amount` is read from a
 * cell as an amount. So "the GST rate, if it is truly configurable" has an
 * answer: it is not configurable, because it does not exist as an input.
 */
export const PI_HAS_CONFIGURABLE_GST_RATE = false

/** One thing that is missing, and where the reader goes to supply it. */
export type PiRequirement = {
  /** Stable key — for tests and for the editor to focus the right section. */
  key: string
  /** What is missing, in the reader's words. */
  label: string
  /**
   * Which editor section supplies it, so "Add client details" can open at the
   * right place instead of at the top of a long form.
   */
  section: 'client' | 'terms' | 'schedule' | 'products' | 'workbook'
  /**
   * True when no editor can fix this — the workbook itself has to be corrected
   * and re-imported. Telling somebody to edit a field that no form owns is
   * worse than telling them nothing.
   */
  needsReimport?: boolean
}

export type PiReadiness = {
  ready: boolean
  missing: readonly PiRequirement[]
  /** One sentence naming the whole remaining distance, not just its first step. */
  summary: string | null
}

/**
 * The subset of a PI this module reads. Deliberately small.
 *
 * The six finalization columns are OPTIONAL properties, so a caller that
 * legitimately holds fewer — the payment surface, which asks only about the
 * client name — still type-checks. An ABSENT property means "not known here"
 * and is never reported as missing; only a property that IS present and blank
 * is. Anything else would have the payment card inventing requirements out of
 * columns it never read.
 */
export type PiReadinessSource = {
  client_name: string | null
  source_workbook_path: string | null
  parse_blocking_issues?: unknown
  creation_date?: string | null
  source_created_by?: string | null
  contact_number?: string | null
  client_city?: string | null
  fabric_responsibility?: string | null
  commercial_terms_note?: string | null
}

/** The subset of a product line this module reads. */
export type PiReadinessItem = {
  item_sequence?: number | null
  product_name?: string | null
  hasRepresentativeImage?: boolean
}

const blank = (v: string | null | undefined) => (v ?? '').trim() === ''

export const PI_CLIENT_NAME_REQUIREMENT: PiRequirement = {
  key: 'client_name',
  label: 'Client name',
  section: 'client',
}

/**
 * WHAT A PI MUST SAY ABOUT ITSELF BEFORE IT IS FINALIZED (20261225000000).
 *
 * In the order the form shows them, so somebody clearing them one at a time
 * moves down the page rather than around it. Each names the section that can
 * supply it, so "Add details" opens where the field actually is rather than at
 * the top of a long form.
 *
 * NONE OF THESE NEEDS A RE-IMPORT, and that is the whole reason they are here
 * rather than among the parse issues. Every one is an ordinary editable column;
 * the workbook is where they usually come from, not the only place they can.
 */
export const PI_FINALIZATION_REQUIREMENTS: readonly PiRequirement[] = [
  { key: 'creation_date',         label: 'Date of creation',           section: 'terms'  },
  { key: 'source_created_by',     label: 'Salesperson',                section: 'terms'  },
  { key: 'contact_number',        label: 'Salesperson contact number', section: 'client' },
  PI_CLIENT_NAME_REQUIREMENT,
  { key: 'client_city',           label: 'Client city',                section: 'client' },
  { key: 'fabric_responsibility', label: 'Fabric responsibility',      section: 'terms'  },
  { key: 'commercial_terms_note', label: 'Commercial terms',           section: 'terms'  },
]

/**
 * The whole answer, for one purpose.
 *
 * `items` is optional because the payment surface does not read product lines
 * and should not be made to fetch them just to ask this question. Passing
 * `undefined` means "not known here", and no line-level requirement is
 * reported — silence rather than a guess.
 */
export function piReadiness(
  purpose: PiReadinessPurpose,
  submission: PiReadinessSource,
  items?: readonly PiReadinessItem[],
): PiReadiness {
  const missing: PiRequirement[] = []

  // ── The client name. The ONLY requirement both purposes share, and the one
  //    that produced the dead end: money cannot be attributed to a PI that does
  //    not say whose it is.
  if (blank(submission.client_name)) missing.push(PI_CLIENT_NAME_REQUIREMENT)

  if (purpose === 'submission') {
    // ── The six a finalized PI must say about itself ──
    //
    // Read in the requirement list's own order, and the client name is skipped
    // here because it was already added above for BOTH purposes — listing it
    // twice would print it twice.
    //
    // A field is missing only when the caller PASSED it and it is empty. An
    // absent property is silence, not a gap; see PiReadinessSource.
    for (const requirement of PI_FINALIZATION_REQUIREMENTS) {
      if (requirement.key === 'client_name') continue
      const value = submission[requirement.key as keyof PiReadinessSource]
      if (value === undefined) continue
      // fabric_responsibility is the one that is refused for being NULL rather
      // than for being empty, and blank() answers both the same way: a record
      // nobody has answered carries null, and null is blank.
      if (blank(value as string | null)) missing.push(requirement)
    }

    if (blank(submission.source_workbook_path)) {
      missing.push({
        key: 'source_workbook',
        label: 'The uploaded PI workbook',
        section: 'workbook',
        needsReimport: true,
      })
    }

    // Parse issues are the workbook's, not a field's. No editor can clear them
    // and it would be dishonest to offer one.
    const issues = Array.isArray(submission.parse_blocking_issues)
      ? submission.parse_blocking_issues.length
      : 0
    if (issues > 0) {
      missing.push({
        key: 'parse_blocking_issues',
        label: issues === 1
          ? '1 problem in the workbook that must be corrected and re-imported'
          : `${issues} problems in the workbook that must be corrected and re-imported`,
        section: 'workbook',
        needsReimport: true,
      })
    }

    if (items !== undefined) {
      if (items.length === 0) {
        missing.push({ key: 'products', label: 'At least one product line', section: 'products' })
      } else {
        // COUNTED, NOT LISTED. Eleven lines each missing an image is one
        // sentence a reader can act on; eleven sentences is a wall.
        const incomplete = items.filter(i =>
          i.item_sequence == null
          || blank(i.product_name)
          || i.hasRepresentativeImage === false).length
        if (incomplete > 0) {
          missing.push({
            key: 'product_lines_incomplete',
            label: incomplete === 1
              ? '1 product line is missing a sequence, a name or its representative image'
              : `${incomplete} product lines are missing a sequence, a name or their representative image`,
            section: 'products',
          })
        }
      }
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    summary: missing.length === 0 ? null : summarize(purpose, missing),
  }
}

function summarize(purpose: PiReadinessPurpose, missing: readonly PiRequirement[]): string {
  const what = purpose === 'payment'
    ? 'Before a payment can be added'
    : 'Before this PI can be submitted'
  if (missing.length === 1) return `${what}, ${lowerFirst(missing[0].label)} is needed.`
  return `${what}, ${missing.length} things are needed.`
}

const lowerFirst = (s: string) => (s === '' ? s : s[0].toLowerCase() + s.slice(1))

/**
 * True when the reader can be offered a direct way to fix this, rather than
 * only being told what is wrong.
 *
 * A list where every entry says "correct the workbook and import it again" is
 * a list with no action on it, and a button offering to edit those fields
 * would be a lie.
 */
export function piReadinessIsEditable(readiness: PiReadiness): boolean {
  return readiness.missing.length > 0
    && readiness.missing.some(r => !r.needsReimport)
}

/** Which editor section to open first — the first one a form can actually fix. */
export function piReadinessFirstSection(readiness: PiReadiness): PiRequirement['section'] | null {
  return readiness.missing.find(r => !r.needsReimport)?.section ?? null
}
