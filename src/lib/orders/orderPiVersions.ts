// The PI versions of one Confirmed Order, as something a person can read.
//
// WHAT THIS MODULE IS ABOUT
// -------------------------
// A Confirmed Order may receive another PI later. The rows come from
// public.order_pi_versions (20261119000000): V1 is the document the Order was
// approved from; every later row is a REVISION that never overwrites the current
// one. This module turns those rows into the three things the Order screen
// draws — the current version, the pending revision if there is one, and the
// history — and owns the words, the validation and the failure sentences of the
// propose / approve / reject controls.
//
// WHAT IT IS NOT. Not authorization and not a parser. propose_order_pi_revision,
// reject_order_pi_revision and the approve route re-derive who may do what under
// row locks; the revised workbook is parsed on the server by the same route that
// saves a draft. Nothing here decides which version is current — the database's
// partial unique index does — this only draws what it finds.

import { workbookObjectPath } from './saveDraftFlow'

// ── The persisted row ─────────────────────────────────────────────────────────

export type PiVersionStatus = 'pending' | 'approved' | 'rejected' | 'superseded'

export type PersistedPiVersion = {
  id: string
  order_id: string
  submission_id: string
  version_number: number
  status: string
  workbook_path: string | null
  workbook_name: string | null
  uploaded_by: string | null
  uploaded_at: string
  revision_reason: string | null
  decided_by: string | null
  decided_at: string | null
  decision_reason: string | null
  superseded_at: string | null
}

/** Named, never `*`. The hash and the successor link are not read: the screen
 *  shows a file, a reason and a decision, and nothing that is only a key. */
export const ORDER_PI_VERSION_COLUMNS = [
  'id', 'order_id', 'submission_id', 'version_number', 'status',
  'workbook_path', 'workbook_name',
  'uploaded_by', 'uploaded_at', 'revision_reason',
  'decided_by', 'decided_at', 'decision_reason', 'superseded_at',
].join(', ')

// ── Words ─────────────────────────────────────────────────────────────────────

export const PI_HISTORY_TITLE = 'PI History'
export const PI_HISTORY_CURRENT_HEADING = 'Current'
export const PI_HISTORY_PENDING_HEADING = 'Pending revision'
export const PI_HISTORY_PAST_HEADING = 'History'
export const PI_HISTORY_EMPTY = 'No PI versions are recorded for this Order.'

export const PI_VERSION_STATUS_LABEL: Record<PiVersionStatus, string> = {
  pending:    'Pending approval',
  approved:   'Approved',
  rejected:   'Rejected',
  superseded: 'Superseded',
}

export type PiVersionTone = 'green' | 'amber' | 'red' | 'neutral'

export const PI_VERSION_STATUS_TONE: Record<PiVersionStatus, PiVersionTone> = {
  pending:    'amber',
  approved:   'green',
  rejected:   'red',
  superseded: 'neutral',
}

export const UPLOAD_REVISION_BUTTON_LABEL = 'Upload revised PI'
export const UPLOAD_REVISION_DIALOG_TITLE = 'Upload revised PI'
export const UPLOAD_REVISION_CONFIRM_LABEL = 'Propose revision'
export const APPROVE_REVISION_BUTTON_LABEL = 'Approve revision'
export const REJECT_REVISION_BUTTON_LABEL = 'Reject revision'
export const REJECT_REVISION_DIALOG_TITLE = 'Reject revised PI'
export const REVISION_REASON_LABEL = 'Why is a revised PI needed? *'
export const REVISION_REASON_PLACEHOLDER = 'e.g. client changed the quantity on line 3'
export const REVISION_DECISION_REASON_LABEL = 'Why the revised PI is refused *'
export const REVISION_FILE_LABEL = 'Revised PI workbook (.xlsx) *'
export const OPEN_VERSION_LABEL = 'Open'

