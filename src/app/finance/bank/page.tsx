'use client'

// ── /finance/bank ────────────────────────────────────────────────────────────
//
// Sits inside src/app/finance/layout.tsx, so ModuleGuard has already decided
// Finance entry before anything here mounts. Whether the caller may reconcile
// is decided by the view (finance.reconcile) and, for every read and write,
// by the database.

import { BankStatementsView } from './BankStatementsView'

export default function BankStatementsPage() {
  return <BankStatementsView />
}
