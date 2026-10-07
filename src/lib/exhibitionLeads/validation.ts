import {
  CLIENT_TYPES, REQUIREMENTS, optionValues,
  type BuyingTimeline, type ClientType, type Priority, type Requirement,
} from './constants'
import { joinPhone, normalizeLeadPhone, phoneError } from './phone'

export const MAX_NAME = 120
export const MAX_COMPANY = 160
export const MAX_CITY = 80
export const MAX_NOTE = 2000

export type LeadFormValues = {
  contactName: string
  countryCode: string
  mobile: string
  clientType: ClientType | ''
  requirements: Requirement[]
  companyName: string
  projectCity: string
  buyingTimeline: BuyingTimeline | ''
  priority: Priority
  note: string
}

export type LeadFormErrors = Partial<Record<
  'contactName' | 'mobile' | 'clientType' | 'requirements' | 'companyName' | 'projectCity' | 'note', string>>

export function emptyLeadForm(): LeadFormValues {
  return {
    contactName: '', countryCode: '91', mobile: '', clientType: '', requirements: [],
    companyName: '', projectCity: '', buyingTimeline: '', priority: 'not_assessed', note: '',
  }
}

export function validateLeadForm(v: LeadFormValues): LeadFormErrors {
  const e: LeadFormErrors = {}
  const name = v.contactName.trim()
  if (!name) e.contactName = 'Enter the contact name'
  else if (name.length > MAX_NAME) e.contactName = `At most ${MAX_NAME} characters`
  const mobile = phoneError(v.countryCode, v.mobile)
  if (mobile) e.mobile = mobile
  if (!v.clientType || !optionValues(CLIENT_TYPES).includes(v.clientType)) e.clientType = 'Choose a client type'
  if (v.requirements.length === 0) e.requirements = 'Choose at least one requirement'
  else if (!v.requirements.every(r => optionValues(REQUIREMENTS).includes(r))) e.requirements = 'Unknown requirement'
  if (v.companyName.trim().length > MAX_COMPANY) e.companyName = `At most ${MAX_COMPANY} characters`
  if (v.projectCity.trim().length > MAX_CITY) e.projectCity = `At most ${MAX_CITY} characters`
  if (v.note.trim().length > MAX_NOTE) e.note = `At most ${MAX_NOTE} characters`
  return e
}

/** Arguments of create_exhibition_lead — minus the ids the caller supplies. */
export function toCreateArgs(v: LeadFormValues) {
  return {
    p_contact_name: v.contactName.trim(),
    p_phone: normalizeLeadPhone(joinPhone(v.countryCode, v.mobile)) ?? '',
    p_client_type: v.clientType,
    p_requirements: v.requirements,
    p_company_name: v.companyName.trim() || null,
    p_project_city: v.projectCity.trim() || null,
    p_buying_timeline: v.buyingTimeline || null,
    p_priority: v.priority,
    p_note: v.note.trim() || null,
  }
}

/** "Not Decided" excludes the rest: it means no choice has been made. */
export function toggleRequirement(current: Requirement[], value: Requirement): Requirement[] {
  if (current.includes(value)) return current.filter(r => r !== value)
  if (value === 'not_decided') return ['not_decided']
  return [...current.filter(r => r !== 'not_decided'), value]
}
