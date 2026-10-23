// ── What the Sample Tracking list asks the database ───────────────────────────
//
// Which statuses each tab means, who may see which rows, and how a tab orders
// its page. Pure data — no Supabase import, no React — so the rules are testable
// and the page and its count query cannot drift apart.
//
// WHY THE DATABASE NOW DOES THIS. The list used to read every request with a
// single unbounded select and bucket it in the browser: silently clipped at
// PostgREST's 1000-row ceiling, and the whole table re-downloaded after every
// action. Each tab is now one status filter on one 30-row page.

import type { TabKey } from '@/components/layout/SamplesLayout'

/** The statuses a tab shows. `null` means no status filter (All Requests). */
export const TAB_STATUSES: Record<TabKey, readonly string[] | null> = {
  all:              null,
  pending_approval: ['pending_approval'],
  approved:         ['approved'],
  qr_submitted:     ['qr_submitted'],
  dispatched:       ['dispatched'],
  rejected:         ['rejected'],
  closed:           ['returned', 'lost'],
}

export const TAB_KEYS = Object.keys(TAB_STATUSES) as TabKey[]

/**
 * The rows the effective reader may see: everything for an administrator or
 * anyone holding a Sample Tracking permission, and otherwise only the requests
 * they raised. Returns the requester to restrict to, or null for no restriction.
 *
 * This narrows a set RLS has already decided the caller may read; it is the same
 * rule the page applied to the downloaded rows before paging existed.
 */
export function ownRequestsOnly(input: {
  isAdmin: boolean
  hasAnySamplePermission: boolean
  userId: string
}): string | null {
  if (input.isAdmin || input.hasAnySamplePermission) return null
  return input.userId
}

/**
 * The ordering of a tab's page. Dispatched samples list the overdue ones first
 * (the earliest expected return date), then the rest; every other tab is newest
 * first. `id` is the final key because LIMIT/OFFSET promises nothing between two
 * requests unless the order is unique.
 */
export function tabOrder(tab: TabKey): { column: string; ascending: boolean; nullsFirst?: boolean }[] {
  const base = [
    { column: 'created_at', ascending: false },
    { column: 'id', ascending: false },
  ]
  if (tab === 'dispatched') {
    return [{ column: 'expected_return_date', ascending: true, nullsFirst: false }, ...base]
  }
  return base
}
