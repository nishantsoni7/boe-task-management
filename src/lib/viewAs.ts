import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * View As — the identity model, in one place.
 *
 * THE TWO IDENTITIES, and the rule that keeps them apart:
 *
 *   AUTHENTICATED ACTOR   the person holding the session. Always the real
 *                         signed-in user. Every WRITE, every audit row and
 *                         every authorization decision is theirs.
 *
 *   DISPLAY SUBJECT       the person whose interface is being rendered. In View
 *                         As that is the selected employee; otherwise it is the
 *                         actor. Every DISPLAY decision — which module cards
 *                         exist, which navigation entries show, which counts and
 *                         badges appear, which page a link lands on — is theirs.
 *
 * READ IDENTITY  = subject.   WRITE AUTHORITY = actor.   And while View As is
 * active there are no writes at all.
 *
 * WHY THIS FILE EXISTS. View As was half-built: the launcher took the viewed
 * user's PROFILE for the Attendance/Payroll card but the ADMIN's effective
 * permissions for every engine-gated card; ModuleGuard, the Performance guards
 * and the notification badges all read the admin. So "Viewing as Dhruv" rendered
 * a screen that was partly Dhruv and partly the administrator — which makes the
 * feature useless for its actual purpose, because an admin cannot tell whether
 * what they are looking at is what the employee sees.
 *
 * WHAT IT IS NOT. This is not an authentication mechanism. No token is issued,
 * no session is exchanged, no password is used and RLS is untouched. The browser
 * says WHICH employee it wants to preview; the server decides whether that is
 * allowed and what the preview may contain. A client-supplied id is a request,
 * never a credential.
 */

/** The employee whose interface is being rendered. */
export type ViewAsSubjectRequest = {
  /** The id the browser is asking to preview. Untrusted input. */
  requestedSubjectId: string | null | undefined
  /** The authenticated caller, resolved server-side from their session. */
  actor: { id: string; role: string; is_active?: boolean | null; is_deleted?: boolean | null } | null
}

export type ViewAsDecision =
  | { allowed: true; subjectId: string; isPreview: boolean }
  | { allowed: false; status: 401 | 403 | 404; reason: string }

/**
 * MAY THIS CALLER PREVIEW THIS EMPLOYEE?
 *
 * The single server-side gate every View As read passes through. Four questions,
 * in the order the requirement states them, and every one answered from data the
 * server read itself:
 *
 *   1. is there an authenticated caller at all?
 *   2. is that caller permitted to use View As?
 *   3. does the requested employee exist and are they eligible?
 *   4. (the caller's own id always resolves, so a no-op preview is not an error)
 *
 * WHO MAY PREVIEW. Administrators, and only administrators — the same authority
 * that renders the Switch User control. Deactivated and soft-deleted accounts
 * are refused even when their role still says admin, because deactivating an
 * account does not end its Supabase session; that is the rule
 * /api/control-center/permissions/employees/[id] already applies and this must
 * not be the weaker door.
 *
 * NOTE ON `subject` ELIGIBILITY. The caller previewing THEMSELVES is always
 * allowed and is not a preview at all — it is the ordinary case, and treating it
 * as one keeps every caller on a single code path instead of branching on
 * whether View As happens to be active.
 */
export function decideViewAsSubject({ requestedSubjectId, actor }: ViewAsSubjectRequest): ViewAsDecision {
  if (!actor) return { allowed: false, status: 401, reason: 'Unauthorized' }

  // No subject asked for, or the caller's own id: ordinary rendering.
  if (!requestedSubjectId || requestedSubjectId === actor.id) {
    return { allowed: true, subjectId: actor.id, isPreview: false }
  }

  if (!isEligibleViewer(actor)) {
    return { allowed: false, status: 403, reason: 'View As is not available to this account' }
  }

  return { allowed: true, subjectId: requestedSubjectId, isPreview: true }
}

/**
 * May this account use View As at all?
 *
 * Role AND liveness. A stale session belonging to a deactivated administrator
 * must not be able to browse the company one employee at a time.
 */
export function isEligibleViewer(
  actor: { role: string; is_active?: boolean | null; is_deleted?: boolean | null } | null,
): boolean {
  if (!actor) return false
  if (actor.role !== 'admin') return false
  if (actor.is_active === false) return false
  if (actor.is_deleted === true) return false
  return true
}

/**
 * Is this employee eligible to BE previewed?
 *
 * An inactive or soft-deleted employee has no current interface to reproduce, so
 * previewing one would render a screen nobody sees. Refused rather than
 * approximated.
 */
export function isEligibleSubject(
  subject: { is_active?: boolean | null; is_deleted?: boolean | null } | null | undefined,
): boolean {
  if (!subject) return false
  return subject.is_active !== false && subject.is_deleted !== true
}

/**
 * Resolve the display subject for a request, reading the actor and the subject
 * from the database rather than from anything the client sent.
 *
 * Returns the decision plus the subject row, so a caller can scope its query to
 * `subjectId` and be certain that id was authorized rather than asserted.
 */
export async function resolveViewAsSubject(
  // No generated Database type in this project — matches the untyped-client
  // pattern the API routes already use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupabaseClient<any, any, any>,
  actorId: string,
  requestedSubjectId: string | null | undefined,
): Promise<ViewAsDecision> {
  const { data: actor } = await client
    .from('users')
    .select('id, role, is_active, is_deleted')
    .eq('id', actorId)
    .maybeSingle()

  const decision = decideViewAsSubject({
    requestedSubjectId,
    actor: actor as ViewAsSubjectRequest['actor'],
  })
  if (!decision.allowed || !decision.isPreview) return decision

  const { data: subject } = await client
    .from('users')
    .select('id, is_active, is_deleted')
    .eq('id', decision.subjectId)
    .maybeSingle()

  if (!isEligibleSubject(subject as { is_active?: boolean; is_deleted?: boolean } | null)) {
    return { allowed: false, status: 404, reason: 'Employee not available for preview' }
  }
  return decision
}

/**
 * THE WRITE RULE, stated once so every caller can point at it.
 *
 * While View As is active, no user mutation may proceed. Not "is rewritten to
 * the admin", not "is attributed to the admin" — refused.
 *
 * The audit half of this is already structurally safe: every mutation endpoint
 * in this codebase derives its actor from the bearer token or the session
 * cookie and none accepts an actor id from the body, so an admin previewing
 * Dhruv could never produce "Dhruv submitted EOD" however hard the client tried.
 * What this rule prevents is the other failure — an admin inspecting somebody
 * else's screen and silently mutating THEIR OWN state by clicking what looks
 * like the employee's button.
 *
 * SAFE TO TRUST FROM THE CLIENT, and this is the only reason a header is
 * acceptable here: the flag can only ever REFUSE a write. A caller who lies by
 * omitting it gains nothing they did not already have as themselves, and a
 * caller who sends it can only reduce their own authority. It is a seatbelt,
 * not a gate — the gate is the session.
 */
export const VIEW_AS_HEADER = 'x-boe-view-as'

/** Does this request declare itself a read-only preview? */
export function isPreviewRequest(headers: { get(name: string): string | null }): boolean {
  const raw = headers.get(VIEW_AS_HEADER)
  return typeof raw === 'string' && raw.trim() !== '' && raw.trim() !== 'false'
}

export const PREVIEW_WRITE_REFUSED =
  'This action is disabled while View As is active. Exit View Mode to make changes.'
