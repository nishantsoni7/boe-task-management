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

// ── Sent with a submitted PI, before its Order exists ───────────────────────

export const SENT_WITH_PI_TITLE = 'Sent with this PI'

/**
 * The documents a submitted PI carries while no Order exists yet, with who acts
 * next. The Order page names the owner once the Order is created; until then
 * this is the only place the PI page shows them — including on an approver's
 * OWN PI, whose PI decision is auto-stamped (20261224000000) while its
 * attachments still wait for the Order and then for operations.
 */
export function sentWithPi(rows: readonly PersistedDocumentSubmission[]): {
  submission: PersistedDocumentSubmission
  owner: string
  next: string
} | null {
  const pending = rows
    .filter(r => r.stage === 'initial' && r.status === 'pending_admin')
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0]
  if (!pending) return null
  return { submission: pending, owner: currentOwnerLabel(pending, () => null), next: nextActionLabel(pending) }
}

/** Rejected submissions not yet superseded by a correction. */
export function uncorrectedRejections(rows: readonly PersistedDocumentSubmission[]): PersistedDocumentSubmission[] {
  const corrected = new Set(rows.map(r => r.resubmission_of).filter((x): x is string => !!x))
  return rows.filter(r => (r.status === 'rejected_admin' || r.status === 'rejected_operations') && !corrected.has(r.id))
}

// ── The Documents card: what is current, and what is changing ────────────────
//
// ONE VOCABULARY FOR THE CARD. The accepted rows say "on file" and carry no
// status of their own beyond the Main PI's one pill; a change says only where it
// stands — waiting for Admin, waiting for Operations, or rejected — so a reader
// never meets "Approved", "Accepted" and "Accepted for production" side by side
// for one file. The finer stage names (SUBMISSION_STATUS_LABEL) stay in the
// review dialog and the history, where the distinction is the point.

export const DOCUMENT_CURRENT_LABEL = 'Current'
export const NO_DESIGN_FILES_ON_FILE = 'No design files on file'
export const NO_CLIENT_PO_ON_FILE = 'No client PO on file'
export const UPDATE_DOCUMENTS_LABEL = 'Update documents'
export const DOCUMENT_CHANGES_TITLE = 'Document changes'
export const NEEDS_YOUR_ACTION_TITLE = 'Needs your action'
export const REVIEW_CHANGE_LABEL = 'Review change'

/** Where a change stands, in the card's own words. */
export const CHANGE_STATUS_LABEL: Record<DocumentSubmissionStatus, string> = {
  pending_admin: 'Waiting for Admin',
  awaiting_operations: 'Waiting for Operations',
  accepted: 'Current',
  rejected_admin: 'Rejected by Admin',
  rejected_operations: 'Rejected by Operations',
}

/** One accepted-document row: what is on file for a category, and nothing proposed. */
export type SupportingRowView =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'none'; message: string; note: string | null }
  | { kind: 'files'; files: PersistedDocumentFile[]; acceptedAt: string | null }

/**
 * THE ACCEPTED ROW FOR ONE CATEGORY, from accepted submissions only.
 *
 * An absent file says "No … on file" and never implies one was accepted. The
 * acknowledged absence from the PI's submission is a quiet note under it, and
 * only while nothing newer is under review for that category.
 */
export function supportingRow(
  api: { rows: readonly PersistedDocumentSubmission[]; state: 'loading' | 'ready' | 'unavailable' },
  category: DocumentCategory,
  absence: string | null,
): SupportingRowView {
  if (api.state === 'loading') return { kind: 'loading' }
  if (api.state === 'unavailable') return { kind: 'unavailable' }
  const accepted = currentAcceptedFiles(api.rows, category)
  if (accepted.files.length > 0) return { kind: 'files', files: accepted.files, acceptedAt: accepted.acceptedAt }
  return {
    kind: 'none',
    message: category === 'design_files' ? NO_DESIGN_FILES_ON_FILE : NO_CLIENT_PO_ON_FILE,
    note: openSubmissionFor(api.rows, category) ? null : absence,
  }
}

