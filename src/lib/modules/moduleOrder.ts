/**
 * PERSONAL MODULE-CARD ORDER — the whole decision, with no React in it.
 *
 * The launcher (src/app/modules/page.tsx) builds the cards this person may open
 * and has always rendered them in the order that array is written in. That order
 * is a reasonable default and a poor personal answer: whoever lives in Orders
 * all day reaches past four cards to get to it, and whoever lives in Finance
 * reaches past eight.
 *
 * WHAT IS PERSONAL AND WHAT IS NOT
 * --------------------------------
 * The ORDER is personal. WHICH CARDS EXIST is not, and nothing in this file can
 * change it: every function here takes the already-gated array as its input and
 * returns a PERMUTATION of it. A stored key that names a module this person may
 * not open is not a card — there is no entry to reorder, so the key is dropped
 * on the floor. That is the security-relevant property of this file, and it is
 * a consequence of the signature rather than of a check: nothing here can
 * invent a module, and `applyPersonalModuleOrder` returns only elements it was
 * given.
 *
 * WHY KEYS AND NOTHING ELSE
 * -------------------------
 * A stored preference is a list of `ModuleDef.key` strings — `orders`,
 * `finance`, `tasks`. Not titles, not routes, not icons, not module objects. A
 * title is a sentence somebody will rewrite; a route is a fact about the app
 * that a rename changes; an icon is a component. The key is the one thing about
 * a card that is meant to be stable, and it is already what React keys the grid
 * by and what `user_top_tasks` set the precedent for (an id and a position,
 * nothing more).
 *
 * THE FOUR RULES, IN ORDER
 * ------------------------
 *   1. The allowed set is built first, by the existing permission logic. This
 *      file is never asked whether somebody may open something.
 *   2. The saved order is applied to that set and to nothing else.
 *   3. A saved key that is no longer a card — retired module, revoked
 *      permission, renamed key — is ignored.
 *   4. An allowed card the saved order does not mention is APPENDED, in the
 *      canonical order it has in the array. So a module shipped after somebody
 *      last saved appears, at the end, rather than vanishing.
 *
 * Run:
 *   npx tsx --test src/lib/modules/moduleOrder.test.ts
 */

// ── The shape ordering needs ─────────────────────────────────────────────────

/**
 * Ordering needs a stable key and knows nothing else about a card. Declared
 * structurally rather than importing `ModuleDef` so that this file cannot grow
 * a dependency on a title, a route or a React node — the things it must never
 * read and must never store.
 */
export type OrderableModule = { key: string }

/**
 * The one table this feature reads or writes. Named here rather than spelled
 * into the query, so the migration, the hook and the tests all point at one
 * string.
 */
export const PERSONAL_MODULE_ORDER_TABLE = 'user_module_order'

/**
 * What a stored key is allowed to look like: the shape every `ModuleDef.key` in
 * the launcher has. Applied when READING the database as well as when writing,
 * because a row is data from outside the program even when this program is the
 * only thing that writes it.
 */
const MODULE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/

/**
 * Cap on a stored list. The launcher has thirteen cards; sixty-four is room for
 * a decade of new modules and still a bound, so a malformed or hostile row
 * cannot hand the grid an arbitrarily long list to walk. The database carries
 * the same cap as a check constraint — see
 * supabase/migrations/20261228000000_personal_module_order.sql.
 */
export const MAX_STORED_MODULE_KEYS = 64

// ── Reading what was stored ──────────────────────────────────────────────────

/**
 * A stored preference, validated into something safe to order by, or null when
 * there is nothing usable in it.
 *
 * Null means "no preference" and therefore "canonical order" — the same answer
 * a first-time user gets. There is deliberately no error path: a preference is
 * a convenience, and a row that has somehow become nonsense must degrade to the
 * default launcher rather than break the screen somebody signs in to.
 *
 * Duplicates are collapsed to their FIRST occurrence, which is the position the
 * person put the card in.
 */
