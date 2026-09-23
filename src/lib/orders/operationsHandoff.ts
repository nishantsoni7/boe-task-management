// THE PI-TO-OPERATIONS HANDOFF, AS THE ORDER PAGE STATES IT (20261229000000).
//
// One row per PI version that became the version in force on a Confirmed
// Order. The database records it inside the approval's own transaction and
// decides every authority question again under row locks; this module only
// turns the row into words, and decides whether a control is DRAWN.
//
// THE THREE STATES OF THE VERSION IN FORCE, in words first:
//   Awaiting operations review   recorded, nobody has decided
//   Accepted for production      the reviewer can work from this version
//   Clarification needed         the reviewer cannot, and said why
//
// PLUS TWO HONEST ABSENCES:
//   Not recorded     an Order approved before handoffs existed. Nothing is
//                    invented for it; the words say so.
//   Not assigned     no active operations reviewer is configured. The handoff
//                    is real and awaiting, and an administrator must act.
//
// ACCEPTANCE IS NOT COMPLETION. It says operations has reviewed and can work
// from this version; it says nothing about manufacturing.
//
// ALIGNMENT IS A DIFFERENT STATEMENT. orders.production_alignment is the Head
// of Manufacturing's feasibility answer; the handoff is the reviewer's answer
// about the document. When a later version is approved on an Order that was
// aligned against an earlier one, the page says so — it does not move the
// alignment, and it does not pretend the alignment covers the new version.

export type OperationsHandoffStatus = 'awaiting' | 'accepted' | 'clarification_needed'

/** The columns the page reads; matches the table, with the actor names embedded. */
export const ORDER_OPERATIONS_HANDOFF_COLUMNS = [
  'id', 'order_id', 'pi_version_id', 'submission_id', 'version_number',
  'approved_by', 'approved_at', 'assigned_to', 'assigned_at',
  'production_alignment_at_approval', 'prior_handoff_status', 'status',
  'accepted_by', 'accepted_at', 'accepted_note',
  'clarification_by', 'clarification_at', 'clarification_reason',
  'superseded_at', 'superseded_by_version_id', 'created_at',
].join(', ')

export type PersistedOperationsHandoff = {
  id: string
  order_id: string
  pi_version_id: string
  submission_id: string
  version_number: number
  approved_by: string | null
  approved_at: string
  assigned_to: string | null
  assigned_at: string | null
  production_alignment_at_approval: 'not_aligned' | 'aligned'
  prior_handoff_status: OperationsHandoffStatus | null
  status: OperationsHandoffStatus
  accepted_by: string | null
  accepted_at: string | null
  accepted_note: string | null
  clarification_by: string | null
  clarification_at: string | null
  clarification_reason: string | null
  superseded_at: string | null
  superseded_by_version_id: string | null
  created_at: string
}

// ── Words ────────────────────────────────────────────────────────────────────

export const OPERATIONS_REVIEW_TITLE = 'Operations review'
export const OPERATIONS_REVIEW_ANCHOR = 'operations-review'

export const OPERATIONS_HANDOFF_STATUS_LABEL: Record<OperationsHandoffStatus, string> = {
  awaiting:             'Awaiting operations review',
  accepted:             'Accepted for production',
  clarification_needed: 'Clarification needed',
}

export const OPERATIONS_HANDOFF_NOT_RECORDED_LABEL = 'Not recorded'
export const OPERATIONS_HANDOFF_NOT_RECORDED_HINT =
  'This Order was approved before operations handoffs were recorded. No acceptance is claimed for it.'
export const OPERATIONS_HANDOFF_UNASSIGNED_LABEL = 'No operations reviewer assigned'
export const OPERATIONS_HANDOFF_UNASSIGNED_HINT =
  'An administrator must assign the operations reviewer in Control Center before this version can be accepted.'
export const OPERATIONS_HANDOFF_UNASSIGNED_HREF = '/admin/control-center?tab=operations-handoff'

export const ACCEPT_FOR_PRODUCTION_LABEL = 'Accept for production'
export const CANNOT_ACCEPT_LABEL = 'Cannot accept'
export const ACCEPT_DIALOG_TITLE = 'Accept this PI version for production'
export const CANNOT_ACCEPT_DIALOG_TITLE = 'Cannot accept this PI version'
export const ACCEPT_CONFIRM =
  'This records that operations has reviewed this exact PI version and can work from it. It does not say any manufacturing work is done, and it does not change production alignment.'
