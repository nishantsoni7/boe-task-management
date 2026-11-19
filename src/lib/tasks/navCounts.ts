import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidUUID } from '@/lib/ui'

/** The three badges in the Task Management sidebar (and the phone bottom nav). */
export type NavCounts = { myActive: number; assignedByMeActive: number; quotationActive: number }

export const NO_NAV_COUNTS: NavCounts = { myActive: 0, assignedByMeActive: 0, quotationActive: 0 }

/**
 * The three badges in ONE call (task_nav_counts, 20270810000000): the same three rules as the reads below, under
 * the caller's own row-level security. Null on ANY failure (a database without the function included) or on an
 * answer that is not three non-negative numbers, so the three reads still answer.
 */
async function countAtOnce(supabase: SupabaseClient, uid: string): Promise<NavCounts | null> {
  const { data, error } = await supabase.rpc('task_nav_counts', { p_user: uid })
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined
  if (error || !row) return null
  const counts: NavCounts = {
    myActive: Number(row.my_active),
    assignedByMeActive: Number(row.assigned_by_me_active),
    quotationActive: Number(row.quotation_active),
  }
  return Object.values(counts).every(n => Number.isFinite(n) && n >= 0) ? counts : null
}

/** The original three head-only reads, unchanged: the fallback, and the definition the function copies. */
async function countAtThreeCalls(supabase: SupabaseClient, uid: string): Promise<NavCounts> {
  const [myRes, abmRes, qrRes] = await Promise.all([
    supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', uid)
      .in('status', ['pending', 'started', 'working'])
      .neq('task_type', 'quotation_request'),
    supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', uid)
      .neq('assigned_to', uid)
      .neq('status', 'completed')
      .neq('status', 'cancelled'),
    supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', uid)
      .eq('task_type', 'quotation_request')
      .neq('status', 'completed')
      .neq('status', 'cancelled'),
  ])
  return {
    myActive:           myRes.count  ?? 0,
    assignedByMeActive: abmRes.count ?? 0,
    quotationActive:    qrRes.count  ?? 0,
  }
}

/**
 * Sidebar task counts for a user: zeros (and no request) for an absent or non-UUID id (a seed or test placeholder),
 * otherwise one call, or the three reads when that call cannot be used.
 */
export async function fetchNavCounts(supabase: SupabaseClient, uid: string | null | undefined): Promise<NavCounts> {
  if (!uid || !isValidUUID(uid)) return NO_NAV_COUNTS
  return (await countAtOnce(supabase, uid)) ?? await countAtThreeCalls(supabase, uid)
}
