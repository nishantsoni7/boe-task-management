'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { pathWithSearch } from '@/lib/tasks/taskReturnPath'

/**
 * This page's own path and query — the exact view to hand Task Detail as
 * `returnTo`, so Submit for Approval can bring the user back to it with the same
 * tab, filters, search and page.
 *
 * Requires a `<Suspense>` boundary above it (it reads `useSearchParams`). Every
 * task list page already has one for its URL list state.
 */
export function useCurrentReturnPath(): string {
  return pathWithSearch(usePathname(), useSearchParams().toString())
}
