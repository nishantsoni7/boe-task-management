// THE CONFIRMED ORDER'S HANDOFF FROM THE PI IT CAME FROM.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// approve_order_submission() copies five facts onto `orders` — the client name,
// the two dates, the grand total, the gross product amount — plus the declared
// billing percentage (20260921000000 §13, 20260922000000, 20260923000000). That
// is deliberately all of it: the PI stays the authority for its own commercial
// detail, and duplicating GST or the pre-GST total into `orders` would create a
// second copy that could disagree with the document it was agreed on.
//
// So an operations reader on /orders/[id] is missing everything they need to
// actually RUN the order: who to bill, where to ship, whom to call, what the
// pre-GST value was, what the billing percentage comes to, which products, what
// they look like, and the workbook it was all agreed on. Every one of those
// facts exists on the linked order_submissions row. This module turns that row
// into the shapes the APPROVED PI SCREEN'S OWN builders already take, so the
// Order says the same words about the same figures.
//
// THE RULE THAT SHAPES ALL OF IT: NOT ONE SECOND ARITHMETIC PATH.
// Every figure here comes through buildCommercialRows / persistedCommercial /
// billingValue — the same helpers the PI detail page uses, already tested. This
// module computes NOTHING. It selects, it arranges, and — the one thing it
// genuinely decides — it DROPS what the Order screen already states, so the
// handoff adds facts rather than repeating them.
//
// AND NOT ONE AUTHORITY DECISION.
// Whether a person may see the linked PI at all is decided by
// can_view_order_submission_via_order (migration 20260924000000), which asks the
// Order's own RLS. A viewer who may not reach the submission simply gets no row,
// and this module reports `unavailable` — never ₹0, never an invented value.

import {
  persistedCommercial,
  persistedHeader,
  type PersistedCommercialSource,
  type PersistedHeaderSource,
} from './draftsView'
import { billingValue, readBillingPercentage } from './billingPercentage'
import {
  buildClientDetails,
  buildDateSummary,
  buildBillingSummary,
  commercialBreakdownRows,
  omitDash,
  summaryCommercialFigures,
  type BillingSummary,
  type ClientDetails,
  type DateSummary,
  type SummaryFigure,
} from '@/app/orders/drafts/[submissionId]/piDetailView'
import {
  buildCommercialRows,
  buildHeaderRows,
  formatPiDate,
  type PiAmountRow,
} from '@/lib/pi/previewView'

// ── What the Order screen selects ─────────────────────────────────────────────

/**
 * The approved PI's columns, as /orders/[id] reads them.
 *
 * NARROWER THAN PI_DRAFT_DETAIL_COLUMNS ON PURPOSE, and the omissions are the
 * point. The Order screen does not select — and so cannot leak, cache or later
 * start rendering — the PI's REVIEW material: review_note, rejected_by,
 * parse_warnings, parse_blocking_issues, the advance-exception decision, the
 * finance verification, or deletion_claim_token. Those belong to the review
 * audience on the PI screen. An Order viewer is entitled to the AGREED
 * DOCUMENT, not to the argument that produced it.
 *
 * Every column below is read by exactly one of: persistedHeader,
 * persistedCommercial, buildClientDetails, buildDateSummary, the billing
 * summary, or the workbook line. Nothing is selected "in case".
 */
export const ORDER_PI_HANDOFF_COLUMNS = [
  'id',
  // The document's own identity, and the two parties it names.
  'client_name', 'bill_to_name', 'ship_to_name',
  'creation_date', 'source_created_by',
  // Contact and location — the reason an operations reader opens this at all.
  'contact_number', 'bill_to_phone', 'ship_to_phone',
  'billing_address', 'shipping_address',
  // Schedule. `due_date` is the stored column (20260922000000); the commitment
  // beside it is prose and is only ever shown when there is no date.
  'order_confirmation_date', 'dispatch_commitment', 'due_date',
  // The commercial footer, whole, so buildCommercialRows renders the same
  // breakdown the PI screen renders.
  'gross_product_amount', 'discount_amount', 'subtotal_after_discount',
  'fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text',
  'packing_cost', 'packing_cost_meaning', 'packing_cost_text',
  'transportation_amount', 'transportation_text',
  'total_before_gst', 'gst_amount', 'grand_total',
  // The declaration, and the workbook the whole thing was agreed on.
  'billing_percentage',
  'source_workbook_name', 'source_workbook_path',
].join(', ')

/**
 * The row shape ORDER_PI_HANDOFF_COLUMNS returns.
 *
 * Composed from the two `Pick`s the shared mappers accept, so a column dropped
 * from the select above becomes a TYPE error here rather than an `undefined`
 * that quietly formats as an em dash.
 */