/**
 * What the upload dialog says the revision will and will not do.
 *
 * The second sentence is the whole reason the dialog exists rather than a bare
 * file picker: the current PI is what the Order runs on, and a person uploading
 * a new one must know nothing changes until an administrator approves it.
 */
export const UPLOAD_REVISION_NOTE =
  'The current approved PI stays in force. The revised PI is recorded as a pending version and changes nothing on this Order until an administrator approves it.'
export const APPROVE_REVISION_NOTE =
  'Approving applies the revised workbook to this Order: its figures, product lines and pictures are re-read from the new file, any ready documents stop being current, and the previous PI is kept as history.'

export const REVISION_REASON_MAX_LENGTH = 500
export const REVISION_DECISION_REASON_MAX_LENGTH = 1000

export const REVISION_REASON_REQUIRED = 'Say why a revised PI is being proposed.'
export const REVISION_REASON_TOO_LONG =
  `A reason may be at most ${REVISION_REASON_MAX_LENGTH} characters.`
export const REVISION_DECISION_REASON_REQUIRED = 'A reason is required to reject the revised PI.'
export const REVISION_DECISION_REASON_TOO_LONG =
  `A reason may be at most ${REVISION_DECISION_REASON_MAX_LENGTH} characters.`
export const REVISION_FILE_REQUIRED = 'Choose the revised PI workbook.'
export const REVISION_FILE_NOT_XLSX = 'The revised PI must be an .xlsx workbook.'

/** `PI V3`, said once so every surface numbers a version the same way. */
export function piVersionLabel(versionNumber: number): string {
  return `PI V${versionNumber}`
}

// ── The view ──────────────────────────────────────────────────────────────────

export type PiVersionView = {
  id: string
  versionNumber: number
  label: string
  status: PiVersionStatus
  statusLabel: string
  tone: PiVersionTone
  /** The storage key, for the signer. Null when the file is not recorded. */
  workbookPath: string | null
  workbookName: string | null
  uploadedBy: string
  uploadedAt: string
  revisionReason: string | null
  /** "Approved by X · date" / "Rejected by X · date", or null while pending. */
  decisionLine: string | null
  decisionReason: string | null
}

export type PiVersionHistory = {
  /** The one approved version, or null for an Order with no recorded PI. */
  current: PiVersionView | null
  /** The one open revision, or null. */
  pending: PiVersionView | null
  /** Everything else, newest first: superseded and rejected versions. */
  history: PiVersionView[]
}

export const UNKNOWN_ACTOR = 'Unknown user'

function asStatus(value: string): PiVersionStatus | null {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'superseded'
    ? value
    : null
}

/**
 * The history, from the rows.
 *
 * ONE CURRENT AND ONE PENDING AT MOST, by the database's own indexes; if a read
 * ever returned two of either, the newest by version number wins here and the
 * other is listed — never silently dropped — so a defect would be visible rather
 * than hidden. A row whose status this build does not know is dropped, for the
 * same reason the activity trail drops an unknown action.
 */
export function describePiVersionHistory(
  rows: readonly PersistedPiVersion[],
  namesById: ReadonlyMap<string, string>,
  formatWhen: (iso: string | null) => string,
): PiVersionHistory {
  const name = (id: string | null): string => {
    const n = id ? namesById.get(id) : undefined
    return n && n.trim() !== '' ? n.trim() : UNKNOWN_ACTOR
  }

  const views = rows
    .map(row => {
      const status = asStatus(row.status)
      if (status === null) return null
      const decisionVerb =
        status === 'approved' || status === 'superseded' ? 'Approved'
        : status === 'rejected' ? 'Rejected'
        : null
      const view: PiVersionView = {
        id: row.id,
        versionNumber: row.version_number,
        label: piVersionLabel(row.version_number),
        status,
        statusLabel: PI_VERSION_STATUS_LABEL[status],
        tone: PI_VERSION_STATUS_TONE[status],
        workbookPath: row.workbook_path && row.workbook_path.trim() !== '' ? row.workbook_path : null,
        workbookName: row.workbook_name && row.workbook_name.trim() !== '' ? row.workbook_name : null,
        uploadedBy: name(row.uploaded_by),
        uploadedAt: formatWhen(row.uploaded_at),
        revisionReason: row.revision_reason && row.revision_reason.trim() !== '' ? row.revision_reason.trim() : null,
        decisionLine: decisionVerb && row.decided_at
          ? `${decisionVerb} by ${name(row.decided_by)} · ${formatWhen(row.decided_at)}`
          : null,
        decisionReason: row.decision_reason && row.decision_reason.trim() !== '' ? row.decision_reason.trim() : null,
      }
      return view
    })
    .filter((v): v is PiVersionView => v !== null)
    .sort((a, b) => b.versionNumber - a.versionNumber)

  const current = views.find(v => v.status === 'approved') ?? null
  const pending = views.find(v => v.status === 'pending') ?? null
  const history = views.filter(v => v !== current && v !== pending)

  return { current, pending, history }
}

