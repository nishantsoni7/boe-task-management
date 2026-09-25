// THE PI-TO-OPERATIONS HANDOFF, AS THE ORDER PAGE STATES IT (20261229000000).
//
// One row per PI version that became the version in force on a Confirmed
// Order. The database records it inside the approval's own transaction and
// decides every authority question again under row locks; this module only
// turns the row into words, and decides whether a control is DRAWN.
//
// ONE OPERATIONS DECISION, AND WHAT THE TWO WORDS MEAN
// ----------------------------------------------------
// ACCEPTANCE is the operations reviewer's decision about ONE PI version:
// "operations has reviewed this exact version and can work from it". It says
// nothing about manufacturing progress.
//
// ALIGNMENT (orders.production_alignment) is what the Order carries as a
// result. For an Order with a handoff, accepting the version in force ALIGNS
// the Order, withdrawing or flagging takes the alignment back, and approving a
// later version RESETS it (the alignment covered the earlier version). So the
// Order is aligned exactly when its current version is accepted, and the old
// "Align for Production" control is the same door: the page draws ONE set of
// controls, on the Operations review card, for the assigned reviewer only.
//
// A LEGACY Order (approved before handoffs were recorded, never revised since)
// has no handoff: it reads "Not recorded", its alignment is whatever it was,
// and the old control and the old permission still apply to it.
//
// THE STATES OF THE VERSION IN FORCE, in words first:
//   Awaiting operations review   recorded, nobody has decided
//   Accepted for production      the reviewer can work from it; the Order is aligned
//   Clarification needed         the reviewer cannot, and said why; not aligned
//                                (after an acceptance, this is a WITHDRAWAL, and the
//                                acceptance stays on record)
// PLUS TWO HONEST ABSENCES:
//   Not recorded     an Order approved before handoffs existed. Nothing is
//                    invented for it; the words say so.
//   Not assigned     no active operations reviewer is configured. The handoff
//                    is real and awaiting, and an administrator must act.

import { describeAdvanceRefusal } from './advanceReadiness'

export type OperationsHandoffStatus = 'awaiting' | 'accepted' | 'clarification_needed'

/**
 * WHY a handoff has nobody to review it. All three need an administrator:
 * nobody is configured; the configured person is no longer active; or the
 * configured person cannot open this particular Order (their access changed
 * after they were assigned). The database records the reason at creation and
 * on every reassignment; the page and the queues say it in words.
 */
export type UnassignedReason = 'no_reviewer' | 'reviewer_inactive' | 'reviewer_cannot_open_order'

export const UNASSIGNED_REASON_LABEL: Record<UnassignedReason, string> = {
  no_reviewer:                'No operations reviewer assigned',
  reviewer_inactive:          'Operations reviewer is no longer active',
  reviewer_cannot_open_order: 'Operations reviewer cannot open this Order',
}

export const UNASSIGNED_REASON_HINT: Record<UnassignedReason, string> = {
  no_reviewer:
    'An administrator must assign the operations reviewer in Control Center before this version can be accepted.',
  reviewer_inactive:
    'The configured operations reviewer is no longer an active account. An administrator must assign someone else in Control Center.',
  reviewer_cannot_open_order:
    'The configured operations reviewer cannot open this Order. An administrator must assign someone who can open every Order: an admin, a member of the operations team, or a holder of orders.view_all.',
}

