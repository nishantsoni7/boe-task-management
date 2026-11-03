import { istAddDays } from '@/lib/istDate'

// Sales, Lead Board: the words and the small rules My day, the board and the lead panel share. The database is the
// authority on what may happen (20270525000000_sales_lead_board.sql); nothing here decides that.

export const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'under_process', label: 'Under process' },
  { key: 'potential', label: 'Potential client' },
  { key: 'negotiation', label: 'Negotiation' },
  { key: 'follow_up_later', label: 'Follow up later' },
  { key: 'converted', label: 'Converted' },
  { key: 'dead', label: 'Dead' },
] as const

export type Stage = typeof STAGES[number]['key']
export const STAGE_KEYS: readonly Stage[] = STAGES.map(s => s.key)
export const stageLabel = (stage: string) => STAGES.find(s => s.key === stage)?.label ?? stage

/** The columns of the board. Converted and Dead are the two ways out, drawn apart. */
export const BOARD_STAGES: readonly Stage[] = ['new', 'under_process', 'potential', 'negotiation', 'follow_up_later']
/** The bar across the top of a lead. Follow up later and Dead are not steps of a sale. */
export const PATH_STAGES: readonly Stage[] = ['new', 'under_process', 'potential', 'negotiation', 'converted']

/** One line telling the salesperson what this stage is for. */
export const STAGE_GUIDE: Partial<Record<Stage, string>> = {
  new: 'Call within the hour. Find out what they need.',
  under_process: 'Find out what they need, how much, and for which project.',
  potential: 'Send the quotation. Confirm the budget and when they need it.',
  negotiation: 'Agree the price and delivery. Find out who signs off.',
}

export const NEXT_STAGE: Partial<Record<Stage, Stage>> = { new: 'under_process', under_process: 'potential', potential: 'negotiation' }

export const TEMPERATURES = [
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Cold' },
] as const
export type Temperature = typeof TEMPERATURES[number]['value']
export const TEMPERATURE_VALUES: readonly Temperature[] = TEMPERATURES.map(t => t.value)

export const SEGMENTS = [
  { value: 'bulk', label: 'Bulk' },
  { value: 'residential', label: 'Residential' },
  { value: 'reseller', label: 'Reseller' },
] as const
export type Segment = typeof SEGMENTS[number]['value']
export const SEGMENT_VALUES: readonly Segment[] = SEGMENTS.map(t => t.value)

export const CLIENT_TYPES = [
  { value: 'hotel', label: 'Hotel' },
  { value: 'resort', label: 'Resort' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'cafe', label: 'Cafe' },
  { value: 'other', label: 'Other' },
] as const
export type ClientType = typeof CLIENT_TYPES[number]['value']

export const MARKETS = [
  { value: 'domestic', label: 'Domestic' },
  { value: 'export', label: 'Export' },
] as const
export const MARKET_VALUES = ['domestic', 'export'] as const

export const KINDS = [
  { value: 'call', label: 'Call' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'email', label: 'Email' },
  { value: 'quotation', label: 'Quotation' },
  { value: 'sample', label: 'Sample' },
] as const
export type ActivityKind = typeof KINDS[number]['value']
export const kindLabel = (kind: string) => KINDS.find(k => k.value === kind)?.label ?? kind

/** The answers on the log form. "Not interested" is not stored as an outcome: it asks why the lead is dead instead. */
export const OUTCOMES = [
  { value: 'interested', label: 'Interested', step: 'Call: send quotation', inDays: 3 },
  { value: 'still_deciding', label: 'Still deciding', step: 'Call back', inDays: 7 },
  { value: 'call_back', label: 'Call back', step: 'Call back', inDays: 1 },
  { value: 'not_interested', label: 'Not interested', step: '', inDays: 0 },
] as const
export type OutcomeChoice = typeof OUTCOMES[number]['value']

const OUTCOME_WORDS: Record<string, string> = {
  interested: 'Interested', still_deciding: 'Still deciding', call_back: 'Call back', no_answer: 'No answer', sent: 'Sent',
}
export const outcomeLabel = (outcome: string) => OUTCOME_WORDS[outcome] ?? outcome

export const NEXT_STEPS = ['Call: send quotation', 'Call back', 'WhatsApp: send catalogue', 'Meeting', 'Send sample'] as const

export const WHEN_CHOICES = [
  { key: 1, label: 'Tomorrow' },
  { key: 3, label: 'In 3 days' },
  { key: 7, label: 'Next week' },
] as const

export const DEAD_REASONS = [
  { value: 'price_too_high', label: 'Price too high' },
  { value: 'chose_another_supplier', label: 'Chose another supplier' },
  { value: 'not_responding', label: 'Not responding' },
  { value: 'quantity_too_small', label: 'Quantity too small for us' },
  { value: 'project_cancelled', label: 'Project cancelled or postponed' },
  { value: 'delivery_time', label: 'Delivery time did not suit' },
  { value: 'retail_enquiry', label: 'Retail enquiry, not our business' },
  { value: 'wrong_number', label: 'Wrong number or spam' },
  { value: 'no_requirement', label: 'No requirement' },
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'other', label: 'Other (say why)' },
] as const
export type DeadReason = typeof DEAD_REASONS[number]['value']
export const deadReasonLabel = (reason: string | null) => DEAD_REASONS.find(r => r.value === reason)?.label ?? 'Dead'

