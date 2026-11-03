import type { createClient } from '@/lib/supabase/client'
import type { ClientType, NeededFact, Segment, Stage, Temperature } from './board'
import type { HistoryRow, ImportRow } from './clickup'
import type { SheetRow } from './sheets'
import type { LeadSource, Period } from './constants'

// Thin typed wrappers over the database functions (20270524000000). There is no API route in between on purpose:
// every function reads auth.uid() itself, so the browser's own session IS the identity, and the database decides
// what is allowed. The screens only decide what to SHOW.

type Supabase = ReturnType<typeof createClient>

export type SalesLead = {
  id: string
  lead_no: number
  /** The day it came in, in India, as YYYY-MM-DD. */
  received_on: string
  /** The one stored format: +<country><digits>. */
  phone: string
  source: LeadSource
  name: string | null
  email: string | null
  location: string | null
  requirement: string | null
  /** Null = not allotted yet. */
  assigned_to: string | null
  holder_name: string | null
  assigned_at: string | null
  /** The version of the lead: an edit sends it back, and is refused if the lead has changed since. */
  updated_at: string
  /** An old lead from the sheets, kept for the record: on nobody's board and not in the Not allotted queue. */
  is_history?: boolean
  /** Why it is Premium, read from what the client wrote ("250 seats", "₹20 lakh"); null when it is not. */
  premium?: string | null
}

export type LeadPage = {
  periods: Record<Period, number>
  /** How many leads the period, source and search select, before the "Allotted to" filter. */
  everyone: number
  unallotted: number
  holders: { id: string; name: string; n: number }[]
  /** How many match everything including the "Allotted to" filter. */
  total: number
  rows: SalesLead[]
}

export type LeadEvent = {
  kind: 'added' | 'allotted' | 'reassigned' | 'edited' | 'moved' | 'enquired_again' | 'imported' | 'clickup_status'
  from_name: string | null
  to_name: string | null
  /** For an edit: which fields changed, never their values. */
  detail: string | null
  actor_name: string | null
  at: string
}

export type LeadDetail = { lead: SalesLead; events: LeadEvent[] }

export type PhoneCheck =
  | { state: 'invalid' }
  | { state: 'free'; phone: string }
  | { state: 'exists'; phone: string; lead: SalesLead }

/** 'duplicate' means nothing was saved: the number already belongs to `lead`. */
export type SaveResult =
  | { status: 'created' | 'saved' | 'unchanged'; lead: SalesLead }
  | { status: 'duplicate'; lead: SalesLead }

export type LeadInput = {
  /** Already joined with the country code. The database normalises it again. */
  phone: string
  source: LeadSource
  name: string
  email: string
  location: string
  requirement: string
}

export type Person = { id: string; full_name: string }

export type SalesErrorKind = 'auth' | 'forbidden' | 'not_found' | 'changed' | 'invalid' | 'uncertain' | 'unknown'

export class SalesRequestError extends Error {
  readonly kind: SalesErrorKind
  constructor(kind: SalesErrorKind, message: string) {
    super(message)
    this.name = 'SalesRequestError'
    this.kind = kind
  }
}

type Raw = { message?: string; code?: string; status?: number } | null | undefined

const AFTER_PREFIX = /^SALES_[A-Z_]*:\s*/

/** Turn what the database or the network says into a sentence a person can act on. */
export function classifySalesError(err: Raw): SalesRequestError {
  const message = (err?.message ?? '').trim()
  const code = err?.code ?? ''
  if (/JWT|not authenticated|Auth session missing/i.test(message) || code === 'PGRST301' || err?.status === 401) {
    return new SalesRequestError('auth', 'Your session has expired. Sign in again; what you typed is kept on this page.')
  }
  if (message.startsWith('SALES_FORBIDDEN') || code === '42501') {
    return new SalesRequestError('forbidden', 'You do not have access to this.')
  }
  if (message.startsWith('SALES_NOT_FOUND')) return new SalesRequestError('not_found', 'This lead is not available.')
  if (message.startsWith('SALES_CHANGED')) {
    return new SalesRequestError('changed', message.replace(AFTER_PREFIX, '') || 'Somebody changed who holds this lead.')
  }
  if (message.startsWith('SALES_INVALID')) {
    return new SalesRequestError('invalid', message.replace(AFTER_PREFIX, '') || 'Check the details and try again.')
  }
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i.test(message) || err?.status === 0) {
    return new SalesRequestError('uncertain', 'Could not confirm the save. Nothing is lost: try again.')
  }
  return new SalesRequestError('unknown', 'Something went wrong. Nothing was confirmed saved: try again.')
}

type RpcResult<T> = { data: T | null; error: Raw }

async function call<T>(run: () => PromiseLike<RpcResult<T>>): Promise<T> {
  let res: RpcResult<T>
  try {
    res = await run()
  } catch (e) {
    throw classifySalesError({ message: e instanceof Error ? e.message : 'Failed to fetch', status: 0 })
  }
  if (res.error) throw classifySalesError(res.error)
  return res.data as T
}

export const SALES_KEY = 'sales-leads'

