import { CLIENT_TYPES, REQUIREMENTS, optionValues, type ClientType, type Requirement } from './constants'
import { DEFAULT_COUNTRY_CODE, normalizeLeadPhone } from './phone'
import {
  EMAIL_PATTERN, MAX_CITY, MAX_COMPANY, MAX_NAME, MAX_NOTE, MAX_OTHER,
  type LeadFormValues,
} from './validation'

// Scanning a visiting card or a visitor form.
//
// A photograph is read once, on the server (/api/exhibition-leads/scan), into a
// ScanResult. Nothing here trusts that result: parseScanResult keeps only what
// has the right shape, and applyScan only ever FILLS fields the salesperson has
// not already typed. The salesperson still chooses the Lead Type (and confirms
// the rest) before anything is saved, so a misread costs one tap, not a bad lead.

export type ScanKind = 'visiting_card' | 'visitor_form'

export const SCAN_KINDS: readonly { value: ScanKind; label: string; short: string }[] = [
  { value: 'visiting_card', label: 'Visiting card', short: 'card' },
  { value: 'visitor_form', label: 'Visitor form', short: 'form' },
]

export type ScanResult = {
  kind: ScanKind
  name: string
  /** Every number found, as printed. The first usable one fills the mobile field. */
  phones: string[]
  email: string
  company: string
  designation: string
  /** Where the person is based out of. */
  city: string
  website: string
  address: string
  clientType: ClientType | ''
  requirements: Requirement[]
  /** The requirement in the visitor's own words, when it does not fit the two options. */
  requirementText: string
}

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** The model's answer, made safe: wrong types and unknown option values are dropped, not guessed at. */
export function parseScanResult(raw: unknown, kind: ScanKind): ScanResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const clientType = optionValues(CLIENT_TYPES).find(v => v === o.client_type) ?? ''
  const reqs = Array.isArray(o.requirements)
    ? optionValues(REQUIREMENTS).filter(v => (o.requirements as unknown[]).includes(v))
    : []
  const phones = (Array.isArray(o.phones) ? o.phones : [])
    .map(p => text(p, 40))
    .filter(Boolean)
    .slice(0, 6)
  return {
    kind,
    name: text(o.name, MAX_NAME),
    phones,
    email: text(o.email, 120).toLowerCase(),
    company: text(o.company, MAX_COMPANY),
    designation: text(o.designation, 80),
    city: text(o.city, MAX_CITY),
    website: text(o.website, 120),
    address: text(o.address, 240),
    clientType,
    requirements: reqs,
    requirementText: text(o.requirement_text, 300),
  }
}

/** True when the photograph yielded nothing a salesperson could use. */
export const scanIsEmpty = (r: ScanResult): boolean =>
  !r.name && r.phones.length === 0 && !r.company && !r.email && !r.city

/** '+919876543210' → { countryCode: '91', mobile: '9876543210' }. Other countries keep the full '+…' in the number box. */
export function splitPhone(e164: string): { countryCode: string; mobile: string } {
  if (/^\+91[6-9][0-9]{9}$/.test(e164)) return { countryCode: DEFAULT_COUNTRY_CODE, mobile: e164.slice(3) }
  return { countryCode: DEFAULT_COUNTRY_CODE, mobile: e164 }
}

/** The first number on the page the form can actually save. */
export function firstUsablePhone(phones: readonly string[]): string | null {
  for (const p of phones) {
    const n = normalizeLeadPhone(p)
    if (n) return n
  }
  return null
}

/** The fields the form shows as "read from the photo", for the little marker beside them. */
export type ScanField = 'contactName' | 'mobile' | 'email' | 'companyName' | 'projectCity' | 'clientType' | 'requirements' | 'note'

/**
 * What has no column of its own (designation, website, address, spare numbers)
 * goes in the discussion note, once, headed by where it came from — so it is on
 * the lead for the follow-up call instead of lost with the photograph.
 */
export function scanNote(r: ScanResult): string {
  const lines = [r.kind === 'visiting_card' ? 'Scanned from visiting card' : 'Scanned from visitor form']
  if (r.designation) lines.push(`Designation: ${r.designation}`)
  if (r.website) lines.push(`Website: ${r.website}`)
  if (r.address) lines.push(`Address: ${r.address}`)
  const spare = r.phones.filter(p => normalizeLeadPhone(p) !== firstUsablePhone(r.phones))
  if (spare.length) lines.push(`Other numbers: ${spare.join(', ')}`)
  if (r.requirementText) lines.push(`Requirement: ${r.requirementText}`)
  return lines.join('\n').slice(0, MAX_NOTE)
}

export type AppliedScan = { values: LeadFormValues; filled: ScanField[]; unusablePhone: boolean }

/**
 * Pour the scan into the form. A field the salesperson already filled is left
 * alone; the Lead Type is never touched — that judgement is theirs.
 */
export function applyScan(current: LeadFormValues, r: ScanResult): AppliedScan {
  const next: LeadFormValues = { ...current }
  const filled: ScanField[] = []

  if (r.name && !current.contactName.trim()) { next.contactName = r.name; filled.push('contactName') }

  const phone = firstUsablePhone(r.phones)
  if (phone && !current.mobile.trim()) {
    const { countryCode, mobile } = splitPhone(phone)
    next.countryCode = countryCode
    next.mobile = mobile
    filled.push('mobile')
  }

  // A misread address is left out rather than filled in: the form would refuse it on Save.
  if (r.email && EMAIL_PATTERN.test(r.email) && !(current.email ?? '').trim()) { next.email = r.email; filled.push('email') }

  if (r.company && !current.companyName.trim()) { next.companyName = r.company; filled.push('companyName') }
  if (r.city && !current.projectCity.trim()) { next.projectCity = r.city; filled.push('projectCity') }

  if (r.clientType && !current.clientType) {
    next.clientType = r.clientType
    filled.push('clientType')
  }
  if (r.requirements.length && current.requirements.length === 0) {
    next.requirements = [...r.requirements]
    filled.push('requirements')
  }

  const note = scanNote(r)
  if (note && !current.note.trim()) { next.note = note; filled.push('note') }

  return { values: next, filled, unusablePhone: r.phones.length > 0 && !phone }
}

/** MAX_OTHER is re-exported for the client-type "other" text a scan never fills. */
export { MAX_OTHER }

// ── The photograph ───────────────────────────────────────────────────────

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const
/** What the browser sends after shrinking; the server refuses anything bigger. */
export const MAX_SCAN_BYTES = 3 * 1024 * 1024
/** The longest side after shrinking: plenty to read a card, small enough for hall Wi-Fi. */
export const SCAN_LONG_SIDE = 1800

export type ScanApiResponse =
  | { ok: true; result: ScanResult }
  | { ok: false; error: string; code: 'not_configured' | 'unreadable' | 'rate_limited' | 'auth' | 'too_large' | 'failed' }
