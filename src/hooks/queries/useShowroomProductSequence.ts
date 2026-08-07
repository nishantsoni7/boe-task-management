'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'

// The ordered run of product codes behind Previous/Next on a product's edit
// page.
//
// Keyed by the *sequence context* (category + search + status + sort, never the
// page), so stepping through forty products issues ONE request: every product in
// the run shares the same key, and TanStack serves the rest from cache. That is
// what makes Previous/Next feel instant — the neighbour is already known before
// the click, and only the product itself has to be fetched.

export type ShowroomProductSequence = {
  /** Product codes in the list's own order. */
  codes: string[]
  /** The run hit the server's cap; products past it have no neighbours. */
  truncated: boolean
}

export const showroomProductSequenceKey = (search: string) =>
  ['showroom', 'product-sequence', search] as const

const EMPTY: string[] = []

export type ShowroomProductSequenceState = ShowroomProductSequence & {
  /** The answer is known — either the codes arrived or the request failed. */
  ready: boolean
}

/**
 * @param search Sequence context from `productSequenceSearch()`. An empty string
 *   means there is no run to load (no category is known yet), and no request is
 *   made — there is no all-products sequence, just as there is no all-products
 *   list.
 */
export function useShowroomProductSequence(
  search: string,
  enabled: boolean,
): ShowroomProductSequenceState {
  const supabase = useMemo(() => createClient(), [])

  const { data, isSuccess, isError, isPaused } = useQuery<ShowroomProductSequence>({
    queryKey: showroomProductSequenceKey(search),
    enabled: enabled && !!search,
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const res = await fetch(`/api/showroom/admin/products?sequence=1&${search}`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error(`Product sequence request failed (HTTP ${res.status})`)
      return res.json() as Promise<ShowroomProductSequence>
    },
    // One attempt, and a generous window: the run only moves when a product is
    // added, deleted, renamed or recategorised. A stale entry costs a hidden
    // arrow at worst — never a step to the wrong product, because the code is
    // looked up in the run rather than trusted from it.
    retry: false,
    staleTime: 60 * 1000,
  })

  return {
    codes: data?.codes ?? EMPTY,
    truncated: data?.truncated ?? false,
    ready: isSuccess || isError || isPaused,
  }
}
