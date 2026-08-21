// CONFIRMED ORDER DOCUMENTS — the vocabulary, the paths, and what a screen says.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// Migration 20260925000000 is the authority for every rule below: which states
// exist, where a file lives, when a version is downloadable, and who may ask for
// one. This module exists so the browser and the server can SPEAK about those
// rules without a second implementation of them — and so that a test can read
// the migration and this file together and prove they still agree.
//
// NOTHING HERE AUTHORIZES ANYTHING. Whether a person may ask for documents is
// decided by two RLS policies as the caller; whether they may download one is
// decided by the order-files storage rule. This module decides only what a
// control is CALLED and whether it is worth showing.
//
// NOTHING HERE COMPUTES A FIGURE. It reports state.

// ── The states ────────────────────────────────────────────────────────────────

/**
 * The four states a version can be in, and no fifth.
 *
 * The set is CLOSED in SQL by order_document_versions_status_known, and closed
 * here by this type. A row somehow carrying anything else renders as its raw
 * value rather than being mistaken for a state this system understands.
 */
export const ORDER_DOCUMENT_STATUSES = ['pending', 'claimed', 'ready', 'failed'] as const

export type OrderDocumentStatus = typeof ORDER_DOCUMENT_STATUSES[number]

export function isOrderDocumentStatus(value: unknown): value is OrderDocumentStatus {
  return typeof value === 'string' && (ORDER_DOCUMENT_STATUSES as readonly string[]).includes(value)
}

/**
 * WHAT EACH STATE IS CALLED, in a person's words rather than a machine's.
 *
 * `claimed` says "Generating" and not "Claimed": a lease is an implementation
 * detail of how two workers avoid each other, and nobody reading an Order screen
 * is asking about it. What they are asking is whether their documents are on
 * their way.
 */
export const ORDER_DOCUMENT_STATUS_LABEL: Record<OrderDocumentStatus, string> = {
  pending: 'Queued',
  claimed: 'Generating',
  ready:   'Ready',
  failed:  'Failed',
}

/** The restrained palette the Order screens already spend state colour from. */
export type OrderDocumentTone = 'neutral' | 'blue' | 'green' | 'red'

export const ORDER_DOCUMENT_STATUS_TONE: Record<OrderDocumentStatus, OrderDocumentTone> = {
  pending: 'neutral',
  claimed: 'blue',
  ready:   'green',
  failed:  'red',
}

// ── Paths ─────────────────────────────────────────────────────────────────────
//
// THE SAME THREE RULES public.order_document_version_prefix and
// public.order_document_attempt_path state in SQL. orderDocumentsSchema.test.ts
// reads the migration and pins them to these, so the two cannot drift.

/** The document kinds this system produces, and the only two it will accept. */
export const ORDER_DOCUMENT_KINDS = ['xlsx', 'pdf'] as const
export type OrderDocumentKind = typeof ORDER_DOCUMENT_KINDS[number]

/** `orders/{order_id}/versions/{version}` — the shape 20260908000000 §9 reserved. */
export function orderDocumentVersionPrefix(orderId: string, version: number): string {
  return `orders/${orderId}/versions/${version}`
}

/**
 * Where ONE ATTEMPT writes its output.
 *
 * ATTEMPT-SCOPED, because order-files has no UPDATE policy and its objects are
 * immutable: every write must go to a key nothing has ever occupied, or a retry
 * after a half-finished attempt could never succeed. The version row then NAMES
 * the two objects of the attempt that worked, and naming them is what publishes
 * them.
 *
 * Null — never a plausible-looking key — for an unknown kind or an impossible
 * counter. Every caller treats null as a refusal.
 */
export function orderDocumentAttemptPath(
  orderId: string,
  version: number,
  attempt: number,
  kind: OrderDocumentKind,
): string | null {
  if (!(ORDER_DOCUMENT_KINDS as readonly string[]).includes(kind)) return null
  if (!Number.isInteger(version) || version < 1) return null
  if (!Number.isInteger(attempt) || attempt < 1) return null
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(orderId)) return null
  return `${orderDocumentVersionPrefix(orderId, version)}/attempts/${attempt}/approved.${kind}`
}

/** How long a document download link lives. The same hour the PI's own files
 *  use: long enough to press, short enough that a URL copied out of the page
 *  stops working the same hour. */
export const ORDER_DOCUMENT_URL_TTL_SECONDS = 3600

// ── The row ───────────────────────────────────────────────────────────────────

/**
 * The columns a CLIENT may select.
 *
 * claim_token is absent, and not by omission: it is granted to no client role,
 * so naming it here would make every read of this table fail outright. That is
 * the guarantee stated as a column list.
 */
