// THE OPERATIONS DASHBOARD'S OWN READ, AS THE PAGE USES IT (20270401000000).
//
// public.operations_orders_dashboard() returns what the Operations team needs
// beyond orders_dashboard_summary(): the changes to Orders already in
// production that are waiting for THIS reader's answer, the answers already
// given, and Orders / Dispatches for last month and the last six months.
//
// Like orderDashboardSummary.ts this module VALIDATES the payload, owns the
// words and formats the figures; it computes nothing about orders. A payload it
// cannot read is an error, never an empty dashboard — an empty "changes" list
// would tell Operations nothing needs an answer because a query misbehaved.

export type ChangeDecision = 'can_do' | 'cannot_do' | 'discuss'

export type ChangeDetail = { label: string; old: string | null; new: string | null }

export type ChangeLine = {
  key: string
  title: string
  kind: 'added' | 'removed' | 'changed'
  changes: ChangeDetail[]
  answer: { decision: ChangeDecision; note: string | null } | null
}

export type PendingChange = {
  handoffId: string
  orderId: string
  displayNumber: string
  clientName: string
  versionNumber: number
  approvedAt: string
  approvedByName: string | null
  revisionReason: string | null
  /** False when the replaced version's content was not kept (older data). */
  available: boolean
  lines: ChangeLine[]
}

export type ChangeResponse = {
  handoffId: string
  orderId: string
  displayNumber: string
  clientName: string
  versionNumber: number
  stillCurrent: boolean
  answeredAt: string
  answeredByName: string | null
  canDo: number
  cannotDo: number
  discuss: number
  lines: { key: string; title: string; decision: ChangeDecision; note: string | null }[]
}

export type PeriodFigure = { count: number; value: number }
export type OrdersVsDispatches = {
  from: string
  to: string
  orders: PeriodFigure
  dispatches: PeriodFigure
}

export type OperationsRead = {
  today: string
  viewer: { isReviewer: boolean; isApprover: boolean }
  pending: PendingChange[]
  responses: ChangeResponse[]
  lastMonth: OrdersVsDispatches
  lastSixMonths: OrdersVsDispatches
  gaps: { dispatchedWithoutDate: number; ordersWithoutValue: number; noConfirmDate: number }
}

export type ParsedOperationsRead =
  | { ok: true; read: OperationsRead }
  | { ok: false; message: string }

class Bad extends Error {}
type Obj = Record<string, unknown>

const obj = (v: unknown, what: string): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Bad(what)
  return v as Obj
}
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Bad(what)
  return v
}
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v === '') throw new Bad(what)
  return v
}
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new Bad(what)
  return n
}
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw new Bad(what)
  return v
}
const decision = (v: unknown, what: string): ChangeDecision => {
  if (v !== 'can_do' && v !== 'cannot_do' && v !== 'discuss') throw new Bad(what)
  return v
}
const scalar = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

const figure = (v: unknown, what: string): PeriodFigure => {
  const o = obj(v, what)
  return { count: num(o.count, what), value: num(o.value, what) }
}
const period = (v: unknown, what: string): OrdersVsDispatches => {
  const o = obj(v, what)
  return { from: str(o.from, what), to: str(o.to, what), orders: figure(o.orders, what), dispatches: figure(o.dispatches, what) }
}

const lineOf = (x: unknown): ChangeLine => {
  const o = obj(x, 'change line')
  const kind = o.kind
  if (kind !== 'added' && kind !== 'removed' && kind !== 'changed') throw new Bad('change kind')
  const answer = o.answer === undefined || o.answer === null ? null : (() => {
    const a = obj(o.answer, 'answer')
    return { decision: decision(a.decision, 'decision'), note: optStr(a.note) }
  })()
  return {
    key: str(o.key, 'line key'),
    title: str(o.title, 'line title'),
    kind,
    changes: arr(o.changes, 'changes').map(c => {
      const co = obj(c, 'change')
      return { label: str(co.label, 'label'), old: scalar(co.old), new: scalar(co.new) }
    }),
    answer,
  }
}

