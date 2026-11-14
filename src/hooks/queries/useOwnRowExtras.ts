'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { PERMISSION_GC_MS, PERMISSION_STALE_MS } from '@/hooks/queries/usePermissionContext'

// THE FOUR COLUMNS OF THE SIGNED-IN PERSON'S OWN ROW THAT THE SHARED PROFILE DELIBERATELY LEAVES OUT,
// READ ONCE (2026-11-14, page speed part 6).
//
// The Modules page read `payroll_active, is_deleted` (does this person take part in Attendance & Payroll,
// for the "Request attendance" button) and the account menu read `position, designation_level` (the line
// under their name): two requests for the same row, one in each step of the page, and a request that waits
// beside others finishes later. They are one read now, under one cache entry, whichever asks first.
//
// WHY NOT THE SHARED PROFILE. usePermissionContext / useProfile select a fixed column list on purpose: the
// permission code must never read designation_level, and the shared row is what that code is handed. This
// is a separate cache entry that no permission code reads. `authenticated` may select all four columns
// (20260813000000 and the account menu's own read before this one).
//
// A failed read is an error here, not a guess: the "Request attendance" button is offered when it fails
// (as it was before this rule existed) and the account menu simply shows no designation line.

export type OwnRowExtras = {
  payroll_active: boolean | null
  is_deleted: boolean | null
  position: string | null
  designation_level: string | null
}

export const OWN_ROW_EXTRA_COLUMNS = 'payroll_active, is_deleted, position, designation_level'
export const ownRowExtrasKey = (userId: string | null | undefined) => ['own-row-extras', userId] as const

/** `staleTime` is the CALLER's own freshness: the launcher wants 30 s as before, the account menu 5 minutes. */
export function useOwnRowExtras(
  userId: string | null | undefined,
  { enabled = true, staleTime = PERMISSION_STALE_MS }: { enabled?: boolean; staleTime?: number } = {},
) {
  return useQuery<OwnRowExtras>({
    queryKey: ownRowExtrasKey(userId),
    enabled: enabled && !!userId,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('users')
        .select(OWN_ROW_EXTRA_COLUMNS)
        .eq('id', userId!)
        .single()
      if (error) throw error
      return data as unknown as OwnRowExtras
    },
    staleTime,
    gcTime: PERMISSION_GC_MS,
  })
}
