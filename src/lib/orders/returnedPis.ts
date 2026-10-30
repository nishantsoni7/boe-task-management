// PIs RETURNED TO YOU, for the Modules launcher's For you card (owner, 2026-10-30).
//
// public.my_returned_pis() (20270507000000) returns the signed-in person's own
// PIs in Returned to Sales — where they are the salesperson, creator or
// submitter — oldest first, from the same definition the sales Orders dashboard
// reads. It returns [] without the Orders module, so the launcher never breaks.
// The approver's note is never sent: it is on the PI page.
//
// This module validates that answer and owns the card's words. A row it cannot
// read makes the whole answer unreadable (the card then says it could not be
// loaded), never a silently shorter list.

export type ReturnedPi = {
  submissionId: string
  /** The PI's draft reference, `PID-00021`. */
  reference: string
  clientName: string
  /** Who returned it; null when the person is no longer on record. */
  byName: string | null
  /** When it was returned (ISO); null when no activity row records it. */
  since: string | null
  waitingSeconds: number
  /** False when the existing PI rules would refuse this reader: no Open PI button. */
  canOpen: boolean
}

/** Turns the RPC's answer into the card's rows; throws when the answer is not a list of rows. */
export function readReturnedPis(raw: unknown): ReturnedPi[] {
  if (!Array.isArray(raw)) throw new Error('The returned PIs answer is not a list.')
  return raw.map((x): ReturnedPi => {
    if (typeof x !== 'object' || x === null) throw new Error('A returned PI row is not an object.')
    const o = x as Record<string, unknown>
    if (typeof o.submission_id !== 'string' || o.submission_id === '') throw new Error('A returned PI has no id.')
    const seconds = typeof o.waiting_seconds === 'number' ? o.waiting_seconds : Number(o.waiting_seconds)
    return {
      submissionId: o.submission_id,
      reference: typeof o.reference === 'string' && o.reference.trim() !== '' ? o.reference.trim() : 'PI',
      clientName: typeof o.client_name === 'string' ? o.client_name : '',
      byName: typeof o.by_name === 'string' && o.by_name.trim() !== '' ? o.by_name.trim() : null,
      since: typeof o.since === 'string' ? o.since : null,
      waitingSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
      canOpen: o.can_open === true,
    }
  })
}

/** `3 days`, `1 day`, `5 h`, `just now`. */
export function returnedAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`
  const hours = Math.floor(s / 3600)
  return hours >= 1 ? `${hours} h` : 'just now'
}

/** From the third day (two full days waited) the card turns red (owner, 2026-10-30). */
export const RETURNED_URGENT_SECONDS = 2 * 86400
export const isReturnedPiUrgent = (seconds: number): boolean => seconds >= RETURNED_URGENT_SECONDS

/** `IBC · PID-00021`. */
export function returnedBrief(r: ReturnedPi): string {
  return `${r.clientName || 'Client not recorded'} · ${r.reference}`
}

/** `Returned by Nishant Soni. Open it to see what to change.` */
export function returnedDetail(r: ReturnedPi): string {
  return `${r.byName ? `Returned by ${r.byName}. ` : ''}Open it to see what to change.`
}
