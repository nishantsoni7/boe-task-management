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
    | 'operations_review'
    | 'operations_unassigned'
    | 'alignment_predates_version'
    | 'advance_below'
    | 'advance_realign'
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
  /**
   * The PI-to-operations handoff for the version in force (20261229000000):
   * which version, whether it is still undecided or flagged, and whether
   * nobody is assigned to decide it. Null when the version is accepted, or
   * when nothing was recorded. Optional: older callers raise nothing.
   */
  operationsReview?: {
    versionNumber: number
    status: 'awaiting' | 'clarification_needed'
    unassigned: boolean
  } | null
  /** Production was aligned before this PI version was approved. */
  alignmentPredatesVersion?: number | null
  /**
   * The verified advance is below 40% of the Order's (amended) value and no
   * below-40% approval covers it (20270116000000): production cannot be
   * aligned. Already in words (advanceAttentionLabel); null when fine.
   */
  advanceBelowLabel?: string | null
  /**
   * A held Order whose verified advance is back at 40% (or covered by an
   * approval) and is waiting to be aligned again (review W3). In words; null
   * otherwise.
   */
  advanceRealignLabel?: string | null
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
  // A SHORT ADVANCE BLOCKS PRODUCTION, and the database refuses the alignment
  // until it is met or excepted — so it is red, and said with its figures.
  if (open && input.advanceBelowLabel) {
    items.push({ key: 'advance_below', label: input.advanceBelowLabel, tone: 'red' })
  }
  // READY AGAIN, STILL HELD: nothing blocks it any more, but nobody has put it
  // back into production yet. Amber, and said, so the button beside the strip
  // is not the only clue.
  if (open && !input.advanceBelowLabel && input.advanceRealignLabel) {
    items.push({ key: 'advance_realign', label: input.advanceRealignLabel, tone: 'amber' })
  }
  // ONE LINE ABOUT PRODUCTION. On an Order with an operations handoff the
  // alignment IS the handoff decision (20261229000000), so the handoff item
  // below says it in the words that name the version; "Production not
  // aligned" is kept for the legacy Order that has no handoff.
  if (open && !input.productionAligned && !input.operationsReview) {
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
  // THE OPERATIONS HANDOFF. An aligned Order whose current PI version has not
  // been accepted is the case the strip exists for: "Production not aligned"
  // is quiet, and a reader would otherwise take the alignment as covering a
  // version nobody has reviewed.
  if (open && input.alignmentPredatesVersion) {
    items.push({
      key: 'alignment_predates_version',
      label: `Production was aligned before PI V${input.alignmentPredatesVersion}`,
      tone: 'amber',
    })
  }
  // A PENDING REVIEW OUTLIVES DISPATCH. decide_order_operations_handoff()
  // refuses only a CANCELLED Order, and the review queue, the dashboard count
  // and reviewer reassignment all treat a dispatched Order's undecided version
  // as live work — so the strip names it until the Order is cancelled, not
  // until it is closed. The alignment warning above stays an open-Order gap.
  if (input.status !== 'cancelled' && input.operationsReview) {
    const r = input.operationsReview
    if (r.unassigned) {
      items.push({ key: 'operations_unassigned', label: 'No operations reviewer assigned', tone: 'amber' })
    }
    items.push({
      key: 'operations_review',
      label: r.status === 'clarification_needed'
        ? `PI V${r.versionNumber} flagged by operations: clarification needed`
        : `PI V${r.versionNumber} awaiting operations review`,
      tone: r.status === 'clarification_needed' ? 'red' : 'amber',
    })
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


// ── The top summary, as three groups ──────────────────────────────────────────
//
// THREE QUESTIONS, IN THE ORDER A READER ASKS THEM. Who the client is and what
// the order is worth; who owns the sale and whether production has been
// aligned; and the dates. The band used to answer the first and third together
// in one flat row of six, with the second stranded in its own block below the
// payment section — so a reader told "Production not aligned" had to scroll
// past the money to find the field that said so.
//
// IT COMPOSES, IT DOES NOT RESOLVE. Every value here is already decided:
// orderSummaryFields built the six, orderRecordFacts built the three, and both
// keep their own wording, their own `Not available` / `Not set` conventions and
// their own gap tones. This only says which group each one belongs to. The one
// field that is new to the panel is the client's contact number, and that
// arrives resolved by the same builder the PI card uses.
//
// AN UNALIGNED ORDER SHOWS NO ALIGNMENT METADATA. `line` is
// describeProductionAlignment's, which is null unless the Order is aligned AND
// carries a timestamp — so there is never an empty "aligned by" or "aligned on"
// row to read past.

export type OrderSummaryGroupKey = 'client' | 'sales' | 'dates'

export const SUMMARY_GROUP_TITLE: Record<OrderSummaryGroupKey, string> = {
  client: 'Client and value',
  sales:  'Sales and production',
  dates:  'Important dates',
}

/** The client's own number. The PI card's word for it, so one thing keeps one
 *  name across the two screens that print it. */
export const ORDER_CONTACT_LABEL = 'Contact'

/**
 * THE CLIENT'S OWN ROW LABEL.
 *
 * The name used to be the group's oversized primary text, captioned by nothing.
 * It is a label/value row like the three beside it now, and a row needs a label.
 * `Client`, not the field builder's `Client name`: every row in this group is
 * about the client, and the extra word only lengthens the column.
 */
export const ORDER_CLIENT_LABEL = 'Client'

/** The production alignment's own row label, above the badge that states it. */
export const ORDER_PRODUCTION_LABEL = 'Production'

/** A label/value pair as the groups draw them — the shape both builders above
 *  already produce, narrowed to what a row needs. */
export type OrderFactRow = {
  key: string
  label: string
  value: string
  /** True when the record genuinely has none. Drawn quietly, never as an alarm. */
  missing: boolean
  detail: string | null
  tone: WorkspaceTone
  /**
   * A row whose value carries slightly more weight than the rows around it.
   *
   * THE ONE ROW THAT USES IT is the total product value, which lost its tinted
   * panel so the group could be a plain column of label/value rows. It is a
   * half-step in weight, not a second heading: the panel already has three
   * headings and a fourth voice inside a group would undo the hierarchy the
   * headings establish.
   */
  emphasis?: boolean
}

export type OrderSummaryView = {
  client: {
    /** Client, contact, location, total product value — always all four. */
    rows: OrderFactRow[]
  }
  sales: {
    production: {
      label: string
      tone: WorkspaceTone
      aligned: boolean
      /** "Aligned by X · date". NULL WHENEVER THE ORDER IS NOT ALIGNED. */
      line: string | null
    }
    /** The lead source, then the salesperson. Production leads them as a badge. */
    rows: OrderFactRow[]
  }
  /** Confirm date, upload date, due date — always all three, in that order. */
  dates: OrderFactRow[]
}

const asRow = (f: OrderSummaryField): OrderFactRow => ({
  key: f.key, label: f.label, value: f.value, missing: f.missing, detail: f.detail, tone: f.tone,
})

/** A record fact as a row. These carry their own absent wording (`Not set`,
 *  `Not assigned`) and are never `missing` in the panel's sense. */
const factRow = (f: OrderRecordFact): OrderFactRow => ({
  key: f.key, label: f.label, value: f.value, missing: false, detail: f.detail, tone: f.tone,
})

/**
 * The three groups, from the two builders' own output.
 *
 * A field this cannot find is not invented: the summary builder always emits
 * all six and the facts builder always emits all three, so every lookup below
 * is total. The fallbacks exist so a caller that hands over a short list gets a
 * quiet gap rather than a crash.
 */
export function orderSummaryView(input: {
  /** orderSummaryFields' six, unchanged. */
  fields: readonly OrderSummaryField[]
  /** orderRecordFacts' three, unchanged. */
  facts: readonly OrderRecordFact[]
  /** The client's own number as the PI card prints it, or null. */
  clientContact: string | null
  productionAligned: boolean
  /**
   * An accepted version whose Order is on a production hold (20270116000000,
   * review W2): its line says why it is not aligned, so it is drawn too.
   */
  productionHeld?: boolean
}): OrderSummaryView {
  const byKey = (key: OrderSummaryFieldKey): OrderSummaryField | null =>
    input.fields.find(f => f.key === key) ?? null
  const factByKey = (key: OrderRecordFactKey): OrderRecordFact | null =>
    input.facts.find(f => f.key === key) ?? null

  const client = byKey('client')
  const location = byKey('location')
  const value = byKey('product_value')
  const production = factByKey('production')

  const contact = (input.clientContact ?? '').trim()

  return {
    client: {
      rows: [
        // THE NAME IS A ROW NOW, not the group's oversized primary text. It
        // keeps its own value, its own `missing` answer and its own wrapping;
        // only its label and its weight changed.
        client
          ? { ...asRow(client), label: ORDER_CLIENT_LABEL }
          : {
              key: 'client', label: ORDER_CLIENT_LABEL, value: SUMMARY_NOT_AVAILABLE,
              missing: true, detail: null, tone: 'neutral' as WorkspaceTone,
            },
        {
          key: 'contact',
          label: ORDER_CONTACT_LABEL,
          value: contact === '' ? SUMMARY_NOT_AVAILABLE : contact,
          missing: contact === '',
          detail: null,
          tone: 'neutral',
        },
        location ? asRow(location) : {
          key: 'location', label: SUMMARY_FIELD_LABEL.location, value: SUMMARY_NOT_AVAILABLE,
          missing: true, detail: null, tone: 'neutral' as WorkspaceTone,
        },
        // THE FIGURE, AS A ROW. It had a tinted panel of its own, which made
        // the group two things — a list and a banner — and cost the panel the
        // vertical room three groups of plain rows do not need. It is the last
        // row of the group, carrying a half-step of extra weight and nothing
        // more. The value itself is untouched: still the approved PI's own
        // string, still formatted by the builder that has always formatted it.
        value
          ? { ...asRow(value), emphasis: true }
          : {
              key: 'product_value', label: SUMMARY_FIELD_LABEL.product_value,
              value: SUMMARY_NOT_AVAILABLE, missing: true, detail: null,
              tone: 'neutral' as WorkspaceTone, emphasis: true,
            },
      ],
    },
    sales: {
      production: {
        label: production?.value ?? SUMMARY_NOT_AVAILABLE,
        tone: production?.tone ?? 'neutral',
        aligned: input.productionAligned,
        // The supporting line is shown for an aligned Order, and for a HELD
        // one (its line is the reason it is not aligned). On any other
        // unaligned Order it stays null, whatever the caller handed over.
        line: input.productionAligned || input.productionHeld ? (production?.detail ?? null) : null,
      },
      rows: [
        factByKey('lead_source'),
        factByKey('salesperson'),
      ].filter((f): f is OrderRecordFact => f !== null).map(factRow),
    },
    dates: (['confirm_date', 'upload_date', 'due_date'] as OrderSummaryFieldKey[])
      .map(byKey)
      .filter((f): f is OrderSummaryField => f !== null)
      .map(asRow),
  }
}
// ── The header actions ────────────────────────────────────────────────────────

export type OrderHeaderActionKey =
  | 'align'
  | 'unalign'
  | 'amend'
  | 'request_change'
  | 'request_cancel'
  | 'review_change_request'
  | 'withdraw_acceptance'
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
  /**
   * The assigned operations reviewer may withdraw the acceptance of the PI
   * version in force. Optional: an Order with no handoff has nothing to withdraw.
   */
  canWithdrawAcceptance?: boolean
}

/**
 * ONE PRIMARY ACTION. Aligning an unaligned Order for production is the move
 * this screen exists to prompt, so it is primary whenever it is offered.
 * Otherwise a pending change request the reader may decide is the next thing.
 * Otherwise nothing is filled: every remaining control is an ordinary edit.
 *
 * Removing an alignment, withdrawing an operations acceptance, requesting a
 * cancellation and the testing-phase cleanup route are rare, and none of them may compete with the everyday
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
  if (input.canWithdrawAcceptance) overflow.push('withdraw_acceptance')
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
