import type { BoardPage, WorkLead } from './api'

// How a Lead Board column reads its leads: a page at a time, from the database's own order (sales_board_page, migration
// 20270601000000), so the 1,070 leads of one stage are never fetched at once.

/** How many leads a column asks for each time it reaches its end. */
export const COLUMN_PAGE = 40

/**
 * Where the next page of a column starts, or undefined once the column has been read to its end. Counted over every row
 * received, because the offset is a position in the database's list, not in what the screen shows.
 */
export function nextOffset(last: BoardPage, all: readonly BoardPage[]): number | undefined {
  const loaded = all.reduce((n, p) => n + p.rows.length, 0)
  return last.rows.length > 0 && loaded < last.n ? loaded : undefined
}

/** The leads of every page loaded so far, once each in the order they came: a lead that moved while pages loaded could be in two. */
export function uniqueRows(pages: readonly BoardPage[] | undefined): WorkLead[] {
  const seen = new Set<string>()
  const out: WorkLead[] = []
  for (const page of pages ?? []) for (const row of page.rows) if (!seen.has(row.id)) { seen.add(row.id); out.push(row) }
  return out
}
