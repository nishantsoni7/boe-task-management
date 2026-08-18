// Reading a SAVED PI submission back, as data.
//
// WHAT THIS IS FOR
// ----------------
// /orders/import parses a workbook in the tab and shows it. That preview is
// gone the moment the page reloads, and it was never the record: the server
// re-parses the same workbook and persists its OWN reading (20260908000000 §8b).
// Everything a draft page shows must therefore come from those persisted rows,
// and this module is the one place that turns them into the shapes the existing,
// already-tested preview helpers accept.
//
// THE RULE THAT SHAPES ALL OF IT: NO SECOND SET OF PRESENTATION RULES.
// How money is written, what "Included" means as against "Not applicable", which
// header fields are shown, how the 40% advance is derived, how a picture is
// labelled in the viewer — all of that already exists in src/lib/pi/previewView
// and is covered by its own tests. Re-implementing any of it against database
// columns would give the same draft two renderings that could drift apart, and
// the one a reviewer trusts would be whichever they happened to open. So this
// module only REBUILDS THE INPUTS those helpers already take:
//
//   persistedHeader        → PiHeader        → buildHeaderRows
//   persistedCommercial    → PiCommercialSummary → buildCommercialRows
//   persistedImageUrlMaps  → PiImageUrls-ish → buildImageViewerItems
//   persistedDiagnostics   → the parser's own entries → groupPiDiagnostics
//
// NOTHING HERE READS AUTHORITY. Which submissions a person may see is decided by
// RLS (order_submissions_select) and re-decided for every child table by
// can_view_order_submission. This module never filters by owner, never compares
// a user id, and must not start to: a client-side visibility rule would be a
// second, weaker answer to a question the database already answers.

import type {
  PiAmountOrText,
  PiCommercialSummary,
  PiDateValue,
  PiHeader,
  PiImageRole,
} from '@/lib/pi/types'
import { PI_ADVANCE_COLUMNS, type PersistedAdvance } from './advanceRequirement'
import {
  PI_APPROVAL_COLUMNS,
  PI_FINANCE_COLUMNS,
  type PersistedFinanceVerification,
} from './finalApproval'

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * The five states 20260908000000 admits, and no more.
 *
 * 'approved' is in the column's CHECK so the approval phase is additive, and is
 * unreachable today — the transition trigger refuses every move into it for
 * every caller, service role included. It is spelled here so that a row somehow
 * carrying it still renders a truthful label rather than a raw enum value.
 */
export const PI_DRAFT_STATUSES = [
  'draft',
  'submitted',
  'needs_changes',
  'rejected',
  'approved',
] as const

export type PiDraftStatus = (typeof PI_DRAFT_STATUSES)[number]

/**
 * What the Drafts list asks the database for.
 *
 * APPROVED IS DELIBERATELY ABSENT. An approved submission has become an Order
 * and belongs in Confirmed Orders; leaving it here would give one record two
 * homes and invite somebody to work on the copy that no longer decides anything.
 * 'rejected' is included because a rejected PI is still the employee's record of
 * what they filed and must not silently vanish from their own list.
 */
export const PI_DRAFT_LIST_STATUSES: readonly PiDraftStatus[] = [
  'draft',
  'submitted',
  'needs_changes',
  'rejected',
]

/** Friendly labels. Never a raw enum value on screen. */
export const PI_DRAFT_STATUS_LABEL: Record<PiDraftStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted for Review',
  needs_changes: 'Needs Changes',
  rejected: 'Rejected',
  approved: 'Approved',
}

export type PiDraftStatusTone = 'neutral' | 'blue' | 'amber' | 'red' | 'green'

const STATUS_TONE: Record<PiDraftStatus, PiDraftStatusTone> = {
  draft: 'neutral',
  submitted: 'blue',
  needs_changes: 'amber',
  rejected: 'red',
  approved: 'green',
}

export function isPiDraftStatus(value: unknown): value is PiDraftStatus {
  return typeof value === 'string' && (PI_DRAFT_STATUSES as readonly string[]).includes(value)
}

/** An unknown value renders as itself rather than as a lie about the record. */
export function draftStatusLabel(status: string | null | undefined): string {
  return isPiDraftStatus(status) ? PI_DRAFT_STATUS_LABEL[status] : (status ?? '—')
}

