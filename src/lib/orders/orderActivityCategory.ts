// ── ACTIVITY CATEGORIES (owner, 2026-10-27) ──────────────────────────────────
//
// Approvals, Payments and PI edits are three different kinds of event and are
// listed apart: every approval (Fabric, Finish, each pendency) is ONE category,
// distinct from an Edit PI and from a payment. Anything else is only in "All".
//
// Display only. It decides nothing about the Order.

export type ActivityCategory = 'approvals' | 'payments' | 'pi_edits' | 'other'

export const ACTIVITY_FILTERS: readonly { key: 'all' | Exclude<ActivityCategory, 'other'>; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pi_edits', label: 'PI edits' },
  { key: 'payments', label: 'Payments' },
  { key: 'approvals', label: 'Approvals' },
]

const APPROVAL_TYPE = /^(order_approval_|order_pendency_)/
const PAYMENT_TYPE = /^payment_/
const PI_EDIT_TYPE = /^(pi_revision_|order_workbook_replaced$)/

/** The source PI's trail is worded, so its categories are read from the words. */
const PAYMENT_LABEL = /payment/i
const PI_EDIT_LABEL = /(revised pi|workbook replaced|pi (updated|replaced|corrected|amended)|correction|changes requested)/i

export function activityCategory(input: {
  source: 'order' | 'pi'
  label: string
  eventType?: string | null
}): ActivityCategory {
  if (input.source === 'order' && input.eventType) {
    const t = input.eventType
    if (APPROVAL_TYPE.test(t)) return 'approvals'
    if (PAYMENT_TYPE.test(t)) return 'payments'
    if (PI_EDIT_TYPE.test(t)) return 'pi_edits'
    return 'other'
  }
  const label = input.label.trim()
  if (PAYMENT_LABEL.test(label)) return 'payments'
  if (PI_EDIT_LABEL.test(label)) return 'pi_edits'
  return 'other'
}
