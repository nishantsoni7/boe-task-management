// A CANCELLED ORDER KEEPS ITS NUMBER FOR GOOD (owner, 2026-10-31).
//
// change_confirmed_order_number() already refuses a number any Order holds,
// cancelled or not. Two doors could still free a cancelled Order's number,
// because neither checks the status: renumbering the cancelled Order itself,
// and deleting it. The Order page draws neither for a cancelled Order, and both
// routes ask here first. This check lives in the app, not the database.

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Read as the signed-in user. 'unknown' is a failed read, which the caller
 * refuses: a read that did not happen must not let the change through. No row
 * is 'open': the database then answers for a missing or forbidden Order.
 */
export async function readCancelledOrderLock(
  client: SupabaseClient,
  orderId: string,
): Promise<'cancelled' | 'open' | 'unknown'> {
  const { data, error } = await client.from('orders').select('status').eq('id', orderId).maybeSingle()
  if (error) return 'unknown'
  return data?.status === 'cancelled' ? 'cancelled' : 'open'
}
