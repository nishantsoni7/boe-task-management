'use client'

import { useQuery } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { VENDORS_KEY, fetchVendorPage } from './api'

// The areas already used by active vendors (Basni, Boranada, …), for the suggestions in the vendor form. Read
// from the one-row vendor_list answer, so no extra function is needed. Kept for a minute: it changes rarely.
export function useVendorAreas(supabase: ReturnType<typeof createClient>, enabled: boolean): readonly string[] {
  const { data } = useQuery({
    queryKey: [VENDORS_KEY, 'areas'],
    queryFn: () => fetchVendorPage(supabase, { limit: 1 }),
    enabled,
    staleTime: 60_000,
    select: page => page.areas,
  })
  return data ?? []
}
