'use client'

// ONE OLD ORDER (BDPI) — the same Payment plan as a Confirmed Order's
// (OrderPaymentPlan in BDPI mode). The database decides what may be seen and
// changed (bdpi_* functions); this page only lays it out. An Admin may delete a
// BDPI uploaded by mistake while nothing of it has been marked dispatched.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities, type OrdersCapabilities } from '@/lib/permissions/orders'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'
import OrderPaymentPlan from '../../[id]/OrderPaymentPlan'

type Head = { bdpiNo: string; oldOrderNo: string | null; client: string | null; fabric: string | null; workbook: string | null }

const FABRIC_WORDS: Record<string, string> = { boe: 'BOE supplies the fabric', client: 'Client supplies the fabric', not_selected: 'Fabric: not selected' }

export default function BdpiPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState<OrdersCapabilities | null>(null)
  const [head, setHead] = useState<Head | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, perms, read] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        supabase.rpc('bdpi_payment_plan_read', { p_bdpi_id: id }),
      ])
      if (!live) return
      const meRow = me.data as UserProfile | null
      if (meRow) setProfile(meRow)
      setCaps(deriveOrdersCapabilities(meRow?.role, perms))
      const o = (read.data as { order?: Record<string, unknown> } | null)?.order
      if (o) {
        const s = (v: unknown) => (v === null || v === undefined ? null : String(v))
        setHead({ bdpiNo: String(o.display_number ?? ''), oldOrderNo: s(o.old_order_no), client: s(o.client_name),
          fabric: s(o.fabric_responsibility), workbook: s(o.workbook_name) })
      }
    })()
    return () => { live = false }
  }, [supabase, id, router])

  const remove = async () => {
    setProblem(null)
    const res = await fetch(`/api/orders/bdpi/${id}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    })
    const json = await res.json().catch(() => ({})) as { message?: string }
    if (!res.ok) { setProblem(json.message ?? 'The BDPI could not be deleted.'); return }
    router.push('/orders/bdpi')
  }

  const handleSignOut = async () => { await supabase.auth.signOut(); router.replace('/login') }
  const isAdmin = profile?.role === 'admin'
  const title = head ? `Payment plan · ${head.bdpiNo}` : 'Payment plan · Old order'

  return (
    <OrdersLayout profile={profile} title={title} onSignOut={handleSignOut} showRefresh={false}>
      <div className="opp-page">
        <Link href="/orders/bdpi" className="opp-back">← Back to Old orders</Link>
        {caps && !caps.canViewPaymentPlan && (
          <p className="opp-warn" role="alert">You do not have access to the Payment plan. An Admin can grant it in Control Center.</p>
        )}
        {caps?.canViewPaymentPlan && (
          <>
            {head && (
              <p className="opp-sub">
                Old order <strong>{head.oldOrderNo ?? '—'}</strong>{head.client ? ` · ${head.client}` : ''}
                {head.fabric && FABRIC_WORDS[head.fabric] ? ` · ${FABRIC_WORDS[head.fabric]}` : ''}
                {head.workbook ? ` · from ${head.workbook}` : ''}
              </p>
            )}
            <OrderPaymentPlan orderId={id} submissionId={null} bdpiId={id}
              canEdit={caps.canEditPaymentPlan} isAdmin={isAdmin} />
            {isAdmin && (
              <div className="opp-actions opp-mark">
                {!deleting ? (
                  <button type="button" className="opp-link" onClick={() => setDeleting(true)}>Delete this BDPI (uploaded by mistake)</button>
                ) : (
                  <>
                    <label className="opp-field opp-grow">
                      <span>Why is it being deleted? (at least 10 characters; only possible while nothing is dispatched)</span>
                      <input className="boe-input" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} />
                    </label>
                    <button type="button" className="boe-btn boe-btn-ghost" disabled={reason.trim().length < 10}
                      onClick={() => { if (window.confirm('Delete this BDPI and its files?')) void remove() }}>Delete</button>
                    <button type="button" className="opp-link" onClick={() => { setDeleting(false); setProblem(null) }}>Cancel</button>
                  </>
                )}
              </div>
            )}
            {problem && <p className="opp-warn" role="alert">{problem}</p>}
          </>
        )}
      </div>
    </OrdersLayout>
  )
}