export function draftStatusTone(status: string | null | undefined): PiDraftStatusTone {
  return isPiDraftStatus(status) ? STATUS_TONE[status] : 'neutral'
}

// ── The empty state ───────────────────────────────────────────────────────────

export const PI_DRAFTS_EMPTY_TEXT = 'No PI drafts saved yet.'

/**
 * The page's own subtitle.
 *
 * It used to end "Nothing here has been submitted for approval", which stopped
 * being true the day submission shipped: this list now holds submitted records,
 * returned ones and rejected ones, and for a reviewer it holds the queue as
 * well. Kept as a constant so the sentence and the test that pins it read the
 * same string.
 */
export const PI_DRAFTS_SUBTITLE = 'Saved PI submissions, and anything waiting on you.'

/** What the list says when a person can see nothing here yet. */
export const PI_DRAFTS_EMPTY_NOTE =
  'A record appears here as soon as a PI has been uploaded and saved. It stays here through submission, review and any changes management asks for.'

/** The empty state of a reviewer's queue: a real, and good, answer. */
export const PI_REVIEW_EMPTY_TEXT = 'No PI is waiting for review.'

// ── Row shapes, as PostgREST returns them ─────────────────────────────────────

/**
 * numeric columns arrive as JSON numbers, but a string is accepted too.
 *
 * Defensive rather than superstitious: these are money figures a client has
 * already been sent, and `'250000.00' * 1` silently becoming NaN somewhere
 * downstream would print an em dash where a grand total belongs. Anything that
 * is not a finite number becomes null, which every formatter here already
 * renders as "—".
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export type PersistedCostMeaning = 'numeric' | 'not_applicable' | 'included' | 'text'

/** One row of public.order_submissions, as the drafts pages read it. */
export type PersistedSubmission = PersistedAdvance & PersistedFinanceVerification & {
  id: string
  status: string
  client_name: string | null

  // ── Who filed it, and when it last reached a reviewer ──
  //
  // created_by and submitted_by are the pair can_edit_order_submission uses, so
  // the screens can offer an owner their own controls without inventing a
  // second, weaker ownership rule. submitted_at is written by the status
  // transition trigger (20260910000000) and by nothing else, so it is a fact
  // about the record rather than a claim the browser was handed.
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  rejected_by: string | null
  rejected_at: string | null

  creation_date: string | null
  source_created_by: string | null
  bill_to_name: string | null
  ship_to_name: string | null
  order_confirmation_date: string | null
  dispatch_commitment: string | null

  source_workbook_name: string | null

  gross_product_amount: number | string | null
  discount_amount: number | string | null
  subtotal_after_discount: number | string | null
  fabric_cost: number | string | null
  fabric_cost_meaning: string | null
  fabric_cost_text: string | null
  packing_cost: number | string | null
  packing_cost_meaning: string | null
  packing_cost_text: string | null
  transportation_amount: number | string | null
  transportation_text: string | null
  total_before_gst: number | string | null
  gst_amount: number | string | null
  grand_total: number | string | null

  parse_warnings: unknown
  parse_blocking_issues: unknown
  review_note: string | null

  created_at: string
  updated_at: string

  // ── Final approval, and the Order it produced ──
  //
  // approved_by and approved_at existed from 20260908000000 and were unreachable
  // until Phase C. order_id was reserved by the same migration and is written by
  // approve_order_submission() alone. All three are null on every record that has
  // not been approved.
  approved_by: string | null
  approved_at: string | null
  order_id: string | null

  // ── The deletion reservation ──
  //
  // Read so the screen can refuse to offer a decision on a record that is being
  // erased. The token itself is never rendered; only its presence is consulted.
  deletion_claim_token: string | null

  // The advance requirement this PI was submitted under, and the exception
  // decision if it carries one, come from PersistedAdvance above. A COMMERCIAL
  // CONDITION, never a payment: a record submitted before 20260913000000
  // declared nothing and every one of those columns is null.
  //
  // The finance verification, if one is current, comes from
  // PersistedFinanceVerification. Also never a payment — see finalApproval.ts.
}

/** One row of public.order_submission_items. */
export type PersistedItem = {
  id: string
  source_row: number
  item_sequence: string | null
  product_name: string | null
  quantity: number | string | null
  dimensions: string | null
  material: string | null
  customization: string | null
  cost_per_piece: number | string | null
  total_amount: number | string | null
  sort_order: number
}

