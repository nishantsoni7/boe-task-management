'use client'

// ── /finance/expenses ────────────────────────────────────────────────────────
//
// The expense log. Sits inside src/app/finance/layout.tsx, so ModuleGuard has
// already decided Finance entry before anything here mounts — a direct URL is
// refused, not merely hidden — and RLS decides every row independently.

import { ExpensesView } from './ExpensesView'

export default function ExpensesPage() {
  return <ExpensesView />
}
