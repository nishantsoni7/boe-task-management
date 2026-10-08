'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { istToday } from '@/lib/istDate'
import { EXHIBITION_LEADS_KEY, fetchExhibitions } from '@/lib/exhibitionLeads/api'
import { pickDefaultExhibition } from '@/lib/exhibitionLeads/format'

// Signed-in profile for every Exhibition Leads page. Authority is the SIGNED-IN
// user's, never a View As subject's: each database function reads auth.uid(), so
// there is nothing here a preview could lend. `isAdmin` only decides what to
// SHOW; the database decides what is allowed.
export function useExhibitionLeads(): {
  supabase: ReturnType<typeof createClient>
  profile: UserProfile | null
  isAdmin: boolean
  loading: boolean
  signOut: () => Promise<void>
} {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`)
        return
      }
      const { data: p } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!active) return
      if (!p) { router.replace('/login'); return }
      setProfile(p as UserProfile)
      setLoading(false)
    })()
    return () => { active = false }
  }, [supabase, router, pathname])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [supabase, router])

  return { supabase, profile, isAdmin: profile?.role === 'admin', loading, signOut }
}

/** The active exhibitions, and the one to preselect today. */
export function useExhibitions(supabase: ReturnType<typeof createClient>, enabled: boolean) {
  const q = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'exhibitions'],
    queryFn: () => fetchExhibitions(supabase),
    enabled,
    staleTime: 5 * 60_000,
  })
  const list = useMemo(() => q.data ?? [], [q.data])
  // Closed exhibitions stay listed (their leads are still there) but take no new leads.
  const open = useMemo(() => list.filter(e => e.is_active), [list])
  const fallback = useMemo(() => pickDefaultExhibition(list, istToday()), [list])
  const fallbackOpen = useMemo(() => pickDefaultExhibition(open, istToday()), [open])
  return { exhibitions: list, open, defaultExhibition: fallback, defaultOpenExhibition: fallbackOpen, isLoading: q.isLoading, error: q.error as Error | null, refetch: q.refetch }
}
