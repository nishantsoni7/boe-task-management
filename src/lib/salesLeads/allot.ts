/**
 * What picking a name in a lead's dropdown means (the owner's rule, 2026-11-02):
 *   - the lead is not allotted yet  → the pick is saved at once;
 *   - the lead already has a holder → the screen asks first ("Change who holds this lead?"), because a name
 *     changed by mistake is the thing the question exists to stop;
 *   - the pick is the holder already → nothing.
 * The database adds its own guard (allot_sales_lead refuses a change whose "who I saw" is stale).
 */
export type AllotStep = 'nothing' | 'save' | 'confirm'

export function allotStep(holder: string | null, picked: string): AllotStep {
  if (picked === holder) return 'nothing'
  return holder === null ? 'save' : 'confirm'
}

type KeyLike = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }

const MOVING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * A closed <select> in Chrome and Edge changes its value, and says so, on every arrow key or typed letter. Allotting
 * a lead by a stray key press is exactly the mistake this screen guards against, so a change that arrives from such
 * a key is ignored: the person opens the list (a click, Space, Enter or Alt+Down) and picks from it. Alt, Ctrl and
 * Meta are not moving keys: Alt+Down is how the list is opened from the keyboard.
 */
export function isSelectNavigationKey(e: KeyLike): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false
  if (MOVING_KEYS.has(e.key)) return true
  return e.key.length === 1 && e.key !== ' '
}

/**
 * How soon after a moving key a `change` still counts as that key's doing. A closed select changes in the same
 * instant as the key. Picking from the open list comes much later, even on a Mac where an arrow key opens the list
 * (the key press is then not followed by a change at all, and its key-up never reaches the select, so the rule must
 * not wait for one).
 */
export const KEY_CHANGE_WINDOW_MS = 100

/** `keyAt` is the time of the last moving key on the select (null = none); both are event timestamps in ms. */
export function changeCameFromKey(keyAt: number | null, changeAt: number): boolean {
  return keyAt !== null && changeAt >= keyAt && changeAt - keyAt < KEY_CHANGE_WINDOW_MS
}
