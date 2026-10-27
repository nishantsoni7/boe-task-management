// ── THE ORDER'S TWO PI MILESTONES, FROM THE FIRST PI ─────────────────────────
//
// The dates timeline says when the salesperson uploaded the PI and when the
// admin team approved it. Both must belong to the SAME version, or they can
// read out of order: the page used to take the upload from the version now in
// force (a revision uploaded days after the first approval) and the approval
// from the first "PI approved" event, so an Order revised after approval showed
// "approved" BEFORE "uploaded".
//
// The timeline tells the Order's own story — it was uploaded, then approved —
// so both come from the FIRST PI version (V1). Later revisions have their own
// history in PI history and in Activity.

export type PiMilestoneVersion = {
  version_number: number
  status: string
  uploaded_at: string | null
  decided_at: string | null
}

/** A decision that approved the version (a version since replaced was approved once). */
const APPROVED_STATUSES: readonly string[] = ['approved', 'admin_approved', 'superseded']

export function firstPiMilestones(
  versions: readonly PiMilestoneVersion[],
  /** The time of the first "PI approved" event, used only when V1 carries no decision. */
  firstApprovalEventAt: string | null = null,
): { uploadedAt: string | null; approvedAt: string | null } {
  const first = [...versions].sort((a, b) => a.version_number - b.version_number)[0]
  if (!first) return { uploadedAt: null, approvedAt: firstApprovalEventAt }
  const approvedByVersion = APPROVED_STATUSES.includes(first.status) ? first.decided_at : null
  return {
    uploadedAt: first.uploaded_at,
    approvedAt: approvedByVersion ?? firstApprovalEventAt,
  }
}
