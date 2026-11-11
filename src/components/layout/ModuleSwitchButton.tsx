'use client'

import Link from 'next/link'
import { ArrowLeftRight } from 'lucide-react'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'
import { useIntentWarm } from '@/hooks/useIntentWarm'

type SwitchTarget = 'finance' | 'orders'

const TARGET_META: Record<SwitchTarget, { label: string; short: string; route: string }> = {
  orders:  { label: 'Switch to Order Management', short: 'Orders',  route: '/orders' },
  finance: { label: 'Switch to Finance',          short: 'Finance', route: '/finance' },
}

/**
 * The Orders ↔ Finance switch, offered only when the other module's OWN guard
 * would let this person in.
 *
 * ── EACH TARGET ASKS ITS GUARD'S QUESTION ──
 *
 *   orders   OrdersGuard (src/app/orders/layout.tsx) admits the SIGNED-IN user
 *            when their role is admin or resolve_permission(orders, view) says
 *            yes. The permission context carries exactly that answer: the bulk
 *            resolver applies the same precedence and the same active-module
 *            filter as the per-module one (20260662).
 *   finance  ModuleGuard admits the DISPLAY SUBJECT through
 *            canAccessManagementModule — so this asks canAccessManagementModule,
 *            of the display subject.
 *
 * WHAT THIS FIXES. The Finance branch used to read the legacy `app_modules`
 * visibility table, which Access Control no longer writes and the Finance guard
 * no longer consults. The switch and the route could therefore disagree: offer
 * Finance to somebody the guard bounces, or hide it from somebody it admits.
 * It also cost a request on every Orders and Finance page mount; both answers
 * now come from the session-scoped permission context the shell already holds.
 *
 * STILL A CONVENIENCE, NOT A GATE. It fails closed — nothing is drawn until the
 * answer is in — and the target's own guard remains authoritative.
 *
 * A LINK, so it can be opened in a new tab. The target is warmed on INTENT
 * (pointer resting, focus, touch), not by Next's viewport prefetch: that
 * preloaded the other module's stylesheet on every Finance and Orders page and
 * Chrome logged "preloaded but not used" each time (measured 2026-11-11).
 */
/**
 * Whether the switch is offered, with its words and route. The header button
 * below and, on a phone, the layout's ⋯ menu (owner, 2026-11-05) ask the same
 * question here, so the two can never disagree.
 */
export function useModuleSwitch(target: SwitchTarget): { visible: boolean; label: string; short: string; route: string } {
  const actor = usePermissionContext()
  const subject = useDisplaySubject()

  const visible = target === 'orders'
    ? actor.ready && actor.userId !== null && (
        actor.role === 'admin' ||
        (actor.permissionsByModule.get('orders') ?? []).some(p => p.actionKey === 'view' && p.allowed)
      )
    : subject.ready && subject.actorUserId !== null && canAccessManagementModule({
        role: subject.subjectRole,
        moduleKey: 'finance',
        isModuleActive: true,
        permissions: subject.subjectPermissionsByModule.get('finance') ?? [],
      })

  return { visible, ...TARGET_META[target] }
}

export function ModuleSwitchButton({ target }: { target: SwitchTarget }) {
  const { visible, label, short, route } = useModuleSwitch(target)
  const { warmOnRest, warmNow, cancel } = useIntentWarm()
  if (!visible) return null

  // On a phone the full sentence pushed the page's own primary action onto a
  // second header row; there the module's name alone is shown (CSS swaps the
  // two spans). The accessible name is the full sentence at every width.
  return (
    <Link
      href={route}
      prefetch={false}
      onPointerEnter={() => warmOnRest(route)}
      onPointerLeave={cancel}
      onFocus={() => warmNow(route)}
      onTouchStart={() => warmNow(route)}
      // On a phone it is an item of the header's ⋯ menu instead.
      className="boe-btn boe-btn-ghost boe-module-switch boe-desktop-only"
      title={label}
      aria-label={label}
      style={{ whiteSpace: 'nowrap', textDecoration: 'none' }}
    >
      <ArrowLeftRight size={14} strokeWidth={2} aria-hidden="true" />
      <span className="boe-module-switch-long">{label}</span>
      <span className="boe-module-switch-short" aria-hidden="true">{short}</span>
    </Link>
  )
}