export function normalizeStoredModuleOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null

  const seen = new Set<string>()
  const keys: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    if (!MODULE_KEY_RE.test(entry)) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    keys.push(entry)
    if (keys.length >= MAX_STORED_MODULE_KEYS) break
  }

  return keys.length > 0 ? keys : null
}

// ── Applying it ──────────────────────────────────────────────────────────────

/**
 * The gated cards, rearranged to this person's saved order.
 *
 * A NEW ARRAY, ALWAYS. The canonical array is never sorted, spliced or
 * otherwise touched: it is the application's own default order and the fallback
 * for everybody who has saved nothing, so mutating it would make one person's
 * preference everybody's.
 */
export function applyPersonalModuleOrder<T extends OrderableModule>(
  canonical: readonly T[],
  savedOrder: readonly string[] | null | undefined,
): T[] {
  if (!savedOrder || savedOrder.length === 0) return [...canonical]

  // Keyed by what the card IS, so a saved key can only ever select one of these
  // and can never introduce anything else. A duplicate key in the canonical
  // array (which would be a bug in the launcher) keeps its first card.
  const byKey = new Map<string, T>()
  for (const mod of canonical) if (!byKey.has(mod.key)) byKey.set(mod.key, mod)

  const placed = new Set<string>()
  const ordered: T[] = []

  // RULE 2 and RULE 3. `byKey.get` returning nothing IS rule 3: a saved key
  // that no longer names an accessible card contributes no entry.
  for (const key of savedOrder) {
    if (placed.has(key)) continue
    const mod = byKey.get(key)
    if (!mod) continue
    placed.add(key)
    ordered.push(mod)
  }

  // RULE 4. Whatever the saved order did not mention, in the canonical order it
  // already had — walking `canonical` rather than the map, because insertion
  // order is the default order and reading it from the array is what makes that
  // obvious.
  for (const mod of canonical) if (!placed.has(mod.key)) ordered.push(mod)

  return ordered
}

/** The keys of an arrangement, in order: exactly what gets stored. */
export function moduleOrderKeys(modules: readonly OrderableModule[]): string[] {
  return modules.map(mod => mod.key)
}

/** Whether two arrangements are the same list in the same order. */
export function moduleOrderEquals(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

// ── Rearranging ──────────────────────────────────────────────────────────────

/**
 * `key` moved `delta` places, clamped at both ends. The keyboard path: one press
 * is one position, and a press at the end of the list is a no-op rather than a
 * wrap, because a card that leaps from last to first on an arrow press is not
 * what anybody meant.
 *
 * A key that is not in the list returns the list unchanged — the caller is a
 * rendered handle, and a handle for a card that has just disappeared (a
 * permission revoked in another tab) must not throw.
 */
export function moveModuleKey(
  order: readonly string[],
  key: string,
  delta: number,
): string[] {
  const from = order.indexOf(key)
  if (from < 0 || delta === 0) return [...order]

  const to = Math.min(order.length - 1, Math.max(0, from + delta))
  if (to === from) return [...order]

  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, key)
  return next
}

/**
 * `key` moved into the slot `targetKey` currently occupies. The pointer path:
 * while a handle is held, the card under the pointer names the slot the dragged
 * card should take, and the rest of the grid closes up behind it.
 *
 * THE TARGET INDEX IS THE ONE IN THE LIST AS IT STANDS, read before the dragged
 * key is removed. Reading it afterwards lands a downward drag one slot short of
 * the pointer, which feels like the card refusing to go where it was put.
 */
export function moveModuleKeyToSlotOf(
  order: readonly string[],
  key: string,
  targetKey: string,
): string[] {
  if (key === targetKey) return [...order]
  const from = order.indexOf(key)
  const to   = order.indexOf(targetKey)
  if (from < 0 || to < 0) return [...order]

  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, key)
  return next
}

