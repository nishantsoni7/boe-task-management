import { leavesThisPage } from './navWait'

export const UNSAVED_LEAVE_PROMPT = 'You have unsaved changes. Leave without saving?'

/** The page's one Back control (PageBackButton). A button, not a link, and it leaves the page just the same. */
const BACK_BUTTON = '.boe-back-btn'

/**
 * A document click listener (capture phase) that asks before an in-app link,
 * or the page's Back button, takes the person off a page with unsaved edits.
 * Cancelling stops the click, and next/link does not navigate a click whose
 * default was prevented.
 * `beforeunload` only covers closing or reloading the tab, not the app's own menu.
 * Not covered: the browser's own Back button.
 */
export function askBeforeLeaving(isDirty: () => boolean, ask: (text: string) => boolean = t => window.confirm(t)) {
  return (e: MouseEvent) => {
    if (!isDirty() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const el = (e.target as Element | null)?.closest?.(`a[href], ${BACK_BUTTON}`) as HTMLElement | null
    if (!el) return
    if (el.tagName === 'A') {
      const a = el as HTMLAnchorElement
      // A new tab or a download keeps this page open.
      if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return
      if (!leavesThisPage(a.getAttribute('href') ?? '', window.location.href)) return
    }
    if (!ask(UNSAVED_LEAVE_PROMPT)) { e.preventDefault(); e.stopPropagation() }
  }
}
