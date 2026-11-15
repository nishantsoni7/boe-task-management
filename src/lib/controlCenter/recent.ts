// The Control Center screens this browser tab opened lately, newest first, so Find anything can offer them
// the moment it opens. Kept for the tab only (sessionStorage): it is a convenience, not a setting, and it
// must never stop a screen from rendering, so every read and write is allowed to fail.

const KEY = 'boe.cc.recent'
const MAX = 4

type Store = Pick<Storage, 'getItem' | 'setItem'>

function defaultStore(): Store | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

/** Section ids, newest first. Anything unreadable is "nothing recent". */
export function recentSectionIds(store: Store | null = defaultStore()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch {
    return []
  }
}

/** Put a section first, once, keeping the last few. */
export function rememberSection(id: string, store: Store | null = defaultStore()): void {
  try {
    const next = [id, ...recentSectionIds(store).filter(x => x !== id)].slice(0, MAX)
    store?.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage blocked (a private window): recents simply stay empty.
  }
}
