import { joinPhone, normalizeLeadPhone } from '@/lib/exhibitionLeads/phone'
import type { PhotoKind } from './constants'
import type { VendorInput, VisitInput } from './api'

// The same rules the database enforces, so the form can say what is wrong before a round trip. The database
// stays authoritative (save_vendor / log_vendor_visit re-check everything).

export type FieldErrors<K extends string> = Partial<Record<K, string>>

export const EMPTY_VENDOR: VendorInput = {
  company_name: '', contact_name: '', contact_designation: '', phone: '', alt_phone: '', email: '',
  address: '', city: '', state: '', pincode: '', capabilities: [], categories: [], materials: '',
  headcount: '', monthly_capacity: '', notes: '',
}

export type VendorField = keyof VendorInput

/** The phone boxes hold the national part; the country code is +91 unless the person typed a full +number. */
export const fullPhone = (raw: string) => joinPhone('91', raw)

export function validateVendor(v: VendorInput): FieldErrors<VendorField> {
  const e: FieldErrors<VendorField> = {}
  if (!v.company_name.trim()) e.company_name = 'Enter the company name'
  if (!v.contact_name.trim()) e.contact_name = 'Enter the name of the contact person'
  if (!v.phone.trim()) e.phone = 'Enter the mobile number'
  else if (!normalizeLeadPhone(fullPhone(v.phone))) e.phone = 'Enter a valid mobile number'
  if (v.alt_phone.trim() && !normalizeLeadPhone(fullPhone(v.alt_phone))) e.alt_phone = 'Enter a valid number or leave it empty'
  if (v.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) e.email = 'Email does not look right'
  if (v.address.trim().length < 5) e.address = 'Enter the exact address of the factory'
  if (!v.city.trim()) e.city = 'Enter the city'
  if (v.pincode.trim() && !/^[0-9]{6}$/.test(v.pincode.trim())) e.pincode = 'Pincode is 6 digits'
  if (v.capabilities.length === 0) e.capabilities = 'Choose what this vendor can do'
  if (v.headcount.trim() && !/^[0-9]{1,4}$/.test(v.headcount.trim())) e.headcount = 'Enter a whole number'
  return e
}

/** What goes to the database: phones in full, text trimmed. */
export function vendorPayload(v: VendorInput): VendorInput {
  return {
    ...v,
    company_name: v.company_name.trim(), contact_name: v.contact_name.trim(),
    contact_designation: v.contact_designation.trim(),
    phone: fullPhone(v.phone), alt_phone: v.alt_phone.trim() ? fullPhone(v.alt_phone) : '',
    email: v.email.trim(), address: v.address.trim(), city: v.city.trim(), state: v.state.trim(),
    pincode: v.pincode.trim(), materials: v.materials.trim(), headcount: v.headcount.trim(),
    monthly_capacity: v.monthly_capacity.trim(), notes: v.notes.trim(),
  }
}

export type VisitDraft = Omit<VisitInput, 'photos' | 'latitude' | 'longitude' | 'accuracy_m'>
export type VisitField = keyof VisitDraft | 'photos'

export const EMPTY_VISIT: VisitDraft = {
  purpose: '', person_met: '', person_met_designation: '', discussion: '', outcome: '', next_follow_up_on: '',
}

export function validateVisit(
  v: VisitDraft,
  photoKinds: readonly PhotoKind[],
  needsFactoryPhoto: boolean,
  today: string,
): FieldErrors<VisitField> {
  const e: FieldErrors<VisitField> = {}
  if (!v.purpose) e.purpose = 'Choose the purpose of the visit'
  if (!v.person_met.trim()) e.person_met = 'Enter the name of the person you met'
  if (v.discussion.trim().length < 3) e.discussion = 'Write what was discussed'
  if (!v.outcome) e.outcome = 'Choose the outcome'
  if (v.outcome === 'follow_up_needed' && !v.next_follow_up_on) e.next_follow_up_on = 'Choose the date of the next follow-up'
  if (v.next_follow_up_on && v.next_follow_up_on < today) e.next_follow_up_on = 'The date cannot be in the past'
  if (photoKinds.length === 0) e.photos = 'Add at least one photograph of the visit'
  else if (needsFactoryPhoto && !photoKinds.includes('factory')) e.photos = 'The first visit needs a photograph of the factory'
  return e
}
