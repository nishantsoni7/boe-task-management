/**
 * THE PENDENCIES COLUMN of the Confirmed Orders list (owner, 2026-10-27).
 *
 * An Order reads "Approved" only when Fabric and Finish are both Fully Approved
 * AND no pendency is open; otherwise how many are still pending ("3 pending",
 * owner, 2026-10-31: a column of the same red "Not Approved" said nothing), and
 * the popup lists exactly what is outstanding. Display only: the approvals
 * themselves are written by record_order_approval_event() and
 * approve_order_pendency(), which re-derive every rule.
 */

import { APPROVAL_KINDS, APPROVAL_KIND_LABEL, APPROVAL_STATUS_LABEL, type ApprovalKind, type ApprovalStatus } from '@/lib/orders/orderApprovals'

export const PENDENCY_COLUMN_LABEL = 'Pendencies'
export const PENDENCY_ALL_APPROVED = 'Approved'
export const PENDENCY_NOT_APPROVED = 'Not Approved'

/** What the column says for an Order with something outstanding. */
export const pendencyCountLabel = (count: number) => `${count} pending`

/** One row of public.order_approval_current. */
export type CurrentApprovalRow = { order_id: string; approval_kind: string; status: string }
/** One open row of public.order_pendencies. */
export type OpenPendencyRow = { order_id: string; label: string }

export type PendingItem = { key: string; label: string; detail: string }

export type OrderPendencyOverview = {
  approved: boolean
  /** What is still outstanding, in reading order: Fabric, Finish, then the client list. */
  pending: PendingItem[]
}

const isStatus = (s: string): s is ApprovalStatus =>
  s === 'not_approved' || s === 'partially_approved' || s === 'fully_approved'

/** Folds the two reads into one overview per Order id. Orders absent from both are Not Approved on Fabric and Finish. */
export function buildPendencyOverviews(
  orderIds: readonly string[],
  approvals: readonly CurrentApprovalRow[],
  open: readonly OpenPendencyRow[],
): Map<string, OrderPendencyOverview> {
  const status = new Map<string, ApprovalStatus>()
  for (const a of approvals) {
    if (isStatus(a.status)) status.set(`${a.order_id}:${a.approval_kind}`, a.status)
  }
  const openBy = new Map<string, string[]>()
  for (const p of open) {
    const held = openBy.get(p.order_id) ?? []
    held.push(p.label)
    openBy.set(p.order_id, held)
  }

  const out = new Map<string, OrderPendencyOverview>()
  for (const id of orderIds) {
    const pending: PendingItem[] = []
    for (const kind of APPROVAL_KINDS) {
      const s: ApprovalStatus = status.get(`${id}:${kind}`) ?? 'not_approved'
      if (s !== 'fully_approved') {
        pending.push({ key: `${id}:${kind}`, label: kindLabel(kind), detail: APPROVAL_STATUS_LABEL[s] })
      }
    }
    for (const [i, label] of (openBy.get(id) ?? []).entries()) {
      pending.push({ key: `${id}:p${i}`, label, detail: PENDENCY_NOT_APPROVED })
    }
    out.set(id, { approved: pending.length === 0, pending })
  }
  return out
}

const kindLabel = (kind: ApprovalKind) => APPROVAL_KIND_LABEL[kind]
