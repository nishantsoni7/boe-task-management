// ── List scroll positions ─────────────────────────────────────────────────────
// Storage half of scroll restoration for list pages. Kept apart from the hook so
// the key shape and the "never trust what came out of storage" rules are
// testable without a DOM.
//
// Why this exists at all: a list page renders <LoadingScreen /> until its first
// query resolves, so on a history return the document is a few hundred pixels
// tall at the moment the browser would restore scroll. Native restoration has
// nothing to scroll to and gives up. The hook re-applies the offset once the
// rows are actually on the page.
//
// sessionStorage, not localStorage: a scroll offset is meaningful for one tab
// for the length of one visit, and stale offsets should not outlive it.

/** The slice of `Storage` used here — a fake in tests, `sessionStorage` at runtime. */
export type ScrollStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const SCROLL_KEY_PREFIX = 'boe:list-scroll:'

/**
 * Keyed by pathname *and* the complete query string: two different filter sets
 * on the same page are two different lists, and restoring one's offset into the
 * other would be worse than not restoring at all.
 */
export function scrollStorageKey(pathname: string, search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  return `${SCROLL_KEY_PREFIX}${pathname}${query ? `?${query}` : ''}`
}

/**
 * A stored offset, or `null` when there is none, when it is not a usable
 * number, or when storage itself is unavailable (Safari private mode throws on
 * access). Never throws.
 */
export function readScrollTop(store: ScrollStore | null | undefined, key: string): number | null {
  if (!store) return null
  let raw: string | null
  try {
    raw = store.getItem(key)
  } catch {
    return null
  }
  // `Number('')` is 0, which would read as a real "top of list" position.
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

/** Persist an offset. A zero offset is stored as an erase — top is the default. */
export function writeScrollTop(store: ScrollStore | null | undefined, key: string, top: number): void {
  if (!store) return
  try {
    if (!Number.isFinite(top) || top <= 0) store.removeItem(key)
    else store.setItem(key, String(Math.floor(top)))
  } catch {
    // Quota or a disabled store — scroll restoration is a nicety, never an error.
  }
}

// ── Retry decision ────────────────────────────────────────────────────────────

/**
 * What the restore loop should do on this frame.
 *
 * `wait` is the only outcome that schedules another frame, and it is
 * unreachable once the deadline has passed — which is what bounds the loop.
 */
export type RestoreStep =
  | { action: 'scroll'; top: number }
  | { action: 'wait' }
  | { action: 'give-up' }

/**
 * The list grows as its first query resolves, so the saved offset may not be
 * reachable yet. Wait for it, but only until `deadline`: past that, take
 * whatever the page now allows, or stop if it allows nothing.
 */
export function nextRestoreStep(input: {
  target: number
  /** Furthest the document can currently scroll: scrollHeight − innerHeight. */
  maxTop: number
  now: number
  deadline: number
}): RestoreStep {
  const { target, maxTop, now, deadline } = input
  if (maxTop >= target) return { action: 'scroll', top: target }
  if (now >= deadline) {
    // The list came back shorter than it was (rows closed, filters changed
    // underneath) — go as far as it now allows instead of nowhere.
    return maxTop > 0 ? { action: 'scroll', top: maxTop } : { action: 'give-up' }
  }
  return { action: 'wait' }
}

// ── History-return tracking ───────────────────────────────────────────────────

/**
 * Decides whether a list mounting right now is a Back/Forward return.
 *
 * One history navigation restores one list: the first key to claim it wins, so a
 * list opened by a fresh in-app navigation moments later is not mistaken for a
 * return. Re-claiming with the same key still succeeds, which keeps restoration
 * working under StrictMode's double-invoked effects.
 *
 * A reload or a directly typed URL starts a new document, where nothing has
 * called `noteHistoryNavigation` yet — so neither is ever treated as a return.
 */
export function createHistoryReturnTracker(windowMs: number) {
  let lastAt: number | null = null
  let claimedBy: string | null = null

  return {
    noteHistoryNavigation(now: number): void {
      lastAt = now
      claimedBy = null
    },
    claim(key: string, now: number): boolean {
      if (lastAt === null) return false
      if (now - lastAt > windowMs) return false
      if (claimedBy !== null && claimedBy !== key) return false
      claimedBy = key
      return true
    },
  }
}
