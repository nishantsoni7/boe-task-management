// ── How a long list is paged ──────────────────────────────────────────────────
//
// The pure rules every paged list shares: how big a page is, which rows a page
// number means, how many pages a total makes, and which page buttons to draw.
// No React, no Supabase — so each rule is testable directly and no list grows a
// private version of it.
//
// WHY THIS EXISTS. A list that asks for everything and filters in the browser is
// silently truncated at PostgREST's 1000-row ceiling (src/lib/supabasePaging.ts)
// and gets slower with every row the business adds. A page is bounded by
// construction: the database does the narrowing, counts the total, and sends
// only what the reader can see.
//
// The Finance lists page by 50 (src/app/finance/listQuery.ts) and the Completed
// task lists by 20. Cards and tables that are scanned rather than read page by
// 30, and a list that fits in one page shows no pager at all.

/** Rows per page for a paged table or card list. Far below the 1000-row cap. */
export const LIST_PAGE_SIZE = 30

/** The inclusive `.range(from, to)` bounds for a 1-based page number. */
export function listPageRange(page: number, pageSize = LIST_PAGE_SIZE): { from: number; to: number } {
  // A page below 1 is a URL somebody typed, not a state the controls produce.
  // PostgREST refuses a negative offset outright, which would blank the list.
  const safe = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const from = (safe - 1) * pageSize
  return { from, to: from + pageSize - 1 }
}

/** How many pages a total makes. At least one, so an empty list is "page 1 of 1". */
export function listPageCount(total: number | null | undefined, pageSize = LIST_PAGE_SIZE): number {
  if (total == null || !Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * The page a reader should be on after the result set changed size. Staying on
 * page four of a set that now has one page would show an empty table over a
 * filter that matches plenty.
 */
export function clampListPage(page: number, total: number | null | undefined, pageSize = LIST_PAGE_SIZE): number {
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), listPageCount(total, pageSize))
}

/** The 1-based position of the first and last row on a page, for "31–60 of 212". */
export function listPageSpan(page: number, total: number, pageSize = LIST_PAGE_SIZE): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 }
  const safe = clampListPage(page, total, pageSize)
  const first = (safe - 1) * pageSize + 1
  return { first, last: Math.min(total, safe * pageSize) }
}

/** Whether a pager is worth drawing: only when the list does not fit on one page. */
export function needsPager(total: number | null | undefined, pageSize = LIST_PAGE_SIZE): boolean {
  return total != null && Number.isFinite(total) && total > pageSize
}

/** One slot in the page strip: a page number, or a gap standing in for hidden pages. */
export type PageSlot = number | 'gap'

/**
 * The page numbers to draw, with gaps for the pages left out.
 *
 * Always shows the first page, the last page, and `siblings` pages either side
 * of the current one, so a 200-page list is still seven slots wide. A gap
 * covering exactly one page is drawn as that page instead — "1 … 3" would hide
 * a single number behind an ellipsis that is wider than it.
 */
export function pageSlots(page: number, pages: number, siblings = 1): PageSlot[] {
  if (pages <= 1) return [1]
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  const wanted = new Set<number>([1, pages])
  for (let p = current - siblings; p <= current + siblings; p++) {
    if (p >= 1 && p <= pages) wanted.add(p)
  }
  const sorted = [...wanted].sort((a, b) => a - b)

  const slots: PageSlot[] = []
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    const previous = sorted[i - 1]
    if (previous !== undefined && p - previous > 1) {
      slots.push(p - previous === 2 ? previous + 1 : 'gap')
    }
    slots.push(p)
  }
  return slots
}
