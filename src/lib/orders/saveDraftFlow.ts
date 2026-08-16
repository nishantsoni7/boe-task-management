// The "Save Draft" flow, as data.
//
// The screen owns three async steps that can each fail differently — create the
// draft row, upload the workbook, ask the server to verify and persist it — and
// the rules about what the employee may click, what they are told, and what a
// success actually means are the part worth testing. All of it lives here as
// pure functions so it can be exercised without a browser, a network or a
// database.
//
// THE ONE RULE THAT MATTERS MOST. A success on this screen never means an order
// exists. It means a private draft was saved. Nothing in this module can
// produce a message that says otherwise, and `SAVE_SUCCESS_NO_NUMBER_NOTE` is
// asserted by a test for exactly that reason.

/** The four things that happen, in order, and what the employee is told. */
export const SAVE_STAGES = [
  { key: 'creating',  label: 'Creating draft' },
  { key: 'uploading', label: 'Uploading PI' },
  { key: 'verifying', label: 'Verifying PI' },
  { key: 'saving',    label: 'Saving products and images' },
] as const

export type SaveStageKey = (typeof SAVE_STAGES)[number]['key']

export const SAVE_BUTTON_LABEL = 'Save Draft'

export const SAVE_SUCCESS_NO_NUMBER_NOTE =
  'No official order number has been assigned. Numbering happens only after management approval.'

export function saveStageLabel(stage: SaveStageKey): string {
  return SAVE_STAGES.find(s => s.key === stage)?.label ?? ''
}

/** 1-based position, for "step 2 of 4". */
export function saveStageIndex(stage: SaveStageKey): number {
  return SAVE_STAGES.findIndex(s => s.key === stage) + 1
}

// ── May the button be pressed? ────────────────────────────────────────────────

export type SaveGateInput = {
  /** True only when a workbook has been parsed successfully in this tab. */
  hasPreview: boolean
  /** Blocking issues the BROWSER found. The server checks again regardless. */
  blockingCount: number
  /** A save is already in flight. */
  saving: boolean
  /** This draft has already been saved in this session. */
  saved: boolean
}

/**
 * Save Draft is enabled only when there is something to save, nothing blocking
 * it, and no save already running.
 *
 * The blocking check here is a COURTESY, not the control. An employee who
 * defeated it would still be refused by the server, which re-parses the
 * workbook and re-derives the issues itself. Disabling the button just stops a
 * person wasting an upload on a document they already know is wrong.
 *
 * Double-click prevention is the `saving` term, and it belongs in the same
 * function as the rest so there is one answer to "is this clickable".
 */
export function canSaveDraft(input: SaveGateInput): boolean {
  if (!input.hasPreview) return false
  if (input.blockingCount > 0) return false
  if (input.saving) return false
  if (input.saved) return false
  return true
}

// ── Failures ──────────────────────────────────────────────────────────────────

export type SaveFailure = {
  /** Stable code, safe to show and to log. Never carries workbook content. */
  code: string
  message: string
  /** Whether pressing Save Draft again could plausibly succeed. */
  retryable: boolean
  /** True when the SERVER rejected the document itself, so the browser's
   *  "ready" verdict was wrong and must not be restated. */
  serverRejectedDocument: boolean
}

