'use client'

// RECORD A DISPATCH (/orders/[id]/dispatch/new), OR ADD PAPERS AND DETAILS TO ONE
// (/orders/[id]/dispatch/[lotId]). Its own page, so the papers can sit beside the
// form. Who may record is the database's answer: order_dispatch_read says so, and
// order_dispatch_record / _update ask again. The capabilities are not read here.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { useViewAs } from '@/hooks/useViewAs'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { parseDispatchData, type DispatchData } from '@/lib/orders/dispatch'
import type { UserProfile } from '@/lib/types'
import OrderDispatchRecord from '../../OrderDispatchRecord'

type Access =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'denied' }
  | { kind: 'ready'; data: DispatchData; clientName: string | null }

export default function OrderDispatchRecordPage() {
  const { id, lotId } = useParams<{ id: string; lotId: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId } = useViewAs()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [access, setAccess] = useState<Access>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, orderRes, read] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        supabase.from('orders').select('client_name').eq('id', id).maybeSingle(),
        supabase.rpc('order_dispatch_read', { p_order_id: id }),
      ])
      if (!live) return
      if (me.data) setProfile(me.data as UserProfile)
      if (orderRes.error || !orderRes.data) { setAccess({ kind: 'missing' }); return }
      const data = read.error ? null : parseDispatchData(read.data)
      if (!data || !data.canRecord) { setAccess({ kind: 'denied' }); return }
      setAccess({ kind: 'ready', data, clientName: (orderRes.data as { client_name: string | null }).client_name })
    })()
    return () => { live = false }
  }, [supabase, id, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const orderHref = `/orders/${id}?view=dispatch`
  const ready = access.kind === 'ready' ? access : null
  const lot = ready && lotId !== 'new' ? ready.data.lots.find(l => l.id === lotId && l.status === 'dispatched') ?? null : null
  const lotMissing = !!ready && lotId !== 'new' && !lot

  return (
    <OrdersLayout profile={profile} title="Record dispatch" onSignOut={handleSignOut} showRefresh={false}>
      <div className="opp-page">
        <Link href={orderHref} className="opp-back">← Back to the Order</Link>
        {access.kind === 'loading' && <p className="opp-note" role="status">Opening the dispatch…</p>}
        {access.kind === 'missing' && <p className="opp-warn" role="alert">This Order could not be found.</p>}
        {access.kind === 'denied' && (
          <p className="opp-warn" role="alert">You do not have access to record a dispatch on this Order. An Admin can grant it in Control Center.</p>
        )}
        {lotMissing && <p className="opp-warn" role="alert">This dispatch could not be found.</p>}
        {ready && viewAsUserId && <p className="opp-warn" role="alert">Recording a dispatch is disabled while View As is active.</p>}
        {ready && !viewAsUserId && !lotMissing && (
          <OrderDispatchRecord data={ready.data} clientName={ready.clientName} lot={lot} onDone={() => router.push(orderHref)} />
        )}
      </div>
    </OrdersLayout>
  )
}
