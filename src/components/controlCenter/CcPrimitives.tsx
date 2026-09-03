'use client'

import { useEffect, useId, type ReactNode } from 'react'
import s from './controlCenter.module.css'

// ── The Control Center's shared page furniture ──────────────────────────────
//
// Small, deliberately: a section heading, a toolbar row, a table shell, a
// badge, an empty state, a dialog and a field. Each exists because two or more
// redesigned sections needed it. Buttons are the global .boe-btn variants so
// primary, secondary and destructive actions read the same here as anywhere
// else in BOE.

export { s as cc }

export function CcSection({
  title, description, action, children,
}: {
  title?: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={s.section}>
      {(title || action) && (
        <div className={s.sectionHead}>
          <div>
            {title && <div className={s.sectionTitle}>{title}</div>}
            {description && <div className={s.sectionDesc}>{description}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function CcToolbar({ children }: { children: ReactNode }) {
  return <div className={s.toolbar}>{children}</div>
}

export function CcTable({ children }: { children: ReactNode }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>{children}</table>
    </div>
  )
}

export type CcTone = 'green' | 'gray' | 'amber' | 'blue' | 'violet' | 'red'

const TONE_CLASS: Record<CcTone, string> = {
  green: s.badgeGreen, gray: s.badgeGray, amber: s.badgeAmber,
  blue: s.badgeBlue, violet: s.badgeViolet, red: s.badgeRed,
}

export function CcBadge({ tone, children }: { tone: CcTone; children: ReactNode }) {
  return <span className={`${s.badge} ${TONE_CLASS[tone]}`}>{children}</span>
}

/** Active / Inactive, the one status every People row carries. */
export function ActiveBadge({ active }: { active: boolean }) {
  return <CcBadge tone={active ? 'green' : 'gray'}>{active ? 'Active' : 'Inactive'}</CcBadge>
}

export function CcEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className={s.empty}>
      <div>{message}</div>
      {hint && <div className={s.emptyHint}>{hint}</div>}
    </div>
  )
}

/**
 * A modal dialog. Escape and a click on the overlay close it; the page behind
 * stops scrolling while it is open. The footer is where the actions go, with
 * the confirming action last.
 */
export function CcDialog({
  title, subtitle, onClose, wide, footer, children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  wide?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className={s.overlay} onClick={onClose}>
      <div
        className={`${s.dialog}${wide ? ` ${s.dialogWide}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        <div className={s.dialogHead}>
          <div id={titleId} className={s.dialogTitle}>{title}</div>
          {subtitle && <div className={s.dialogSub}>{subtitle}</div>}
        </div>
        <div className={s.dialogBody}>{children}</div>
        {footer && <div className={s.dialogFoot}>{footer}</div>}
      </div>
    </div>
  )
}

export function CcField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      {children}
      {hint && <span className={s.fieldHint}>{hint}</span>}
    </label>
  )
}