/** One row of public.order_submission_item_images. */
export type PersistedItemImage = {
  item_id: string
  role: string
  position: number
  storage_path: string
}

// ── What the two pages select ─────────────────────────────────────────────────
//
// Named column lists, never `select('*')`. The submission table carries the
// employee's own client and commercial data and there is no reason for a list
// screen to pull the addresses, the parse diagnostics or the storage paths it
// does not render — and an explicit list is what stops a column added by a later
// migration from silently appearing in a response.
//
// STORAGE PATHS ARE NOT SELECTED BY THE LIST. A path is not a secret and not a
// capability (the order-files policies authorize by submission, so knowing a key
// grants nothing), but it is internal plumbing, and a listing has no use for it.

export const PI_DRAFT_LIST_COLUMNS = [
  'id', 'status', 'client_name', 'bill_to_name',
  'source_workbook_name', 'grand_total', 'created_at', 'updated_at',
  // Who filed it and when it reached review. The list needs both because the
  // review section states them on every row, and because the queue is ordered
  // by the submission time rather than by when the row was last written.
  'submitted_by', 'submitted_at',
  // WHO OWNS IT. Read so the list can decide whether to draw a Delete control:
  // created_by and submitted_by are the pair can_edit_order_submission and
  // order_submission_deletable_by() both read, so the screen asks the same
  // question the database answers. A courtesy, never the authority.
  'created_by',
].join(', ')

export const PI_DRAFT_DETAIL_COLUMNS = [
  'id', 'status', 'client_name',
  'created_by', 'submitted_by', 'submitted_at', 'rejected_by', 'rejected_at',
  'creation_date', 'source_created_by', 'bill_to_name', 'ship_to_name',
  'order_confirmation_date', 'dispatch_commitment',
  'source_workbook_name',
  'gross_product_amount', 'discount_amount', 'subtotal_after_discount',
  'fabric_cost', 'fabric_cost_meaning', 'fabric_cost_text',
  'packing_cost', 'packing_cost_meaning', 'packing_cost_text',
  'transportation_amount', 'transportation_text',
  'total_before_gst', 'gst_amount', 'grand_total',
  'parse_warnings', 'parse_blocking_issues', 'review_note',
  'created_at', 'updated_at',
  // Approval, the Order link and the deletion reservation. Named in
  // finalApproval.ts and submissionDeletion.ts respectively, so the columns and
  // the modules that read them cannot drift apart.
  ...PI_APPROVAL_COLUMNS,
  ...PI_FINANCE_COLUMNS,
  'deletion_claim_token',
  // The advance requirement this PI was submitted under, and the exception
  // decision if it carries one. Named in advanceRequirement.ts so the columns
  // and the module that reads them cannot drift apart.
  ...PI_ADVANCE_COLUMNS,
].join(', ')

export const PI_DRAFT_ITEM_COLUMNS = [
  'id', 'source_row', 'item_sequence', 'product_name', 'quantity',
  'dimensions', 'material', 'customization', 'cost_per_piece',
  'total_amount', 'sort_order',
].join(', ')

export const PI_DRAFT_ITEM_IMAGE_COLUMNS = ['item_id', 'role', 'position', 'storage_path'].join(', ')

/** The private bucket every PI file lives in. Never made public. */
export const ORDER_FILES_BUCKET = 'order-files'

/**
 * How long a product picture's signed URL lives.
 *
 * Long enough to read a twelve-line PI without a picture expiring mid-scroll,
 * short enough that a URL copied out of the page stops working the same hour.
 */
export const PI_DRAFT_IMAGE_URL_TTL_SECONDS = 3600

// ── The list ──────────────────────────────────────────────────────────────────

