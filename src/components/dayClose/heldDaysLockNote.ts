'use client'

// The line the payroll lock's confirmation adds about Day Close held days (owner, 2026-11-18). It never blocks the
// lock: a held day left undecided counts as present. Empty when there are none, or when they cannot be read.

import { dayCloseFetch } from './api'

/** The pure wording, so it is tested without a browser. */
export function heldDaysLockLine(undecided: number): string {
  if (undecided <= 0) return ''
  return `\n\n${undecided} Day Close held ${undecided === 1 ? 'day is' : 'days are'} still undecided ` +
    '(Attendance → Monthly Review). Locking counts them as present; nothing is deducted for them.'
}

export async function heldDaysLockNote(year: number, month: number): Promise<string> {
  const r = await dayCloseFetch<{ holds: { decision: string | null; cleared_at: string | null }[] }>(
    `/api/day-close/holds?year=${year}&month=${month}`)
  if (!r.ok) return ''
  return heldDaysLockLine(r.data.holds.filter(h => !h.decision && !h.cleared_at).length)
}
