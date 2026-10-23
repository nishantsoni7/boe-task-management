import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { TabKey } from '@/components/layout/SamplesLayout'
import { usePagedQuery } from '@/hooks/usePagedQuery'
import { TAB_KEYS, TAB_STATUSES, tabOrder } from '@/lib/samples/listQuery'

// The columns of a request plus the six people it names. `*` is deliberate: the
// card shows nearly every column, and the page maps the joined names itself.
const SAMPLE_SELECT = `
  *,
  requested_by_user:users!requested_by(full_name),
  approved_by_user:users!approved_by(full_name),
  rejected_by_user:users!rejected_by(full_name),
  received_by_user:users!received_by(full_name),
  dispatched_by_user:users!dispatched_by(full_name),
  lost_by_user:users!lost_by(full_name)
`

/** `ownOnly` is the requester to restrict to, or null for every request. */
export type SampleReader = { userId: string; ownOnly: string | null }

/**
 * One page of the active tab, 30 rows, with the exact total for that tab.
 * `userId` is the EFFECTIVE person (View As), so one person's cached pages are
 * never shown for another.
 */
export function useSamplePage(reader: SampleReader, tab: TabKey, page: number, enabled: boolean) {
  return usePagedQuery<Record<string, unknown>>({
    scope: ['samples', reader.userId, reader.ownOnly, tab],
    page,
    enabled: enabled && reader.userId !== '',
    fetchPage: async ({ from, to }) => {
      const statuses = TAB_STATUSES[tab]
      let query = createClient().from('sample_dispatches').select(SAMPLE_SELECT, { count: 'exact' })
      if (statuses) query = query.in('status', [...statuses])
      if (reader.ownOnly) query = query.eq('requested_by', reader.ownOnly)
      for (const o of tabOrder(tab)) {
        query = query.order(o.column, { ascending: o.ascending, nullsFirst: o.nullsFirst })
      }
      const { data, count, error } = await query.range(from, to)
      if (error) throw error
      return { rows: (data ?? []) as unknown as Record<string, unknown>[], total: count ?? 0 }
    },
  })
}

/** The number on every tab, counted by the database (head requests, no rows). */
export function useSampleTabCounts(reader: SampleReader, enabled: boolean) {
  return useQuery<Record<TabKey, number>>({
    queryKey: ['samples', 'counts', reader.userId, reader.ownOnly],
    enabled: enabled && reader.userId !== '',
    staleTime: 30_000,
    queryFn: async () => {
      const supabase = createClient()
      const entries = await Promise.all(TAB_KEYS.map(async tab => {
        const statuses = TAB_STATUSES[tab]
        let query = supabase.from('sample_dispatches').select('id', { count: 'exact', head: true })
        if (statuses) query = query.in('status', [...statuses])
        if (reader.ownOnly) query = query.eq('requested_by', reader.ownOnly)
        const { count, error } = await query
        if (error) throw error
        return [tab, count ?? 0] as const
      }))
      return Object.fromEntries(entries) as Record<TabKey, number>
    },
  })
}
