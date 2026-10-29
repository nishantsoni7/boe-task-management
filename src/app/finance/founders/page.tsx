'use client'

// ── /finance/founders ────────────────────────────────────────────────────────
//
// Sits inside src/app/finance/layout.tsx, so ModuleGuard has already decided
// Finance entry before anything here mounts. Whether the caller may see the
// founders' payouts is decided by the view (an explicit finance.founder_payouts
// grant — administrators are not let in by role) and, for every read and write,
// by the database door of 20270501000000.

import { FounderPayoutsView } from './FounderPayoutsView'

export default function FounderPayoutsPage() {
  return <FounderPayoutsView />
}
