// THE CONFIRMED ORDER WORKSPACE — what the screen says at a glance, as rules.
//
// WHAT THIS MODULE IS FOR. /orders/[id] is read many times a day by people who
// need four answers in a few seconds: what is wrong, how the money stands, who
// owns it, and what to press next. Each of those is a small rule over state the
// page ALREADY holds — the Order row, the finance position the shared builder
// computed, the production alignment, the document register, the PI history.
// The rules live here, with tests, so the header, the attention bar and the
// health card cannot each decide them slightly differently.
//
// NOTHING HERE IS A NEW BUSINESS RULE. Every condition below restates a
// semantic the page already carried somewhere: the overdue rule (due date
// passed on an Order that is neither dispatched nor cancelled), the amber
// "Not Aligned" production state, the amber awaiting-verification count, the
// pending change request that offers Review, the pending PI revision that
// offers a decision, and the document register's own failed/outdated states.
// This module only gathers them into one place and one order.
//
// NOTHING HERE AUTHORIZES. Which controls are DRAWN is decided by the page from
// the capabilities the database resolved; this only decides which of the
// controls it was told about is the primary one and where the rest sit.

export type WorkspaceTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red'

/** The statuses under which an Order is no longer being worked. The overdue
 *  rule has always excluded exactly these two. */
export const ORDER_CLOSED_STATUSES: readonly string[] = ['dispatched', 'cancelled']

export function isOrderClosed(status: string): boolean {
  return ORDER_CLOSED_STATUSES.includes(status)
}

// ── The attention bar ─────────────────────────────────────────────────────────

export type OrderAttentionItem = {
  key:
    | 'overdue'
    | 'production'
    | 'assignee'
    | 'due_date'
    | 'pi_revision'
    | 'change_requests'
    | 'documents_failed'
    | 'documents_outdated'
    | 'awaiting_verification'
  label: string
  /** Red only for a genuinely overdue Order; every other gap is amber. */
  tone: 'amber' | 'red'
}

