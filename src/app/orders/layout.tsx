'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Lock } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { hasPermission } from '@/lib/permissions/resolver'

export default function OrdersGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const [denied, setDenied] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      // ── THE TWO QUESTIONS ARE ASKED TOGETHER ──
      //
      // THIS GUARD IS ON THE CRITICAL PATH OF EVERY ORDER SCREEN. It renders a
      // loading state instead of its children, so nothing below it — not one
      // query on any Order page — begins until it answers. Every round trip it
      // spends is spent by all nine routes.
      //
      // It used to spend two in series: read the role, and only then, for a
      // non-admin, resolve orders.view. Neither needs the other's answer; both
      // need only the session's user id. The short-circuit saved an admin one
      // RPC and cost every non-admin a full round trip, and non-admins are who
      // this gate is for.
      //
      // THE RULE IS UNCHANGED, and is still the database's: an admin passes on
      // the role, anybody else passes on resolve_permission's answer, and a
      // failed read of either denies. Only the waiting changed.
      const [{ data: profile }, viewAllowed] = await Promise.all([
        supabase
          .from('users')
          .select('role')
          .eq('id', session.user.id)
          .single(),
        hasPermission(supabase, session.user.id, 'orders', 'view').catch(() => false),
      ])

      // Admin always has access; otherwise defer to Control Center's
      // Order Management access level (view = can open this module at all).
      const allowed = !!profile && (profile.role === 'admin' || viewAllowed)

      // DENIED IN PLACE. This used to redirect to /coming-soon, a hard-coded
      // ATTENDANCE placeholder, so somebody without Orders access was told a
      // different module was "under development". The rule is unchanged.
      if (!allowed) {
        setDenied(true)
        return
      }

      setAuthorized(true)
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (denied) return <OrdersAccessDenied onBack={() => router.push('/modules')} />
  if (!authorized) return <LoadingScreen />
  return <>{children}</>
}

/** Said to a signed-in person whose account does not have Order Management. */
export const ORDERS_ACCESS_DENIED_TITLE = 'Order Management is not enabled for your account'

function OrdersAccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ minHeight: '100vh', background: colors.void, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div role="alert" style={{
        background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '14px',
        padding: '28px 24px', maxWidth: '440px', width: '100%', display: 'flex', flexDirection: 'column', gap: '10px',
      }}>
        <Lock size={20} strokeWidth={1.8} color="#9A6212" aria-hidden="true" />
        <h1 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: colors.primary }}>{ORDERS_ACCESS_DENIED_TITLE}</h1>
        <p style={{ margin: 0, fontSize: '13px', color: colors.secondary, lineHeight: 1.55 }}>
          PI Drafts and Confirmed Orders are opened only by people given Order Management in Control Center.
          If you need them, ask an administrator to enable it for you.
        </p>
        <div>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onBack}>Back to Modules</button>
        </div>
      </div>
    </div>
  )
}