export type LeadFilter = {
  period: Period
  /** '' = everyone, 'none' = not allotted, or a user id. */
  holder: string
  /** '' = every source. */
  source: string
  q: string
  limit: number
  offset: number
}

export const fetchLeadPage = (s: Supabase, f: LeadFilter) =>
  call<LeadPage>(() => s.rpc('sales_leads_page', {
    p_period: f.period,
    p_holder: f.holder || 'all',
    p_source: f.source || null,
    p_q: f.q || null,
    p_limit: f.limit,
    p_offset: f.offset,
  }))

export const fetchLead = (s: Supabase, id: string) =>
  call<LeadDetail>(() => s.rpc('get_sales_lead', { p_id: id }))

export const checkPhone = (s: Supabase, phone: string) =>
  call<PhoneCheck>(() => s.rpc('sales_lead_phone_check', { p_phone: phone }))

const blankToNull = (v: string) => (v.trim() === '' ? null : v)

export const createLead = (s: Supabase, i: LeadInput) =>
  call<SaveResult>(() => s.rpc('create_sales_lead', {
    p_phone: i.phone, p_source: i.source, p_name: blankToNull(i.name), p_email: blankToNull(i.email),
    p_location: blankToNull(i.location), p_requirement: blankToNull(i.requirement),
  }))

/** `expectedUpdatedAt` is the version the person started editing (SalesLead.updated_at): the database refuses the edit if the lead has changed since. */
export const updateLead = (s: Supabase, id: string, i: LeadInput, expectedUpdatedAt: string) =>
  call<SaveResult>(() => s.rpc('update_sales_lead', {
    p_id: id, p_phone: i.phone, p_source: i.source, p_name: blankToNull(i.name), p_email: blankToNull(i.email),
    p_location: blankToNull(i.location), p_requirement: blankToNull(i.requirement),
    p_expected_updated_at: expectedUpdatedAt,
  }))

/** `expectedFrom` is who the screen showed as holding the lead (null = not allotted): the database refuses the change if that is stale. */
export const allotLead = (s: Supabase, id: string, to: string, expectedFrom: string | null) =>
  call<SaveResult>(() => s.rpc('allot_sales_lead', { p_id: id, p_to: to, p_expected_from: expectedFrom }))

// ── The Lead Board (20270525000000) ─────────────────────────────────────────

/** A lead as My day, the board and the lead panel read it. */
export type WorkLead = SalesLead & {
  stage: Stage
  temperature: Temperature
  segment: Segment | null
  client_type: ClientType | null
  market: 'domestic' | 'export'
  quantity: string | null
  timeline: string | null
  expected_value_paise: number | null
  next_step: string | null
  next_due_on: string | null
  first_attempt_at: string | null
  first_contact_at: string | null
  last_activity_at: string | null
  last_kind: string | null
  no_answer_streak: number
  enquired_again_at: string | null
  dead_reason: string | null
  dead_note: string | null
  closed_at: string | null
  stuck: boolean
}

export type Activity = {
  id: string
  kind: string
  outcome: string
  note: string | null
  next_step: string | null
  next_due_on: string | null
  actor_name: string | null
  at: string
}

export type WorkDetail = {
  /** What ClickUp held for this lead, as exported. Empty for a lead added in BOE One. */
  clickup: Record<string, string>[]
  lead: WorkLead
  /** What to show. The writes decide again for themselves. */
  can_work: boolean
  quotation_sent: boolean
  events: LeadEvent[]
  activities: Activity[]
}

export type MyDay = { rows: WorkLead[]; done_today: number; coming_up: number }

export type BoardData = {
  stats: { open: number; value_paise: number; overdue: number; due_today: number; stuck: number }
  /** The real count and value of each stage, whatever is loaded. Closed stages cover the last 30 days. */
  stages: Partial<Record<Stage, { n: number; value_paise: number }>>
  rows: WorkLead[]
  holders: { id: string; name: string; n: number }[]
  /** Null unless this person can do something about the queue. */
  waiting_allotment: number | null
}

export type BoardFilter = { holder: string; market: string; segment: string; temperature: string; source: string; q: string }

export type WorkResult = { status: 'saved'; activity_id?: string; streak?: number; lead: WorkLead }
export type MoveResult =
  | { status: 'moved' | 'unchanged'; lead: WorkLead }
  | { status: 'needs'; missing: NeededFact[]; lead: WorkLead }

export type LeadFacts = Partial<{
  name: string; email: string; location: string; requirement: string; quantity: string; timeline: string
  segment: string; client_type: string; temperature: string; expected_value_paise: number | string
}>

export const fetchMyDay = (s: Supabase) => call<MyDay>(() => s.rpc('sales_my_day'))

export const fetchBoard = (s: Supabase, f: BoardFilter) =>
  call<BoardData>(() => s.rpc('sales_board', {
    p_holder: f.holder || 'all', p_market: f.market || null, p_segment: f.segment || null,
    p_temperature: f.temperature || null, p_source: f.source || null, p_q: f.q || null,
  }))

