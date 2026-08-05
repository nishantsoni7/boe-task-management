import type { EffectivePermission } from './types'
import type { Meeting } from '@/lib/meetings/types'

// Meetings capability derivation.
//
// One place that turns the raw effective permissions for the 'meetings' module
// into the booleans the layout and the pages branch on, so the UI and the
// database say the same thing. Every capability maps to exactly one action, and
// every button maps to exactly one capability — a button must never appear for
// a permission its RPC will refuse.
//
//   view    → ENTER the module. NOT "see every meeting": the meetings SELECT
//             policy still narrows the rows to the ones you led, created or
//             attended.
//   create  → schedule a review
//   edit    → conduct one: record SKU updates, set follow-ups, create tasks
//   manage  → see EVERY meeting in the company, and complete / reopen one
//   delete  → discard an empty draft
//   export  → download the blank import template and export a review
//
// THE RULE THIS FILE EXISTS TO STATE: 'view' is not visibility.
//
// These are management reviews. The failure mode to avoid is the one Assets &
// Access hit (see assetsAccess.ts and migration 20260810000000), where a
// module-entry default quietly became organisation-wide read access. Here the
// separation is enforced twice: by `canViewAllMeetings` below, and — the part
// that actually matters — by row-level security, which an employee cannot get
// past whatever the browser believes.
//
// Admins bypass the engine entirely, matching every other cut-over module.

export type MeetingsCapabilities = {
  /** May open Meetings at all. Says nothing about which meetings are visible. */
  canAccessMeetings: boolean
  /**
   * May see EVERY meeting, not only their own. A management-level grant
   * ('manage'), never the plain 'view' an ordinary employee holds. Mirrors the
   * `resolve_permission(..., 'manage')` branch of can_view_meeting().
   */
  canViewAllMeetings: boolean
  canCreateMeeting: boolean
  /** May record updates, add orders and SKU lines, and create tasks. */
  canConductMeeting: boolean
  /** May complete a meeting, and reopen a completed one for a correction. */
  canCompleteMeeting: boolean
  canDeleteMeeting: boolean
  /** May download the blank template and run the spreadsheet import. */
  canImport: boolean
}

export const NO_MEETINGS_CAPABILITIES: MeetingsCapabilities = {
  canAccessMeetings: false,
  canViewAllMeetings: false,
  canCreateMeeting: false,
  canConductMeeting: false,
  canCompleteMeeting: false,
  canDeleteMeeting: false,
  canImport: false,
}

export function deriveMeetingsCapabilities(
  role: string | null | undefined,
  permissions: EffectivePermission[],
): MeetingsCapabilities {
  if (role === 'admin') {
    return {
      canAccessMeetings: true,
      canViewAllMeetings: true,
      canCreateMeeting: true,
      canConductMeeting: true,
      canCompleteMeeting: true,
      canDeleteMeeting: true,
      canImport: true,
    }
  }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  const canManage = allowed('manage')
  const canEdit   = allowed('edit')
  const canCreate = allowed('create')

  // Entry is the weakest thing this module grants, so any stronger capability
  // implies it — a grant can never leave someone authorized to act on a module
  // they cannot open.
  const canAccessMeetings = allowed('view') || canManage || canEdit || canCreate

  return {
    canAccessMeetings,
    canViewAllMeetings: canManage,
    canCreateMeeting: canCreate,
    // Bulk import writes into an existing meeting through the same
    // history-writing path as a manual update, so it is the same authority.
    canConductMeeting: canEdit || canManage,
    canCompleteMeeting: canManage,
    canDeleteMeeting: allowed('delete') || canCreate,
    canImport: canEdit || canManage,
  }
}

/**
 * Whether this person may change THIS meeting — the browser-side mirror of
 * can_edit_meeting() (migration 20260814000000 §6).
 *
 * The lead and the creator are included on purpose and without a module grant:
 * whoever is running the review must be able to record it. Anyone else needs
 * 'edit' or 'manage'.
 *
 * A completed meeting is editable by nobody. Reopening it is a separate
 * capability (`canCompleteMeeting`) precisely so that "correct a closed record"
 * is a decision someone takes, not a side effect of still having the tab open.
 */
export function canEditThisMeeting(
  meeting: Pick<Meeting, 'status' | 'lead_id' | 'created_by'>,
  userId: string | null | undefined,
  caps: MeetingsCapabilities,
): boolean {
  if (!userId) return false
  if (meeting.status === 'completed') return false
  if (caps.canConductMeeting) return true
  return meeting.lead_id === userId || meeting.created_by === userId
}

/**
 * Whether this person may complete or reopen THIS meeting.
 *
 * Same owners as editing, plus the 'manage' grant. Completing is allowed on a
 * live meeting; reopening is the only write permitted against a completed one.
 */
export function canSetThisMeetingStatus(
  meeting: Pick<Meeting, 'status' | 'lead_id' | 'created_by'>,
  userId: string | null | undefined,
  caps: MeetingsCapabilities,
): boolean {
  if (!userId) return false
  if (caps.canCompleteMeeting) return true
  if (caps.canConductMeeting) return true
  return meeting.lead_id === userId || meeting.created_by === userId
}
