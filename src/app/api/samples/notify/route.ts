import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export type SampleNotifyEvent =
  | 'sample_request_created'
  | 'sample_request_approved'
  | 'sample_request_rejected'
  | 'sample_request_reapplied'
  | 'sample_request_edited'
  | 'sample_request_deleted'
  | 'sample_qr_submitted'
  | 'sample_dispatched'
  | 'sample_followup'
  | 'sample_returned'
  | 'sample_lost'

// Always 'task_acknowledged' — the notifications table enforces this single
// value via a CHECK constraint. Sample notifications are distinguished by their
// title text, not by the type column.
const NOTIF_TYPE = 'task_acknowledged'

type NotifRow = {
  user_id: string
  type: string
  title: string
  body: string
  is_push_sent: boolean
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { event, requestedBy, sampleLabel } = await req.json() as {
    event: SampleNotifyEvent
    requestedBy: string
    sampleLabel: string
  }

  if (!event || !requestedBy) {
    return NextResponse.json({ error: 'event and requestedBy are required' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: actorRow } = await supabase
    .from('users').select('full_name').eq('id', user.id).single()
  const actor = actorRow?.full_name ?? 'Someone'

  // Fetch admins once; used by several events
  const getAdmins = async (): Promise<string[]> => {
    const { data } = await supabase
      .from('users').select('id').eq('role', 'admin')
      .or('is_deleted.eq.false,is_deleted.is.null')
    return (data ?? []).map((r: { id: string }) => r.id)
  }

  const rows: NotifRow[] = []

  const toAdmins = async (title: string) => {
    const admins = await getAdmins()
    for (const id of admins) {
      if (id === user.id) continue
      rows.push({ user_id: id, type: NOTIF_TYPE, title, body: sampleLabel, is_push_sent: true })
    }
  }

  const toRequester = (title: string) => {
    if (requestedBy === user.id) return
    rows.push({ user_id: requestedBy, type: NOTIF_TYPE, title, body: sampleLabel, is_push_sent: true })
  }

  switch (event) {
    case 'sample_request_created':
      await toAdmins(`${actor} created a sample request`)
      break
    case 'sample_request_approved':
      toRequester(`${actor} approved your sample request`)
      break
    case 'sample_request_rejected':
      toRequester(`${actor} rejected your sample request`)
      break
    case 'sample_request_reapplied':
      await toAdmins(`${actor} reapplied for a sample request`)
      break
    case 'sample_request_edited':
      await toAdmins(`${actor} edited a sample request`)
      break
    case 'sample_request_deleted':
      await toAdmins(`${actor} deleted a sample request`)
      break
    case 'sample_qr_submitted':
      await toAdmins(`${actor} submitted QR for sample`)
      break
    case 'sample_dispatched':
      toRequester(`${actor} dispatched your sample`)
      break
    case 'sample_followup':
      await toAdmins(`${actor} logged a follow-up for sample`)
      break
    case 'sample_returned':
      toRequester(`${actor} received your sample`)
      break
    case 'sample_lost':
      toRequester(`${actor} marked your sample as lost`)
      await toAdmins(`${actor} marked a sample as lost`)
      break
  }

  if (rows.length === 0) return NextResponse.json({ skipped: true })

  const { error } = await supabase.from('notifications').insert(rows)
  if (error) {
    console.error('[samples/notify] insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, count: rows.length })
}
