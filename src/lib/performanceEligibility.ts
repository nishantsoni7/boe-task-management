/**
 * Who is measured by Performance, and who is not.
 *
 * The owner's first question about any ranking is "who is in this list?". If the
 * answer includes administrative logins and permission-test fixtures, every
 * number below it — the team average, the weakest performer, the activity rate —
 * is describing a population the owner does not manage.
 *
 * The switch is `users.performance_tracking_enabled` (migration 20260719000000),
 * default true. It is deliberately *not* role, is_active, payroll_active or
 * module access:
 *
 *   - role          An admin can be an operational employee; a 'member' can be a
 *                   test account.
 *   - is_active      Removing someone from Performance must not remove them from
 *                   Members, permissions, task history or View As.
 *   - payroll_active Means "pays this person". Sharing it would let a reporting
 *                    decision change what someone is paid.
 *   - module access  Controls whether they can *see* Performance, not whether
 *                    they are *counted* by it.
 *
 * Nothing here matches on names. Exclusion is by primary key, decided in the
 * database, applied server-side. A frontend name filter would be defeated by a
 * rename, by a direct API call, and by every aggregate that is computed before
 * the list reaches the browser.
 */

/** The user row fields this module needs. Kept minimal so any caller can satisfy it. */
export type EligibilityUser = {
  id:        string
  full_name: string
  team:      string
  position?: string | null
  performance_tracking_enabled?: boolean | null
  performance_tracking_note?:    string | null
}

/**
 * Is this user measured by Performance?
 *
 * Null and undefined both read as **included**. The column is NOT NULL with
 * DEFAULT true, so the only way to see a null here is a caller that forgot to
 * select it — and defaulting to "included" makes that mistake visible as an
 * unexpected extra employee rather than silently deleting people from the report.
 */
export function isPerformanceTracked(user: EligibilityUser): boolean {
  return user.performance_tracking_enabled !== false
}

/** An employee held out of Performance reporting, for the admin-only coverage panel. */
export type ExcludedUser = {
  userId:   string
  userName: string
  team:     string
  /** Auditable reason from performance_tracking_note. Null when none was recorded. */
  note:     string | null
}

/**
 * Split an employee list into the measured population and the held-out one.
 *
 * Call this once, before any metric is computed. Every downstream figure —
 * per-employee metrics, team average, rankings, attention, EOD totals, adoption,
 * department averages — is derived from `tracked` only, so an excluded user
 * cannot influence a result by any path.
 */
export function partitionByTracking<T extends EligibilityUser>(
  users: readonly T[],
): { tracked: T[]; excluded: ExcludedUser[] } {
  const tracked:  T[] = []
  const excluded: ExcludedUser[] = []

  for (const u of users) {
    if (isPerformanceTracked(u)) {
      tracked.push(u)
    } else {
      excluded.push({
        userId:   u.id,
        userName: u.full_name,
        team:     u.team,
        note:     u.performance_tracking_note ?? null,
      })
    }
  }
  return { tracked, excluded }
}

/**
 * What an excluded user sees on their own `/performance` page.
 *
 * They keep the page — an administrator still wants to see their own activity —
 * but it has to say plainly that these numbers are not in any team comparison.
 * Silently showing a score that appears nowhere in the team report is how an
 * owner ends up arguing about two different sets of numbers.
 *
 * The `performance_tracking_note` is deliberately NOT surfaced here. It can say
 * "test account", which is management's assessment, not something to render into
 * the account holder's own page.
 */
export const EXCLUDED_SELF_NOTICE =
  'This account is not included in team Performance reporting. The figures below '
  + 'describe your own activity only — they do not appear in team rankings, the '
  + 'team average or the employee comparison.'

/**
 * Admin-only summary line for the Performance Coverage panel.
 *
 * Returns null at zero so the panel does not display "0 users excluded", which
 * invites the question of why the line exists.
 */
export function excludedSummaryLine(count: number): string | null {
  if (count <= 0) return null
  return `${count} user${count === 1 ? '' : 's'} excluded from Performance tracking`
}

/**
 * May this caller see *which* users are excluded and why?
 *
 * Admin only. Managers can read team performance, but the exclusion notes record
 * management's reason for holding an account out ("administrative/test account"),
 * which is a different sensitivity from a score. The count itself is not
 * sensitive and is shown to anyone who can see the page.
 */
export function canViewExcludedDetails(caller: { role: string }): boolean {
  return caller.role === 'admin'
}
