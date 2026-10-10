import {
  CLIENT_TYPES, LEAD_TYPES, REQUIREMENTS, optionValues,
  type BuyingTimeline, type ClientType, type LeadType, type Requirement,
} from './constants'
import { joinPhone, normalizeLeadPhone, phoneError } from './phone'

export const MAX_NAME = 120
export const MAX_COMPANY = 160
export const MAX_CITY = 80
export const MAX_NOTE = 2000
export const MAX_OTHER = 200
export const MAX_EMAIL = 120

/** The same shape the database CHECK accepts: one address, no spaces. */
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export type LeadFormValues = {
  contactName: string
  countryCode: string
  mobile: string
  /** Optional. */
  email: string
  clientType: ClientType | ''
  /** Required when clientType is 'other'. */
  clientTypeOther: string
  requirements: Requirement[]
  companyName: string
  projectCity: string
  buyingTimeline: BuyingTimeline | ''
  /** Mandatory, and no default: the salesperson judges every lead. */
  leadType: LeadType | ''
  note: string
}

export type LeadFormErrors = Partial<Record<
  'contactName' | 'mobile' | 'email' | 'clientType' | 'clientTypeOther' | 'requirements' | 'leadType' | 'companyName' | 'projectCity' | 'note', string>>

export function emptyLeadForm(): LeadFormValues {
  return {
    contactName: '', countryCode: '91', mobile: '', email: '', clientType: '', clientTypeOther: '', requirements: [],
    companyName: '', projectCity: '', buyingTimeline: '', leadType: '', note: '',
  }
}

export function validateLeadForm(v: LeadFormValues): LeadFormErrors {
  const e: LeadFormErrors = {}
  const name = v.contactName.trim()
  if (!name) e.contactName = 'Enter the contact name'
  else if (name.length > MAX_NAME) e.contactName = `At most ${MAX_NAME} characters`
  const mobile = phoneError(v.countryCode, v.mobile)
  if (mobile) e.mobile = mobile
  const email = (v.email ?? '').trim()
  if (email && (email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email))) e.email = 'Enter a valid email address'
  if (!v.clientType || !optionValues(CLIENT_TYPES).includes(v.clientType)) e.clientType = 'Choose a client type'
  if (v.clientType === 'other') {
    if (!v.clientTypeOther.trim()) e.clientTypeOther = 'Say what kind of client this is'
    else if (v.clientTypeOther.trim().length > MAX_OTHER) e.clientTypeOther = `At most ${MAX_OTHER} characters`
  }
  if (v.requirements.length === 0) e.requirements = 'Choose at least one requirement'
  else if (!v.requirements.every(r => optionValues(REQUIREMENTS).includes(r))) e.requirements = 'Unknown requirement'
  if (!v.leadType || !optionValues(LEAD_TYPES).includes(v.leadType)) e.leadType = 'Choose a lead type'
  if (v.companyName.trim().length > MAX_COMPANY) e.companyName = `At most ${MAX_COMPANY} characters`
  if (v.projectCity.trim().length > MAX_CITY) e.projectCity = `At most ${MAX_CITY} characters`
  if (v.note.trim().length > MAX_NOTE) e.note = `At most ${MAX_NOTE} characters`
  return e
}

/**
 * The required fields still open, by name, in form order — what the Save bar
 * says is "still needed". Empty means the form can be saved (validateLeadForm
 * remains the judge of the exact rules).
 */
export function missingRequired(v: LeadFormValues): string[] {
  const out: string[] = []
  if (!v.contactName.trim()) out.push('Name')
  if (phoneError(v.countryCode, v.mobile)) out.push('Mobile')
  if (!v.clientType) out.push('Client type')
  else if (v.clientType === 'other' && !v.clientTypeOther.trim()) out.push('Kind of client')
  if (v.requirements.length === 0) out.push('Requirement')
  if (!v.leadType) out.push('Lead type')
  return out
}

/** Arguments of create_exhibition_lead — minus the ids the caller supplies. */
export function toCreateArgs(v: LeadFormValues) {
  return {
    p_contact_name: v.contactName.trim(),
    p_phone: normalizeLeadPhone(joinPhone(v.countryCode, v.mobile)) ?? '',
    p_client_type: v.clientType,
    p_client_type_other: v.clientType === 'other' ? v.clientTypeOther.trim() : null,
    p_requirements: v.requirements,
    p_company_name: v.companyName.trim() || null,
    p_project_city: v.projectCity.trim() || null,
    p_buying_timeline: v.buyingTimeline || null,
    p_lead_type: v.leadType,
    p_note: v.note.trim() || null,
  }
}

/** What set_exhibition_lead_contact takes besides the photo: sent right after the lead is created. */
export const emailOf = (v: LeadFormValues): string => (v.email ?? '').trim().toLowerCase()

export function toggleRequirement(current: Requirement[], value: Requirement): Requirement[] {
  return current.includes(value) ? current.filter(r => r !== value) : [...current, value]
}
