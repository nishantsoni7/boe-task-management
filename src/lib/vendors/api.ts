import type { createClient } from '@/lib/supabase/client'
import type { Activity, PhotoKind, VendorDetail, VendorPage, VisitKind } from './constants'

// Thin typed wrappers over the database functions. There is no API route in between on purpose: every
// function reads auth.uid() itself, so the browser's own session IS the identity.

type Supabase = ReturnType<typeof createClient>

export type VendorErrorKind = 'auth' | 'forbidden' | 'not_found' | 'archived' | 'duplicate_phone' | 'invalid' | 'uncertain' | 'unknown'

export class VendorRequestError extends Error {
  readonly kind: VendorErrorKind
  constructor(kind: VendorErrorKind, message: string) {
    super(message)
    this.name = 'VendorRequestError'
    this.kind = kind
  }
}

type Raw = { message?: string; code?: string; status?: number } | null | undefined

const AFTER_PREFIX = /^VENDOR[A-Z_]*:\s*/

/** Turn what the database or the network says into a sentence a person can act on. */
export function classifyVendorError(err: Raw): VendorRequestError {
  const message = (err?.message ?? '').trim()
  const code = err?.code ?? ''
  if (/JWT|not authenticated|Auth session missing/i.test(message) || code === 'PGRST301' || err?.status === 401) {
    return new VendorRequestError('auth', 'Your session has expired. Sign in again — what you entered is kept on this page.')
  }
  if (message.startsWith('VENDORS_FORBIDDEN') || code === '42501') {
    return new VendorRequestError('forbidden', 'You do not have access to this.')
  }
  if (message.startsWith('VENDOR_NOT_FOUND')) return new VendorRequestError('not_found', 'This vendor is not available.')
  if (message.startsWith('VENDOR_ARCHIVED')) {
    return new VendorRequestError('archived', 'This vendor is archived. Ask an administrator to restore it.')
  }
  if (message.startsWith('VENDOR_DUPLICATE_PHONE')) {
    return new VendorRequestError('duplicate_phone', 'Another active vendor already has this mobile number.')
  }
  if (message.startsWith('VENDOR_INVALID')) {
    return new VendorRequestError('invalid', message.replace(AFTER_PREFIX, '') || 'Check the details and try again.')
  }
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i.test(message) || err?.status === 0) {
    return new VendorRequestError('uncertain', 'Could not confirm the save. Nothing is lost — tap Save again.')
  }
  return new VendorRequestError('unknown', 'Something went wrong. Nothing was confirmed saved — try again.')
}

type RpcResult<T> = { data: T | null; error: Raw }

async function call<T>(run: () => PromiseLike<RpcResult<T>>): Promise<T> {
  let res: RpcResult<T>
  try {
    res = await run()
  } catch (e) {
    throw classifyVendorError({ message: e instanceof Error ? e.message : 'Failed to fetch', status: 0 })
  }
  if (res.error) throw classifyVendorError(res.error)
  return res.data as T
}

export const VENDORS_KEY = 'vendors'

export type VendorFilter = {
  q?: string
  statuses?: string[]
  capabilities?: string[]
  categories?: string[]
  city?: string
  awaiting_visit?: boolean
  archived?: boolean
  sort?: 'last_visit' | 'oldest_visit' | 'name' | 'newest'
  limit?: number
  offset?: number
}

export const fetchVendorPage = (s: Supabase, filter: VendorFilter) =>
  call<VendorPage>(() => s.rpc('vendor_list', { p_filter: filter }))

export const fetchVendor = (s: Supabase, id: string) =>
  call<VendorDetail>(() => s.rpc('get_vendor', { p_vendor_id: id }))

export const fetchActivity = (s: Supabase, from: string | null, to: string | null) =>
  call<Activity>(() => s.rpc('vendor_activity', { p_from: from, p_to: to }))

export const fetchMyAccess = (s: Supabase) =>
  call<VendorAccess>(() => s.rpc('vendors_my_access'))

export type VendorAccess = { is_admin: boolean; past_entries_until: string | null; past_entries_open: boolean }

export const setPastEntriesUntil = (s: Supabase, until: string) =>
  call<{ past_entries_until: string; past_entries_open: boolean }>(() => s.rpc('set_vendor_past_entries_until', { p_until: until }))

/** What the vendor form sends. Text stays text; the database parses and validates it again. */
export type VendorInput = {
  company_name: string
  contact_name: string
  phone: string
  address: string
  city: string
  capabilities: string[]
  categories: string[]
  headcount: string
  referred_by: string
  notes: string
  /** Only when creating: 'potential' | 'contacted' (a name is enough) or 'prospect' (the default). */
  status?: 'potential' | 'contacted' | 'prospect'
  latitude?: number | null
  longitude?: number | null
}

export type SaveVendorResult = { status: 'created' | 'saved' | 'duplicate'; id: string; company_name: string }

export const saveVendor = (s: Supabase, submissionId: string, vendorId: string | null, input: VendorInput) =>
  call<SaveVendorResult>(() => s.rpc('save_vendor', { p_submission_id: submissionId, p_vendor_id: vendorId, p: input }))

export type VisitInput = {
  kind: VisitKind
  /** A visit that already happened, typed in afterwards (no photographs or location). */
  entered_later: boolean
  visited_on: string
  person_met: string
  discussion: string
  outcome: string
  next_follow_up_on: string
  latitude?: number | null
  longitude?: number | null
  accuracy_m?: number | null
  photos: { path: string; kind: PhotoKind }[]
}

export type LogVisitResult = {
  status: 'logged' | 'replayed'
  id: string
  vendor_id: string
  kind?: VisitKind
  entered_later?: boolean
  location_source?: 'gps' | 'unavailable' | 'not_applicable'
  distance_m?: number | null
}

export const logVisit = (s: Supabase, submissionId: string, vendorId: string, input: VisitInput) =>
  call<LogVisitResult>(() => s.rpc('log_vendor_visit', { p_submission_id: submissionId, p_vendor_id: vendorId, p: input }))

export const setVendorStatus = (s: Supabase, id: string, status: string) =>
  call<{ id: string; status: string }>(() => s.rpc('set_vendor_status', { p_vendor_id: id, p_status: status }))

export const archiveVendor = (s: Supabase, id: string, reason: string) =>
  call<unknown>(() => s.rpc('archive_vendor', { p_vendor_id: id, p_reason: reason }))

export const restoreVendor = (s: Supabase, id: string) =>
  call<unknown>(() => s.rpc('restore_vendor', { p_vendor_id: id }))
