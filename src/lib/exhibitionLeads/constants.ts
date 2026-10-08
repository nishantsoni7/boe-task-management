// Exhibition Leads — the closed vocabularies, shared by the form, the list, the
// CSV and the tests. The slugs are what the database stores (and CHECKs); the
// labels are what people read. Changing a slug is a migration.

export const EXHIBITION_LEADS_MODULE_KEY = 'exhibition_leads'

export const CLIENT_TYPES = [
  { value: 'architect_designer', label: 'Architect / Interior Designer' },
  { value: 'property_owner', label: 'Property Owner' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'other', label: 'Other' },
] as const

export const REQUIREMENTS = [
  { value: 'restaurant_cafe', label: 'Restaurant / Cafe' },
  { value: 'hotel', label: 'Hotel' },
] as const

export const BUYING_TIMELINES = [
  { value: 'within_1_month', label: 'Within 1 month' },
  { value: '1_3_months', label: '1–3 months' },
  { value: '3_6_months', label: '3–6 months' },
  { value: 'later', label: 'Later' },
  { value: 'not_sure', label: 'Not sure' },
] as const

/**
 * Lead Type — mandatory, no default. `label` is the name shown everywhere (form,
 * lists, filters, CSV); `hint` is the explanation, kept out of sight until the
 * small "i" beside the option is tapped.
 */
export const LEAD_TYPES = [
  { value: 'hot', label: 'Hot', hint: 'Immediate RFQs / Active Site Plan' },
  { value: 'warm', label: 'Warm', hint: 'Sourcing for Pipeline Projects' },
  { value: 'long_term', label: 'Long Term', hint: 'General Networking & Future Roster' },
  { value: 'mismatched_retail', label: 'Mismatched / Retail Inquiries', hint: 'Low Priority' },
] as const

/** The colour that goes with each lead type on the entry form (and nowhere that carries meaning alone: the name is always written). */
export const LEAD_TYPE_ACCENTS: Readonly<Record<string, string>> = {
  hot: '#DC1F2E',
  warm: '#D97706',
  long_term: '#2563EB',
  mismatched_retail: '#7C8493',
}

export const leadTypeLabel = (value: string | null | undefined): string =>
  value ? (LEAD_TYPES.find(t => t.value === value)?.label ?? value) : ''

export const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'quotation_sent', label: 'Quotation Sent' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'converted', label: 'Converted' },
  { value: 'not_proceeding', label: 'Not Proceeding' },
] as const

export const FOLLOW_UP_FILTERS = [
  { value: 'due_today', label: 'Due today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'not_scheduled', label: 'Not scheduled' },
] as const

export const TERMINAL_STATUSES = ['converted', 'not_proceeding'] as const

export type ClientType = (typeof CLIENT_TYPES)[number]['value']
export type Requirement = (typeof REQUIREMENTS)[number]['value']
export type BuyingTimeline = (typeof BUYING_TIMELINES)[number]['value']
export type LeadType = (typeof LEAD_TYPES)[number]['value']
export type LeadStatus = (typeof STATUSES)[number]['value']
export type FollowUpFilter = (typeof FOLLOW_UP_FILTERS)[number]['value']

type Option = { readonly value: string; readonly label: string }

export function optionValues<const T extends readonly Option[]>(options: T): T[number]['value'][] {
  return options.map(o => o.value)
}

export function labelOf(options: readonly Option[], value: string | null | undefined): string {
  if (!value) return ''
  return options.find(o => o.value === value)?.label ?? value
}

export const requirementsLabel = (list: readonly string[]) =>
  list.map(v => labelOf(REQUIREMENTS, v)).join(', ')

/** "Property Owner", or "Other: <what the salesperson wrote>". */
export function clientTypeText(l: { client_type: string; client_type_other?: string | null }): string {
  const base = labelOf(CLIENT_TYPES, l.client_type)
  return l.client_type === 'other' && l.client_type_other ? `${base}: ${l.client_type_other}` : base
}

export const isTerminalStatus = (status: string) =>
  (TERMINAL_STATUSES as readonly string[]).includes(status)

/** The exhibition row the form preselects. */
export type Exhibition = {
  id: string
  slug: string
  name: string
  city: string | null
  starts_on: string
  ends_on: string
  /** false = closed: takes no new leads, but its leads and ranking stay available. */
  is_active: boolean
}

export type Lead = {
  id: string
  exhibition_id: string
  /** Which exhibition the lead belongs to (shown when a list spans exhibitions). */
  exhibition_name?: string | null
  contact_name: string
  phone: string
  client_type: ClientType
  /** The message that goes with client_type = 'other'; null for every other type. */
  client_type_other: string | null
  requirements: Requirement[]
  company_name: string | null
  project_city: string | null
  buying_timeline: BuyingTimeline | null
  lead_type: LeadType
  status: LeadStatus
  next_follow_up_on: string | null
  initial_note: string | null
  collected_by: string
  collected_by_name: string | null
  owner_id: string
  owner_name: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  archive_reason: string | null
  latest_note: string | null
  latest_note_at: string | null
}

export type LeadEvent = {
  id: string
  event_type: 'created' | 'details_edited' | 'status_changed' | 'follow_up_changed'
    | 'note' | 'reassigned' | 'archived' | 'restored'
  note: string | null
  detail: Record<string, unknown>
  created_at: string
  actor_id: string
  actor_name: string | null
}
