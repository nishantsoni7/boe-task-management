// Choosing what the once-a-day splash shows, in the browser.
//
// The splash used to show quote number (day of the year % 50): the same line for
// everyone on a given day, and the whole list back every 50 days. Now each
// browser remembers which lines it has shown and draws from the ones it has not,
// so nobody sees a repeat until the whole library has been used, and two
// colleagues are rarely looking at the same line. The same KIND (fact, jingle,
// quote...) never shows two days running.
//
// Everything here is a plain function over a Storage-like object, so it is
// tested without a browser. Storage can be missing or throw (private windows,
// blocked site data): every read falls back to "nothing remembered" and every
// write is swallowed. The splash is not worth breaking the home page over.

import { SPLASH_ITEMS, type SplashItem, type SplashKind } from './items'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export const SPLASH_STATE_KEY = 'boe_daily_splash_v1'
export const HEADLINES_KEY = 'boe_daily_headlines_v1'

// Ask the server for fresh headlines at most this often...
const HEADLINES_REFRESH_MS = 6 * 3_600_000
// ...and stop showing one after this long: old news is not "trending".
const HEADLINES_USABLE_MS = 3 * 86_400_000
const SEEN_NEWS_KEPT = 40
const KINDS: readonly SplashKind[] = ['fact', 'boe', 'work', 'oneliner', 'jingle', 'motivation', 'news']

export type SplashState = {
  /** Ids of library lines shown in the current lap. */
  seen: string[]
  /** Ids of recent headlines shown. */
  newsSeen: string[]
  lastKind: SplashKind | null
}

const EMPTY_STATE: SplashState = { seen: [], newsSeen: [], lastKind: null }

