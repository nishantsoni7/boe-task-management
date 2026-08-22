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
  // The reviewer this PI is routed to. Read on the detail page for one reason:
  // the PI's named reviewer is one of the three people record_pi_submission_payment()
  // permits to record a payment against it, so the screen can offer the control
  // to exactly whom the database would allow. A courtesy, never the authority.
  assigned_to: string | null
  submitted_at: string | null
  rejected_by: string | null
  rejected_at: string | null

  creation_date: string | null
  source_created_by: string | null
  bill_to_name: string | null
  ship_to_name: string | null
  order_confirmation_date: string | null
  dispatch_commitment: string | null
  /**
   * The dispatch due date, or null.
   *
   * Written ONLY from an explicit, plausible calendar date — see
   * src/lib/orders/dueDate.ts and migration 20260922000000. Never derived from
   * the prose in dispatch_commitment beside it.
   */
  due_date: string | null
  /**
   * How much of total_before_gst should be billed, as a percentage — or null
   * for undeclared, which is neither 0 nor 100. Added by migration
   * 20260923000000. PostgREST hands numeric back as a STRING; readBillingPercentage
   * in src/lib/orders/billingPercentage.ts is the one place that converts it.
   *
   * Optional on the type so a payload from before the migration still parses.
   */
  billing_percentage?: number | string | null

  // How to reach the client, and where the order goes. Parsed into these
  // columns since 20260908000000 and stored ever since; the detail page only
  // began READING them when its top summary started answering "who is this and
  // how do I contact them" in one place.
  contact_number: string | null
  bill_to_phone: string | null
  ship_to_phone: string | null
  billing_address: string | null
  shipping_address: string | null
  // Optional on the TYPE because these two are newly READ, not newly written:
  // the parser has stored them since 20260908000000, but fixtures built before
  // the detail page asked for them do not carry the keys.
  bill_to_gst?: string | null
  ship_to_gst?: string | null
  payment_terms?: string | null
  billing_terms?: string | null

  /** Optimistic-concurrency counter — see PI_DRAFT_DETAIL_COLUMNS. */
  row_version?: number | null

  source_workbook_name: string | null
  /** The stored key. Optional so a fixture written before this read still types. */
  source_workbook_path?: string | null

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
  /**
   * OPTIONAL, because a payload built before the product editor existed does
   * not carry it. Absent reads as "no code", which is what a line without one
   * has always meant — not as a missing field the caller forgot.
   */
  source_product_code?: string | null
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
  // WHAT THE ORDER IS WORTH, BOTH WAYS, because they answer different questions
  // and the gap between them is itself information. gross_product_amount is the
  // goods; grand_total is what the client is billed once discount, fabric,
  // packing, transport and GST are applied. A row showing only one of them
  // leaves a reader to guess which.
  'gross_product_amount', 'grand_total',
  // WHO AUTHORED THE PI, AND WHEN — read out of the workbook itself, not from
  // any app user. A PI is usually written by one person and uploaded by another,
  // and a list that names only the uploader cannot answer "whose order is this?"
  'source_created_by', 'creation_date',
  // WHEN IT WAS UPLOADED. created_at is what the list SHOWS — the record's own
  // beginning. updated_at is read only because the query is ordered by it, so a
  // draft corrected five minutes ago still surfaces above one untouched since
  // Monday; it is no longer a column anybody reads off the screen.
  'created_at', 'updated_at',
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
  'created_by', 'submitted_by', 'assigned_to', 'submitted_at', 'rejected_by', 'rejected_at',
  'creation_date', 'source_created_by', 'bill_to_name', 'ship_to_name',
  'order_confirmation_date', 'dispatch_commitment',
  // The dispatch DATE, when the PI stated an explicit one. Added by migration
  // 20260922000000 and read here with everything else — dispatch_commitment
  // above keeps the prose, and the two are never confused for one another.
  'due_date',
  // The declared billing percentage, read with everything else — one request,
  // as before. Migration 20260923000000 adds it; see the deployment note in
  // that file's header for why the migration goes first.
  'billing_percentage',
  // Contact and location, for the top summary. No new column: every one of
  // these has been written by the save route since the table was created.
  'contact_number', 'bill_to_phone', 'ship_to_phone',
  'billing_address', 'shipping_address',
  // The two tax numbers, read with everything else. Editable through
  // update_order_submission_client_details (20260928000000) and previously
  // written by the parser but never surfaced.
  'bill_to_gst', 'ship_to_gst',
  // The two agreed arrangements (20260921000000). Editable through
  // update_order_submission_schedule_terms; read here so the editor can
  // prefill them and the detail page can show them.
  'payment_terms', 'billing_terms',
  // The optimistic-concurrency counter (20260928000000). Read here so an
  // editor can send back the version it opened at; a concurrent edit moves it
  // and the second write is refused rather than silently winning.
  'row_version',
  'source_workbook_name',
  // WHETHER A WORKBOOK IS STORED AT ALL, which source_workbook_name cannot
  // answer: the save route deliberately writes NULL there, because a PI is
  // named after its client and a body-supplied filename is unverified text. So
  // a null name is the normal case and says nothing. The PATH is the fact, and
  // piReadiness('submission') needs it — submit_pi_for_review refuses a PI with
  // no stored workbook, and a screen that could not see that would be listing
  // everything except the one thing no editor can fix.
  'source_workbook_path',
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
  // source_product_code is read for the product editor: a form that could not
  // show the code it was about to change would be editing blind.
  'id', 'source_row', 'item_sequence', 'source_product_code', 'product_name',
  'quantity', 'dimensions', 'material', 'customization', 'cost_per_piece',
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
  /**
   * Who AUTHORED the PI, as the workbook itself names them.
   *
   * NOT AN APP USER, and deliberately not resolved against `users`: this is the
   * name typed into the document, which is frequently somebody who has no login
   * at all. It answers a different question from `uploader` below, and the two
   * are shown side by side precisely because they are so often different people.
   */
  authoredBy: string
  /** The date the PI document itself carries, or "—". */
  authoredOn: string
  /**
   * The app user who uploaded it, resolved from `users`, or "—".
   *
   * An honest dash when the name could not be resolved. A row without a name is
   * still a row, and printing a uuid would be worse than printing nothing.
   */
  uploader: string
  /** When it was uploaded, in Indian business time. */
  uploadedAt: string
  /** The goods, before discount, other costs and GST. "—" when the workbook
   *  printed no product figure. */
  productValue: string
  /** What the client is billed. "—" when the workbook printed no total. */
  grandTotal: string
  status: string
  statusLabel: string
  statusTone: PiDraftStatusTone
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
export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

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
  formatMoney: (amount: number | null) => string,
  /**
   * The display names the caller has already batch-fetched, by role on the
   * record. Both optional, and both render as an honest dash when absent: a name
   * the caller could not resolve must never be replaced by an id.
   */
  names?: {
    /** Who uploaded it — the app user behind created_by. */
    uploader?: string | null
    /** Who last sent it for review — the app user behind submitted_by. */
    submitter?: string | null
  },
): PiDraftListEntry {
  const submittedIso = text(row.submitted_at)
  return {
    id: row.id,
    createdBy: row.created_by,
    submittedBy: row.submitted_by,
    href: draftDetailHref(row.id),
    client: text(row.client_name) ?? text(row.bill_to_name) ?? 'Unnamed client',
    // The workbook's own author, verbatim. Never resolved against `users`, and
    // never substituted with the uploader when the document left it blank.
    authoredBy: text(row.source_created_by) ?? '—',
    authoredOn: formatDateOnly(row.creation_date),
    uploader: text(names?.uploader ?? null) ?? '—',
    uploadedAt: formatSavedAt(row.created_at),
    productValue: formatMoney(toNumber(row.gross_product_amount)),
    grandTotal: formatMoney(toNumber(row.grand_total)),
    status: row.status,
    statusLabel: draftStatusLabel(row.status),
    statusTone: draftStatusTone(row.status),
    submittedAt: submittedIso ? formatSavedAt(submittedIso) : '—',
    submittedAtIso: submittedIso,
    submitter: text(names?.submitter ?? null) ?? '—',
  }
}

