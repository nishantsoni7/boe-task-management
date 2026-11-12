// OPERATIONS FLAGS PI LINES BEFORE AN ORDER IS ALIGNED (20270616000000).
//
// Operations (2026-11-12) asked to comment on a line whose price is very low, quantity small or design
// complicated, and to reject a line they cannot make as quoted, early enough for Sales to cancel, revise
// or pitch a stock design. The reviewer marks each line OK, Comment or Cannot make; the database
// (flag_order_lines) composes the reason and hands the decision to decide_order_operations_handoff()
// unchanged: any Cannot make flags the PI (the Order stays not aligned), comments only accept it.
//
// This module owns the words and the rules a test can pin: the reasons, what a marked line needs, what
// the review button says, the payload the database is sent, the reader of what it returns, and the
// refusal sentences. No React, no network beyond the one read helper.

import { isDashboardFunctionMissing } from '@/lib/orders/salespersonDashboard'

// ── Reasons ───────────────────────────────────────────────────────────────────

export const LINE_FLAG_REASONS = [
  { code: 'price_low', label: 'Price too low' },
  { code: 'quantity_low', label: 'Quantity too low' },
  { code: 'complicated_design', label: 'Complicated design' },
  { code: 'size', label: 'Size or dimension' },
  { code: 'material', label: 'Material or finish' },
  { code: 'other', label: 'Other' },
] as const

export type LineFlagReason = typeof LINE_FLAG_REASONS[number]['code']
const REASON_CODES: readonly string[] = LINE_FLAG_REASONS.map(r => r.code)
export const reasonLabel = (code: string): string => LINE_FLAG_REASONS.find(r => r.code === code)?.label ?? code

export type LineFlagKind = 'comment' | 'cannot_make'
export type LineMarkKind = 'ok' | LineFlagKind

export const LINE_MARK_LABEL: Record<LineMarkKind, string> = { ok: 'OK', comment: 'Comment', cannot_make: 'Cannot make' }
export const LINE_FLAG_KIND_LABEL: Record<LineFlagKind, string> = { comment: 'Comment', cannot_make: 'Cannot make as quoted' }

export const LINE_NOTE_MAX_LENGTH = 1000

// ── Words ─────────────────────────────────────────────────────────────────────

export const FLAG_LINES_LABEL = 'Flag lines…'
export const LINE_REVIEW_TITLE = (versionLabel: string) => `Review ${versionLabel} lines`
export const LINE_REVIEW_HINT = 'Mark only the lines that need attention. A line you leave as OK is accepted.'
export const LINE_REVIEW_OTHER_REASON = 'Cannot accept this PI for another reason…'
export const LINE_NOTE_LABEL = 'Note for Sales'
export const LINE_NOTE_PLACEHOLDER = 'What Sales should know or check with the client'
export const LINE_PRICE_LABEL = 'Price should be'
export const LINE_PRICE_HINT = 'per piece · optional · internal, never on a client document'
export const LINE_MARK_INCOMPLETE = 'Pick a reason and write a note.'
export const FLAGGED_BY = (name: string | null) => `Operations${name ? ` · ${name}` : ''}`
export const RESPOND_LINE_PLACEHOLDER = 'Optional: e.g. keep as quoted, the client agreed the price'
export const RESPOND_GENERAL_LABEL = 'Anything else for Operations'

// ── The reviewer's marks ──────────────────────────────────────────────────────

export type LineMark = {
  kind: LineMarkKind
  reasons: readonly LineFlagReason[]
  note: string
  /** As typed: "7,000", "₹ 7000.50", or blank. */
  price: string
}

export const OK_MARK: LineMark = { kind: 'ok', reasons: [], note: '', price: '' }

