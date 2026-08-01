// ── URL-backed list state ─────────────────────────────────────────────────────
// The pure half of "filters live in the URL". A list page declares one codec per
// control; this module turns a query string into typed state and a state patch
// back into a query string. No React, no router — so the parsing rules (which
// values are accepted, which are dropped, when `page` resets) can be tested
// directly, and every list page shares one set of rules instead of growing its
// own.
//
// Two invariants the codecs exist to enforce:
//
//   * A value equal to the page default serialises to `null`, i.e. the param is
//     removed. `/tasks/assigned-by-me` with nothing selected is a clean URL.
//   * An unrecognised value parses to the default rather than throwing. A URL
//     typed by hand, or one holding a filter that no longer exists, renders the
//     page's default view instead of crashing it.
//
// The React binding lives in `@/hooks/useListUrlState`.

/**
 * One search param. `parse` never throws — an absent or unusable raw value
 * yields the default. `serialize` returns `null` for "omit this param".
 */
export type ParamCodec<T> = {
  parse: (raw: string | null) => T
  serialize: (value: T) => string | null
}

// A map of codecs is deliberately loose in its value type: `ParamCodec<T>` is
// covariant in `parse` and contravariant in `serialize`, so no single supertype
// fits every codec. `ListState` recovers the precise types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodecMap = Record<string, ParamCodec<any>>

/** The typed state a codec map describes: `{ tab: TabKey, page: number, … }`. */
export type ListState<M extends CodecMap> = {
  [K in keyof M]: M[K] extends ParamCodec<infer T> ? T : never
}

/**
 * The read-only slice of `URLSearchParams` this module needs, so callers can
 * pass either a real `URLSearchParams` or Next's `ReadonlyURLSearchParams`.
 */
export type ReadableParams = {
  get(name: string): string | null
  toString(): string
}

// ── Codecs ────────────────────────────────────────────────────────────────────

/**
 * A closed set of values with a default. Anything outside the set — a renamed
 * tab, a typo, an injected string — reads as `fallback`, and `fallback` itself
 * is never written to the URL.
 */
export function enumParam<T extends string>(allowed: readonly T[], fallback: T): ParamCodec<T> {
  return {
    parse: raw => (raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback),
    serialize: value => (value === fallback || !(allowed as readonly string[]).includes(value) ? null : value),
  }
}

/**
 * Like {@link enumParam} but the default is "nothing selected" (`null`) rather
 * than one of the members — for a tab strip that can start with no tab active.
 */
export function optionalEnumParam<T extends string>(allowed: readonly T[]): ParamCodec<T | null> {
  return {
    parse: raw => (raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null),
    serialize: value => (value !== null && (allowed as readonly string[]).includes(value) ? value : null),
  }
}

/**
 * A dropdown whose default is "All" — the empty string means no filter, so it
 * is never written. Distinct from {@link enumParam}, where one of the members
 * *is* the default.
 */
export function optionParam<T extends string>(allowed: readonly T[]): ParamCodec<T | ''> {
  return {
    parse: raw => (raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : ''),
    serialize: value => (value !== '' && (allowed as readonly string[]).includes(value) ? value : null),
  }
}

/**
 * Free text (a search box). Read verbatim so a trailing space the user is still
 * typing survives; written trimmed, and a blank value removes the param.
 * `URLSearchParams` handles the encoding, so spaces and `&` need no special
 * casing here.
 */
export function textParam(): ParamCodec<string> {
  return {
    parse: raw => raw ?? '',
    serialize: value => {
      const trimmed = value.trim()
      return trimmed === '' ? null : trimmed
    },
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A user id filter. Only a UUID-shaped value is accepted; anything else parses
 * to `''` (no filter), which is what keeps a hand-edited `?assignee=xyz` from
 * silently filtering the list down to nothing.
 *
 * A well-formed id that no longer matches anyone is a different case: it cannot
 * be judged here, without the option list. Pages hand that to
 * `usePruneUnknownValue` once their data has loaded.
 */
export function idParam(): ParamCodec<string> {
  return {
    parse: raw => (raw !== null && UUID_RE.test(raw) ? raw.toLowerCase() : ''),
    serialize: value => (UUID_RE.test(value) ? value.toLowerCase() : null),
  }
}

/** 1-based page number. Page 1 is the default and is never written. */
export function pageParam(): ParamCodec<number> {
  return {
    parse: raw => {
      const n = Number.parseInt(raw ?? '', 10)
      return Number.isFinite(n) && n > 1 ? n : 1
    },
    serialize: value => (Number.isFinite(value) && value > 1 ? String(Math.floor(value)) : null),
  }
}

/**
 * A comma-separated subset of a closed set (`?status=pending,working`).
 * Unknown members are dropped rather than failing the whole param, and an empty
 * result removes it.
 */
export function enumListParam<T extends string>(allowed: readonly T[]): ParamCodec<T[]> {
  const clean = (values: readonly string[]): T[] => {
    const seen = new Set<string>()
    const out: T[] = []
    for (const v of values) {
      const trimmed = v.trim()
      if (!trimmed || seen.has(trimmed)) continue
      if (!(allowed as readonly string[]).includes(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed as T)
    }
    return out
  }
  return {
    parse: raw => (raw === null ? [] : clean(raw.split(','))),
    serialize: value => {
      const cleaned = clean(value)
      return cleaned.length === 0 ? null : cleaned.join(',')
    },
  }
}

// ── Query string ↔ state ──────────────────────────────────────────────────────

function toSearchParams(current: ReadableParams | string): URLSearchParams {
  return new URLSearchParams(typeof current === 'string' ? current : current.toString())
}

/** Read every declared param out of a query string. */
export function parseListState<M extends CodecMap>(specs: M, params: ReadableParams): ListState<M> {
  const out = {} as Record<string, unknown>
  for (const key of Object.keys(specs)) {
    out[key] = specs[key].parse(params.get(key))
  }
  return out as ListState<M>
}

/**
 * Apply a patch to the current query string and return the new one.
 *
 * Params the page did not declare are copied through untouched, so a deep link
 * that also carries, say, `?from=notification` survives every filter change.
 *
 * `pageKey` implements "a filter change returns to page 1": if the patch
 * touches anything other than the page itself, the page param is dropped.
 */
export function buildListSearch<M extends CodecMap>(
  specs: M,
  current: ReadableParams | string,
  patch: Partial<ListState<M>>,
  options: { pageKey?: Extract<keyof M, string> } = {},
): string {
  const next = toSearchParams(current)
  const values = patch as Record<string, unknown>
  const touched: string[] = []

  for (const key of Object.keys(values)) {
    const codec = specs[key]
    // An undeclared key has no codec and no defined serialisation — ignore it
    // rather than writing a raw value the parser would not accept back.
    if (!codec) continue
    const value = values[key]
    if (value === undefined) continue
    touched.push(key)
    const raw = codec.serialize(value)
    if (raw === null || raw === '') next.delete(key)
    else next.set(key, raw)
  }

  const { pageKey } = options
  if (pageKey && !touched.includes(pageKey) && touched.length > 0) next.delete(pageKey)

  return next.toString()
}

/**
 * Drop every declared param, keeping any the page does not own — the "Reset
 * filters" action.
 */
export function clearListSearch<M extends CodecMap>(
  specs: M,
  current: ReadableParams | string,
): string {
  const next = toSearchParams(current)
  for (const key of Object.keys(specs)) next.delete(key)
  return next.toString()
}
