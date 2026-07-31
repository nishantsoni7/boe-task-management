'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveAssetsAccessCapabilities,
  NO_ASSETS_ACCESS_CAPABILITIES,
  type AssetsAccessCapabilities,
} from '@/lib/permissions/assetsAccess'

// Signed-in profile + Assets & Access capabilities, for the module's pages that
// are ROUTES rather than views inside the inventory screen (the asset detail
// page and the notifications page).
//
// Two things it deliberately preserves from the inventory page's own logic:
//
//   * authority is always resolved for the SIGNED-IN user, never an
//     impersonated one. View As shows another person's records; it does not
//     lend them your permissions.
//   * capabilities are re-resolved when the tab regains focus, so an
//     administrator changing someone's permissions in Control Center reaches a
//     page that is already open, instead of a page that keeps offering buttons
//     the database has just stopped accepting.
//
// It is NOT a data-fetching hook for asset rows — each page reads what it needs
// with its own RLS-scoped queries.
export function useAssetsAccess(): {
  supabase: ReturnType<typeof createClient>
  profile: UserProfile | null
  caps: AssetsAccessCapabilities
  loading: boolean
  signOut: () => Promise<void>
} {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState<AssetsAccessCapabilities>(NO_ASSETS_ACCESS_CAPABILITIES)
  const [loading, setLoading] = useState(true)

  const refreshCapabilities = useCallback(async (prof: UserProfile) => {
    const effective = await getEffectivePermissions(supabase, prof.id, 'assets_access').catch(() => [])
    setCaps(deriveAssetsAccessCapabilities(prof.role, effective))
  }, [supabase])

  useEffect(() => {
    let active = true
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (!active) return
      if (!p) { router.push('/login'); return }

      const prof = p as UserProfile
      setProfile(prof)
      await refreshCapabilities(prof)
      if (active) setLoading(false)
    }
    init()
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!profile) return
    const refresh = () => { refreshCapabilities(profile) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [profile, refreshCapabilities])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [supabase, router])

  return { supabase, profile, caps, loading, signOut }
}