export const ORDER_DOCUMENT_COLUMNS = [
  'id', 'order_id', 'version', 'status', 'attempt_count',
  'claimed_at', 'completed_at',
  'last_error_code', 'last_error_message',
  'excel_path', 'pdf_path', 'excel_sha256', 'pdf_sha256', 'excel_bytes', 'pdf_bytes',
  'created_at', 'updated_at',
].join(', ')

export type OrderDocumentRow = {
  id: string
  order_id: string
  version: number
  status: string
  attempt_count: number
  claimed_at: string | null
  completed_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  excel_path: string | null
  pdf_path: string | null
  excel_sha256: string | null
  pdf_sha256: string | null
  excel_bytes: number | string | null
  pdf_bytes: number | string | null
  created_at: string
  updated_at: string
}

// ── What the screen says ──────────────────────────────────────────────────────

export const ORDER_DOCUMENTS_TITLE = 'Order documents'

export const ORDER_DOCUMENTS_NONE =
  'No documents have been generated for this Order yet.'

export const ORDER_DOCUMENTS_GENERATE_LABEL = 'Generate documents'
export const ORDER_DOCUMENTS_RETRY_LABEL = 'Try again'
export const ORDER_DOCUMENTS_EXCEL_LABEL = 'Confirmed Excel'
export const ORDER_DOCUMENTS_PDF_LABEL = 'Confirmed PDF'

/**
 * The one sentence shown while generation is in flight.
 *
 * NO PROGRESS BAR AND NO ESTIMATE. Nothing in this system knows how long a
 * render will take, and a bar that creeps to 90% and stops is worse than a
 * sentence that is honest.
 */
export const ORDER_DOCUMENTS_WORKING =
  'Generating. This page will show the documents once both are ready.'

/**
 * DOCUMENT-READY MEANS BOTH FILES, and this is the one place the browser says so.
 *
 * The database already refuses to record `ready` without both paths — see
 * order_document_versions_ready_is_complete — so this can never disagree with it
 * for a row that came from the database. It exists because a screen must not
 * offer one download and imply the other is coming.
 */
export function isOrderDocumentReady(row: Pick<OrderDocumentRow, 'status' | 'excel_path' | 'pdf_path'>): boolean {
  return row.status === 'ready'
    && typeof row.excel_path === 'string' && row.excel_path.trim() !== ''
    && typeof row.pdf_path === 'string' && row.pdf_path.trim() !== ''
}

/**
 * What the Order screen shows for its documents.
 *
 * ONE ANSWER, so the card, the button and the tests cannot disagree about
 * whether there is anything to download or anything to press.
 */
export type OrderDocumentsView = {
  /** The version a person is looking at: the newest ready one, else the newest. */
  version: number | null
  status: OrderDocumentStatus | null
  statusLabel: string | null
  tone: OrderDocumentTone | null
  /** True only when BOTH files exist. */
  downloadable: boolean
  /** Present only when downloadable — the two objects to sign on a click. */
  excelPath: string | null
  pdfPath: string | null
  /** True while a generation is queued or running. */
  working: boolean
  /**
   * The last failure, in a person's words.
   *
   * The MESSAGE is what the server chose to store, already sanitized; the CODE
   * is never shown — it is a token for a log, and putting it on screen invites
   * somebody to search for it instead of reading the sentence.
   */
  failure: string | null
  /** How many attempts this version has taken. Shown only when it is more than
   *  one, because "attempt 1" is not information. */
  attempts: number | null
}

/**
 * WHICH VERSION A PERSON IS LOOKING AT.
 *
 * The newest READY one, if there is one — because that is what they can actually
 * open, and a failed attempt at a newer version does not take their documents
 * away. Otherwise the newest row, whatever state it is in, because that is what
 * is happening now.
 *
 * A ready version and an in-flight one can legitimately coexist: an approved
 * amendment opens version 2 while version 1 is still downloadable.
 */
export function currentOrderDocument(rows: readonly OrderDocumentRow[]): OrderDocumentRow | null {
  if (rows.length === 0) return null
  const byVersionDesc = [...rows].sort((a, b) => b.version - a.version)
  return byVersionDesc.find(isOrderDocumentReady) ?? byVersionDesc[0]
}

/** The newest row of any kind — what is happening now, as against what can be
 *  opened. Null for an Order that has never been asked for documents. */
export function latestOrderDocument(rows: readonly OrderDocumentRow[]): OrderDocumentRow | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => b.version - a.version)[0]
}

