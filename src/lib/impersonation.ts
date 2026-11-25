/**
 * LOGIN AS MEMBER — the rules, in one place.
 *
 * An administrator may sign in AS any member to test what that member sees and
 * does. This is a REAL session swap, not the read-only preview in viewAs.ts:
 * the server issues a one-time login token for the member, the browser exchanges
 * it for the member's session, and from then on every page, RLS rule,
 * notification feed and write behaves exactly as it does for that member.
 *
 * No password is read, shown or changed. The administrator's own session is kept
 * in the browser (STASH_KEY) so one click puts them back; every start and end is
 * recorded in admin_impersonation_sessions by the server.
 *
 * Authority lives on the server: /api/impersonation/start only answers an
 * active, non-deleted administrator. The stash is the administrator's own
 * credential kept where their session already lives — it grants nothing the
 * browser did not already hold.
 */

export const IMPERSONATION_STASH_KEY = 'boeAdminImpersonation'

/** What the browser keeps while an administrator is acting as a member. */
export type ImpersonationStash = {
  /** admin_impersonation_sessions.id of the open session. */
  sessionId: string
  admin: {
    id: string
    fullName: string
    accessToken: string
    refreshToken: string
  }
  target: {
    id: string
    fullName: string
    subtitle: string
  }
  startedAt: string
}

export type ImpersonationMember = {
  id: string
  full_name: string
  email: string | null
  role: string
  team: string | null
  position: string | null
  designation_level: string | null
  is_active: boolean
  employee_code: string | null
}

export function isEligibleImpersonator(
  actor: { role: string; is_active?: boolean | null; is_deleted?: boolean | null } | null | undefined,
): boolean {
  if (!actor) return false
  return actor.role === 'admin' && actor.is_active !== false && actor.is_deleted !== true
}

/** Why a start request is refused, or null when it may proceed. */
export function startRefusal(actorId: string, targetId: string | null | undefined): string | null {
  if (!targetId) return 'targetUserId is required'
  if (targetId === actorId) return 'You are already signed in as yourself'
  return null
}

export function parseStash(raw: string | null): ImpersonationStash | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<ImpersonationStash> | null
    if (
      !v || typeof v.sessionId !== 'string' ||
      !v.admin || typeof v.admin.accessToken !== 'string' || typeof v.admin.refreshToken !== 'string' ||
      !v.target || typeof v.target.id !== 'string'
    ) return null
    return v as ImpersonationStash
  } catch {
    return null
  }
}

export function readStash(): ImpersonationStash | null {
  if (typeof window === 'undefined') return null
  try {
    return parseStash(window.localStorage.getItem(IMPERSONATION_STASH_KEY))
  } catch {
    return null
  }
}

export function writeStash(stash: ImpersonationStash | null): void {
  try {
    if (stash) window.localStorage.setItem(IMPERSONATION_STASH_KEY, JSON.stringify(stash))
    else window.localStorage.removeItem(IMPERSONATION_STASH_KEY)
  } catch {
    // Storage blocked: the swap itself still works, but restoring would not.
  }
}

// WHERE THE FLOATING BUTTON IS PARKED (owner, 2026-11-25: it sat on top of page content).
// Pixels from the window's right and bottom edges, so a resize keeps it near the same edge.
// A per-browser convenience only: nothing here is a credential, and nothing needs it.
export const IMPERSONATION_POSITION_KEY = 'boeLoginAsPosition'

export type FloatPosition = { right: number; bottom: number }

const EDGE_GAP = 8

/** Keeps the whole button inside the window, EDGE_GAP px from every edge. */
export function clampPosition(
  p: FloatPosition,
  box: { width: number; height: number },
  win: { width: number; height: number },
): FloatPosition {
  const fit = (v: number, room: number) => Math.min(Math.max(v, EDGE_GAP), Math.max(EDGE_GAP, room))
  return { right: fit(p.right, win.width - box.width - EDGE_GAP), bottom: fit(p.bottom, win.height - box.height - EDGE_GAP) }
}

export function parsePosition(raw: string | null): FloatPosition | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<FloatPosition> | null
    if (!v || !Number.isFinite(v.right) || !Number.isFinite(v.bottom)) return null
    return { right: v.right as number, bottom: v.bottom as number }
  } catch {
    return null
  }
}

export function readPosition(): FloatPosition | null {
  if (typeof window === 'undefined') return null
  try {
    return parsePosition(window.localStorage.getItem(IMPERSONATION_POSITION_KEY))
  } catch {
    return null
  }
}

export function writePosition(p: FloatPosition): void {
  try {
    window.localStorage.setItem(IMPERSONATION_POSITION_KEY, JSON.stringify(p))
  } catch {
    // Storage blocked: the button still moves for this visit, it just starts at the corner next time.
  }
}
