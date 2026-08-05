'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveMeetingsCapabilities,
  NO_MEETINGS_CAPABILITIES,
  type MeetingsCapabilities,
} from '@/lib/permissions/meetings'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

// Signed-in profile + Meetings capabilities, shared by every page in the
// module. Same shape and the same two guarantees as useAssetsAccess:
//
//   * authority is resolved for the SIGNED-IN user, never an impersonated one.
//     View As shows another person's records; it does not lend their
//     permissions.
//   * capabilities are re-resolved when the tab regains focus, so an admin
//     changing someone's access in Control Center reaches a page that is
//     already open, rather than leaving it offering buttons the database has
//     just stopped accepting.
//
// It is not a data-fetching hook: each page reads its own RLS-scoped rows.
export function useMeetings(): {
  supabase: ReturnType<typeof createClient>
  profile: UserProfile | null
  caps: MeetingsCapabilities
  loading: boolean
  signOut: () => Promise<void>
} {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState<MeetingsCapabilities>(NO_MEETINGS_CAPABILITIES)
  const [loading, setLoading] = useState(true)

  const refreshCapabilities = useCallback(async (prof: UserProfile) => {
    const effective = await getEffectivePermissions(supabase, prof.id, 'meetings').catch(() => [])
    setCaps(deriveMeetingsCapabilities(prof.role, effective))
  }, [supabase])

  useEffect(() => {
    let active = true
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
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
