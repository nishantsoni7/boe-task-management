import type { QueryClient } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { istToday } from '@/lib/istDate'
import {
  EXHIBITION_LEADS_KEY, LeadRequestError, fetchExhibitions, fetchLeadPage, fetchMyAccess, fetchStandings,
} from './api'
import type { Exhibition } from './constants'
import { pickDefaultExhibition } from './format'
import type { Standings } from './standings'

// The reads behind the Add Lead screen, defined once so the screen and the
// early start below ask for exactly the same thing under exactly the same key.
//
// THE EARLY START. A salesperson opens this page again and again during a fair,
// usually on a weak connection, and every round trip is seconds. The page used
// to wait: session → module check → exhibitions → standings, one after the
// other. Now the route layout starts the exhibitions and the standings reads the
// moment the session exists, in parallel with the module check, and the last
// exhibition list is kept on the device so the standings read does not even wait
// for the exhibitions answer. When the page appears its numbers are on the way
// or already there. The cache holds exhibition names and dates only — the same
// rows any signed-in user may read — and a stale copy is replaced as soon as the
// fresh list arrives.

type Supabase = ReturnType<typeof createClient>

export const exhibitionsKey = [...EXHIBITION_LEADS_KEY, 'exhibitions'] as const
export const standingsKey = (exhibitionId: string | null) => [...EXHIBITION_LEADS_KEY, 'standings', exhibitionId] as const

export const myAccessKey = [...EXHIBITION_LEADS_KEY, 'my-access'] as const

/** Whether the caller may see everyone's leads. If the door is not there yet (older database), nobody may. */
export const myAccessQuery = (supabase: Supabase) => ({
  queryKey: myAccessKey,
  queryFn: () => fetchMyAccess(supabase),
  staleTime: 5 * 60_000,
  retry: false,
})

const CACHE_KEY = 'exhibition-leads:exhibitions:v1'
const EXHIBITIONS_STALE_MS = 5 * 60_000
export const STANDINGS_STALE_MS = 15_000

export function readCachedExhibitions(): { data: Exhibition[]; at: number } | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { data?: unknown; at?: unknown }
    if (!Array.isArray(parsed.data) || typeof parsed.at !== 'number') return null
    const ok = parsed.data.every(e => e && typeof e === 'object' && typeof (e as Exhibition).id === 'string'
      && typeof (e as Exhibition).starts_on === 'string' && typeof (e as Exhibition).ends_on === 'string')
    return ok ? { data: parsed.data as Exhibition[], at: parsed.at } : null
  } catch {
    return null
  }
}

function writeCachedExhibitions(data: Exhibition[]): void {
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify({ data, at: Date.now() })) } catch { /* storage unavailable */ }
}

export const exhibitionsQuery = (supabase: Supabase) => ({
  queryKey: exhibitionsKey,
  queryFn: async () => {
    const list = await fetchExhibitions(supabase)
    writeCachedExhibitions(list)
    return list
  },
  staleTime: EXHIBITIONS_STALE_MS,
})

/**
 * The leaderboard door is a newer addition than the rest of the module. If it
 * is missing (or fails for a reason of its own) the person's own numbers still
 * show, from the list function that has always existed, marked `degraded`.
 */
export async function loadStandings(supabase: Supabase, exhibitionId: string): Promise<Standings> {
  try {
    return await fetchStandings(supabase, exhibitionId)
  } catch (e) {
    if (!(e instanceof LeadRequestError) || (e.kind !== 'unknown' && e.kind !== 'forbidden')) throw e
    const page = await fetchLeadPage(supabase, { scope: 'mine', exhibition_id: exhibitionId }, 0, 0)
    return {
      exhibition_id: exhibitionId, today: page.today, is_final: false, participants: 1, degraded: true,
      rows: [{ name: 'Me', total: page.mine.collected_total, today: page.mine.owned_today, rank: null, is_me: true }],
    }
  }
}

export const standingsQuery = (supabase: Supabase, exhibitionId: string) => ({
  queryKey: standingsKey(exhibitionId),
  queryFn: () => loadStandings(supabase, exhibitionId),
  staleTime: STANDINGS_STALE_MS,
})

/** The exhibition the form will open on, from the copy kept on this device. */
export function cachedDefaultExhibitionId(): string | null {
  const cached = readCachedExhibitions()
  if (!cached) return null
  return pickDefaultExhibition(cached.data.filter(e => e.is_active), istToday())?.id ?? null
}

/**
 * Called by the route layout as soon as a session exists, before the module
 * check has finished. Errors are ignored here: the screen asks again, and shows
 * them, if it still needs the answer.
 */
export function warmStart(qc: QueryClient, supabase: Supabase, pathname: string): void {
  void qc.prefetchQuery(exhibitionsQuery(supabase))
  // The standings are shown on My Leads; the Add Lead page needs nothing but the exhibition.
  if (pathname.startsWith('/exhibition-leads/my')) {
    const id = cachedDefaultExhibitionId()
    if (id) void qc.prefetchQuery(standingsQuery(supabase, id))
  }
}
