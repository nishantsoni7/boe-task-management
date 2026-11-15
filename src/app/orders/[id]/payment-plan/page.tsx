'use client'

// PAYMENT PLAN FOR A CONFIRMED ORDER — its own page (owner, 2026-10-29: "it
// should not show on the order detail page; clicking it should open a new page
// where dispatches are managed"). The Order page links here.
//
// Who may see it is the database's answer: order_payment_plan_read asks for the
// Orders entry gate, view_payment_plan and the right to open the Order. The
// capabilities read here only decide whether to say "no access" early and
// which controls to draw.

import { displayOrderNumber } from '@/lib/orderNumbering'
import { useEffect, useMemo, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useQueryClient } from '@tanstack/react-query'
import { callerModulePermissions, callerProfile } from '@/hooks/queries/usePermissionContext'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { deriveOrdersCapabilities, type OrdersCapabilities } from '@/lib/permissions/orders'
import type { UserProfile } from '@/lib/types'
import OrderPaymentPlan from '../OrderPaymentPlan'

type OrderRow = {
  id: string
  display_number: string | null
  client_name: string | null
  source_order_submission_id: string | null
}

type Access =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'denied' }
  | { kind: 'ready'; order: OrderRow; caps: OrdersCapabilities }

export default function OrderPaymentPlanPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const qc = useQueryClient()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [access, setAccess] = useState<Access>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      // Profile and Orders permissions come from what the Orders guard just read when under 30 s old
      // (callerProfile / callerModulePermissions, 2026-11-15): two requests fewer beside this page's own.
      const [me, orderRes, perms] = await Promise.all([
        callerProfile(qc, session.user.id).then(data => ({ data })),
        supabase.from('orders').select('id, display_number, client_name, source_order_submission_id').eq('id', id).maybeSingle(),
        callerModulePermissions(qc, supabase, session.user.id, 'orders'),
      ])
      if (!live) return
      const meRow = me.data as UserProfile | null
      if (meRow) setProfile(meRow)
      const order = orderRes.data as OrderRow | null
      if (orderRes.error || !order) { setAccess({ kind: 'missing' }); return }
      const caps = deriveOrdersCapabilities(meRow?.role, perms)
      if (!caps.canViewPaymentPlan) { setAccess({ kind: 'denied' }); return }
      setAccess({ kind: 'ready', order, caps })
    })()
    return () => { live = false }
  }, [supabase, qc, id, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const orderHref = `/orders/${id}`
  const ready = access.kind === 'ready' ? access : null
  const title = ready
    ? `Payment plan · Order ${displayOrderNumber(ready.order.display_number)}`.trim()
    : 'Payment plan'

  return (
    <OrdersLayout profile={profile} title={title} onSignOut={handleSignOut} showRefresh={false}>
      <div className="opp-page">
        <Link href={orderHref} className="opp-back">← Back to the Order</Link>
        {access.kind === 'loading' && <p className="opp-note" role="status">Opening the Payment plan…</p>}
        {access.kind === 'missing' && <p className="opp-warn" role="alert">This Order could not be found.</p>}
        {access.kind === 'denied' && (
          <p className="opp-warn" role="alert">You do not have access to the Payment plan. An Admin can grant it in Control Center.</p>
        )}
        {ready && (
          // The client's name is drawn by the plan itself, beside the lot.
          <OrderPaymentPlan
            orderId={ready.order.id}
            submissionId={ready.order.source_order_submission_id}
            canEdit={ready.caps.canEditPaymentPlan}
            isAdmin={profile?.role === 'admin'}
          />
        )}
      </div>
    </OrdersLayout>
  )
}
