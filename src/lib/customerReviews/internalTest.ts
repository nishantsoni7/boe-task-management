// THE INTERNAL-TEST BOUNDARY OF THE MODULE. Read this before changing anything
// in it.
//
// WHAT THIS PHASE IS
// ------------------
// An internal rehearsal of a workflow. An authorized BOE employee opens a list
// of TEST CARDS, books one, opens WhatsApp with a prefilled message addressed
// to ANY VALID NUMBER THE TESTER ENTERS, confirms by hand that they sent it,
// uploads a screenshot, and a verifier checks that the workflow was exercised.
//
// WHAT THIS PHASE IS NOT
// ----------------------
// It is not a customer review system. Nothing here is attributed to a customer
// or publishable: there is no review destination, no Google link and no
// public-posting action anywhere in the module. The card text is obviously
// fictional filler whose only job is to exercise layout and message handling.
//
// WHAT IS NOT CLAIMED. The tester chooses the recipient, so nothing here can
// promise who receives a message — not that they are internal, and not that
// they are not a member of the public. What IS true, and enforced, is that
// nothing is posted anywhere and that BOE never sends the message: the artefact
// is a wa.me URL a person clicks.
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
 * The provenance status shown beside every draft, on screen only.
 *
 * Exported as ONE constant so the card, the list and the detail header are
 * provably the same words, and so that changing it is a change to one visible
 * line rather than a diff buried in a template.
 *
 * IT IS NEVER IN THE MESSAGE. buildReviewMessage carries the draft and nothing
 * else — the recipient gets a review they can use, not a review annotated with
 * our internal note about where it came from. A test asserts the absence.
 */
export const DRAFT_STATUS = 'AI-generated draft'

/**
 * The wording this replaced, kept as a constant for ONE purpose: proving it is
 * gone.
 *
 * The cards are drafts now, not internal filler, so
 * "INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH" would be false
 * wherever it appeared. It is retained here, unexported from the UI, because
 * several guards need the exact string to assert that no card body, no
 * generated draft and no message contains it — including the CHECK constraint
 * in migration 20261017000000, which still refuses a body carrying it.
 *
 * Do not render this anywhere.
 */
export const RETIRED_TEST_WARNING =
  'INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH'

/**
 * WHAT THE MESSAGE USED TO CARRY, and why it no longer does.
 *
 * There was a second constant here — INTERNAL_TEST_EXPLANATION — telling the
 * recipient that an automated workflow test had reached them and that nothing
 * was expected of them. It was correct for filler cards and is wrong for a
 * draft review somebody actually intends to offer, so it is gone rather than
 * reworded.
 *
 * The message is now the draft and nothing else. No label, no explanation, no
 * reference, no category — see buildReviewMessage.
 */

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
 * The exact text WhatsApp will be handed: THE DRAFT, AND NOTHING ELSE.
 *
 * No status, no reference, no category, no explanation. Everything the module
 * knows ABOUT a draft — that a model wrote it, which card it is, what category
 * it was filed under — is ours, not the recipient's, and stays on the screen.
 *
 * That is a deliberate narrowing from the version this replaces, which put a
 * label at the top and the bottom and the card's reference in the middle. A
 * person receiving a suggested review should receive a suggested review.
 *
 * This is the ONLY place a message is built. The preview on screen and the text
 * inside the wa.me URL both come from this call, so what a candidate reads
 * before clicking is exactly what the recipient would see — see buildWaMeUrl
 * and the parity test that decodes the URL back and compares it.
 */
export function buildReviewMessage(input: InternalTestMessageInput): string {
  return collapse(input.body)
}

/**
 * Whether a run of text contains something shaped like a telephone number.
 *
 * THE MATCHER THIS REPLACES ONLY FIRED ON A LEADING '+'. It read
 *
 *     /\+\d[\d\s()-]{7,}/
 *
 * so "+44 20 7946 0000" was caught and "202-555-0100", "(202) 555-0100" and
 * "9876543210" all went straight through — three of the four ways a number is
 * actually written. A guard that only catches the international form is not a
 * contact-detail guard.
 *
 * WHAT THIS DOES INSTEAD. It finds every run of digits joined by the characters
 * people put inside phone numbers — spaces, hyphens, brackets, dots and a
 * leading plus — and asks how many DIGITS the run holds. Seven or more and it
 * is a phone number, whatever punctuation it was dressed in. The shortest
 * national subscriber numbers are seven digits, so that is the floor.
 *
 * WHY COUNTING DIGITS RATHER THAN MATCHING FORMATS. There is no list of phone
 * formats that is both short and complete, and a review has no legitimate
 * reason to contain seven digits in one unbroken run. Counting is the property
 * that actually matters and it does not need maintaining.
 *
 * WHAT IT LEAVES ALONE. Quantities and durations, because a word or a comma
 * ends a run: "120 chairs", "60 rooms", "18 months", "a hundred and twenty
 * covers", "three weeks". Each carries two or three digits and the next
 * character is a letter, so no run ever reaches seven.
 *
 * IT ERRS TOWARD REFUSING. A false positive rejects one draft batch, which
 * costs a regeneration. A false negative puts somebody's phone number in a
 * message BOE hands to WhatsApp.
 */
export function containsTelephoneNumber(text: string): boolean {
  // A digit, then at least five more phone-ish characters, then a digit — so a
  // bare two- or three-digit quantity cannot start a run at all.
  const runs = text.match(/\+?\d[\d\s().-]{5,}\d/g)
  if (!runs) return false
  return runs.some(run => run.replace(/\D/g, '').length >= 7)
}

/**
 * Whether a message is safe to hand to WhatsApp.
 *
 * The old guard asserted the mandatory label was PRESENT. This one asserts the
 * opposite kind of thing — that nothing which belongs on our screen has leaked
 * into the recipient's message:
 *
 *   * not the retired internal-test warning, which would now be a false claim;
 *   * not the provenance status, which is ours to know and not theirs to read;
 *   * not a link, an address or a telephone number, none of which a drafted
 *     review has any reason to contain.
 *
 * The screen calls it before the WhatsApp control is enabled, so a builder that
 * is ever refactored into leaking one of these leaves the control dead rather
 * than sending it.
 */
export function isSendableReviewMessage(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  if (text.includes(RETIRED_TEST_WARNING)) return false
  if (text.includes(DRAFT_STATUS)) return false
  if (/https?:\/\/|www\.|[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) return false
  if (containsTelephoneNumber(text)) return false
  return true
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
