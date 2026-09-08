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
    | 'salesperson'
    | 'due_date'
    | 'lead_source'
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
  /** orders.assigned_to — the SALESPERSON. One column, one word. */
  hasSalesperson: boolean
  hasDueDate: boolean
  hasLeadSource: boolean
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
  if (open && !input.hasSalesperson) {
    items.push({ key: 'salesperson', label: 'Salesperson not set', tone: 'amber' })
  }
  if (open && !input.hasDueDate) {
    items.push({ key: 'due_date', label: 'Due date not set', tone: 'amber' })
  }
  // THESE THREE ARE NOW REQUIRED AT CONVERSION (20261201000000), so a new Order
  // cannot arrive missing one. They remain listed because the Orders that
  // predate that rule legitimately do, and their gaps are still real.
  if (open && !input.hasLeadSource) {
    items.push({ key: 'lead_source', label: 'Lead source not set', tone: 'amber' })
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

// ── The Order Summary's operational facts ─────────────────────────────────────
//
// ONE FACT, ONE PLACE. These six are the Order's operational state, and this is
// the only place on the screen that states any of them: the command header
// carries the identity and the actions and nothing else, and there is no second
// summary card underneath.
//
// PAYMENT IS NOT HERE. It has its own section, which holds every payment figure
// on the page — the summary and the records together.

export type OrderSummaryFactKey =
  | 'status' | 'production' | 'salesperson' | 'confirm_date' | 'due_date' | 'lead_source'

export type OrderSummaryFact = {
  key: OrderSummaryFactKey
  label: string
  value: string
  /** A quieter second line, or null. */
  detail: string | null
  tone: WorkspaceTone
}

export type OrderSummaryInput = {
  status: string
  statusLabel: string
  statusTone: WorkspaceTone
  productionAligned: boolean
  productionLabel: string
  /** "Aligned by X · date", or null. */
  productionLine: string | null
  /** orders.assigned_to's name, or null. */
  salespersonName: string | null
  /** Already formatted, or null. */
  confirmDate: string | null
  dueDate: string | null
  isOverdue: boolean
  /** Already labelled by leadSourceLabel, or null. */
  leadSource: string | null
}

export const SUMMARY_NOT_SET = 'Not set'
export const SUMMARY_UNASSIGNED = 'Not assigned'

/**
 * The six facts, in reading order. A gap on an OPEN Order is amber; the same
 * gap on a dispatched or cancelled one is neutral, because nothing is waiting
 * on it any more. Red is kept for a due date that has genuinely passed.
 */
export function orderSummaryFacts(input: OrderSummaryInput): OrderSummaryFact[] {
  const closed = isOrderClosed(input.status)
  const gapTone: WorkspaceTone = closed ? 'neutral' : 'amber'

  return [
    {
      key: 'status', label: 'Status', value: input.statusLabel,
      detail: null, tone: input.statusTone,
    },
    {
      key: 'production', label: 'Production',
      value: input.productionLabel,
      detail: input.productionLine,
      tone: input.productionAligned ? 'green' : gapTone,
    },
    input.salespersonName
      ? { key: 'salesperson', label: 'Salesperson', value: input.salespersonName, detail: null, tone: 'neutral' }
      : { key: 'salesperson', label: 'Salesperson', value: SUMMARY_UNASSIGNED, detail: null, tone: gapTone },
    {
      key: 'confirm_date', label: 'Confirm date',
      value: input.confirmDate ?? SUMMARY_NOT_SET,
      detail: null,
      tone: input.confirmDate ? 'neutral' : gapTone,
    },
    input.dueDate
      ? {
          key: 'due_date', label: 'Due date', value: input.dueDate,
          detail: input.isOverdue ? 'Overdue' : null,
          tone: input.isOverdue ? 'red' : 'neutral',
        }
      : { key: 'due_date', label: 'Due date', value: SUMMARY_NOT_SET, detail: null, tone: gapTone },
    input.leadSource
      ? { key: 'lead_source', label: 'Lead source', value: input.leadSource, detail: null, tone: 'neutral' }
      : { key: 'lead_source', label: 'Lead source', value: SUMMARY_NOT_SET, detail: null, tone: gapTone },
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

// ── The activity trail ────────────────────────────────────────────────────────

/** How many events the trail shows before it asks to be expanded. */
export const ACTIVITY_PREVIEW_COUNT = 5

/**
 * How many of `total` events are on screen. A trail of five or fewer is shown
 * whole and offers no control; a longer one shows the latest five until it is
 * expanded. Nothing is ever dropped — `hidden` is what the control promises.
 */
export function activityWindow(total: number, expanded: boolean): { shown: number; hidden: number } {
  if (expanded || total <= ACTIVITY_PREVIEW_COUNT) return { shown: total, hidden: 0 }
  return { shown: ACTIVITY_PREVIEW_COUNT, hidden: total - ACTIVITY_PREVIEW_COUNT }
}

export function activityToggleLabel(total: number, expanded: boolean): string {
  return expanded
    ? `Show latest ${ACTIVITY_PREVIEW_COUNT}`
    : `View all ${total} events`
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
