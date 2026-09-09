import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { insertUserNotifications, type NotificationInsert } from '@/lib/notificationWrites'
import { formatOrderOperationalNumber } from '@/lib/orders/orderProductCodes'
import { isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'
import {
  activityTypesForEvent,
  describeOrderUpdate,
  isOrderUpdateEvent,
  readRecipientConfig,
  resolveOrderUpdateRecipients,
  type OrderUpdateCandidate,
} from '@/lib/orders/orderUpdateNotifications'

// TELLING THE PEOPLE ON AN ORDER THAT IT MOVED.
//
// WHAT THE CALLER SENDS
// ---------------------
// `{ event }`, from a closed list of four, and nothing else. Not a recipient,
// not a title, not a value, not an actor. A browser that could name its own
// recipients could notify anybody; a browser that could supply its own title
// could write anything into everybody else's bell. Both are therefore resolved
// here, server-side, from the database's own record of what happened.
//
// WHERE THE FACTS COME FROM
// -------------------------
// `order_activity_log`. Every action worth announcing already writes an audit
// row naming itself, its actor, its payload and its time — status_changed,
// order_amended, production_alignment_changed, payment_verified and the rest —
// and THAT row is what this route words the notification from. So:
//
//   * A notification cannot exist without an audit entry to justify it.
//   * Nothing the client says can change what the sentence claims.
//   * "meaningful" is defined exactly once, by the event map in
//     src/lib/orders/orderUpdateNotifications.ts, and a bookkeeping row not in
//     that map raises nothing.
//
// There is deliberately NO path from "the row's updated_at moved" to a
// notification. A timestamp is not an event.
//
// THE ACTOR IS NEVER NOTIFIED, twice over: once when the recipients are
// resolved, and again at insertUserNotifications(..., { actorId }) — the single
// funnel Task Management already routes its writes through, which drops a row
// addressed to the person who caused it. Either alone would be correct.
//
// AUTHORIZATION. The Order is read AS THE CALLER, so RLS decides whether they
// may see it at all; a caller who cannot read the Order gets 404 and writes
// nothing. The activity row is likewise matched on `actor_id = caller`, so the
// only event anybody can announce is one they themselves just performed.
//
// FIRE AND FORGET. The business action has already committed by the time this
// runs. Every refusal below is reported as a skip with a reason, not as a
// failure, and nothing here can roll anything back.

export const runtime = 'nodejs'

/**
 * How far back a matching activity row may be.
 *
 * The client calls this immediately after the write that produced the row, so
 * the real gap is milliseconds. Five minutes is generous enough for a slow
 * network and a retry, and short enough that a second call an hour later cannot
 * re-announce an old change.
 */
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000

/**
 * How long a duplicate is suppressed for.
 *
 * Same rule and the same two minutes as /api/finance/notify: a double-click, a
 * retry or a second tab must not put the same sentence in somebody's bell
 * twice. Identity is (user_id, type, entity_id) — the recipient, the kind of
 * change and the Order — which is stable regardless of wording.
 */
const DEDUP_WINDOW_MS = 2 * 60 * 1000

type ActivityRow = {
  id: string
  event_type: string
  payload: Record<string, unknown> | null
  created_at: string
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // A PREVIEW MAY NOT WRITE. An administrator looking at the system through an
  // employee's eyes performs no action, so there is nothing to announce — and a
  // notification attributed to the employee for something the administrator did
  // would be a lie in somebody else's feed. Same refusal the notification
  // mutation routes make. See src/lib/viewAs.ts.
  if (isPreviewRequest(req.headers)) {
    return NextResponse.json({ error: PREVIEW_WRITE_REFUSED }, { status: 403 })
  }

  const { id: orderId } = await params
  const body = await req.json().catch(() => null)
  const event = (body ?? {}).event as unknown

  if (!isOrderUpdateEvent(event)) {
    return NextResponse.json({ error: 'A known event is required' }, { status: 400 })
  }

  // ── 1. The Order, AS THE CALLER ──
  //
  // RLS decides. A caller who cannot see this Order cannot announce a change to
  // it, and gets the same answer as one asking about an Order that does not
  // exist.
  const { data: order } = await authClient
    .from('orders')
    .select('id, display_number, assigned_to')
    .eq('id', orderId)
    .maybeSingle()

  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // ── 2. The event this caller just performed ──
  //
  // `actor_id = caller` is the whole authorization for the CONTENT: the only
  // change anybody can announce is one the database recorded them making. Read
  // as the caller too, so the activity RLS policies apply as they always have.
  const since = new Date(Date.now() - ACTIVITY_WINDOW_MS).toISOString()
  const { data: activityRows } = await authClient
    .from('order_activity_log')
    .select('id, event_type, payload, created_at')
    .eq('order_id', orderId)
    .eq('actor_id', user.id)
    .in('event_type', activityTypesForEvent(event) as string[])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)

  const activity = (activityRows ?? [])[0] as ActivityRow | undefined
  if (!activity) {
    // NOT AN ERROR. Nothing happened that this caller may announce — a refused
    // write, a duplicate call, or an event outside the map. The business action
    // is unaffected either way.
    return NextResponse.json({ skipped: true, reason: 'no matching activity' })
  }

  // ── 3. The sentence, from the stored row ──
  const orderNumber = formatOrderOperationalNumber(order.display_number) ?? order.display_number
  const { data: actor } = await authClient
    .from('users').select('full_name').eq('id', user.id).maybeSingle()

  const message = describeOrderUpdate(
    event,
    orderNumber,
    (actor as { full_name?: string | null } | null)?.full_name ?? null,
    { event_type: activity.event_type, payload: activity.payload ?? {} },
  )
  if (!message) return NextResponse.json({ skipped: true, reason: 'nothing to say' })

  // ── 4. Who hears it ──
  //
  // The service role from here down: resolving recipients means reading users
  // the caller has no business reading, and writing a row into somebody else's
  // feed is by definition not something the caller may do as themselves.
  const service = adminClient()
  if (!service.ok) {
    // The deployment cannot write privileged rows. The NAMES go to the log,
    // where an operator needs them; the caller learns only that nothing was
    // sent — and the business action it followed is unaffected.
    console.error('[orders/notify] not configured; missing:', service.missing.join(', '))
    return NextResponse.json({ skipped: true, reason: 'not configured' })
  }
  const admin = service.client

  const [{ data: configRows }, { data: candidateRows }] = await Promise.all([
    admin.from('order_notification_recipients').select('recipient_role, enabled'),
    // EVERY PERSON WHO COULD MATCH ANY CATEGORY, in one read. Narrowed by the
    // four category predicates rather than pulling the whole directory: an
    // administrator, a Super Admin, a member of the BDM department, or the one
    // salesperson this Order names.
    admin
      .from('users')
      .select('id, role, designation_level, team, is_deleted')
      .or([
        'role.eq.admin',
        'designation_level.eq.super_admin',
        'team.eq.bdm',
        ...(order.assigned_to ? [`id.eq.${order.assigned_to}`] : []),
      ].join(',')),
  ])

  const config = readRecipientConfig(configRows as { recipient_role?: unknown; enabled?: unknown }[] | null)

  const recipients = resolveOrderUpdateRecipients({
    candidates: (candidateRows ?? []) as OrderUpdateCandidate[],
    order: { assignedTo: order.assigned_to ?? null },
    config,
    actorId: user.id,
  })

  if (recipients.length === 0) {
    return NextResponse.json({ skipped: true, reason: 'no eligible recipients' })
  }

  // ── 5. Idempotency ──
  //
  // ONE QUERY FOR EVERY RECIPIENT, not one per recipient — the shape
  // /api/finance/notify settled on. A read that FAILED tells us nothing about
  // what exists, and a missing notification is worse than a duplicate one, so a
  // failed read sends.
  const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
  const { data: existing, error: dedupError } = await admin
    .from('notifications')
    .select('user_id')
    .eq('type', message.type)
    .eq('entity_id', orderId)
    .gte('created_at', dedupSince)
    .in('user_id', recipients)

  if (dedupError) console.error('[orders/notify] dedup read failed, sending anyway:', dedupError.message)
  const already = new Set(dedupError ? [] : (existing ?? []).map((r: { user_id: string }) => r.user_id))
  const fresh = recipients.filter(id => !already.has(id))
  if (fresh.length === 0) return NextResponse.json({ skipped: true, deduped: true })

  // ── 6. The write, through the one funnel ──
  //
  // `task_id` is null: this is not a task. `entity_id` is the ORDER, which is
  // what makes the row deep-link to the Order page, what the Confirmed Orders
  // list counts per user, and what the Order page marks read when that user
  // opens it. One column, three behaviours, no second unread store.
  const rows: NotificationInsert[] = fresh.map(userId => ({
    user_id:      userId,
    task_id:      null,
    entity_id:    orderId,
    type:         message.type,
    title:        message.title,
    body:         message.body,
    is_push_sent: true,
  }))

  const result = await insertUserNotifications(admin, rows, { actorId: user.id })
  if (result.error) {
    console.error('[orders/notify] insert failed:', result.error.message)
    return NextResponse.json({ error: result.error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    count: result.inserted,
    selfSuppressed: result.selfSuppressed,
  })
}