export function parseOperationsRead(raw: unknown): ParsedOperationsRead {
  try {
    const root = obj(raw, 'the operations read')
    const viewer = obj(root.viewer, 'viewer')
    const periods = obj(root.periods, 'periods')
    const gaps = obj(periods.gaps, 'gaps')
    return {
      ok: true,
      read: {
        today: str(root.today, 'today'),
        viewer: { isReviewer: bool(viewer.is_reviewer, 'viewer'), isApprover: bool(viewer.is_approver, 'viewer') },
        pending: arr(root.pending_changes, 'pending changes').map(x => {
          const o = obj(x, 'pending change')
          const changes = obj(o.changes, 'changes')
          return {
            handoffId: str(o.handoff_id, 'handoff_id'),
            orderId: str(o.order_id, 'order_id'),
            displayNumber: str(o.display_number, 'display_number'),
            clientName: typeof o.client_name === 'string' ? o.client_name : '',
            versionNumber: num(o.version_number, 'version_number'),
            approvedAt: str(o.approved_at, 'approved_at'),
            approvedByName: optStr(o.approved_by_name),
            revisionReason: optStr(o.revision_reason),
            available: bool(changes.available, 'available'),
            lines: arr(changes.lines, 'lines').map(lineOf),
          }
        }),
        responses: arr(root.responses, 'responses').map(x => {
          const o = obj(x, 'response')
          return {
            handoffId: str(o.handoff_id, 'handoff_id'),
            orderId: str(o.order_id, 'order_id'),
            displayNumber: str(o.display_number, 'display_number'),
            clientName: typeof o.client_name === 'string' ? o.client_name : '',
            versionNumber: num(o.version_number, 'version_number'),
            stillCurrent: bool(o.still_current, 'still_current'),
            answeredAt: str(o.answered_at, 'answered_at'),
            answeredByName: optStr(o.answered_by_name),
            canDo: num(o.can_do, 'can_do'),
            cannotDo: num(o.cannot_do, 'cannot_do'),
            discuss: num(o.discuss, 'discuss'),
            lines: arr(o.lines, 'response lines').map(l => {
              const lo = obj(l, 'response line')
              return { key: str(lo.key, 'key'), title: str(lo.title, 'title'), decision: decision(lo.decision, 'decision'), note: optStr(lo.note) }
            }),
          }
        }),
        lastMonth: period(periods.last_month, 'last month'),
        lastSixMonths: period(periods.last_six_months, 'last six months'),
        gaps: {
          dispatchedWithoutDate: num(gaps.dispatched_without_date, 'gap'),
          ordersWithoutValue: num(gaps.orders_without_value, 'gap'),
          noConfirmDate: num(gaps.no_confirm_date, 'gap'),
        },
      },
    }
  } catch (e) {
    return { ok: false, message: e instanceof Bad ? `The operations answer was not in the expected shape (${e.message}).` : 'The operations answer could not be read.' }
  }
}

// ── Words ─────────────────────────────────────────────────────────────────────

export const OPS_ERROR_HEADING = 'The Operations dashboard could not be loaded'
export const OPS_ERROR_BODY =
  'The changes waiting for your answer, and the order and dispatch figures, could not be read, so an empty screen here does not mean nothing needs you. Try again; if it keeps failing, tell an administrator.'

export const DECISION_LABEL: Record<ChangeDecision, string> = {
  can_do: 'Can do',
  cannot_do: 'Cannot do',
  discuss: 'Needs discussion',
}
/** The symbols the owner asked for, kept beside the words so colour is never the only signal. */
export const DECISION_SYMBOL: Record<ChangeDecision, string> = {
  can_do: '✔',
  cannot_do: '✖',
  discuss: '?',
}

export const CHANGES_STAY_ALIGNED_NOTE =
  'These orders are already in production and stay aligned while you answer. Your answers are advice to the approver, who decides with the customer.'
export const CHANGES_UNAVAILABLE_NOTE =
  'The previous version of this PI was not kept, so the changed lines cannot be listed. Open the order to compare the versions.'
export const NOTE_PLACEHOLDER = 'Why? (required)'
export const BULK_NOTE_PLACEHOLDER = 'One reason for every line without a note'

export const ANSWER_FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'ORDER_CHANGES_INCOMPLETE', message: 'Every changed line needs an answer before you send.' },
  { marker: 'ORDER_CHANGES_NOTE_REQUIRED', message: 'Say why on every line you cannot do or want to discuss.' },
  { marker: 'ORDER_CHANGES_NOTE_TOO_LONG', message: 'A note may be at most 1000 characters.' },
  { marker: 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED', message: 'A newer version of this PI has been approved. Reload and answer that one.' },
  { marker: 'ORDER_OPERATIONS_HANDOFF_STALE', message: 'This version is no longer the approved one. Reload the dashboard.' },
  { marker: 'ORDER_CHANGES_CLOSED', message: 'This order is dispatched or cancelled and takes no more changes.' },
  { marker: 'ORDER_CHANGES_ALREADY_FLAGGED', message: 'This version was already flagged for clarification on the order page.' },
  { marker: 'Only the operations reviewer', message: 'Only the operations reviewer these changes were sent to can answer them.' },
  { marker: 'Authentication required', message: 'Your session has expired. Sign in again and try once more.' },
]
export const ANSWER_FALLBACK = 'Your answers could not be sent just now. Try again in a moment.'

