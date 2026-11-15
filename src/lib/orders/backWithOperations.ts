// ORDERS THAT HAVE COME BACK TO OPERATIONS (owner, 2026-11-15, for Nitish in Operations).
//
// THE ASK. Operations sends an order for correction; the approver sends it back (via Sales, or straight
// away); it must come back to Operations MARKED "New update", and stay marked until Operations acts:
// accepts it, rejects it, or asks for more changes (which hands it back to the approver). It replaces the
// four-coloured "PI change waiting" pills of 2026-11-14 (piChangeMarker.ts, deleted): the owner asked for
// this one thing only, in the blue "New update" the list already uses.
//
// THE RULE. The order's live handoff (order_operations_handoffs, superseded_at is null) is
//   · status 'awaiting'              — Operations has not decided it, and
//   · chain_holder 'operations'      — the PI review chain (20270718000000) has put it with Operations, and
//   · a version that is NOT the first look: version_number >= 2 (a revised PI the approver approved), or
//     chain_round >= 1 (Operations flagged THIS version before, and the approver passed it back).
// A brand-new order (version 1, never flagged) is not marked: it is already "Not Aligned" / "Awaiting
// review", and nothing has come back. Deciding it moves or removes the state by itself: accept makes the
// status 'accepted'; "cannot accept" makes it 'clarification_needed' held by the approver; answering the
// changed lines of a revised PI (answer_order_pi_changes) makes it 'accepted' with a counts note. So nothing
// here is cleared by hand and opening the order does NOT clear it (the blue unread tint beside it,
// orderUnreadUpdates.ts, does go on opening).
//
// WHO SEES IT. The pages draw it for the Operations team only (users.team = 'operations'): it means "this
// is waiting for you". The read is the same one the Operations queue already makes, under the reader's own
// row-level security (can_view_order), so it adds no access; the team check only decides who is shown it.
//
// READS ONLY. A failed read draws no mark at all: a mark nobody checked is worse than none.

import type { SupabaseClient } from '@supabase/supabase-js'

/** The words on the Confirmed Orders table row, the Operations dashboard and its change card. */
export const BACK_WITH_OPERATIONS_NOTE = 'New update'
/** The same words, as the capitalised badge the phone cards use (see unreadUpdateLabel). */
export const BACK_WITH_OPERATIONS_BADGE = 'NEW UPDATE'

export type BackHandoff = {
  order_id: string
  status: string
  chain_holder: string | null
  chain_round: number | null
  version_number: number | null
}

/** The rule above, for one live handoff. */
export function isBackWithOperations(h: BackHandoff): boolean {
  return h.status === 'awaiting'
    && h.chain_holder === 'operations'
    && ((h.version_number ?? 1) >= 2 || (h.chain_round ?? 0) >= 1)
}

/** The order ids whose live handoff is back with Operations. */
export function ordersBackWithOperations(handoffs: readonly BackHandoff[]): Set<string> {
  return new Set(handoffs.filter(isBackWithOperations).map(h => h.order_id))
}

/** Only the Operations team is shown the mark; everybody else gets an empty set. */
export function backWithOperationsFor(team: string | null | undefined, ids: ReadonlySet<string>): ReadonlySet<string> {
  return team === 'operations' ? ids : EMPTY
}
const EMPTY: ReadonlySet<string> = new Set()

/**
 * One small read beside the list or the dashboard. The filters narrow the read to what the rule needs;
 * the rule is then applied again to what came back, so the two can never disagree. Empty on any failure.
 */
export async function loadOrdersBackWithOperations(supabase: SupabaseClient): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('order_operations_handoffs')
      .select('order_id, status, chain_holder, chain_round, version_number')
      .eq('status', 'awaiting')
      .eq('chain_holder', 'operations')
      .is('superseded_at', null)
      .or('version_number.gte.2,chain_round.gte.1')
    if (error) return new Set()
    return ordersBackWithOperations((data ?? []) as BackHandoff[])
  } catch {
    return new Set()
  }
}
