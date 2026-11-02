import { joinPhone, phoneError } from '@/lib/exhibitionLeads/phone'
import {
  EMAIL_PATTERN, LEAD_SOURCE_VALUES, MAX_EMAIL, MAX_LOCATION, MAX_NAME, MAX_REQUIREMENT, type LeadSource,
} from './constants'
import type { LeadInput } from './api'

// The same rules the database checks (20270524000000), so the form can say no without a round trip. The number
// rule is the Exhibition Leads one, imported, not copied: one definition of "a valid mobile number" in BOE.

export type LeadForm = {
  countryCode: string
  /** What the person typed in the number box. */
  number: string
  source: LeadSource | ''
  name: string
  email: string
  location: string
  requirement: string
}

export type LeadFormErrors = Partial<Record<'number' | 'source' | 'name' | 'email' | 'location' | 'requirement', string>>

export const EMPTY_FORM: LeadForm = { countryCode: '91', number: '', source: '', name: '', email: '', location: '', requirement: '' }

/**
 * The Exhibition Leads rule, plus the two slips it cannot see because it takes the number as typed: a 0 left at the
 * front of a number from another country (+971 0501234567 would be stored as a different lead from +971 501234567),
 * and "Other" without a + (9876543210 would become +9876543210). India's leading 0 is already handled by the rule.
 */
export function numberError(countryCode: string, number: string): string | null {
  const base = phoneError(countryCode, number)
  if (base) return base
  const typed = number.replace(/[\s().-]/g, '')
  if (/^(\+|00)/.test(typed)) return null
  if (countryCode === '') return 'Start with + and the country code, for example +971 56 732 3638'
  if (countryCode !== '91' && typed.startsWith('0')) return 'Leave out the 0 at the start'
  return null
}

export function validateLead(f: LeadForm): LeadFormErrors {
  const errors: LeadFormErrors = {}
  const number = numberError(f.countryCode, f.number)
  if (number) errors.number = number
  if (f.source === '' || !LEAD_SOURCE_VALUES.includes(f.source)) errors.source = 'Choose where the lead came from'
  if (f.name.trim().length > MAX_NAME) errors.name = `Keep the name under ${MAX_NAME} characters`
  const email = f.email.trim()
  if (email !== '' && (email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email))) errors.email = 'Enter a valid email address'
  if (f.location.trim().length > MAX_LOCATION) errors.location = `Keep the location under ${MAX_LOCATION} characters`
  if (f.requirement.trim().length > MAX_REQUIREMENT) errors.requirement = `Keep this under ${MAX_REQUIREMENT} characters`
  return errors
}

/** The form as the database wants it. Call only when validateLead found nothing. */
export function toInput(f: LeadForm): LeadInput {
  return {
    phone: joinPhone(f.countryCode, f.number),
    source: f.source as LeadSource,
    name: f.name.trim(),
    email: f.email.trim(),
    location: f.location.trim(),
    requirement: f.requirement.trim(),
  }
}

/** A stored number back into the form: an Indian number fills the box without its +91, any other keeps the whole +… */
export function formFromLead(l: { phone: string; source: LeadSource; name: string | null; email: string | null; location: string | null; requirement: string | null }): LeadForm {
  const india = /^\+91([6-9][0-9]{9})$/.exec(l.phone)
  return {
    countryCode: india ? '91' : '',
    number: india ? india[1] : l.phone,
    source: l.source,
    name: l.name ?? '',
    email: l.email ?? '',
    location: l.location ?? '',
    requirement: l.requirement ?? '',
  }
}
