import type { createClient } from '@/lib/supabase/client'
import { classifyLeadError, type LeadError } from './errors'
import type { Exhibition, Lead, LeadEvent } from './constants'
import type { RpcFilter } from './filters'
import type { RankingData } from './ranking'
import type { ExportLead } from './csv'

// Thin typed wrappers over the database functions. There is no API route in
// between on purpose: every function reads auth.uid() itself, so the browser's
// own session IS the identity, and nothing here holds a service credential.

type Supabase = ReturnType<typeof createClient>

export class LeadRequestError extends Error {
  readonly detail: LeadError
  constructor(detail: LeadError) {
    super(detail.message)
    this.name = 'LeadRequestError'
    this.detail = detail
  }
  get kind() { return this.detail.kind }
}

type RpcResult<T> = { data: T | null; error: { message?: string; code?: string; status?: number } | null }

async function call<T>(run: () => PromiseLike<RpcResult<T>>): Promise<T> {
  let res: RpcResult<T>
  try {
    res = await run()
  } catch (e) {
    // fetch itself threw: the request may or may not have reached the server.
    throw new LeadRequestError(classifyLeadError({ message: e instanceof Error ? e.message : 'Failed to fetch', status: 0 }))
  }
  if (res.error) throw new LeadRequestError(classifyLeadError(res.error))
  return res.data as T
}

export type LeadPage = {
  total: number
  date_counts: { date: string; count: number }[]
  rows: Lead[]
  summary: { active_valid: number; hot: number; overdue: number }
  mine: { owned_today: number; owned_total: number; collected_total: number }
  cities: string[]
  today: string
}

export const fetchExhibitions = (s: Supabase) =>
  call<Exhibition[]>(async () => {
    const { data, error } = await s.from('exhibitions')
      .select('id, slug, name, city, starts_on, ends_on, is_active')
      .order('starts_on', { ascending: false })
    return { data: data as Exhibition[] | null, error }
  })

export type AdminExhibition = Exhibition & { leads: number; archived: number }

export const fetchExhibitionsAdmin = (s: Supabase) =>
  call<AdminExhibition[]>(() => s.rpc('list_exhibitions_admin'))

type ExhibitionInput = { name: string; city: string; startsOn: string; endsOn: string }

export const createExhibition = (s: Supabase, v: ExhibitionInput) =>
  call<{ id: string; slug: string }>(() => s.rpc('create_exhibition', {
    p_name: v.name.trim(), p_city: v.city.trim() || null, p_starts_on: v.startsOn, p_ends_on: v.endsOn,
  }))

export const updateExhibition = (s: Supabase, id: string, v: ExhibitionInput & { isActive: boolean }) =>
  call<{ id: string }>(() => s.rpc('update_exhibition', {
    p_id: id, p_name: v.name.trim(), p_city: v.city.trim() || null,
    p_starts_on: v.startsOn, p_ends_on: v.endsOn, p_is_active: v.isActive,
  }))

export const fetchLeadPage = (s: Supabase, filter: RpcFilter, limit: number, offset: number) =>
  call<LeadPage>(() => s.rpc('exhibition_leads_page', { p_filter: filter, p_limit: limit, p_offset: offset }))

export const fetchLead = (s: Supabase, id: string) =>
  call<{ lead: Lead; events: LeadEvent[] }>(() => s.rpc('get_exhibition_lead', { p_lead_id: id }))

export type CreateResult =
  | { outcome: 'created' | 'replayed'; lead_id: string; mine?: undefined }
  | { outcome: 'duplicate'; mine: true; lead_id: string }
  | { outcome: 'duplicate'; mine: false; lead_id?: undefined }

export const createLead = (
  s: Supabase,
  args: { submissionId: string; exhibitionId: string } & Record<string, unknown>,
) => {
  const { submissionId, exhibitionId, ...rest } = args
  return call<CreateResult>(() => s.rpc('create_exhibition_lead', {
    p_submission_id: submissionId, p_exhibition_id: exhibitionId, ...rest,
  }))
}

export const updateLead = (s: Supabase, id: string, changes: Record<string, unknown>, note: string | null) =>
  call<{ outcome: string; lead_id: string }>(() =>
    s.rpc('update_exhibition_lead', { p_lead_id: id, p_changes: changes, p_note: note }))

export const reassignLead = (s: Supabase, id: string, newOwner: string, note: string | null) =>
  call<{ outcome: string }>(() =>
    s.rpc('reassign_exhibition_lead', { p_lead_id: id, p_new_owner: newOwner, p_note: note }))

export const archiveLead = (s: Supabase, id: string, reason: string) =>
  call<{ outcome: string }>(() => s.rpc('archive_exhibition_lead', { p_lead_id: id, p_reason: reason }))

export const restoreLead = (s: Supabase, id: string) =>
  call<{ outcome: string }>(() => s.rpc('restore_exhibition_lead', { p_lead_id: id }))

export const fetchPeople = (s: Supabase, exhibitionId: string | null) =>
  call<{ id: string; name: string; eligible: boolean }[]>(() =>
    s.rpc('exhibition_lead_people', { p_exhibition_id: exhibitionId }))

export const fetchRanking = (s: Supabase, exhibitionId: string) =>
  call<RankingData>(() => s.rpc('exhibition_lead_ranking', { p_exhibition_id: exhibitionId }))

export const fetchExportPage = (s: Supabase, filter: RpcFilter, offset: number, limit = 1000) =>
  call<ExportLead[]>(() => s.rpc('export_exhibition_leads', { p_filter: filter, p_limit: limit, p_offset: offset }))

export const EXHIBITION_LEADS_KEY = ['exhibition-leads'] as const
