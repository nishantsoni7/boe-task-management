'use client'

import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { ProductCategoryCount } from '@/lib/showroom/productNav'

// Counts for the Product Master sidebar. Lives in a query rather than in the
// products page because the sidebar is part of the module shell — the numbers
// have to be right on the Categories page and a product's edit page too, not
// only on the list.
//
// TanStack dedupes to a single request per key, so the layout and the list page
// (which needs the category order to pick a default) share one fetch.

export type ShowroomProductCounts = {
  /** Catalog total under the same rules as the list — active products only. */
  total: number
  /** Stored category names with their counts, ordered by name. */
  categories: ProductCategoryCount[]
}

export type ShowroomProductCountsState = ShowroomProductCounts & {
  /**
   * True once the answer is known — data arrived, or the request failed and
   * will not be retried into a different answer. Callers use this to tell
   * "there are no categories" apart from "the categories have not loaded yet",
   * which is the difference between showing an empty state and discarding a
   * perfectly good bookmark.
   */
  ready: boolean
  /** The counts request failed; `categories` is empty for that reason, not because there are none. */
  failed: boolean
}

export const showroomProductCountsKey = ['showroom', 'product-counts'] as const

const EMPTY: ProductCategoryCount[] = []

/**
 * Ceiling on one attempt, covering the session lookup as well as the request.
 *
 * Product Master cannot render until it knows which categories exist, so a
 * counts request that never settles is not a slow badge — it is a page stuck on
 * a skeleton with no way out. Anything that hangs (a stalled auth lock, a
 * connection that is open but silent) is turned into an error the page can
 * show. Measured against a normal response of well under a second.
 */
const COUNTS_TIMEOUT_MS = 6000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Product counts request timed out')), ms)
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

export function useShowroomProductCounts(enabled: boolean): ShowroomProductCountsState {
  const supabase = useMemo(() => createClient(), [])

  const { data, isSuccess, isError, isPaused } = useQuery<ShowroomProductCounts>({
    queryKey: showroomProductCountsKey,
    enabled,
    queryFn: () => withTimeout((async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const res = await fetch('/api/showroom/admin/products?counts=1', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      // A failed count keeps the last known numbers rather than flashing zeros —
      // same reasoning as the notification badges.
      if (!res.ok) throw new Error(`Product counts request failed (HTTP ${res.status})`)
      return res.json() as Promise<ShowroomProductCounts>
    })(), COUNTS_TIMEOUT_MS),
    // One attempt. Every retry is another COUNTS_TIMEOUT_MS the page spends on a
    // skeleton, and a refresh is a better answer than a longer wait.
    retry: false,
    staleTime: 30 * 1000,
  })

  return {
    total: data?.total ?? 0,
    categories: data?.categories ?? EMPTY,
    // A failure — including "the browser says we are offline", which parks the
    // query indefinitely — is an answer too. The page must stop waiting and say
    // so rather than sitting on a skeleton forever.
    ready: isSuccess || isError || isPaused,
    failed: (isError || isPaused) && !data,
  }
}

/** Refresh the badges after a create, delete or activate/deactivate. */
export function useRefreshShowroomProductCounts(): () => void {
  const queryClient = useQueryClient()
  return () => { queryClient.invalidateQueries({ queryKey: showroomProductCountsKey }) }
}
