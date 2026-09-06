'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { derivePerformanceCapabilities } from '@/lib/permissions/performance'

// TEAM PERFORMANCE'S OWN GATE, on top of the module gate.
//
// src/app/performance/layout.tsx already decides whether this person may open
// the Performance module at all (`performance.view`). This decides the narrower
// question the module gate cannot: whether they may open the MANAGEMENT half of
// it — every employee's score, ranking, EOD discipline and attention briefing.
// That is `performance.view_team`, registered by 20261109000000.
//
// It is written as its own layout, exactly as Orders and Meetings each keep
// their own file, because the predicate is module-specific and ModuleGuard's is
// not. The three properties that make ModuleGuard correct are kept:
//
//   1. `children` render in no state but `allowed`, so the team screen's fetch
//      cannot start for somebody who is about to be redirected.
//   2. The check reads the SIGNED-IN user, never the View As target. View As
//      shows an administrator what somebody else sees; it must not lend that
//      person's authority nor take the administrator's away.
//   3. A failed profile read denies — derivePerformanceCapabilities returns
//      nothing on a null role.
//
// AND IT IS NOT THE BOUNDARY. GET /api/performance-metrics/team and
// GET /api/eod-logs/team each resolve the same capability from the caller's own
// bearer token and refuse without it, so a hand-typed URL gets the same answer
// as the screen. This exists so the screen never mounts, not so the data is
// safe; the data is safe because of the routes.
//
// Denied lands on /performance — their own report — rather than on
// /coming-soon. Somebody who reached this URL holds the module; the only thing
// they lack is the management half of it, and the honest place to put them is
// the half they do have.
export default function PerformanceTeamLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  // The DISPLAY SUBJECT decides — see the note in ModuleGuard. Previewing Dhruv
  // must show Dhruv's Team Performance if he has it and hide it if he does not;
  // the admin's own `view_team` is not what is being previewed.
  const { ready, actorUserId: userId, subjectRole: role, subjectPermissionsByModule: permissionsByModule }
    = useDisplaySubject()

  const capabilities = derivePerformanceCapabilities(
    role,
    permissionsByModule.get('performance') ?? [],
  )
  const allowed = ready && userId !== null && capabilities.canAccessTeamPerformance

  useEffect(() => {
    // Nothing is decided until the context resolves. `ready` false reports a
    // null role and an empty permission map, which is indistinguishable from a
    // genuine denial — redirecting on it would bounce authorized people.
    if (!ready) return
    if (userId === null) { router.replace('/login'); return }
    if (!allowed) router.replace('/performance')
  }, [ready, userId, allowed, router])

  if (!allowed) return <LoadingScreen />
  return <>{children}</>
}
