// The Lock Payroll button's conversation with the server.
//
// The SERVER decides whether a month has open attendance-review items
// (src/lib/payroll/lockPeriod.ts). This module only relays: it asks to lock;
// if the server answers that items are open, it shows them, asks for a reason,
// and repeats the request carrying the server's own fingerprint of that state.
// If the state changed in between, the server refuses the stale
// acknowledgement and this shows the new state instead of locking.
//
// A month with nothing open keeps the existing one-confirmation flow.

export type OpenItemsSummary = {
  code?: string
  unresolved: number
  conflicts: number
  fingerprint?: string
  employees: { full_name: string | null; unresolved: number; conflicts: number }[]
}

/** The text an admin must read before locking past open items. */
export function lockWarningText(summary: OpenItemsSummary | null, failed: boolean, stale = false): string {
  if (failed || !summary) {
    return 'The attendance review for this month could not be checked on the server. ' +
      'Unresolved attendance salary items may exist.\n\n' +
      'To lock anyway, type the reason for this override below. It is recorded with your name.'
  }
  const { unresolved, conflicts } = summary
  const names = summary.employees
    .slice(0, 5)
    .map(e => `• ${e.full_name ?? 'Employee'}: ${e.unresolved} unresolved${e.conflicts ? `, ${e.conflicts} disagree with the draft` : ''}`)
    .join('\n')
  const more = summary.employees.length > 5 ? `\n• …and ${summary.employees.length - 5} more` : ''
  return (stale ? 'THE REVIEW CHANGED SINCE YOU LOOKED. This is the current state.\n\n' : '') +
    `ATTENDANCE REVIEW NOT FINISHED — ${unresolved} unresolved salary item${unresolved === 1 ? '' : 's'}` +
    (conflicts ? `, of which ${conflicts} disagree with this draft` : '') + ':\n' +
    `${names}${more}\n\n` +
    'Locking now freezes the draft as it stands; afterwards, changes need Unlock or an adjustment.\n' +
    'To lock with these open, type the reason below. It is recorded with your name, the time and these counts.'
}

export type LockOutcome = { status: 'locked' | 'cancelled' | 'error'; error?: string }

type Ask = { confirm: (msg: string) => boolean; prompt: (msg: string) => string | null }

/**
 * Run the lock. `baseConfirm` is the existing confirmation text. `ui` defaults
 * to the browser's confirm/prompt; tests pass their own.
 */
export async function runLockFlow(
  token: string,
  periodId: string,
  baseConfirm: string,
  ui: Ask = { confirm: m => window.confirm(m), prompt: m => window.prompt(m) },
  post: (body: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> = async body => {
    const res = await fetch('/api/payroll/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) }
  },
): Promise<LockOutcome> {
  if (!ui.confirm(baseConfirm)) return { status: 'cancelled' }

  let r = await post({ payroll_period_id: periodId })
  // At most a few rounds: each stale answer shows the fresh state once more.
  for (let round = 0; round < 3; round++) {
    if (r.ok) return { status: 'locked' }
    const code = r.json.code as string | undefined
    if (r.status !== 409 || !r.json.requires_acknowledgement) {
      return { status: 'error', error: (r.json.error as string) ?? 'Lock failed' }
    }
    const failed = code === 'attendance_check_failed'
    const text = lockWarningText(failed ? null : (r.json as unknown as OpenItemsSummary), failed, code === 'attendance_ack_stale')
    const reason = ui.prompt(text)
    if (reason == null || !reason.trim()) return { status: 'cancelled' }
    r = await post({
      payroll_period_id: periodId,
      attendance_acknowledgement: failed
        ? { unverified: true, reason: reason.trim() }
        : { fingerprint: r.json.fingerprint, reason: reason.trim() },
    })
  }
  return r.ok ? { status: 'locked' } : { status: 'error', error: (r.json.error as string) ?? 'Lock failed' }
}