/** The columns the page reads; matches the table. */
export const ORDER_OPERATIONS_HANDOFF_COLUMNS = [
  'id', 'order_id', 'pi_version_id', 'submission_id', 'version_number',
  'approved_by', 'approved_at', 'assigned_to', 'assigned_at', 'unassigned_reason',
  'production_alignment_at_approval', 'prior_handoff_status', 'status',
  'accepted_by', 'accepted_at', 'accepted_note',
  'acceptance_withdrawn_by', 'acceptance_withdrawn_at', 'acceptance_withdrawn_reason',
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
  unassigned_reason: UnassignedReason | null
  production_alignment_at_approval: 'not_aligned' | 'aligned'
  prior_handoff_status: OperationsHandoffStatus | null
  status: OperationsHandoffStatus
  accepted_by: string | null
  accepted_at: string | null
  accepted_note: string | null
  acceptance_withdrawn_by: string | null
  acceptance_withdrawn_at: string | null
  acceptance_withdrawn_reason: string | null
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
  'This Order was approved before operations handoffs were recorded. No acceptance is claimed for it, and its production alignment is set the old way, from the header.'
export const OPERATIONS_HANDOFF_UNASSIGNED_LABEL = 'No operations reviewer assigned'
export const OPERATIONS_HANDOFF_UNASSIGNED_HINT =
  'An administrator must assign the operations reviewer in Control Center before this version can be accepted.'
export const OPERATIONS_HANDOFF_UNASSIGNED_HREF = '/admin/control-center?tab=operations-handoff'

export const ACCEPT_FOR_PRODUCTION_LABEL = 'Accept for production'
export const CANNOT_ACCEPT_LABEL = 'Cannot accept'
export const WITHDRAW_ACCEPTANCE_LABEL = 'Withdraw acceptance'
export const ACCEPT_DIALOG_TITLE = 'Accept this PI version for production'
export const CANNOT_ACCEPT_DIALOG_TITLE = 'Cannot accept this PI version'
export const WITHDRAW_DIALOG_TITLE = 'Withdraw the acceptance of this PI version'
export const ACCEPT_CONFIRM =
  'This records that operations has reviewed this exact PI version and can work from it, and it aligns the Order for production against this version. It does not say any manufacturing work is done.'
export const CANNOT_ACCEPT_CONFIRM =
  'This flags the version for clarification and tells the approver why. The Order stays not aligned for production. Once the question is settled you can accept this same version, or a revised PI will bring a new one.'
export const WITHDRAW_CONFIRM =
  'This takes back the acceptance of this version and the production alignment that came with it, and tells the approver why. The acceptance stays on record with its date. Nothing is said about work already done.'
export const ACCEPT_NOTE_LABEL = 'Note (optional)'
export const CANNOT_ACCEPT_REASON_LABEL = 'What needs clarifying'
export const CANNOT_ACCEPT_REASON_PLACEHOLDER = 'Say what stops operations from working from this version'
export const OPERATIONS_HANDOFF_REASON_MAX_LENGTH = 1000
export const OPERATIONS_HANDOFF_REASON_REQUIRED = 'Say what needs clarifying before this version can be accepted.'
export const OPERATIONS_HANDOFF_REASON_TOO_LONG = `The reason may be at most ${OPERATIONS_HANDOFF_REASON_MAX_LENGTH} characters.`

// ── Aligning a HELD Order again (20270104000000, review R1) ──
//
// An accepted version whose Order fell below the 40% advance is aligned again
// by whoever is the operations reviewer NOW, after checking it; the acceptance
// on record is untouched and the re-alignment is its own event. When no
// reviewer can act, an administrator may recover the alignment with a reason.
export const REALIGN_DIALOG_TITLE = 'Align production again'
export const REALIGN_CONFIRM =
  "This puts the Order back in production against the PI version operations already accepted. That acceptance stays on record as it was; this re-alignment is recorded under your name, now. Check the Order's value, the PI in force and the verified payment first."
export const REALIGN_CHECK_LABEL = 'I have checked this Order and it can go back into production'
export const REALIGN_CHECK_REQUIRED = 'Confirm that you have checked the Order.'
export const RECOVER_ALIGNMENT_LABEL = 'Recover production alignment…'
export const RECOVER_DIALOG_TITLE = 'Recover the production alignment'
export const RECOVER_CONFIRM =
  'No operations reviewer can align this Order again. As an administrator you can put it back in production against the PI version operations accepted, with a reason. The acceptance stays on record; this recovery is recorded under your name, with the reason. The 40% advance still applies.'
export const RECOVER_REASON_LABEL = 'Why production is aligned again without an operations reviewer'
export const RECOVER_SAVE_LABEL = 'Align production (administrator recovery)'
export const RECOVER_REASON_MIN_LENGTH = 10

/** The recovery reason: 10–1000 characters, trimmed. The database checks the same. */
export function validateRecoveryReason(raw: string): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = raw.trim()
  if (reason.length < RECOVER_REASON_MIN_LENGTH) {
    return { ok: false, message: `Say why, in at least ${RECOVER_REASON_MIN_LENGTH} characters.` }
  }
  if (reason.length > OPERATIONS_HANDOFF_REASON_MAX_LENGTH) return { ok: false, message: OPERATIONS_HANDOFF_REASON_TOO_LONG }
  return { ok: true, reason }
}

/** The card's read-only line for a reader who cannot decide. */
export const OPERATIONS_REVIEW_READ_ONLY_NOTE =
  'Only the assigned operations reviewer can accept a version or flag it for clarification. Being an administrator does not count.'

