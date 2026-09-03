'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { UserProfile } from '@/lib/types'

// What the Control Center layout hands to the sections it wraps: identity, and
// nothing else.
//
// The signed-in administrator is resolved ONCE, by
// src/app/admin/control-center/layout.tsx, from the same session-scoped
// permission resolution the launcher and every module guard already share.
// Sections used to re-read the session and the `users` row for themselves on
// every mount; this is the replacement for that, not a data store. Members,
// departments, modules and permission trees stay in the pages that use them.
export type ControlCenterSession = {
  /** The signed-in administrator's own profile row. Never the View As target. */
  profile: UserProfile
  /** The signed-in user's id. */
  userId: string
}

const ControlCenterContext = createContext<ControlCenterSession | null>(null)

export function ControlCenterProvider({
  value,
  children,
}: {
  value: ControlCenterSession
  children: ReactNode
}) {
  return <ControlCenterContext.Provider value={value}>{children}</ControlCenterContext.Provider>
}

/**
 * The administrator the layout admitted.
 *
 * Throws outside the Control Center on purpose: a section rendered without the
 * gate above it is a wiring mistake, and a null here would let it render as if
 * nobody were signed in.
 */
export function useControlCenterSession(): ControlCenterSession {
  const ctx = useContext(ControlCenterContext)
  if (!ctx) throw new Error('useControlCenterSession must be used inside the Control Center layout')
  return ctx
}
