'use client'

import { usePathname, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { hasInAppHistory } from '@/lib/navigation/appHistory'
import { backTarget } from '@/lib/navigation/backTarget'
import { noteListReturn } from '@/hooks/useListScrollRestore'

// Where Back goes is worked out at the moment it is needed (hover, focus, click)
// from the live address and history, never stored in state: the address bar's
// query and this document's history can change without this component rendering.
const targetNow = (pathname: string) =>
  backTarget({ pathname, search: window.location.search, inAppHistory: hasInAppHistory() })

/**
 * THE Back control. One button, left of the page title, in the header of every
 * module (each layout renders it just before `.boe-page-title-group`). Pages
 * must not draw a Back of their own; rules and reasons in src/lib/navigation/backTarget.ts.
 *
 * Icon only, so the tooltip and the accessible name carry the words: "Back to
 * Confirmed Orders" where the place is known, "Back" where it is not.
 */
export function PageBackButton() {
  const pathname = usePathname()
  const router = useRouter()
  if (backTarget({ pathname, search: '', inAppHistory: false }) === null) return null

  const name = (el: HTMLButtonElement) => { el.title = targetNow(pathname)?.label ?? 'Back' }

  return (
    <button
      type="button"
      className="boe-back-btn"
      aria-label="Back"
      onPointerEnter={e => name(e.currentTarget)}
      onFocus={e => name(e.currentTarget)}
      onClick={() => {
        const target = targetNow(pathname)
        if (!target) return
        if (target.kind === 'history') { router.back(); return }
        noteListReturn() // so a list restores its scroll, as it does for the browser's Back
        router.push(target.path)
      }}
    >
      <ArrowLeft size={22} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}