/** What the two words mean, said once on the card. */
export const ACCEPTANCE_MEANING =
  'Accepting says operations has reviewed this exact PI version and can work from it, and it aligns the Order for production against this version. It does not say any manufacturing work is done.'

/** A revised workbook: what the card can and cannot show. */
export const REVISION_COMPARE_NOTE =
  'A field-by-field comparison of the two workbooks is not available yet. Open the current PI and the previous one to compare them.'
export const OPEN_CURRENT_PI_LABEL = (version: number) => `Open current PI (V${version})`
export const OPEN_PREVIOUS_PI_LABEL = (version: number) => `Open previous PI (V${version})`

export const ALIGNMENT_PREDATES_VERSION_WARNING = (version: number) =>
  `Production was aligned before PI V${version} was approved. That alignment has been reset; it does not cover PI V${version}, which has not been reviewed by operations yet.`

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
      /** Why nobody is assigned, and what an administrator must do. Null when assigned. */
      unassignedReason: UnassignedReason | null
      unassignedHint: string | null
      /** The decision, when there is one. */
      decision: OperationsHandoffDecisionLine | null
      /** A withdrawn acceptance: what had been accepted, kept on record. */
      withdrawn: { acceptedBy: string | null; acceptedAt: string | null; by: string | null; at: string | null; reason: string | null } | null
      /** The revised workbook's reason, for V2+; null for V1. */
      revisionReason: string | null
      /** Set when the previous version had been accepted and this one has not. */
      priorAcceptedNotice: string | null
      /** Set when the Order was aligned for production before this version. */
      alignmentWarning: string | null
      /** What the Order's alignment says as a result of this handoff. */
      alignment: { label: string; line: string | null; aligned: boolean; held: boolean }
      /** Which control, if any, this reader is offered. */
      actions: { accept: boolean; cannotAccept: boolean; withdraw: boolean }
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
 * operations. An accepted version can still be decided: withdrawn.
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
  return true
}

/**
 * The latest re-alignment of a held Order (20270104000000), from the Order's
 * history: by the operations reviewer (operations_handoff_realigned) or by an
 * administrator's recovery (operations_handoff_realigned_by_admin).
 */
export type HandoffRealignment = { kind: 'operations' | 'admin'; byName: string | null; at: string }

/** The newest re-alignment event among the Order's history rows, or null. */
export function latestRealignment(
  rows: readonly { event_type: string; actor_name?: string | null; created_at: string; payload?: Record<string, unknown> | null }[],
  versionId: string | null,
): HandoffRealignment | null {
  let best: HandoffRealignment | null = null
  for (const r of rows) {
    const kind = r.event_type === 'operations_handoff_realigned' ? 'operations'
      : r.event_type === 'operations_handoff_realigned_by_admin' ? 'admin' : null
    if (!kind) continue
    if (versionId && r.payload && typeof r.payload.version_id === 'string' && r.payload.version_id !== versionId) continue
    if (!best || r.created_at > best.at) best = { kind, byName: r.actor_name ?? null, at: r.created_at }
  }
  return best
}

