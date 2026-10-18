// Which actions a Confirmed Payments row offers, how each is drawn, and how
// wide that makes its Actions column.
//
// WHY THIS IS A MODULE AND NOT FOUR JSX GUARDS
//
// The column has a declared width, and what sits inside it must fit that width
// on one line. That is arithmetic over the WIDEST row the rules can produce —
// so something has to be able to answer "what is that widest row?" without a
// person counting call sites by eye. It was counted by eye twice and was wrong
// both times, which is why the width is COMPUTED here instead.
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

// REDESIGN 2026-10: the owner's order — View, Edit, Allocate, Delete — as icons.
export const ROW_ACTION_KEYS = ['view', 'edit', 'allocate', 'delete'] as const
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
  if (input.canManage) actions.push('edit')
  if (input.offerAllocate) actions.push('allocate')
  if (input.canDelete) actions.push('delete')
  return actions
}

// ── Where each action is drawn ───────────────────────────────────────────────
//
// REDESIGN 2026-10 (owner's request): every action is an ICON in its own fixed
// slot, in the order View, Edit, Allocate, Delete. Each icon carries a tooltip
// and an accessible name that names the payment. An action the reader may not
// take leaves its slot EMPTY rather than shifting the others, so each icon sits
// at the same x on every row. Delete is last, in red, and still opens its own
// confirmation.

export const INLINE_ROW_ACTIONS: readonly RowActionKey[] = ['view', 'edit', 'allocate', 'delete']
export const MENU_ROW_ACTIONS: readonly RowActionKey[] = []

/** A row's actions split by where they are drawn, each group in draw order. */
export function rowActionLayout(actions: readonly RowActionKey[]): {
  inline: RowActionKey[]
  menu: RowActionKey[]
} {
  return {
    inline: ROW_ACTION_KEYS.filter(a => actions.includes(a) && INLINE_ROW_ACTIONS.includes(a)),
    menu: ROW_ACTION_KEYS.filter(a => actions.includes(a) && MENU_ROW_ACTIONS.includes(a)),
  }
}

// ── The column has to be as wide as the widest row it can draw ───────────────
//
// Every width below is a FIXED size the CSS also sets (.boe-row-icon), so the
// arithmetic and the rendered row cannot disagree.

/** One icon button — a square, like every icon control in Finance. */
export const ROW_ACTION_TARGET_PX = 28
/** Gap between adjacent controls in the cell. */
export const ROW_ACTION_GAP_PX = 4
/** Horizontal padding on ONE side of a Confirmed Payments table cell. */
export const TABLE_CELL_PADDING_X_PX = 8

/** The controls alone: one square per action and the gaps between them. */
export function actionGroupWidthPx(actions: readonly RowActionKey[]): number {
  const n = rowActionLayout(actions).inline.length
  if (n === 0) return 0
  return n * ROW_ACTION_TARGET_PX + (n - 1) * ROW_ACTION_GAP_PX
}

/** The whole cell: the group plus the padding on both sides. */
export function actionsColumnWidthPx(actions: readonly RowActionKey[]): number {
  return actionGroupWidthPx(actions) + TABLE_CELL_PADDING_X_PX * 2
}

/** Every combination the visibility rules can distinguish — eight cases. */
export function allRowActionInputs(): RowActionInput[] {
  const out: RowActionInput[] = []
  for (const offerAllocate of [false, true])
    for (const canManage of [false, true])
      for (const canDelete of [false, true])
        out.push({ offerAllocate, canManage, canDelete })
  return out
}

/**
 * The widest group any row can draw, found by trying every combination of the
 * inputs rather than by reasoning about them.
 */
export function widestRowActions(): RowActionKey[] {
  let widest: RowActionKey[] = []
  for (const input of allRowActionInputs()) {
    const actions = visibleRowActions(input)
    if (actionGroupWidthPx(actions) > actionGroupWidthPx(widest)) widest = actions
  }
  return widest
}

/**
 * The declared width of the Actions column, wide enough for the widest row:
 * four squares and three gaps plus the cell padding — 4 x 28 + 3 x 4 + 2 x 8
 * = 140px.
 */
export const ACTIONS_COLUMN_WIDTH_PX = actionsColumnWidthPx(widestRowActions())