export const CANNOT_ACCEPT_CONFIRM =
  'This flags the version for clarification and tells the approver why. The Order is not changed. Once the question is settled you can accept this same version, or a revised PI will bring a new one.'
export const ACCEPT_NOTE_LABEL = 'Note (optional)'
export const CANNOT_ACCEPT_REASON_LABEL = 'What needs clarifying'
export const CANNOT_ACCEPT_REASON_PLACEHOLDER = 'Say what stops operations from working from this version'
export const OPERATIONS_HANDOFF_REASON_MAX_LENGTH = 1000
export const OPERATIONS_HANDOFF_REASON_REQUIRED = 'Say what needs clarifying before this version can be accepted.'
export const OPERATIONS_HANDOFF_REASON_TOO_LONG = `The reason may be at most ${OPERATIONS_HANDOFF_REASON_MAX_LENGTH} characters.`

/** The card's read-only line for a reader who cannot decide. */
export const OPERATIONS_REVIEW_READ_ONLY_NOTE =
  'Only the assigned operations reviewer can accept a version or flag it for clarification.'

export const ALIGNMENT_PREDATES_VERSION_WARNING = (version: number, alignedOn: number | null) =>
  alignedOn
    ? `Production was aligned against PI V${alignedOn}. PI V${version} has not been reviewed by operations yet.`
    : `Production was aligned before PI V${version} was approved. PI V${version} has not been reviewed by operations yet.`

// ── The view ─────────────────────────────────────────────────────────────────

export type OperationsHandoffTone = 'green' | 'amber' | 'red' | 'neutral'

export type OperationsHandoffDecisionLine = {
  label: string
  by: string | null
  at: string | null
  note: string | null
}

export type OperationsHandoffView =
  | {
      kind: 'not_recorded'
      label: string
      hint: string
      tone: 'neutral'
    }
  | {
      kind: 'recorded'
      handoffId: string
      versionNumber: number
      versionLabel: string
      status: OperationsHandoffStatus
      statusLabel: string
      tone: OperationsHandoffTone
      /** "Approved by X · when" */
      approvedLine: string
      /** The reviewer's name, or null when unassigned. */
      reviewerName: string | null
      reviewerLine: string
      unassigned: boolean
      /** The decision, when there is one. */
      decision: OperationsHandoffDecisionLine | null
      /** Set when the previous version had been accepted and this one has not. */
      priorAcceptedNotice: string | null
      /** Set when the Order was aligned for production before this version. */
      alignmentWarning: string | null
      /** Which control, if any, this reader is offered. */
      actions: { accept: boolean; cannotAccept: boolean }
      /** Why no control is offered, for a reader who cannot decide. */
      readOnlyNote: string | null
    }

export const OPERATIONS_HANDOFF_TONE: Record<OperationsHandoffStatus, OperationsHandoffTone> = {
  awaiting: 'amber',
  accepted: 'green',
  clarification_needed: 'red',
}

export function versionLabel(n: number): string {
  return `PI V${n}`
}

/**
 * The live handoff — the one for the version in force — and the superseded
 * ones behind it, newest first. Rows are taken as the database returns them
 * (any order); the split is by superseded_at, which the database sets in the
 * same transaction that approves the next version.
 */
export function splitOperationsHandoffs(rows: readonly PersistedOperationsHandoff[]): {
  live: PersistedOperationsHandoff | null
  history: PersistedOperationsHandoff[]
} {
  const sorted = [...rows].sort((a, b) => b.version_number - a.version_number)
  const live = sorted.find(r => r.superseded_at === null) ?? null
  const history = sorted.filter(r => r.superseded_at !== null)
  return { live, history }
}

/**
 * Whether this reader may DECIDE the live handoff. Drawn only; the database
 * re-derives the whole rule under a lock. Never under View As, and never for
 * an admin who is not the assigned reviewer — being an admin is not being
 * operations.
 */
export function canDecideOperationsHandoff(input: {
  viewerId: string | null
  viewingAs: boolean
  handoff: PersistedOperationsHandoff | null
  orderStatus: string
}): boolean {
  const { viewerId, viewingAs, handoff, orderStatus } = input
  if (viewingAs || !viewerId || !handoff) return false
  if (handoff.superseded_at !== null) return false
  if (handoff.assigned_to === null || handoff.assigned_to !== viewerId) return false
  if (orderStatus === 'cancelled') return false
  return handoff.status !== 'accepted'
}

