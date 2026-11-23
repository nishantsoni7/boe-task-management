// "Pending from" on the Quotations list (owner, 23 Nov 2026): how long an OPEN quotation has been waiting.
// A draft counts from when it was made (it has not gone out yet); a sent or negotiating one from when it was sent (it waits for the client).
// Confirmed, lost and archived are not pending. Whole 24-hour days, the amber and red limits and the words are the Dashboard's wait
// for quotation requests (`quotationWait`), so the two read the same. PURE: the caller passes `now` (epoch ms).

import { istDateOf } from '@/lib/istDate'
import { quotationWait, type WaitBand } from '@/lib/tasks/quotationWait'
import type { ListRow } from './api'
import { formatDateIN } from './math'

export type Pending = { label: string; band: WaitBand; note: string }

const day = (iso: string) => formatDateIN(istDateOf(iso))

export function pendingFrom(r: Pick<ListRow, 'status' | 'created_at' | 'sent_at'>, now: number): Pending | null {
  if (r.status === 'draft') {
    const w = quotationWait(r.created_at, now)
    return w && { label: w.label, band: w.band, note: `made ${day(r.created_at)}, not sent` }
  }
  if (r.status === 'sent' || r.status === 'negotiating') {
    // A sent quotation with no sent time (an old row) counts from when it was made.
    const from = r.sent_at ?? r.created_at
    const w = quotationWait(from, now)
    return w && { label: w.label, band: w.band, note: `since ${r.sent_at ? 'sent' : 'made'} ${day(from)}` }
  }
  return null
}
