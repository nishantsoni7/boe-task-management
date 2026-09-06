'use client'

import { useQuery } from '@tanstack/react-query'
import { useViewAs } from '@/hooks/useViewAs'
import { usePermissionContext, PERMISSION_STALE_MS, PERMISSION_GC_MS } from '@/hooks/queries/usePermissionContext'
import type { UserProfile } from '@/lib/types'
import type { EffectivePermission } from '@/lib/permissions/types'

// ONE ANSWER TO "WHOSE SCREEN IS THIS?", shared by every display surface.
//
// THE MODEL
//
//   actorUserId / actorRole      the authenticated caller. Never the viewed
//                                employee. Every write, every audit row and
//                                every server-side authorization is theirs.
//
//   subjectUserId / subjectRole  whose interface to render. The viewed employee
//   subjectProfile               while View As is active; the actor otherwise.
//   subjectPermissionsByModule
//
//   viewMode / readOnly          true only while previewing somebody else.
//
// READ IDENTITY = subject. WRITE AUTHORITY = actor. See src/lib/viewAs.ts.
//
// WHAT THIS FIXES. View As was half-wired. The launcher took the viewed user's
// PROFILE for the Attendance/Payroll card but the ADMIN's effective permissions
// for every engine-gated card; ModuleGuard, both Performance guards and every
// notification badge read the admin outright. "Viewing as Dhruv" therefore
// rendered a screen that was partly Dhruv and partly the administrator — which
// defeats the entire purpose, because an admin cannot tell which half they are
// looking at. Every display decision now reads the subject through this hook.
//
// THE PERMISSIONS COME FROM THE SERVER, and that is the security-relevant part.
// The subject's effective permissions are fetched from /api/view-as/subject,
// which decides from the SESSION whether this caller may preview that employee.
// The browser says which employee it wants; it never says whether it may. That
// replaces DashboardLayout's View As branch, which called
// resolve_effective_permissions_for_user(<any id>) straight from the client and
// so put the decision in the browser.
//
// NO EXTRA WORK IN THE ORDINARY CASE. Outside View As the subject IS the actor,
// and the answer is already in the session-scoped permission context that
// ModuleGuard and /modules share — so this hook costs no request at all unless
// somebody is actually previewing.
//
// THE SAME RESOLVER, DELIBERATELY. The subject's permissions are produced by
// resolve_effective_permissions_for_user, which is what a normal login resolves
// through. There is no second, View-As-only permission engine, so a permission
// changed in Control Center changes the preview exactly as it changes that
// employee's real screen.

export type DisplaySubject = {
  /** False while either identity is still resolving. Render no access decision on it. */
  ready: boolean

  // ── Authenticated actor ────────────────────────────────────────────────────
  /** The signed-in user. Null once ready means no session. */
  actorUserId: string | null
  /** The signed-in user's role. Never the subject's. */
  actorRole: string | null
  /** The signed-in user's own profile — the one the account menu names. */
  actorProfile: UserProfile | null

  // ── Display subject ────────────────────────────────────────────────────────
  /** Whose interface is being rendered. Equals actorUserId outside View As. */
  subjectUserId: string | null
  subjectRole: string | null
  subjectProfile: UserProfile | null
  /** The subject's effective permissions, keyed by module_key. */
  subjectPermissionsByModule: ReadonlyMap<string, readonly EffectivePermission[]>

  // ── Mode ───────────────────────────────────────────────────────────────────
  /** True only while previewing somebody else. */
  viewMode: boolean
  /** True whenever viewMode is. Named separately because it is what callers branch on. */
  readOnly: boolean
}

const NO_PERMISSIONS: ReadonlyMap<string, readonly EffectivePermission[]> = new Map()

type SubjectResponse = {
  subject: UserProfile
  permissionsByModule: Record<string, EffectivePermission[]>
  isPreview: boolean
}

export const displaySubjectKey = (subjectId: string | null) => ['view-as-subject', subjectId] as const

export function useDisplaySubject(): DisplaySubject {
  const { viewAsUserId } = useViewAs()
  const {
    ready: actorReady,
    userId: actorUserId,
    profile: actorProfile,
    role: actorRole,
    permissionsByModule: actorPermissions,
  } = usePermissionContext()

  // A preview is only a preview when it names SOMEBODY ELSE. An admin whose
  // stored view-as target is their own id is simply themselves, and must not pay
  // for a request or render a banner.
  const previewing = !!viewAsUserId && !!actorUserId && viewAsUserId !== actorUserId

  const { data: subjectData, isPending: subjectPending } = useQuery<SubjectResponse>({
    queryKey: displaySubjectKey(previewing ? viewAsUserId : null),
    // Waits for the actor: firing before the session is known would ask the
    // server to authorize a caller it cannot yet identify.
    enabled: previewing && actorReady,
    queryFn: async () => {
      const res = await fetch(`/api/view-as/subject?userId=${encodeURIComponent(viewAsUserId!)}`)
      // A refusal is a real answer — the caller may not preview this employee,
      // or the employee is no longer eligible. It must not silently fall back to
      // the ADMIN's own interface wearing somebody else's name, so it throws and
      // the derivation below denies everything until it resolves.
      if (!res.ok) throw new Error(`View As subject request failed (HTTP ${res.status})`)
      return res.json() as Promise<SubjectResponse>
    },
    staleTime: PERMISSION_STALE_MS,
    gcTime: PERMISSION_GC_MS,
  })

  if (!previewing) {
    return {
      ready: actorReady,
      actorUserId,
      actorRole,
      actorProfile,
      subjectUserId: actorUserId,
      subjectRole: actorRole,
      subjectProfile: actorProfile,
      subjectPermissionsByModule: actorPermissions,
      viewMode: false,
      readOnly: false,
    }
  }

  const subjectReady = actorReady && !subjectPending && subjectData !== undefined

  // FAIL CLOSED WHILE PREVIEWING. Until the server has said who the subject is
  // and what they hold, the subject has a null role and no permissions — which
  // every display helper reads as "nothing". The alternative, falling back to
  // the actor, would render the ADMIN's modules under the employee's name: the
  // exact leak this hook exists to close.
  const subjectPermissions: ReadonlyMap<string, readonly EffectivePermission[]> = subjectData
    ? new Map(Object.entries(subjectData.permissionsByModule))
    : NO_PERMISSIONS

  return {
    ready: subjectReady,
    actorUserId,
    actorRole,
    actorProfile,
    subjectUserId: viewAsUserId,
    subjectRole: subjectData?.subject.role ?? null,
    subjectProfile: subjectData?.subject ?? null,
    subjectPermissionsByModule: subjectPermissions,
    viewMode: true,
    readOnly: true,
  }
}
