// THE STAR SELLER'S SUPER PRIORITY (owner, 2026-11-12): last month's announced Star Seller puts ONE of their own
// open Orders into Factory Focus, once for that award; it stays until dispatched (or the owner removes it).
// Everybody sees it on their Scoreboard card: who, which Order, why. Only the Order number, the seller and their
// line are shown: never the client or the value (the Factory Focus rule for people who cannot open the Order).
//
// The database decides who may pick (order_factory_focus_guard, 20270628000000); this file reads the state and
// writes the pick on the service role with the actor from the token.

import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { istToday } from '@/lib/istDate'
import { monthLabel, previousMonth } from './reviewServer'
import type { Result } from './server'

const ok = (body: Record<string, unknown>, status = 200): Result => ({ status, body })
const fail = (status: number, error: string): Result => ({ status, body: { error } })

async function starSellerOf(caller: Caller, month: string): Promise<string | null> {
  const [frozen, award] = await Promise.all([
    caller.svc.from('scoreboard_months').select('month').eq('month', month).maybeSingle(),
    caller.svc.from('scoreboard_awards').select('employee_id').eq('month', month).eq('award', 'star_seller').maybeSingle(),
  ])
  if (frozen.error) throw new Error(frozen.error.message)
  if (award.error) throw new Error(award.error.message)
  return frozen.data && award.data ? String(award.data.employee_id) : null
}

export async function loadStarSeller(caller: Caller, now: Date = new Date()): Promise<Result> {
  const month = previousMonth(`${istToday(now).slice(0, 7)}-01`)
  const seller = await starSellerOf(caller, month)
  if (!seller) return ok({ month, monthLabel: monthLabel(month), seller: null })

  const [who, pickR] = await Promise.all([
    caller.svc.from('users').select('full_name').eq('id', seller).maybeSingle(),
    caller.svc.from('order_factory_focus_selections').select('order_id, note, removed_at').eq('kind', 'star_seller').eq('award_month', month).maybeSingle(),
  ])
  if (pickR.error) throw new Error(pickR.error.message)
  let pick: Record<string, unknown> | null = null
  if (pickR.data) {
    const o = await caller.svc.from('orders').select('display_number, status').eq('id', pickR.data.order_id).maybeSingle()
    pick = {
      orderNumber: o.data?.display_number ?? null,
      status: o.data?.status ?? null,
      note: pickR.data.note ?? null,
      active: !pickR.data.removed_at && !['dispatched', 'cancelled'].includes(String(o.data?.status ?? '')),
    }
  }

  const isMe = seller === caller.id
  let openOrders: { id: string; number: string; client: string }[] = []
  if (isMe && !pick) {
    const r = await caller.svc.from('orders').select('id, display_number, client_name, status, is_test_data')
      .eq('assigned_to', caller.id).not('status', 'in', '(dispatched,cancelled)').order('display_number', { ascending: false }).limit(100)
    if (r.error) throw new Error(r.error.message)
    openOrders = ((r.data ?? []) as { id: string; display_number: string; client_name: string; is_test_data: boolean | null }[])
      .filter(x => !x.is_test_data)
      .map(x => ({ id: x.id, number: x.display_number, client: x.client_name }))
  }

  return ok({
    month,
    monthLabel: monthLabel(month),
    seller: { name: (who.data?.full_name as string | null) ?? 'Unknown', isMe },
    pick,
    openOrders,
  })
}

export async function pickOrder(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  const month = previousMonth(`${istToday(now).slice(0, 7)}-01`)
  const seller = await starSellerOf(caller, month)
  if (!seller || seller !== caller.id) return fail(403, 'Only last month’s Star Seller makes this pick.')
  const orderId = typeof body.order_id === 'string' ? body.order_id : ''
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null
  const o = await caller.svc.from('orders').select('id, assigned_to, status').eq('id', orderId).maybeSingle()
  if (o.error) throw new Error(o.error.message)
  if (!o.data || o.data.assigned_to !== caller.id) return fail(404, 'Choose one of your own Orders.')
  if (['dispatched', 'cancelled'].includes(String(o.data.status))) return fail(409, 'That Order is closed.')
  const active = await caller.svc.from('order_factory_focus_selections').select('id').eq('order_id', orderId).is('removed_at', null).maybeSingle()
  if (active.error) throw new Error(active.error.message)
  if (active.data) return fail(409, 'That Order is already in Factory Focus. Choose another.')
  // selected_month and salesperson_id are stamped by the guard, which also checks everything again.
  const { error } = await caller.svc.from('order_factory_focus_selections').insert({
    order_id: orderId, selected_by: caller.id, note, kind: 'star_seller', award_month: month,
    selected_month: month, salesperson_id: caller.id,
  })
  if (error) {
    if (error.code === '23505') return fail(409, 'Your Super Priority pick for this award is already made.')
    throw new Error(error.message)
  }
  return ok({ picked: true }, 201)
}
