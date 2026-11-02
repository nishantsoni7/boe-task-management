import type { createClient } from '@/lib/supabase/client'
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
  kind: 'added' | 'allotted' | 'reassigned' | 'edited'
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

/** Who can be given a lead: the same "sales candidate" rule Orders uses (active, in Sales or granted it). */
export async function fetchPeople(s: Supabase): Promise<Person[]> {
  const rows = await call<{ id: string; full_name: string }[]>(() => s.rpc('list_eligible_order_assignees'))
  return (rows ?? []).map(r => ({ id: r.id, full_name: r.full_name })).sort((a, b) => a.full_name.localeCompare(b.full_name))
}
