'use client'

// EDIT PI FOR A CONFIRMED ORDER — the full page (was a modal on the Order).
//
// Who may open it is the database's answer, asked the same way the server asks
// when the edit is submitted: can_propose_order_pi_edit(order). The page only
// declines early and politely; the pi-edits route decides again.
//
// While a proposed version is still open, the editor is not offered: one
// proposal at a time, exactly the rule the Order page's Edit PI button follows.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { EDIT_PI_LABEL, PiEditor } from '@/components/orders/PiEditor'
import { EDIT_PI_BLOCKED_NOTE, isOpenRevision } from '@/components/orders/PiVersionsPanel'
import { useOrderDocumentSubmissions } from '../OrderDocumentSubmissions'
import { absenceLine, supportingRow } from '@/lib/orders/orderDocumentSubmissions'
import { editPiReturnHref } from '@/lib/orders/editPiPage'
import { notifyPiSubmission } from '@/lib/notify'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'

type OrderRow = {
  id: string
  display_number: string | null
  client_name: string | null
  status: string
  source_order_submission_id: string | null
}

type Access =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'denied'; reason: string }
  | { kind: 'ready'; order: OrderRow; submissionId: string }

/** One line per category for the Attachments section: names, or "None on file". */
function filesLine(row: ReturnType<typeof supportingRow>): string {
  if (row.kind === 'loading') return 'Loading…'
  if (row.kind === 'unavailable') return 'Could not be read'
  if (row.kind === 'none') return 'None on file'
  const names = row.files.map(f => f.file_name)
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

export default function EditOrderPiPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [access, setAccess] = useState<Access>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, orderRes, may] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        supabase.from('orders').select('id, display_number, client_name, status, source_order_submission_id').eq('id', id).maybeSingle(),
        supabase.rpc('can_propose_order_pi_edit', { p_order_id: id }),
      ])
      if (!live) return
      if (me.data) setProfile(me.data as UserProfile)
      const order = orderRes.data as OrderRow | null
      if (orderRes.error || !order) { setAccess({ kind: 'missing' }); return }
      if (!order.source_order_submission_id) {
        setAccess({ kind: 'denied', reason: 'This Order has no PI to edit.' }); return
      }
      if (may.error || may.data !== true) {
        setAccess({ kind: 'denied', reason: 'You cannot edit this PI. Its owner or an Admin can.' }); return
      }
      const versions = await supabase.from('order_pi_versions').select('status').eq('order_id', order.id)
      if (!live) return
      if (((versions.data ?? []) as { status: string }[]).some(v => isOpenRevision(v.status))) {
        setAccess({ kind: 'denied', reason: EDIT_PI_BLOCKED_NOTE }); return
      }
      setAccess({ kind: 'ready', order, submissionId: order.source_order_submission_id })
    })()
    return () => { live = false }
  }, [supabase, id, router])

  const ready = access.kind === 'ready' ? access : null
  const docs = useOrderDocumentSubmissions(supabase, ready?.order.id ?? null, ready?.submissionId ?? null)
  const orderHref = `/orders/${id}`

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const title = ready ? `${EDIT_PI_LABEL} · Order ${ready.order.display_number ?? ''}`.trim() : EDIT_PI_LABEL

  return (
    <OrdersLayout profile={profile} title={title} onSignOut={handleSignOut} showRefresh={false}>
      {access.kind === 'loading' && <div className="pi-edit-loading" role="status">Opening the PI…</div>}
      {(access.kind === 'missing' || access.kind === 'denied') && (
        <div className="pi-edit-page">
          <div className="pi-edit-card">
            <div className="pi-edit-card-body">
              <p className="pi-edit-denied">{access.kind === 'missing' ? 'This Order could not be found.' : access.reason}</p>
              <Link href={orderHref} className="boe-btn boe-btn-ghost">Back to the Order</Link>
            </div>
          </div>
        </div>
      )}
      {ready && (
        <PiEditor
          supabase={supabase}
          mode="propose"
          submissionId={ready.submissionId}
          orderId={ready.order.id}
          backHref={orderHref}
          context={[`Order ${ready.order.display_number ?? ''}`.trim(), ready.order.client_name].filter(Boolean).join(' · ')}
          onDone={outcome => {
            // The proposal's one notification, as the modal used to send it.
            if (outcome === 'proposed') void notifyPiSubmission({ event: 'pi_revision_proposed', submissionId: ready.submissionId })
            router.push(editPiReturnHref(orderHref, outcome))
          }}
          attachments={{
            designFiles: filesLine(supportingRow(docs, 'design_files', absenceLine(docs.absence, 'design_files', () => null, () => ''))),
            clientPo: filesLine(supportingRow(docs, 'client_po', absenceLine(docs.absence, 'client_po', () => null, () => ''))),
            uploadDocumentsHref: `${orderHref}?upload=documents`,
            uploadWorkbookHref: `${orderHref}?upload=pi`,
            note: null,
          }}
        />
      )}
    </OrdersLayout>
  )
}
