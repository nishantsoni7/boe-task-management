import type { LeadErrorKind } from './errors'
import type { LeadFormValues } from './validation'

// The outbox — why Save feels instant at a crowded stand.
//
// Tapping Save puts the entry here and clears the form at once; the network
// call happens behind it. Hall Wi-Fi drops, and the database can take seconds
// from some regions, so the person must never wait for it with a visitor in
// front of them. Nothing is lost on the way:
//
//   * every entry carries its own submission id, minted when Save was tapped
//     and reused for EVERY retry, so a retry can never create a second lead
//     (create_exhibition_lead replays the original row for the same id);
//   * entries not yet confirmed are kept in localStorage, per signed-in person,
//     and are sent again after a reload, a lost connection or a new login;
//   * anything the server refuses is shown, with what to do, instead of being
//     dropped: the person can edit it back into the form or discard it.
//
// This file is the pure part — the states and the transitions — plus guarded
// storage. The screen owns the network call and the timers.

export type OutboxStatus =
  | 'saving'          // sent, or about to be
  | 'retry'           // the network let us down; will be sent again by itself
  | 'auth'            // the session is gone; sent again after signing in
  | 'saved'
  | 'duplicate_mine'  // this number is already one of my leads
  | 'duplicate_other' // this number belongs to someone else's lead
  | 'failed'          // refused; needs a person

export type OutboxEntry = {
  /** The idempotency key. */
  id: string
  exhibitionId: string
  /** What the form held, so an entry can be put back for editing. */
  values: LeadFormValues
  /** The exact arguments sent (create_exhibition_lead minus the ids). */
  args: Record<string, unknown>
  name: string
  status: OutboxStatus
  attempts: number
  createdAt: number
  /** The existing lead, for duplicate_mine. */
  leadId?: string
  message?: string
}

/** Statuses that still need to reach the database. */
export const UNSENT: readonly OutboxStatus[] = ['saving', 'retry', 'auth']
/** Statuses that need the person to do something. */
export const NEEDS_ATTENTION: readonly OutboxStatus[] = ['auth', 'duplicate_mine', 'duplicate_other', 'failed']

export const MAX_AUTO_RETRIES = 6

export const isUnsent = (e: OutboxEntry) => UNSENT.includes(e.status)

export function newEntry(init: {
  id: string; exhibitionId: string; values: LeadFormValues; args: Record<string, unknown>; now?: number
}): OutboxEntry {
  return {
    id: init.id, exhibitionId: init.exhibitionId, values: init.values, args: init.args,
    name: init.values.contactName.trim(), status: 'saving', attempts: 0, createdAt: init.now ?? Date.now(),
  }
}

export type SendOutcome =
  | { outcome: 'created' | 'replayed' }
  | { outcome: 'duplicate'; mine: true; lead_id: string }
  | { outcome: 'duplicate'; mine: false }

/** The server answered. */
export function afterAnswer(e: OutboxEntry, res: SendOutcome): OutboxEntry {
  if (res.outcome !== 'duplicate') {
    return { ...e, status: 'saved', message: undefined, attempts: e.attempts + 1 }
  }
  if (res.mine) {
    return {
      ...e, status: 'duplicate_mine', leadId: res.lead_id, attempts: e.attempts + 1,
      message: 'This contact is already in your leads for this exhibition. Nothing new was created.',
    }
  }
  return {
    ...e, status: 'duplicate_other', attempts: e.attempts + 1,
    message: 'This contact is already recorded for this exhibition. Contact Admin for reassignment.',
  }
}

/** Errors worth sending again by themselves: the request may simply not have arrived. */
const TRANSIENT: readonly LeadErrorKind[] = ['uncertain', 'unknown']

/** The call failed. */
export function afterError(e: OutboxEntry, err: { kind: LeadErrorKind; message: string }): OutboxEntry {
  const attempts = e.attempts + 1
  if (err.kind === 'auth') return { ...e, status: 'auth', attempts, message: err.message }
  if (err.kind === 'duplicate_phone') {
    return { ...e, status: 'duplicate_other', attempts, message: err.message }
  }
  if (TRANSIENT.includes(err.kind)) {
    return attempts >= MAX_AUTO_RETRIES
      ? { ...e, status: 'failed', attempts, message: 'Could not reach the server. Check the connection, then tap Retry — nothing is lost.' }
      : { ...e, status: 'retry', attempts, message: err.message }
  }
  return { ...e, status: 'failed', attempts, message: err.message }
}

/** Time to wait before the next automatic try: 2 s, 4 s, 8 s, then 15 s. */
export const retryDelayMs = (attempts: number) => Math.min(2000 * 2 ** Math.max(0, attempts - 1), 15_000)

/** A person asked to send it again, or the connection came back. */
export const resend = (e: OutboxEntry): OutboxEntry =>
  e.status === 'retry' || e.status === 'failed' || e.status === 'auth'
    ? { ...e, status: 'saving', message: undefined }
    : e

/** The entries the screen shows and acts on: the order they were entered. */
export const byEntryOrder = (list: readonly OutboxEntry[]) => [...list].sort((a, b) => a.createdAt - b.createdAt)

/** The next entry to send: the oldest one waiting. */
export const nextToSend = (list: readonly OutboxEntry[]) => byEntryOrder(list).find(e => e.status === 'saving') ?? null

// ── Storage ───────────────────────────────────────────────────────────────

const KEY = 'exhibition-leads:outbox:v1'
type Stored = { userId: string; entries: OutboxEntry[] }

/** Entries still owed to the database or to the person, for this signed-in person only. */
export function loadOutbox(userId: string): OutboxEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const stored = JSON.parse(raw) as Stored
    if (!stored || stored.userId !== userId || !Array.isArray(stored.entries)) return []
    return stored.entries
      .filter(e => e && typeof e.id === 'string' && e.values && e.args && e.status !== 'saved')
      // After a reload nothing is in flight: whatever was waiting is sent again.
      .map(e => (isUnsent(e) ? { ...e, status: 'saving' as const, attempts: 0, message: undefined } : e))
  } catch {
    return []
  }
}

/** Saved entries are dropped: only what is still owed is kept. */
export function storeOutbox(userId: string, entries: readonly OutboxEntry[]): void {
  try {
    const keep = entries.filter(e => e.status !== 'saved')
    if (keep.length === 0) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify({ userId, entries: keep } satisfies Stored))
  } catch {
    // private mode / blocked storage: the screen still works, it just cannot survive a reload.
  }
}
