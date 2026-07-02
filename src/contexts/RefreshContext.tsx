'use client'

import { createContext, useContext, useState, useCallback, useMemo } from 'react'

type RefreshContextValue = {
  refreshKey: number
  triggerRefresh: () => void
}

const RefreshContext = createContext<RefreshContextValue>({
  refreshKey: 0,
  triggerRefresh: () => {},
})

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const triggerRefresh = useCallback(() => setRefreshKey(k => k + 1), [])
  const value = useMemo(() => ({ refreshKey, triggerRefresh }), [refreshKey, triggerRefresh])
  return (
    <RefreshContext.Provider value={value}>
      {children}
    </RefreshContext.Provider>
  )
}

export function useRefresh() {
  return useContext(RefreshContext)
}