/** What the database says is still missing before a move forward. */
export type NeededFact = 'contact' | 'requirement' | 'quantity' | 'quotation' | 'value' | 'timeline'
export const FACT_LABELS: Record<NeededFact, string> = {
  contact: 'First contact', requirement: 'Requirement', quantity: 'Quantity', quotation: 'Quotation', value: 'Expected value', timeline: 'Timeline',
}
/** The facts a person can type; the other two are things that have to happen, and are logged. */
export const TYPED_FACTS: readonly NeededFact[] = ['requirement', 'quantity', 'value', 'timeline']
export const FACT_HINTS: Partial<Record<NeededFact, string>> = {
  requirement: 'What do they want?', quantity: 'e.g. 80 chairs, 20 tables', value: 'Expected value in ₹', timeline: 'When do they need it?',
}

type Facts = {
  stage: string
  first_contact_at: string | null
  requirement: string | null
  quantity: string | null
  timeline: string | null
  expected_value_paise: number | null
}

export type CheckItem = { fact: NeededFact; label: string; value: string | null; done: boolean }

/** What this lead needs before its next stage. Null when the next step of the sale has no checklist. */
export function checklistFor(lead: Facts, quotationSent: boolean): { to: Stage; items: CheckItem[]; left: number } | null {
  const to = NEXT_STAGE[lead.stage as Stage]
  if (!to) return null
  const item = (fact: NeededFact, value: string | null, done = value !== null): CheckItem => ({ fact, label: FACT_LABELS[fact], value, done })
  const items = to === 'under_process'
    ? [item('contact', lead.first_contact_at ? 'Logged' : null)]
    : to === 'potential'
      ? [item('requirement', lead.requirement), item('quantity', lead.quantity)]
      : [
          item('quotation', quotationSent ? 'Sent' : null),
          item('value', lead.expected_value_paise === null ? null : valueLabel(lead.expected_value_paise)),
          item('timeline', lead.timeline),
        ]
  return { to, items, left: items.filter(i => !i.done).length }
}

/** "₹ 14 L", "₹ 1.4 Cr", "₹ 85,000". Whole rupees under a lakh, one decimal at most above it. */
export function valueLabel(paise: number): string {
  const rupees = paise / 100
  const short = (n: number) => String(Math.round(n * 10) / 10)
  if (rupees >= 1_00_00_000) return `₹ ${short(rupees / 1_00_00_000)} Cr`
  if (rupees >= 1_00_000) return `₹ ${short(rupees / 1_00_000)} L`
  return `₹ ${Math.round(rupees).toLocaleString('en-IN')}`
}

/** What a person typed as rupees, as paise. Accepts "14,00,000" and "14 L". Null when it is not an amount. */
export function parseValue(text: string): number | null {
  const m = /^\s*₹?\s*([\d,]*\.?\d+)\s*(l|lakh|lac|cr|crore)?\s*$/i.exec(text)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? '').toLowerCase()
  const rupees = unit.startsWith('c') ? n * 1_00_00_000 : unit ? n * 1_00_000 : n
  return Math.round(rupees * 100)
}

// Longest code first: country codes never prefix one another, so the first match is the only match.
const COUNTRIES: readonly (readonly [string, string])[] = [
  ['971', 'UAE'], ['974', 'Qatar'], ['966', 'Saudi Arabia'], ['968', 'Oman'], ['965', 'Kuwait'], ['973', 'Bahrain'],
  ['254', 'Kenya'], ['255', 'Tanzania'], ['256', 'Uganda'], ['234', 'Nigeria'], ['977', 'Nepal'], ['880', 'Bangladesh'],
  ['960', 'Maldives'], ['27', 'South Africa'], ['94', 'Sri Lanka'], ['65', 'Singapore'], ['60', 'Malaysia'], ['66', 'Thailand'],
  ['62', 'Indonesia'], ['61', 'Australia'], ['64', 'New Zealand'], ['44', 'UK'], ['49', 'Germany'], ['33', 'France'],
  ['31', 'Netherlands'], ['34', 'Spain'], ['39', 'Italy'], ['81', 'Japan'], ['1', 'USA / Canada'],
]

export function countryOf(phone: string): string | null {
  const digits = phone.replace(/^\+/, '')
  return COUNTRIES.find(([code]) => digits.startsWith(code))?.[1] ?? null
}