// ── Edit mode, as a reducer ──────────────────────────────────────────────────
//
// The four things edit mode has to get right are all state transitions, so they
// are written as one, here, where they can be tested without a browser:
//
//   CANCEL   goes back to the arrangement that was on screen when edit mode
//            opened, and writes nothing.
//   RESET    puts the application's canonical order in the working arrangement
//            and leaves edit mode open — the person still presses Save. The
//            launcher has no convention for an immediate destructive write and
//            this is not the place to invent one.
//   SAVE     that FAILS keeps the arrangement and keeps edit mode open. Losing
//            somebody's rearrangement because a request failed is the one
//            outcome worth writing a reducer to prevent.
//   SAVE     that succeeds closes edit mode.

export type ModuleOrderEditState = {
  /**
   * The arrangement being edited, or null when not editing. This is also the
   * flag: `working !== null` IS edit mode, so there is no second boolean that
   * could disagree with it.
   */
  working: string[] | null
  /** What was on screen when edit mode opened. What Cancel restores. */
  baseline: string[] | null
  /** A save is in flight: the controls disable and drags stop. */
  saving: boolean
  /** The retryable message under the controls. Null when there is nothing wrong. */
  error: string | null
  /** The card currently held by a pointer, for the drag feedback. */
  dragging: string | null
}

export const IDLE_MODULE_ORDER_EDIT: ModuleOrderEditState = {
  working: null,
  baseline: null,
  saving: false,
  error: null,
  dragging: null,
}

export type ModuleOrderEditAction =
  /** Enter edit mode on the arrangement currently rendered. */
  | { type: 'open'; order: readonly string[] }
  /** Keyboard: move one card by one or more positions. */
  | { type: 'move'; key: string; delta: number }
  /** Pointer: move one card into another's slot. */
  | { type: 'moveToSlotOf'; key: string; targetKey: string }
  /** Restore the application's default order, still unsaved. */
  | { type: 'reset'; canonical: readonly string[] }
  /** Leave edit mode, writing nothing. */
  | { type: 'cancel' }
  | { type: 'saveStart' }
  | { type: 'saveFailed'; message: string }
  | { type: 'saveSucceeded' }
  | { type: 'dragStart'; key: string }
  | { type: 'dragEnd' }

export function moduleOrderEditReducer(
  state: ModuleOrderEditState,
  action: ModuleOrderEditAction,
): ModuleOrderEditState {
  switch (action.type) {
    case 'open':
      return {
        working: [...action.order],
        // The SAME list, held separately. Every rearrangement below replaces
        // `working` with a new array and never touches `baseline`, so Cancel
        // has something to go back to however many moves happened.
        baseline: [...action.order],
        saving: false,
        error: null,
        dragging: null,
      }

    // A rearrangement DURING a save is ignored rather than queued: the request
    // in flight carries the list as it was, and accepting a move now would
    // leave the screen holding an arrangement the confirmation does not
    // describe.
    case 'move':
      if (!state.working || state.saving) return state
      return { ...state, working: moveModuleKey(state.working, action.key, action.delta) }

    case 'moveToSlotOf':
      if (!state.working || state.saving) return state
      return {
        ...state,
        working: moveModuleKeyToSlotOf(state.working, action.key, action.targetKey),
      }

    // Still unsaved, and the error clears: whatever went wrong last time was
    // about a list this is no longer offering.
    case 'reset':
      if (!state.working || state.saving) return state
      return { ...state, working: [...action.canonical], error: null }

    // WRITES NOTHING. Returning to idle is the restore: the grid outside edit
    // mode renders the SAVED order, which is what baseline was taken from and
    // which no rearrangement above has touched. See `visibleModuleOrder`.
    case 'cancel':
      if (state.saving) return state
      return { ...IDLE_MODULE_ORDER_EDIT }

    case 'saveStart':
      if (!state.working) return state
      return { ...state, saving: true, error: null, dragging: null }

    // THE ARRANGEMENT SURVIVES. `working` is carried through untouched and edit
    // mode stays open, so the person sees what they arranged and a message they
    // can act on rather than the old order and a toast.
    case 'saveFailed':
      if (!state.working) return state
      return { ...state, saving: false, error: action.message }

    case 'saveSucceeded':
      return { ...IDLE_MODULE_ORDER_EDIT }

    case 'dragStart':
      if (!state.working || state.saving) return state
      return { ...state, dragging: action.key }

    case 'dragEnd':
      return state.dragging === null ? state : { ...state, dragging: null }
  }
}

