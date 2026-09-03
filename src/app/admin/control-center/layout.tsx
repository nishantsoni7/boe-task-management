'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useViewAs } from '@/hooks/useViewAs'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { LoadingScreen } from '@/components/ui/atoms'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { ControlCenterProvider } from '@/components/layout/ControlCenterContext'

// THE CONTROL CENTER SHELL AND ITS GATE, in the one place Next keeps mounted.
//
// A segment layout survives navigation between its own routes: Overview,
// Access Control, Test Data Cleanup and the rest are siblings under this file,
// so the sidebar, the header and the admin decision below are created once and
// then left alone while the content pane changes. Before this, every section
// rendered its own copy of the shell and re-decided identity on every mount —
// which is why each sidebar click emptied the screen to a full-viewport
// spinner and re-read the same `users` row again.
//
// WHERE IDENTITY COMES FROM. usePermissionContext — the same session-scoped
// resolution the launcher, ModuleGuard and DashboardLayout share, cached and
// invalidated by the auth listener in Providers.tsx. Arriving from /modules it
// is already warm, so admitting an administrator costs no request at all.
//
// THE RULE IS UNCHANGED, and it fails closed:
//   no session                → /login
//   signed in, not an admin   → /dashboard  (a failed profile read reports a
//                                null role, which is "not an admin")
//   admin with View As active → View As is exited, then /dashboard. The Control
//                                Center is the administrator's own screen; it
//                                has no meaning as somebody else.
//   admin                     → the shell and the section render
//
// `children` render in no state except admitted. Nothing is decided while the
// context is still resolving — an unresolved context reads as "denied", and
// acting on it would bounce authorized people.
//
// THIS IS THE UI HALF ONLY. Every Control Center API route re-verifies the
// caller from its bearer token, and every RPC and policy checks admin again in
// the database. Centralising the screen gate changes nothing about that.
export default function ControlCenterRootLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, exitViewMode } = useViewAs()
  const { ready, userId, role, profile } = usePermissionContext()

  // Raised the moment View As is exited, so the shell cannot appear for the
  // frames between that exit and the new route landing. The flag and the exit
  // are batched into the one render the exit already causes — there is no
  // cascade, only a different outcome for that render.
  const [leaving, setLeaving] = useState(false)

  const allowed = ready && userId !== null && role === 'admin' && !viewAsUserId && !leaving

  useEffect(() => {
    if (!ready) return
    if (userId === null) { router.replace('/login'); return }
    if (role !== 'admin') { router.replace('/dashboard'); return }
    if (viewAsUserId) {
      const leave = () => {
        setLeaving(true)
        exitViewMode()
        router.replace('/dashboard')
      }
      leave()
    }
  }, [ready, userId, role, viewAsUserId, exitViewMode, router])

  // The one full-screen state that remains: before anything is on screen at
  // all. It never shows again while moving between sections, because this
  // component does not remount for them.
  if (!allowed || !profile || userId === null) return <LoadingScreen />

  return (
    <ControlCenterProvider value={{ profile, userId }}>
      <ControlCenterLayout
        profile={profile}
        onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
      >
        {children}
      </ControlCenterLayout>
    </ControlCenterProvider>
  )
}
