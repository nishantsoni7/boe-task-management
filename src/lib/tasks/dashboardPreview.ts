/**
 * The dashboard's attention cards show a short preview of a list that can grow
 * without limit. The card keeps the list's own ranking, count and destination;
 * it only decides how many rows to draw and what the "view all" footer says.
 */

export const DASHBOARD_PREVIEW_LIMIT = 5

export type PreviewKind = 'overdue' | 'acknowledgement' | 'quotation'

const NOUNS: Record<PreviewKind, readonly [string, string]> = {
  overdue: ['overdue task', 'overdue tasks'],
  acknowledgement: ['task awaiting acknowledgement', 'tasks awaiting acknowledgement'],
  quotation: ['quotation request', 'quotation requests'],
}

/** The first rows of an already-ranked list. The input is never reordered. */
export function previewRows<T>(items: readonly T[]): T[] {
  return items.slice(0, DASHBOARD_PREVIEW_LIMIT)
}

/** Footer text when rows are hidden, otherwise null (nothing to expand). */
export function previewFooterLabel(kind: PreviewKind, total: number): string | null {
  if (total <= DASHBOARD_PREVIEW_LIMIT) return null
  const [one, many] = NOUNS[kind]
  return `View all ${total} ${total === 1 ? one : many}`
}
