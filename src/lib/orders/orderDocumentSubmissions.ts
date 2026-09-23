// ── DESIGN FILES AND CLIENT PO: SUBMITTED, REVIEWED TWICE, THEN CURRENT ──────
//
// The rows come from public.order_document_submissions (20261231000000). A
// submission is Sales proposing a change to one or both categories; an admin
// approves or rejects it, then the assigned operations reviewer accepts or
// rejects it. ONLY AN ACCEPTED SUBMISSION IS CURRENT — this module derives the
// current document set from accepted submissions and nothing else, so a
// pending or rejected upload can never be drawn as the accepted file.
//
// IT DECIDES NOTHING. Who may submit or decide is re-derived by the three RPCs
// under row locks; the functions here only choose which controls to draw.
//
// The Main PI is not a category here: a new PI goes through the existing
// revised-PI door (orderPiVersions.ts) and the PI-to-operations handoff.

// ── Persisted rows ───────────────────────────────────────────────────────────

export type DocumentCategory = 'design_files' | 'client_po'

export type DocumentSubmissionStatus =
  | 'pending_admin'
  | 'awaiting_operations'
  | 'accepted'
  | 'rejected_admin'
  | 'rejected_operations'

export type PersistedDocumentFile = {
  id: string
  category: DocumentCategory
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
}

export type PersistedDocumentSubmission = {
  id: string
  /** 'initial': sent with the PI and decided with it. 'amendment': a change on the Order. */
  stage: 'initial' | 'amendment'
  /** Null only for an initial submission whose PI has no Order yet. */
  order_id: string | null
  pi_submission_id: string | null
  includes_design_files: boolean
  includes_client_po: boolean
  design_mode: 'add' | 'replace' | null
  note: string | null
  status: DocumentSubmissionStatus
  snapshot_sha256: string
  file_count: number
  resubmission_of: string | null
  submitted_by: string
  submitted_at: string
  admin_decided_by: string | null
  admin_decided_at: string | null
  admin_reason: string | null
  operations_reviewer: string | null
  operations_decided_by: string | null
  operations_decided_at: string | null
  operations_reason: string | null
  files?: PersistedDocumentFile[] | null
}

/** Named, never `*`. The files are embedded so one read answers the section. */
export const ORDER_DOCUMENT_SUBMISSION_SELECT = [
  'id', 'stage', 'order_id', 'pi_submission_id', 'includes_design_files', 'includes_client_po', 'design_mode', 'note',
  'status', 'snapshot_sha256', 'file_count', 'resubmission_of',
  'submitted_by', 'submitted_at', 'admin_decided_by', 'admin_decided_at', 'admin_reason',
  'operations_reviewer', 'operations_decided_by', 'operations_decided_at', 'operations_reason',
  'files:order_document_submission_files(id, category, storage_path, file_name, mime_type, size_bytes)',
].join(', ')

// ── Words ────────────────────────────────────────────────────────────────────

export const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  design_files: 'Design Files',
  client_po: 'Client PO',
}

/** Status in words first; colour only repeats it. */
export const SUBMISSION_STATUS_LABEL: Record<DocumentSubmissionStatus, string> = {
  pending_admin: 'Pending Admin Review',
  awaiting_operations: 'Awaiting Operations Acceptance',
  accepted: 'Accepted',
  rejected_admin: 'Rejected by Admin',
  rejected_operations: 'Rejected by Operations',
}

export type SubmissionTone = 'green' | 'amber' | 'red' | 'neutral'

export const SUBMISSION_STATUS_TONE: Record<DocumentSubmissionStatus, SubmissionTone> = {
  pending_admin: 'amber',
  awaiting_operations: 'amber',
  accepted: 'green',
  rejected_admin: 'red',
  rejected_operations: 'red',
}

export const UPLOAD_NEW_PI_LABEL = 'Upload New PI'
export const UPLOAD_DESIGN_FILES_LABEL = 'Upload Design Files'
export const UPLOAD_CLIENT_PO_LABEL = 'Upload Client PO'
export const SUBMIT_DOCUMENTS_TITLE = 'Submit documents for review'
export const SUBMIT_DOCUMENTS_CONFIRM = 'Submit for Admin review'
export const SUBMIT_DOCUMENTS_NOTE =
  'Nothing on this Order changes yet. An administrator reviews these files first, then Operations must accept them before they replace the current documents. The current accepted files stay in use until then.'
