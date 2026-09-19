// Shared Indian-numbering helpers for Finance amount display/entry.
// Indian digit grouping (10,00,000 not 1,000,000) via the standard en-IN locale.

// Display formatter — e.g. 1000000 -> "₹10,00,000".
export function formatINR(amount: number): string {
  if (!Number.isFinite(amount)) return ''
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)
}

// Groups a raw, comma-free numeric string (digits + at most one '.') using
// Indian digit grouping, without a currency symbol — for live/blur display in
// editable amount inputs. The canonical stored value never contains commas;
// this is presentation only.
export function groupIndianDigits(raw: string): string {
  if (!raw) return ''
  // Anything that is not already a valid rupees-and-paise figure is shown
  // EXACTLY as typed: formatting 1000.005 would display "1,000.01" — a
  // rounded figure the person never entered.
  if (!/^\d*(\.\d{0,2})?$/.test(raw) || !/\d/.test(raw)) return raw
  const num = Number(raw)
  if (!Number.isFinite(num)) return raw
  const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(num)
  return raw.endsWith('.') ? grouped + '.' : grouped
}

// Removes ONLY what cannot change the figure: spaces, Indian grouping commas
// and the rupee sign, so a pasted "₹10,00,000" is the number 1000000.
//
// NOTHING ELSE IS TOUCHED (launch audit, 2026-09-19). This used to drop every
// other character and cut the fraction to two digits, so a pasted "1000.005"
// silently became "1000.00", "1.2.3" became "1.23", "-500" became "500" and
// "1e5" became "15" — each a DIFFERENT amount than the one entered, with nothing
// on screen to say so. Now the text stays exactly as entered, isValidAmount
// refuses it, and amountInputProblem() says why. Money is never rounded,
// truncated or re-read on the person's behalf.
export function sanitizeAmountInput(value: string): string {
  return value.replace(/[\s,₹]/g, '')
}

export const AMOUNT_TOO_MANY_DECIMALS =
  'Use at most two decimal places (paise). Nothing has been rounded — correct the amount.'
export const AMOUNT_NOT_A_NUMBER =
  'Use digits and one decimal point only — no signs, letters or second decimal point.'

/**
 * Why a typed amount cannot be accepted, in words — or null when it is fine
 * or merely incomplete ("", ".", "12."). A figure is never corrected here:
 * the person is told, and corrects it.
 */
export function amountInputProblem(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (v === '' || v === '.') return null
  if (/^\d*\.\d{3,}$/.test(v)) return AMOUNT_TOO_MANY_DECIMALS
  if (!/^\d*(\.\d{0,2})?$/.test(v)) return AMOUNT_NOT_A_NUMBER
  return null
}

// Business rule: amount must be a real, finite, positive number of rupees with
// at most two decimal places (paise). The server refuses more on every payment
// path; this is the same rule, stated before the request is sent. A trailing
// '.' (still typing) and a leading '.5' read as they always did; a third
// decimal, an exponent, a sign or a comma is refused.
export function isValidAmount(raw: string): boolean {
  if (!raw) return false
  if (!/^(?=\.?\d)\d*(\.\d{0,2})?$/.test(raw.trim())) return false
  const n = Number(raw)
  return Number.isFinite(n) && n > 0
}