/** One proposed or rejected submission, as the "Document changes" panel draws it. */
export type DocumentChangeView = {
  submission: PersistedDocumentSubmission
  /** "New Design Files", "New Client PO", "Design Files + Client PO sent with PI V1". */
  title: string
  status: DocumentSubmissionStatus
  statusLabel: string
  tone: SubmissionTone
  /** What the change does to the files on file, in words. */
  effect: string
  /** "Submitted by Asha, 20 Sept · approved by Nishant, 21 Sept". */
  submittedLine: string
  /** Who holds it now, and what they do next. */
  owner: string
  next: string
  note: string | null
  /** The rejection, when there is one: "The PO is not signed — Nishant (Admin), 21 Sept". */
  rejection: string | null
  /** The proposed files themselves, never drawn as current. */
  files: PersistedDocumentFile[]
  /** The viewer's own control on it, if any. */
  action: 'admin_review' | 'operations_review' | 'resubmit' | null
}

const countFiles = (n: number) => `${n} file${n === 1 ? '' : 's'}`

/**
 * THE CHANGES IN FLIGHT, ONCE EACH.
 *
 * A submission covering both categories used to be drawn under each of them; it
 * is one entry here. Open submissions come first (at most one per category, the
 * database's own rule), then any rejection its submitter — or an admin — still
 * has to correct, unless a newer submission for the same files is already open.
 */
export function documentChanges(
  rows: readonly PersistedDocumentSubmission[],
  viewer: DocumentViewer,
  nameOf: (id: string | null) => string | null,
  formatWhen: (iso: string | null) => string,
): DocumentChangeView[] {
  const open = rows.filter(r => r.status === 'pending_admin' || r.status === 'awaiting_operations')
  const covered = new Set(open.flatMap(categoriesOf))
  const rejected = uncorrectedRejections(rows)
    .filter(r => r.submitted_by === viewer.viewerId || viewer.isAdmin)
    .filter(r => !categoriesOf(r).some(c => covered.has(c)))
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
    .slice(0, 1)

  return [...open, ...rejected].map(s => {
    const effects: string[] = []
    const designFiles = (s.files ?? []).filter(f => f.category === 'design_files')
    const poFiles = (s.files ?? []).filter(f => f.category === 'client_po')
    if (s.stage === 'initial') {
      effects.push(`${countFiles((s.files ?? []).length)} sent with the PI — decided with its Operations review`)
    } else {
      if (s.includes_design_files) {
        effects.push(s.design_mode === 'add'
          ? `Would add ${countFiles(designFiles.length)} to the current design files`
          : currentAcceptedFiles(rows, 'design_files').files.length > 0
            ? `Would replace the current design files with ${countFiles(designFiles.length)}`
            : `Would be the first design files (${countFiles(designFiles.length)})`)
      }
      if (s.includes_client_po) {
        effects.push(currentAcceptedFiles(rows, 'client_po').files.length > 0
          ? `Would replace the current client PO with ${countFiles(poFiles.length)}`
          : `Would be the first client PO (${countFiles(poFiles.length)})`)
      }
    }
    const submitted = [`Submitted by ${nameOf(s.submitted_by) ?? 'Sales'}, ${formatWhen(s.submitted_at)}`]
    if (s.admin_decided_at && s.status !== 'rejected_admin') {
      submitted.push(`approved by ${nameOf(s.admin_decided_by) ?? 'Admin'}, ${formatWhen(s.admin_decided_at)}`)
    }
    const rej = rejectionOf(s)
    const actions = submissionActions(s, viewer)
    return {
      submission: s,
      title: s.stage === 'initial' ? `${categoriesLabel(s)} sent with the PI` : `New ${categoriesLabel(s)}`,
      status: s.status,
      statusLabel: CHANGE_STATUS_LABEL[s.status],
      tone: SUBMISSION_STATUS_TONE[s.status],
      effect: effects.join(' · '),
      submittedLine: submitted.join(' · '),
      owner: currentOwnerLabel(s, nameOf),
      next: nextActionLabel(s),
      note: s.note,
      rejection: rej ? `${rej.reason} — ${nameOf(rej.by) ?? rej.stage} (${rej.stage}), ${formatWhen(rej.at)}` : null,
      files: s.files ?? [],
      action: actions.adminDecide ? 'admin_review' : actions.operationsDecide ? 'operations_review' : actions.resubmit ? 'resubmit' : null,
    }
  })
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
