'use client'

// ONE DRAFT ORDER (CLICKUP): everything the copy holds — the client and order
// fields, description, checklists, the files with the date each was uploaded,
// the comments and the status history (drawn by ../OrderView). Read-only.
// Administrators only.

import { use, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { AppLink } from '@/components/ui/AppLink'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import type { DraftOrder } from '@/lib/orders/clickupDrafts'
import { callDrafts } from '../callDrafts'
import { OrderView } from '../OrderView'

export default function ClickupDraftOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { profile } = usePermissionContext()
  const [order, setOrder] = useState<DraftOrder | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void callDrafts<{ order: DraftOrder }>(`/api/orders/clickup-drafts/${id}`).then(r => {
      if (r.ok) setOrder(r.body.order)
      else setProblem(r.message)
    })
  }, [id])

  const handleSignOut = async () => { await supabase.auth.signOut(); router.replace('/login') }

  return (
    <OrdersLayout profile={profile} title={order ? `${order.order_no ?? ''} ${order.client_name}`.trim() : 'Draft order'}
      onSignOut={handleSignOut} showRefresh={false}>
      <div className="opp-page">
        <AppLink href="/orders/clickup" className="opp-back">← Draft Orders (ClickUp)</AppLink>
        {problem && <p className="opp-warn" role="alert">{problem}</p>}
        {!order && !problem && <p className="opp-note" role="status">Loading…</p>}
        {order && <OrderView order={order} />}
      </div>
    </OrdersLayout>
  )
}
