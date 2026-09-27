/**
 * Asset catalogue helpers (src/lib/assets/catalogue.ts).
 *
 * The rules a form and a label depend on: duplicate names in the right scope,
 * a retired entry never offered for a new choice but still shown for the asset
 * that has it, a rename reaching every label, and a product never surviving a
 * move to a category it does not belong to.
 *
 * Run:
 *   npx tsx --test src/lib/assets/catalogue.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  categoryLabel,
  categoryNameProblem,
  cataloguePickerState,
  categoryOptions,
  findDuplicateCategory,
  findDuplicateProduct,
  normaliseCatalogueName,
  productAfterCategoryChange,
  productLabel,
  productNameProblem,
  productOptions,
  productsInCategory,
  sortCategories,
  summariseCatalogueUsage,
  type AssetCatalogue,
  type AssetCategory,
  type AssetProduct,
} from './catalogue'

const T = '2026-09-27T00:00:00Z'

function cat(key: string, name: string, is_active = true): AssetCategory {
  return { key, name, is_active, created_at: T, created_by: null, updated_at: T, updated_by: null }
}

function prod(id: string, category_key: string, name: string, is_active = true): AssetProduct {
  return { id, category_key, name, is_active, created_at: T, created_by: null, updated_at: T, updated_by: null }
}

const catalogue: AssetCatalogue = {
  categories: [
    cat('laptop_desktop', 'Laptop / Desktop'),
    cat('other', 'Other'),
    cat('phone', 'Phone'),
    cat('workshop_equipment', 'Workshop Equipment'),
    cat('tablet', 'Tablet', false),
  ],
  products: [
    prod('p-latitude', 'laptop_desktop', 'Dell Latitude 5420'),
    prod('p-xps', 'laptop_desktop', 'Dell XPS 13', false),
    prod('p-drill', 'workshop_equipment', 'Bosch GSB 500'),
    prod('p-pixel', 'phone', 'Pixel 6a'),
  ],
}

describe('names are compared the way the database stores them', () => {
  test('trimmed and whitespace-collapsed, exactly like asset_catalogue_normalise_name()', () => {
    assert.equal(normaliseCatalogueName('  Workshop    Equipment '), 'Workshop Equipment')
    assert.equal(normaliseCatalogueName(null), '')
  })

  test('a category duplicate is found case- and space-insensitively, including RETIRED ones', () => {
    assert.equal(findDuplicateCategory(catalogue.categories, ' workshop  equipment')?.key, 'workshop_equipment')
    assert.equal(findDuplicateCategory(catalogue.categories, 'TABLET')?.key, 'tablet')
    assert.equal(findDuplicateCategory(catalogue.categories, 'Printers'), null)
  })

  test('a category may keep its own name when renamed', () => {
    assert.equal(findDuplicateCategory(catalogue.categories, 'Phone', 'phone'), null)
    assert.equal(categoryNameProblem(catalogue.categories, 'phone', 'phone'), null)
  })

  test('product names are unique WITHIN a category, not across them', () => {
    assert.equal(findDuplicateProduct(catalogue.products, 'laptop_desktop', 'dell latitude 5420')?.id, 'p-latitude')
    assert.equal(findDuplicateProduct(catalogue.products, 'other', 'Dell Latitude 5420'), null)
    assert.equal(findDuplicateProduct(catalogue.products, 'laptop_desktop', 'Dell Latitude 5420', 'p-latitude'), null)
  })

  test('the inline hint says what is wrong, and points a retired duplicate at reactivation', () => {
    assert.equal(categoryNameProblem(catalogue.categories, '  '), 'Enter a category name.')
    assert.match(categoryNameProblem(catalogue.categories, 'phone') ?? '', /already exists/)
    assert.match(categoryNameProblem(catalogue.categories, 'tablet') ?? '', /inactive.*Reactivate/)
    assert.match(categoryNameProblem(catalogue.categories, 'x'.repeat(61)) ?? '', /60 characters/)
    assert.equal(categoryNameProblem(catalogue.categories, 'Printers'), null)

    assert.match(productNameProblem(catalogue, 'laptop_desktop', 'dell xps 13') ?? '', /inactive product/)
    assert.match(productNameProblem(catalogue, 'laptop_desktop', 'Dell Latitude 5420') ?? '', /"Laptop \/ Desktop" already has/)
    assert.equal(productNameProblem(catalogue, 'phone', 'Dell Latitude 5420'), null)
  })
})

describe('labels follow a rename', () => {
  test('the stored key resolves to the CURRENT name', () => {
    const renamed: AssetCatalogue = {
      ...catalogue,
      categories: catalogue.categories.map(c => c.key === 'laptop_desktop' ? { ...c, name: 'Computers' } : c),
    }
    assert.equal(categoryLabel(catalogue, 'laptop_desktop'), 'Laptop / Desktop')
    assert.equal(categoryLabel(renamed, 'laptop_desktop'), 'Computers')
  })

  test('an unknown key (catalogue not loaded yet) still reads as words, never blank', () => {
    assert.equal(categoryLabel({ categories: [], products: [] }, 'mouse_keyboard'), 'Mouse Keyboard')
    assert.equal(categoryLabel(catalogue, null), '—')
  })

  test('a product label is its name, or null when the asset names none', () => {
    assert.equal(productLabel(catalogue, 'p-pixel'), 'Pixel 6a')
    assert.equal(productLabel(catalogue, null), null)
    assert.equal(productLabel(catalogue, 'missing'), null)
  })

  test('categories sort by name with Other last', () => {
    assert.deepEqual(sortCategories(catalogue.categories).map(c => c.key),
      ['laptop_desktop', 'phone', 'tablet', 'workshop_equipment', 'other'])
  })
})

describe('what a form offers', () => {
  test('a new asset is offered active categories only', () => {
    const keys = categoryOptions(catalogue.categories).map(o => o.value)
    assert.deepEqual(keys, ['laptop_desktop', 'phone', 'workshop_equipment', 'other'])
    assert.ok(!keys.includes('tablet'))
  })

  test('an asset already in a retired category keeps it, labelled inactive, first', () => {
    const opts = categoryOptions(catalogue.categories, 'tablet')
    assert.deepEqual(opts[0], { value: 'tablet', label: 'Tablet (inactive)', inactive: true })
  })

  test('products are the active ones of the chosen category; a retired current one stays', () => {
    assert.deepEqual(productOptions(catalogue.products, 'laptop_desktop').map(o => o.value), ['p-latitude'])
    assert.deepEqual(productOptions(catalogue.products, 'laptop_desktop', 'p-xps').map(o => o.label),
      ['Dell XPS 13 (inactive)', 'Dell Latitude 5420'])
    // A product from another category is never offered, current or not.
    assert.deepEqual(productOptions(catalogue.products, 'phone', 'p-latitude').map(o => o.value), ['p-pixel'])
    assert.equal(productsInCategory(catalogue.products, 'laptop_desktop', { includeInactive: true }).length, 2)
  })

  test('changing the category drops a product that does not belong to it', () => {
    assert.equal(productAfterCategoryChange(catalogue.products, 'p-latitude', 'phone'), '')
    assert.equal(productAfterCategoryChange(catalogue.products, 'p-latitude', 'laptop_desktop'), 'p-latitude')
    assert.equal(productAfterCategoryChange(catalogue.products, '', 'phone'), '')
  })
})

describe('usage counts', () => {
  test('fold per-status rows into per-category and per-product totals', () => {
    const usage = summariseCatalogueUsage([
      { category_key: 'laptop_desktop', product_id: null,         status: 'assigned',  asset_count: '13' },
      { category_key: 'laptop_desktop', product_id: 'p-latitude', status: 'available', asset_count: 2 },
      { category_key: 'laptop_desktop', product_id: 'p-latitude', status: 'assigned',  asset_count: 1 },
      { category_key: 'phone',          product_id: null,         status: 'assigned',  asset_count: 5 },
    ])
    assert.equal(usage.byCategory.laptop_desktop, 16)
    assert.equal(usage.byCategory.phone, 5)
    assert.equal(usage.byProduct['p-latitude'], 3)
    assert.equal(usage.byCategory.workshop_equipment, undefined)
  })
})

// ─── What a picker may show (review finding 1 on #240) ──────────────────────

describe('cataloguePickerState never lets a failure pass for "no categories"', () => {
  test('not loaded and no error: loading', () => {
    assert.equal(cataloguePickerState({ loaded: false, error: null }, { categories: [], products: [] }), 'loading')
  })
  test('not loaded with an error: error — even though the list is empty', () => {
    assert.equal(cataloguePickerState({ loaded: false, error: 'Failed to fetch' }, { categories: [], products: [] }), 'error')
  })
  test('a Retry in flight after a failure reads as loading, not as the old error', () => {
    assert.equal(cataloguePickerState({ loaded: false, error: 'Failed to fetch', loading: true }, { categories: [], products: [] }), 'loading')
  })
  test('loaded with only retired categories: empty, a different state', () => {
    assert.equal(cataloguePickerState({ loaded: true, error: null }, { categories: [cat('tablet', 'Tablet', false)], products: [] }), 'empty')
  })
  test('loaded with an active category: ready — and a later refresh error does not take it away', () => {
    assert.equal(cataloguePickerState({ loaded: true, error: null }, catalogue), 'ready')
    assert.equal(cataloguePickerState({ loaded: true, error: 'Failed to fetch' }, catalogue), 'ready')
  })
})
