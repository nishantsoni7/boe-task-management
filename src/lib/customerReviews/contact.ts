// The customer's WhatsApp number: normalising it, masking it, and keeping it
// out of everything that is not the wa.me URL.
//
// THE PRIVACY RULE THIS FILE EXISTS TO SUPPORT
// --------------------------------------------
// This is the only genuinely private customer datum the module stores. It must
// never appear in a console line, a thrown error, an analytics event, a
// notification, or a query string other than the wa.me address the employee's
// own browser opens. Nothing here formats it into a message, and no function
// here takes a `context` string that could carry it somewhere else.
//
// Masking is a DISPLAY control, not an authorization one. Who may read a number
// at all is decided by the customer_review_requests SELECT policy; masking is
// what stops it being read over a shoulder or captured in a screenshot of a
// list. The two are not substitutes and the module uses both.

/**
 * BOE's default country. An employee typing a bare 10-digit Indian mobile is
 * the overwhelmingly common case, and making them type +91 every time would be
 * friction with no safety gain.
 *
 * AN ASSUMPTION, DELIBERATELY NARROW: it applies ONLY to a bare 10-digit input.
 * Anything longer, anything with a leading + or 00, and anything shorter is
 * taken at face value and either normalises to what the employee actually typed
 * or is refused. An international customer's number is therefore never silently
 * turned into an Indian one.
 */
export const DEFAULT_COUNTRY_CODE = '91'

/** E.164: a leading '+', a non-zero first digit, and 8–15 digits in total. */
const E164_RE = /^\+[1-9][0-9]{7,14}$/

export type NormalizedNumber =
  | { ok: true; e164: string; digits: string }
  | { ok: false; error: string }

/**
 * Turn what an employee typed into E.164, or explain why it cannot be.
 *
 * Accepts the shapes people actually paste — spaces, dashes, brackets, a
 * leading 00, a leading +, a bare national number — and produces exactly one
 * canonical form. Returns a RESULT rather than throwing, so a caller cannot let
 * a validation failure escape as an exception carrying the number in its
 * message.
 */
export function normalizeWhatsAppNumber(
  raw: string | null | undefined,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): NormalizedNumber {
  const input = (raw ?? '').trim()
  if (input === '') return { ok: false, error: 'Enter the customer’s WhatsApp number.' }

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
 * to be safe on a shared screen. There is a deliberate reveal control on the
 * detail screen for the moment an employee genuinely needs the full number; the
 * masked form is what everything else shows.
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
 * Returns null rather than a best guess when the stored value is not a valid
 * E.164 number, so a malformed record produces no link at all instead of a link
 * to the wrong person.
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
