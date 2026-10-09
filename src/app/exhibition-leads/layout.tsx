'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import ModuleGuard from '@/components/layout/ModuleGuard'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { EXHIBITION_LEADS_MODULE_KEY } from '@/lib/exhibitionLeads/constants'
import { warmStart } from '@/lib/exhibitionLeads/queries'

// Two gates, in order.
//
//   1. AUTHENTICATION, with a way back. Someone who opens /exhibition-leads/add
//      from a saved link or a WhatsApp message while signed out is sent to
//      /login?redirect=<this exact path>, and the login page follows the value
//      only after safeReturnPath() has proved it is an internal BOE path.
//   2. MODULE ACCESS, the same ModuleGuard every engine-gated module uses, so
//      "may this person open Exhibition Leads" is answered by the function the
//      launcher card asks.
//
// This is the UI half of the boundary. The database refuses the data on its own:
// every function re-checks the caller and every table has the module gate.
export default function ExhibitionLeadsRouteLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    let active = true
    const supabase = createClient()
    supabase.auth.getSession().then(({ data: { session } }: { data: { session: unknown } }) => {
      if (!active) return
      if (!session) {
        const here = `${window.location.pathname}${window.location.search}`
        router.replace(`/login?redirect=${encodeURIComponent(here)}`)
        return
      }
      // Start the page's reads now, alongside the module check below, instead of after it.
      warmStart(qc, supabase, window.location.pathname)
      setSignedIn(true)
    })
    return () => { active = false }
  }, [router, qc])

  if (!signedIn) return <LoadingScreen />
  return <ModuleGuard moduleKey={EXHIBITION_LEADS_MODULE_KEY}>{children}</ModuleGuard>
}