/** Every user id a set of version rows refers to — one users read, not one per row. */
export function versionActorIds(rows: readonly PersistedPiVersion[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.uploaded_by) ids.add(row.uploaded_by)
    if (row.decided_by) ids.add(row.decided_by)
  }
  return [...ids]
}

// ── Who is offered what ───────────────────────────────────────────────────────
//
// THE BROWSER-SIDE HALF. propose_order_pi_revision() and the approve/reject
// doors re-derive all of it under row locks; this decides only whether a control
// is drawn. A hidden control is a courtesy.

export type PiRevisionActor = {
  /** The SIGNED-IN user, never a View As target. */
  viewerId: string | null
  isAdmin: boolean
  /** orders.create, as deriveOrdersCapabilities resolved it. */
  canCreate: boolean
}

export type PiRevisionTarget = {
  orderStatus: string
  /** The source PI's owners. */
  createdBy: string | null
  submittedBy: string | null
  /** Whether the Order has a recorded PI at all. */
  hasCurrentVersion: boolean
  hasPendingRevision: boolean
}

/** Upload revised PI: the PI's owner or an admin, with orders.create, on a live
 *  Order with a PI and no open revision. */
export function canProposePiRevision(actor: PiRevisionActor, target: PiRevisionTarget): boolean {
  if (!target.hasCurrentVersion || target.hasPendingRevision) return false
  if (target.orderStatus === 'cancelled') return false
  if (!actor.viewerId) return false
  const owns = target.createdBy === actor.viewerId || target.submittedBy === actor.viewerId
  if (!(actor.isAdmin || owns)) return false
  return actor.isAdmin || actor.canCreate
}

/** Approve / reject a revision: an ACTIVE ADMIN, matching the deployed rule for
 *  moving a submitted PI's figures (20261003000000 §1). */
export function canDecidePiRevision(actor: Pick<PiRevisionActor, 'isAdmin'>): boolean {
  return actor.isAdmin
}

// ── Validation ────────────────────────────────────────────────────────────────

export type ReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; message: string }

export function validateRevisionReason(value: string | null | undefined): ReasonValidation {
  const reason = (value ?? '').trim()
  if (reason === '') return { ok: false, message: REVISION_REASON_REQUIRED }
  if (reason.length > REVISION_REASON_MAX_LENGTH) return { ok: false, message: REVISION_REASON_TOO_LONG }
  return { ok: true, reason }
}

export function validateRevisionDecisionReason(value: string | null | undefined): ReasonValidation {
  const reason = (value ?? '').trim()
  if (reason === '') return { ok: false, message: REVISION_DECISION_REASON_REQUIRED }
  if (reason.length > REVISION_DECISION_REASON_MAX_LENGTH) {
    return { ok: false, message: REVISION_DECISION_REASON_TOO_LONG }
  }
  return { ok: true, reason }
}