export function buildOrderDocumentsView(rows: readonly OrderDocumentRow[]): OrderDocumentsView {
  const shown = currentOrderDocument(rows)
  const latest = latestOrderDocument(rows)

  if (!shown || !latest) {
    return {
      version: null, status: null, statusLabel: null, tone: null,
      downloadable: false, excelPath: null, pdfPath: null,
      working: false, failure: null, attempts: null,
    }
  }

  const status = isOrderDocumentStatus(shown.status) ? shown.status : null
  const downloadable = isOrderDocumentReady(shown)

  // WORKING IS A FACT ABOUT THE NEWEST ROW, not about the one being shown: while
  // version 2 generates, version 1 is still what a person can open, and both
  // things are true at once.
  const working = latest.status === 'pending' || latest.status === 'claimed'

  // AND SO IS THE FAILURE. A failed version 2 must be reported even while
  // version 1 remains downloadable, or somebody waits for documents that are
  // not coming.
  const failed = latest.status === 'failed'

  return {
    version: shown.version,
    status,
    statusLabel: status === null ? null : ORDER_DOCUMENT_STATUS_LABEL[status],
    tone: status === null ? null : ORDER_DOCUMENT_STATUS_TONE[status],
    downloadable,
    excelPath: downloadable ? shown.excel_path : null,
    pdfPath: downloadable ? shown.pdf_path : null,
    working,
    failure: failed ? failureText(latest) : null,
    attempts: latest.attempt_count > 1 ? latest.attempt_count : null,
  }
}

/**
 * The stored message, or a plain fallback.
 *
 * NEVER THE CODE, and never a raw exception. If the server stored nothing usable
 * the honest thing is a short sentence saying generation failed and can be tried
 * again — not a token nobody can act on.
 */
export function failureText(row: Pick<OrderDocumentRow, 'last_error_message'>): string {
  const message = (row.last_error_message ?? '').trim()
  if (message === '') return ORDER_DOCUMENTS_GENERIC_FAILURE
  return message
}

export const ORDER_DOCUMENTS_GENERIC_FAILURE =
  'Generating the documents did not finish. You can try again.'

// ── Sanitizing what a failure is allowed to say ───────────────────────────────

/**
 * WHAT MAY BE STORED AS A FAILURE MESSAGE.
 *
 * A person needs to know why their documents did not appear. They must never be
 * told it through a stack trace, a connection string, a bearer token or an
 * internal hostname — and neither must anyone else who can see the Order.
 *
 * SO THIS IS AN ALLOW-LIST, NOT A SCRUBBER. A scrubber tries to find the secret
 * in arbitrary text and is wrong the first time a secret takes a shape nobody
 * anticipated. This instead maps a known failure to a sentence written in
 * advance, and maps everything else to the generic one. An unrecognised error
 * therefore cannot leak anything, because none of its own text is used.
 *
 * The CODE is stored beside it for the log and is never rendered.
 */
export const ORDER_DOCUMENT_FAILURES = {
  WORKBOOK_MISSING: 'The PI workbook this Order was created from could not be found in storage.',
  WORKBOOK_MISMATCH: 'The stored workbook does not match the PI this Order was created from.',
  WORKBOOK_UNREADABLE: 'The PI workbook could not be read as a valid Excel file.',
  WORKBOOK_UNSUPPORTED: 'The PI workbook uses a format this system cannot rewrite safely.',
  WORKBOOK_TOO_LARGE: 'The generated workbook is larger than the storage limit allows.',
  PDF_RENDER_FAILED: 'The confirmed PDF could not be rendered.',
  PDF_TOO_LARGE: 'The generated PDF is larger than the storage limit allows.',
  IMAGE_UNREADABLE: 'One of the product images could not be decoded.',
  UPLOAD_FAILED: 'The generated files could not be saved to storage.',
  CLAIM_LOST: 'Another generation took over before this one finished.',
  NO_SOURCE_PI: 'This Order was not created from a PI, so it has no documents to generate.',
  PI_UNREADABLE: 'The approved PI behind this Order could not be read.',
} as const

export type OrderDocumentFailureCode = keyof typeof ORDER_DOCUMENT_FAILURES

export function isOrderDocumentFailureCode(value: unknown): value is OrderDocumentFailureCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ORDER_DOCUMENT_FAILURES, value)
}

/** The code stored for a failure nobody anticipated. Its message is the generic
 *  one, so an unrecognised error contributes NO text of its own. */
export const ORDER_DOCUMENT_UNKNOWN_FAILURE = 'GENERATION_FAILED'

/**
 * A failure, as it will be stored.
 *
 * Takes whatever the generator threw and returns a code and a message that were
 * both written here, in advance. The thrown value's own text is never used, and
 * that is the whole security property.
 */
export function sanitizeOrderDocumentFailure(code: unknown): {
  code: string
  message: string
} {
  if (isOrderDocumentFailureCode(code)) {
    return { code, message: ORDER_DOCUMENT_FAILURES[code] }
  }
  return { code: ORDER_DOCUMENT_UNKNOWN_FAILURE, message: ORDER_DOCUMENTS_GENERIC_FAILURE }
}
