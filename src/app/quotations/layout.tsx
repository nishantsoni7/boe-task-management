'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ModuleGuard from '@/components/layout/ModuleGuard'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { QUOTATIONS_MODULE_KEY } from '@/lib/quotations/api'

// Two gates, in order, as Inventory: a signed-out link goes to /login?redirect=<this path>; then the same
// ModuleGuard the launcher card asks. Refused goes back to Modules. The database refuses on its own anyway:
// every quotation function re-checks the caller.
export default function QuotationsRouteLayout({ children }: { children: React.ReactNode }) {
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
  return <ModuleGuard moduleKey={QUOTATIONS_MODULE_KEY} deniedRoute="/modules">{children}</ModuleGuard>
}