export type PiDraftListEntry = {
  id: string
  /**
   * The pair that decides ownership, carried through untouched.
   *
   * Not folded into a boolean here, because this module does not know who is
   * looking — the page does, and canDeleteSubmission answers it in one place for
   * the list, the dialog and the route alike.
   */
  createdBy: string | null
  submittedBy: string | null
  /** Where "Open Draft" goes. Built here so the route shape has one source. */
  href: string
  client: string
  /**
   * THE ORIGINAL PI FILE NAME, and deliberately not source_order_number.
   *
   * The workbook's own B20 is kept on the record for traceability and is
   * normally the number of whatever older PI this one was copied from
   * (20260908000000 documents that at length). On a list it can only be read as
   * this order's number, and an imported PI has none until approval allocates
   * one — so the reference shown is the file the employee actually uploaded,
   * which identifies the record without inventing a number for it.
   */
  reference: string
  itemCount: number
  /** "12 products" */
  itemCountLabel: string
  /** Formatted rupees, or "—" when the workbook had no grand total figure. */
  grandTotal: string
  status: string
  statusLabel: string
  statusTone: PiDraftStatusTone
  /** "16 Aug 2026, 04:12 PM" in IST, or "—". */
  savedAt: string
  /**
   * When this record last reached a reviewer, formatted, or "—".
   *
   * Separate from `savedAt`, which is the last WRITE of any kind. A returned
   * submission is written again the moment its PI is replaced, so the two
   * diverge, and a review queue ordered by the wrong one puts a corrected draft
   * above a PI that has been waiting since Monday.
   */
  submittedAt: string
  /** The raw stamp, for ordering only. Never rendered. */
  submittedAtIso: string | null
  /** Who submitted it, resolved from users, or "—" when it has not been
   *  submitted and there is nobody to name. */
  submitter: string
}

/**
 * When this draft was last written, in Indian business time.
 *
 * Pinned to Asia/Kolkata for the same reason src/lib/payroll/months.ts pins its
 * own stamp: every "when" in this application is an Indian business time, and an
 * unpinned string would read as two different times on two desks.
 */
export function formatSavedAt(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at
    .toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Asia/Kolkata',
    })
    // Some ICU builds separate the meridiem with a narrow no-break space, which
    // is invisible in source and breaks a naive comparison.
    .replace(/ /g, ' ')
    .replace(/\b(am|pm)\b/gi, m => m.toUpperCase())
}

export function draftDetailHref(submissionId: string): string {
  return `/orders/drafts/${submissionId}`
}

/**
 * Where Save Draft goes.
 *
 * The `saved` flag is a MESSAGE, not data: it decides whether the detail page
 * congratulates the employee, and nothing else. Every figure, product and
 * picture on that page is loaded from the persisted rows whether the flag is
 * there or not, so a hand-typed one shows a banner over an unchanged record.
 */
export function draftSavedHref(submissionId: string): string {
  return `${draftDetailHref(submissionId)}?saved=1`
}

/**
 * One list row, from the submission and the number of product lines stored
 * against it.
 *
 * The count is passed in rather than derived from an embedded aggregate so that
 * the caller reads the items under the same RLS the rest of the page does: a
 * count the viewer is not allowed to see must not appear beside a record they
 * are.
 */
export function describeDraftListEntry(
  row: PersistedSubmission,
  itemCount: number,
  formatMoney: (amount: number | null) => string,
  /**
   * The submitter's display name, already batch-fetched by the caller. Optional
   * because the employee's own list has no use for it — it is their own record —
   * and because a name the caller could not resolve must render as an honest
   * dash rather than as an id.
   */
  submitterName?: string | null,
): PiDraftListEntry {
  const count = Number.isFinite(itemCount) && itemCount > 0 ? Math.trunc(itemCount) : 0
  const submittedIso = text(row.submitted_at)
  return {
    id: row.id,
    createdBy: row.created_by,
    submittedBy: row.submitted_by,
    href: draftDetailHref(row.id),
    client: text(row.client_name) ?? text(row.bill_to_name) ?? 'Unnamed client',
    reference: text(row.source_workbook_name) ?? '—',
    itemCount: count,
    itemCountLabel: `${count} product${count === 1 ? '' : 's'}`,
    grandTotal: formatMoney(toNumber(row.grand_total)),
    status: row.status,
    statusLabel: draftStatusLabel(row.status),
    statusTone: draftStatusTone(row.status),
    savedAt: formatSavedAt(row.updated_at ?? row.created_at),
    submittedAt: submittedIso ? formatSavedAt(submittedIso) : '—',
    submittedAtIso: submittedIso,
    submitter: text(submitterName ?? null) ?? '—',
  }
}

// ── The detail: header ────────────────────────────────────────────────────────

const dateValue = (iso: string | null): PiDateValue | null =>
  iso ? { iso, text: iso, source: 'serial' } : null

