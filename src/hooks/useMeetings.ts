'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { profileQueryOptions } from '@/hooks/queries/useProfile'
import { useQueryClient } from '@tanstack/react-query'
import type { UserProfile } from '@/lib/types'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import type { EffectivePermission } from '@/lib/permissions/types'
import { cachedModulePermissions } from '@/hooks/queries/usePermissionContext'
import {
  deriveMeetingsCapabilities,
  NO_MEETINGS_CAPABILITIES,
  type MeetingsCapabilities,
} from '@/lib/permissions/meetings'

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
  const queryClient = useQueryClient()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState<MeetingsCapabilities>(NO_MEETINGS_CAPABILITIES)
  const [loading, setLoading] = useState(true)

  // `known`: the module gate's fresh answer (first load), so it is not asked twice.
  // On focus there is none, and the database is asked again.
  const refreshCapabilities = useCallback(async (prof: UserProfile, known?: EffectivePermission[] | null) => {
    const effective = known ?? await getEffectivePermissions(supabase, prof.id, 'meetings').catch(() => [])
    setCaps(deriveMeetingsCapabilities(prof.role, effective))
  }, [supabase])

  useEffect(() => {
    let active = true
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await queryClient.ensureQueryData(profileQueryOptions(queryClient, session.user.id)).then(data => ({ data }))

      if (!active) return
      if (!p) { router.push('/login'); return }

      const prof = p as UserProfile
      setProfile(prof)
      await refreshCapabilities(prof, cachedModulePermissions(queryClient, prof.id, 'meetings'))
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
