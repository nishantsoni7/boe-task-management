import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// PI-submission notifications for the reduced-payment exception.
//
// WHY A ROUTE AND NOT AN RPC. Every notification on this system is written with
// the service key from a small server route — samples, finance, orders, assets —
// because `notifications` has no client INSERT path and recipients must be
// resolved from tables the actor cannot read. This is that pattern, for the one
// workflow Phase 3 introduces.
//
// THREE EVENTS, AND ONLY THREE:
//
//   pi_exception_requested   the salesperson asked to confirm an Order below the
//                            standard verified-payment requirement → the people
//                            who may decide it
//   pi_exception_approved    it was accepted  → the submission owner
//   pi_exception_rejected    it was refused   → the submission owner
//
// NOBODY ELSE IS TOLD. Management already sees a submitted PI in its review
// queue, and an approver's own decision is not news to the approver — the
// actor-skip below is the same one every other notify route applies.
//
// THE CLIENT SUPPLIES ONLY THE SUBMISSION ID. The client name, the owner and the
// set of authorised approvers are all resolved here, server-side: a browser that
// could name its own recipients could notify anybody, and a browser that could
// name its own client string could put words in the notification.

export type PiSubmissionNotifyEvent =
  | 'pi_exception_requested'
  | 'pi_exception_approved'
  | 'pi_exception_rejected'

type NotifRow = {
  user_id: string
  task_id: null
  entity_id: string | null
  type: PiSubmissionNotifyEvent
  title: string
  body: string | null
  is_push_sent: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { event, submissionId } = await req.json() as {
    event: PiSubmissionNotifyEvent
    submissionId: string
  }

  if (!event || typeof submissionId !== 'string' || !UUID.test(submissionId)) {
    return NextResponse.json({ error: 'event and a submission id are required' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // The record itself, read server-side. A caller who is not a participant is
  // refused by the RLS-checked read below rather than by anything this route
  // decides: the authenticated client is used for the visibility test, and the
  // service client only for what a browser may not read.
  const { data: visible } = await authClient
    .from('order_submissions').select('id').eq('id', submissionId).maybeSingle()
  if (!visible) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: submission } = await supabase
    .from('order_submissions')
    .select('id, client_name, created_by, submitted_by, advance_exception_requested_by')
    .eq('id', submissionId)
    .maybeSingle()

  if (!submission) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const clientName = (submission.client_name ?? '').trim() || 'a PI'
  const owner = submission.submitted_by ?? submission.created_by ?? null

  const rows: NotifRow[] = []
  const push = (userId: string | null | undefined, title: string) => {
    // Never notify the actor about their own action, and never twice.
    if (!userId || userId === user.id) return
    if (rows.some(r => r.user_id === userId)) return
    rows.push({
      user_id: userId, task_id: null, entity_id: submissionId,
      type: event, title, body: clientName, is_push_sent: true,
    })
  }

  if (event === 'pi_exception_requested') {
    // WHO MAY DECIDE, resolved by the database from the same two authorities the
    // decision RPCs accept: an active admin, or a holder of
    // orders.approve_advance_exception. Never a hard-coded role list.
    const { data: approvers } = await supabase
      .rpc('users_with_module_permission', {
        p_module_key: 'orders', p_action_key: 'approve_advance_exception',
      })
    // The RPC returns a NAMED column (`user_id`), so the shape is not a guess.
    // A bare string is still accepted, because a scalar set is what PostgREST
    // produces if the function is ever simplified back.
    for (const row of (approvers ?? []) as ({ user_id?: string } | string)[]) {
      push(typeof row === 'string' ? row : row.user_id,
        `${clientName} needs approval to confirm an Order below 40% payment.`)
    }
  } else if (event === 'pi_exception_approved') {
    push(owner, `Approval to proceed below 40% was granted for ${clientName}.`)
  } else if (event === 'pi_exception_rejected') {
    push(owner, `Approval to proceed below 40% was refused for ${clientName}.`)
  } else {
    return NextResponse.json({ error: 'Unknown event' }, { status: 400 })
  }

  if (rows.length === 0) return NextResponse.json({ skipped: true })

  // Idempotency, on the same terms the Orders route uses: skip a row identical
  // to one created for the same recipient in the last 2 minutes, so a client or
  // network retry does not double-notify. Events that legitimately repeat do so
  // minutes apart, well outside the window.
  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const { data: recent } = await supabase
    .from('notifications')
    .select('user_id, type, entity_id')
    .eq('entity_id', submissionId)
    .eq('type', event)
    .gte('created_at', since)

  const seen = new Set((recent ?? []).map((r: { user_id: string }) => r.user_id))
  const fresh = rows.filter(r => !seen.has(r.user_id))
  if (fresh.length === 0) return NextResponse.json({ skipped: true })

  const { error } = await supabase.from('notifications').insert(fresh)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ delivered: fresh.length })
}