export function describeAnswerFailure(error: unknown): string {
  const raw = typeof error === 'string' ? error : String((error as { message?: unknown } | null)?.message ?? '')
  return ANSWER_FAILURES.find(f => raw.includes(f.marker))?.message ?? ANSWER_FALLBACK
}

// ── Answer drafting (pure, so it can be tested) ──────────────────────────────

export type DraftAnswers = Record<string, { decision: ChangeDecision | null; note: string }>

export function emptyDraft(lines: readonly ChangeLine[]): DraftAnswers {
  return Object.fromEntries(lines.map(l => [l.key, { decision: l.answer?.decision ?? null, note: l.answer?.note ?? '' }]))
}

/** "Accept all" / "Reject all": every line gets the decision; notes already typed stay. */
export function applyToAll(draft: DraftAnswers, d: ChangeDecision): DraftAnswers {
  return Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, { ...v, decision: d }]))
}

export type AnswerPayload = { line_key: string; decision: ChangeDecision; note: string | null }[]

/**
 * What would be sent, or why it cannot be yet. `bulkNote` fills a line that needs a
 * note and has none; a can_do line sends no note unless one was typed.
 */
export function buildAnswers(
  lines: readonly ChangeLine[],
  draft: DraftAnswers,
  bulkNote: string,
): { ok: true; answers: AnswerPayload } | { ok: false; message: string } {
  const answers: AnswerPayload = []
  for (const l of lines) {
    const d = draft[l.key]
    if (!d || d.decision === null) return { ok: false, message: `Choose an answer for “${l.title}”.` }
    const typed = d.note.trim()
    const note = typed !== '' ? typed : d.decision === 'can_do' ? null : bulkNote.trim() || null
    if (d.decision !== 'can_do' && note === null) return { ok: false, message: `Say why for “${l.title}”.` }
    answers.push({ line_key: l.key, decision: d.decision, note })
  }
  return { ok: true, answers }
}

export function tally(draft: DraftAnswers): { canDo: number; cannotDo: number; discuss: number; open: number } {
  const t = { canDo: 0, cannotDo: 0, discuss: 0, open: 0 }
  for (const v of Object.values(draft)) {
    if (v.decision === 'can_do') t.canDo += 1
    else if (v.decision === 'cannot_do') t.cannotDo += 1
    else if (v.decision === 'discuss') t.discuss += 1
    else t.open += 1
  }
  return t
}

/** `quantity 10 → 12`, `added: 12`, `removed (was 10)`. Never renders a missing value as "null". */
export function changeText(c: ChangeDetail): { from: string; to: string } {
  return { from: c.old ?? '—', to: c.new ?? '—' }
}

export function responseSummary(r: Pick<ChangeResponse, 'canDo' | 'cannotDo' | 'discuss'>): string {
  const parts: string[] = []
  if (r.canDo > 0) parts.push(`${r.canDo} can do`)
  if (r.cannotDo > 0) parts.push(`${r.cannotDo} cannot do`)
  if (r.discuss > 0) parts.push(`${r.discuss} to discuss`)
  return parts.join(' · ')
}

/** Overall tone of an answered change: anything but a clean yes needs the approver. */
export function responseTone(r: Pick<ChangeResponse, 'cannotDo' | 'discuss'>): 'good' | 'attention' | 'danger' {
  if (r.cannotDo > 0) return 'danger'
  if (r.discuss > 0) return 'attention'
  return 'good'
}

export const ORDERS_VS_DISPATCHES_TITLE = 'Orders and dispatches'
export const ORDERS_BASIS_NOTE =
  'Orders are counted by the date they were confirmed, dispatches by the date they moved to Dispatched. Values are product value, excluding GST and other charges.'

export function dispatchGapNotes(g: OperationsRead['gaps']): string[] {
  const notes: string[] = []
  if (g.dispatchedWithoutDate > 0) {
    notes.push(`${g.dispatchedWithoutDate} dispatched ${g.dispatchedWithoutDate === 1 ? 'order has' : 'orders have'} no recorded dispatch date and ${g.dispatchedWithoutDate === 1 ? 'is' : 'are'} not in the dispatch figures.`)
  }
  if (g.ordersWithoutValue > 0) {
    notes.push(`${g.ordersWithoutValue} ${g.ordersWithoutValue === 1 ? 'order' : 'orders'} in these months ${g.ordersWithoutValue === 1 ? 'has' : 'have'} no product value on record and ${g.ordersWithoutValue === 1 ? 'is' : 'are'} counted without a value.`)
  }
  return notes
}
