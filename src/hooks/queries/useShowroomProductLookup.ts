'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import {
  lookupRequestPath,
  shouldRunLookup,
  type ProductLookupResult,
} from '@/lib/showroom/productLookup'

// The sidebar's jump-to-a-product query. Same shape as
// useShowroomProductCounts: one TanStack key, an explicit enabled gate, no
// retry, and a short staleTime so a repeated term inside one search session is
// answered from cache rather than re-fetched.

export type ShowroomProductLookupState = {
  results: ProductLookupResult[]
  loading: boolean
  failed: boolean
}

export const showroomProductLookupKey = (term: string) =>
  ['showroom', 'product-lookup', term] as const

const EMPTY: ProductLookupResult[] = []

export function useShowroomProductLookup(term: string, enabled: boolean): ShowroomProductLookupState {
  const supabase = useMemo(() => createClient(), [])

  // Both gates matter. `enabled` is the caller's (the box is open, the user may
  // manage products); shouldRunLookup is the rule that a blank term is never a
  // request, so an empty box cannot fetch even if the caller forgets.
  const active = enabled && shouldRunLookup(term)

  const { data, isFetching, isError } = useQuery<ProductLookupResult[]>({
    queryKey: showroomProductLookupKey(term),
    enabled: active,
    queryFn: async () => {
      const path = lookupRequestPath(term)
      // Unreachable while `enabled` holds; asserted rather than assumed, since
      // "we fetched a blank term" is the failure that matters here.
      if (!path) return EMPTY
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const res = await fetch(path, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error(`Product lookup failed (HTTP ${res.status})`)
      const json = await res.json() as { products?: ProductLookupResult[] }
      return json.products ?? EMPTY
    },
    retry: false,
    staleTime: 30 * 1000,
  })

  return {
    results: data ?? EMPTY,
    loading: active && isFetching,
    failed: isError,
  }
}
