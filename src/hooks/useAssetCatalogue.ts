'use client'

import { useEffect, useSyncExternalStore } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EMPTY_ASSET_CATALOGUE,
  loadAssetCatalogue,
  type AssetCatalogue,
} from '@/lib/assets/catalogue'

// One copy of the asset catalogue for the whole tab.
//
// The list, My Assets, the detail page and every create / edit form name
// categories and products, and they must all say the same thing — in
// particular, a category renamed in Manage Catalogue has to read by its new
// name everywhere the moment the save returns, not after a reload. So the
// catalogue lives in one module-level store: the first component to ask loads
// it, everyone subscribes, and `refreshAssetCatalogue` after a write updates
// every screen at once.
//
// FAILURE IS A STATE, NOT AN EMPTY CATALOGUE. `loaded` becomes true only when
// a read has SUCCEEDED. A failed first read leaves `loaded` false with `error`
// set, so a form can say "could not load categories — Retry" instead of
// offering an empty picker that reads as "there are no categories", and the
// next component to mount (or the Retry button) tries again. A failed REFRESH
// after a success keeps the catalogue already on screen and reports the error.
//
// It is two small tables, read once per tab. No polling.

export type AssetCatalogueState = {
  catalogue: AssetCatalogue
  /** True once a read has succeeded. Never set by a failure. */
  loaded: boolean
  /** The last read's failure, or null. */
  error: string | null
  /** A read is in flight. */
  loading: boolean
}

const INITIAL: AssetCatalogueState = { catalogue: EMPTY_ASSET_CATALOGUE, loaded: false, error: null, loading: false }

let state: AssetCatalogueState = INITIAL
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(next: AssetCatalogueState) {
  state = next
  listeners.forEach(l => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = () => state
const getServerSnapshot = () => state

/** The current store state. Exported for tests. */
export function getAssetCatalogueState(): AssetCatalogueState {
  return state
}

/** Back to the never-loaded state. Tests only. */
export function resetAssetCatalogueStore(): void {
  inFlight = null
  emit(INITIAL)
}

/** Re-read both tables and update every subscribed screen. Also the Retry action. */
export function refreshAssetCatalogue(supabase: SupabaseClient): Promise<void> {
  if (inFlight) return inFlight
  emit({ ...state, loading: true })
  inFlight = loadAssetCatalogue(supabase)
    .then(({ catalogue, error }) => {
      emit(error
        // Keep whatever was loaded before, and stay un-loaded if nothing was.
        ? { ...state, loading: false, error }
        : { catalogue, loaded: true, error: null, loading: false })
    })
    .catch((e: unknown) => {
      emit({ ...state, loading: false, error: e instanceof Error ? e.message : 'Could not load the catalogue' })
    })
    .finally(() => { inFlight = null })
  return inFlight
}

export function useAssetCatalogue(supabase: SupabaseClient): AssetCatalogueState & { refresh: () => Promise<void> } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    // A mount after a failed first read tries again; a mount after a success
    // does not re-read.
    if (!state.loaded && !inFlight) refreshAssetCatalogue(supabase)
  }, [supabase])

  return { ...snapshot, refresh: () => refreshAssetCatalogue(supabase) }
}