/** "7,000" / "₹7000.5" → 7000 / 7000.5; blank → null; anything unusable → NaN. */
export function parseSuggestedPrice(raw: string): number | null {
  const text = raw.replace(/[₹,\s]/g, '')
  if (text === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return Number.NaN
  const n = Number(text)
  return n > 0 && n < 1e10 ? n : Number.NaN
}

/** Why a marked line cannot be sent yet, or null when it can (an OK line always can). */
export function lineMarkProblem(mark: LineMark): string | null {
  if (mark.kind === 'ok') return null
  if (mark.reasons.length === 0 || mark.note.trim() === '') return LINE_MARK_INCOMPLETE
  if (mark.note.trim().length > LINE_NOTE_MAX_LENGTH) return `A note may be at most ${LINE_NOTE_MAX_LENGTH} characters.`
  if (mark.reasons.includes('price_low') && Number.isNaN(parseSuggestedPrice(mark.price))) {
    return 'Write the price as a number, like 7000, or leave it blank.'
  }
  return null
}

export type LineReviewSummary = {
  ok: number
  comments: number
  cannotMake: number
  incomplete: number
  /** What the primary button does. */
  action: 'accept' | 'accept_with_comments' | 'send_back'
  actionLabel: string
  /** One line under the buttons: what pressing it does, or what is missing. */
  note: string
  ready: boolean
}

export function summarizeLineReview(marks: readonly LineMark[]): LineReviewSummary {
  const ok = marks.filter(m => m.kind === 'ok').length
  const comments = marks.filter(m => m.kind === 'comment').length
  const cannotMake = marks.filter(m => m.kind === 'cannot_make').length
  const incomplete = marks.filter(m => lineMarkProblem(m) !== null).length
  const action = cannotMake > 0 ? 'send_back' : comments > 0 ? 'accept_with_comments' : 'accept'
  const actionLabel = action === 'send_back' ? 'Send back to Sales' : action === 'accept_with_comments' ? 'Accept with comments' : 'Accept for production'
  const note = incomplete > 0
    ? `${incomplete} flagged line${incomplete === 1 ? ' still needs' : 's still need'} a reason and a note.`
    : action === 'send_back'
      ? 'The Order stays not aligned until Sales answers.'
      : action === 'accept_with_comments'
        ? 'Aligns the Order for production. Sales sees each comment.'
        : 'Aligns the Order for production, as today.'
  return { ok, comments, cannotMake, incomplete, action, actionLabel, note, ready: incomplete === 0 }
}

export type LineFlagPayload = {
  item_id: string
  kind: LineFlagKind
  reasons: LineFlagReason[]
  note: string
  suggested_price: number | null
}

/** The lines flag_order_lines() is sent: marked lines only, in table order. Throws on an incomplete mark. */
export function lineFlagPayload(lines: readonly { itemId: string; mark: LineMark }[]): LineFlagPayload[] {
  return lines.flatMap(({ itemId, mark }) => {
    if (mark.kind === 'ok') return []
    const problem = lineMarkProblem(mark)
    if (problem) throw new Error(problem)
    const price = mark.reasons.includes('price_low') ? parseSuggestedPrice(mark.price) : null
    return [{ item_id: itemId, kind: mark.kind, reasons: [...mark.reasons], note: mark.note.trim(), suggested_price: price }]
  })
}

// ── What the database returns (order_line_flags_for) ─────────────────────────

export type LineFlag = {
  itemId: string | null
  lineCode: string | null
  lineTitle: string | null
  kind: LineFlagKind
  reasons: string[]
  note: string
  suggestedPrice: number | null
  flaggedAt: string
  byName: string | null
  handoffId: string
  versionNumber: number
  handoffStatus: 'awaiting' | 'accepted' | 'clarification_needed'
}

export function readLineFlags(raw: unknown): LineFlag[] {
  if (!Array.isArray(raw)) throw new Error('The line flags answer is not a list.')
  return raw.map((x): LineFlag => {
    if (typeof x !== 'object' || x === null) throw new Error('A line flag is not an object.')
    const o = x as Record<string, unknown>
    if (o.kind !== 'comment' && o.kind !== 'cannot_make') throw new Error('A line flag has no kind.')
    if (typeof o.handoff_id !== 'string' || typeof o.note !== 'string') throw new Error('A line flag is incomplete.')
    const status = o.handoff_status
    if (status !== 'awaiting' && status !== 'accepted' && status !== 'clarification_needed') throw new Error('A line flag has no review status.')
    const price = o.suggested_price === null || o.suggested_price === undefined ? null : Number(o.suggested_price)
    return {
      itemId: typeof o.item_id === 'string' ? o.item_id : null,
      lineCode: typeof o.line_code === 'string' ? o.line_code : null,
      lineTitle: typeof o.line_title === 'string' ? o.line_title : null,
      kind: o.kind,
      reasons: Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === 'string') : [],
      note: o.note,
      suggestedPrice: price !== null && Number.isFinite(price) ? price : null,
      flaggedAt: typeof o.flagged_at === 'string' ? o.flagged_at : '',
      byName: typeof o.by_name === 'string' && o.by_name.trim() !== '' ? o.by_name.trim() : null,
      handoffId: o.handoff_id,
      versionNumber: Number(o.version_number) || 1,
      handoffStatus: status,
    }
  })
}

