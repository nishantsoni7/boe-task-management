import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// Finance payment-request notifications. Reuses the shared `notifications`
// table (task_id left null) and mirrors the Samples notify route: service-role
// insert, admin recipients resolved via role, actor never notified about their
// own action. Titles carry the request number so the record can be located.
export type FinanceNotifyEvent =
  | 'finance_submitted'
  | 'finance_resubmitted'
  | 'finance_clarification'
  | 'finance_approved_suspense'
  | 'finance_approved_linked'
  | 'finance_rejected'
  | 'finance_linked'
  | 'finance_status_corrected'

type NotifRow = {
  user_id: string
  task_id: null
  entity_id: string | null
  type: string
  title: string
  body: string | null
  is_push_sent: boolean
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { event, requestNumber, entityId, clientName, creatorId, orderNumber, statusLabel } =
    await req.json() as {
      event: FinanceNotifyEvent
      requestNumber: string
      entityId?: string | null
      clientName?: string | null
      creatorId?: string | null
      orderNumber?: string | null
      statusLabel?: string | null
    }

  if (!event || !requestNumber) {
    return NextResponse.json({ error: 'event and requestNumber are required' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const body = clientName ?? null
  const orderSuffix = orderNumber ? ` ${orderNumber}` : ''

  const getAdmins = async (): Promise<string[]> => {
    const { data } = await supabase
      .from('users').select('id').eq('role', 'admin')
      .or('is_deleted.eq.false,is_deleted.is.null')
    return (data ?? []).map((r: { id: string }) => r.id)
  }

  const rows: NotifRow[] = []
  const push = (userId: string | null | undefined, title: string) => {
    if (!userId || userId === user.id) return
    rows.push({ user_id: userId, task_id: null, entity_id: entityId ?? null, type: event, title, body, is_push_sent: true })
  }
  const toAdmins = async (title: string) => {
    for (const id of await getAdmins()) push(id, title)
  }

  switch (event) {
    case 'finance_submitted':
      await toAdmins(`Payment request ${requestNumber} requires review.`)
      break
    case 'finance_resubmitted':
      await toAdmins(`Payment request ${requestNumber} was resubmitted.`)
      break
    case 'finance_clarification':
      push(creatorId, `Clarification requested for payment request ${requestNumber}.`)
      break
    case 'finance_approved_suspense':
      push(creatorId, `Payment request ${requestNumber} was approved and moved to Suspense.`)
      break
    case 'finance_approved_linked':
      push(creatorId, `Payment request ${requestNumber} was approved and linked to Order${orderSuffix}.`)
      break
    case 'finance_rejected':
      push(creatorId, `Payment request ${requestNumber} was rejected.`)
      break
    case 'finance_linked':
      push(creatorId, `Payment request ${requestNumber} was linked to Order${orderSuffix}.`)
      break
    case 'finance_status_corrected':
      push(creatorId, `Payment request ${requestNumber} status was updated to ${statusLabel ?? 'a new status'}.`)
      break
    default:
      return NextResponse.json({ error: 'Unknown event' }, { status: 400 })
  }

  if (rows.length === 0) return NextResponse.json({ skipped: true })

  // Idempotency: skip rows identical to one created for the same recipient in
  // the last 2 minutes, so client/network retries don't double-notify. Events
  // that legitimately repeat do so minutes/hours apart, well outside the window.
  //
  // Duplicate identity is (user_id, type, entity_id) — the stable record the
  // notification is about, independent of title wording. A row without an
  // entity_id (legacy / missing) falls back to matching on title.
  const windowStart = new Date(Date.now() - 2 * 60 * 1000).toISOString()
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
    console.error('[finance/notify] insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, count: fresh.length })
}
