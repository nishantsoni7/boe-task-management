'use client'

// THE SLIDE-IN PANEL the Fabric & Finish cost sheet opens in over the PI Draft
// and the Confirmed Order page (owner, 2026-10-29: "slide the page on the
// right, like opening a sheet in Excel"). The attendance request drawer's
// mechanics, unchanged: Escape and ✕ close it, a click on the dimmed page does
// nothing, Tab cannot leave it, focus returns to whatever opened it, and the
// page behind does not scroll. On a phone it is the full width.
//
// It draws FabricFinishSheet and nothing of its own: every figure and every
// write belongs to the sheet.

import { useEffect, useId, useRef } from 'react'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'
import { useScrollLock } from '@/hooks/useScrollLock'
import { FabricFinishSheet, FABRIC_FINISH_TITLE } from './FabricFinishSheet'

export function FabricFinishDrawer({ submissionId, context, openAsPageHref, onClose }: {
  submissionId: string
  context: string
  /** The sheet's own page, for "Open as a page". */
  openAsPageHref: string
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useScrollLock()

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => { previouslyFocused?.focus?.() }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (shouldCloseFormModal('escape')) onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = panelRef.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      const target = resolveTrapTarget({
        count: focusables.length,
        activeIndex: focusables.indexOf(document.activeElement as HTMLElement),
        shiftKey: e.shiftKey,
      })
      if (target === null) return
      e.preventDefault()
      if (target === 'block') { root.focus(); return }
      focusables[target === 'first' ? 0 : focusables.length - 1]?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <>
      {/* Dims the page. Deliberately no click handler: it never dismisses. */}
      <div className={'ff-scrim'} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={FABRIC_FINISH_TITLE}
        tabIndex={-1}
        className={'ff-drawer'}
      >
        <span id={titleId} hidden>{FABRIC_FINISH_TITLE}</span>
        <FabricFinishSheet
          submissionId={submissionId}
          variant="drawer"
          context={context}
          openAsPageHref={openAsPageHref}
          onClose={() => { if (shouldCloseFormModal('close-icon')) onClose() }}
        />
      </div>
    </>
  )
}
