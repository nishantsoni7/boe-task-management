'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { ShowroomCategory } from '@/lib/types'

// Active showroom categories — the options behind the edit form's Category
// dropdown.
//
// A query rather than a fetch inside the page, because the edit page is now
// somewhere the user *stays*: stepping through forty products with Previous/Next
// remounts it forty times, and the category list is identical every time. One
// request now covers the whole run.

export const showroomCategoriesKey = ['showroom', 'categories'] as const

const EMPTY: ShowroomCategory[] = []

export type ShowroomCategoriesState = {
  categories: ShowroomCategory[]
  failed: boolean
}

export function useShowroomCategories(enabled: boolean): ShowroomCategoriesState {
  const supabase = useMemo(() => createClient(), [])

  const { data, isError, isPaused } = useQuery<ShowroomCategory[]>({
    queryKey: showroomCategoriesKey,
    enabled,
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const res = await fetch('/api/showroom/admin/categories', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error(`Categories request failed (HTTP ${res.status})`)
      const body = await res.json()
      return Array.isArray(body?.categories) ? body.categories as ShowroomCategory[] : []
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  return {
    categories: data ?? EMPTY,
    // Keep the last known list on a later failure rather than emptying the
    // dropdown under someone mid-edit.
    failed: (isError || isPaused) && !data,
  }
}
