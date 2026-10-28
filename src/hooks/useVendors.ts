'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { fetchMyAccess } from '@/lib/vendors/api'

/** What the signed-in person's access level lets the screens SHOW. Shared (one cached query) by every Vendors page and its layout. */
export function useVendorAccess(profile: UserProfile | null) {
  const supabase = useMemo(() => createClient(), [])
  const access = useQuery({
    queryKey: ['vendors', 'my-access'],
    queryFn: () => fetchMyAccess(supabase),
    enabled: !!profile,
    staleTime: 60_000,
  })
  const admin = profile?.role === 'admin'
  const a = access.data
  return {
    /** The access answer has arrived (or the person is Admin), so a screen may show or withhold actions. */
    accessReady: admin || access.isFetched,
    isAdmin: admin || a?.is_admin === true,
    canCreate: admin || a?.can_create === true,
    canEdit: admin || a?.can_edit === true,
    canExport: admin || a?.can_export === true,
    canSeeActivity: admin || a?.can_see_activity === true,
    pastEntriesOpen: a?.past_entries_open === true,
    pastEntriesUntil: a?.past_entries_until ?? null,
  }
}

// Signed-in profile for every Vendors page. Authority is the SIGNED-IN user's, never a View As subject's: each
// database function reads auth.uid(). `isAdmin` only decides what to SHOW; the database decides what is allowed.
export function useVendors(): {
  supabase: ReturnType<typeof createClient>
  profile: UserProfile | null
  isAdmin: boolean
  /** What the access level allows (the Admin role holds all). The database re-checks every write. */
  canCreate: boolean
  canEdit: boolean
  canExport: boolean
  canSeeActivity: boolean
  /** The catch-up window for visits that already happened is open (Admin sets the end date). */
  pastEntriesOpen: boolean
  pastEntriesUntil: string | null
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

  const { accessReady, ...access } = useVendorAccess(profile)
  return { supabase, profile, ...access, loading: loading || !accessReady, signOut }
}
