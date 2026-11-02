// Sales, Lead Master: the words and limits the screens and the database share. The database is the authority
// (20270524000000_sales_lead_master.sql); these copies let the form say no before a round trip, so keep them equal.

/** The ten places a lead can come from. The values are what the database stores. */
export const LEAD_SOURCES = [
  { value: 'website', label: 'Website' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'insta_promo', label: 'Insta Promo' },
  { value: 'facebook_promo', label: 'Facebook Promo' },
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'reference', label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'others', label: 'Others' },
] as const

export type LeadSource = typeof LEAD_SOURCES[number]['value']
export const LEAD_SOURCE_VALUES: readonly LeadSource[] = LEAD_SOURCES.map(s => s.value)

/** A stored value this screen does not know still reads as itself, never as a blank. */
export function sourceLabel(value: string): string {
  return LEAD_SOURCES.find(s => s.value === value)?.label ?? value
}

/** The period cards. The database counts them all at once and ignores every other filter. */
export const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
] as const

export type Period = typeof PERIODS[number]['key']
export const PERIOD_KEYS: readonly Period[] = PERIODS.map(p => p.key)

export const MAX_NAME = 120
export const MAX_EMAIL = 120
export const MAX_LOCATION = 120
export const MAX_REQUIREMENT = 4000
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** The database clamps a page to 100; the screen asks for this many and offers "Show more". */
export const PAGE_SIZE = 50

/** Country codes offered beside the number box. "Other" means the person types the whole number starting with +. */
export const COUNTRY_CODES = [
  { value: '91', label: '+91 India' },
  { value: '971', label: '+971 UAE' },
  { value: '1', label: '+1 US / Canada' },
  { value: '44', label: '+44 UK' },
  { value: '', label: 'Other: type +…' },
] as const
