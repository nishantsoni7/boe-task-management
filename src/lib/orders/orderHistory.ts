// The Confirmed Order's whole chronology, from two trails.
//
// A Confirmed Order's own trail (order_activity_log) starts the day the Order is
// created. Everything before that — the draft, the submission, the payments
// attached, Finance's decisions, the exception, the PI decision — lives on the
// PI's trail (order_submission_activity), which the Order side may read since
// 20261119000000. This module merges the two into one list, newest first, so a
// reader of the Order sees the whole story without a second screen.
//
// NOTHING IS COPIED between tables. Both trails are read as they are and
// interleaved here; an event appears once, on the trail that wrote it.

import {
  PI_ACTIVITY_LABEL,
  PI_ACTIVITY_TONE,
  describeActivityEntries,
  type ActivityEntry as PiActivityEntry,
  type PersistedActivity,
  type PiActivityTone,
} from './submissionActivity'

/** One row of order_activity_log, as the Order page reads it. */
export type OrderActivityRow = {
  id: string
  actor_name?: string
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}

export type OrderHistoryEntry = {
  key: string
  /** 'order' for the Order's own trail, 'pi' for the source PI's. */
  source: 'order' | 'pi'
  label: string
  /** One optional sentence under the label. */
  detail: string | null
  actor: string | null
  createdAtIso: string
  tone: PiActivityTone
}

/**
 * The Order-side events this module can name, beyond the ones the page already
 * labels. Kept here so the new events introduced by 20261119000000 have their
 * words in one place.
 */
export const ORDER_EVENT_LABEL: Record<string, string> = {
  pi_revision_proposed:         'Revised PI uploaded',
  pi_revision_approved:         'Revised PI approved',
  pi_revision_rejected:         'Revised PI rejected',
  production_alignment_changed: 'Production alignment changed',
  payment_verified:             'Payment verified by Finance',
  payment_rejected:             'Payment rejected by Finance',
  order_workbook_replaced:      'PI workbook replaced',
  order_client_details_amended: 'Client details amended',
  order_schedule_terms_amended: 'Schedule or terms amended',
}

export const ORDER_EVENT_TONE: Record<string, PiActivityTone> = {
  pi_revision_proposed:         'amber',
  pi_revision_approved:         'green',
  pi_revision_rejected:         'red',
  production_alignment_changed: 'blue',
  payment_verified:             'green',
  payment_rejected:             'red',
  order_workbook_replaced:      'amber',
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/** One sentence for the Order-side events this module labels. */
export function describeOrderEvent(row: OrderActivityRow): string | null {
  const p = row.payload ?? {}
  switch (row.event_type) {
    case 'pi_revision_proposed': {
      const v = typeof p.version_number === 'number' ? `PI V${p.version_number}` : null
      return [v, text(p.reason)].filter(Boolean).join(' · ') || null
    }
    case 'pi_revision_approved': {
      const v = typeof p.version_number === 'number' ? `PI V${p.version_number} is now current` : null
      const prev = typeof p.superseded_version_number === 'number'
        ? `PI V${p.superseded_version_number} superseded` : null
      return [v, prev].filter(Boolean).join(' · ') || null
    }
    case 'pi_revision_rejected': {
      const v = typeof p.version_number === 'number' ? `PI V${p.version_number}` : null
      return [v, text(p.reason)].filter(Boolean).join(' · ') || null
    }
    case 'production_alignment_changed': {
      const from = p.from === 'aligned' ? 'Aligned' : 'Not Aligned'
      const to = p.to === 'aligned' ? 'Aligned' : 'Not Aligned'
      return [`${from} → ${to}`, text(p.note)].filter(Boolean).join(' · ')
    }
    case 'payment_verified':
    case 'payment_rejected': {
      const id = text(p.human_payment_id) ?? text(p.request_number)
      const amount = typeof p.allocated_amount === 'number' || typeof p.allocated_amount === 'string'
        ? `₹${Number(p.allocated_amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : null
      return [id, amount ? `${amount} allocated to this Order` : null, text(p.admin_note)]
        .filter(Boolean).join(' · ') || null
    }
    case 'order_workbook_replaced':
      return text(p.reason)
    default:
      return null
  }
}

/**
 * The merged chronology, newest first.
 *
 * The Order's own rows are handed in already labelled by the page (it owns the
 * words for its older events); PI rows are labelled by submissionActivity.ts,
 * which drops any action it cannot name. Ties on the timestamp are broken by
 * the key so two events written in one transaction cannot swap between renders.
 */
export function mergeOrderHistory(input: {
  orderRows: readonly OrderActivityRow[]
  /** The page's own label for an Order event, or null to use ORDER_EVENT_LABEL. */
  orderLabel: (eventType: string) => string | null
  orderDetail: (row: OrderActivityRow) => string | null
  piRows: readonly PersistedActivity[]
  namesById: ReadonlyMap<string, string>
  formatWhen: (iso: string | null) => string
}): OrderHistoryEntry[] {
  const order: OrderHistoryEntry[] = input.orderRows.map(row => ({
    key: `order:${row.id}`,
    source: 'order',
    label: input.orderLabel(row.event_type) ?? ORDER_EVENT_LABEL[row.event_type] ?? row.event_type,
    detail: input.orderDetail(row) ?? describeOrderEvent(row),
    actor: row.actor_name ?? null,
    createdAtIso: row.created_at,
    tone: ORDER_EVENT_TONE[row.event_type] ?? 'neutral',
  }))

  // describeActivityEntries formats the time; the ISO instant is needed for the
  // merge, so it is looked back up by id.
  const isoById = new Map(input.piRows.map(r => [r.id, r.created_at]))
  const pi: OrderHistoryEntry[] = describeActivityEntries(input.piRows, input.namesById, input.formatWhen)
    .map((entry: PiActivityEntry) => ({
      key: `pi:${entry.key}`,
      source: 'pi',
      label: entry.label,
      detail: [entry.figures, entry.note].filter((s): s is string => !!s).join(' · ') || null,
      actor: entry.actor,
      createdAtIso: isoById.get(entry.key) ?? '',
      tone: entry.tone,
    }))

  return [...order, ...pi].sort((a, b) => {
    if (a.createdAtIso !== b.createdAtIso) return a.createdAtIso < b.createdAtIso ? 1 : -1
    return a.key < b.key ? 1 : -1
  })
}

/** Re-exported so the page can label a PI event without importing two modules. */
export { PI_ACTIVITY_LABEL, PI_ACTIVITY_TONE }
