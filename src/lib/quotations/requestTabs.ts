// Quotations › Requests: Pending (anything not completed or cancelled, longest waiting first) and Completed (newest
// first), narrowed by a search over the lead, company, project and note. A cancelled request is in neither.
import type { Task } from '@/lib/types'

export type RequestTab = 'pending' | 'completed'

type Row = Pick<Task, 'status' | 'created_at' | 'last_update_at' | 'customer_name' | 'company_name' | 'city_project' | 'title' | 'note'>

const time = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t }

export function requestTabs<T extends Row>(rows: readonly T[], search: string): Record<RequestTab, T[]> {
  const needle = search.trim().toLowerCase()
  const hit = (t: T) => !needle || [t.customer_name, t.company_name, t.city_project, t.title, t.note].some(v => (v ?? '').toLowerCase().includes(needle))
  const found = rows.filter(hit)
  return {
    pending: found.filter(t => t.status !== 'completed' && t.status !== 'cancelled').sort((a, b) => time(a.created_at) - time(b.created_at)),
    completed: found.filter(t => t.status === 'completed').sort((a, b) => time(b.last_update_at) - time(a.last_update_at)),
  }
}
