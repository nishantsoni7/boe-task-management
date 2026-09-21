// FABRIC AND FINISH, AS THE CARD READS THEM.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// public.order_approval_events (20261227000000) is an APPEND-ONLY log: one row
// per change, each naming the kind, the new status, the ERP screenshot behind
// it, who recorded it and when. There is no current-status column anywhere and
// there deliberately never will be — the current state of each kind is the
// NEWEST EVENT for that kind, which is a read.
//
// So this module does three things and no more: it folds a list of events into
// two current standings, it decides what the update dialog may submit, and it
// owns the words. Every rule it states is one the database states again under a
// row lock — record_order_approval_event() re-derives the authority, the
// evidence requirement, the path ownership and the no-op refusal whatever the
// browser sent.
//
// NOTHING HERE AUTHORIZES. `canRecord` is handed in, resolved from the caller's
// own profile and the Order's assigned salesperson, and is used only to decide
// whether a control is DRAWN. A hidden button is a courtesy; the refusal is the
// RPC's.

// ── The vocabulary ────────────────────────────────────────────────────────────

export type ApprovalKind = 'fabric' | 'finish'
export type ApprovalStatus = 'not_approved' | 'partially_approved' | 'fully_approved'
export type ApprovalTone = 'green' | 'amber' | 'red' | 'neutral'

export const APPROVAL_KINDS: readonly ApprovalKind[] = ['fabric', 'finish']

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'not_approved', 'partially_approved', 'fully_approved',
]

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  fabric: 'Fabric',
  finish: 'Finish',
}

export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  not_approved:       'Not Approved',
  partially_approved: 'Partially Approved',
  fully_approved:     'Fully Approved',
}

/**
 * RESTRAINED, AND NEVER THE ONLY SIGNAL.
 *
 * Red for the state before anything has happened, amber for part of the way,
 * green for done. Every pill that uses this also prints the words above, so a
 * reader who cannot tell amber from red still reads "Partially Approved".
 */
export const APPROVAL_STATUS_TONE: Record<ApprovalStatus, ApprovalTone> = {
  not_approved:       'red',
  partially_approved: 'amber',
  fully_approved:     'green',
}

/** The private bucket the ERP screenshots live in (20261227000000). */
export const APPROVAL_EVIDENCE_BUCKET = 'order-approval-evidence'

export const FABRIC_FINISH_TITLE = 'Fabric & Finish'
export const FABRIC_FINISH_UPDATE_LABEL = 'Update'
export const FABRIC_FINISH_READ_ONLY =
  'Only the salesperson on this Order, an admin or a manager can update these.'
export const FABRIC_FINISH_VIEW_AS_NOTE =
  'You are viewing as somebody else, so these are read-only.'

/** What the dialog says when a required screenshot has not been chosen. */
export const EVIDENCE_REQUIRED_MESSAGE = 'An ERP screenshot is required for this change.'
export const EVIDENCE_SAME_FILE_MESSAGE =
  'Fabric and Finish each need their own screenshot. Choose a different file for one of them.'

export const EVIDENCE_VIEW_LABEL = 'View proof'

/** What the bucket accepts. Stated once so the picker, the check and the
 *  migration's allowed_mime_types cannot drift apart. */
export const EVIDENCE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']
export const EVIDENCE_ACCEPT = EVIDENCE_MIME_TYPES.join(',')
/** 5 MiB — the bucket's own file_size_limit, restated for the dialog. */
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024
export const EVIDENCE_BAD_TYPE_MESSAGE = 'The screenshot must be a PNG, JPEG or WebP image.'
export const EVIDENCE_TOO_LARGE_MESSAGE = 'The screenshot must be 5 MB or smaller.'

// ── The stored row ────────────────────────────────────────────────────────────

export type PersistedApprovalEvent = {
  id: string
  order_id: string
  approval_kind: string
  status: string
  evidence_path: string | null
  actor_id: string | null
  created_at: string
}

/** Named, never `*`. */
export const ORDER_APPROVAL_EVENT_COLUMNS = [
  'id', 'order_id', 'approval_kind', 'status', 'evidence_path', 'actor_id', 'created_at',
].join(', ')

const isKind = (value: string): value is ApprovalKind =>
  value === 'fabric' || value === 'finish'

const isStatus = (value: string): value is ApprovalStatus =>
  value === 'not_approved' || value === 'partially_approved' || value === 'fully_approved'

// ── The standing ──────────────────────────────────────────────────────────────

export type ApprovalKindStanding = {
  kind: ApprovalKind
  label: string
  status: ApprovalStatus
  tone: ApprovalTone
  /**
   * When this status was recorded, already formatted — or NULL for Not
   * Approved.
   *
   * A DATE IS ONLY DRAWN WHERE THERE IS AN EVENT TO DATE. Not Approved is where
   * every Order starts, so dating it would date something that never happened.
   * A deliberate revert TO Not Approved is a real event and is kept in the
   * history below; the card still shows no date beside it, because the field
   * means "approved on" and nothing was.
   */
  at: string | null
  /** The screenshot behind the current status, when it has one. */
  evidencePath: string | null
  /** Who recorded it, or null. */
  actorId: string | null
}

