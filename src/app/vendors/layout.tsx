'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ModuleGuard from '@/components/layout/ModuleGuard'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { VENDORS_MODULE_KEY } from '@/lib/vendors/constants'

// Two gates, in order: sign-in (with a safe way back to this exact page), then the module access check every
// engine-gated module uses. The database refuses the data on its own as well: every function re-checks the
// caller and every table carries the module gate.
export default function VendorsRouteLayout({ children }: { children: React.ReactNode }) {
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
  return <ModuleGuard moduleKey={VENDORS_MODULE_KEY}>{children}</ModuleGuard>
}
