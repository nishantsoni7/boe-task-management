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
export function sanitizeAmountInput(value: string): string {
  let v = value.replace(/[^0-9.]/g, '')
  const firstDot = v.indexOf('.')
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '')
  }
  return v
}

// Business rule: amount must be a real, finite, positive number.
export function isValidAmount(raw: string): boolean {
  if (!raw) return false
  const n = Number(raw)
  return Number.isFinite(n) && n > 0
}