export const DESIGN_MODE_ADD_LABEL = 'Add files — keep the current design files and add these'
export const DESIGN_MODE_REPLACE_LABEL = 'Replace current files — these become the whole design set (the old files stay in history)'
export const NO_ACCEPTED_DESIGN_FILES = 'No design files accepted on this Order yet'
export const NO_ACCEPTED_CLIENT_PO = 'No client PO accepted on this Order yet'
export const CATEGORY_PENDING_BLOCKS_UPLOAD = (label: string) =>
  `${label} already has a submission under review. Wait for its decision before submitting another.`

export const ADMIN_APPROVE_LABEL = 'Approve'
export const ADMIN_REJECT_LABEL = 'Reject'
export const OPS_ACCEPT_LABEL = 'Accept'
export const OPS_REJECT_LABEL = 'Reject'
export const REVIEW_FILES_LABEL = 'Review files'
export const CORRECT_AND_RESUBMIT_LABEL = 'Correct and resubmit'

export const DECISION_REASON_MAX_LENGTH = 1000
export const DECISION_REASON_REQUIRED = 'A reason is required to reject a submission. Sales will see it.'
export const DECISION_REASON_TOO_LONG = `The reason may be at most ${DECISION_REASON_MAX_LENGTH} characters.`
export const NOTE_MAX_LENGTH = 1000

// ── Files: the same rules the bucket and the RPC enforce ─────────────────────

export const DOCUMENT_ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
export const MAX_DESIGN_FILES = 20
export const MAX_CLIENT_PO_FILES = 5
export const DOCUMENT_ACCEPT_ATTR = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp'

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** A file the browser offers, checked before any byte is uploaded. The server
 *  re-checks the stored object's own type and size. */
export function validateDocumentFile(file: { name: string; size: number; type: string }): string | null {
  if (!(DOCUMENT_ALLOWED_MIME as readonly string[]).includes(file.type)) {
    return `${file.name}: only PDF, PNG, JPEG or WebP files can be attached.`
  }
  if (file.size <= 0) return `${file.name} is empty.`
  if (file.size > DOCUMENT_MAX_BYTES) return `${file.name} is larger than 10 MB.`
  return null
}

/** The storage key the INSERT policy admits: sealed once the submission exists. */
export function documentObjectPath(input: {
  orderId: string
  submissionId: string
  category: DocumentCategory
  fileId: string
  mime: string
}): string {
  const ext = EXT_BY_MIME[input.mime]
  if (!ext) throw new Error('unsupported document type')
  return `order-documents/${input.orderId}/${input.submissionId}/${input.category}/${input.fileId}.${ext}`
}

export function validateDecisionReason(raw: string, required: boolean):
  | { ok: true; reason: string | null }
  | { ok: false; message: string } {
  const reason = raw.trim()
  if (required && reason === '') return { ok: false, message: DECISION_REASON_REQUIRED }
  if (reason.length > DECISION_REASON_MAX_LENGTH) return { ok: false, message: DECISION_REASON_TOO_LONG }
  return { ok: true, reason: reason === '' ? null : reason }
}

// ── The current accepted set ─────────────────────────────────────────────────

const byOpsDecision = (a: PersistedDocumentSubmission, b: PersistedDocumentSubmission) =>
  (a.operations_decided_at ?? '').localeCompare(b.operations_decided_at ?? '')

const filesOf = (s: PersistedDocumentSubmission, category: DocumentCategory) =>
  (s.files ?? []).filter(f => f.category === category)

/**
 * THE ACCEPTED FILES OF ONE CATEGORY, derived from accepted submissions only.
 *
 * Client PO: the latest accepted submission that carried one.
 * Design Files: every accepted design submission from the latest accepted
 * REPLACE onwards (an ADD extends the set, a REPLACE starts it again). Nothing
 * pending, awaiting or rejected is ever counted.
 */
