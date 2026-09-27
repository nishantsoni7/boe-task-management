/**
 * WHAT SALES CHANGED BETWEEN "RETURNED FOR CHANGES" AND THE RESUBMISSION.
 *
 * Read entirely from the append-only activity trail the page already loads —
 * nothing is written, replaced or re-derived from the live row. Each PI edit on
 * a draft logs `parse_replaced` with the same before/after figures
 * (20270122000000), so the reviewer can be shown the FIRST "before" after the
 * return against the LAST "after" before the resubmission.
 *
 * WHAT IT CANNOT SAY. The trail records totals and dates, not product lines:
 * a quantity or price change is visible here only through the totals it moved.
 * `lineDetailRecorded` is false so the panel says so rather than implying the
 * list is complete. Recording the lines needs a migration (see the PR notes).
 */
import { PI_ACTIVITY_LABEL, type PersistedActivity } from '@/lib/orders/submissionActivity'
import { formatInr } from '@/lib/pi/previewView'
import { formatIsoDay } from '@/lib/orders/piInternalDetails'

export type ResubmissionFigureChange = { key: string; label: string; before: string; after: string }

export type ResubmissionChanges = {
  /** When management returned it, as the trail recorded it (ISO). */
  returnedAt: string
  /** How many times the PI itself was edited or replaced in between. */
  editCount: number
  /** The other kinds of change made in between, in the trail's own words. */
  otherChanges: string[]
  /** Figures whose value differs between the first edit's "before" and the last edit's "after". */
  figures: ResubmissionFigureChange[]
  /** Always false today: the trail does not record product lines. */
  lineDetailRecorded: false
}

const FIGURES: { key: string; label: string; kind: 'money' | 'date' | 'text' }[] = [
  { key: 'grand_total', label: 'Grand total', kind: 'money' },
  { key: 'total_before_gst', label: 'Total before GST', kind: 'money' },
  { key: 'gst_amount', label: 'GST', kind: 'money' },
  { key: 'discount_amount', label: 'Discount', kind: 'money' },
  { key: 'discount_label', label: 'Discount wording', kind: 'text' },
  { key: 'order_confirmation_date', label: 'Confirmation date', kind: 'date' },
  { key: 'due_date', label: 'Due date', kind: 'date' },
]

/** Edits that change the PI's content, other than a PI edit or replacement itself. */
const OTHER_EDITS = new Set([
  'client_details_updated', 'client_details_amended_by_admin',
  'schedule_terms_updated', 'schedule_terms_amended_by_admin',
  'product_details_updated', 'product_details_amended_by_admin',
  'billing_percentage_set', 'billing_percentage_amended_by_admin',
  'internal_details_updated', 'workbook_replaced_by_admin',
  'payment_recorded',
])

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

function show(kind: 'money' | 'date' | 'text', v: unknown): string {
  if (v === null || v === undefined || v === '') return 'not set'
  if (kind === 'money') {
    const n = Number(v)
    return Number.isFinite(n) ? formatInr(n) : String(v)
  }
  if (kind === 'date') return formatIsoDay(String(v)) ?? String(v)
  return String(v)
}

/**
 * Null unless the latest submission follows a return for changes (a first
 * submission has nothing to compare against). Order of `rows` does not matter.
 */
export function changesSinceReturn(rows: readonly PersistedActivity[]): ResubmissionChanges | null {
  const ordered = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  let submitAt = -1
  for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i].action === 'submitted') { submitAt = i; break }
  if (submitAt < 0) return null
  let returnAt = -1
  for (let i = submitAt - 1; i >= 0; i--) {
    if (ordered[i].action === 'submitted') break
    if (ordered[i].action === 'changes_requested') { returnAt = i; break }
  }
  if (returnAt < 0) return null

  const between = ordered.slice(returnAt + 1, submitAt)
  const edits = between.filter(r => r.action === 'parse_replaced')
  const otherChanges = [...new Set(between
    .filter(r => OTHER_EDITS.has(r.action))
    .map(r => PI_ACTIVITY_LABEL[r.action] ?? r.action))]

  const first = asObject(asObject(edits[0]?.metadata)?.['before'])
  const last = asObject(asObject(edits[edits.length - 1]?.metadata)?.['after'])
  const figures: ResubmissionFigureChange[] = []
  if (first && last) {
    for (const f of FIGURES) {
      const b = first[f.key] ?? null
      const a = last[f.key] ?? null
      if (String(b ?? '') !== String(a ?? '') && !(f.kind === 'money' && Number(b) === Number(a) && b !== null && a !== null)) {
        figures.push({ key: f.key, label: f.label, before: show(f.kind, b), after: show(f.kind, a) })
      }
    }
  }

  return {
    returnedAt: String(ordered[returnAt].created_at),
    editCount: edits.length,
    otherChanges,
    figures,
    lineDetailRecorded: false,
  }
}

export const RESUBMISSION_CHANGES_TITLE = 'What changed since it was returned'
export const RESUBMISSION_NO_CHANGES = 'Resubmitted without editing the PI.'
export const RESUBMISSION_LINE_DETAIL_NOTE =
  'Product quantities and prices are not recorded separately yet; a line change shows here only through the totals it moved. Check the Products table below.'

export function resubmissionEditLine(c: ResubmissionChanges): string {
  if (c.editCount === 0) return RESUBMISSION_NO_CHANGES
  return `The PI was edited ${c.editCount === 1 ? 'once' : `${c.editCount} times`} before it was resubmitted.`
}
