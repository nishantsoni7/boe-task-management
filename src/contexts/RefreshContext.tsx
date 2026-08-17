'use client'

import { createContext, useContext, useState, useCallback, useMemo } from 'react'

// ── TWO COUNTERS, BECAUSE ONE CANNOT ANSWER "WHO ASKED" ─────────────────────
//
// `refreshKey` is bumped by everything that wants a re-read: the Refresh button
// in each module layout, and the visibilitychange handlers that still exist in
// DashboardLayout, FinanceLayout, SamplesLayout and AttendancePayrollLayout. A
// consumer reading it therefore cannot tell an explicit press from the user
// simply coming back to the tab — the two are the same number going up.
//
// `manualRefreshKey` is bumped ONLY by an explicit press. It exists for
// consumers that must not re-read on tab return: the dashboard's task list,
// whose rows are now cached, where an automatic refetch on every glance at
// another tab is exactly the behaviour that was removed.
//
// STRICTLY ADDITIVE. `triggerRefresh` is untouched and `triggerManualRefresh`
// bumps BOTH, so every existing consumer of `refreshKey` — /tasks/my, the
// shared NotificationsView, the attendance and samples pages — sees precisely
// the sequence of increments it saw before, from both sources. Nothing opts out
// of anything; one new signal is added alongside.
type RefreshContextValue = {
  refreshKey: number
  /** Bumped only by an explicit Refresh press, never by tab visibility. */
  manualRefreshKey: number
  triggerRefresh: () => void
  triggerManualRefresh: () => void
}

const RefreshContext = createContext<RefreshContextValue>({
  refreshKey: 0,
  manualRefreshKey: 0,
  triggerRefresh: () => {},
  triggerManualRefresh: () => {},
})

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [manualRefreshKey, setManualRefreshKey] = useState(0)
  const triggerRefresh = useCallback(() => setRefreshKey(k => k + 1), [])
  // Both, so a press still reaches every existing `refreshKey` consumer exactly
  // as it did before, while manual-only consumers can single it out.
  const triggerManualRefresh = useCallback(() => {
    setManualRefreshKey(k => k + 1)
    setRefreshKey(k => k + 1)
  }, [])
  const value = useMemo(
    () => ({ refreshKey, manualRefreshKey, triggerRefresh, triggerManualRefresh }),
    [refreshKey, manualRefreshKey, triggerRefresh, triggerManualRefresh],
  )
  return (
    <RefreshContext.Provider value={value}>
      {children}
    </RefreshContext.Provider>
  )
}

export function useRefresh() {
  return useContext(RefreshContext)
}
