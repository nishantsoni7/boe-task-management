'use client'

import { useEffect, useEffectEvent, useRef } from 'react'
import { FOCUSABLE_SELECTOR, resolveTrapTarget } from '@/lib/ui/modalDismissal'

// Keyboard behaviour for a layer over the page (the lead panel, the "Change who holds this lead?" question):
//   - it remembers what had focus when it opened and gives focus back when it closes, so a keyboard user does not
//     land on <body> and have to Tab through the whole list again;
//   - Tab stays inside it (the shared trap, `resolveTrapTarget`), so the dropdowns behind it cannot be reached;
//   - Escape goes to `onEscape` and nowhere else, in the capture phase, so a layer underneath never also hears it;
//   - when two layers are open, only the top one answers (the panel with the question above it).
// `onEscape` may do nothing (a save is running): the key is still swallowed.

const open: object[] = []

export function useDialogFocus<T extends HTMLElement>(onEscape: () => void) {
  const ref = useRef<T>(null)
  const escape = useEffectEvent(onEscape)

  useEffect(() => {
    const me = {}
    open.push(me)
    const opener = document.activeElement as HTMLElement | null

    const onKey = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== me) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        escape()
        return
      }
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      const activeIndex = focusables.indexOf(document.activeElement as HTMLElement)
      const target = resolveTrapTarget({ count: focusables.length, activeIndex, shiftKey: e.shiftKey })
      if (target === null) return
      e.preventDefault()
      if (target === 'block') { root.focus(); return }
      focusables[target === 'first' ? 0 : focusables.length - 1]?.focus()
    }

    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      open.splice(open.indexOf(me), 1)
      if (opener && opener.isConnected) opener.focus?.()
    }
  }, [])

  return ref
}