export function currentAcceptedFiles(
  rows: readonly PersistedDocumentSubmission[],
  category: DocumentCategory,
): { files: PersistedDocumentFile[]; acceptedAt: string | null; submissionIds: string[] } {
  const accepted = rows
    .filter(r => r.status === 'accepted')
    .filter(r => (category === 'design_files' ? r.includes_design_files : r.includes_client_po))
    .slice()
    .sort(byOpsDecision)
  if (accepted.length === 0) return { files: [], acceptedAt: null, submissionIds: [] }

  if (category === 'client_po') {
    const latest = accepted[accepted.length - 1]
    return { files: filesOf(latest, category), acceptedAt: latest.operations_decided_at, submissionIds: [latest.id] }
  }

  let start = 0
  accepted.forEach((r, i) => { if (r.design_mode === 'replace') start = i })
  const inForce = accepted.slice(start)
  return {
    files: inForce.flatMap(r => filesOf(r, category)),
    acceptedAt: inForce[inForce.length - 1].operations_decided_at,
    submissionIds: inForce.map(r => r.id),
  }
}

/** The one unresolved submission covering a category, if any (the database
 *  allows at most one). */
export function openSubmissionFor(
  rows: readonly PersistedDocumentSubmission[],
  category: DocumentCategory,
): PersistedDocumentSubmission | null {
  return rows.find(r =>
    (r.status === 'pending_admin' || r.status === 'awaiting_operations')
    && (category === 'design_files' ? r.includes_design_files : r.includes_client_po),
  ) ?? null
}

// ── Who acts now ─────────────────────────────────────────────────────────────

export type DocumentViewer = {
  viewerId: string | null
  isAdmin: boolean
  canSubmit: boolean
  viewingAs: boolean
}

export function isOperationsReviewerFor(s: PersistedDocumentSubmission, viewer: DocumentViewer): boolean {
  if (!viewer.viewerId || viewer.viewingAs) return false
  // THE ROW IS THE AUTHORITY. The database readdresses operations_reviewer
  // inside the same transaction as a Control Center reassignment
  // (20261231000000 §12), and the decision RPC refuses anybody else — so the
  // Order page, the dashboard queue and the database read one answer.
  return s.operations_reviewer === viewer.viewerId
}

/** The stage's owner, in words, for "current owner" on a card or queue row. */
export function currentOwnerLabel(
  s: PersistedDocumentSubmission,
  nameOf: (id: string | null) => string | null,
): string {
  if (s.stage === 'initial') {
    if (s.status === 'pending_admin') return 'Admin — decided with the PI approval'
    if (s.status === 'awaiting_operations') {
      return s.operations_reviewer
        ? `Operations — ${nameOf(s.operations_reviewer) ?? 'assigned reviewer'}, with PI V1's operations review`
        : 'Operations — no reviewer assigned (PI V1 operations review)'
    }
  }
  switch (s.status) {
    case 'pending_admin': return 'Admin'
    case 'awaiting_operations':
      return s.operations_reviewer ? `Operations — ${nameOf(s.operations_reviewer) ?? 'assigned reviewer'}` : 'Operations — no reviewer assigned'
    case 'rejected_admin':
    case 'rejected_operations': return `Sales — ${nameOf(s.submitted_by) ?? 'submitter'}`
    case 'accepted': return 'Nobody — accepted'
  }
}

export function nextActionLabel(s: PersistedDocumentSubmission): string {
  if (s.stage === 'initial') {
    if (s.status === 'pending_admin') return 'Approver to approve the PI (creating the Order) or return it'
    if (s.status === 'awaiting_operations') return 'Operations to Accept for production PI V1'
    if (s.status === 'rejected_admin') return 'Sales to correct and resubmit the PI'
  }
  switch (s.status) {
    case 'pending_admin': return 'Admin to approve or reject'
    case 'awaiting_operations': return 'Operations to accept or reject'
    case 'rejected_admin':
    case 'rejected_operations': return 'Sales to correct and resubmit'
    case 'accepted': return 'None'
  }
}

