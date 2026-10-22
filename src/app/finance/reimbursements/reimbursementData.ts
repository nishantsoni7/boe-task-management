// ── Reading reimbursements for the history page and the Excel files ──────────
//
// Every read here runs as the signed-in person, so row-level security decides
// what comes back: the batches are readable by company-wide Finance sight (or
// whoever recorded one), an item by anyone who may read its expense. Nothing
// here widens that, and an export can only contain what the screen could show.

import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaging'
import { reimbursementWorkbook, type ExportBatch, type ExportBatchItem } from '@/lib/finance/expenseReimbursementExport'

type Supabase = ReturnType<typeof createClient>

export const BATCH_COLUMNS =
  'id, reimbursed_on, reference, payer_id, expense_count, total_amount, status, note, recorded_by, recorded_at, reversed_at, reversal_reason'

const ITEM_COLUMNS =
  'reimbursement_id, amount, paid_by, expense:expenses!expense_reimbursement_items_expense_id_fkey(expense_date, paid_to, remark)'

/** Ids per request: a URL carrying hundreds of uuids is refused by the gateway. */
const IDS_PER_REQUEST = 60

/** The line items of the given batches. Throws a readable error rather than returning a short list. */
export async function loadBatchItems(supabase: Supabase, batchIds: readonly string[]): Promise<ExportBatchItem[]> {
  const items: ExportBatchItem[] = []
  for (let i = 0; i < batchIds.length; i += IDS_PER_REQUEST) {
    const ids = batchIds.slice(i, i + IDS_PER_REQUEST)
    const result = await fetchAllRows<ExportBatchItem>((from, to) =>
      supabase
        .from('expense_reimbursement_items')
        .select(ITEM_COLUMNS)
        .in('reimbursement_id', ids)
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: ExportBatchItem[] | null; error: { message: string } | null }>)
    if (!result.ok) throw new Error('The reimbursed expenses could not be read. Nothing was downloaded.')
    if (result.truncated) throw new Error('There are too many lines to download at once. Narrow the dates and try again.')
    items.push(...result.rows)
  }
  return items
}

export type BatchFilters = {
  dateFrom: string
  dateTo: string
  payerId: string
  status: '' | 'recorded' | 'reversed'
  search: string
}

export const EMPTY_BATCH_FILTERS: BatchFilters = { dateFrom: '', dateTo: '', payerId: '', status: '', search: '' }

/** A search term as a literal for ILIKE: %, _ and \ lose their special meaning. */
export function ilikeLiteral(term: string): string {
  return term.trim().replace(/[\\%_]/g, c => `\\${c}`)
}

/** The batches matching the filters, as a query ready to be ordered and ranged. */
export function batchQuery(supabase: Supabase, filters: BatchFilters) {
  let q = supabase.from('expense_reimbursements').select(BATCH_COLUMNS, { count: 'exact' })
  if (filters.dateFrom) q = q.gte('reimbursed_on', filters.dateFrom)
  if (filters.dateTo) q = q.lte('reimbursed_on', filters.dateTo)
  if (filters.payerId) q = q.eq('payer_id', filters.payerId)
  if (filters.status) q = q.eq('status', filters.status)
  const term = ilikeLiteral(filters.search)
  if (term) q = q.ilike('reference', '%' + term + '%')
  return q
}

/** Every batch matching the filters (for totals and for the Excel file). */
export async function loadAllBatches(supabase: Supabase, filters: BatchFilters): Promise<ExportBatch[]> {
  const result = await fetchAllRows<ExportBatch>((from, to) =>
    batchQuery(supabase, filters)
      .order('reimbursed_on', { ascending: false })
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: ExportBatch[] | null; error: { message: string } | null }>)
  if (!result.ok) throw new Error('The reimbursements could not be read. Nothing was downloaded.')
  if (result.truncated) throw new Error('There are too many reimbursements to download at once. Narrow the dates and try again.')
  return result.rows
}

/** Batches by id, for the file offered right after one is recorded. */
export async function loadBatchesByIds(supabase: Supabase, ids: readonly string[]): Promise<ExportBatch[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('expense_reimbursements').select(BATCH_COLUMNS).in('id', ids as string[])
  if (error) throw new Error('The reimbursement could not be read. Nothing was downloaded.')
  return (data ?? []) as unknown as ExportBatch[]
}

/** id → full name for the people on the rows in hand (a failed read names nobody). */
export async function loadPeopleNames(supabase: Supabase, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const { data } = await supabase.from('users').select('id, full_name').in('id', unique)
  return new Map(((data ?? []) as { id: string; full_name: string | null }[]).map(u => [u.id, u.full_name ?? '']))
}

/** The whole workbook (summary + lines) for the given batches. */
export async function loadReimbursementSheets(supabase: Supabase, batches: readonly ExportBatch[]) {
  const items = await loadBatchItems(supabase, batches.map(b => b.id))
  const names = await loadPeopleNames(supabase, [
    ...batches.flatMap(b => [b.payer_id, b.recorded_by]),
    ...items.map(i => i.paid_by),
  ])
  return reimbursementWorkbook(batches, items, id => (id && names.get(id)) || '—')
}