// ── The detail: header ────────────────────────────────────────────────────────

const dateValue = (iso: string | null): PiDateValue | null =>
  iso ? { iso, text: iso, source: 'serial' } : null

/**
 * EXACTLY the columns persistedHeader reads, and no more.
 *
 * A `Pick` rather than the whole row, so a caller that legitimately selects
 * FEWER columns still type-checks — /orders/[id] reads the approved PI a
 * Confirmed Order came from and has no business pulling that PI's review notes,
 * its advance decision or its deletion reservation. Every existing caller passes
 * a full PersistedSubmission, which satisfies this by construction.
 */
export type PersistedHeaderSource = Pick<
  PersistedSubmission,
  | 'client_name'
  | 'creation_date'
  | 'source_created_by'
  | 'bill_to_name'
  | 'ship_to_name'
  | 'order_confirmation_date'
  | 'dispatch_commitment'
>

/** EXACTLY the columns persistedCommercial reads. Same reasoning as above. */
export type PersistedCommercialSource = Pick<
  PersistedSubmission,
  | 'gross_product_amount'
  | 'discount_amount'
  | 'subtotal_after_discount'
  | 'fabric_cost'
  | 'fabric_cost_meaning'
  | 'fabric_cost_text'
  | 'packing_cost'
  | 'packing_cost_meaning'
  | 'packing_cost_text'
  | 'transportation_amount'
  | 'transportation_text'
  | 'total_before_gst'
  | 'gst_amount'
  | 'grand_total'
>

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
export function persistedHeader(row: PersistedHeaderSource): PiHeader {
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
export function persistedCommercial(row: PersistedCommercialSource): PiCommercialSummary {
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
  sourceProductCode: string | null
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
      sourceProductCode: text(item.source_product_code),
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
