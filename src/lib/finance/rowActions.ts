// Which actions a Confirmed Payments row offers, and how wide that makes its
// Actions column.
//
// WHY THIS IS A MODULE AND NOT FOUR JSX GUARDS
//
// The column has a declared width, and the icons inside it must fit that width
// on one line. That is arithmetic over the MAXIMUM number of icons a row can
// show at once — so something has to be able to answer "what is that maximum?"
// without a person counting call sites by eye. It was counted by eye twice and
// was wrong both times, which is why the width is COMPUTED here instead.
//
// ATTACHING MONEY IS ALLOCATION, AND ONLY ALLOCATION. Link to an Order and
// Unlink are gone: one payment could only ever point at one Order, so they
// could not express a partial attachment, a split across several records, a
// mixed PI-Draft/Order division, or a remaining unallocated balance. The
// allocation ledger expresses all five, so it is the single attachment
// workflow and these four are the whole action set.
//
// The linkage inputs went with them — a row's actions no longer depend on
// `order_id`, `order_request_id` or `payment_against` at all.

export const ROW_ACTION_KEYS = ['view', 'allocate', 'edit', 'delete'] as const
export type RowActionKey = (typeof ROW_ACTION_KEYS)[number]

/** Everything the visibility rules read. Nothing here is a permission decision
 *  of this module's own — each flag is resolved by its own capability helper at
 *  the call site and passed in. */
export type RowActionInput = {
  /** canAllocate && canOfferAllocateFunds(row) — permission AND allocatable balance */
  offerAllocate: boolean
  /** finance.manage */
  canManage: boolean
  /** canDeleteRow(row) — admin-only, any status */
  canDelete: boolean
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
 * Three independent booleans, so the whole space is eight cases — small enough
 * to enumerate outright, which is the point: an action added or a rule relaxed
 * later moves this number by itself, and the width assertion that reads it
 * fails until the column is re-sized.
 */
export function maxSimultaneousRowActions(): number {
  let most = 0
  for (const offerAllocate of [false, true]) {
    for (const canManage of [false, true]) {
      for (const canDelete of [false, true]) {
        const count = visibleRowActions({ offerAllocate, canManage, canDelete }).length
        if (count > most) most = count
      }
    }
  }
  return most
}

/**
 * The declared width of the Actions column, wide enough for the widest row.
 *
 * Computed, not chosen: the maximum is four actions, so
 * 4 x 28 + 3 x 2 + 2 x 10 = 138px.
 */
export const ACTIONS_COLUMN_WIDTH_PX = actionsColumnWidthPx(maxSimultaneousRowActions())
