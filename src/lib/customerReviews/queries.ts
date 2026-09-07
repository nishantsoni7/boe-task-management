import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * HOW MANY REVIEWS A REPLACE WOULD DISPLACE — unassigned only, matching what
 * customer_review_replace_available() actually does. `head: true` fetches no
 * rows.
 *
 * ONE PLACE, because BatchesScreen and TestCardListScreen both show a Replace
 * confirmation and both used to run this identical query themselves. It is a
 * display number, not a decision: the database chooses and locks the set
 * inside the transaction and returns what it actually replaced.
 */
export async function fetchAvailableUnassignedCount(supabase: SupabaseClient): Promise<number> {
  const { count } = await supabase
    .from('customer_review_test_cards')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'available')
    .is('assigned_to', null)
    .is('deleted_at', null)
  return count ?? 0
}