const FAILURE_MESSAGES: Record<string, { message: string; retryable: boolean; document?: boolean }> = {
  UNAUTHORIZED:        { message: 'Your session has expired. Sign in again and retry.', retryable: false },
  FORBIDDEN:           { message: 'You do not have permission to create an order.', retryable: false },
  ACCOUNT_INACTIVE:    { message: 'This account cannot save order drafts.', retryable: false },
  NOT_OWNED:           { message: 'This draft belongs to someone else.', retryable: false },
  NOT_FOUND:           { message: 'This draft no longer exists. Start again.', retryable: false },
  NOT_EDITABLE:        { message: 'This submission can no longer be changed.', retryable: false },
  BAD_REQUEST:         { message: 'The draft could not be identified. Start again.', retryable: false },
  BAD_WORKBOOK_PATH:   { message: 'The uploaded PI could not be located for this draft.', retryable: true },
  WORKBOOK_NOT_STORED: { message: 'The uploaded PI could not be found. Upload it again.', retryable: true },
  WORKBOOK_EMPTY:      { message: 'The uploaded PI arrived empty. Upload it again.', retryable: true },
  WORKBOOK_TOO_LARGE:  { message: 'The PI is larger than 10 MB.', retryable: false },
  WORKBOOK_NOT_XLSX:   { message: 'The uploaded file is not an .xlsx workbook.', retryable: false },
  PARSE_FAILED:        { message: 'The server could not read this PI. Check the file and upload it again.', retryable: false, document: true },
  BLOCKING_ISSUES:     { message: 'The server found issues in this PI that must be fixed before it can be saved.', retryable: false, document: true },
  // A product image the system cannot store. The workbook has to change, so
  // this is a document rejection and retrying the same file cannot help.
  IMAGE_FORMAT_UNSUPPORTED: { message: 'This PI has a product image in a format that cannot be saved. Replace it with a PNG, JPG/JPEG or WebP image and upload the PI again.', retryable: false, document: true },
  // Not a failure at all: another attempt on this draft got there first. The
  // employee keeps their draft, their upload and their preview, and simply
  // waits. Never a document rejection.
  PROCESSING_BUSY:     { message: 'This draft is already being processed. Please try again shortly.', retryable: true },
  LEASE_FAILED:        { message: 'This draft could not be prepared for saving. Try again.', retryable: true },
  IMAGE_UPLOAD_FAILED: { message: 'The product images could not be saved. Try again.', retryable: true },
  IMAGE_INTEGRITY:     { message: 'A stored product image did not match the PI. Try again, or upload the PI again.', retryable: true },
  SAVE_FAILED:         { message: 'The draft could not be saved. Try again.', retryable: true },
  CREATE_FAILED:       { message: 'The draft could not be created. Try again.', retryable: true },
  UPLOAD_FAILED:       { message: 'The PI could not be uploaded. Check your connection and try again.', retryable: true },
  NETWORK:             { message: 'The server could not be reached. Check your connection and try again.', retryable: true },
}

const UNKNOWN_FAILURE = {
  message: 'Something went wrong while saving this draft. Try again.',
  retryable: true,
}

/**
 * A server or transport failure, in the shape the screen renders.
 *
 * An unrecognised code is retryable: the alternative is telling somebody their
 * work is unrecoverable on the strength of a code this build has not heard of.
 */
export function describeSaveFailure(code: string | null | undefined): SaveFailure {
  const known = code ? FAILURE_MESSAGES[code] : undefined
  const chosen = known ?? UNKNOWN_FAILURE
  return {
    code: code && code !== '' ? code : 'UNKNOWN',
    message: chosen.message,
    retryable: chosen.retryable,
    serverRejectedDocument: known?.document === true,
  }
}

// ── Success ───────────────────────────────────────────────────────────────────

export type SaveSuccess = {
  submissionId: string
  itemCount: number
  representativeImageCount: number
  customizationImageCount: number
  warningCodes: readonly string[]
  /** "12 products · 12 representative images · 4 customization images" */
  summary: string
  note: string
  /** Always false in this phase, and asserted as such. */
  orderNumberAssigned: false
}

type ProcessResponse = {
  submissionId?: unknown
  itemCount?: unknown
  representativeImageCount?: unknown
  customizationImageCount?: unknown
  warningCodes?: unknown
}

const count = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The server's answer, in the words the screen shows.
 *
 * Built ONLY from the response. The browser knows its own counts and they are
 * deliberately not used: if the two ever disagreed, the server's reading of the
 * document is the one that was saved, and the screen must show what was saved.
 */
export function summariseSaveResult(response: ProcessResponse, fallbackId: string): SaveSuccess {
  const items = count(response.itemCount)
  const representative = count(response.representativeImageCount)
  const customization = count(response.customizationImageCount)
  const warningCodes = Array.isArray(response.warningCodes)
    ? response.warningCodes.filter((c): c is string => typeof c === 'string')
    : []

  const parts = [
    plural(items, 'product', 'products'),
    plural(representative, 'representative image', 'representative images'),
  ]
  if (customization > 0) parts.push(plural(customization, 'customization image', 'customization images'))

  return {
    submissionId: typeof response.submissionId === 'string' ? response.submissionId : fallbackId,
    itemCount: items,
    representativeImageCount: representative,
    customizationImageCount: customization,
    warningCodes,
    summary: parts.join(' · '),
    note: SAVE_SUCCESS_NO_NUMBER_NOTE,
    orderNumberAssigned: false,
  }
}

// ── The workbook object key ───────────────────────────────────────────────────

export const WORKBOOK_UPLOAD_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * submissions/{submission_id}/original/{uuid}.xlsx
 *
 * An opaque uuid, NOT the employee's filename. A PI is named after the client
 * it was written for, and object keys travel into logs, signed URLs and storage
 * listings where a client's name has no business being.
 */
export function workbookObjectPath(submissionId: string, objectId: string): string {
  return `submissions/${submissionId}/original/${objectId}.xlsx`
}
