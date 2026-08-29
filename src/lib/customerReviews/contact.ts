// Phone numbers: normalising them, validating them, masking them, and keeping
// them out of everything that is not the wa.me URL.
//
// WHOSE NUMBERS THESE ARE
// -----------------------
// WHATEVER NUMBER THE AUTHORIZED TESTER TYPES. There is no allowlist and no
// approved-recipient list: an employee who holds `use` and has booked the card
// enters an international number and the server builds a wa.me link for it.
//
// That is a deliberate widening of an earlier design, and what replaced the
// allowlist is worth naming, because "anyone" is not "unchecked":
//
//   * only an ACTIVE employee holding `customer_review_requests.use`, and only
//     for a card THEY hold, can produce a link at all;
//   * the number is normalised and validated ON THE SERVER, and a malformed,
//     implausibly short or implausibly long one is refused with no link;
//   * the tester must tick a confirmation that the number may receive an
//     internal BOE test message;
//   * the message still carries the permanent internal-test label, which no
//     employee can edit or remove;
//   * nothing sends. The artefact is a URL string; a person opens it and
//     presses send themselves.
//
// THE PRIVACY RULE THIS FILE SUPPORTS
// -----------------------------------
// A phone number is personal data, and now that any number may be typed it is
// no longer necessarily a colleague's. It must never appear in a console line,
// a thrown error, an analytics event, a notification, an audit row, a test
// fixture, or any query string other than the wa.me address the tester's own
// browser opens.
//
// THE FULL NUMBER IS NEVER STORED. What the card keeps is a masked last four
// and a non-reversible fingerprint — see ./recipientPrivacy.ts. Masking here is
// a DISPLAY control on top of that: it is what stops a number being read over a
// shoulder or captured in a screenshot, and a screenshot is precisely what this
// module asks testers to take.

/** E.164: a leading '+', a non-zero first digit, and 8–15 digits in total. */
const E164_RE = /^\+[1-9][0-9]{7,14}$/

/**
 * The plausibility bounds, named rather than buried in the regex above.
 *
 * E.164 caps a number at 15 digits including the country code, and no
 * assignable number is shorter than 8. Anything outside that is not a number
 * somebody mistyped — it is not a number.
 */
export const MIN_NUMBER_DIGITS = 8
export const MAX_NUMBER_DIGITS = 15

export type NormalizedNumber =
  | { ok: true; e164: string; digits: string }
  | { ok: false; error: string }

/**
 * Turn what somebody typed into E.164, or explain why it cannot be.
 *
 * ACCEPTS the shapes people actually paste: a leading `+` or `00`, spaces,
 * hyphens, and parentheses around a country or area code. All of those are
 * separators, and all of them are removed.
 *
 * REQUIRES THE COUNTRY CODE, and this is the one place the rule tightened when
 * the allowlist went away. An earlier version treated a bare ten-digit input as
 * an Indian mobile, which was a safe convenience while the only reachable
 * numbers were BOE's own. Now that ANY number can be typed, silently deciding
 * which country a bare number belongs to would be silently deciding who gets
 * messaged. So a number must say where it is: `+…` or `00…`.
 *
 * Returns a RESULT rather than throwing, so a caller cannot let a validation
 * failure escape as an exception carrying the number in its message. NO ERROR
 * STRING BELOW CONTAINS ANY PART OF THE INPUT.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): NormalizedNumber {
  const input = (raw ?? '').trim()
  if (input === '') {
    return { ok: false, error: 'Enter the WhatsApp number this internal test should go to.' }
  }

  // The separators a person legitimately types. Anything else — a letter, a
  // slash, a comma — means this is not a phone number, and is caught below
  // rather than quietly stripped.
  const withoutSeparators = input.replace(/[\s()\-.‐-―]/g, '')

  const hadPlus = withoutSeparators.startsWith('+')
  const hadZeros = !hadPlus && withoutSeparators.startsWith('00')

  const body = hadPlus ? withoutSeparators.slice(1)
    : hadZeros ? withoutSeparators.slice(2)
    : withoutSeparators

  // Everything left must be a digit. Checked rather than stripped: stripping
  // would turn "+91 98765 4321O" (a typed letter O) into a valid-looking number
  // one digit short of the one that was meant.
  if (!/^[0-9]+$/.test(body)) {
    return { ok: false, error: 'That does not look like a phone number.' }
  }

  if (!hadPlus && !hadZeros) {
    return {
      ok: false,
      error: 'Include the country code, for example +91 98765 43210 or 0091 98765 43210.',
    }
  }

  if (body.length < MIN_NUMBER_DIGITS) {
    return { ok: false, error: 'That number is too short to be a WhatsApp number.' }
  }
  if (body.length > MAX_NUMBER_DIGITS) {
    return { ok: false, error: 'That number is too long to be a WhatsApp number.' }
  }

  const e164 = `+${body}`
  if (!E164_RE.test(e164)) {
    // Reachable for a leading zero after the country code, which E.164 forbids
    // and which would otherwise look valid.
    return { ok: false, error: 'Enter the number with its country code, for example +91 98765 43210.' }
  }

  return { ok: true, e164, digits: body }
}

export function isValidWhatsAppNumber(value: string | null | undefined): boolean {
  return typeof value === 'string' && E164_RE.test(value)
}

/**
 * The number as a screen shows it: the last four digits and nothing else.
 *
 * NOT the country code, and not the leading digits. A country code plus a
 * length is already a strong hint about who somebody is, and this string exists
 * to be safe on a shared screen — and inside the screenshots this module asks
 * testers to upload.
 */
export function maskWhatsAppNumber(value: string | null | undefined): string {
  if (!value) return '—'
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4) return '••••'
  return `•••• •••• ${digits.slice(-4)}`
}

/** The same shape, built from a stored last-four rather than a full number. */
export function maskFromLastFour(lastFour: string | null | undefined): string {
  if (!lastFour || !/^[0-9]{4}$/.test(lastFour)) return '—'
  return `•••• •••• ${lastFour}`
}

// ── TWO HELPERS THAT USED TO BE HERE, AND WHY THEY ARE NOT ──────────────────
//
// waMePhone(e164) turned a stored number into wa.me path digits. Nothing stores
// a number any more: the route validates what the tester typed and uses the
// `digits` that normalizeWhatsAppNumber already returns, so the helper had one
// job and no caller.
//
// formatWhatsAppNumber(e164) rendered a full number for a deliberate reveal
// control. There is nothing to reveal — the card keeps four digits and a
// fingerprint — so both the control and the formatter are gone. Leaving a
// function whose only purpose is to display a full number would be leaving the
// shape of the thing this module now refuses to keep.
