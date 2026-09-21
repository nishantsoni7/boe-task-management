// WHAT A PI SAYS ABOUT ITSELF AS A COMMERCIAL DOCUMENT — said once, here.
//
// Two facts, both introduced by migration 20261225000000, both stored on
// order_submissions, and both printed on a document a client is sent:
//
//   fabric_responsibility  who provides the fabric on this order
//   commercial_terms_note  what the quoted prices do and do not include
//
// WHY ONE MODULE AND NOT TWO. They are the same kind of thing and they are read
// by the same four surfaces — the draft screen, the edit dialog, the readiness
// check and the confirmed PDF. A constant that four callers each spell for
// themselves is a constant that will be spelled four ways, and the one place it
// would show up is on the document.
//
// NOTHING HERE READS A FIGURE, and nothing here decides authority. The database
// owns both — update_order_submission_pi_terms re-derives who may write, and
// assert_order_submission_finalizable re-derives what must be present. What
// this module owns is the WORDS.

// ── Fabric responsibility ─────────────────────────────────────────────────────

/**
 * THE THREE ANSWERS, AND WHY NULL IS NOT A FOURTH.
 *
 * `null` on the record means NOBODY HAS BEEN ASKED. It is not an option a
 * person can choose and it is never offered as one: it is the state a PI is in
 * before somebody answers, and it is what the finalization gate refuses.
 *
 * `not_selected` is the opposite — a deliberate "we have not decided yet, and
 * the PI should say so". It is a real answer, it prints in words, and it does
 * NOT block submission. Collapsing the two into one value would have made the
 * system unable to tell "unanswered" from "answered: still open", and the whole
 * point of asking is to know which of those is true.
 */
export const FABRIC_RESPONSIBILITY_OPTIONS = [
  {
    value: 'not_selected',
    label: 'Fabric not selected yet',
    /** What the PI prints. A STATUS, never a commitment by either party. */
    statement: 'Fabric not selected yet.',
    help: 'The fabric is still being decided. The PI will say so, and neither party is stated as providing it.',
  },
  {
    value: 'boe',
    label: 'Fabric will be provided by BOE',
    statement: 'Fabric will be provided by BOE.',
    help: 'BOE sources the fabric. The fabric cost on this PI is what is charged for it.',
  },
  {
    value: 'client',
    label: 'Fabric will be provided by client',
    statement: 'Fabric will be provided by client.',
    help: 'The client supplies the fabric. The PI must not read as though BOE will source it.',
  },
] as const

export type FabricResponsibility = typeof FABRIC_RESPONSIBILITY_OPTIONS[number]['value']

export function isFabricResponsibility(value: unknown): value is FabricResponsibility {
  return typeof value === 'string'
    && FABRIC_RESPONSIBILITY_OPTIONS.some(o => o.value === value)
}

/** The heading the selection sits under, beside the fabric cost. Said once. */
export const FABRIC_RESPONSIBILITY_LABEL = 'Fabric responsibility'

/** What a PI with nobody's answer on it reads as, on screen and only on screen. */
export const FABRIC_RESPONSIBILITY_UNANSWERED = 'Not chosen yet'

/**
 * What the PI states about the fabric, in one sentence.
 *
 * NULL COMES BACK AS NULL, never as a sentence. A record nobody has answered
 * must not acquire a statement here — printing "Fabric not selected yet" for it
 * would put a deliberate answer on a document where none was given, which is
 * exactly the assumption the column has no default in order to avoid. The
 * caller decides how to show an absent answer; on the draft screen that is
 * FABRIC_RESPONSIBILITY_UNANSWERED beside a control, and a PI in that state
 * cannot be submitted at all, so it never reaches a generated document.
 */
export function fabricResponsibilityStatement(
  value: string | null | undefined,
): string | null {
  if (!isFabricResponsibility(value)) return null
  return FABRIC_RESPONSIBILITY_OPTIONS.find(o => o.value === value)!.statement
}

/** The short label for the chosen answer, or null when there is none. */
export function fabricResponsibilityLabel(
  value: string | null | undefined,
): string | null {
  if (!isFabricResponsibility(value)) return null
  return FABRIC_RESPONSIBILITY_OPTIONS.find(o => o.value === value)!.label
}

/**
 * Does moving to this answer need the reader to confirm first?
 *
 * ONLY WHEN THERE IS A FIGURE TO CONTRADICT. Saying the client provides the
 * fabric while the PI carries a fabric CHARGE is not necessarily wrong — a
 * workbook can bill a handling line on client-supplied cloth — but it is the
 * one combination somebody is likely to have arrived at by accident, and it is
 * the one that misreads worst on a document.
 *
 * SO IT ASKS; IT DOES NOT ACT. Nothing in this system deletes a fabric figure
 * when the answer changes — update_order_submission_pi_terms does not assign
 * fabric_cost at all, and a migration assertion holds it to that. The figure
 * the workbook stated stays stated, and correcting it is its own deliberate
 * act through the workbook.
 */
export function fabricResponsibilityNeedsConfirmation(input: {
  next: string | null
  /** The stored fabric cost, if the PI carries a positive one. */
  fabricCost: number | null
}): boolean {
  return input.next === 'client'
    && input.fabricCost !== null
    && Number.isFinite(input.fabricCost)
    && input.fabricCost > 0
}

export const FABRIC_RESPONSIBILITY_KEEPS_FIGURES =
  'The fabric cost already on this PI is not changed or removed by this choice. '
  + 'Correct the figure in the workbook if it should not be charged.'

// ── The commercial terms note ─────────────────────────────────────────────────

/**
 * THE STANDARD BOE WORDING.
 *
 * Duplicated, on purpose, in the DEFAULT of order_submissions.
 * commercial_terms_note — that default is what puts the sentence on a new draft
 * without any code having to remember to, and this constant is what the screen
 * shows as "the standard wording" when offering to restore it. A test reads the
 * migration and asserts the two are the same string, so the duplication cannot
 * drift.
 *
 * IT IS A STARTING POINT, NOT A RULE. Individual client agreements do include
 * fabric, packing or transportation, so the stored value is editable and an
 * edited one is never overwritten — not by a re-upload, not by a PI change, not
 * by regenerating the documents. See the migration header.
 */
export const BOE_STANDARD_COMMERCIAL_TERMS =
  'Given prices are ex-factory. Fabric, packaging and GST, if not quoted, will be extra as applicable.'

export const COMMERCIAL_TERMS_LABEL = 'Commercial terms'

/** What an empty terms note reads as on screen. Never printed on a document. */
export const COMMERCIAL_TERMS_ABSENT = 'Not stated'

/** At most this many characters — the limit update_order_submission_pi_terms holds. */
export const COMMERCIAL_TERMS_MAX_LENGTH = 2000

/** The stored wording, trimmed, or null when the record carries none. */
export function commercialTermsNote(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  return text === '' ? null : text
}

/** True when the record still carries exactly the standard wording. */
export function isStandardCommercialTerms(value: string | null | undefined): boolean {
  return commercialTermsNote(value) === BOE_STANDARD_COMMERCIAL_TERMS
}
