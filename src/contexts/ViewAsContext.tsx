'use client'

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { UserProfile } from '@/lib/types'

const STORAGE_KEY = 'adminViewAs'

type ViewAsState = { userId: string; profile: UserProfile } | null

function readStorage(): ViewAsState {
  if (typeof window === 'undefined') return null
  try {
    const s = localStorage.getItem(STORAGE_KEY)
    return s ? (JSON.parse(s) as ViewAsState) : null
  } catch {
    return null
  }
}

type ViewAsContextType = {
  viewAsUserId: string | null
  viewAsProfile: UserProfile | null
  enterViewMode: (userId: string, profile: UserProfile) => void
  exitViewMode: () => void
}

const ViewAsContext = createContext<ViewAsContextType>({
  viewAsUserId: null,
  viewAsProfile: null,
  enterViewMode: () => {},
  exitViewMode: () => {},
})

export function ViewAsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ViewAsState>(readStorage)

  const enterViewMode = useCallback((userId: string, profile: UserProfile) => {
    const val: ViewAsState = { userId, profile }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    setState(val)
  }, [])

  const exitViewMode = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setState(null)
  }, [])

  return (
    <ViewAsContext.Provider
      value={{
        viewAsUserId: state?.userId ?? null,
        viewAsProfile: state?.profile ?? null,
        enterViewMode,
        exitViewMode,
      }}
    >
      {children}
    </ViewAsContext.Provider>
  )
}

export function useViewAs() {
  return useContext(ViewAsContext)
}
