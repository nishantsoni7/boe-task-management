// Permanently deleting a Confirmed Order: who may, what the person types, and
// what anybody is told when it does not work.
//
// The authority is public.delete_confirmed_order() (20270317000000). It checks
// that the caller is an active administrator, that the typed confirmation is the
// Order's own number, and that no payment allocation, intent or payment request
// names the Order or its PI. Everything here only decides what is worth SHOWING
// and words the refusals; none of it is a gate.

export const DELETE_ORDER_ACTION_LABEL = 'Delete Order'
export const DELETE_ORDER_DIALOG_TITLE = 'Delete Order?'
export const DELETE_ORDER_CONFIRM_LABEL = 'Delete Order'
export const DELETE_ORDER_BUSY_LABEL = 'Deleting…'

/** What goes with the Order, in the words the dialog shows. */
export const DELETE_ORDER_WARNING =
  'This permanently deletes the Order, the PI it was created from, their documents, '
  + 'versions, approvals and activity history. This action cannot be undone.'

/** What it never touches, said before the decision rather than after it. */
export const DELETE_ORDER_PAYMENTS_NOTE =
  'Payments are never deleted or changed here. If any payment is allocated to this Order '
  + 'or its PI, the deletion is refused and Finance must deal with it first.'

export type DeleteOrderViewer = {
  isAdmin: boolean
  /** An administrator previewing another person's view performs no action. */
  viewingAs: boolean
}

/** Whether the control is worth drawing. The database decides again. */
export function canDeleteOrder(viewer: DeleteOrderViewer): boolean {
  return viewer.isAdmin && !viewer.viewingAs
}

/** The typed confirmation must be the Order's own number, exactly. */
export function orderDeletionConfirmationMatches(
  typed: string,
  displayNumber: string | null | undefined,
): boolean {
  const expected = (displayNumber ?? '').trim()
  return expected !== '' && typed.trim() === expected
}

export type OrderDeletionCode =
  | 'DENIED'
  | 'MISSING'
  | 'CONFIRMATION'
  | 'BLOCKED_PAYMENTS'
  | 'BLOCKED_REQUESTS'
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'FAILED'

export type OrderDeletionFailure = {
  code: OrderDeletionCode
  message: string
  /** Nothing is wrong and pressing again will not help: another record is in the way. */
  blocked: boolean
}

const FAILURE_COPY: Record<OrderDeletionCode, Omit<OrderDeletionFailure, 'code'>> = {
  DENIED: { message: 'Only an administrator can delete an Order.', blocked: false },
  MISSING: { message: 'This Order has already been deleted.', blocked: false },
  CONFIRMATION: { message: 'The number you typed is not this Order’s number.', blocked: false },
  BLOCKED_PAYMENTS: {
    message: 'A payment is allocated to this Order or its PI, or a payment request is linked to it. '
      + 'Finance must reverse or remove that first; nothing has been deleted.',
    blocked: true,
  },
  BLOCKED_REQUESTS: {
    message: 'A retired Order Request was converted into this Order, so it is kept. Nothing has been deleted.',
    blocked: true,
  },
  NOT_CONFIGURED: {
    message: 'Deleting an Order is not configured on this deployment. Nothing has been deleted.',
    blocked: false,
  },
  UNAUTHORIZED: { message: 'Sign in again to delete this Order.', blocked: false },
  BAD_REQUEST: { message: 'The request could not be read. Nothing has been deleted.', blocked: false },
  FAILED: { message: 'This Order could not be deleted. Nothing has been deleted; try again.', blocked: false },
}

const DATABASE_MARKERS: readonly { marker: string; code: OrderDeletionCode }[] = [
  { marker: 'ORDER_DELETE_DENIED', code: 'DENIED' },
  { marker: 'ORDER_DELETE_MISSING', code: 'MISSING' },
  { marker: 'ORDER_DELETE_CONFIRMATION', code: 'CONFIRMATION' },
  { marker: 'ORDER_DELETE_BLOCKED_PAYMENTS', code: 'BLOCKED_PAYMENTS' },
  { marker: 'ORDER_DELETE_BLOCKED_REQUESTS', code: 'BLOCKED_REQUESTS' },
]

/** A database error becomes a stable code. Nothing of its text is ever echoed. */
export function classifyOrderDeletionError(message: string | null | undefined): OrderDeletionCode {
  const text = message ?? ''
  return DATABASE_MARKERS.find(entry => text.includes(entry.marker))?.code ?? 'FAILED'
}

export function describeOrderDeletionFailure(code: unknown): OrderDeletionFailure {
  const known = (typeof code === 'string' && code in FAILURE_COPY ? code : 'FAILED') as OrderDeletionCode
  return { code: known, ...FAILURE_COPY[known] }
}

/** HTTP status for each code. */
export const ORDER_DELETION_HTTP: Record<OrderDeletionCode, number> = {
  DENIED: 403,
  MISSING: 404,
  CONFIRMATION: 422,
  BLOCKED_PAYMENTS: 409,
  BLOCKED_REQUESTS: 409,
  NOT_CONFIGURED: 500,
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  FAILED: 500,
}
