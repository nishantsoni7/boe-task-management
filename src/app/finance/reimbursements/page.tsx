'use client'

// ── /finance/reimbursements ──────────────────────────────────────────────────
//
// Sits inside src/app/finance/layout.tsx, so ModuleGuard has already decided
// Finance entry before anything here mounts. Whether the caller may see the
// reimbursements is decided by the view (finance.reimburse + view_all) and, for
// every row, by the database.

import { ReimbursementsView } from './ReimbursementsView'

export default function ReimbursementsPage() {
  return <ReimbursementsView />
}
