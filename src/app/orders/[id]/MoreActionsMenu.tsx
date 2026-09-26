'use client'

// THE OVERFLOW MENU, in its own module so the Documents card and the command
// header share one accessible menu without importing each other.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import { colors } from '@/lib/tokens'

// ── More actions ──────────────────────────────────────────────────────────────

export type MoreActionItem<K extends string> = {
  key: K
  label: string
  disabled?: boolean
  title?: string
  danger?: boolean
}

/**
 * The overflow menu for the rare paths. Keyboard behaviour is the WAI-ARIA
 * menu-button pattern: click or ArrowDown opens, focus lands on the first
 * enabled item, Up/Down/Home/End move, Escape closes and returns focus to the
 * trigger, Tab or an outside click closes. Renders nothing when there is no
 * item — an empty trigger would be a control that does nothing.
 */
export function MoreActionsMenu<K extends string>({ items, onSelect, label, ariaLabel = 'More actions', triggerClassName }: {
  items: readonly MoreActionItem<K>[]
  onSelect: (key: K) => void
  /** A worded trigger ("Update documents ▾") instead of the ⋯ icon. */
  label?: string
  /** The trigger's and the menu's accessible name. */
  ariaLabel?: string
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs   = useRef<(HTMLButtonElement | null)[]>([])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const first = itemRefs.current.findIndex(el => el && !el.disabled)
    if (first >= 0) itemRefs.current[first]?.focus()
  }, [open])

  if (items.length === 0) return null

  const focusItem = (index: number) => {
    const bounded = (index + items.length) % items.length
    itemRefs.current[bounded]?.focus()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); focusItem(index + 1) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); focusItem(index - 1) }
    else if (e.key === 'Home')      { e.preventDefault(); focusItem(0) }
    else if (e.key === 'End')       { e.preventDefault(); focusItem(items.length - 1) }
    else if (e.key === 'Tab')       { setOpen(false) }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) }
        }}
        aria-label={label ? undefined : ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName ?? 'boe-record-action boe-record-action--icon'}
        style={{ background: open ? colors.float : undefined }}
      >
        {label ? <>{label}<ChevronDown size={13} strokeWidth={2} aria-hidden="true" /></> : <MoreHorizontal size={15} strokeWidth={2} />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label ?? ariaLabel}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: '9px', boxShadow: '0 8px 24px rgba(16,24,40,0.14)',
            minWidth: '224px', padding: '4px 0', overflow: 'hidden',
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={el => { itemRefs.current[index] = el }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => { triggerRef.current?.focus(); setOpen(false); onSelect(item.key) }}
              onKeyDown={e => onMenuKeyDown(e, index)}
              className="order-menu-item"
              style={{ color: item.danger ? '#B42318' : colors.secondary }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
