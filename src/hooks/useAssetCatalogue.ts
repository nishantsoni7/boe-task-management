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
// It is two small tables, read once per tab. No polling.

type State = { catalogue: AssetCatalogue; loaded: boolean; error: string | null }

let state: State = { catalogue: EMPTY_ASSET_CATALOGUE, loaded: false, error: null }
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(next: State) {
  state = next
  listeners.forEach(l => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = () => state
const getServerSnapshot = () => state

/** Re-read both tables and update every subscribed screen. */
export function refreshAssetCatalogue(supabase: SupabaseClient): Promise<void> {
  inFlight = loadAssetCatalogue(supabase).then(({ catalogue, error }) => {
    // A failed reload keeps what was already on screen rather than blanking
    // every label in the module.
    emit(error
      ? { ...state, loaded: true, error }
      : { catalogue, loaded: true, error: null })
  }).finally(() => { inFlight = null })
  return inFlight
}

export function useAssetCatalogue(supabase: SupabaseClient): State & { refresh: () => Promise<void> } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    if (!state.loaded && !inFlight) refreshAssetCatalogue(supabase)
  }, [supabase])

  return { ...snapshot, refresh: () => refreshAssetCatalogue(supabase) }
}
