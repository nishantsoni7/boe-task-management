// "Clear all" on the Modules launcher's For you panel (owner, 2026-10-29):
// every item showing is hidden for 24 hours, then comes back if it has still
// not been dealt with. Nothing is deleted, decided or marked read.
//
// Pure helpers, kept free of React and storage so the test runner can execute
// them. The state lives in this browser's localStorage, per signed-in user (see
// AttentionPanel.tsx): a choice made on one device does not hide items on
// another.
//
// An item is hidden only if its KEY was showing when Clear all was pressed. A
// key names the thing AND what it says (a holder's key includes the amount), so
// something new or changed shows at once, even inside the 24 hours.

export const SNOOZE_MS = 24 * 60 * 60 * 1000

export type SnoozeState = { until: number; keys: string[] }

export const EMPTY_SNOOZE: SnoozeState = { until: 0, keys: [] }

/** The localStorage key for one signed-in user. */
export const snoozeStorageKey = (userId: string) => `boe.forYou.cleared.${userId}`

/** Hide these keys for 24 hours from `now`. */
export function snoozeAll(keys: readonly string[], now: number): SnoozeState {
  return { until: now + SNOOZE_MS, keys: [...new Set(keys)] }
}

/** Whether this key is hidden at `now`. */
export function isSnoozed(state: SnoozeState, key: string, now: number): boolean {
  return now < state.until && state.keys.includes(key)
}

/**
 * Whether this key is hidden by a state already known to be unexpired (the
 * panel keeps only such a state: readSnooze on load, a timer at `until`).
 */
export function isHidden(state: SnoozeState, key: string): boolean {
  return state.until > 0 && state.keys.includes(key)
}

/** Read a stored value; anything malformed, or already expired, is no snooze. */
export function readSnooze(raw: string | null, now: number): SnoozeState {
  if (!raw) return EMPTY_SNOOZE
  try {
    const v = JSON.parse(raw) as Partial<SnoozeState>
    const until = typeof v.until === 'number' ? v.until : 0
    const keys = Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === 'string') : []
    return until > now ? { until, keys } : EMPTY_SNOOZE
  } catch {
    return EMPTY_SNOOZE
  }
}

/** Item keys. Each names the thing and what it currently says. */
export const itemKeys = {
  announcement: (id: string) => `announcement:${id}`,
  handover: (id: string) => `handover:${id}`,
  holder: (holderId: string, amount: number, detail: string) => `cash:${holderId}:${amount}:${detail}`,
  request: (id: string) => `request:${id}`,
  /** A PI returned to Sales; returned again later is a new item, shown at once. */
  returnedPi: (id: string, since: string | null) => `returned-pi:${id}:${since ?? ''}`,
  /** The attendance machine has stopped; still stopped tomorrow is a new item. */
  machineStopped: (date: string) => `machine-stopped:${date}`,
}