export function marketLabel(lead: { market: string; phone: string }): string {
  if (lead.market !== 'export') return 'Domestic'
  const country = countryOf(lead.phone)
  return country ? `Export · ${country}` : 'Export'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDay = (date: string) => {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export type Tone = 'over' | 'today' | 'plain'

type Dated = { stage: string; next_due_on: string | null; dead_reason?: string | null }

/** When the next step is due, in words. */
export function dueOf(lead: Dated, today: string): { label: string; tone: Tone } {
  if (lead.stage === 'converted') return { label: 'Converted', tone: 'plain' }
  if (lead.stage === 'dead') return { label: deadReasonLabel(lead.dead_reason ?? null), tone: 'plain' }
  if (!lead.next_due_on) return { label: 'No date', tone: 'plain' }
  const days = daysBetween(today, lead.next_due_on)
  // A parked lead has no deadline, only a day it comes back.
  if (lead.stage === 'follow_up_later' && days > 0) return { label: `Wakes ${shortDay(lead.next_due_on)}`, tone: 'plain' }
  if (days < 0) return { label: `Overdue ${-days} d`, tone: 'over' }
  if (days === 0) return { label: 'Today', tone: 'today' }
  if (days === 1) return { label: 'Tomorrow', tone: 'plain' }
  return { label: shortDay(lead.next_due_on), tone: 'plain' }
}

type Clocked = {
  stuck: boolean
  first_attempt_at: string | null
  assigned_at: string | null
  last_activity_at: string | null
  stage: string
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * The warning beside the date. A new lead nobody has tried counts up from the moment it was allotted, which is the
 * clock the first-response target runs on. Anything else only speaks up when the database says it is stuck.
 */
export function flagOf(lead: Clocked, now: number): { kind: 'waiting' | 'stuck'; label: string; red: boolean } | null {
  if (['converted', 'dead', 'follow_up_later'].includes(lead.stage)) return null
  if (!lead.first_attempt_at && lead.assigned_at) {
    const waited = Math.max(0, now - Date.parse(lead.assigned_at))
    const text = waited < HOUR ? `${Math.floor(waited / 60_000)} min` : waited < DAY ? `${Math.floor(waited / HOUR)} h` : `${Math.floor(waited / DAY)} d`
    return { kind: 'waiting', label: `Waiting ${text}`, red: lead.stuck }
  }
  if (!lead.stuck) return null
  const since = lead.last_activity_at ?? lead.assigned_at
  return { kind: 'stuck', label: since ? `Stuck ${Math.max(1, Math.floor((now - Date.parse(since)) / DAY))} d` : 'Stuck', red: true }
}

type Ranked = Clocked & { temperature: string; expected_value_paise: number | null; next_due_on: string | null; enquired_again_at: string | null }

const TEMPERATURE_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 }
const notTried = (l: Ranked) => !l.first_attempt_at

/** My day's order: a lead nobody has called, then Hot, then the biggest value, then the longest overdue. */
export function rankMyDay<T extends Ranked>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    Number(notTried(b)) - Number(notTried(a))
    || (TEMPERATURE_RANK[a.temperature] ?? 3) - (TEMPERATURE_RANK[b.temperature] ?? 3)
    || (b.expected_value_paise ?? 0) - (a.expected_value_paise ?? 0)
    || (a.next_due_on ?? '').localeCompare(b.next_due_on ?? ''))
}

/** The line that says why this lead is on top, so the order never feels random. */
export function whyFirst(lead: Ranked, today: string): string {
  if (lead.enquired_again_at && !lead.last_activity_at) return 'Came back with a new enquiry'
  if (notTried(lead)) return 'New lead, nobody has called yet'
  const overdue = !!lead.next_due_on && lead.next_due_on < today
  if (lead.temperature === 'hot') return overdue ? 'Hot and overdue' : 'Hot, due today'
  return overdue ? 'Overdue' : 'Due today'
}

export function lastLabel(lead: { last_activity_at: string | null; last_kind: string | null }, today: string): string {
  if (!lead.last_activity_at) return 'No contact yet'
  const day = lead.last_activity_at.slice(0, 10)
  const days = daysBetween(day, today)
  const what = `Last ${kindLabel(lead.last_kind ?? '').toLowerCase()}`
  return days <= 0 ? `${what} today` : days === 1 ? `${what} yesterday` : `${what} ${days} d ago`
}

export const whenFrom = (today: string, days: number) => istAddDays(today, days)

export function quickMessages(sender: string): { label: string; text: string }[] {
  const me = sender.trim().split(/\s+/)[0] || 'the sales team'
  return [
    { label: 'Catalogue', text: `Hello, this is ${me} from Best of Exports. Here is our hospitality catalogue. Tell me which pieces suit your project and I will share prices.` },
    { label: 'Follow-up', text: `Hello, this is ${me} from Best of Exports, following up on your enquiry. Is this a good time to speak about your project?` },
    { label: 'Quotation reminder', text: `Hello, this is ${me} from Best of Exports. Did you get a chance to review our quotation? Happy to adjust it to your budget.` },
  ]
}

/** Opens WhatsApp with the message filled in. Nothing is sent until the person presses send. */
export const whatsAppLink = (phone: string, text?: string) =>
  `https://wa.me/${phone.replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`