export type ApprovalStanding = {
  kinds: ApprovalKindStanding[]
  readOnlyNote: string
}

/**
 * The current state of each kind, from the whole event list.
 *
 * NEWEST EVENT WINS, and the caller is expected to have read the rows newest
 * first; this sorts again anyway so a differently-ordered read cannot change
 * the answer. An Order with no events at all is Not Approved on both, which is
 * the truthful default and is never stored anywhere.
 *
 * A row whose kind or status this build does not recognise is DROPPED, for the
 * same reason the activity trail drops an unknown action: showing a status the
 * screen cannot name would be worse than showing the last one it can.
 */
export function approvalStanding(input: {
  events: readonly PersistedApprovalEvent[]
  /** Already formatted by the caller. */
  formatWhen: (iso: string) => string
  readOnlyNote?: string
}): ApprovalStanding {
  const { events, formatWhen } = input

  const newest = new Map<ApprovalKind, PersistedApprovalEvent>()
  for (const event of events) {
    if (!isKind(event.approval_kind) || !isStatus(event.status)) continue
    const held = newest.get(event.approval_kind)
    if (!held || event.created_at > held.created_at) newest.set(event.approval_kind, event)
  }

  return {
    kinds: APPROVAL_KINDS.map(kind => {
      const event = newest.get(kind)
      const status: ApprovalStatus =
        event && isStatus(event.status) ? event.status : 'not_approved'
      const approved = status !== 'not_approved'
      return {
        kind,
        label: APPROVAL_KIND_LABEL[kind],
        status,
        tone: APPROVAL_STATUS_TONE[status],
        at: approved && event ? formatWhen(event.created_at) : null,
        evidencePath: approved && event ? event.evidence_path : null,
        actorId: event?.actor_id ?? null,
      }
    }),
    readOnlyNote: input.readOnlyNote ?? FABRIC_FINISH_READ_ONLY,
  }
}

/**
 * WHY THERE IS NO HISTORY VIEW HERE.
 *
 * Every event IS preserved — the table is append-only and its evidence bucket
 * has no UPDATE or DELETE policy — but the card states the CURRENT standing of
 * each kind and offers the proof behind it, which is what this phase's design
 * asks for. A reader who needs the whole trail has the log; building a second
 * modal for it would be a surface nobody asked for, and an exported helper with
 * no caller is how a module starts carrying code nothing tests in anger.
 *
 * The rule to keep if one is ever added: newest first, unrecognised rows
 * dropped, and a revert to Not Approved listed like any other event.
 */

// ── Who may move one ──────────────────────────────────────────────────────────

/**
 * Whether to DRAW the update control.
 *
 * THE SALESPERSON IS MATCHED BY USER ID, never by display name — two people can
 * share a name, and a rename must not hand or remove authority. The id is the
 * SIGNED-IN viewer's, never a View As target's: viewing as somebody else must
 * not lend their authority, which is the rule every other control on this page
 * already follows.
 *
 * The database asks the same question again in can_record_order_approval(),
 * from public.users.role and orders.assigned_to, so a caller who reaches the
 * RPC without the button is refused just the same.
 */
export function canRecordApproval(input: {
  /** The SIGNED-IN user's id. Null under View As, and null when unknown. */
  viewerId: string | null
  /** public.users.role for that viewer. */
  role: string | null
  /** orders.assigned_to. */
  assignedTo: string | null
  /** True while the page is under View As. */
  viewingAs: boolean
}): boolean {
  if (input.viewingAs) return false
  if (!input.viewerId) return false
  if (input.role === 'admin' || input.role === 'manager') return true
  return input.assignedTo !== null && input.assignedTo === input.viewerId
}

// ── What the dialog may submit ────────────────────────────────────────────────

export type ApprovalDraft = {
  kind: ApprovalKind
  /** The status the user picked. */
  status: ApprovalStatus
  /** The status this kind is at now. */
  current: ApprovalStatus
  /** A chosen file, or null. */
  file: { name: string; size: number; type: string } | null
}

export type DraftCheck =
  | { ok: true; changed: ApprovalDraft[] }
  | { ok: false; message: string }

/** True when this draft is a real change that needs a fresh screenshot. */
export function needsEvidence(draft: Pick<ApprovalDraft, 'status' | 'current'>): boolean {
  return draft.status !== draft.current && draft.status !== 'not_approved'
}

/** True when this draft changes anything at all. */
export function isChanged(draft: Pick<ApprovalDraft, 'status' | 'current'>): boolean {
  return draft.status !== draft.current
}

