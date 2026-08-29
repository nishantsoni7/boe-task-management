// THE INTERNAL-TEST BOUNDARY OF THE MODULE. Read this before changing anything
// in it.
//
// WHAT THIS PHASE IS
// ------------------
// An internal rehearsal of a workflow. An authorized BOE employee opens a list
// of TEST CARDS, books one, opens WhatsApp with a prefilled message addressed
// to a BOE TEAM NUMBER, confirms by hand that they sent it, uploads a
// screenshot, and an administrator verifies that the workflow was exercised.
//
// WHAT THIS PHASE IS NOT
// ----------------------
// It is not a customer review system. Nothing here is addressed to a customer,
// attributed to a customer, or publishable. There is no review destination, no
// Google link, no public-posting action, and no path by which any of this
// reaches a member of the public. The card text is obviously fictional filler
// whose only job is to exercise layout and message handling.
//
// THE LABEL
// ---------
// Every card and every message carries INTERNAL_TEST_WARNING, and the employee
// cannot remove it. That is not a promise made by a comment; it is a property
// of the shape of this module:
//
//   * The warning is a CONSTANT here. It is not a column, so there is no row to
//     edit and no value to omit.
//   * buildInternalTestMessage() puts it first, always. It is not a parameter,
//     so no caller can decline it.
//   * Card text is not authored by employees at all. It arrives from a
//     fixture, and `authenticated` holds no INSERT and no UPDATE privilege on
//     any content column of customer_review_test_cards (migration
//     20261017000000 §9). There is no form, no API and no RPC through which an
//     employee can supply or alter a single character of it.
//
// So the only text an employee can influence is none of it, and the warning is
// prepended by this file to whatever the card says.

/**
 * The label that must appear on every card and at the start of every message.
 *
 * Exported as ONE constant so the card, the preview, the wa.me text and the
 * tests are provably the same string, and so that changing it is a change to
 * one visible line rather than a diff buried in a template.
 *
 * MIRRORED IN SQL by public.customer_review_internal_test_warning() in
 * supabase/migrations/20261017000000_customer_review_outreach.sql, and the two
 * are pinned to each other by a source-contract test
 * (internalTest.test.ts → "the SQL constant is the same string").
 */
export const INTERNAL_TEST_WARNING =
  'INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH'

/**
 * The second line of every message: what the recipient should do with it.
 *
 * Separate from the warning because they answer different questions — the
 * warning says what this is NOT, and this says what it IS. Anyone who gets one
 * of these on their phone should be able to tell in one glance that a system
 * test reached them and that nothing is expected of them.
 *
 * IT NO LONGER CLAIMS WHO THE RECIPIENT IS. An earlier version said the message
 * had been "sent to a BOE internal team number", which was true while the
 * recipient came from an allowlist and stopped being true the moment a tester
 * could type any number. A message that tells its reader something false about
 * themselves is exactly the kind of claim this module refuses to make, so it now
 * describes only what BOE can vouch for: where the message came from, and that
 * a person sent it deliberately.
 */
export const INTERNAL_TEST_EXPLANATION =
  'This is an automated workflow test, sent deliberately by a member of BOE ' +
  'staff from an internal test system. It is not from a customer, it describes ' +
  'nothing real, and it must not be forwarded, quoted or published anywhere.'

export type InternalTestMessageInput = {
  /** The fixture's short title for this card. */
  title: string
  /** The fixture's generic, visibly fictional test scenario. */
  body: string
  /** The category key, shown so a tester can tell which card they are on. */
  categoryLabel: string
  /** The card's id, so a screenshot can be matched back to a record. */
  reference: string
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * The exact text WhatsApp will be handed.
 *
 * THE WARNING IS THE FIRST THING IN IT, and it is not optional. There is no
 * parameter that suppresses it, no branch that omits it, and no caller-supplied
 * prefix that could push it below the fold of a notification preview.
 *
 * This is the ONLY place a message is built. The preview on screen and the text
 * inside the wa.me URL both come from this call, so what a tester reads before
 * clicking is what the recipient would see — see buildWaMeUrl and the parity
 * test that decodes the URL back and compares it to this string.
 */
export function buildInternalTestMessage(input: InternalTestMessageInput): string {
  return [
    INTERNAL_TEST_WARNING,
    '',
    INTERNAL_TEST_EXPLANATION,
    '',
    `Test card: ${collapse(input.categoryLabel)} — ${collapse(input.title)}`,
    `Reference: ${collapse(input.reference)}`,
    '',
    collapse(input.body),
    '',
    INTERNAL_TEST_WARNING,
  ].join('\n')
}

/**
 * Whether a message still carries the mandatory label, at the very start and
 * again at the end.
 *
 * A belt to buildInternalTestMessage's braces. The screen calls it before the
 * WhatsApp control is enabled, so that if the builder is ever refactored into
 * producing something without the label, the control goes dead rather than the
 * label quietly going away.
 */
export function hasInternalTestWarning(message: string): boolean {
  return message.startsWith(INTERNAL_TEST_WARNING) && message.trimEnd().endsWith(INTERNAL_TEST_WARNING)
}

/**
 * The wa.me address that opens WhatsApp with the test message prefilled.
 *
 * `phoneDigits` is digits only, no '+', which is what wa.me expects. The one
 * caller passes the `digits` that normalizeWhatsAppNumber returned, so the
 * value has already been validated as a whole international number — this
 * function does not re-check it and must never be handed raw input.
 *
 * OPENING THIS URL SENDS NOTHING. It hands the message to WhatsApp with the
 * chat open and the text in the input box; a person still has to press send.
 * Nothing in this module infers a send from an open, and the two are recorded
 * by two different calls for exactly that reason.
 *
 * NOTHING HERE CALLS WHATSAPP. There is no WhatsApp Business API client in this
 * repository, no token, and no server-side send path. This function returns a
 * string.
 */
export function buildWaMeUrl(phoneDigits: string, message: string): string {
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`
}

/**
 * The message a wa.me URL actually carries, for verification.
 *
 * Used by the parity tests — and available to anyone checking by hand — so "the
 * preview matches what WhatsApp would show" is something that can be proved by
 * INSPECTING the URL rather than by navigating to it. No test in this module
 * opens WhatsApp.
 */
export function messageFromWaMeUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'wa.me') return null
    return parsed.searchParams.get('text')
  } catch {
    return null
  }
}

/** The phone digits a wa.me URL addresses, for the same reason. */
export function phoneFromWaMeUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'wa.me') return null
    const digits = parsed.pathname.replace(/^\//, '')
    return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null
  } catch {
    return null
  }
}