/** Stable id for a line: the kind plus a hash of its text (djb2 / xor). */
export function splashId(item: SplashItem): string {
  let h = 5381
  for (let i = 0; i < item.text.length; i++) h = ((h * 33) ^ item.text.charCodeAt(i)) >>> 0
  return `${item.kind}:${h.toString(36)}`
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

function parseState(raw: unknown): SplashState {
  if (!raw || typeof raw !== 'object') return EMPTY_STATE
  const r = raw as Record<string, unknown>
  return {
    seen: isStringArray(r.seen) ? r.seen : [],
    newsSeen: isStringArray(r.newsSeen) ? r.newsSeen : [],
    lastKind: KINDS.includes(r.lastKind as SplashKind) ? (r.lastKind as SplashKind) : null,
  }
}

/**
 * One draw. Pure: give it a random function and it is deterministic.
 * Returns the line and the state to remember.
 */
export function pickSplash(
  items: readonly SplashItem[],
  news: readonly SplashItem[],
  state: SplashState,
  rand: () => number,
): { item: SplashItem; state: SplashState } {
  // Ids of lines that were edited or removed since are dropped here.
  const known = new Set(items.map(splashId))
  let seen = new Set(state.seen.filter(id => known.has(id)))
  let unseen = items.filter(i => !seen.has(splashId(i)))
  if (unseen.length === 0) {
    // A full lap is done: start the next one.
    seen = new Set()
    unseen = [...items]
  }
  const newsSeen = new Set(state.newsSeen)
  const pool = [...unseen, ...news.filter(n => !newsSeen.has(splashId(n)))]

  const kinds = [...new Set(pool.map(i => i.kind))]
  const kindChoices = kinds.length > 1 ? kinds.filter(k => k !== state.lastKind) : kinds
  const kind = kindChoices[Math.floor(rand() * kindChoices.length)]
  const ofKind = pool.filter(i => i.kind === kind)
  const item = ofKind[Math.floor(rand() * ofKind.length)]
  const id = splashId(item)

  return {
    item,
    state: item.kind === 'news'
      ? { seen: [...seen], newsSeen: [...state.newsSeen, id].slice(-SEEN_NEWS_KEPT), lastKind: 'news' }
      : { seen: [...seen, id], newsSeen: state.newsSeen, lastKind: item.kind },
  }
}

function readJson(storage: StorageLike, key: string): unknown {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

type StoredHeadlines = { at: number; items: { title: string; source: string }[] }

/** Keep only well-formed headlines, so what a browser stored can never break the splash. */
export function cleanHeadlineList(raw: unknown): StoredHeadlines['items'] {
  if (!Array.isArray(raw)) return []
  const out: StoredHeadlines['items'] = []
  for (const h of raw) {
    const t = (h as { title?: unknown } | null)?.title
    const s = (h as { source?: unknown } | null)?.source
    if (typeof t === 'string' && typeof s === 'string' && t.length > 0 && t.length <= 110 && s.length > 0 && s.length <= 40) {
      out.push({ title: t, source: s })
    }
    if (out.length >= 12) break
  }
  return out
}

function readStoredHeadlines(storage: StorageLike): StoredHeadlines | null {
  const raw = readJson(storage, HEADLINES_KEY) as { at?: unknown; items?: unknown } | null
  if (!raw || typeof raw.at !== 'number') return null
  const items = cleanHeadlineList(raw.items)
  return items.length ? { at: raw.at, items } : null
}

export function readHeadlines(storage: StorageLike, now: number): SplashItem[] {
  const stored = readStoredHeadlines(storage)
  if (!stored || now - stored.at > HEADLINES_USABLE_MS) return []
  return stored.items.map(h => ({ kind: 'news' as const, text: h.title, by: h.source }))
}

/** What today's splash shows. Remembers it, so tomorrow's is different. */
export function chooseTodaysSplash(
  storage: StorageLike | null,
  rand: () => number = Math.random,
  now: number = Date.now(),
): SplashItem {
  const state = storage ? parseState(readJson(storage, SPLASH_STATE_KEY)) : EMPTY_STATE
  const news = storage ? readHeadlines(storage, now) : []
  const picked = pickSplash(SPLASH_ITEMS, news, state, rand)
  if (storage) {
    try {
      storage.setItem(SPLASH_STATE_KEY, JSON.stringify(picked.state))
    } catch {
      // Storage unavailable: the splash still shows; it may repeat sooner.
    }
  }
  return picked.item
}

/**
 * Fetch headlines for a FUTURE day's splash and keep them in the browser. It is
 * deliberately not awaited by anything on the way to the splash: the splash
 * never waits on the network, so a headline shows the day after it was fetched.
 */
export async function refreshHeadlines(
  storage: StorageLike,
  fetchFn: typeof fetch,
  now: number = Date.now(),
): Promise<void> {
  const stored = readStoredHeadlines(storage)
  if (stored && now - stored.at < HEADLINES_REFRESH_MS) return
  try {
    const res = await fetchFn('/api/daily-headlines')
    if (!res.ok) return
    const items = cleanHeadlineList(((await res.json()) as { items?: unknown } | null)?.items)
    if (items.length) storage.setItem(HEADLINES_KEY, JSON.stringify({ at: now, items }))
  } catch {
    // Offline, blocked or storage full: the library alone is enough.
  }
}

/** localStorage can throw on mere ACCESS (blocked site data), not only on read. */
export function browserStorage(): StorageLike | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

export const LOADER_LINE_COUNT = 8

/**
 * The lines for one showing of the BOE One loader: eight different ones, never
 * two of the same kind in a row. Nothing is remembered between showings: with
 * 300+ lines a repeat is rare, and the loader should cost nothing to show.
 * Fresh headlines (see readHeadlines) are in the draw like any other kind.
 */
export function drawLoaderLines(
  news: readonly SplashItem[] = [],
  rand: () => number = Math.random,
  count: number = LOADER_LINE_COUNT,
): SplashItem[] {
  let state = EMPTY_STATE
  const lines: SplashItem[] = []
  for (let i = 0; i < count; i++) {
    const drawn = pickSplash(SPLASH_ITEMS, news, state, rand)
    lines.push(drawn.item)
    state = drawn.state
  }
  return lines
}

/** How long the splash stays up: 2.5 s for a short line, up to 4.5 s for a long one. */
export function splashDurationMs(item: SplashItem): number {
  return Math.min(4500, Math.max(2500, 2500 + (item.text.length - 60) * 40))
}
