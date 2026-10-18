'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, MoreHorizontal, Pencil, Split, Trash2, type LucideIcon } from 'lucide-react'
import { placeMenu, type MenuPlacement } from '@/lib/ui/menuPlacement'
import { ROW_ACTION_GAP_PX, rowActionLayout, type RowActionKey } from '@/lib/finance/rowActions'
import { colors } from '@/lib/tokens'
import { PAYMENT_DELETE_CONFIRM_LABEL } from '@/lib/finance/paymentDeletion'
import { ALLOCATE_FUNDS_ACTION_LABEL } from './AllocateFundsModal'
import { PaymentRequest } from './receivedPaymentsModel'

export type RowActionMeta = Record<RowActionKey, {
  Icon: LucideIcon
  /** The visible words. */
  text: string
  /** The accessible name, naming the payment. */
  label: (r: PaymentRequest) => string
  run: (r: PaymentRequest) => void
  danger?: boolean
}>

export function rowActionMeta({ onView, onAllocateFunds, onEdit, onDelete }: {
  onView: (r: PaymentRequest) => void
  onAllocateFunds: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
  onDelete: (r: PaymentRequest) => void
}): RowActionMeta {
  return {
    view: {
      Icon: Eye,
      text: 'View',
      label: r => `View details for ${r.human_payment_id ?? 'this payment'}`,
      run: r => onView(r),
    },
    allocate: {
      Icon: Split,
      text: 'Allocate',
      label: r => `${ALLOCATE_FUNDS_ACTION_LABEL} for ${r.human_payment_id ?? 'this payment'}`,
      run: r => onAllocateFunds(r),
    },
    edit: {
      Icon: Pencil,
      text: 'Edit payment',
      label: r => `Edit ${r.human_payment_id ?? 'this payment'}`,
      run: r => onEdit(r),
    },
    // Drawn last, in red, behind its own confirmation — and never beside View.
    delete: {
      Icon: Trash2,
      text: PAYMENT_DELETE_CONFIRM_LABEL,
      label: r => `${PAYMENT_DELETE_CONFIRM_LABEL} ${r.human_payment_id ?? 'this payment'}`,
      run: r => onDelete(r),
      danger: true,
    },
  }
}

/**
 * A row's actions: the routine ones as WORDS, the rest behind "More actions".
 *
 * View is always a labelled button; Allocate is one whenever the payment has
 * money left to place. Edit and Delete live in the menu, Delete last and in
 * red, so destroying a payment is never the same kind of control as viewing
 * one, never beside it, and never one mis-aimed click away. See
 * lib/finance/rowActions.ts for the split and for the width it adds up to.
 *
 * It decides NO permission. `actions` is the row's own visibleRowActions()
 * answer; an action the reader may not take is not rendered at all.
 */
export function PaymentRowActions({ row, actions, meta, slots = false }: {
  row: PaymentRequest
  actions: readonly RowActionKey[]
  meta: RowActionMeta
  /**
   * TABLE ROWS: every control in a fixed slot — View at the left edge of the
   * cell, Allocate beside it, More pinned to the right edge — so each one sits
   * at the same x on every row and the column reads as a column. Right-aligning
   * the whole group made View jump sideways wherever Allocate was absent.
   */
  slots?: boolean
}) {
  const { inline, menu } = rowActionLayout(actions)
  return (
    <div
      className={`boe-row-actions${slots ? ' boe-row-actions--slots' : ''}`}
      style={{ gap: `${ROW_ACTION_GAP_PX}px` }}
      // The row opens the record on click; an action must not also do that.
      onClick={e => e.stopPropagation()}
    >
      {inline.map(key => (
        <button
          key={key}
          type="button"
          className={`boe-row-action boe-row-action--${key}`}
          aria-label={meta[key].label(row)}
          onClick={event => { event.stopPropagation(); meta[key].run(row) }}
        >
          {meta[key].text}
        </button>
      ))}
      {menu.length > 0 && (
        <span className="boe-row-actions-menu">
          <RowActionsMenu
            label={`More actions for ${row.human_payment_id ?? 'this payment'}`}
            actions={menu.map(key => ({
              label: meta[key].text,
              onSelect: () => meta[key].run(row),
              danger: meta[key].danger,
              Icon: meta[key].Icon,
            }))}
          />
        </span>
      )}
    </div>
  )
}

