'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { fetchMyAccess } from '@/lib/vendors/api'

// Signed-in profile for every Vendors page. Authority is the SIGNED-IN user's, never a View As subject's: each
// database function reads auth.uid(). `isAdmin` only decides what to SHOW; the database decides what is allowed.
export function useVendors(): {
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

  const access = useQuery({
    queryKey: ['vendors', 'my-access'],
    queryFn: () => fetchMyAccess(supabase),
    enabled: !!profile,
    staleTime: 5 * 60_000,
  })
  return { supabase, profile, isAdmin: profile?.role === 'admin' || access.data?.is_admin === true, loading, signOut }
}