export type OrderPiRow = PersistedHeaderSource & PersistedCommercialSource & {
  id: string
  contact_number: string | null
  bill_to_phone: string | null
  ship_to_phone: string | null
  billing_address: string | null
  shipping_address: string | null
  due_date: string | null
  billing_percentage?: number | string | null
  source_workbook_name: string | null
  /**
   * The private storage key of the uploaded workbook — never rendered, and
   * never sent anywhere but Supabase's own signer. See orderPiWorkbookPath.
   */
  source_workbook_path?: string | null
}

// ── What the Order already says about itself ──────────────────────────────────

/**
 * The Order's own commercial columns, as far as the handoff needs to know them.
 *
 * ONLY TO AVOID SAYING A THING TWICE. Nothing here is used as a figure; each is
 * consulted for whether the Order screen is ALREADY stating that fact above,
 * in which case the handoff does not restate it. See handoffFigures.
 */
export type OrderCommercialFacts = {
  /** orders.total_product_value — the copied gross product amount. */
  totalProductValue: number | null
  /** orders.total_value — the copied grand total. */
  totalValue: number | null
}

// ── The handoff ───────────────────────────────────────────────────────────────

/**
 * Three states, and the middle one matters most.
 *
 *   none         this Order was not created from a PI. The Order screen keeps
 *                exactly the experience it has always had — no empty card, no
 *                "not available" panel for a thing that was never there.
 *   unavailable  there IS a linked PI and it could not be read. Almost always
 *                a permission answer, which is the correct one to give without
 *                elaborating. A RESTRAINED state: it says the detail is not
 *                available to this reader and shows no figures at all. It must
 *                never degrade into ₹0, and it must never become a page error —
 *                the Order itself is perfectly readable.
 *   ready        the linked PI was read.
 */
export type OrderPiHandoff =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | {
      kind: 'ready'
      submissionId: string
      client: ClientDetails
      /** Confirm date and due date, as the PI states them. */
      dates: readonly DateSummary[]
      /**
       * The commercial figures the ORDER DOES NOT ALREADY STATE.
       *
       * Never both of them on an ordinary Order — see handoffFigures.
       */
      figures: readonly SummaryFigure[]
      billing: BillingSummary
      /** The full breakdown, minus the advance row. Same rows the PI shows. */
      commercialRows: readonly PiAmountRow[]
      /** The uploaded workbook's filename, for the download control's label. */
      workbookName: string | null
    }

/**
 * Which of the two summary figures the handoff prints.
 *
 * THE ONE JUDGEMENT IN THIS MODULE, and the whole reason it is a function with
 * tests rather than a condition in JSX.
 *
 * The Order's summary strip already states `Total Product Value`
 * (orders.total_product_value) and `Total Order Value` (orders.total_value).
 * Printing "Product value" again in the handoff card would be the same rupees,
 * under a second caption, four inches lower — which is how a reader starts
 * wondering whether the two are different numbers.
 *
 * `Total before GST` is NEVER dropped: `orders` has no such column and never
 * will (that is the standing decision — the PI stays the authority for it), so
 * the handoff is the only place it can appear.
 *
 * A NULL ON THE ORDER IS NOT "ALREADY SHOWN". An Order whose
 * total_product_value is null prints an em dash up in the strip, which states
 * nothing; the handoff then carries the figure, because the PI has it.
 */
export function handoffFigures(
  rows: readonly PiAmountRow[],
  order: OrderCommercialFacts,
): SummaryFigure[] {
  const orderStatesProductValue =
    order.totalProductValue !== null && Number.isFinite(order.totalProductValue)

  return summaryCommercialFigures(rows)
    .filter(figure => !(figure.key === 'gross' && orderStatesProductValue))
}

/**
 * The whole handoff, from one submission row.
 *
 * Every builder called below is the approved PI screen's own, unmodified. The
 * ORDER of the calls, and `handoffFigures`, are the only decisions here.
 */
export function buildOrderPiHandoff(row: OrderPiRow, order: OrderCommercialFacts): OrderPiHandoff {
  // The shared header builder decides the CONFIRM DATE's format, so the Order
  // and the PI cannot print the same date differently.
  const headerRows = buildHeaderRows(persistedHeader(row))
  const confirmed = headerRows.find(r => r.key === 'confirmed')?.value ?? '—'

  // THE SAME ROWS THE PI SCREEN SHOWS, minus the advance line. The advance is
  // a pre-approval condition — "40% is required before this becomes an Order" —
  // and this Order already exists, so printing it here would state a
  // requirement that no longer applies.
  const commercialRows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(row)))

  return {
    kind: 'ready',
    submissionId: row.id,
    client: buildClientDetails({
      clientName: row.client_name,
      billToName: row.bill_to_name,
      shipToName: row.ship_to_name,
      contactNumber: row.contact_number,
      billToPhone: row.bill_to_phone,
      shipToPhone: row.ship_to_phone,
      billingAddress: row.billing_address,
      shippingAddress: row.shipping_address,
    }),
    dates: buildDateSummary({
      confirmed: omitDash(confirmed),
      // formatPiDate re-spells the ISO string WITHOUT constructing a Date — the
      // timezone-safe path the PI screen uses, so a 25 March due date reads as
      // 25 March in Jaipur and in a CI runner alike.
      due: row.due_date
        ? formatPiDate({ iso: row.due_date, text: row.due_date, source: 'serial' })
        : null,
      commitment: row.dispatch_commitment,
    }),
    figures: handoffFigures(commercialRows, order),
    billing: buildBillingSummary({
      raw: row.billing_percentage ?? null,
      // FROM THE COLUMN, NOT THE ROW. commercialRows carries FORMATTED strings,
      // and arithmetic on those is how a figure quietly loses its paise.
      totalBeforeGst: numeric(row.total_before_gst),
    }),
    commercialRows,
    workbookName: cleanText(row.source_workbook_name),
  }
}

