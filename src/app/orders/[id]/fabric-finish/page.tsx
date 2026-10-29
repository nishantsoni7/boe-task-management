'use client'

// FABRIC & FINISH COST SHEET OF A CONFIRMED ORDER — its own page (owner,
// 2026-10-29: the sheet slides in over the Order on a desktop and opens here
// on a phone or from "Open as a page"). The Order page links here with a
// button; this page links back.
//
// Who may see it is the database's answer (order_submission_fabric_finish_read
// asks for the Orders entry gate and the right to read the Order). This page
// only resolves the Order's PI in force and draws the sheet.

import { displayOrderNumber } from '@/lib/orderNumbering'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'
import { FabricFinishSheet, FABRIC_FINISH_TITLE } from '@/components/orders/FabricFinishSheet'

type OrderRow = {
  id: string
  display_number: string | null
  client_name: string | null
  source_order_submission_id: string | null
}

type Access =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; order: OrderRow }

export default function OrderFabricFinishPage() {
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
      const [me, orderRes] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        supabase.from('orders').select('id, display_number, client_name, source_order_submission_id').eq('id', id).maybeSingle(),
      ])
      if (!live) return
      const meRow = me.data as UserProfile | null
      if (meRow) setProfile(meRow)
      const order = orderRes.data as OrderRow | null
      if (orderRes.error || !order) { setAccess({ kind: 'missing' }); return }
      setAccess({ kind: 'ready', order })
    })()
    return () => { live = false }
  }, [supabase, id, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const ready = access.kind === 'ready' ? access : null
  const title = ready
    ? `${FABRIC_FINISH_TITLE} · Order ${displayOrderNumber(ready.order.display_number)}`.trim()
    : FABRIC_FINISH_TITLE

  return (
    <OrdersLayout profile={profile} title={title} onSignOut={handleSignOut} showRefresh={false}>
      <div className={'ff-page'}>
        <button type="button" className={'ff-back'} onClick={() => router.push(`/orders/${id}`)}>← Back to the Order</button>
        {access.kind === 'loading' && <p className={'ff-note'} role="status">Opening…</p>}
        {access.kind === 'missing' && (
          <p className={'ff-alert'} role="alert">This Order is not available to you, or it does not exist.</p>
        )}
        {ready && !ready.order.source_order_submission_id && (
          <p className={'ff-note'} role="status">This Order has no PI, so it has no Fabric &amp; Finish sheet.</p>
        )}
        {ready && ready.order.source_order_submission_id && (
          <div className={'ff-page-card'}>
            <FabricFinishSheet
              submissionId={ready.order.source_order_submission_id}
              variant="page"
              context={`Order ${displayOrderNumber(ready.order.display_number)}${ready.order.client_name ? ` · ${ready.order.client_name}` : ''}`}
            />
          </div>
        )}
      </div>
    </OrdersLayout>
  )
}
