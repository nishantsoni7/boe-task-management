import { joinPhone, normalizeLeadPhone } from '@/lib/exhibitionLeads/phone'
import type { PhotoKind, VisitKind } from './constants'
import type { VendorInput, VisitInput } from './api'

// The same rules the database enforces, so the form can say what is wrong before a round trip. The database
// stays authoritative (save_vendor / log_vendor_visit re-check everything).

export type FieldErrors<K extends string> = Partial<Record<K, string>>

export const EMPTY_VENDOR: VendorInput = {
  company_name: '', contact_name: '', phone: '', address: '', city: '', capabilities: [], categories: [],
  headcount: '', referred_by: '', notes: '',
}

export type VendorField = keyof VendorInput

/** The phone box holds the number as typed; +91 is added unless the person typed a full +number. */
export const fullPhone = (raw: string) => joinPhone('91', raw)

/**
 * `relaxed` is a potential / contacted vendor: only a name is required, but anything typed must still be valid.
 * Otherwise (a registered vendor, or one about to be registered by a site visit) the whole profile is.
 */
export function validateVendor(v: VendorInput, relaxed = false): FieldErrors<VendorField> {
  const e: FieldErrors<VendorField> = {}
  if (!v.company_name.trim()) e.company_name = 'Enter the company name'
  if (!relaxed && !v.contact_name.trim()) e.contact_name = 'Enter the contact person'
  if (!v.phone.trim()) {
    if (!relaxed) e.phone = 'Enter the mobile number'
  } else if (!normalizeLeadPhone(fullPhone(v.phone))) e.phone = 'Enter a valid mobile number'
  if (v.address.trim() ? v.address.trim().length < 5 : !relaxed) e.address = 'Enter the exact address'
  if (!relaxed && !v.city.trim()) e.city = 'Enter the city'
  if (!relaxed && v.capabilities.length === 0) e.capabilities = 'Choose what they can do'
  if (v.headcount.trim() && !/^[0-9]{1,4}$/.test(v.headcount.trim())) e.headcount = 'Enter a whole number'
  return e
}

/** What goes to the database: phone in full, text trimmed. */
export function vendorPayload(v: VendorInput): VendorInput {
  return {
    ...v,
    company_name: v.company_name.trim(), contact_name: v.contact_name.trim(),
    phone: v.phone.trim() ? fullPhone(v.phone) : '', address: v.address.trim(), city: v.city.trim(),
    headcount: v.headcount.trim(), referred_by: v.referred_by.trim(), notes: v.notes.trim(),
  }
}

export type VisitDraft = Omit<VisitInput, 'photos' | 'latitude' | 'longitude' | 'accuracy_m' | 'kind' | 'entered_later'>
export type VisitField = keyof VisitDraft | 'photos'

export const EMPTY_VISIT: VisitDraft = {
  visited_on: '', person_met: '', discussion: '', outcome: '', next_follow_up_on: '',
}

export type VisitContext = {
  kind: VisitKind
  /** A visit that already happened, typed in afterwards. */
  enteredLater: boolean
  photoKinds: readonly PhotoKind[]
  /** The vendor has no earlier LIVE site visit, so a photograph of the factory is required. */
  needsFactoryPhoto: boolean
  today: string
}

/** True when this meeting is a live visit to the vendor's factory: the one that needs photographs and location. */
export const isLiveSiteVisit = (kind: VisitKind, enteredLater: boolean) => kind === 'site_visit' && !enteredLater

export function validateVisit(v: VisitDraft, ctx: VisitContext): FieldErrors<VisitField> {
  const e: FieldErrors<VisitField> = {}
  if (!v.person_met.trim()) e.person_met = 'Who did you meet?'
  if (v.discussion.trim().length < 3) e.discussion = 'Write a few words about the meeting'
  if (!v.outcome) e.outcome = 'Choose the outcome'
  if (v.outcome === 'follow_up_needed' && !v.next_follow_up_on) e.next_follow_up_on = 'Choose the follow-up date'
  if (v.next_follow_up_on && v.next_follow_up_on < ctx.today) e.next_follow_up_on = 'The date cannot be in the past'
  if (ctx.enteredLater) {
    if (!v.visited_on) e.visited_on = 'Choose the day it happened'
    else if (v.visited_on > ctx.today) e.visited_on = 'The day cannot be in the future'
  }
  if (isLiveSiteVisit(ctx.kind, ctx.enteredLater)) {
    if (ctx.photoKinds.length === 0) e.photos = 'Add at least one photograph'
    else if (ctx.needsFactoryPhoto && !ctx.photoKinds.includes('factory')) e.photos = 'The first visit needs a photograph of the factory'
  }
  return e
}
