import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LIST_PAGE_SIZE, listPageCount, listPageRange } from '@/lib/listPaging'

/** What one page read returns: the rows on the page and the exact total behind them. */
export type PagedResult<T> = { rows: T[]; total: number }

type Options<T> = {
  /**
   * Names the list AND everything that narrows it: the screen, the effective
   * person (View As), the tab, the filters, the search. Two pages share cached
   * rows only when this is identical, so a filter change can never show the
   * previous filter's rows while the new ones load. Must be JSON-serialisable.
   */
  scope: readonly unknown[]
  page: number
  pageSize?: number
  enabled?: boolean
  /** Reads rows `from..to` (inclusive) and the exact total. Must throw on failure. */
  fetchPage: (range: { from: number; to: number }) => Promise<PagedResult<T>>
  /** How long a cached page is served without a re-read. Defaults to 30 seconds. */
  staleTime?: number
}

/**
 * One page of a long list, built so moving between pages does not feel like
 * loading.
 *
 *  - KEEP THE LAST PAGE ON SCREEN. While the next page loads the reader keeps
 *    the rows they were looking at (`isFetchingNext` is true) — never a blank
 *    table or a spinner — but only within the same scope. Changing the tab, a
 *    filter or the viewed person drops the old rows.
 *  - READ THE NEXT PAGE EARLY. Once this page has landed, the one after it is
 *    fetched quietly, so pressing Next is instant. `prefetchPage` does the same
 *    for any page a pager button is hovered or focused on.
 *  - A FAILED READ IS NOT AN EMPTY LIST. `fetchPage` throws, the query errors,
 *    and the caller shows a retry — it is never cached as zero rows.
 */
export function usePagedQuery<T>({
  scope, page, pageSize = LIST_PAGE_SIZE, enabled = true, fetchPage, staleTime = 30_000,
}: Options<T>) {
  const queryClient = useQueryClient()
  const scopeKey = JSON.stringify(scope)

  // The reader is always the latest closure; the query key is what identifies it.
  const fetchRef = useRef(fetchPage)
  useEffect(() => { fetchRef.current = fetchPage })

  const optionsFor = useCallback((target: number) => ({
    queryKey: ['paged', scopeKey, target] as const,
    queryFn: () => fetchRef.current(listPageRange(target, pageSize)),
    staleTime,
  }), [scopeKey, pageSize, staleTime])

  const query = useQuery<PagedResult<T>>({
    ...optionsFor(page),
    enabled,
    // Rows from the previous page are reused only inside the same scope.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === scopeKey ? previous : undefined,
    gcTime: 5 * 60_000,
  })

  const total = query.data?.total ?? null
  const pages = listPageCount(total, pageSize)

  const prefetchPage = useCallback((target: number) => {
    if (!enabled || target < 1 || target > pages) return
    void queryClient.prefetchQuery(optionsFor(target))
  }, [enabled, pages, queryClient, optionsFor])

  // Warm the next page as soon as this one has settled.
  useEffect(() => {
    if (query.isSuccess && !query.isPlaceholderData && page < pages) prefetchPage(page + 1)
  }, [query.isSuccess, query.isPlaceholderData, page, pages, prefetchPage])

  return {
    rows: query.data?.rows ?? [],
    total,
    pages,
    /** First load of this scope, with nothing to show yet. */
    isLoading: query.isPending,
    /** Showing the previous page's rows while this one loads. */
    isFetchingNext: query.isPlaceholderData,
    isError: query.isError,
    refetch: query.refetch,
    prefetchPage,
  }
}