/**
 * The persisted header, in the parser's own shape, so buildHeaderRows decides
 * which fields appear and how they are worded — here as on the import screen.
 *
 * sourceOrderNumber is passed as NULL on purpose. It exists on the record and is
 * not shown; buildHeaderRows would ignore it anyway, and hard-wiring null here
 * means no later edit can reach it through this path either.
 *
 * dispatchCommitment is stored as text ("6 weeks from date of confirmation" as
 * often as a date), so it is rebuilt as a text-sourced value and formatPiDate
 * returns the words unchanged.
 */
export function persistedHeader(row: PersistedSubmission): PiHeader {
  const commitment = text(row.dispatch_commitment)
  return {
    sourceOrderNumber: null,
    creationDate: dateValue(text(row.creation_date)),
    createdBy: text(row.source_created_by),
    boeGst: null,
    contactNumber: null,
    billToName: text(row.bill_to_name) ?? text(row.client_name),
    billToPhone: null,
    billToGst: null,
    billingAddress: null,
    shipToName: text(row.ship_to_name),
    shipToPhone: null,
    shipToGst: null,
    shippingAddress: null,
    orderConfirmationDate: dateValue(text(row.order_confirmation_date)),
    dispatchCommitment: commitment ? { iso: null, text: commitment, source: 'text' } : null,
  }
}

// ── The detail: commercial summary ────────────────────────────────────────────

const plainAmount = (value: unknown, cell: string): PiAmountOrText => ({
  amount: toNumber(value),
  text: null,
  zeroMeaning: null,
  cell,
})

/**
 * Rebuild one "as per actual" cell from the three columns 20260909000000 stores
 * it in.
 *
 * The four meanings are the parser's, and the round trip is exact:
 *
 *   numeric         a real charge (or nothing yet)  → the figure
 *   not_applicable  a dash or a blank               → "Not applicable"
 *   included        "Inclusive"                     → "Included", wording kept
 *   text            anything else                   → the words, verbatim
 *
 * INCLUDED IS NOT NOT_APPLICABLE. Both add zero and they are opposite answers to
 * "was the client charged for packing?" — which is exactly why the meaning is a
 * column and not an inference from the amount.
 */
export function persistedCost(
  amount: unknown,
  meaning: string | null,
  wording: string | null,
  cell: string,
): PiAmountOrText {
  const words = text(wording)
  switch (meaning as PersistedCostMeaning) {
    case 'not_applicable':
      return { amount: 0, text: null, zeroMeaning: 'notApplicable', cell }
    case 'included':
      return { amount: 0, text: words, zeroMeaning: 'included', cell }
    case 'text':
      return { amount: null, text: words, zeroMeaning: null, cell }
    default:
      return { amount: toNumber(amount), text: null, zeroMeaning: null, cell }
  }
}

/**
 * The saved commercial footer, in the shape buildCommercialRows already takes.
 *
 * NOTHING IS RECOMPUTED. Every figure is the one the server persisted from its
 * own parse; the only derived value in the rendered summary is the 40% advance,
 * and that is computed by the shared helper from the grand total, exactly as it
 * is on the import preview.
 */
export function persistedCommercial(row: PersistedSubmission): PiCommercialSummary {
  const gross = toNumber(row.gross_product_amount) ?? 0
  const discount = toNumber(row.discount_amount) ?? 0

  return {
    discount,
    discountLabel: null,
    subtotalAfterDiscount: plainAmount(row.subtotal_after_discount, 'I116'),
    fabricCost: persistedCost(row.fabric_cost, row.fabric_cost_meaning, row.fabric_cost_text, 'I117'),
    packingCost: persistedCost(row.packing_cost, row.packing_cost_meaning, row.packing_cost_text, 'I118'),
    transportation: {
      // The one cell that has always been an amount/text pair, and stays one.
      amount: toNumber(row.transportation_amount),
      text: text(row.transportation_text),
      zeroMeaning: null,
      cell: 'I119',
    },
    totalBeforeGst: plainAmount(row.total_before_gst, 'I120'),
    gst: plainAmount(row.gst_amount, 'I121'),
    grandTotal: plainAmount(row.grand_total, 'I122'),
    grossProductAmount: gross,
    expectedSubtotal: gross - discount,
  }
}

// ── The detail: products ──────────────────────────────────────────────────────

