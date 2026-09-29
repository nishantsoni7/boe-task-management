/**
 * Asset forms when the catalogue is loading, failed, empty or ready — review
 * finding 1 on #240.
 *
 * The defect: a failed first catalogue read was stored as "loaded, empty", was
 * never retried, and Create Asset then showed an empty category picker as if
 * BOE had no categories. Asserted here on the real store and the real rendered
 * form:
 *
 *   - a failed read leaves the store UN-loaded with the error kept, and the
 *     next read (Retry) replaces it;
 *   - a failed refresh after a success keeps the catalogue on screen;
 *   - Create Asset shows the failure, a Retry button, and a disabled picker
 *     that says why — never an empty list of choices;
 *   - "genuinely no active category" is a different, explained state.
 *
 * Run:
 *   npx tsx --test src/components/assets/assetCatalogueForms.render.test.tsx
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getAssetCatalogueState,
  refreshAssetCatalogue,
  resetAssetCatalogueStore,
} from '@/hooks/useAssetCatalogue'
import { CreateAssetModal, EditAssetModal } from './AssetChangeModals'
import type { Asset } from '@/lib/assets/types'

const T = '2026-09-27T00:00:00Z'

type Reply = { data: unknown; error: { message: string } | null }

/** A client whose two catalogue reads answer with `replies[table]`. */
function fakeClient(replies: Record<string, Reply>): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => Promise.resolve(replies[table] ?? { data: [], error: null }),
    }),
  } as unknown as SupabaseClient
}

const FAIL: Record<string, Reply> = {
  asset_categories: { data: null, error: { message: 'Failed to fetch' } },
  asset_products:   { data: null, error: { message: 'Failed to fetch' } },
}

const cat = (key: string, name: string, is_active = true) =>
  ({ key, name, is_active, created_at: T, created_by: null, updated_at: T, updated_by: null })

const OK: Record<string, Reply> = {
  asset_categories: { data: [cat('laptop_desktop', 'Laptops & Desktops'), cat('phone', 'Phone')], error: null },
  asset_products:   { data: [], error: null },
}

const NONE_ACTIVE: Record<string, Reply> = {
  asset_categories: { data: [cat('laptop_desktop', 'Laptops & Desktops', false)], error: null },
  asset_products:   { data: [], error: null },
}

const noop = () => {}
const renderCreate = () => renderToStaticMarkup(
  createElement(CreateAssetModal, { supabase: fakeClient({}), onClose: noop, onSaved: noop }),
)

beforeEach(() => resetAssetCatalogueStore())

describe('the catalogue store', () => {
  test('a failed FIRST read is not "loaded": the error is kept, the catalogue stays empty', async () => {
    await refreshAssetCatalogue(fakeClient(FAIL))
    const s = getAssetCatalogueState()
    assert.equal(s.loaded, false)
    assert.equal(s.error, 'Failed to fetch')
    assert.equal(s.loading, false)
    assert.equal(s.catalogue.categories.length, 0)
  })

  test('Retry after a failure loads the catalogue and clears the error', async () => {
    await refreshAssetCatalogue(fakeClient(FAIL))
    await refreshAssetCatalogue(fakeClient(OK))
    const s = getAssetCatalogueState()
    assert.equal(s.loaded, true)
    assert.equal(s.error, null)
    assert.deepEqual(s.catalogue.categories.map(c => c.name), ['Laptops & Desktops', 'Phone'])
  })

  test('a failed REFRESH after a success keeps the catalogue already on screen', async () => {
    await refreshAssetCatalogue(fakeClient(OK))
    await refreshAssetCatalogue(fakeClient(FAIL))
    const s = getAssetCatalogueState()
    assert.equal(s.loaded, true)
    assert.equal(s.error, 'Failed to fetch')
    assert.equal(s.catalogue.categories.length, 2)
  })

  test('a thrown read (network down) is a failure too, not a hang', async () => {
    const throwing = { from: () => ({ select: () => Promise.reject(new Error('network down')) }) } as unknown as SupabaseClient
    await refreshAssetCatalogue(throwing)
    const s = getAssetCatalogueState()
    assert.equal(s.loaded, false)
    assert.equal(s.loading, false)
    assert.match(s.error ?? '', /network down/)
  })
})

describe('Create Asset never presents an empty picker as "no categories"', () => {
  test('failed read: the error, a Retry button, and a disabled picker that says why', async () => {
    await refreshAssetCatalogue(fakeClient(FAIL))
    const html = renderCreate()
    assert.match(html, /role="alert"/)
    assert.match(html, /Asset categories could not be loaded, so this form cannot be saved yet/)
    assert.match(html, /Failed to fetch/)
    assert.match(html, />Retry</)
    assert.match(html, /<select[^>]*disabled[^>]*>.*Categories could not be loaded/)
    assert.doesNotMatch(html, /Choose a category/)
  })

  test('still loading: says so, offers no choice', () => {
    const html = renderCreate()
    assert.match(html, /Loading asset categories/)
    assert.match(html, /Loading categories…/)
    assert.doesNotMatch(html, /Choose a category/)
    assert.doesNotMatch(html, />Retry</)
  })

  test('loaded, but nothing active: a different, explained state', async () => {
    await refreshAssetCatalogue(fakeClient(NONE_ACTIVE))
    const html = renderCreate()
    assert.match(html, /There are no active asset categories/)
    assert.match(html, /No active categories/)
    assert.doesNotMatch(html, />Retry</)
  })

  test('loaded: the real choices, and no notice', async () => {
    await refreshAssetCatalogue(fakeClient(OK))
    const html = renderCreate()
    assert.match(html, /Choose a category/)
    assert.match(html, /Laptops &amp; Desktops/)
    assert.match(html, />Phone</)
    assert.doesNotMatch(html, /role="alert"/)
  })
})

describe('Edit Asset while the catalogue is unavailable', () => {
  const asset = {
    id: 'a1', asset_code: 'BOE-AST-000001', asset_type: 'laptop_desktop', product_id: null,
    asset_name: 'Riya laptop', serial_no: null, specifications: null, brand: null, model: null,
    description: null, purchase_date: null, purchase_price: null, vendor: null, invoice_number: null,
    warranty_start_date: null, warranty_expiry_date: null, warranty_type: null, warranty_remarks: null,
    condition: null, location: null, department: null, status: 'assigned', created_at: T, updated_at: T,
  } as Asset

  test('keeps the asset’s own category, read-only and readable — never "(inactive)"', async () => {
    await refreshAssetCatalogue(fakeClient(FAIL))
    const html = renderToStaticMarkup(createElement(EditAssetModal, { asset, supabase: fakeClient({}), onClose: noop, onSaved: noop }))
    assert.match(html, />Retry</)
    assert.match(html, /<select[^>]*disabled[^>]*><option value="laptop_desktop"[^>]*>Laptop Desktop<\/option>/)
    assert.doesNotMatch(html, /\(inactive\)/)
  })
})