/** The alignment the Order carries, as a consequence of this handoff. */
export function describeHandoffAlignment(input: {
  live: PersistedOperationsHandoff
  reviewerName: string | null
  formatWhen: (iso: string | null) => string
  /**
   * The latest re-alignment after a production hold (review W1). When the
   * Order is aligned again, the line says who put it back and when, and keeps
   * the acceptance it stands on beside it: the acceptance alone would name the
   * wrong person and the wrong time.
   */
  realignment?: HandoffRealignment | null
  /**
   * The Order's own alignment. An ACCEPTED version whose Order is not aligned
   * was put on hold (its advance fell below 40%, 20270104000000): the
   * acceptance stands, the alignment does not.
   */
  productionAligned?: boolean
  /**
   * The held Order's advance is covered again (verified money back at 40%, or
   * an approval covers it) and it only awaits being aligned again (review N1).
   * The line must then not claim the advance is still below 40%.
   */
  holdCovered?: boolean
}): { label: string; line: string | null; aligned: boolean; held: boolean } {
  const { live } = input
  const accepted = `Accepted by ${input.reviewerName ?? 'operations'} · ${input.formatWhen(live.accepted_at)}`
  const r = input.realignment
  const realigned = !!r && (!live.accepted_at || r.at > live.accepted_at)
  const realignedBy = realigned && r
    ? `${r.kind === 'admin' ? 'recovered by' : 'aligned again by'} ${r.byName ?? (r.kind === 'admin' ? 'an administrator' : 'operations')} · ${input.formatWhen(r.at)}`
    : null
  if (live.status === 'accepted' && input.productionAligned === false) {
    // HELD. The acceptance it stands on, and the last re-alignment if there was
    // one, stay visible; then what the hold is waiting for now.
    return {
      aligned: false,
      held: true,
      label: 'Not Aligned',
      line: `${versionLabel(live.version_number)} ${accepted.charAt(0).toLowerCase()}${accepted.slice(1)}`
        + (realignedBy ? ` · last ${realignedBy}` : '')
        + (input.holdCovered
          ? '; production on hold — awaiting production realignment'
          : '; production on hold — advance below 40%'),
    }
  }
  if (live.status === 'accepted') {
    return {
      aligned: true,
      held: false,
      label: `Aligned · ${versionLabel(live.version_number)}`,
      line: realignedBy
        ? `${realignedBy.charAt(0).toUpperCase()}${realignedBy.slice(1)} · ${versionLabel(live.version_number)} ${accepted.charAt(0).toLowerCase()}${accepted.slice(1)}`
        : accepted,
    }
  }
  return {
    aligned: false,
    held: false,
    label: 'Not Aligned',
    line: live.status === 'clarification_needed'
      ? `${versionLabel(live.version_number)} flagged for clarification`
      : `Awaiting operations acceptance of ${versionLabel(live.version_number)}`,
  }
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
  /** The live version's revision reason (order_pi_versions.revision_reason), for V2+. */
  revisionReason?: string | null
  /** The latest re-alignment after a hold (latestRealignment), for the alignment line. */
  realignment?: HandoffRealignment | null
  /** A held Order whose advance is covered again (advanceHoldCovered), for the held line. */
  holdCovered?: boolean
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

  const withdrawn = live.acceptance_withdrawn_at
    ? {
        acceptedBy: name(live.accepted_by),
        acceptedAt: live.accepted_at ? formatWhen(live.accepted_at) : null,
        by: name(live.acceptance_withdrawn_by),
        at: formatWhen(live.acceptance_withdrawn_at),
        reason: live.acceptance_withdrawn_reason,
      }
    : null

  const priorAcceptedNotice =
    live.prior_handoff_status === 'accepted' && live.status !== 'accepted'
      ? `An earlier version was accepted for production. ${versionLabel(live.version_number)} has not been.`
      : null

  // The handoff records what alignment said when this version was approved:
  // 'aligned' means the Order was in production against an earlier version,
  // and the database reset it. Warn until this version is accepted.
  const alignmentWarning =
    live.production_alignment_at_approval === 'aligned' && live.status !== 'accepted'
      ? ALIGNMENT_PREDATES_VERSION_WARNING(live.version_number)
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
      ? UNASSIGNED_REASON_LABEL[live.unassigned_reason ?? 'no_reviewer']
      : `Operations reviewer: ${reviewerName ?? 'assigned'}`,
    unassigned,
    unassignedReason: unassigned ? (live.unassigned_reason ?? 'no_reviewer') : null,
    unassignedHint: unassigned ? UNASSIGNED_REASON_HINT[live.unassigned_reason ?? 'no_reviewer'] : null,
    decision,
    withdrawn,
    revisionReason: live.version_number > 1 ? (input.revisionReason?.trim() || null) : null,
    priorAcceptedNotice,
    alignmentWarning,
    alignment: describeHandoffAlignment({ live, reviewerName: name(live.accepted_by), formatWhen, productionAligned: input.productionAligned, realignment: input.realignment ?? null, holdCovered: input.holdCovered ?? false }),
    actions: {
      accept: mayDecide && live.status !== 'accepted',
      cannotAccept: mayDecide && live.status === 'awaiting',
      withdraw: mayDecide && live.status === 'accepted',
    },
    readOnlyNote: mayDecide
      ? null
      : unassigned
        ? UNASSIGNED_REASON_HINT[live.unassigned_reason ?? 'no_reviewer']
        : input.orderStatus === 'cancelled'
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
      statusLabel: h.status === 'awaiting' ? 'Not decided' : h.acceptance_withdrawn_at ? `${status} (acceptance withdrawn)` : status,
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
  // Accepting would align production below the 40% advance (20270104000000):
  // the database's own sentence carries the percentage and the shortfall.
  const advance = describeAdvanceRefusal(m)
  if (advance) return advance
  if (m.includes('ORDER_REALIGN_NOT_CURRENT_REVIEWER')) {
    return 'Only the current operations reviewer can align production again.'
  }
  if (m.includes('ORDER_REALIGN_NO_REVIEWER')) {
    return 'No operations reviewer is assigned. An administrator can assign one in Control Center, or recover the alignment with a reason.'
  }
  if (m.includes('ORDER_REALIGN_NOT_HELD')) {
    return 'This Order is not on a production hold any more. Refresh the page.'
  }
  if (m.includes('ORDER_REALIGN_REVIEWER_AVAILABLE')) {
    return "An operations reviewer can align this Order again, so an administrator's recovery is not available. Ask them."
  }
  if (m.includes('ORDER_REALIGN_NOT_ACCEPTED')) {
    return 'The PI version in force has not been accepted by operations; it needs their review, not a recovery.'
  }
  if (m.includes('ORDER_REALIGN_RECOVERY_REASON_REQUIRED')) {
    return `Say why, in at least ${RECOVER_REASON_MIN_LENGTH} characters.`
  }
  if (m.includes('ORDER_REALIGN_RECOVERY_REASON_TOO_LONG')) {
    return OPERATIONS_HANDOFF_REASON_TOO_LONG
  }
  if (m.includes('Only an administrator can recover')) {
    return 'Only an active administrator can recover a production alignment.'
  }
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
  if (m.includes('not active')) {
    return 'Your account is not active.'
  }
  if (m.includes('do not have access to this Order')) {
    return 'You no longer have access to this Order.'
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
/** Who can be chosen, in words — the same rule set_order_operations_reviewer() enforces. */
export const OPERATIONS_REVIEWER_ELIGIBILITY =
  'The reviewer must be able to open every Confirmed Order: an admin, a member of the Operations department, or somebody holding "View all Orders" — with Orders access and an active account. Orders access alone is not enough. If the reviewer later loses that access, new PI versions they cannot open are left unassigned and the administrators are told.'
export const OPERATIONS_REVIEWER_NOBODY = 'Nobody is assigned'
export const OPERATIONS_REVIEWER_NOBODY_HINT =
  'New handoffs are recorded and shown as unassigned until someone is chosen here. Choosing someone also takes over every handoff that is still waiting or flagged; clearing the choice leaves every one of them visibly unassigned.'
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
  if (m.includes('ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS')) return 'That person cannot open every Order. Choose an admin, a member of the Operations department, or somebody holding "View all Orders".'
  if (m.includes('ORDER_OPERATIONS_REVIEWER_NOT_FOUND')) return 'That person has no user record.'
  if (m.includes('Only an administrator')) return 'Only an administrator can assign the operations reviewer.'
  return m || 'The reviewer could not be saved.'
}

export function describeReviewerSaved(input: { name: string | null; reassigned: number; unassigned?: number }): string {
  if (!input.name) {
    const n = input.unassigned ?? 0
    return n > 0
      ? `No operations reviewer is assigned. ${n} waiting or flagged handoff${n === 1 ? '' : 's'} now show${n === 1 ? 's' : ''} as unassigned until someone is chosen.`
      : 'No operations reviewer is assigned. New handoffs will wait unassigned until one is chosen.'
  }
  const tail = input.reassigned > 0
    ? ` ${input.reassigned} waiting or flagged handoff${input.reassigned === 1 ? '' : 's'} reassigned to them, and they have been notified.`
    : ''
  return `${input.name} is now the operations reviewer.${tail}`
}

// ── The Orders dashboard and the Action Queue ────────────────────────────────

export const AWAITING_OPERATIONS_REVIEW_LABEL = 'Operations Review'
export const AWAITING_OPERATIONS_REVIEW_SUB = 'PI versions awaiting your acceptance'
export const AWAITING_OPERATIONS_REVIEW_SUB_ADMIN = 'PI versions awaiting operations'
/** The Confirmed Orders list, filtered to Orders whose version in force awaits operations. */
export const OPERATIONS_REVIEW_QUEUE_HREF = '/orders/all?ops=awaiting'
export const OPERATIONS_REVIEW_QUEUE_BANNER = 'Showing Orders whose current PI version is awaiting operations review or flagged for clarification'

/** Why no operations reviewer could align a held Order again (recover_order_production_alignment). */
const REVIEWER_UNAVAILABLE_TEXT: Record<string, string> = {
  no_reviewer: 'no operations reviewer was assigned',
  reviewer_inactive: 'the operations reviewer is inactive',
  reviewer_cannot_open_order: 'the operations reviewer cannot open this Order',
}

/** The Order-history words for the events the migration writes. */
export const OPERATIONS_HANDOFF_EVENT_LABEL: Record<string, string> = {
  operations_handoff_recorded:              'Sent to operations for review',
  operations_reviewer_assigned:             'Operations reviewer assigned',
  operations_reviewer_unassigned:           'Operations reviewer unassigned',
  operations_handoff_accepted:              'Accepted for production by operations',
  operations_handoff_clarification_needed:  'Operations cannot accept: clarification needed',
  operations_handoff_acceptance_withdrawn:  'Operations withdrew the acceptance',
  operations_handoff_realigned:             'Operations aligned production again',
  operations_handoff_realigned_by_admin:    'Administrator recovered the production alignment',
}

export const OPERATIONS_HANDOFF_EVENT_TONE: Record<string, OperationsHandoffTone> = {
  operations_handoff_recorded:              'amber',
  operations_reviewer_assigned:             'neutral',
  operations_reviewer_unassigned:           'amber',
  operations_handoff_accepted:              'green',
  operations_handoff_clarification_needed:  'red',
  operations_handoff_acceptance_withdrawn:  'red',
  operations_handoff_realigned:             'green',
  operations_handoff_realigned_by_admin:    'amber',
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** One sentence of detail for each event, from its payload. */
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
      if (p.production_alignment === 'aligned') parts.push('the Order was aligned for production; that alignment was reset')
      // A one-time data fix (20261230000000) sent an approval made BEFORE
      // handoffs existed; the approval itself keeps its own date and approver.
      if (p.recorded_for_existing_approval === true) parts.push('sent later for an approval made before operations review existed')
      return parts.filter(Boolean).join(' · ') || null
    }
    case 'operations_reviewer_assigned':
    case 'operations_reviewer_unassigned':
      return [v, p.handoff_status === 'clarification_needed' ? 'flagged for clarification' : null].filter(Boolean).join(' · ') || null
    case 'operations_handoff_accepted':
      return [v, p.after_withdrawal === true ? 'after a withdrawal' : p.after_clarification === true ? 'after clarification' : null, text(p.note)].filter(Boolean).join(' · ') || null
    case 'operations_handoff_clarification_needed':
    case 'operations_handoff_acceptance_withdrawn':
      return [v, text(p.reason)].filter(Boolean).join(' · ') || null
    case 'operations_handoff_realigned':
      return [v, 'after a production hold', text(p.note)].filter(Boolean).join(' · ')
    case 'operations_handoff_realigned_by_admin':
      return [v, 'after a production hold', REVIEWER_UNAVAILABLE_TEXT[String(p.reviewer_unavailable)] ?? null, text(p.reason)]
        .filter(Boolean).join(' · ')
    default:
      return null
  }
}