export function RowActionsMenu({ label, actions }: {
  label: string
  /** `danger` marks a destructive entry, which is drawn in red and sits last. */
  actions: { label: string; onSelect: () => void; danger?: boolean; Icon?: LucideIcon }[]
}) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Measured after paint, so the panel's real height decides the flip rather
  // than a guess. Re-measured on scroll and resize because the panel is fixed
  // and the row underneath it is not: without this, scrolling the page would
  // leave the menu behind.
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (!trigger || !panel) return
      setPlacement(placeMenu({
        anchor: trigger.getBoundingClientRect(),
        menuWidth: panel.offsetWidth,
        menuHeight: panel.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }))
    }
    reposition()
    // `true` for capture: a scroll inside the table or any other scrollable
    // ancestor does not bubble, and each of them moves the row.
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  if (actions.length === 0) return null

  const panel = (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      style={{
        position: 'fixed',
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        // Above the app shell and any card, and out of every card's stacking
        // context because the panel is a child of <body>.
        zIndex: 1000,
        // Hidden for the one frame between mount and measurement, so it cannot
        // be seen at 0,0 before placeMenu has run.
        visibility: placement ? 'visible' : 'hidden',
        background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 8,
        boxShadow: '0 6px 20px rgba(48,53,54,0.12)', minWidth: 150, padding: 4,
      }}
    >
      {actions.map((action, index) => (
        <Fragment key={action.label}>
        {/* A rule above the destructive entry: it sits apart from the
            ordinary ones as well as below them. */}
        {action.danger && index > 0 && <div role="separator" className="boe-menu-separator" />}
        <button
          role="menuitem"
          // Hover and focus-visible live in globals.css (.boe-menu-item), because
          // neither can be written as an inline style — and a keyboard user must
          // see which action Enter will run, not only a mouse user. The class
          // carries the same padding, font size and radius the inline style did,
          // so the panel measures the same and opens in the same place.
          className={`boe-menu-item${action.danger ? ' boe-menu-item--danger' : ''}`}
          onClick={() => { setOpen(false); action.onSelect() }}
        >
          {/* THE ICON SUPPORTS THE LABEL, IT DOES NOT REPLACE IT. The text is
              always rendered; the glyph is decorative and hidden from screen
              readers, which would otherwise announce it twice. A fixed 14px box
              keeps every label starting on the same x, including an action that
              has no icon. */}
          {action.Icon
            ? <action.Icon size={14} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
            : <span aria-hidden="true" style={{ width: 14, flexShrink: 0 }} />}
          <span>{action.label}</span>
        </button>
        </Fragment>
      ))}
    </div>
  )

  return (
    <span style={{ display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => { event.stopPropagation(); setOpen(o => !o) }}
        // A fixed 28px square (.boe-row-more), which the Actions column width
        // counts on; hover and focus rings live in globals.css.
        className="boe-row-more"
      >
        <MoreHorizontal size={15} strokeWidth={2} aria-hidden="true" />
      </button>
      {/* Rendered into <body>, so no ancestor's overflow can clip it. Guarded
          on `open` AND on the document existing, because this component is
          reached during server rendering too. */}
      {open && typeof document !== 'undefined' && createPortal(panel, document.body)}
    </span>
  )
}

/**
 * The Payments to Verify table.
 *
 * A DIFFERENT TABLE, not the confirmed one with columns hidden. The two pages
 * answer different questions and the columns follow: this one leads with the
 * reference and the client — a verifier is reconciling a submission against a
 * proof, and both are what they are holding — and it keeps STATUS, which the
 * confirmed page dropped precisely because every row there has the same one.
 *
 * NO MONEY COLUMNS. To Orders, To PI Draft and Unallocated are attribution
 * figures over money that has been confirmed to exist. Drawing them here would
 * print ₹0 beside every row and invite somebody to read it as a fact.
 *
 * VERIFICATION LIVES WHERE THE ROWS ARE. Opening a row is what verifies it, and
 * the row leaves this page for Confirmed Payments the moment it does — both
 * pages ask the database for their own statuses rather than filtering a shared
 * list in the browser.
 */
