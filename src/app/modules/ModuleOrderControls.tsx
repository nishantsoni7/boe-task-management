'use client'

import { useRef } from 'react'
import { GripVertical, ArrowUpDown, RotateCcw, Check, X } from 'lucide-react'
import { moduleDragHandleLabel, moduleReorderKeyDelta } from '@/lib/modules/moduleOrder'
import styles from './modules.module.css'

/**
 * EDIT ORDER — the controls, the handle, and the pointer drag.
 *
 * Split out of page.tsx so the launcher keeps reading as "what may this person
 * open", and so the pieces that decide what a handle SAYS can be rendered in a
 * test without the page's eleven hooks.
 *
 * ── NOTHING SHOWS UNTIL IT IS ASKED FOR ────────────────────────────────────
 *
 * Normal mode is one quiet text button beside the Modules heading. No handles,
 * no arrows, no chrome on the cards — a launcher is used far more often than it
 * is rearranged, and permanent editing furniture on thirteen cards would make
 * every visit pay for a thing somebody does twice a year.
 *
 * ── MOUSE, TOUCH AND KEYBOARD, ON ONE HANDLE ───────────────────────────────
 *
 * The handle is a real <button>, so it is in the tab order and takes arrow keys
 * for free. The drag is POINTER events, which is the whole reason there is no new
 * dependency and no HTML5 drag-and-drop here: `pointerdown`/`pointermove` are one
 * code path for a mouse, a finger and a stylus, while HTML5 `dragstart` is not
 * fired by touch at all on mobile Safari or Chrome for Android — a drag that only
 * works on a desktop is not the feature.
 *
 * `touch-action: none` on the handle (modules.module.css) is what stops the page
 * scrolling under a finger that is holding it. It is scoped to the 24-pixel
 * handle, so the rest of the card — and the rest of the page — scrolls normally
 * even in edit mode.
 */

// ── The handle ───────────────────────────────────────────────────────────────

export type ModuleDragHandleProps = {
  /** The card this handle belongs to, named in the accessible label. */
  moduleKey: string
  title: string
  /** 1-based, for the label. Somebody using a screen reader needs to hear where the card went. */
  position: number
  total: number
  disabled: boolean
  /** Keyboard: move this card by `delta` places. */
  onMove: (key: string, delta: number) => void
  /** Pointer: begin a drag. Supplied by useModuleReorderPointer. */
  onPointerDown: (key: string, event: React.PointerEvent<HTMLElement>) => void
}

export function ModuleDragHandle({
  moduleKey, title, position, total, disabled, onMove, onPointerDown,
}: ModuleDragHandleProps) {
  const label = moduleDragHandleLabel(title, position, total)

  return (
    <button
      type="button"
      className={styles.dragHandle}
      aria-label={label}
      title={label}
      disabled={disabled}
      // A grabbable thing, announced as one. The card behind it is no longer a
      // button in edit mode, so this is the only control on it.
      aria-roledescription="sortable"
      data-module-drag-handle={moduleKey}
      onPointerDown={e => onPointerDown(moduleKey, e)}
      // The card's own click handler is removed in edit mode, but the handle
      // stops its events anyway: this must never be one keystroke away from
      // opening a module.
      onClick={e => { e.preventDefault(); e.stopPropagation() }}
      onKeyDown={e => {
        if (disabled) return
        // Left/Up move the card earlier, Right/Down move it later — both pairs,
        // because the grid is columns on a desktop and rows on a phone and the
        // direction a card travels depends on which. The mapping is in
        // src/lib/modules/moduleOrder.ts so that it is executed by a test rather
        // than pattern-matched in this file.
        const delta = moduleReorderKeyDelta(e.key, total)
        if (delta === 0) return
        // Arrow keys scroll a page and Home/End jump it. Neither may happen
        // while they are moving a card.
        e.preventDefault()
        e.stopPropagation()
        onMove(moduleKey, delta)
      }}
    >
      <GripVertical size={15} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}

// ── The pointer drag ─────────────────────────────────────────────────────────

/**
 * Turns a held handle into "the card under the pointer names the slot this card
 * should take".
 *
 * WHY HIT-TESTING RATHER THAN A GHOST THAT FOLLOWS THE CURSOR. The cards are a
 * responsive CSS grid — `auto-fill, minmax(240px, 1fr)` on a desktop, two fixed
 * columns on a phone — so there are no item coordinates to interpolate between
 * and the number of columns changes with the window. `elementFromPoint` asks the
 * layout where the pointer actually is, which is correct at every width without
 * measuring anything, and the rearrangement is the real grid reflowing rather
 * than a floating copy: the gap the dragged card leaves IS the placeholder.
 *
 * THE POINTER IS CAPTURED by the handle, so a drag that leaves the grid, crosses
 * the sidebar or ends outside the window still ends — `pointercancel` and
 * `pointerup` both land on the element that holds the capture.
 */
export function useModuleReorderPointer({
  enabled,
  onMoveToSlotOf,
  onDragStart,
  onDragEnd,
}: {
  enabled: boolean
  onMoveToSlotOf: (key: string, targetKey: string) => void
  onDragStart: (key: string) => void
  onDragEnd: () => void
}) {
  // Survives the re-renders each reorder causes, so one press is one drag.
  const active = useRef<number | null>(null)

  return (key: string, event: React.PointerEvent<HTMLElement>) => {
    if (!enabled) return
    // Secondary and middle buttons open menus and paste; neither is a drag.
    if (event.button !== 0 && event.pointerType === 'mouse') return
    if (active.current !== null) return

    // Stops the press selecting the card's text, and stops it reaching the card.
    event.preventDefault()
    event.stopPropagation()

    const handle = event.currentTarget
    const pointerId = event.pointerId
    active.current = pointerId
    // Every subsequent event for this pointer comes to `handle`, whatever it is
    // over — including outside the document.
    try { handle.setPointerCapture(pointerId) } catch { /* capture is a nicety, not a requirement */ }
    onDragStart(key)

    const startX = event.clientX
    const startY = event.clientY
    let moved = false

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      // A TAP IS NOT A DRAG. Four pixels of travel before anything reorders, so
      // a finger that lands slightly off-centre on the handle does not shuffle
      // the grid.
      if (!moved) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return
        moved = true
      }
      // What is under the pointer, and which card is it part of? Reading the key
      // off the DOM keeps this ignorant of the order and of the grid's shape.
      const over = document.elementFromPoint(ev.clientX, ev.clientY)
      const card = over instanceof Element
        ? (over.closest('[data-module-key]') as HTMLElement | null)
        : null
      const targetKey = card?.dataset.moduleKey
      if (!targetKey || targetKey === key) return
      onMoveToSlotOf(key, targetKey)
    }

    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      try { handle.releasePointerCapture(pointerId) } catch { /* already released */ }
      active.current = null
      onDragEnd()
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  }
}

