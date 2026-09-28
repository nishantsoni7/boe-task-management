// ── The order highlight remark (20270210000000) ──────────────────────────────
//
// One optional INTERNAL note Sales writes on a PI draft for whoever works the
// Order: shown at the top of the Confirmed Order, labelled as internal, and
// never printed on the client PI, its PDF, the confirmed Excel or a message.
//
// It lives on order_submissions.order_highlight_remark, so it survives approval
// with no copy: the Confirmed Order points at that row
// (orders.source_order_submission_id) and reads it from there. It is written
// only by set_order_submission_highlight_remark(), which admits the owner or an
// active admin while the PI is a draft or returned — can_edit_order_submission.
//
// READ SEPARATELY, AND FAILURE-TOLERANT. Neither page adds the column to its
// main select: a deploy that reaches the browser before the migration reaches
// the database would otherwise fail the whole PI or Order read. A failed read
// here means "no remark to show and no editor", never a broken page.

export const HIGHLIGHT_REMARK_COLUMN = 'order_highlight_remark'
export const HIGHLIGHT_REMARK_RPC = 'set_order_submission_highlight_remark'
/** The database's own limit (order_submissions_highlight_remark_len). */
export const HIGHLIGHT_REMARK_MAX = 1000

export const HIGHLIGHT_REMARK_TITLE = 'Order highlight'
export const HIGHLIGHT_REMARK_TAG = 'Internal'
export const HIGHLIGHT_REMARK_OPTIONAL = 'Optional'
export const HIGHLIGHT_REMARK_NOTE =
  'For BOE only. Shown at the top of the Confirmed Order; never printed on the client PI, PDF or messages.'
export const HIGHLIGHT_REMARK_PLACEHOLDER =
  'Anything the team working this Order must see first — e.g. client visiting the factory on the 12th.'
export const HIGHLIGHT_REMARK_EMPTY = 'No highlight added.'
/** The Confirmed Order's label: the same words, so the two pages are one note. */
export const ORDER_HIGHLIGHT_LABEL = 'Internal highlight'

/** What the RPC will store: trimmed, and blank as null. */
export function normalizeHighlightRemark(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** The one shape problem a browser can know about before the RPC does. */
export function highlightRemarkProblem(value: string): string | null {
  const normalized = normalizeHighlightRemark(value)
  if (normalized !== null && normalized.length > HIGHLIGHT_REMARK_MAX) {
    return `Keep the highlight to ${HIGHLIGHT_REMARK_MAX.toLocaleString('en-IN')} characters.`
  }
  return null
}

/**
 * The remark off a read of that one column. Anything but a non-blank string —
 * no row, an error, a column the database does not have yet — reads as none.
 */
export function readHighlightRemark(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const value = (data as Record<string, unknown>)[HIGHLIGHT_REMARK_COLUMN]
  return typeof value === 'string' ? normalizeHighlightRemark(value) : null
}

/** A refused or failed save, in words. The RPC's own sentences are kept. */
export function highlightRemarkSaveFailure(error: { message?: string; code?: string } | null | undefined): string {
  const message = (error?.message ?? '').trim()
  if (!error?.code && /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message)) {
    return 'The highlight could not be saved — check the connection and try again.'
  }
  // The RPC prefixes a machine code ("ORDER_SUBMISSION_STALE: …"); the reader
  // gets the sentence after it.
  const sentence = message.replace(/^[A-Z_]+:\s*/, '')
  return sentence || 'The highlight could not be saved.'
}
