// Where a row's overflow menu goes, so that all of it is on screen.
//
// WHY THIS IS A MODULE, AND WHY IT IS PURE
//
// The Finance tables sit inside `.boe-card`, which carries `overflow: hidden`
// to keep rows from bleeding past its rounded corners. An absolutely-positioned
// menu is clipped by any ancestor whose overflow is not `visible`, so the menu
// on the LAST row was cut off at the card's bottom edge — the actions below
// "Allocate Funds" were rendered and unreachable. It also always opened
// downward, with no flip.
//
// The escape is to render the panel through a portal, positioned `fixed` — but
// then something has to decide the coordinates, and that decision is the part
// worth testing. It is arithmetic over four rectangles, so it lives here, with
// no React and no DOM, and the component below it only measures and paints.
//
// COORDINATES ARE VIEWPORT-RELATIVE, which is exactly what
// getBoundingClientRect() returns and exactly what `position: fixed` consumes.
// No scroll offset is added anywhere; adding one is the classic way this breaks.

/** The trigger's box, as getBoundingClientRect() gives it. */
export type AnchorRect = {
  top: number
  bottom: number
  left: number
  right: number
}

export type MenuPlacementInput = {
  anchor: AnchorRect
  /** Measured size of the menu panel. */
  menuWidth: number
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  /** Space between the trigger and the panel. */
  gap?: number
  /** Smallest distance the panel may sit from a viewport edge. */
  margin?: number
}

export type MenuPlacement = {
  top: number
  left: number
  /** Which side of the trigger the panel ended up on. */
  placement: 'below' | 'above'
}

export const MENU_GAP = 4
export const MENU_MARGIN = 8

/**
 * Place the panel below the trigger, or above it when below does not fit.
 *
 * THE RULES, in order:
 *
 * 1. BELOW IS PREFERRED. It is where a menu is expected, and on every row but
 *    the last few it fits.
 * 2. FLIP ONLY IF ABOVE IS GENUINELY BETTER. A short viewport can fail both
 *    ways; flipping into an even smaller space would trade a clipped bottom for
 *    a clipped top and move the first action off screen instead of the last.
 *    So the flip happens only when below overflows AND above has more room.
 * 3. CLAMP LAST. Whichever side wins, the panel is pushed back inside the
 *    viewport if it still pokes out — the panel stays whole and merely sits
 *    closer to the trigger than the gap asked for. Clamping the top is done
 *    after clamping the bottom so that, when the panel is taller than the
 *    viewport, the TOP edge is the one that survives: a menu is read from its
 *    first item down.
 *
 * Horizontal placement mirrors the old `right: 0` — the panel's right edge
 * lines up with the trigger's — then clamps into the viewport, which is what
 * keeps a right-hand Actions column from pushing the panel off screen.
 */
export function placeMenu({
  anchor,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  gap = MENU_GAP,
  margin = MENU_MARGIN,
}: MenuPlacementInput): MenuPlacement {
  const roomBelow = viewportHeight - anchor.bottom - gap - margin
  const roomAbove = anchor.top - gap - margin

  const fitsBelow = menuHeight <= roomBelow
  const placement: 'below' | 'above' =
    fitsBelow || roomAbove <= roomBelow ? 'below' : 'above'

  let top = placement === 'below'
    ? anchor.bottom + gap
    : anchor.top - gap - menuHeight

  // Bottom first, then top — see rule 3.
  if (top + menuHeight > viewportHeight - margin) top = viewportHeight - margin - menuHeight
  if (top < margin) top = margin

  let left = anchor.right - menuWidth
  if (left + menuWidth > viewportWidth - margin) left = viewportWidth - margin - menuWidth
  if (left < margin) left = margin

  return { top, left, placement }
}
