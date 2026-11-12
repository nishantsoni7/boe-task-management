'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Lock } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'

export default function OrdersGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  // ── ONE ANSWER FOR THE GATE, THE PAGE AND THE FRAME (2026-11-12) ──
  //
  // THIS GUARD IS ON THE CRITICAL PATH OF EVERY ORDER SCREEN: nothing below it
  // begins until it answers. It used to read the role and call resolve_permission
  // itself; the page then read the profile and resolve_effective_permissions
  // again, and the Orders frame resolved the permission context a third time,
  // after the page had drawn. It now resolves the signed-in person's context
  // (profile + resolve_effective_permissions_for_user, one RPC for every module),
  // which the page and the frame below read from the cache.
  //
  // THE RULE IS UNCHANGED, and is still the database's: an admin passes on the
  // role, anybody else on Orders `view` (the same merge resolve_permission reads),
  // and a failed read of either denies (usePermissionContext fails closed).
  const { ready, userId, profile, role, permissionsByModule } = usePermissionContext()

  useEffect(() => {
    if (ready && !userId) router.replace('/login')
  }, [ready, userId, router])

  if (!ready || !userId) return <LoadingScreen />

  // Admin always has access; otherwise defer to Control Center's
  // Order Management access level (view = can open this module at all).
  const allowed = !!profile && (
    role === 'admin'
    || (permissionsByModule.get('orders') ?? []).some(p => p.actionKey === 'view' && p.allowed)
  )

  // DENIED IN PLACE. This used to redirect to /coming-soon, a hard-coded
  // ATTENDANCE placeholder, so somebody without Orders access was told a
  // different module was "under development". The rule is unchanged.
  if (!allowed) return <OrdersAccessDenied onBack={() => router.push('/modules')} />
  return <>{children}</>
}

/** Said to a signed-in person whose account does not have Order Management. */
export const ORDERS_ACCESS_DENIED_TITLE = 'Order Management is not enabled for your account'

function OrdersAccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ minHeight: '100vh', background: colors.void, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div role="alert" style={{
        background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '12px',
        padding: '28px 24px', maxWidth: '440px', width: '100%', display: 'flex', flexDirection: 'column', gap: '10px',
      }}>
        <Lock size={20} strokeWidth={1.8} color="#805B0D" aria-hidden="true" />
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
