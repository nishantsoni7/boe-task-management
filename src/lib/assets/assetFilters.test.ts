/**
 * Asset list search and filtering.
 *
 * The governing rule under test: an EMPTY filter matches everything. A
 * narrowing nobody asked for silently hides assets, and the reader has no way
 * to tell it happened.
 *
 * Run:
 *   npx tsx --test src/lib/assets/assetFilters.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_ASSET_FILTERS,
  activeFilterCount,
  assetSearchHaystack,
  buildAssetRows,
  distinctValues,
  filterAssetRows,
  hasActiveFilters,
  matchesSearch,
  sortAssetRows,
  type AssetFilters,
} from './assetFilters'
import type { Asset, EmployeeAsset } from './types'

const NOW = '2026-08-01T00:00:00Z'

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a1',
  asset_code: 'BOE-AST-000001',
  asset_type: 'laptop_desktop',
  asset_name: 'Dell XPS 15',
  serial_no: 'SN-1234',
  specifications: null,
  brand: 'Dell',
  model: 'XPS 15',
  description: null,
  purchase_date: '2025-06-01',
  purchase_price: '90000',
  vendor: 'Acme IT',
  invoice_number: 'INV-1',
  warranty_start_date: '2025-06-01',
  warranty_expiry_date: '2027-06-01',
  warranty_type: 'Manufacturer',
  warranty_remarks: null,
  condition: 'good',
  location: 'Store Room A',
  department: 'Design',
  status: 'available',
  created_at: '2025-06-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  ...over,
})

const assignment = (over: Partial<EmployeeAsset> = {}): EmployeeAsset => ({
  id: 'ea1',
  asset_id: 'a1',
  employee_id: 'u1',
  assigned_by: 'admin',
  assigned_at: '2026-01-01T00:00:00Z',
  accepted_at: null,
  returned_at: null,
  lost_at: null,
  status: 'accepted',
  ...over,
})

const names: Record<string, string> = { u1: 'Priya Sharma', u2: 'Rahul Verma' }
const lookup = (id: string) => names[id] ?? null

const withFilters = (over: Partial<AssetFilters>): AssetFilters => ({ ...EMPTY_ASSET_FILTERS, ...over })

describe('the empty-filter rule', () => {
  test('no filters at all returns every row, unchanged', () => {
    const rows = buildAssetRows([asset({ id: 'a1' }), asset({ id: 'a2' })], [], lookup, NOW)
    assert.equal(filterAssetRows(rows, EMPTY_ASSET_FILTERS).length, 2)
  })

  test('hasActiveFilters and activeFilterCount agree with the empty state', () => {
    assert.equal(hasActiveFilters(EMPTY_ASSET_FILTERS), false)
    assert.equal(activeFilterCount(EMPTY_ASSET_FILTERS), 0)
    assert.equal(hasActiveFilters(withFilters({ search: 'dell' })), true)
    // Search is not counted as a "filter" chip — it has its own visible input.
    assert.equal(activeFilterCount(withFilters({ search: 'dell' })), 0)
    assert.equal(activeFilterCount(withFilters({ status: 'lost', condition: 'poor' })), 2)
  })

  test('whitespace-only values do not narrow anything', () => {
    const rows = buildAssetRows([asset()], [], lookup, NOW)
    assert.equal(filterAssetRows(rows, withFilters({ search: '   ' })).length, 1)
  })
})

describe('search', () => {
  test('the haystack covers every field the brief asks for', () => {
    const hay = assetSearchHaystack(asset(), 'Priya Sharma')
    for (const term of ['dell xps 15', 'boe-ast-000001', 'sn-1234', 'dell', 'xps 15', 'priya sharma', 'store room a']) {
      assert.ok(hay.includes(term), term)
    }
  })

  test('is case-insensitive', () => {
    assert.equal(matchesSearch('dell xps 15 sn-1234', 'DELL'), true)
  })

  test('every term must match, so two words narrow rather than widen', () => {
    // "dell priya" finds the Dell that Priya holds, not everything matching
    // either word.
    assert.equal(matchesSearch('dell xps priya sharma', 'dell priya'), true)
    assert.equal(matchesSearch('dell xps rahul verma', 'dell priya'), false)
  })

  test('an empty search matches everything', () => {
    assert.equal(matchesSearch('anything', ''), true)
    assert.equal(matchesSearch('anything', '    '), true)
  })

  test('finds an asset by the name of the employee holding it', () => {
    const rows = buildAssetRows(
      [asset({ status: 'assigned' })],
      [assignment()],
      lookup,
      NOW,
    )
    assert.equal(filterAssetRows(rows, withFilters({ search: 'priya' })).length, 1)
    assert.equal(filterAssetRows(rows, withFilters({ search: 'rahul' })).length, 0)
  })
})

describe('individual filters', () => {
  const rows = () => buildAssetRows(
    [
      asset({ id: 'a1', status: 'available', condition: 'good', department: 'Design',  location: 'Store Room A', asset_type: 'laptop_desktop', purchase_date: '2025-06-01', warranty_expiry_date: '2027-06-01' }),
      asset({ id: 'a2', status: 'assigned',  condition: 'poor', department: 'Sales',   location: 'Sales Desk',   asset_type: 'monitor',        purchase_date: '2024-01-15', warranty_expiry_date: '2026-08-10' }),
      asset({ id: 'a3', status: 'lost',      condition: null,   department: null,      location: null,           asset_type: 'phone',          purchase_date: null,         warranty_expiry_date: null }),
    ],
    [assignment({ asset_id: 'a2', employee_id: 'u2' })],
    lookup,
    NOW,
  )

  test('category', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ category: 'monitor' })).map(r => r.asset.id), ['a2'])
  })

  test('status', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ status: 'lost' })).map(r => r.asset.id), ['a3'])
  })

  test('assigned employee matches the DERIVED holder, not a stored field', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ employeeId: 'u2' })).map(r => r.asset.id), ['a2'])
    assert.equal(filterAssetRows(rows(), withFilters({ employeeId: 'u1' })).length, 0)
  })

  test('department matches a contained substring, case-insensitively', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ department: 'des' })).map(r => r.asset.id), ['a1'])
  })

  test('location matches a contained substring', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ location: 'store' })).map(r => r.asset.id), ['a1'])
  })

  test('condition — an asset with none recorded is not "good"', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ condition: 'good' })).map(r => r.asset.id), ['a1'])
    assert.equal(filterAssetRows(rows(), withFilters({ condition: 'poor' })).length, 1)
  })

  test('warranty is derived at filter time from the expiry date', () => {
    assert.deepEqual(filterAssetRows(rows(), withFilters({ warranty: 'active' })).map(r => r.asset.id), ['a1'])
    assert.deepEqual(filterAssetRows(rows(), withFilters({ warranty: 'expiring_soon' })).map(r => r.asset.id), ['a2'])
    assert.deepEqual(filterAssetRows(rows(), withFilters({ warranty: 'not_available' })).map(r => r.asset.id), ['a3'])
  })

  test('purchase-date range is inclusive at both ends', () => {
    assert.deepEqual(
      filterAssetRows(rows(), withFilters({ purchasedFrom: '2025-06-01', purchasedTo: '2025-06-01' })).map(r => r.asset.id),
      ['a1'],
    )
  })

  test('an asset with no purchase date is excluded from a bounded range', () => {
    // Including it would assert a date nobody wrote down.
    const result = filterAssetRows(rows(), withFilters({ purchasedFrom: '2020-01-01' }))
    assert.deepEqual(result.map(r => r.asset.id), ['a1', 'a2'])
  })
})

describe('combined filters', () => {
  const rows = () => buildAssetRows(
    [
      asset({ id: 'a1', asset_name: 'Dell Laptop',   asset_type: 'laptop_desktop', status: 'available', condition: 'good' }),
      asset({ id: 'a2', asset_name: 'Dell Monitor',  asset_type: 'monitor',        status: 'available', condition: 'good' }),
      asset({ id: 'a3', asset_name: 'HP Laptop',     asset_type: 'laptop_desktop', status: 'lost',      condition: 'poor' }),
    ],
    [], lookup, NOW,
  )

  test('filters narrow, they never replace one another', () => {
    const result = filterAssetRows(rows(), withFilters({
      search: 'dell', category: 'laptop_desktop', status: 'available',
    }))
    assert.deepEqual(result.map(r => r.asset.id), ['a1'])
  })

  test('a combination matching nothing returns an empty list, not everything', () => {
    const result = filterAssetRows(rows(), withFilters({ category: 'monitor', status: 'lost' }))
    assert.equal(result.length, 0)
  })

  test('clearing restores exactly what was hidden', () => {
    const all = rows()
    const narrowed = filterAssetRows(all, withFilters({ status: 'lost' }))
    assert.equal(narrowed.length, 1)
    assert.equal(filterAssetRows(all, EMPTY_ASSET_FILTERS).length, 3)
  })
})

describe('buildAssetRows', () => {
  test('an asset with no assignment history still builds a row', () => {
    const [row] = buildAssetRows([asset()], [], lookup, NOW)
    assert.equal(row.assignment, null)
    assert.equal(row.holderId, null)
    assert.equal(row.holderLabel, 'Store Room A')
  })

  test('an asset with none of the new fields recorded still builds a row', () => {
    const bare = asset({
      brand: null, model: null, purchase_date: null, purchase_price: null,
      warranty_expiry_date: null, condition: null, location: null, department: null,
    })
    const [row] = buildAssetRows([bare], [], lookup, NOW)
    assert.equal(row.warranty, 'not_available')
    assert.equal(row.holderLabel, 'Unassigned')
  })

  test('the holder shown and the holder searched are the same string', () => {
    const [row] = buildAssetRows([asset({ status: 'assigned' })], [assignment()], lookup, NOW)
    assert.equal(row.holderLabel, 'Priya Sharma')
    assert.ok(assetSearchHaystack(row.asset, row.holderName).includes('priya sharma'))
  })
})

describe('distinctValues', () => {
  test('lists only values actually present, sorted, without blanks', () => {
    const assets = [
      asset({ department: 'Design' }),
      asset({ department: 'Admin' }),
      asset({ department: 'Design' }),
      asset({ department: '   ' }),
      asset({ department: null }),
    ]
    assert.deepEqual(distinctValues(assets, 'department'), ['Admin', 'Design'])
  })
})

describe('sortAssetRows', () => {
  test('most recently updated first, name as the tie-break', () => {
    const rows = buildAssetRows([
      asset({ id: 'a1', asset_name: 'Zebra',  updated_at: '2026-01-01T00:00:00Z' }),
      asset({ id: 'a2', asset_name: 'Apple',  updated_at: '2026-05-01T00:00:00Z' }),
      asset({ id: 'a3', asset_name: 'Banana', updated_at: '2026-05-01T00:00:00Z' }),
    ], [], lookup, NOW)
    assert.deepEqual(sortAssetRows(rows).map(r => r.asset.id), ['a2', 'a3', 'a1'])
  })

  test('does not mutate the caller’s array', () => {
    const rows = buildAssetRows([
      asset({ id: 'a1', updated_at: '2026-01-01T00:00:00Z' }),
      asset({ id: 'a2', updated_at: '2026-05-01T00:00:00Z' }),
    ], [], lookup, NOW)
    const before = rows.map(r => r.asset.id)
    sortAssetRows(rows)
    assert.deepEqual(rows.map(r => r.asset.id), before)
  })
})