export function describeOperationsHandoff(input: {
  live: PersistedOperationsHandoff | null
  /** The Order came from a PI, so a handoff could have been recorded. */
  hasSourcePi: boolean
  namesById: ReadonlyMap<string, string>
  formatWhen: (iso: string | null) => string
  viewerId: string | null
  viewingAs: boolean
  orderStatus: string
  /** The Order's current alignment and when it was set. */
  productionAligned: boolean
  productionAlignedAt: string | null
}): OperationsHandoffView {
  const { live, namesById, formatWhen } = input
  if (!live) {
    return {
      kind: 'not_recorded',
      label: OPERATIONS_HANDOFF_NOT_RECORDED_LABEL,
      hint: input.hasSourcePi
        ? OPERATIONS_HANDOFF_NOT_RECORDED_HINT
        : 'This Order did not come from a PI, so there is no PI version to hand over.',
      tone: 'neutral',
    }
  }

  const name = (id: string | null) => (id ? namesById.get(id) ?? null : null)
  const approverName = name(live.approved_by)
  const reviewerName = name(live.assigned_to)
  const unassigned = live.assigned_to === null

  const decision: OperationsHandoffDecisionLine | null =
    live.status === 'accepted'
      ? {
          label: OPERATIONS_HANDOFF_STATUS_LABEL.accepted,
          by: name(live.accepted_by),
          at: live.accepted_at ? formatWhen(live.accepted_at) : null,
          note: live.accepted_note,
        }
      : live.status === 'clarification_needed'
        ? {
            label: OPERATIONS_HANDOFF_STATUS_LABEL.clarification_needed,
            by: name(live.clarification_by),
            at: live.clarification_at ? formatWhen(live.clarification_at) : null,
            note: live.clarification_reason,
          }
        : null

  const priorAcceptedNotice =
    live.prior_handoff_status === 'accepted' && live.status !== 'accepted'
      ? `An earlier version was accepted for production. ${versionLabel(live.version_number)} has not been.`
      : null

  // The alignment predates this version when it was set before the version
  // was approved. The handoff also records what alignment said at approval,
  // which is the same question asked of the row rather than of two clocks;
  // either signal alone is enough to warn.
  const alignedBefore =
    input.productionAligned && (
      live.production_alignment_at_approval === 'aligned' ||
      (input.productionAlignedAt !== null && input.productionAlignedAt < live.approved_at)
    )
  const alignmentWarning =
    alignedBefore && live.status !== 'accepted'
      ? ALIGNMENT_PREDATES_VERSION_WARNING(live.version_number, null)
      : null

  const mayDecide = canDecideOperationsHandoff({
    viewerId: input.viewerId,
    viewingAs: input.viewingAs,
    handoff: live,
    orderStatus: input.orderStatus,
  })

  return {
    kind: 'recorded',
    handoffId: live.id,
    versionNumber: live.version_number,
    versionLabel: versionLabel(live.version_number),
    status: live.status,
    statusLabel: OPERATIONS_HANDOFF_STATUS_LABEL[live.status],
    tone: OPERATIONS_HANDOFF_TONE[live.status],
    approvedLine: `Approved by ${approverName ?? 'an administrator'} · ${formatWhen(live.approved_at)}`,
    reviewerName,
    reviewerLine: unassigned
      ? OPERATIONS_HANDOFF_UNASSIGNED_LABEL
      : `Operations reviewer: ${reviewerName ?? 'assigned'}`,
    unassigned,
    decision,
    priorAcceptedNotice,
    alignmentWarning,
    actions: {
      accept: mayDecide,
      cannotAccept: mayDecide && live.status === 'awaiting',
    },
    readOnlyNote: mayDecide
      ? null
      : unassigned
        ? OPERATIONS_HANDOFF_UNASSIGNED_HINT
        : live.status === 'accepted' || input.orderStatus === 'cancelled'
          ? null
          : OPERATIONS_REVIEW_READ_ONLY_NOTE,
  }
}

