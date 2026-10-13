'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ModuleGuard from '@/components/layout/ModuleGuard'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { INVENTORY_MODULE_KEY } from '@/lib/inventory/constants'

// Two gates, in order.
//
//   1. AUTHENTICATION, with a way back: a link opened while signed out goes to /login?redirect=<this path>.
//   2. MODULE ACCESS, the same ModuleGuard every engine-gated module uses, so "may this person open
//      Inventory" is answered by the function the launcher card asks.
//
// This is the UI half of the boundary. The database refuses the data on its own: every function re-checks
// the caller and every table carries the module gate.
export default function InventoryRouteLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    createClient().auth.getSession().then(({ data: { session } }: { data: { session: unknown } }) => {
      if (!active) return
      if (!session) {
        const here = `${window.location.pathname}${window.location.search}`
        router.replace(`/login?redirect=${encodeURIComponent(here)}`)
        return
      }
      setReady(true)
    })
    return () => { active = false }
  }, [router])

  if (!ready) return <LoadingScreen />
  return <ModuleGuard moduleKey={INVENTORY_MODULE_KEY}>{children}</ModuleGuard>
}
