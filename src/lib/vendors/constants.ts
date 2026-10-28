// Vendors — the closed vocabularies, shared by the forms, the list, the CSV and the tests. The slugs are
// what the database stores (and CHECKs); the labels are what people read. Changing a slug is a migration.

export const VENDORS_MODULE_KEY = 'vendors'

export const CAPABILITIES = [
  { value: 'raw_pieces', label: 'Raw / semi-finished pieces' },
  { value: 'finished_pieces', label: 'Complete finished furniture' },
  { value: 'finishing_only', label: 'Finishing only' },
] as const

export const CATEGORIES = [
  { value: 'sofa_upholstery', label: 'Sofa / upholstery' },
  { value: 'chairs', label: 'Chairs' },
  { value: 'tables', label: 'Tables' },
  { value: 'beds', label: 'Beds' },
  { value: 'storage_cabinets', label: 'Storage / cabinets' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'metal_fabrication', label: 'Metal fabrication' },
  { value: 'wood_carving_turning', label: 'Wood carving / turning' },
  { value: 'polishing_finishing', label: 'Polishing / finishing' },
  { value: 'other', label: 'Other' },
] as const

export const VENDOR_STATUSES = [
  { value: 'potential', label: 'Potential' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'under_evaluation', label: 'Under evaluation' },
  { value: 'approved', label: 'Approved' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'rejected', label: 'Rejected' },
] as const

/** Before a site visit a vendor may be only a name; from 'prospect' on the full profile is required. */
export const PRE_VISIT_STATUSES = ['potential', 'contacted'] as const

/** What kind of meeting: we went to them (the proof event), or they came to our factory. */
export const VISIT_KINDS = [
  { value: 'site_visit', label: 'We visited their factory' },
  { value: 'vendor_at_our_factory', label: 'They visited our factory' },
] as const

export type VisitKind = (typeof VISIT_KINDS)[number]['value']

export const VISIT_OUTCOMES = [
  { value: 'interested', label: 'Interested' },
  { value: 'follow_up_needed', label: 'Follow-up needed' },
  { value: 'sample_requested', label: 'Sample requested' },
  { value: 'approved_to_start', label: 'Approved to start' },
  { value: 'not_suitable', label: 'Not suitable' },
] as const

export const PHOTO_KINDS = [
  { value: 'factory', label: 'Factory / workshop' },
  { value: 'person', label: 'Person met' },
  { value: 'product', label: 'Products / samples' },
  { value: 'other', label: 'Other' },
] as const

export type PhotoKind = (typeof PHOTO_KINDS)[number]['value']

export const MAX_PHOTOS_PER_VISIT = 12
/** A visit this close (metres) to the vendor's address point counts as "at the site". */
export const AT_SITE_METRES = 500

type Option = { readonly value: string; readonly label: string }

export const labelOf = (options: readonly Option[], value: string | null | undefined): string =>
  options.find(o => o.value === value)?.label ?? (value ?? '')

export const labelsOf = (options: readonly Option[], values: readonly string[] | null | undefined): string =>
  (values ?? []).map(v => labelOf(options, v)).join(', ')

export type VendorSummary = {
  id: string
  company_name: string
  contact_name: string | null
  phone: string | null
  city: string | null
  status: string
  referred_by: string | null
  capabilities: string[]
  categories: string[]
  headcount: number | null
  created_at: string
  archived: boolean
  visit_count: number
  site_visit_count: number
  inbound_count: number
  awaiting_site_visit: boolean
  last_visit_at: string | null
  last_visited_by: string | null
  days_since_visit: number | null
}

export type VendorPage = { total: number; awaiting_count: number; status_counts: Record<string, number>; rows: VendorSummary[] }

export type Vendor = {
  id: string
  company_name: string
  contact_name: string | null
  phone: string | null
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  capabilities: string[]
  categories: string[]
  headcount: number | null
  referred_by: string | null
  notes: string | null
  status: string
  profile_complete: boolean
  awaiting_site_visit: boolean
  created_at: string
  created_by_name: string | null
  updated_at: string
  archived: boolean
  archive_reason: string | null
}

export type VisitPhoto = { path: string; kind: PhotoKind }

export type Visit = {
  id: string
  visited_at: string
  visited_by: string
  visited_by_name: string | null
  kind: VisitKind
  entered_later: boolean
  recorded_at: string
  person_met: string
  discussion: string
  outcome: string
  next_follow_up_on: string | null
  location_source: 'gps' | 'unavailable' | 'not_applicable'
  latitude: number | null
  longitude: number | null
  accuracy_m: number | null
  distance_m: number | null
  photos: VisitPhoto[]
}

export type VendorDetail = { vendor: Vendor; visits: Visit[] }

export type ActivityPerson = {
  user_id: string
  name: string | null
  visits: number
  vendors_visited: number
  repeat_visits: number
  at_site: number
  no_location: number
  first_visit: string
  last_visit: string
  vendors_added: number
  at_our_factory: number
  entered_later: number
}

export type Activity = {
  from: string
  to: string
  past_entries_until: string | null
  pipeline: { potential: number; contacted: number; registered: number }
  totals: { visits: number; vendors_visited: number; at_site: number; no_location: number; at_our_factory: number; entered_later: number }
  by_person: ActivityPerson[]
  by_day: { day: string; visits: number }[]
  awaiting_site_visit: { id: string; company_name: string; city: string | null; status: string; first_met_at: string; days_waiting: number }[]
  quiet_vendors: { id: string; company_name: string; city: string | null; status: string; last_visit_at: string | null; days_since_visit: number | null }[]
  follow_ups_due: { vendor_id: string; company_name: string; next_follow_up_on: string; visited_by_name: string | null }[]
}
