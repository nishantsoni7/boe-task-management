'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { accessKey, fetchAccess, fetchPendingCount, pendingKey } from '@/lib/inventory/api'
import type { InventoryAccess } from '@/lib/inventory/constants'

const NO_ACCESS: InventoryAccess = { create: false, edit: false, delete: false, approve: false }

// Signed-in profile and rights for every Inventory page. Authority is the SIGNED-IN user's, never a View As
// subject's: each database function reads auth.uid(). `access` only decides what to SHOW; the database
// decides what is allowed.
export function useInventory() {
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
    queryKey: accessKey, queryFn: () => fetchAccess(supabase), enabled: !!profile, staleTime: 5 * 60_000,
  })
  const pendingQuery = useQuery({
    queryKey: pendingKey, queryFn: () => fetchPendingCount(supabase), enabled: !!profile,
    staleTime: 30_000, refetchOnWindowFocus: true,
  })

  const access = accessQuery.data ?? NO_ACCESS
  return {
    supabase, profile, loading, signOut,
    isAdmin: profile?.role === 'admin',
    access,
    accessLoaded: accessQuery.isSuccess,
    pending: pendingQuery.data ?? 0,
  }
}