export type PersistedProduct = {
  /** The item row's id — what its pictures are keyed by. */
  id: string
  /** The worksheet row, which is what the viewer and the table agree on. */
  row: number
  itemSequence: string | null
  productName: string | null
  quantity: number | null
  dimensions: string | null
  material: string | null
  customization: string | null
  costPerPiece: number | null
  lineTotal: number | null
}

/**
 * The stored product lines, in the workbook's own order.
 *
 * Sorted by sort_order, which the server wrote as the position in the parsed
 * document. A stable tiebreak on source_row keeps two lines that somehow share a
 * sort order from swapping between renders.
 */
export function persistedProducts(items: readonly PersistedItem[]): PersistedProduct[] {
  return [...items]
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.source_row - b.source_row))
    .map(item => ({
      id: item.id,
      row: item.source_row,
      itemSequence: text(item.item_sequence),
      productName: text(item.product_name),
      quantity: toNumber(item.quantity),
      dimensions: text(item.dimensions),
      // Separate fields, at every layer. Never merged.
      material: text(item.material),
      customization: text(item.customization),
      costPerPiece: toNumber(item.cost_per_piece),
      lineTotal: toNumber(item.total_amount),
    }))
}

export type PersistedImageUrls = {
  representativeByRow: ReadonlyMap<number, string>
  customizationByRow: ReadonlyMap<number, readonly string[]>
  /** Stored pictures whose signed URL could not be obtained. Reported, never
   *  papered over: the table shows its honest "No image" box for them. */
  unresolved: number
}

const isRole = (value: string): value is PiImageRole =>
  value === 'representative' || value === 'customization'

/**
 * Stored pictures, keyed the way the preview helpers expect.
 *
 * Two joins happen here and both matter. The image rows name an ITEM; the table
 * and the viewer speak in WORKSHEET ROWS, so item ids are resolved through the
 * products. And a storage path is not a URL: `signedByPath` is the result of
 * asking Storage for time-limited URLs under the caller's own policies, so a
 * path the viewer may not read simply yields no picture rather than a broken
 * one.
 *
 * Customization pictures are ordered by their stored `position`, which the
 * server wrote as the workbook's own anchor order — that is what makes
 * "customization image 2 of 3" mean the same thing here as it does in the file.
 */
export function persistedImageUrlMaps(
  products: readonly PersistedProduct[],
  images: readonly PersistedItemImage[],
  signedByPath: ReadonlyMap<string, string>,
): PersistedImageUrls {
  const rowByItem = new Map(products.map(p => [p.id, p.row]))
  const representativeByRow = new Map<number, string>()
  const customization = new Map<number, { position: number; url: string }[]>()
  let unresolved = 0

  for (const image of [...images].sort((a, b) => a.position - b.position)) {
    const row = rowByItem.get(image.item_id)
    if (row === undefined || !isRole(image.role)) continue

    const url = signedByPath.get(image.storage_path)
    if (!url) { unresolved += 1; continue }

    if (image.role === 'representative') {
      representativeByRow.set(row, url)
      continue
    }
    const list = customization.get(row)
    if (list) list.push({ position: image.position, url })
    else customization.set(row, [{ position: image.position, url }])
  }

  const customizationByRow = new Map<number, readonly string[]>()
  for (const [row, entries] of customization) {
    customizationByRow.set(row, entries.sort((a, b) => a.position - b.position).map(e => e.url))
  }

  return { representativeByRow, customizationByRow, unresolved }
}

// ── The detail: saved diagnostics ─────────────────────────────────────────────

export type PersistedDiagnostic = {
  code: string
  message: string
  row: number | null
  cell: string | null
}

/**
 * The parse warnings and blocking issues stored verbatim on the submission.
 *
 * jsonb is `unknown` until proven otherwise: these were written by the server
 * from its own parse, but nothing here may assume a shape a future parser
 * version might change. An entry without a usable code and message is dropped
 * rather than rendered as "undefined".
 */
export function persistedDiagnostics(value: unknown): PersistedDiagnostic[] {
  if (!Array.isArray(value)) return []
  const out: PersistedDiagnostic[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const code = text(record.code)
    const message = text(record.message)
    if (!code || !message) continue
    out.push({
      code,
      message,
      row: toNumber(record.row) === null ? null : Math.trunc(toNumber(record.row) as number),
      cell: text(record.cell),
    })
  }
  return out
}
