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
  const num = Number(raw)
  if (!Number.isFinite(num)) return raw
  const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(num)
  return raw.endsWith('.') ? grouped + '.' : grouped
}

// Strips an amount input down to digits and at most one decimal point, so the
// canonical form.amount value never contains commas or invalid characters.
//
// AND AT MOST TWO DIGITS AFTER IT (launch audit, 2026-09-19). Money is rupees
// and paise. The input used to accept "1000.005", and the Payment Requests "+
// New" and edit paths stored it as typed — a payment no allocation (always whole
// paise) could ever fully account for.
export function sanitizeAmountInput(value: string): string {
  let v = value.replace(/[^0-9.]/g, '')
  const firstDot = v.indexOf('.')
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '').slice(0, 2)
  }
  return v
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