/**
 * The alignment event, when a handoff wrote it: the existing history label
 * ("Production alignment changed") keeps its words; this adds WHY, from the
 * payload the handoff functions attach. Null for the legacy or manual path.
 */
export function describeAlignmentEventReason(payload: Record<string, unknown> | null | undefined): string | null {
  const p = payload ?? {}
  const v = typeof p.version_number === 'number' ? versionLabel(p.version_number) : null
  switch (p.reason) {
    case 'pi_version_approved':
      return typeof p.covered_version_number === 'number'
        ? `reset: ${v ?? 'a new version'} approved; the alignment covered ${versionLabel(p.covered_version_number)}`
        : `reset: ${v ?? 'a new version'} approved; the alignment predated version tracking`
    case 'operations_handoff_accepted':
      return v ? `${v} accepted by operations` : 'accepted by operations'
    case 'operations_handoff_clarification_needed':
      return v ? `${v} flagged for clarification` : 'flagged for clarification'
    case 'operations_handoff_acceptance_withdrawn':
      return v ? `acceptance of ${v} withdrawn` : 'acceptance withdrawn'
    case 'advance_hold':
      return 'removed: the verified advance fell below 40%'
    case 'operations_handoff_realigned':
      return v ? `${v} aligned again after a production hold` : 'aligned again after a production hold'
    case 'operations_handoff_realigned_by_admin':
      return v ? `${v} aligned again by an administrator (no operations reviewer could)` : 'aligned again by an administrator (no operations reviewer could)'
    default:
      return p.legacy_order === true ? 'set the old way (no handoff on this Order)' : null
  }
}