/** One line per superseded handoff, for the history disclosure. */
export function describeOperationsHandoffHistory(input: {
  history: readonly PersistedOperationsHandoff[]
  namesById: ReadonlyMap<string, string>
  formatWhen: (iso: string | null) => string
}): { key: string; versionLabel: string; statusLabel: string; tone: OperationsHandoffTone; line: string; note: string | null }[] {
  const name = (id: string | null) => (id ? input.namesById.get(id) ?? null : null)
  return input.history.map(h => {
    const status = OPERATIONS_HANDOFF_STATUS_LABEL[h.status]
    const who = h.status === 'accepted' ? name(h.accepted_by) : h.status === 'clarification_needed' ? name(h.clarification_by) : null
    const when = h.status === 'accepted' ? h.accepted_at : h.status === 'clarification_needed' ? h.clarification_at : null
    const line = h.status === 'awaiting'
      ? `Superseded ${input.formatWhen(h.superseded_at)} without a decision`
      : `${who ?? 'Operations'} · ${input.formatWhen(when)} · superseded ${input.formatWhen(h.superseded_at)}`
    return {
      key: h.id,
      versionLabel: versionLabel(h.version_number),
      statusLabel: h.status === 'awaiting' ? 'Not decided' : status,
      tone: h.status === 'awaiting' ? 'neutral' : OPERATIONS_HANDOFF_TONE[h.status],
      line,
      note: h.status === 'accepted' ? h.accepted_note : h.status === 'clarification_needed' ? h.clarification_reason : null,
    }
  })
}

// ── The decision form ────────────────────────────────────────────────────────

export type DecisionCheck =
  | { ok: true; reason: string | null }
  | { ok: false; message: string }

export function validateHandoffDecision(decision: OperationsHandoffStatus, raw: string): DecisionCheck {
  const reason = raw.trim() === '' ? null : raw.trim()
  if (reason !== null && reason.length > OPERATIONS_HANDOFF_REASON_MAX_LENGTH) {
    return { ok: false, message: OPERATIONS_HANDOFF_REASON_TOO_LONG }
  }
  if (decision === 'clarification_needed' && reason === null) {
    return { ok: false, message: OPERATIONS_HANDOFF_REASON_REQUIRED }
  }
  return { ok: true, reason }
}

/** The database's refusal markers, said in a sentence. */
export function describeHandoffFailure(error: { message?: string | null } | null | undefined): string {
  const m = error?.message ?? ''
  if (m.includes('ORDER_OPERATIONS_HANDOFF_STALE') || m.includes('ORDER_OPERATIONS_HANDOFF_SUPERSEDED')) {
    return 'A newer PI version has been approved since this page loaded. Refresh to review the current one.'
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED')) {
    return 'This version was already accepted for production.'
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED')) {
    return 'This version is already flagged for clarification.'
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_UNASSIGNED')) {
    return OPERATIONS_HANDOFF_UNASSIGNED_HINT
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_CLOSED')) {
    return 'This Order is cancelled; there is nothing to accept.'
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED')) {
    return OPERATIONS_HANDOFF_REASON_REQUIRED
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG')) {
    return OPERATIONS_HANDOFF_REASON_TOO_LONG
  }
  if (m.includes('ORDER_OPERATIONS_HANDOFF_NOT_FOUND')) {
    return 'That handoff no longer exists. Refresh the page.'
  }
  if (m.includes('Only the assigned operations reviewer') || m.includes('permission') || m.includes('42501')) {
    return 'Only the assigned operations reviewer can decide this. Being an administrator does not count.'
  }
  return m || 'The decision could not be recorded.'
}

// ── Control Center: the reviewer assignment ──────────────────────────────────

export const OPERATIONS_REVIEWER_SECTION_TITLE = 'Who reviews approved PI versions for production'
export const OPERATIONS_REVIEWER_SECTION_DESCRIPTION =
  'One person. Every time a PI becomes a Confirmed Order, or a revised PI is approved, they are notified and asked to accept that exact version for production or say what needs clarifying. Their acceptance is their own: an administrator is never counted in their place.'
export const OPERATIONS_REVIEWER_NOBODY = 'Nobody is assigned'
export const OPERATIONS_REVIEWER_NOBODY_HINT =
  'New handoffs are recorded and shown as unassigned until someone is chosen here. Choosing someone also assigns every handoff that is still waiting.'