export type OrderAttentionInput = {
  status: string
  productionAligned: boolean
  hasAssignee: boolean
  hasDueDate: boolean
  /** The page's existing overdue rule, already evaluated. */
  isOverdue: boolean
  /** Payments recorded against this Order that Finance has not yet decided. */
  awaitingVerificationCount: number
  /** Change requests this reader can see that are still pending. */
  pendingChangeRequests: number
  /** A revised PI is uploaded and awaiting a decision. */
  pendingPiRevision: boolean
  /** The document register's own states, from buildOrderDocumentsView. */
  documentsFailed: boolean
  documentsOutdated: boolean
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * What needs somebody's attention on this Order, most urgent first.
 *
 * OPERATIONAL GAPS ARE SHOWN ONLY WHILE THE ORDER IS OPEN. A dispatched Order
 * with no due date is not a problem, and a cancelled one has nothing left to
 * align. Money and pending decisions are shown regardless: a payment awaiting
 * verification is real whatever the Order's status, and a request somebody is
 * waiting on an answer to does not stop mattering because the Order moved.
 *
 * PARTIAL PAYMENT IS NOT LISTED. No existing rule calls a balance a problem,
 * and a 40% verified Order in production is the ordinary case.
 */
export function orderAttentionItems(input: OrderAttentionInput): OrderAttentionItem[] {
  const items: OrderAttentionItem[] = []
  const open = !isOrderClosed(input.status)

  if (open && input.isOverdue) {
    items.push({ key: 'overdue', label: 'Due date has passed', tone: 'red' })
  }
  if (open && !input.productionAligned) {
    items.push({ key: 'production', label: 'Production not aligned', tone: 'amber' })
  }
  if (open && !input.hasAssignee) {
    items.push({ key: 'assignee', label: 'No assignee', tone: 'amber' })
  }
  if (open && !input.hasDueDate) {
    items.push({ key: 'due_date', label: 'Due date not set', tone: 'amber' })
  }
  if (input.pendingPiRevision) {
    items.push({ key: 'pi_revision', label: 'Revised PI awaiting decision', tone: 'amber' })
  }
  if (input.pendingChangeRequests > 0) {
    items.push({
      key: 'change_requests',
      label: `${plural(input.pendingChangeRequests, 'change request')} awaiting review`,
      tone: 'amber',
    })
  }
  if (open && input.documentsFailed) {
    items.push({ key: 'documents_failed', label: 'Document generation failed', tone: 'amber' })
  }
  if (open && input.documentsOutdated && !input.documentsFailed) {
    items.push({ key: 'documents_outdated', label: 'Order documents are not current', tone: 'amber' })
  }
  if (input.awaitingVerificationCount > 0) {
    items.push({
      key: 'awaiting_verification',
      label: `${plural(input.awaitingVerificationCount, 'payment')} awaiting Finance verification`,
      tone: 'amber',
    })
  }
  return items
}

export function attentionHeading(count: number): string {
  return count === 1 ? '1 item needs attention' : `${count} items need attention`
}

// ── The health card ───────────────────────────────────────────────────────────

export type OrderHealthRow = {
  key: 'status' | 'payment' | 'production' | 'due' | 'owner' | 'confirmed'
  label: string
  value: string
  /** A quieter second line, or null. */
  detail: string | null
  tone: WorkspaceTone
}

export type OrderHealthInput = {
  status: string
  statusLabel: string
  statusTone: WorkspaceTone
  /** Already formatted by the shared money/percent helpers, or null. */
  verifiedPercent: string | null
  verified: string
  orderValue: string | null
  fullyPaid: boolean
  paymentCount: number
  /** Null while the payment reads are still in flight. */
  paymentsLoaded: boolean
  productionAligned: boolean
  productionLabel: string
  /** "Aligned by X · date", or null. */
  productionLine: string | null
  /** Already formatted, or null when not set. */
  dueDate: string | null
  isOverdue: boolean
  ownerName: string | null
  /** Already formatted, or null. */
  confirmedDate: string | null
}

export const HEALTH_PAYMENT_LOADING = 'Loading…'
export const HEALTH_NO_PAYMENTS = 'No payments recorded'
export const HEALTH_NOT_SET = 'Not set'
export const HEALTH_UNASSIGNED = 'Unassigned'

/**
 * The six lines a manager reads first, each with a tone that means something:
 * green is verified/complete, amber needs attention, red is genuinely overdue,
 * blue or neutral is an ordinary running state. The words carry the meaning on
 * their own; the tone only makes it faster.
 */
export function orderHealthRows(input: OrderHealthInput): OrderHealthRow[] {
  const closed = isOrderClosed(input.status)

  const payment: OrderHealthRow = !input.paymentsLoaded
    ? { key: 'payment', label: 'Payment', value: HEALTH_PAYMENT_LOADING, detail: null, tone: 'neutral' }
    : input.paymentCount === 0
      ? {
          key: 'payment', label: 'Payment', value: HEALTH_NO_PAYMENTS,
          detail: input.orderValue ? `${input.orderValue} outstanding` : null,
          tone: 'neutral',
        }
      : {
          key: 'payment', label: 'Payment',
          value: input.verifiedPercent ? `${input.verifiedPercent} verified` : `${input.verified} verified`,
          detail: input.orderValue ? `${input.verified} of ${input.orderValue}` : null,
          tone: input.fullyPaid ? 'green' : 'neutral',
        }

  const production: OrderHealthRow = {
    key: 'production', label: 'Production',
    value: input.productionLabel,
    detail: input.productionLine,
    tone: input.productionAligned ? 'green' : closed ? 'neutral' : 'amber',
  }

  const due: OrderHealthRow = input.dueDate
    ? {
        key: 'due', label: 'Due date', value: input.dueDate,
        detail: input.isOverdue ? 'Overdue' : null,
        tone: input.isOverdue ? 'red' : 'neutral',
      }
    : { key: 'due', label: 'Due date', value: HEALTH_NOT_SET, detail: null, tone: closed ? 'neutral' : 'amber' }

  const owner: OrderHealthRow = input.ownerName
    ? { key: 'owner', label: 'Owner', value: input.ownerName, detail: null, tone: 'neutral' }
    : { key: 'owner', label: 'Owner', value: HEALTH_UNASSIGNED, detail: null, tone: closed ? 'neutral' : 'amber' }

  return [
    { key: 'status', label: 'Status', value: input.statusLabel, detail: null, tone: input.statusTone },
    payment,
    production,
    due,
    owner,
    { key: 'confirmed', label: 'Confirmed', value: input.confirmedDate ?? HEALTH_NOT_SET, detail: null, tone: 'neutral' },
  ]
}

// ── The header actions ────────────────────────────────────────────────────────

export type OrderHeaderActionKey =
  | 'align'
  | 'unalign'
  | 'amend'
  | 'request_change'
  | 'request_cancel'
  | 'review_change_request'
  | 'cleanup'

export type OrderActionLayout = {
  /** The one filled button, or null when nothing on this Order is the obvious next move. */
  primary: OrderHeaderActionKey | null
  /** Labelled, quiet buttons beside it. */
  secondary: OrderHeaderActionKey[]
  /** Behind the "more" control: rare, admin-only or destructive paths. */
  overflow: OrderHeaderActionKey[]
}

export type OrderActionInput = {
  /** What the production control offers this reader, if anything. */
  alignAction: 'align' | 'unalign' | null
  canAmend: boolean
  canRequest: boolean
  /** This reader may review, and at least one request is pending. */
  canReviewChangeRequests: boolean
  canCleanUp: boolean
}

/**
 * ONE PRIMARY ACTION. Aligning an unaligned Order for production is the move
 * this screen exists to prompt, so it is primary whenever it is offered.
 * Otherwise a pending change request the reader may decide is the next thing.
 * Otherwise nothing is filled: every remaining control is an ordinary edit.
 *
 * Removing an alignment, requesting a cancellation and the testing-phase
 * cleanup route are rare, and none of them may compete with the everyday
 * controls, so they sit behind the overflow. Nothing is dropped.
 */
export function arrangeOrderActions(input: OrderActionInput): OrderActionLayout {
  const primary: OrderHeaderActionKey | null =
    input.alignAction === 'align' ? 'align'
    : input.canReviewChangeRequests ? 'review_change_request'
    : null

  const secondary: OrderHeaderActionKey[] = []
  if (input.canAmend) secondary.push('amend')
  if (input.canRequest) secondary.push('request_change')
  if (input.canReviewChangeRequests && primary !== 'review_change_request') secondary.push('review_change_request')

  const overflow: OrderHeaderActionKey[] = []
  if (input.alignAction === 'unalign') overflow.push('unalign')
  if (input.canRequest) overflow.push('request_cancel')
  if (input.canCleanUp) overflow.push('cleanup')

  return { primary, secondary, overflow }
}

// ── The quiet metadata line ───────────────────────────────────────────────────

/**
 * 'today' or 'yesterday' when the instant falls on that calendar day in the
 * viewer's own timezone; null otherwise, so the caller prints the date.
 */
export function relativeDayLabel(iso: string | null | undefined, now: Date = new Date()): 'today' | 'yesterday' | null {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayOf(now) - dayOf(then)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return null
}
