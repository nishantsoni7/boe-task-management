'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import { hasPermission } from '@/lib/permissions/resolver'
import type { UserProfile } from '@/lib/types'

type SwitchTarget = 'finance' | 'orders'

type ModuleSwitchButtonProps = {
  target: SwitchTarget
  profile: UserProfile | null
}

const TARGET_META: Record<
  SwitchTarget,
  {
    label: string
    route: string
  }
> = {
  orders: {
    label: 'Switch to Order Management',
    route: '/orders',
  },
  finance: {
    label: 'Switch to Finance',
    route: '/finance',
  },
}

export function ModuleSwitchButton({
  target,
  profile,
}: ModuleSwitchButtonProps) {
  const [visible, setVisible] = useState(false)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    let cancelled = false

    const updateVisibility = (nextVisible: boolean) => {
      if (!cancelled) {
        setVisible(nextVisible)
      }
    }

    const checkAccess = async () => {
      if (!profile) {
        updateVisibility(false)
        return
      }

      // Admin access mirrors the route guards for both modules.
      if (profile.role === 'admin') {
        updateVisibility(true)
        return
      }

      try {
        if (target === 'orders') {
          // Orders access follows the same permission used by OrdersGuard.
          const allowed = await hasPermission(
            supabase,
            profile.id,
            'orders',
            'view'
          )

          updateVisibility(allowed)
          return
        }

        // Finance access follows the same module-visibility rule used by FinanceGuard.
        const { data: financeModule, error } = await supabase
          .from('app_modules')
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'finance')
          .single()

        if (error || !financeModule) {
          updateVisibility(false)
          return
        }

        // Same resolver FinanceGuard uses, so this convenience switch cannot
        // offer a module the route will bounce. Admin is already short-circuited
        // above, matching the guard's own admin-first rule.
        const allowed = resolveModuleAccess('finance', financeModule, profile, true)

        updateVisibility(allowed)
      } catch {
        // Fail closed. The convenience switch stays hidden when access cannot
        // be confirmed. The module's own route guard remains authoritative.
        updateVisibility(false)
      }
    }

    void checkAccess()

    return () => {
      cancelled = true
    }
  }, [profile, supabase, target])

  if (!visible) {
    return null
  }

  const targetMeta = TARGET_META[target]

  return (
    <button
      type="button"
      className="boe-btn boe-btn-ghost"
      title={targetMeta.label}
      aria-label={targetMeta.label}
      style={{ whiteSpace: 'nowrap' }}
      onClick={() => router.push(targetMeta.route)}
    >
      <ArrowLeftRight
        size={14}
        strokeWidth={2}
        aria-hidden="true"
      />
      {targetMeta.label}
    </button>
  )
}