export const OPERATIONS_REVIEWER_SAVE_LABEL = 'Save reviewer'
export const OPERATIONS_REVIEWER_CLEAR_OPTION = 'No reviewer (leave handoffs unassigned)'

/** Who may be chosen: active, not deleted. The RPC re-checks, and also that they can open Orders. */
export function eligibleOperationsReviewers<T extends { id: string; full_name: string; is_active?: boolean | null; is_deleted?: boolean | null }>(
  members: readonly T[],
): T[] {
  return members
    .filter(m => m.is_active !== false && m.is_deleted !== true)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
}

export function describeReviewerAssignmentFailure(error: { message?: string | null } | null | undefined): string {
  const m = error?.message ?? ''
  if (m.includes('ORDER_OPERATIONS_REVIEWER_INACTIVE')) return 'That account is not active. Choose an active person.'
  if (m.includes('ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS')) return 'That person cannot open Orders. Give them Orders access first, or choose someone who has it.'
  if (m.includes('ORDER_OPERATIONS_REVIEWER_NOT_FOUND')) return 'That person has no user record.'
  if (m.includes('Only an administrator')) return 'Only an administrator can assign the operations reviewer.'
  return m || 'The reviewer could not be saved.'
}

export function describeReviewerSaved(input: { name: string | null; reassigned: number }): string {
  if (!input.name) return 'No operations reviewer is assigned. New handoffs will wait unassigned until one is chosen.'
  const tail = input.reassigned > 0
    ? ` ${input.reassigned} waiting handoff${input.reassigned === 1 ? '' : 's'} reassigned to them, and they have been notified.`
    : ''
  return `${input.name} is now the operations reviewer.${tail}`
}

// ── The Orders dashboard and the Action Queue ────────────────────────────────

export const AWAITING_OPERATIONS_REVIEW_LABEL = 'Operations Review'
export const AWAITING_OPERATIONS_REVIEW_SUB = 'PI versions awaiting your acceptance'
export const AWAITING_OPERATIONS_REVIEW_SUB_ADMIN = 'PI versions awaiting operations'
/** The Confirmed Orders list, filtered to Orders whose version in force awaits operations. */
export const OPERATIONS_REVIEW_QUEUE_HREF = '/orders/all?ops=awaiting'
export const OPERATIONS_REVIEW_QUEUE_BANNER = 'Showing Orders whose current PI version is awaiting operations review'

/** The Order-history words for the four events the migration writes. */
export const OPERATIONS_HANDOFF_EVENT_LABEL: Record<string, string> = {
  operations_handoff_recorded:             'Sent to operations for review',
  operations_reviewer_assigned:            'Operations reviewer assigned',
  operations_handoff_accepted:             'Accepted for production by operations',
  operations_handoff_clarification_needed: 'Operations cannot accept: clarification needed',
}

export const OPERATIONS_HANDOFF_EVENT_TONE: Record<string, OperationsHandoffTone> = {
  operations_handoff_recorded:             'amber',
  operations_reviewer_assigned:            'neutral',
  operations_handoff_accepted:             'green',
  operations_handoff_clarification_needed: 'red',
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** One sentence of detail for each of the four events, from its payload. */
export function describeOperationsHandoffEvent(eventType: string, payload: Record<string, unknown> | null | undefined): string | null {
  const p = payload ?? {}
  const v = typeof p.version_number === 'number' ? versionLabel(p.version_number) : null
  switch (eventType) {
    case 'operations_handoff_recorded': {
      const parts = [v]
      if (p.assigned_to === null || p.assigned_to === undefined) parts.push('no operations reviewer assigned')
      if (p.superseded_handoff_status === 'accepted' && typeof p.superseded_version_number === 'number') {
        parts.push(`replaces accepted ${versionLabel(p.superseded_version_number)}`)
      }
      if (p.production_alignment === 'aligned') parts.push('Order was already aligned for production')
      return parts.filter(Boolean).join(' · ') || null
    }
    case 'operations_reviewer_assigned':
      return v
    case 'operations_handoff_accepted':
      return [v, p.after_clarification === true ? 'after clarification' : null, text(p.note)].filter(Boolean).join(' · ') || null
    case 'operations_handoff_clarification_needed':
      return [v, text(p.reason)].filter(Boolean).join(' · ') || null
    default:
      return null
  }
}
