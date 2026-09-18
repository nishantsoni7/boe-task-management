// ── Orders and Finance: where am I? ──────────────────────────────────────────
//
// The pure half of the two module sidebars. Which entry is lit for a path, and
// what the header should say while a route is still loading, are decided here —
// no React, no router — so a test can read the rules directly instead of
// rendering a sidebar to find out.
//
// WHY THIS EXISTS. Each layout used to decide "active" inline, and the answers
// had gaps a reader could see:
//
//   * an Order record (/orders/<id>) lit NOTHING, although it is a Confirmed
//     Order and the reader got there from Confirmed Orders;
//   * a PI record (/orders/drafts/<id>) and Upload PI (/orders/import) are both
//     steps of the PI Drafts workflow, and only the first lit it;
//   * Finance compared the path EXACTLY, so every sub-route of Confirmed Payments
//     and the retired Payments to Verify page lit nothing.
//
// NOTHING HERE DECIDES ACCESS. A lit entry is a statement about location. Each
// route's own guard and the database still decide what opens.

export type OrdersNavKey = 'dashboard' | 'drafts' | 'confirmed'
export type FinanceNavKey = 'requests' | 'confirmed'

// The destinations themselves (labels, paths, icons) stay in OrdersLayout and
// FinanceLayout, where several retirement tests read them; this file only
// decides which of them is lit.

function segments(pathname: string): string[] {
  return pathname.split('?')[0].split('#')[0].split('/').filter(Boolean)
}

/**
 * The Orders entry a path belongs to, or null.
 *
 *   /orders                     → dashboard
 *   /orders/drafts, /drafts/<id>, /orders/import  → drafts (the PI workflow)
 *   /orders/all, /orders/<id>   → confirmed
 *   /orders/notifications       → null (its own sidebar entry lights itself)
 *   /orders/requests…           → null (retired; its notice offers the exits)
 */
export function activeOrdersNav(pathname: string): OrdersNavKey | null {
  const [root, section] = segments(pathname)
  if (root !== 'orders') return null
  if (section === undefined) return 'dashboard'
  if (section === 'drafts' || section === 'import') return 'drafts'
  if (section === 'all') return 'confirmed'
  if (section === 'notifications' || section === 'requests') return null
  // Anything else directly under /orders is an Order record.
  return 'confirmed'
}

/**
 * The Finance entry a path belongs to, or null.
 *
 *   /finance, /finance/payments-to-verify  → requests (the same request-stage
 *                                            records; the latter is retired from
 *                                            the sidebar but still answers)
 *   /finance/received…                     → confirmed
 *   /finance/notifications                 → null
 */
export function activeFinanceNav(pathname: string): FinanceNavKey | null {
  const [root, section] = segments(pathname)
  if (root !== 'finance') return null
  if (section === undefined || section === 'payments-to-verify') return 'requests'
  if (section === 'received') return 'confirmed'
  return null
}

/**
 * What the header says while a route is still loading — the SAME words the page
 * will say when it arrives, so nothing jumps. A PI record's final title is its
 * client's name, which cannot be known before the read; "PI Draft" is what that
 * page already shows while it loads.
 */
export function pendingModuleTitle(pathname: string): string {
  const [root, section, id] = segments(pathname)
  if (root === 'finance') {
    if (section === undefined) return 'Payment Requests'
    if (section === 'received') return 'Confirmed Payments'
    if (section === 'payments-to-verify') return 'Payments to Verify'
    if (section === 'notifications') return 'Notifications'
    return 'Finance'
  }
  if (root === 'orders') {
    if (section === undefined) return 'Orders'
    if (section === 'drafts') return id ? 'PI Draft' : 'PI Drafts'
    if (section === 'all') return 'Confirmed Orders'
    if (section === 'import') return 'Upload PI'
    if (section === 'notifications') return 'Notifications'
    if (section === 'requests') return 'Order Requests'
    return 'Confirmed Order'
  }
  return ''
}
