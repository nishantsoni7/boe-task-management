'use client'

import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  buildListSearch, clearListSearch, parseListState,
  type CodecMap, type ListState,
} from '@/lib/listState'

/**
 * React binding for `@/lib/listState`: the URL is the single source of truth for
 * a list page's tab, search, filters and page number, so browser Back and
 * Forward restore the exact view the user left and a filtered URL can be shared
 * or reloaded.
 *
 * Filter changes `replace` by default — a session of narrowing a list should
 * leave one history entry, not fifteen, so a single Back from a task detail
 * lands on the list as it was. Opening a record still uses a normal `push`.
 *
 * ```ts
 * // Module scope: the codec map must keep a stable identity across renders.
 * const LIST_PARAMS = {
 *   tab:      enumParam(TAB_KEYS, 'all'),
 *   assignee: idParam(),
 *   q:        textParam(),
 * }
 *
 * const { state, setState } = useListUrlState(LIST_PARAMS)
 * // state.tab is TabKey, state.q is string
 * setState({ tab: 'overdue' })
 * ```
 *
 * Any component calling this must sit inside a `<Suspense>` boundary —
 * `useSearchParams` requires one.
 */
export function useListUrlState<M extends CodecMap>(
  specs: M,
  options: { pageKey?: Extract<keyof M, string> } = {},
) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const { pageKey }  = options

  const search = searchParams.toString()

  const state = useMemo(
    () => parseListState(specs, new URLSearchParams(search)),
    [specs, search],
  )

  const navigate = useCallback((nextSearch: string, history: 'replace' | 'push') => {
    const href = nextSearch ? `${pathname}?${nextSearch}` : pathname
    // scroll:false — changing a filter must not throw the reader back to the
    // top of the page.
    router[history](href, { scroll: false })
  }, [router, pathname])

  const setState = useCallback((
    patch: Partial<ListState<M>>,
    history: 'replace' | 'push' = 'replace',
  ) => {
    navigate(buildListSearch(specs, search, patch, { pageKey }), history)
  }, [navigate, specs, search, pageKey])

  const resetState = useCallback((history: 'replace' | 'push' = 'replace') => {
    navigate(clearListSearch(specs, search), history)
  }, [navigate, specs, search])

  return { state, setState, resetState }
}

export const SEARCH_DEBOUNCE_MS = 250

/**
 * A search box bound to a URL param. The input stays local so typing is not
 * one navigation per keystroke; the URL catches up after a pause. Clearing is
 * immediate — there is nothing to wait out.
 *
 * The input re-syncs whenever the URL value changes from elsewhere (Back,
 * Forward, a Reset button), which is what makes history navigation restore the
 * text the user actually left in the box.
 *
 * Returns `[value, setValue, flush]`. Wire `flush` to the input's `onBlur`:
 * clicking a row to open a record blurs the box first, so a value still inside
 * the debounce window reaches the URL *before* the detail page is pushed — and
 * is therefore still there on the way back.
 */
export function useUrlSearchInput(
  urlValue: string,
  commit: (next: string) => void,
  delayMs: number = SEARCH_DEBOUNCE_MS,
): [string, (next: string) => void, () => void] {
  const [input, setInput] = useState(urlValue)

  // Adjust during render rather than in an effect — no flash of the stale value.
  const [prevUrlValue, setPrevUrlValue] = useState(urlValue)
  if (urlValue !== prevUrlValue) {
    setPrevUrlValue(urlValue)
    setInput(urlValue)
  }

  // The caller's closure is rebuilt every render; as an effect event it can be
  // called from the timer without restarting the debounce on every render.
  const onCommit = useEffectEvent(commit)

  useEffect(() => {
    const trimmed = input.trim()
    if (trimmed === urlValue) return
    if (trimmed === '') { onCommit(''); return }
    const timer = setTimeout(() => onCommit(trimmed), delayMs)
    return () => clearTimeout(timer)
  }, [input, urlValue, delayMs])

  // Write the pending value now. The effect above then sees `trimmed ===
  // urlValue` and clears its timer, so this cannot double-commit.
  const flush = useCallback(() => {
    const trimmed = input.trim()
    if (trimmed !== urlValue) commit(trimmed)
  }, [input, urlValue, commit])

  return [input, setInput, flush]
}

/**
 * Drop a filter whose value is well-formed but no longer refers to anything —
 * an employee who left, or whose tasks have all been closed. Runs only once the
 * page has data (`ready`, and a non-empty option list), so a filter is never
 * discarded during the window where the options simply have not loaded yet.
 */
export function usePruneUnknownValue(
  ready: boolean,
  value: string,
  known: readonly string[],
  drop: () => void,
): void {
  const onDrop = useEffectEvent(drop)

  const isKnown = known.includes(value)
  const hasOptions = known.length > 0

  useEffect(() => {
    if (!ready || !value || !hasOptions || isKnown) return
    onDrop()
  }, [ready, value, hasOptions, isKnown])
}
