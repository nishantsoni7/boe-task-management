// Giving a Confirmed Order a different number: who may, what may be typed, and
// what anybody is told when it does not work.
//
// The authority is public.change_confirmed_order_number() (20270502000000). It
// checks that the caller is an active administrator, that the number is 1-9999,
// unused by any Order, never reserved by a PI Draft and below the cycle's next
// number, and — under the cycle lock — gives the old number back to the next
// Order when it was the newest. Everything here only decides what is worth
// SHOWING and words the refusals; none of it is a gate. The one check the
// database does not make, that a cancelled Order keeps its number, is the
// route's (cancelledOrderLock.ts).

import { displayOrderNumber } from '@/lib/orderNumbering'

export const CHANGE_ORDER_NUMBER_ACTION_LABEL = 'Change Order number'
export const CHANGE_ORDER_NUMBER_DIALOG_TITLE = 'Change Order number'
export const CHANGE_ORDER_NUMBER_CONFIRM_LABEL = 'Change number'
export const CHANGE_ORDER_NUMBER_BUSY_LABEL = 'Changing…'

/** What moves with the number, said before the decision. */
export const CHANGE_ORDER_NUMBER_NOTE =
  'The new number must not belong to any other Order. Product codes and the PI PDF '
  + 'follow the new number. If this is the newest Order number, the next Order is given it.'

export type ChangeOrderNumberViewer = {
  isAdmin: boolean
  /** An administrator previewing another person's view performs no action. */
  viewingAs: boolean
  /** A cancelled Order keeps its number: changing it would free it for another Order. */
  cancelled: boolean
}

/** Whether the control is worth drawing. The route and the database decide again. */
export function canChangeOrderNumber(viewer: ChangeOrderNumberViewer): boolean {
  return viewer.isAdmin && !viewer.viewingAs && !viewer.cancelled
}

/**
 * What was typed, as the database will store it ('508' → '0508'), or null when
 * it cannot be an Order number. Same rule as the RPC: 1 to 4 digits, not zero.
 */
export function normalizeNewOrderNumber(typed: string): string | null {
  const text = typed.trim()
  if (!/^[0-9]{1,4}$/.test(text)) return null
  const n = Number(text)
  return n >= 1 && n <= 9999 ? String(n).padStart(4, '0') : null
}

export type OrderNumberChangeCode =
  | 'DENIED'
  | 'MISSING'
  | 'INVALID'
  | 'SAME'
  | 'IN_USE'
  | 'RESERVED'
  | 'TOO_HIGH'
  | 'CANCELLED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'FAILED'

const FAILURE_COPY: Record<OrderNumberChangeCode, string> = {
  DENIED: 'Only an administrator can change an Order number.',
  MISSING: 'This Order no longer exists.',
  INVALID: 'Type a whole number from 1 to 9999.',
  SAME: 'This Order already has that number.',
  IN_USE: 'That number already belongs to another Order. Choose a number no Order has.',
  RESERVED: 'That number was reserved for a PI Draft and cannot be used.',
  TOO_HIGH: 'The new number must be lower than the number the next Order will be given.',
  CANCELLED: 'A cancelled Order keeps its number. Nothing has changed.',
  UNAUTHORIZED: 'Sign in again to change this Order number.',
  BAD_REQUEST: 'The request could not be read. Nothing has changed.',
  FAILED: 'The Order number could not be changed. Nothing has changed; try again.',
}

const DATABASE_MARKERS: readonly { marker: string; code: OrderNumberChangeCode }[] = [
  { marker: 'ORDER_NUMBER_CHANGE_DENIED', code: 'DENIED' },
  { marker: 'ORDER_NUMBER_CHANGE_MISSING', code: 'MISSING' },
  { marker: 'ORDER_NUMBER_CHANGE_INVALID', code: 'INVALID' },
  { marker: 'ORDER_NUMBER_CHANGE_SAME', code: 'SAME' },
  { marker: 'ORDER_NUMBER_CHANGE_IN_USE', code: 'IN_USE' },
  // The unique index is the real guarantee; a race past the check lands here.
  { marker: 'orders_display_number_key', code: 'IN_USE' },
  { marker: 'ORDER_NUMBER_CHANGE_RESERVED', code: 'RESERVED' },
  { marker: 'ORDER_NUMBER_CHANGE_TOO_HIGH', code: 'TOO_HIGH' },
]

/** A database error becomes a stable code. Nothing of its text is ever echoed. */
export function classifyOrderNumberChangeError(message: string | null | undefined): OrderNumberChangeCode {
  const text = message ?? ''
  return DATABASE_MARKERS.find(entry => text.includes(entry.marker))?.code ?? 'FAILED'
}

export function describeOrderNumberChangeFailure(code: unknown): { code: OrderNumberChangeCode; message: string } {
  const known = (typeof code === 'string' && code in FAILURE_COPY ? code : 'FAILED') as OrderNumberChangeCode
  return { code: known, message: FAILURE_COPY[known] }
}

/** HTTP status for each code. */
export const ORDER_NUMBER_CHANGE_HTTP: Record<OrderNumberChangeCode, number> = {
  DENIED: 403,
  MISSING: 404,
  INVALID: 422,
  SAME: 422,
  IN_USE: 409,
  RESERVED: 409,
  TOO_HIGH: 422,
  CANCELLED: 409,
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  FAILED: 500,
}

/** What the RPC returns, as the route passes it on. */
export type OrderNumberChangeResult = {
  previousNumber: string
  displayNumber: string
  nextNumber: string | null
  oldNumberIsNext: boolean
}

/** The one sentence shown once the number has changed. */
export function describeOrderNumberChange(result: OrderNumberChangeResult): string {
  const from = displayOrderNumber(result.previousNumber)
  const to = displayOrderNumber(result.displayNumber)
  return result.oldNumberIsNext
    ? `Order ${from} is now Order ${to}. The next Order will be given ${from}.`
    : `Order ${from} is now Order ${to}. ${from} is left unused: it was not the newest Order number.`
}
