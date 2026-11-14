// THE "PI CHANGE WAITING" MARKER ON THE CONFIRMED ORDERS LIST (Operations' request, 2026-11-14).
//
// WHAT IT SAYS. A PI was changed on a confirmed Order and the change has not been decided yet. It is
// STATE, not a notification: it shows for everybody who can open the Order, and it goes away only when the
// person it is waiting on acts — nobody "reads" it away. (The blue "New update" tint beside it is the other
// thing: one reader's unread notification, gone once they open the Order. See orderUnreadUpdates.ts.)
//
// THE FOUR STATES, newest step first. They are the Order page's own attention rules, read for the whole
// list instead of one Order (orderWorkspace.ts / operationsHandoff.ts):
//   1. a revised PI waits for the approver              order_pi_versions.status = 'pending'
//   2. the approver sent the PI back to the salesperson salesReturnStage (ordersWithSales: the stored holder)
//   3. Operations could not accept it ("asked for changes")  live handoff 'clarification_needed'
//   4. the revised PI waits for Operations               live handoff 'awaiting'
// "A change" means version 2 or later: every new Order starts with V1 awaiting Operations, and that is
// what "Not Aligned" already says. Deciding the step (approve / reject / accept / answer the lines / ask for
// changes / Sales responds) moves or removes the state by itself, so nothing here is ever cleared by hand.
//
// READS ONLY. Both tables are visible to anybody who can open the Order (their RLS is can_view_order), so a
// reader sees exactly the Orders they can see. A failed read draws nothing — a marker nobody checked is worse
// than none.

import type { SupabaseClient } from '@supabase/supabase-js'
import { QUEUE_HANDOFF_COLUMNS, ordersWithSales, type QueueHandoff } from './operationsHandoff'

export type PiChangeStage =
  | 'awaiting_approval'
  | 'returned_to_sales'
  | 'operations_asked_changes'
  | 'awaiting_operations'

export type PiChangeMarker = {
  stage: PiChangeStage
  /** The words on the pill: the meaning never depends on the colour. */
  label: string
  /** Red is the one that is waiting on the salesperson because Operations could not accept. */
  tone: 'amber' | 'red'
  /** The longer sentence, for the pill's tooltip. */
  title: string
}

const MARKER: Record<PiChangeStage, Omit<PiChangeMarker, 'stage'>> = {
  awaiting_approval: {
    label: 'PI changed · awaiting approval',
    tone: 'amber',
    title: 'A revised PI is waiting for the approver to approve or reject it.',
  },
  returned_to_sales: {
    label: 'PI changed · with Sales',
    tone: 'amber',
    title: 'The approver sent the PI back to the salesperson, who has to make the changes and resubmit.',
  },
  operations_asked_changes: {
    label: 'PI changed · Operations asked for changes',
    tone: 'red',
    title: 'Operations could not accept the revised PI. It is waiting for the salesperson to answer.',
  },
  awaiting_operations: {
    label: 'PI changed · awaiting Operations',
    tone: 'amber',
    title: 'The revised PI is approved and is waiting for Operations to accept it or answer the changed lines.',
  },
}

export function piChangeMarker(stage: PiChangeStage): PiChangeMarker {
  return { stage, ...MARKER[stage] }
}

/**
 * One marker per Order that has a PI change waiting, newest step first.
 *
 * `handoffs` are the LIVE, undecided handoffs of version 2 or later (the loader filters them);
 * `withSales` are the Orders whose live handoff is "Returned to Sales".
 */
export function buildPiChangeMarkers(input: {
  pendingRevisionOrderIds: readonly string[]
  handoffs: readonly Pick<QueueHandoff, 'order_id' | 'status'>[]
  withSales: ReadonlySet<string>
}): Map<string, PiChangeMarker> {
  const out = new Map<string, PiChangeMarker>()
  // Oldest step first, so each later step overwrites the one before it.
  for (const h of input.handoffs) {
    if (h.status === 'awaiting') out.set(h.order_id, piChangeMarker('awaiting_operations'))
  }
  for (const h of input.handoffs) {
    if (h.status === 'clarification_needed') out.set(h.order_id, piChangeMarker('operations_asked_changes'))
  }
  for (const h of input.handoffs) {
    if (input.withSales.has(h.order_id)) out.set(h.order_id, piChangeMarker('returned_to_sales'))
  }
  // A revised PI waiting for approval is always the newest step: it is what Sales sent after Operations'
  // objection or the send-back.
  for (const id of input.pendingRevisionOrderIds) out.set(id, piChangeMarker('awaiting_approval'))
  return out
}

/** The two reads beside the list, then the rule. Empty on any failure: nothing is claimed that was not read. */
export async function loadPiChangeMarkers(supabase: SupabaseClient): Promise<Map<string, PiChangeMarker>> {
  try {
    const [pending, live] = await Promise.all([
      supabase.from('order_pi_versions').select('order_id').eq('status', 'pending'),
      supabase
        .from('order_operations_handoffs')
        .select(QUEUE_HANDOFF_COLUMNS)
        .in('status', ['awaiting', 'clarification_needed'])
        .is('superseded_at', null)
        .gte('version_number', 2),
    ])
    if (pending.error || live.error) return new Map()
    const handoffs = (live.data ?? []) as unknown as QueueHandoff[]
    return buildPiChangeMarkers({
      pendingRevisionOrderIds: ((pending.data ?? []) as { order_id: string }[]).map(r => r.order_id),
      handoffs,
      withSales: ordersWithSales(handoffs),
    })
  } catch {
    return new Map()
  }
}
