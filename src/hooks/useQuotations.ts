'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { NO_ACCESS, errorKind, fetchAccess, quotationKeys } from '@/lib/quotations/api'

// Signed-in profile and rights for every Quotations page. Authority is the SIGNED-IN user's: each database
// function reads auth.uid(). `access` only decides what to SHOW; the database decides what is allowed.
export function useQuotations() {
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
      const { data: p } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
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

  const accessQuery = useQuery({
    queryKey: quotationKeys.access, queryFn: () => fetchAccess(supabase), enabled: !!profile, staleTime: 5 * 60_000, retry: false,
  })

  return {
    supabase, profile, loading, signOut,
    access: accessQuery.data ?? NO_ACCESS,
    accessLoaded: accessQuery.isSuccess,
    // Before 20270614000000 is applied the functions do not exist: say so instead of a generic error.
    notSetUp: accessQuery.isError && errorKind(accessQuery.error) === 'not_set_up',
    accessError: accessQuery.error,
  }
}
