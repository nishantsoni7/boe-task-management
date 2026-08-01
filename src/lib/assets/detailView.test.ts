/**
 * Asset detail — presentation arithmetic.
 *
 * Run:
 *   npx tsx --test src/lib/assets/detailView.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_ASSET_ACTION_KEYS,
  ASSET_ACTION_LABEL,
  assetActionLayout,
  assetDetailTabCounts,
  assetSummaryDate,
  hasOverflowActions,
  hasWarrantyDetails,
  optionalText,
  type AssetActionAvailability,
  type AssetActionKey,
} from './detailView'

function availability(overrides: Partial<AssetActionAvailability> = {}): AssetActionAvailability {
  const base = Object.fromEntries(
    ALL_ASSET_ACTION_KEYS.map(key => [key, false]),
  ) as AssetActionAvailability
  return { ...base, ...overrides }
}

describe('assetActionLayout', () => {
  test('every action key lands in exactly one group — none can be lost', () => {
    // The regression this whole module exists to prevent: an action that passes
    // its permission check and then renders nowhere, because it was left out of
    // all three order lists.
    const layout = assetActionLayout(availability(
      Object.fromEntries(ALL_ASSET_ACTION_KEYS.map(k => [k, true])) as AssetActionAvailability,
    ))
    const placed = [...layout.primary, ...layout.more, ...layout.danger]

    assert.equal(placed.length, ALL_ASSET_ACTION_KEYS.length)
    assert.equal(new Set(placed).size, placed.length, 'an action was placed twice')
    for (const key of ALL_ASSET_ACTION_KEYS) {
      assert.ok(placed.includes(key), `${key} is not in any group`)
    }
  })

  test('every action key has a label', () => {
    for (const key of ALL_ASSET_ACTION_KEYS) {
      const label = ASSET_ACTION_LABEL[key as AssetActionKey]
      assert.ok(label && label.trim() !== '', `${key} has no label`)
    }
  })

  test('an unavailable action appears in no group', () => {
    const layout = assetActionLayout(availability({ transfer: true }))
    assert.deepEqual(layout.primary, ['transfer'])
    assert.deepEqual(layout.more, [])
    assert.deepEqual(layout.danger, [])
  })

  test('custody moves are primary; record-keeping is not', () => {
    const layout = assetActionLayout(availability({
      transfer: true, markReturned: true,
      sendRepair: true, warranty: true, edit: true,
    }))
    assert.deepEqual(layout.primary, ['transfer', 'markReturned'])
    assert.deepEqual(layout.more, ['sendRepair', 'warranty', 'edit'])
  })

  test('Delete is last, behind the danger divider', () => {
    const layout = assetActionLayout(availability({
      delete: true, markLost: true, retire: true, dispose: true, edit: true,
    }))
    assert.deepEqual(layout.more, ['edit'])
    assert.deepEqual(layout.danger, ['markLost', 'retire', 'dispose', 'delete'])
    assert.equal(layout.danger[layout.danger.length - 1], 'delete')
  })

  test('a viewer with no permissions gets no controls at all', () => {
    const layout = assetActionLayout(availability())
    assert.deepEqual(layout, { primary: [], more: [], danger: [] })
    assert.equal(hasOverflowActions(layout), false)
  })

  test('hasOverflowActions is true when only the danger group is populated', () => {
    assert.equal(hasOverflowActions(assetActionLayout(availability({ delete: true }))), true)
    // A primary-only layout must not render an empty overflow trigger.
    assert.equal(hasOverflowActions(assetActionLayout(availability({ transfer: true }))), false)
  })
})

describe('assetDetailTabCounts', () => {
  test('the assignment tab counts both lists it renders', () => {
    const counts = assetDetailTabCounts({
      transfers:       [1, 2, 3],
      assignments:     [1, 2],
      services:        [1],
      activeDocuments: [1, 2, 3, 4],
      activity:        [1, 2, 3, 4, 5],
    })
    assert.deepEqual(counts, { assignments: 5, service: 1, documents: 4, activity: 5 })
  })

  test('empty histories count zero rather than going missing', () => {
    const counts = assetDetailTabCounts({
      transfers: [], assignments: [], services: [], activeDocuments: [], activity: [],
    })
    assert.deepEqual(counts, { assignments: 0, service: 0, documents: 0, activity: 0 })
  })
})

describe('optionalText', () => {
  test('null, undefined and blank all mean "nothing to show"', () => {
    assert.equal(optionalText(null), null)
    assert.equal(optionalText(undefined), null)
    assert.equal(optionalText(''), null)
    assert.equal(optionalText('   '), null)
  })

  test('a real value comes back trimmed', () => {
    assert.equal(optionalText('  Dell Latitude  '), 'Dell Latitude')
  })
})

describe('hasWarrantyDetails', () => {
  const blank = {
    warranty_start_date: null, warranty_expiry_date: null,
    warranty_type: null, warranty_remarks: null,
  }

  test('nothing recorded', () => {
    assert.equal(hasWarrantyDetails(blank), false)
    assert.equal(hasWarrantyDetails({ ...blank, warranty_type: '   ' }), false)
  })

  test('a start date with no expiry still counts as warranty data', () => {
    // warrantyStatus() would call this asset 'not_available' — the empty state
    // must NOT be shown over the top of a date somebody entered.
    assert.equal(hasWarrantyDetails({ ...blank, warranty_start_date: '2026-01-01' }), true)
  })

  test('type alone, or remarks alone, count', () => {
    assert.equal(hasWarrantyDetails({ ...blank, warranty_type: 'Onsite' }), true)
    assert.equal(hasWarrantyDetails({ ...blank, warranty_remarks: 'Extended by vendor' }), true)
  })

  test('an expiry date counts', () => {
    assert.equal(hasWarrantyDetails({ ...blank, warranty_expiry_date: '2027-03-01' }), true)
  })
})

describe('assetSummaryDate', () => {
  const asset = { created_at: '2026-01-15T10:00:00Z' }

  test('an asset someone holds is dated by its assignment', () => {
    assert.deepEqual(
      assetSummaryDate(asset, { assigned_at: '2026-06-02T09:30:00Z' }),
      { label: 'Assigned', iso: '2026-06-02T09:30:00Z' },
    )
  })

  test('an asset nobody holds is dated by when the record was created', () => {
    assert.deepEqual(
      assetSummaryDate(asset, null),
      { label: 'Added', iso: '2026-01-15T10:00:00Z' },
    )
  })
})
