// Which actions a Confirmed Payments row offers, and how wide that makes its
// Actions column.
//
// WHY THIS IS A MODULE AND NOT SIX JSX GUARDS
//
// The column has a declared width, and the icons inside it must fit that width
// on one line. That is arithmetic over the MAXIMUM number of icons a row can
// show at once — so something has to be able to answer "what is that maximum?"
// without a person counting call sites by eye.
//
// It was counted by eye, and the count was wrong twice: the actions were
// reported as "six fit the 110px column" when six never fit 110px, and then as
// a maximum of five on the assumption that Link and Unlink exclude each other.
// They do not — see below. The visibility rules therefore live here as one pure
// function, the component renders what it returns, and the width is COMPUTED
// from an exhaustive search over that function rather than asserted.
//
// LINK AND UNLINK ARE NOT MUTUALLY EXCLUSIVE, and this is the case the eye
// misses:
//
//   link   = canManage && !orderId
//   unlink = canManage && (orderId || orderRequestId) && paymentAgainst === 'new_order'
//
// A payment with `orderRequestId` set and `orderId` NULL satisfies BOTH. That
// is not hypothetical: `20261007000000` retired the Order Request workflow by
// refusing new writes, and deleted nothing, so historical payments parked on an
// Order Request are still readable — paymentClassification.ts describes exactly
// that row. The maximum is therefore SIX, not five.
//
// Whether a row should offer Link and Unlink at the same time is a product
// question, not a layout one. This module reports what the existing rules
// permit; it does not change them.

export const ROW_ACTION_KEYS = ['view', 'allocate', 'link', 'unlink', 'edit', 'delete'] as const
export type RowActionKey = (typeof ROW_ACTION_KEYS)[number]

/** Everything the visibility rules read. Nothing here is a permission decision
 *  of this module's own — each flag is resolved by its own capability helper at
 *  the call site and passed in. */
export type RowActionInput = {
  /** canAllocate && canOfferAllocateFunds(row) */
  offerAllocate: boolean
  /** finance.manage */
  canManage: boolean
  /** canDeleteRow(row) — admin-only, any status */
  canDelete: boolean
  orderId: string | null
  orderRequestId: string | null
  paymentAgainst: string | null
}

/**
 * The actions this row offers, in the order they are drawn.
 *
 * An action a reader may not take is ABSENT, never disabled: a greyed control
 * invites a click that will never work.
 */
export function visibleRowActions(input: RowActionInput): RowActionKey[] {
  const actions: RowActionKey[] = ['view']
  if (input.offerAllocate) actions.push('allocate')
  if (input.canManage && !input.orderId) actions.push('link')
  if (input.canManage
    && (input.orderId !== null || input.orderRequestId !== null)
    && input.paymentAgainst === 'new_order') actions.push('unlink')
  if (input.canManage) actions.push('edit')
  if (input.canDelete) actions.push('delete')
  return actions
}

// ── The column has to be as wide as the widest row it can draw ───────────────

/** The icon button's square target. Comfortable without being a toolbar button. */
export const ROW_ACTION_TARGET_PX = 28
/** Gap between adjacent icon buttons. */
export const ROW_ACTION_GAP_PX = 2
/** Horizontal padding on ONE side of a table cell — the `7px 10px` on TD. */
export const TABLE_CELL_PADDING_X_PX = 10

/** The icon group alone: n targets and the n-1 gaps between them. */
export function actionGroupWidthPx(count: number): number {
  if (count <= 0) return 0
  return count * ROW_ACTION_TARGET_PX + (count - 1) * ROW_ACTION_GAP_PX
}

/** The whole cell: the group plus the padding on both sides. */
export function actionsColumnWidthPx(count: number): number {
  return actionGroupWidthPx(count) + TABLE_CELL_PADDING_X_PX * 2
}

/**
 * The most actions any row can show at once, found by trying every combination
 * of the inputs rather than by reasoning about them.
 *
 * Six inputs, and only the three linkage fields have more than two interesting
 * values, so the whole space is small enough to enumerate exhaustively — which
 * is the point: a rule added or relaxed later moves this number by itself, and
 * the width assertion that reads it fails until the column is re-sized.
 */
export function maxSimultaneousRowActions(): number {
  const ids: (string | null)[] = [null, 'id']
  const againsts: (string | null)[] = [null, 'new_order', 'other']
  let most = 0
  for (const offerAllocate of [false, true]) {
    for (const canManage of [false, true]) {
      for (const canDelete of [false, true]) {
        for (const orderId of ids) {
          for (const orderRequestId of ids) {
            for (const paymentAgainst of againsts) {
              const count = visibleRowActions({
                offerAllocate, canManage, canDelete,
                orderId, orderRequestId, paymentAgainst,
              }).length
              if (count > most) most = count
            }
          }
        }
      }
    }
  }
  return most
}

/**
 * The declared width of the Actions column, wide enough for the widest row.
 *
 * Computed, not chosen: at the time of writing the maximum is six actions, so
 * 6 x 28 + 5 x 2 + 2 x 10 = 198px.
 */
export const ACTIONS_COLUMN_WIDTH_PX = actionsColumnWidthPx(maxSimultaneousRowActions())
