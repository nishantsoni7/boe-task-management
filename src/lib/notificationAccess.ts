// Who may read a notification FEED.
//
// Every notification endpoint already scopes its query to `user_id = caller`,
// which is what keeps one person's rows away from another's. That is row
// access, and it is not the question this file answers.
//
// The question here is whether a caller may ask for a CATEGORY at all. Most
// categories need no such rule: Finance, Orders, Assets and Task all notify the
// people involved in the thing that happened, so "your own rows in that
// category" is a sensible request from anyone.
//
// `attendance_payroll` is different. It is the notification half of the
// admin-only management surfaces at /attendance and /payroll — every row is an
// employee reporting a problem with their own attendance or pay, addressed to
// the administrators who deal with it. An employee's view of their own dispute
// is the status badge on /my-attendance and /my-payroll, which comes from
// /api/objections and is pinned to their own rows. This feed is the other side
// of that, and must not become reachable from the self-service half just
// because both live in one table.
//
// Kept out of src/lib/notifications.ts on purpose: that module is imported by
// client components (NotificationsView, the badge hooks) and must stay free of
// any Supabase import. The pure predicate lives there; the database read lives
// here, server-side only.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isAdminOnlyNotificationCategory, type NotificationCategory } from '@/lib/notifications'

/**
 * May this user read this category's feed?
 *
 * Fails CLOSED: a role that cannot be read — a missing profile, a deleted user,
 * a query error — is not an admin. The cheap case is checked first so the four
 * open categories cost no extra round trip.
 *
 * `svc` is the service-role client the endpoint already built. The role is read
 * with an explicit column list, never `select('*')`: `users` has column-level
 * grants (20260813000000) and a star select fails with 42501.
 */
export async function canReadNotificationCategory(
  svc: SupabaseClient,
  userId: string,
  category: NotificationCategory,
): Promise<boolean> {
  if (!isAdminOnlyNotificationCategory(category)) return true

  const { data, error } = await svc
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    console.error('[notifications] role check failed:', error.message)
    return false
  }
  return data?.role === 'admin'
}

/** The one refusal message, so list/count/mark-read/delete-all read alike. */
export const CATEGORY_FORBIDDEN = 'You do not have access to these notifications'
