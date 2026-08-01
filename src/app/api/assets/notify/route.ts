import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  assetNotification,
  assetNotificationBody,
  isAssetNotifyEvent,
  normalizeNotificationEntityId,
  resolveRecipients,
  type AssetNotifyContext,
  type AssetNotifyEvent,
  type RecipientRole,
} from '@/lib/assets/assetNotifications'

// Assets & Access notifications.
//
// Reuses the shared `notifications` table (task_id null, entity_id = the ASSET
// id) and mirrors the Orders notify route: service-role insert, recipients
// resolved server-side, and the actor never notified about their own action.
//
// WHY THIS IS A ROUTE AND NOT A TRIGGER: it runs AFTER the custody transaction
// has committed. A notification that failed inside the transaction would roll
// back a movement that physically happened — an asset really did change hands,
// and losing that record because an insert into a mailbox table failed is the
// wrong trade. Orders and Finance settled this the same way.
//
// AUTHORIZATION: the caller must be signed in, and the recipient set is derived
// here from ids the caller SUPPLIES BY NAME OF ROLE, not from a recipient list
// the client posts. A client cannot address a notification to an arbitrary
// user, and cannot make one say something other than what this file writes.

type NotifRow = {
  user_id: string
  task_id: null
  entity_id: string | null
  type: AssetNotifyEvent
  title: string
  body: string | null
  is_push_sent: boolean
}

type RequestBody = {
  event: unknown
  /** The asset this is about. Becomes entity_id / the deep link. */
  assetId?: string | null
  assetName?: string | null
  assetCode?: string | null
  /** Who now holds it. */
  toEmployeeId?: string | null
  /** Who held it before. */
  fromEmployeeId?: string | null
  /** Who opened the assignment being acknowledged. */
  assignerId?: string | null
  /** Who raised the change request. */
  requesterId?: string | null
  /** The employee an access record belongs to. */
  accessHolderId?: string | null
  toName?: string | null
  fromName?: string | null
  toLocation?: string | null
  vendor?: string | null
  daysToExpiry?: number | null
  requestType?: string | null
  note?: string | null
  documentKind?: string | null
  accessLabel?: string | null
  actorName?: string | null
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let payload: RequestBody
  try {
    payload = await req.json() as RequestBody
  } catch {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
  }

  const { event } = payload
  if (!isAssetNotifyEvent(event)) {
    return NextResponse.json({ error: 'Unknown asset notification event' }, { status: 400 })
  }

  const assetName = (payload.assetName ?? '').trim()
  if (!assetName) {
    return NextResponse.json({ error: 'assetName is required' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const ctx: AssetNotifyContext = {
    assetName,
    assetCode:    payload.assetCode ?? null,
    toName:       payload.toName ?? null,
    fromName:     payload.fromName ?? null,
    toLocation:   payload.toLocation ?? null,
    vendor:       payload.vendor ?? null,
    daysToExpiry: typeof payload.daysToExpiry === 'number' ? payload.daysToExpiry : null,
    requestType:  payload.requestType ?? null,
    note:         payload.note ?? null,
    documentKind: payload.documentKind ?? null,
    accessLabel:  payload.accessLabel ?? null,
    actorName:    payload.actorName ?? null,
  }

  const { recipients, title } = assetNotification(event, ctx)
  const body = assetNotificationBody(event, ctx)

  const getAdmins = async (): Promise<string[]> => {
    const { data } = await supabase
      .from('users').select('id').eq('role', 'admin').eq('is_active', true)
    return (data ?? []).map((r: { id: string }) => r.id)
  }

  // Role → concrete user ids. Anything the caller did not supply simply
  // produces no recipient for that role — never a guess, and never an error
  // that would abort the notifications that CAN be delivered.
  const resolve = async (role: RecipientRole): Promise<(string | null | undefined)[]> => {
    switch (role) {
      case 'admins':             return await getAdmins()
      case 'new_custodian':      return [payload.toEmployeeId]
      case 'previous_custodian': return [payload.fromEmployeeId]
      case 'assigner':           return [payload.assignerId]
      case 'requester':          return [payload.requesterId]
      case 'access_holder':      return [payload.accessHolderId]
    }
  }

  const candidates: (string | null | undefined)[] = []
  for (const role of recipients) candidates.push(...await resolve(role))

  // RULES 1–3, applied in ONE place and tested as a pure function: drop nulls,
  // never tell the actor about their own action, and tell each person once
  // however many roles they occupy. A new event cannot forget any of them
  // because no event does this itself.
  const userIds = resolveRecipients(candidates, user.id)

  if (userIds.length === 0) return NextResponse.json({ skipped: true })

  // Blank means "no record to point at" — see normalizeNotificationEntityId
  // for why an empty string cannot simply be passed through to a uuid column.
  const entityId = normalizeNotificationEntityId(payload.assetId)

  const rows: NotifRow[] = userIds.map(id => ({
    user_id: id,
    task_id: null,
    entity_id: entityId,
    type: event,
    title,
    body,
    is_push_sent: true,
  }))

  // Idempotency: skip a row identical to one created for the same recipient in
  // the last 2 minutes, so a client retry or a double-submit does not
  // double-notify. Events that legitimately repeat do so minutes or hours
  // apart, well outside the window.
  //
  // Duplicate identity is (user_id, type, entity_id) — the stable record the
  // notification is about, independent of title wording. A row without an
  // entity_id falls back to matching on title.
  //
  // Warranty reminders use a much wider window: they are produced by a sweep
  // that can run on every inventory visit, and a daily-or-more reminder about
  // the same warranty is noise, not information.
  const windowMinutes = event === 'asset_warranty_expiring' ? 7 * 24 * 60 : 2
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const fresh: NotifRow[] = []
  for (const row of rows) {
    let q = supabase
      .from('notifications')
      .select('id')
      .eq('user_id', row.user_id)
      .eq('type', row.type)
      .gte('created_at', windowStart)
    q = row.entity_id != null ? q.eq('entity_id', row.entity_id) : q.eq('title', row.title)
    const { data: dup } = await q.limit(1)
    if (!dup || dup.length === 0) fresh.push(row)
  }
  if (fresh.length === 0) return NextResponse.json({ skipped: true, deduped: true })

  const { error } = await supabase.from('notifications').insert(fresh)
  if (error) {
    // Message only — never the rows, whose titles carry asset names.
    console.error('[assets/notify] insert failed:', error.message)
    return NextResponse.json({ error: 'Could not create asset notifications' }, { status: 500 })
  }

  return NextResponse.json({ success: true, count: fresh.length })
}
