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

// ── The Order Summary panel ───────────────────────────────────────────────────
//
// SIX FACTS, ONE PANEL. Who the Order is for, where it goes, the three dates
// that matter and what the products come to. A reader who has just learned
// WHICH Order this is (the command header) needs exactly these before anything
// else on the screen means much.
//
// NOTHING HERE READS THE DATABASE AND NOTHING HERE FORMATS. Every value arrives
// already formatted by the page's own date and money helpers, or as null. A
// null becomes the restrained `Not available` wording and is marked `missing`
// so the panel can mute it — it NEVER becomes a different date, a zero, or an
// em dash that reads as a broken field.
//
// WHO RAISED IT IS NOT HERE. It is a display removal only: orders.requested_by
// and every audit trail that names it are untouched, and the activity trail
// still says who did what.

export type OrderSummaryFieldKey =
  | 'client' | 'location' | 'confirm_date' | 'upload_date' | 'due_date' | 'product_value'

export type OrderSummaryField = {
  key: OrderSummaryFieldKey
  label: string
  /** Already formatted by the caller, or the `Not available` wording. */
  value: string
  /** True when the record genuinely has none. Drawn quietly, never as an alarm. */
  missing: boolean
  /** A name and a place need room; a date and an amount do not. */
  wide: boolean
  /** A quieter second line, or null. */
  detail: string | null
  tone: WorkspaceTone
}

export type OrderSummaryInput = {
  /** orders.client_name — the authoritative saved client name. */
  clientName: string | null
  /**
   * The saved location this page already treats as authoritative: the approved
   * PI's own `client_city`, which is what the client card labels `Location`.
   * NEVER assembled out of a billing or shipping address.
   */
  location: string | null
  /** orders.confirm_date, already formatted. */
  confirmDate: string | null
  /**
   * When the LATEST APPROVED PI was uploaded — order_pi_versions.uploaded_at of
   * the approved version, already formatted.
   *
   * IT IS NOT THE ORDER'S CREATION DATE, not the draft's, and not the
   * confirmation date. Those are three different moments and substituting one
   * for another here would be a lie told in a field somebody plans against.
   */
  uploadDate: string | null
  /** orders.due_date, already formatted. */
  dueDate: string | null
  /** The page's existing overdue rule, already evaluated. */
  isOverdue: boolean
  /**
   * orders.total_product_value, already formatted — the product subtotal
   * BEFORE any commercial adjustment. The Commercial section states the
   * adjustments and the final Order value; this states only the starting one.
   */
  totalProductValue: string | null
}

/** What a field says when the record genuinely has no value for it. */
export const SUMMARY_NOT_AVAILABLE = 'Not available'

export const SUMMARY_FIELD_LABEL: Record<OrderSummaryFieldKey, string> = {
  client:        'Client name',
  location:      'Location',
  confirm_date:  'Confirm date',
  upload_date:   'Upload date',
  due_date:      'Due date',
  product_value: 'Total product value',
}

/** The two fields that hold prose and get the extra width for it. */
const WIDE_FIELDS: readonly OrderSummaryFieldKey[] = ['client', 'location']

function field(
  key: OrderSummaryFieldKey,
  value: string | null,
  extra: { detail?: string | null; tone?: WorkspaceTone } = {},
): OrderSummaryField {
  const present = value !== null && value.trim() !== ''
  return {
    key,
    label: SUMMARY_FIELD_LABEL[key],
    value: present ? value.trim() : SUMMARY_NOT_AVAILABLE,
    missing: !present,
    wide: WIDE_FIELDS.includes(key),
    detail: present ? (extra.detail ?? null) : null,
    tone: present ? (extra.tone ?? 'neutral') : 'neutral',
  }
}

/**
 * The six fields, always all six and always in this order.
 *
 * A MISSING FIELD IS STILL DRAWN. Hiding it would leave a reader unable to tell
 * "this Order has no due date" from "this screen does not show due dates", and
 * the first of those is something somebody can go and fix.
 */
export function orderSummaryFields(input: OrderSummaryInput): OrderSummaryField[] {
  return [
    field('client', input.clientName),
    field('location', input.location),
    field('confirm_date', input.confirmDate),
    field('upload_date', input.uploadDate),
    // The one field that carries a warning: a due date that has passed on an
    // Order still being worked. The rule itself is the page's, unchanged.
    field('due_date', input.dueDate, {
      detail: input.isOverdue ? 'Overdue' : null,
      tone: input.isOverdue ? 'red' : 'neutral',
    }),
    field('product_value', input.totalProductValue),
  ]
}

// ── Record information ────────────────────────────────────────────────────────
//
// WHO IS CARRYING THIS ORDER, AND WHERE IT STANDS IN PRODUCTION.
//
// These three were in the identity band before the summary panel replaced it.
// They are NOT in the panel: that answers who the Order is for, where it goes,
// when it happens and what the products come to, and a reader asking those six
// questions is not at that moment asking who the salesperson is. But they are
// three real operational facts, the attention strip still raises a gap in each,
// and a reader who is told "Salesperson not set" must be able to see the field
// that is not set. So they keep a quiet block lower down, in Record
// information, which is where the page has always put a fact worth having but
// not worth leading with.
//
// EVERY VALUE, LABEL AND TONE IS THE ONE THE BAND USED. Same columns, same
// wording, same gap rules — this is a move, not a redesign, and nothing here
// resolves anything the page did not already resolve.

export type OrderRecordFactKey = 'salesperson' | 'lead_source' | 'production'

export type OrderRecordFact = {
  key: OrderRecordFactKey
  label: string
  value: string
  /** A quieter second line — the production alignment's own, or null. */
  detail: string | null
  tone: WorkspaceTone
}

export type OrderRecordFactsInput = {
  status: string
  /** orders.assigned_to's name, or null. */
  salespersonName: string | null
  /** Already labelled by leadSourceLabel, or null. */
  leadSource: string | null
  productionAligned: boolean
  productionLabel: string
  /** "Aligned by X · date", or null. */
  productionLine: string | null
}

export const SUMMARY_NOT_SET = 'Not set'
export const SUMMARY_UNASSIGNED = 'Not assigned'

/**
 * The three, always all three and always in this order.
 *
 * A gap on an OPEN Order is amber; the same gap on a dispatched or cancelled
 * one is neutral, because nothing is waiting on it any more. That rule is the
 * band's, unchanged.
 */
export function orderRecordFacts(input: OrderRecordFactsInput): OrderRecordFact[] {
  const gapTone: WorkspaceTone = isOrderClosed(input.status) ? 'neutral' : 'amber'

  return [
    input.salespersonName
      ? { key: 'salesperson', label: 'Salesperson', value: input.salespersonName, detail: null, tone: 'neutral' }
      : { key: 'salesperson', label: 'Salesperson', value: SUMMARY_UNASSIGNED, detail: null, tone: gapTone },
    input.leadSource
      ? { key: 'lead_source', label: 'Lead source', value: input.leadSource, detail: null, tone: 'neutral' }
      : { key: 'lead_source', label: 'Lead source', value: SUMMARY_NOT_SET, detail: null, tone: gapTone },
    {
      key: 'production', label: 'Production',
      value: input.productionLabel,
      detail: input.productionLine,
      tone: input.productionAligned ? 'green' : gapTone,
    },
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
