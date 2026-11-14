// The two small rules behind "a slow click shows the BOE One loader".
//
// AppLink (src/components/ui/AppLink.tsx) calls them while a clicked link waits
// for its page. Dependency-free on purpose, like appHistory.ts: AppLink is in
// the bundle every route loads. The loader itself is CSS (globals.css): it shows
// while <html> carries `data-boe-nav-pending`, after a pause so a quick click
// never flashes it.

/**
 * Does following this link take the person to a different PAGE?
 *
 * A link that only changes the query string or the hash (a filter, a tab, a
 * sort) stays on the page it is on: that page already shows its own loading
 * state, and covering the whole app for it would be heavy-handed.
 *
 * `target` is the link's destination as written: a string, or the `pathname` of
 * a URL object ('' when the object has none, i.e. query-only). `currentHref` is
 * the full address the person is on now.
 */
export function leavesThisPage(target: string, currentHref: string): boolean {
  if (!target) return false
  try {
    const here = new URL(currentHref)
    return new URL(target, here).pathname !== here.pathname
  } catch {
    // An address that cannot be read: show the loader rather than leave a slow click silent.
    return true
  }
}

export const NAV_PENDING_ATTRIBUTE = 'data-boe-nav-pending'

// How many clicked links are waiting for their page right now. Counted, not a
// flag: with two waiting at once, the first to finish must not hide the loader
// the second still needs.
let waiting = 0

/**
 * A clicked link starts waiting: mark `root` (the <html> element) so the loader
 * can show. Returns the function that ends THIS wait; the mark comes off only
 * when no wait is left. Calling the returned function twice ends the wait once.
 */
export function beginNavWait(root: Element): () => void {
  waiting += 1
  root.setAttribute(NAV_PENDING_ATTRIBUTE, '')
  let ended = false
  return () => {
    if (ended) return
    ended = true
    waiting -= 1
    if (waiting === 0) root.removeAttribute(NAV_PENDING_ATTRIBUTE)
  }
}
