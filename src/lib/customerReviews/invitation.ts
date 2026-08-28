// The invitation itself.
//
// THIS FILE IS THE ETHICAL BOUNDARY OF THE MODULE. Read it before changing it.
//
// What BOE is doing here is asking a real customer, whose work BOE actually
// did, whether they would like to say what they thought. That is a legitimate
// thing to ask. It stops being legitimate the moment the asking starts steering
// the answer — so the message is assembled here, from a fixed shape, and the
// employee is given exactly two places to type.
//
// WHAT THE EMPLOYEE MAY CHANGE
//   greetingName       who to address. A person's name, a company's name, or
//                      the name they are known by.
//   projectReference   a factual reminder of which job this was. "your
//                      restaurant seating order", "the hotel lobby chairs".
//
// WHAT THE EMPLOYEE MAY NOT CHANGE, AND WHY IT IS NOT A FIELD
//   The closing two sentences. They are the part that makes this an invitation
//   rather than a solicitation: they say that negative feedback is welcome and
//   that the wording and the rating belong to the customer. A free-text message
//   editor would let those be deleted — quietly, one request at a time, by
//   whoever was in a hurry — which is precisely why there is no message_body
//   column in the database and no message_body field in the form. The
//   structured fields ARE the restriction.
//
// WHAT NOTHING HERE DOES
//   * It does not write a review, draft one, or suggest wording for one.
//   * It does not ask for five stars, a good review, a positive review, or a
//     rating of any kind.
//   * It does not praise BOE, make a claim about BOE, or put words in the
//     customer's mouth.
//   * It does not carry the internal note. The note is not a parameter of
//     buildInvitationMessage, so there is no code path that could leak it —
//     that is enforced by the shape of the function, not by remembering.
//
// If a future change adds a parameter to this function, the question to ask is
// "could an employee use this to steer the answer?" If yes, it does not belong
// here.

/**
 * The two sentences the employee cannot remove.
 *
 * Exported as a constant so the tests, the preview and the wa.me text are
 * provably the same string, and so that a change to them is a change to ONE
 * visible line of code rather than a diff buried in a template.
 */
export const NEUTRAL_FEEDBACK_SENTENCE =
  'Your feedback, whether positive, neutral or critical, is welcome and helps us improve.'

export const CUSTOMER_CHOICE_SENTENCE =
  'The wording and rating are entirely your choice.'

/** The default factual reference, when the employee has not written one. */
export const DEFAULT_PROJECT_REFERENCE = 'your furniture requirement'

export type InvitationInput = {
  /** Who to address. Falls back to the customer/project name on the request. */
  greetingName: string | null | undefined
  customerName: string
  /** A factual reminder of the job. Never a claim about how it went. */
  projectReference: string | null | undefined
  reviewUrl: string
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * The exact text the customer will receive.
 *
 * One paragraph, four sentences, in a fixed order:
 *   1. the greeting and the factual thank-you,
 *   2. the invitation and the link,
 *   3. NEUTRAL_FEEDBACK_SENTENCE,
 *   4. CUSTOMER_CHOICE_SENTENCE.
 *
 * This is the ONLY place a message is built. The preview on screen and the text
 * in the wa.me URL both come from this call, so what an employee reads before
 * clicking is what the customer receives — see buildWaMeUrl, and the parity
 * test that decodes the URL back and compares it to this string.
 */
export function buildInvitationMessage(input: InvitationInput): string {
  const name = collapse(input.greetingName || '') || collapse(input.customerName)
  const reference = collapse(input.projectReference || '') || DEFAULT_PROJECT_REFERENCE
  const link = input.reviewUrl.trim()

  return [
    `Hello ${name}, thank you for working with Best of Exports on ${reference}.`,
    `If you would like to share your honest experience, you can leave a review here: ${link}.`,
    NEUTRAL_FEEDBACK_SENTENCE,
    CUSTOMER_CHOICE_SENTENCE,
  ].join(' ')
}

/**
 * PHRASES THAT ASK FOR A VERDICT, which the two editable fragments must not
 * contain.
 *
 * The locked closing sentences cannot be removed — but the greeting and the
 * project reference ARE editable, and without this an employee in a hurry could
 * type "please give us 5 stars" into a factual reference and send a message
 * that solicits a rating in its first sentence and disclaims it in its last.
 * The locked ending would still be there, and the invitation would still be
 * steered. That is the hole this closes.
 *
 * A deliberately NARROW list, not a sentiment model. It catches the phrasings
 * people actually use; it does not try to judge tone. A false positive costs an
 * employee a rewrite, and a false negative costs a customer a steered ask, so
 * the trade is made in that direction.
 *
 * Mirrored in SQL by customer_review_text_steers() — the browser check protects
 * the person typing and the database check protects the customer.
 */
export const STEERING_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z])(5|five)[\s-]*stars?([^a-z]|$)/i,
  /(^|[^a-z])5\s*\/\s*5([^a-z]|$)/i,
  /5\s+out\s+of\s+5/i,
  /(good|great|positive|excellent|best|nice|glowing)\s+(review|rating|feedback)/i,
  /(rate|review)\s+us\s+(well|highly|positively|good)/i,
  /please\s+(rate|review)/i,
  /star\s+rating/i,
  /★/,
]

/**
 * Whether an editable fragment asks the customer for a particular rating or
 * verdict. Applied to the greeting and the project reference, never to the
 * locked sentences (which would obviously never match).
 */
export function containsSteeringLanguage(value: string | null | undefined): boolean {
  if (!value) return false
  return STEERING_PATTERNS.some(pattern => pattern.test(value))
}

/**
 * Whether a message still carries both locked sentences.
 *
 * A belt to buildInvitationMessage's braces. It is called by the create/edit
 * screen before the WhatsApp button is enabled, so that if the builder is ever
 * refactored into producing something that has lost the neutral-feedback or
 * customer-choice language, the button goes dead rather than the promise
 * quietly going away.
 */
export function hasNeutralLanguage(message: string): boolean {
  return message.includes(NEUTRAL_FEEDBACK_SENTENCE) && message.includes(CUSTOMER_CHOICE_SENTENCE)
}

/**
 * The wa.me address that opens WhatsApp with the invitation prefilled.
 *
 * `phoneDigits` is digits only, no '+', which is what wa.me expects — use
 * waMePhone() in ./contact to produce it, because that function refuses a
 * malformed number rather than guessing.
 *
 * OPENING THIS URL SENDS NOTHING. It hands the message to WhatsApp with the
 * chat open and the text in the input box; a person still has to press send.
 * The module records that separately and never treats one as the other.
 */
export function buildWaMeUrl(phoneDigits: string, message: string): string {
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`
}

/**
 * The message a wa.me URL actually carries, for verification.
 *
 * Used by the parity test — and available to anyone checking by hand — so
 * "the preview matches what WhatsApp will show" is something that can be
 * proved rather than asserted.
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
