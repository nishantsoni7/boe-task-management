'use client'

// ── /finance/bank ────────────────────────────────────────────────────────────
//
// Sits inside src/app/finance/layout.tsx, so ModuleGuard has already decided
// Finance entry before anything here mounts. Whether the caller may reconcile
// is decided by the view (finance.reconcile) and, for every read and write,
// by the database.

import { Suspense } from 'react'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { BankStatementsView } from './BankStatementsView'

export default function BankStatementsPage() {
  return (
    <Suspense fallback={<FinanceRouteFallback />}>
      <BankStatementsView />
    </Suspense>
  )
}
