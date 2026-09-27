'use client'

// EDIT PI FOR A PI DRAFT — the full page (was a modal on the draft).
//
// Who may open it is the database's answer, asked exactly as the draft page and
// the pi-edits route ask it: can_edit_order_submission (the owner, while the PI
// is a draft or returned) or can_admin_edit_order_submission. A PI that is
// already an Order is edited from its Order, as a proposed version.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { EDIT_PI_LABEL, PiEditor } from '@/components/orders/PiEditor'
import { editPiPageHref, editPiReturnHref } from '@/lib/orders/editPiPage'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'

type Draft = { id: string; client_name: string | null; draft_reference: string | null; order_id: string | null }

type Access =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'denied'; reason: string; orderId: string | null }
  | { kind: 'ready'; draft: Draft }

export default function EditDraftPiPage() {
  const { submissionId } = useParams<{ submissionId: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [access, setAccess] = useState<Access>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, subRes, canEdit, canAdmin] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        supabase.from('order_submissions').select('id, client_name, draft_reference, order_id').eq('id', submissionId).maybeSingle(),
        supabase.rpc('can_edit_order_submission', { p_submission_id: submissionId }),
        supabase.rpc('can_admin_edit_order_submission', { p_submission_id: submissionId }),
      ])
      if (!live) return
      if (me.data) setProfile(me.data as UserProfile)
      const draft = subRes.data as Draft | null
      if (subRes.error || !draft) { setAccess({ kind: 'missing' }); return }
      if (draft.order_id) {
        setAccess({ kind: 'denied', reason: 'This PI is approved and in force. It changes only as a new version, proposed from its Order.', orderId: draft.order_id })
        return
      }
      if (canEdit.data !== true && canAdmin.data !== true) {
        setAccess({ kind: 'denied', reason: 'You cannot edit this PI now. Its owner can while it is a draft or returned for changes; an Admin can at any stage before it is an Order.', orderId: null })
        return
      }
      setAccess({ kind: 'ready', draft })
    })()
    return () => { live = false }
  }, [supabase, submissionId, router])

  const draftHref = `/orders/drafts/${submissionId}`
  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }
  const ready = access.kind === 'ready' ? access.draft : null

  return (
    <OrdersLayout profile={profile} title={EDIT_PI_LABEL} onSignOut={handleSignOut} showRefresh={false}>
      {access.kind === 'loading' && <div className="pi-edit-loading" role="status">Opening the PI…</div>}
      {(access.kind === 'missing' || access.kind === 'denied') && (
        <div className="pi-edit-page">
          <div className="pi-edit-card">
            <div className="pi-edit-card-body">
              <p className="pi-edit-denied">{access.kind === 'missing' ? 'This PI could not be found.' : access.reason}</p>
              {access.kind === 'denied' && access.orderId
                ? <Link href={editPiPageHref(access.orderId)} className="boe-btn boe-btn-primary">{EDIT_PI_LABEL} on the Order</Link>
                : <Link href={draftHref} className="boe-btn boe-btn-ghost">Back to the PI</Link>}
            </div>
          </div>
        </div>
      )}
      {ready && (
        <PiEditor
          supabase={supabase}
          mode="apply"
          submissionId={ready.id}
          orderId={null}
          backHref={draftHref}
          context={[ready.draft_reference, ready.client_name].filter(Boolean).join(' · ') || 'PI draft'}
          onDone={outcome => router.push(editPiReturnHref(draftHref, outcome))}
          attachments={{
            designFiles: 'attached on the PI draft',
            clientPo: 'attached on the PI draft',
            uploadDocumentsHref: `${draftHref}#pi-draft-attachments`,
            uploadWorkbookHref: null,
            note: 'To replace the whole workbook on a draft, use Change PI on the draft.',
          }}
        />
      )}
    </OrdersLayout>
  )
}
