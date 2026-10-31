'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { placeMenu, type MenuPlacement } from '@/lib/ui/menuPlacement'
import { colors } from '@/lib/tokens'

export type TaskRowMenuItem = {
  key: string
  text: string
  Icon: LucideIcon
  run: () => void
  danger?: boolean
}

// A row's ⋯ menu. Drawn into <body> and placed by placeMenu, the same as the
// finance rows, so the list's edge cannot clip it and the last row opens upward.
export function TaskRowMenu({ label, items, size }: {
  /** The accessible name, naming the task. */
  label: string
  items: TaskRowMenuItem[]
  /** Square button size in px: 32 on a desktop row, 44 on a phone card. */
  size: number
}) {
  const [open,  setOpen]  = useState(false)
  const [place, setPlace] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef   = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const panel = panelRef.current.getBoundingClientRect()
    const next = placeMenu({
      anchor: triggerRef.current.getBoundingClientRect(),
      menuWidth: panel.width,
      menuHeight: panel.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
    setPlace(next)
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => { setOpen(false); setPlace(null) }
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const panel = (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', zIndex: 900,
        top: place?.top ?? 0, left: place?.left ?? 0,
        // Measured hidden on the first frame, then shown where it belongs.
        visibility: place ? 'visible' : 'hidden',
        width: '176px', padding: '4px',
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        boxShadow: 'var(--boe-shadow-float)',
      }}
    >
      {items.map(({ key, text, Icon, run, danger }) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          className="boe-task-row-menu-item"
          onClick={() => { setOpen(false); setPlace(null); run() }}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
            minHeight: '36px', padding: '6px 8px', borderRadius: '6px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: '13px', textAlign: 'left',
            color: danger ? colors.red : colors.primary,
          }}
        >
          <Icon size={14} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />
          {text}
        </button>
      ))}
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={e => {
          e.stopPropagation()
          setPlace(null)
          setOpen(v => !v)
        }}
        className="boe-task-row-menu-trigger"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, width: `${size}px`, height: `${size}px`, borderRadius: '8px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: colors.muted,
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(panel, document.body)}
    </>
  )
}
