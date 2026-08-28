// Phone numbers: normalising them, masking them, and keeping them out of
// everything that is not the wa.me URL.
//
// WHOSE NUMBERS THESE ARE
// -----------------------
// BOE INTERNAL TEAM NUMBERS, and only those. This module has no customer
// contact details, no column that could hold one, and no path by which one
// could be entered — the recipient of a test message is chosen from a
// server-held allowlist (see ./allowlist.ts) and re-checked on the server
// before any link is produced. Nothing here dials, sends, or contacts anybody:
// the functions below turn a string into a canonical form and back into a
// display string.
//
// THE PRIVACY RULE THIS FILE SUPPORTS
// -----------------------------------
// A colleague's mobile number is still personal data. It must never appear in a
// console line, a thrown error, an analytics event, a notification, or a query
// string other than the wa.me address the tester's own browser opens. Nothing
// here formats a number into a message, and no function here takes a `context`
// string that could carry one somewhere else.
//
// Masking is a DISPLAY control, not an authorization one. Who may read a number
// at all is decided by the allowlist route's permission check; masking is what
// stops it being read over a shoulder or captured in a screenshot — and a
// screenshot is precisely what this module asks testers to take.

/**
 * BOE's default country. A tester typing a bare 10-digit Indian mobile is the
 * overwhelmingly common case, and making them type +91 every time would be
 * friction with no safety gain.
 *
 * AN ASSUMPTION, DELIBERATELY NARROW: it applies ONLY to a bare 10-digit input.
 * Anything longer, anything with a leading + or 00, and anything shorter is
 * taken at face value and either normalises to what was actually typed or is
 * refused. It is NOT applied to allowlist configuration, which must be written
 * in full international form — see parseInternalTestAllowlist.
 */
export const DEFAULT_COUNTRY_CODE = '91'

/** E.164: a leading '+', a non-zero first digit, and 8–15 digits in total. */
const E164_RE = /^\+[1-9][0-9]{7,14}$/

export type NormalizedNumber =
  | { ok: true; e164: string; digits: string }
  | { ok: false; error: string }

/**
 * Turn what somebody typed into E.164, or explain why it cannot be.
 *
 * Accepts the shapes people actually paste — spaces, dashes, brackets, a
 * leading 00, a leading +, a bare national number — and produces exactly one
 * canonical form. Returns a RESULT rather than throwing, so a caller cannot let
 * a validation failure escape as an exception carrying the number in its
 * message.
 *
 * NORMALISING IS NOT AUTHORISING. A number that comes out of this function is
 * well-formed and nothing more; whether it may be messaged is answered by
 * findAllowedNumber() against the server-held allowlist.
 */
export function normalizeWhatsAppNumber(
  raw: string | null | undefined,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): NormalizedNumber {
  const input = (raw ?? '').trim()
  if (input === '') return { ok: false, error: 'Enter an internal team WhatsApp number.' }

  // Everything that is not a digit goes, except a single leading '+'. A '+'
  // anywhere else is a typo, not an instruction.
  const hadPlus = input.startsWith('+')
  let digits = input.replace(/\D/g, '')

  // 00 is the other way people write an international prefix.
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2)

  if (digits === '') return { ok: false, error: 'That does not look like a phone number.' }

  // A bare national number gets the default country code — and only a bare
  // national number. See DEFAULT_COUNTRY_CODE.
  if (!hadPlus && !input.startsWith('00') && digits.length === 10) {
    digits = `${defaultCountryCode}${digits}`
  }

  const e164 = `+${digits}`
  if (!E164_RE.test(e164)) {
    return {
      ok: false,
      error: 'Enter the number with its country code, for example +91 98765 43210.',
    }
  }

  return { ok: true, e164, digits }
}

export function isValidWhatsAppNumber(value: string | null | undefined): boolean {
  return typeof value === 'string' && E164_RE.test(value)
}

/**
 * The number as a list row or a detail header shows it: the last four digits
 * and nothing else.
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

/**
 * The number as WhatsApp wants it in a wa.me path: digits only, no '+'.
 *
 * Returns null rather than a best guess when the value is not a valid E.164
 * number, so a malformed entry produces no link at all instead of a link to the
 * wrong person.
 */
export function waMePhone(value: string | null | undefined): string | null {
  if (!isValidWhatsAppNumber(value)) return null
  return (value as string).slice(1)
}

/** Readable grouping for the reveal control. Never used in a link or a log. */
export function formatWhatsAppNumber(value: string | null | undefined): string {
  if (!isValidWhatsAppNumber(value)) return '—'
  const digits = (value as string).slice(1)
  if (digits.length <= 4) return `+${digits}`
  // Country code is everything before the last ten digits, where there are ten
  // to take; otherwise split off the leading two.
  const nationalLength = digits.length > 10 ? 10 : Math.max(digits.length - 2, 0)
  const country = digits.slice(0, digits.length - nationalLength)
  const national = digits.slice(digits.length - nationalLength)
  const grouped = national.length > 5
    ? `${national.slice(0, national.length - 5)} ${national.slice(-5)}`
    : national
  return `+${country} ${grouped}`.trim()
}