/** available = this database has the doors; when false the page keeps the older Cannot accept window. */
export type LineFlagsRead = { available: boolean; flags: LineFlag[] }

type RpcLike = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> }

export async function loadLineFlags(client: RpcLike, orderId: string): Promise<LineFlagsRead> {
  try {
    const { data, error } = await client.rpc('order_line_flags_for', { p_order_id: orderId })
    if (isDashboardFunctionMissing(error)) return { available: false, flags: [] }
    if (error) return { available: false, flags: [] }
    return { available: true, flags: readLineFlags(data) }
  } catch {
    return { available: false, flags: [] }
  }
}

/** The pill on a flagged product row. A Cannot make Operations has since accepted is said as settled. */
export function lineFlagStatus(flag: Pick<LineFlag, 'kind' | 'handoffStatus'>): { label: string; tone: 'red' | 'amber' | 'green' } {
  if (flag.kind === 'comment') return { label: LINE_FLAG_KIND_LABEL.comment, tone: 'amber' }
  if (flag.handoffStatus === 'accepted') return { label: 'Flagged, then accepted by Operations', tone: 'green' }
  return { label: LINE_FLAG_KIND_LABEL.cannot_make, tone: 'red' }
}

export function formatSuggestedPrice(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

/** A saved flag back into the reviewer's mark, so flagging again starts from what was said. */
export function markFromFlag(flag: LineFlag): LineMark {
  return {
    kind: flag.kind,
    reasons: flag.reasons.filter((r): r is LineFlagReason => REASON_CODES.includes(r)),
    note: flag.note,
    price: flag.suggestedPrice === null ? '' : String(flag.suggestedPrice),
  }
}

// ── Sales' answer, line by line, as ONE remark ────────────────────────────────

/** "700-BE0002 Dining Chair: keep as quoted…" lines, then the general words. Blank entries are left out. */
export function composeLineRemarks(lines: readonly { label: string; text: string }[], general: string): string {
  const parts = lines
    .filter(l => l.text.trim() !== '')
    .map(l => `${l.label}: ${l.text.trim().replace(/\s+/g, ' ')}`)
  if (general.trim() !== '') parts.push(general.trim())
  return parts.join('\n')
}

// ── Refusals ──────────────────────────────────────────────────────────────────

/** The sentence for a refusal flag_order_lines() raises itself; null for anything else (decide's words apply). */
export function describeLineFlagFailure(error: { message?: string | null } | null | undefined): string | null {
  const m = error?.message ?? ''
  if (m.includes('ORDER_LINE_FLAGS_NONE')) return 'Mark at least one line, or accept the PI as it is.'
  if (m.includes('ORDER_LINE_FLAGS_UNKNOWN_LINE')) return 'A line you marked is no longer on this PI version. Refresh the page.'
  if (m.includes('ORDER_LINE_FLAGS_REASON_REQUIRED') || m.includes('ORDER_LINE_FLAGS_NOTE_REQUIRED')) return 'Every marked line needs a reason and a note.'
  if (m.includes('ORDER_LINE_FLAGS_NOTE_TOO_LONG')) return `A note may be at most ${LINE_NOTE_MAX_LENGTH} characters.`
  if (m.includes('ORDER_LINE_FLAGS_PRICE_INVALID')) return 'The suggested price must be a number above zero.'
  if (m.includes('ORDER_LINE_FLAGS_KIND_UNKNOWN') || m.includes('ORDER_LINE_FLAGS_INVALID')) return 'The review could not be read. Refresh the page and try again.'
  if (m.includes('Only the assigned operations reviewer can flag')) return 'Only the assigned operations reviewer can flag lines. Being an administrator does not count.'
  return null
}