/**
 * Whether Save may be pressed, and what to say when it may not.
 *
 * THE RULES, and every one of them is restated by the RPC:
 *
 *   * at least one kind actually changed
 *   * a change INTO Partially or Fully Approved carries a screenshot
 *   * a change to Not Approved carries none, and needs none
 *   * an UNCHANGED kind is not asked for a screenshot, however it stands
 *   * if both changed into an approved state, they carry TWO DIFFERENT files.
 *     One upload cannot prove two approvals, which is why this compares the
 *     files rather than only counting them.
 *   * every file is one this bucket would actually accept
 */
export function checkApprovalDraft(drafts: readonly ApprovalDraft[]): DraftCheck {
  const changed = drafts.filter(isChanged)
  if (changed.length === 0) {
    return { ok: false, message: 'Nothing has changed yet.' }
  }

  for (const draft of changed) {
    if (!needsEvidence(draft)) continue
    if (!draft.file) return { ok: false, message: EVIDENCE_REQUIRED_MESSAGE }
    if (!EVIDENCE_MIME_TYPES.includes(draft.file.type)) {
      return { ok: false, message: EVIDENCE_BAD_TYPE_MESSAGE }
    }
    if (draft.file.size > EVIDENCE_MAX_BYTES) {
      return { ok: false, message: EVIDENCE_TOO_LARGE_MESSAGE }
    }
    if (draft.file.size <= 0) return { ok: false, message: EVIDENCE_REQUIRED_MESSAGE }
  }

  // TWO CHANGES, TWO FILES. Identical name and size is the only signal a
  // browser gives for "the same file twice", and it is enough to catch the
  // mistake; the database catches the deliberate version by refusing a path
  // that is already claimed.
  const evidenced = changed.filter(needsEvidence)
  if (evidenced.length === 2) {
    const [a, b] = evidenced
    if (a.file && b.file && a.file.name === b.file.name && a.file.size === b.file.size) {
      return { ok: false, message: EVIDENCE_SAME_FILE_MESSAGE }
    }
  }

  return { ok: true, changed }
}

/**
 * Where a screenshot goes.
 *
 * ONE ORDER, ONE KIND, ONE UNIQUE LEAF. The prefix is what the storage policy
 * authorizes on and what record_order_approval_event() checks the recorded path
 * against, so a fabric file can never be filed as finish evidence or against
 * another Order. The leaf is a fresh uuid every time: nothing is ever
 * overwritten, and there is no UPDATE policy on the bucket that would let it be.
 */
export function evidenceObjectPath(input: {
  orderId: string
  kind: ApprovalKind
  objectId: string
  fileName: string
}): string {
  const dot = input.fileName.lastIndexOf('.')
  const raw = dot > 0 ? input.fileName.slice(dot + 1).toLowerCase() : ''
  const extension = /^[a-z0-9]{1,8}$/.test(raw) ? raw : 'png'
  return `orders/${input.orderId}/${input.kind}/${input.objectId}.${extension}`
}

// ── Failures ──────────────────────────────────────────────────────────────────

const APPROVAL_FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'ORDER_APPROVAL_FORBIDDEN',
    message: FABRIC_FINISH_READ_ONLY },
  { marker: 'ORDER_APPROVAL_EVIDENCE_REQUIRED',
    message: EVIDENCE_REQUIRED_MESSAGE },
  { marker: 'ORDER_APPROVAL_EVIDENCE_REUSED',
    message: EVIDENCE_SAME_FILE_MESSAGE },
  { marker: 'ORDER_APPROVAL_EVIDENCE_MISSING',
    message: 'The screenshot did not finish uploading. Try again.' },
  { marker: 'ORDER_APPROVAL_EVIDENCE_PATH',
    message: 'That screenshot does not belong to this Order. Try again.' },
  { marker: 'ORDER_APPROVAL_UNCHANGED',
    message: 'That status is already set. Refresh to see where this Order stands.' },
  { marker: 'ORDER_APPROVAL_ORDER_CANCELLED',
    message: 'This Order is cancelled, so its approvals cannot move.' },
  { marker: 'ORDER_APPROVAL_BAD_STATUS',
    message: 'That is not a status this Order can take.' },
  { marker: 'ORDER_APPROVAL_BAD_KIND',
    message: 'That is not an approval this Order can take.' },
]

export const APPROVAL_GENERIC_FAILURE = 'That could not be saved just now.'

/**
 * One quiet sentence for a refusal, chosen by the CODE the database raised.
 *
 * The server's own message is never rendered: an unrecognised failure degrades
 * to the generic answer rather than printing a token from the wire.
 */
export function describeApprovalFailure(error: unknown): string {
  const text = typeof error === 'string'
    ? error
    : (error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '')
  const hit = APPROVAL_FAILURES.find(f => text.includes(f.marker))
  return hit ? hit.message : APPROVAL_GENERIC_FAILURE
}