export type SubmissionActions = {
  adminDecide: boolean
  operationsDecide: boolean
  resubmit: boolean
}

export function submissionActions(s: PersistedDocumentSubmission, viewer: DocumentViewer): SubmissionActions {
  const live = !viewer.viewingAs && !!viewer.viewerId
  // Documents sent with a PI have no decision of their own: the PI's approval,
  // return and operations acceptance decide them.
  if (s.stage === 'initial') return { adminDecide: false, operationsDecide: false, resubmit: false }
  return {
    adminDecide: live && viewer.isAdmin && s.status === 'pending_admin',
    operationsDecide: live && s.status === 'awaiting_operations' && isOperationsReviewerFor(s, viewer),
    resubmit: live && viewer.canSubmit
      && (s.status === 'rejected_admin' || s.status === 'rejected_operations'),
  }
}

export function categoriesOf(s: PersistedDocumentSubmission): DocumentCategory[] {
  const out: DocumentCategory[] = []
  if (s.includes_design_files) out.push('design_files')
  if (s.includes_client_po) out.push('client_po')
  return out
}

export function categoriesLabel(s: PersistedDocumentSubmission): string {
  return categoriesOf(s).map(c => CATEGORY_LABEL[c]).join(' + ')
}

/** The rejection a Sales reader must see, with who said it. */
export function rejectionOf(s: PersistedDocumentSubmission): { stage: 'Admin' | 'Operations'; reason: string; by: string | null; at: string | null } | null {
  if (s.status === 'rejected_admin') {
    return { stage: 'Admin', reason: s.admin_reason ?? '', by: s.admin_decided_by, at: s.admin_decided_at }
  }
  if (s.status === 'rejected_operations') {
    return { stage: 'Operations', reason: s.operations_reason ?? '', by: s.operations_decided_by, at: s.operations_decided_at }
  }
  return null
}

/** Rejected submissions not yet superseded by a correction. */
export function uncorrectedRejections(rows: readonly PersistedDocumentSubmission[]): PersistedDocumentSubmission[] {
  const corrected = new Set(rows.map(r => r.resubmission_of).filter((x): x is string => !!x))
  return rows.filter(r => (r.status === 'rejected_admin' || r.status === 'rejected_operations') && !corrected.has(r.id))
}

// ── The "Needs your action" queue ────────────────────────────────────────────

export type QueueRow = {
  submission: PersistedDocumentSubmission
  orderNumber: string
  mine: boolean
}

export type QueueSplit = {
  /** Awaiting THIS reader's decision or correction. */
  needsYou: QueueRow[]
  /** Sales only: their open submissions awaiting somebody else. */
  waitingOnOthers: QueueRow[]
}

/**
 * THE QUEUE, FILTERED TO THE READER'S ROLE.
 *
 *   Admin        submissions pending an admin decision
 *   Operations   admin-approved submissions addressed to them
 *   Sales        their own rejections not yet corrected; and, separately,
 *                their own submissions awaiting somebody else
 */
export function splitDocumentQueue(
  rows: readonly { submission: PersistedDocumentSubmission; orderNumber: string }[],
  viewer: DocumentViewer,
): QueueSplit {
  const needsYou: QueueRow[] = []
  const waitingOnOthers: QueueRow[] = []
  if (!viewer.viewerId || viewer.viewingAs) return { needsYou, waitingOnOthers }
  const corrected = new Set(rows.map(r => r.submission.resubmission_of).filter((x): x is string => !!x))

  for (const r of rows) {
    const s = r.submission
    // Initial documents are not a separate task: the PI review queue and the
    // operations handoff already carry them.
    if (s.stage === 'initial') continue
    const own = s.submitted_by === viewer.viewerId
    if (s.status === 'pending_admin' && viewer.isAdmin) {
      needsYou.push({ ...r, mine: own })
    } else if (s.status === 'awaiting_operations' && isOperationsReviewerFor(s, viewer)) {
      needsYou.push({ ...r, mine: own })
    } else if (own && (s.status === 'rejected_admin' || s.status === 'rejected_operations') && !corrected.has(s.id)) {
      needsYou.push({ ...r, mine: true })
    } else if (own && (s.status === 'pending_admin' || s.status === 'awaiting_operations')) {
      waitingOnOthers.push({ ...r, mine: true })
    }
  }
  const newestFirst = (a: QueueRow, b: QueueRow) => b.submission.submitted_at.localeCompare(a.submission.submitted_at)
  return { needsYou: needsYou.sort(newestFirst), waitingOnOthers: waitingOnOthers.sort(newestFirst) }
}

