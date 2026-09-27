// What the payroll LOCK confirmation says about the month's attendance review.
//
// Lock semantics are unchanged: /api/payroll/lock has never checked
// attendance corrections, objections or anything else, and existing periods
// and users rely on that. What changes is that an admin locking a month with
// unresolved salary items, or with decisions the draft does not reflect, is
// told so in the confirmation they must accept — an explicit acknowledgement
// at the one step the lock flow already has. It is a usability gate, not a
// server-side block; see ATTENDANCE_REQUESTS.md §3.

export type ReviewSummary = {
  totals: { unresolved: number; conflicts: number }
  employees: { full_name: string | null; unresolved: number; conflicts: number }[]
}

/** The paragraph to prepend to the lock confirmation, or '' when nothing is open. */
export function lockWarningText(summary: ReviewSummary | null, failed: boolean): string {
  if (failed || !summary) {
    return 'The attendance review for this month could not be checked. ' +
      'Unresolved attendance salary items may exist.\n\n'
  }
  const { unresolved, conflicts } = summary.totals
  if (unresolved === 0) return ''
  const names = summary.employees
    .slice(0, 5)
    .map(e => `• ${e.full_name ?? 'Employee'}: ${e.unresolved} unresolved${e.conflicts ? `, ${e.conflicts} disagree with the draft` : ''}`)
    .join('\n')
  const more = summary.employees.length > 5 ? `\n• …and ${summary.employees.length - 5} more` : ''
  return `ATTENDANCE REVIEW NOT FINISHED — ${unresolved} unresolved salary item${unresolved === 1 ? '' : 's'}` +
    (conflicts ? `, of which ${conflicts} disagree with this draft` : '') + ':\n' +
    `${names}${more}\n\n` +
    'Locking now freezes the draft as it stands. After lock, changes need Unlock or an adjustment. ' +
    'Press OK only if you accept locking with these open.\n\n'
}

/** Fetch the month's summary. Never throws: a failed check is reported, not fatal. */
export async function fetchLockWarning(token: string, year: number, month: number): Promise<string> {
  try {
    const res = await fetch(`/api/attendance-requests/reconciliation?year=${year}&month=${month}&summary=1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) return lockWarningText(null, true)
    return lockWarningText(await res.json() as ReviewSummary, false)
  } catch {
    return lockWarningText(null, true)
  }
}