// ── The bar beside the heading ───────────────────────────────────────────────

export type ModuleOrderBarProps = {
  editing: boolean
  saving: boolean
  /** The retryable message. Null when nothing is wrong. */
  error: string | null
  /** Whether the working arrangement differs from what is stored. */
  dirty: boolean
  onEdit: () => void
  onSave: () => void
  onCancel: () => void
  onReset: () => void
}

/**
 * Normal mode: one text button. Edit mode: Save, Cancel, Reset to default, a
 * one-line instruction and — when a save has failed — the message, still beside
 * the arrangement it belongs to.
 *
 * INLINE, NOT A MODAL. The thing being rearranged is the grid itself; lifting it
 * into a dialog would mean either drawing the cards twice or rearranging a list
 * of names that is not what the person is looking at. Nothing about the
 * launcher's architecture makes editing in place unsafe — the cards are already
 * a client-rendered array, and edit mode only changes which props they get.
 */
export function ModuleOrderBar({
  editing, saving, error, dirty, onEdit, onSave, onCancel, onReset,
}: ModuleOrderBarProps) {
  if (!editing) {
    return (
      <button
        type="button"
        className={styles.orderEditButton}
        onClick={onEdit}
        aria-label="Edit the order of your module cards"
      >
        <ArrowUpDown size={13} strokeWidth={2} aria-hidden="true" />
        Edit order
      </button>
    )
  }

  return (
    <div className={styles.orderEditing}>
      <div className={styles.orderActions}>
        {/* Reset first, Cancel and Save last: the two that end edit mode sit
            together, and the destructive-looking one is furthest from Save. */}
        <button
          type="button"
          className={styles.orderButton}
          onClick={onReset}
          disabled={saving}
          aria-label="Reset the card order to the default. You still need to save."
        >
          <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
          Reset to default
        </button>
        <button
          type="button"
          className={styles.orderButton}
          onClick={onCancel}
          disabled={saving}
          aria-label="Cancel and restore the order you had before editing"
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
          Cancel
        </button>
        <button
          type="button"
          className={styles.orderButtonPrimary}
          onClick={onSave}
          // Nothing to save is not an error, and a disabled Save says so more
          // clearly than a confirmation that nothing happened. A failed save
          // leaves `dirty` true, so the retry is always available.
          disabled={saving || !dirty}
          aria-label="Save this card order"
        >
          <Check size={13} strokeWidth={2} aria-hidden="true" />
          {saving ? 'Saving…' : 'Save order'}
        </button>
      </div>

      {/* The instruction, once, rather than a tooltip on thirteen handles. */}
      <div className={styles.orderHint}>
        Drag a card by its handle, or focus a handle and use the arrow keys.
      </div>

      {/* THE FAILURE, WHERE THE ARRANGEMENT STILL IS. Announced, so it is not
          only a colour; and it does not replace the buttons, because the point
          of keeping edit mode open is that Save is still there to press. */}
      {error && (
        <div className={styles.orderError} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