// ── What a card and a handle DO ──────────────────────────────────────────────
//
// Three decisions that belong to the UI and are nonetheless pure, so they live
// here where a test can call them instead of reading the JSX as text. The card
// and the handle are declared in files that import a CSS module, which `tsx
// --test` cannot resolve (the repository tests those by reading their source),
// so a decision left inline there could only ever be pattern-matched. These are
// executed.

/** Everything a launcher card needs to be — or not be — a button. */
/** The keyboard event this needs, and nothing a test cannot construct. */
export type ModuleCardKeyEvent = { key: string; preventDefault: () => void }

export type ModuleCardPressProps = {
  onClick: (() => void) | undefined
  role: 'button' | undefined
  tabIndex: 0 | undefined
  onKeyDown: ((event: ModuleCardKeyEvent) => void) | undefined
}

/**
 * THE WHOLE CARD IS THE BUTTON, and in normal mode that is unchanged: a click
 * anywhere on it navigates, it is in the tab order, and Enter or Space opens it.
 *
 * ENTER AND SPACE, because role="button" promises both — a native <button> fires
 * on either and a screen-reader user is told this is a button. Space is also the
 * browser's page-scroll key, so both are preventDefault-ed: without that,
 * activating a focused card would open the module AND scroll the launcher behind
 * it. That behaviour arrived with the card-surface work on main; it lives here
 * rather than inline in the JSX so a test executes it instead of matching it.
 *
 * IN EDIT MODE IT IS NOT A BUTTON AT ALL. `navigate` arrives null and every one
 * of these is undefined — no handler, no role, nothing focusable, no Enter and
 * no Space. That is what stops a drag ending in a navigation, and it is stronger
 * than a handler that checks a flag: there is nothing left to fire.
 */
export function moduleCardPressProps(navigate: (() => void) | null): ModuleCardPressProps {
  if (!navigate) {
    return { onClick: undefined, role: undefined, tabIndex: undefined, onKeyDown: undefined }
  }
  return {
    onClick: navigate,
    role: 'button',
    tabIndex: 0,
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      navigate()
    },
  }
}

/**
 * How far a keypress on a drag handle moves the card, or 0 for a key that is
 * none of the handle's business.
 *
 * BOTH AXES. The grid is columns on a desktop and two-up rows on a phone, so
 * "earlier" is Left on one and Up on the other and there is no width at which
 * only one pair is right. Home and End move a card to the ends; `moveModuleKey`
 * clamps, so overshooting by `total` lands exactly at the edge.
 */
export function moduleReorderKeyDelta(key: string, total: number): number {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return -1
    case 'ArrowRight':
    case 'ArrowDown':
      return 1
    case 'Home':
      return -total
    case 'End':
      return total
    default:
      return 0
  }
}

/**
 * A handle's accessible label. "Reorder Finance, position 8 of 13" names the
 * control, the card it moves and where that card is — without the position, an
 * arrow press has no audible effect at all.
 */
export function moduleDragHandleLabel(title: string, position: number, total: number): string {
  return `Reorder ${title}, position ${position} of ${total}. Use the arrow keys to move it.`
}

/**
 * The arrangement the grid renders — the one place the two orders meet.
 *
 * While editing it is the working arrangement. Otherwise it is the saved
 * preference applied to the gated cards, which is both the normal-mode answer
 * and, because nothing in edit mode writes to it, exactly what Cancel goes back
 * to.
 *
 * Either way the result is a permutation of `canonical`: the working
 * arrangement is a list of keys, and a key that does not name a gated card
 * selects nothing.
 */
export function visibleModuleOrder<T extends OrderableModule>(
  canonical: readonly T[],
  savedOrder: readonly string[] | null | undefined,
  working: readonly string[] | null,
): T[] {
  return applyPersonalModuleOrder(canonical, working ?? savedOrder)
}