export const fetchWorkLead = (s: Supabase, id: string) =>
  call<WorkDetail>(() => s.rpc('get_sales_lead', { p_id: id }))

export const logActivity = (s: Supabase, id: string, a: { kind: string; outcome: string; note: string; nextStep: string; nextDue: string }) =>
  call<WorkResult>(() => s.rpc('log_sales_lead_activity', {
    p_id: id, p_kind: a.kind, p_outcome: a.outcome, p_note: blankToNull(a.note), p_next_step: a.nextStep, p_next_due: a.nextDue,
  }))

export const logNoAnswer = (s: Supabase, id: string) =>
  call<WorkResult>(() => s.rpc('sales_lead_no_answer', { p_id: id }))

export const logMessageSent = (s: Supabase, id: string, label: string) =>
  call<WorkResult>(() => s.rpc('sales_lead_message_sent', { p_id: id, p_label: label }))

export const undoActivity = (s: Supabase, activityId: string) =>
  call<WorkResult>(() => s.rpc('undo_sales_lead_activity', { p_activity: activityId }))

export const moveLead = (s: Supabase, id: string, to: Stage, from: Stage, extra: { reason?: string; note?: string; nextStep?: string; nextDue?: string } = {}) =>
  call<MoveResult>(() => s.rpc('move_sales_lead', {
    p_id: id, p_to: to, p_expected_from: from, p_reason: extra.reason ?? null, p_note: extra.note ? blankToNull(extra.note) : null,
    p_next_step: extra.nextStep ?? null, p_next_due: extra.nextDue ?? null,
  }))

export const updateFacts = (s: Supabase, id: string, facts: LeadFacts) =>
  call<WorkResult>(() => s.rpc('update_sales_lead_facts', { p_id: id, p_facts: facts }))

export const recordEnquiry = (s: Supabase, id: string, source: string, note = '') =>
  call<SaveResult>(() => s.rpc('record_sales_lead_enquiry', { p_id: id, p_source: source, p_note: blankToNull(note) }))

export type ImportOutcome = { created: number; merged: number; already: number; failed: { task_id: string | null; why: string }[] }

export const importLeads = (s: Supabase, rows: ImportRow[]) =>
  call<ImportOutcome>(() => s.rpc('import_sales_leads', { p_rows: rows }))

export type HistoryOutcome = { comments: number; statuses: number; already: number; not_imported: number; failed: { task_id: string | null; why: string }[] }

export type SheetOutcome = { history: number; filled: number; already: number; failed: { phone: string | null; why: string }[] }

export const importSheet = (s: Supabase, rows: SheetRow[]) =>
  call<SheetOutcome>(() => s.rpc('import_sales_lead_sheet', { p_rows: rows }))

export const importHistory = (s: Supabase, rows: HistoryRow[]) =>
  call<HistoryOutcome>(() => s.rpc('import_sales_lead_history', { p_rows: rows }))

export type TeamRisk = WorkLead & { problem: 'not_called' | 'stuck' | 'overdue' }
export type TeamPersonRow = {
  id: string
  name: string
  leads: number
  open: number
  first_call_on_time: number
  first_call_total: number
  followups_on_time: number
  followups_total: number
  stuck: number
  converted: number
}
export type TeamData = {
  tiles: { leads: number; converted: number; first_call_on_time: number; first_call_total: number; followups_on_time: number; followups_total: number }
  funnel: { rank: number; n: number }[]
  reasons: { reason: string; n: number }[]
  people: TeamPersonRow[]
  at_risk: TeamRisk[]
  at_risk_total: number
  absent: { id: string; name: string; due: number }[]
}

export const fetchTeam = (s: Supabase, from: string, market: string, holder: string) =>
  call<TeamData>(() => s.rpc('sales_team_overview', { p_from: from, p_market: market || null, p_holder: holder || null }))

export const remindLead = (s: Supabase, id: string) =>
  call<{ status: 'sent' | 'already' }>(() => s.rpc('sales_lead_remind', { p_id: id }))

export const reassignDue = (s: Supabase, from: string, to: string) =>
  call<{ moved: number }>(() => s.rpc('reassign_due_sales_leads', { p_from: from, p_to: to }))

/** Run the allotment rule now over every lead waiting to be allotted. */
export const allotWaiting = (s: Supabase) =>
  call<{ allotted: number }>(() => s.rpc('allot_waiting_sales_leads'))

/** Premium leads a Junior or Backup was given this week (the Team page offers to hand them on). */
export type MisplacedPremium = WorkLead & { level: 'junior' | 'backup' }
export const fetchPremiumMisplaced = (s: Supabase) =>
  call<MisplacedPremium[]>(() => s.rpc('sales_premium_misplaced'))

/** Who can be given a lead: everybody with a Sales job in Control Center (list_sales_lead_holders). */
export async function fetchPeople(s: Supabase): Promise<Person[]> {
  const rows = await call<{ id: string; full_name: string }[]>(() => s.rpc('list_sales_lead_holders'))
  return (rows ?? []).map(r => ({ id: r.id, full_name: r.full_name })).sort((a, b) => a.full_name.localeCompare(b.full_name))
}