/** The file, checked by name only: the server re-checks the bytes it holds. */
export function validateRevisionFile(file: { name: string; size: number } | null): string | null {
  if (!file) return REVISION_FILE_REQUIRED
  if (!/\.xlsx$/i.test(file.name)) return REVISION_FILE_NOT_XLSX
  return null
}

/**
 * Where a revised workbook is stored: THIS submission's own original/ folder,
 * under an opaque id, exactly where every workbook goes — so every parser path,
 * the storage policy and the approval RPC recognise it as a workbook of this PI.
 */
export function revisionWorkbookPath(submissionId: string, objectId: string): string {
  return workbookObjectPath(submissionId, objectId)
}

// ── Failures ──────────────────────────────────────────────────────────────────

const REVISION_FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'ORDER_PI_REVISION_PENDING',
    message: 'A revised PI is already waiting for a decision on this Order.' },
  { marker: 'ORDER_PI_REVISION_SAME_FILE',
    message: 'That workbook is already a version of this Order’s PI. Upload a different file.' },
  { marker: 'ORDER_PI_REVISION_ORDER_CLOSED',
    message: 'This Order is cancelled and cannot take a revised PI.' },
  { marker: 'ORDER_PI_REVISION_NOT_OWNER',
    message: 'Only the person who owns this PI, or an administrator, can propose a revision.' },
  { marker: 'ORDER_PI_REVISION_NOT_PENDING',
    message: 'This revision has already been decided. Refresh to see its current state.' },
  { marker: 'ORDER_PI_REVISION_STALE',
    message: 'A newer PI has been approved since this revision was proposed. Refresh to see its current state.' },
  { marker: 'ORDER_PI_REVISION_FILE_MISMATCH',
    message: 'The stored file does not match this revision. Upload it again.' },
  { marker: 'ORDER_PI_REVISION_REASON_REQUIRED', message: REVISION_REASON_REQUIRED },
  { marker: 'ORDER_PI_REVISION_DECISION_REASON_REQUIRED', message: REVISION_DECISION_REASON_REQUIRED },
  { marker: 'ORDER_PI_REVISION_REASON_TOO_LONG', message: REVISION_REASON_TOO_LONG },
  { marker: 'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
    message: 'The revised PI could not be found in storage. Upload it again.' },
  { marker: 'ORDER_SUBMISSION_BAD_WORKBOOK_PATH',
    message: 'The revised PI could not be located for this Order. Upload it again.' },
  { marker: 'BLOCKING_ISSUES',
    message: 'The revised PI has issues that must be fixed in the workbook before it can be approved.' },
  { marker: 'PARSE_FAILED',
    message: 'The revised PI could not be read. Check the file and try again.' },
  { marker: 'PROCESSING_BUSY',
    message: 'This PI is already being processed. Please try again shortly.' },
  { marker: 'ORDER_SUBMISSION_REVISED_PI',
    message: 'The revised PI does not carry this Order’s number. Correct the workbook and upload it again.' },
  { marker: 'do not have permission', message: 'You do not have permission to do this.' },
  { marker: 'Authentication required', message: 'Your session has expired. Sign in again and try once more.' },
]

export const REVISION_FALLBACK: Record<'propose' | 'approve' | 'reject', string> = {
  propose: 'The revised PI could not be recorded just now. Try again in a moment.',
  approve: 'The revised PI could not be approved just now. Nothing on this Order was changed.',
  reject: 'The revised PI could not be rejected just now. Try again in a moment.',
}

/** A failed revision action, in the words the screen shows. The raw message is
 *  never rendered; only which marker it contains is read. */
export function describePiRevisionFailure(
  error: unknown,
  action: 'propose' | 'approve' | 'reject',
): string {
  const raw = typeof error === 'string'
    ? error
    : String((error as { message?: unknown; error?: unknown } | null)?.message
        ?? (error as { error?: unknown } | null)?.error ?? '')
  const known = REVISION_FAILURES.find(entry => raw.includes(entry.marker))
  return known ? known.message : REVISION_FALLBACK[action]
}