/**
 * The billing value, for anything that needs the NUMBER rather than the card's
 * formatted string — the confirmed PDF, and the tests that pin the derivation.
 *
 * ONE DERIVATION, and it is billingValue's: total_before_gst × percentage ÷ 100,
 * null whenever either input is missing. Never the grand total (which includes
 * tax this percentage says nothing about) and never the product value (which is
 * before the costs the subtotal already absorbed).
 */
export function orderBillingValue(row: Pick<OrderPiRow, 'total_before_gst' | 'billing_percentage'>): number | null {
  return billingValue({
    totalBeforeGst: numeric(row.total_before_gst),
    percentage: readBillingPercentage(row.billing_percentage ?? null),
  })
}

/**
 * The uploaded workbook's storage key, if the record carries a usable one.
 *
 * REFUSED UNLESS IT IS THIS SUBMISSION'S OWN ORIGINAL. The shape is the one
 * 20260911000000 enforces in SQL, restated here so a malformed or foreign key
 * never reaches the signer — a caller that got as far as asking for a signed URL
 * for `submissions/<someone else>/original/x.xlsx` would be refused by the
 * storage policy anyway, and this refuses it a step earlier.
 *
 * Never rendered. The screen shows source_workbook_name; this is what it signs.
 */
export function orderPiWorkbookPath(row: Pick<OrderPiRow, 'id' | 'source_workbook_path'>): string | null {
  const path = cleanText(row.source_workbook_path)
  if (path === null) return null
  const prefix = `submissions/${row.id}/original/`
  if (!path.startsWith(prefix)) return null
  const leaf = path.slice(prefix.length)
  // Exactly one more segment, and nothing that could climb out of it.
  if (leaf === '' || leaf.includes('/') || leaf.includes('\\') || leaf.includes('..')) return null
  return path
}

/** How long a workbook download link lives. Long enough to press, short enough
 *  that a URL copied out of the page stops working the same hour — the same TTL
 *  the PI screen's product pictures use. */
export const ORDER_PI_WORKBOOK_URL_TTL_SECONDS = 3600

/** What the download control is called, said once so the button and its tests
 *  cannot word it differently. */
export const ORDER_PI_WORKBOOK_LABEL = 'Original PI workbook'

/** What the restrained unavailable state says. Never an error, never a figure. */
export const ORDER_PI_UNAVAILABLE_TITLE = 'Approved PI'
export const ORDER_PI_UNAVAILABLE_BODY =
  'The approved PI behind this Order is not available to you.'

/**
 * THE ORDER THAT NEVER CAME FROM A PI.
 *
 * This panel exists because its absence was a defect. The first cut of this
 * feature rendered NOTHING for an Order with no linked PI — deliberately, on
 * the reasoning that there is no point explaining the absence of a thing that
 * was never there.
 *
 * That reasoning was wrong, and a real reader proved it: from the outside,
 * "this Order has no PI" and "the feature was never deployed" look identical,
 * and the person who cannot tell them apart is exactly the person who needs
 * to. Silence is not a neutral answer here. It is an ambiguous one.
 *
 * So the panel says which of the two it is, and says how the other one comes
 * about, without inviting anybody to expect a document that cannot exist.
 */
export const ORDER_PI_NO_SOURCE_TITLE = 'Approved PI'
export const ORDER_PI_NO_SOURCE_BODY =
  'This Order was not created from a PI submission, so there is no approved PI to show and no confirmed documents to generate. Orders carry a PI only when they were created by approving one.'

// ── Small shared readers ──────────────────────────────────────────────────────

const cleanText = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A `numeric` column as a number, or null.
 *
 * PostgREST returns numeric as a STRING precisely so it is not rounded by
 * JSON's double, and this is the one place in this module that converts one.
 * MISSING STAYS NULL — a PI whose workbook never stated a pre-GST total must
 * report that, not ₹0.
 */
function numeric(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}
