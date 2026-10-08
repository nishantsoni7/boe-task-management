// Mobile / WhatsApp numbers for Exhibition Leads.
//
// normalizeLeadPhone is the TypeScript twin of public.normalize_lead_phone()
// in 20270305000000_exhibition_leads.sql. The database is authoritative (it is
// what the unique index sees); this copy exists so the form can reject a bad
// number before a round trip, and phone.test.ts pins both to the same vectors.
// Keep them identical.
//
//   '+…' / '00…'   international as typed — E.164: 8–15 digits, no leading 0.
//                  No ten-digit rule outside India.
//   10 digits      Indian national number → +91
//   0 + 10 digits  Indian trunk form → +91
//   91 + 10 digits Indian number without '+'
//   Indian numbers must be 10 digits starting 6–9.

export function normalizeLeadPhone(raw: string | null | undefined): string | null {
  const v = (raw ?? '').replace(/[\s().-]/g, '')
  if (v === '') return null
  let d: string
  if (v.startsWith('+')) d = v.slice(1)
  else if (v.startsWith('00')) d = v.slice(2)
  else if (/^[0-9]{10}$/.test(v)) d = `91${v}`
  else if (/^0[0-9]{10}$/.test(v)) d = `91${v.slice(1)}`
  else if (/^91[0-9]{10}$/.test(v)) d = v
  else return null
  if (!/^[0-9]+$/.test(d)) return null
  // "+91 0 98765 43210": a trunk zero after the country code.
  if (/^910[0-9]{10}$/.test(d)) d = `91${d.slice(3)}`
  if (!/^[1-9][0-9]{7,14}$/.test(d)) return null
  if (d.startsWith('91') && !/^91[6-9][0-9]{9}$/.test(d)) return null
  return `+${d}`
}

/** The form keeps the country code and the national part apart (default +91). */
export const DEFAULT_COUNTRY_CODE = '91'

export function joinPhone(countryCode: string, national: string): string {
  const cc = countryCode.replace(/\D/g, '')
  const nat = national.replace(/[\s().-]/g, '')
  // Someone pasting a full "+91 98765 43210" into the number box.
  if (nat.startsWith('+') || nat.startsWith('00')) return nat
  return `+${cc}${nat}`
}

export function phoneError(countryCode: string, national: string): string | null {
  if (national.trim() === '') return 'Enter the mobile number'
  if (!/^[0-9\s().+-]+$/.test(national)) return 'Use digits only'
  return normalizeLeadPhone(joinPhone(countryCode, national)) ? null : 'Enter a valid mobile number'
}

/** '+919876543210' → '+91 98765 43210' for display; other countries stay compact. */
export function formatPhone(e164: string): string {
  const m = /^\+91([6-9][0-9]{4})([0-9]{5})$/.exec(e164)
  return m ? `+91 ${m[1]} ${m[2]}` : e164
}

/** Opening these apps proves nothing about contact having happened. */
export const telHref = (e164: string) => `tel:${e164}`
export const whatsappHref = (e164: string) => `https://wa.me/${e164.replace(/\D/g, '')}`