/** The anchor on the Order page a queue row and a notification open at. */
export const DOCUMENTS_ANCHOR = 'documents'

export function queueHref(orderId: string): string {
  return `/orders/${orderId}#${DOCUMENTS_ANCHOR}`
}

// ── Failures, in sentences ───────────────────────────────────────────────────

export function describeDocumentFailure(error: { message?: string | null } | null | undefined): string {
  const raw = error?.message ?? ''
  const coded = raw.match(/ORDER_DOCUMENT_[A-Z_]+: ([\s\S]*)$/)
  if (coded) return coded[1]
  if (/row-level security|violates|permission|42501|Only /i.test(raw)) {
    return raw.startsWith('Only ') ? raw : 'You do not have permission to do that on this Order.'
  }
  if (/order_document_submissions_one_open/.test(raw)) {
    return 'That category already has a submission under review. Refresh to see it.'
  }
  return 'That did not go through. Refresh and try again.'
}

// ── Sending the PI with its supporting documents (initial submission) ────────

/** A supporting category offered when a PI is sent for approval. */
export type SupportingCategory = DocumentCategory

export const SUBMIT_WITHOUT_FILES_LABEL = 'Submit without these files'
export const SUPPORTING_DOCUMENTS_TITLE = 'Supporting documents (optional)'
export const SUPPORTING_DOCUMENTS_NOTE =
  'Attached files are reviewed with this PI: the approver approves them by creating the Order, and Operations accepts them with PI V1. Nothing is current on the Order before then.'

/**
 * THE ONE EXPLICIT QUESTION, naming exactly what is missing.
 *   both   "No design files or client PO are attached to this submission. Submit without them?"
 *   one    "No client PO is attached to this submission. Submit without it?"
 */
export function missingSupportingQuestion(missing: readonly SupportingCategory[]): string {
  const design = missing.includes('design_files')
  const po = missing.includes('client_po')
  if (design && po) return 'No design files or client PO are attached to this submission. Submit without them?'
  if (design) return 'No design files are attached to this submission. Submit without them?'
  if (po) return 'No client PO is attached to this submission. Submit without it?'
  return ''
}

/** The categories with no file, in a fixed order. */
export function missingSupporting(input: { designCount: number; clientPoCount: number }): SupportingCategory[] {
  const out: SupportingCategory[] = []
  if (input.designCount === 0) out.push('design_files')
  if (input.clientPoCount === 0) out.push('client_po')
  return out
}

/** Where a file sent with a PI is stored: sealed once the PI is submitted. */
export function piDocumentObjectPath(input: {
  piSubmissionId: string
  submissionId: string
  category: DocumentCategory
  fileId: string
  mime: string
}): string {
  const ext = EXT_BY_MIME[input.mime]
  if (!ext) throw new Error('unsupported document type')
  return `pi-documents/${input.piSubmissionId}/${input.submissionId}/${input.category}/${input.fileId}.${ext}`
}

/** An acknowledged absence, as the Order's Documents section states it. */
export type PersistedAbsence = { missing: string[]; acknowledged_by: string; acknowledged_at: string }

export function absenceLine(
  absence: PersistedAbsence | null,
  category: DocumentCategory,
  nameOf: (id: string | null) => string | null,
  formatWhen: (iso: string | null) => string,
): string | null {
  if (!absence || !absence.missing.includes(category)) return null
  return `Not provided — ${nameOf(absence.acknowledged_by) ?? 'the submitter'} confirmed sending the PI without ${category === 'client_po' ? 'a client PO' : 'design files'} on ${formatWhen(absence.acknowledged_at)}.`
}
