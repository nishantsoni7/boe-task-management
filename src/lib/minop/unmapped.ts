// Machine IDs that have punched but belong to no employee yet. Read-only: it
// selects from minop_punches and users and writes nothing.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, unwrapPagedRows } from '../supabasePaging'
import { isPlausiblePunchTime } from './punches'

export type UnmappedMinopId = {
  minopUserId: string
  punchCount: number
  lastPunchLocal: string
}

export type MinopPunchLite = {
  minop_user_id: string
  punch_local: string
  punch_at: string
  first_seen_at: string
}

/**
 * Groups punches by machine ID, keeping only IDs absent from `mappedIds`.
 * Matching is exact text, like fingerprint_employee_code ("01" is not "1").
 * A punch with an impossible time is not a person to link, so it is left out;
 * it stays visible in the Incoming Minop data register.
 */
export function summariseUnmapped(punches: MinopPunchLite[], mappedIds: Set<string>): UnmappedMinopId[] {
  const byId = new Map<string, UnmappedMinopId>()
  for (const p of punches) {
    if (mappedIds.has(p.minop_user_id) || !isPlausiblePunchTime(p.punch_at, p.first_seen_at)) continue
    const row = byId.get(p.minop_user_id)
    if (!row) {
      byId.set(p.minop_user_id, { minopUserId: p.minop_user_id, punchCount: 1, lastPunchLocal: p.punch_local })
      continue
    }
    row.punchCount += 1
    if (p.punch_local > row.lastPunchLocal) row.lastPunchLocal = p.punch_local
  }
  return [...byId.values()].sort((a, b) => b.lastPunchLocal.localeCompare(a.lastPunchLocal))
}

export async function readUnmappedMinopIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: SupabaseClient<any, any, any>,
): Promise<UnmappedMinopId[]> {
  const users = await svc.from('users').select('minop_user_id').not('minop_user_id', 'is', null)
  if (users.error) throw new Error(users.error.message)
  const mappedIds = new Set((users.data ?? []).map(u => String(u.minop_user_id)))

  const punches = unwrapPagedRows('Minop punches', await fetchAllRows<MinopPunchLite>((from, to) =>
    svc.from('minop_punches')
      .select('minop_user_id, punch_local, punch_at, first_seen_at')
      .order('id', { ascending: true })
      .range(from, to),
  ))
  return summariseUnmapped(punches, mappedIds)
}
