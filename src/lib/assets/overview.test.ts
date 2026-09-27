/**
 * The owner's Asset overview (src/lib/assets/overview.ts).
 *
 * What is asserted is mostly what is NOT counted: available stock is never a
 * problem, retired assets are not part of the fleet, a warranty nobody
 * recorded is not "expiring", and a person's holdings are exactly their open
 * custody records.
 *
 * Run:
 *   npx tsx --test src/lib/assets/overview.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIVE_STATUS_FILTER, EMPTY_ASSET_FILTERS, OUT_OF_SERVICE_STATUSES, buildAssetRows, filterAssetRows } from './assetFilters'
import {
  attentionByAsset,
  attentionItems,
  countsByCategory,
  holdingsByPerson,
  summariseAssets,
} from './overview'
import type { Asset, EmployeeAsset } from './types'
import type { AssetCatalogue } from './catalogue'

const NOW = '2026-09-27T00:00:00Z'
const T = '2026-01-01T00:00:00Z'

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, asset_code: `BOE-AST-${id}`, asset_type: 'laptop_desktop', asset_name: `Asset ${id}`,
  serial_no: null, specifications: null, brand: null, model: null, description: null,
  purchase_date: null, purchase_price: null, vendor: null, invoice_number: null,
  warranty_start_date: null, warranty_expiry_date: null, warranty_type: null, warranty_remarks: null,
  condition: null, location: null, department: null,
  status: 'available', created_at: T, updated_at: '2026-09-17T00:00:00Z',
  ...over,
})

const custody = (assetId: string, employeeId: string, over: Partial<EmployeeAsset> = {}): EmployeeAsset => ({
  id: `ea-${assetId}`, asset_id: assetId, employee_id: employeeId, assigned_by: 'admin',
  assigned_at: '2026-08-03T00:00:00Z', accepted_at: '2026-08-04T00:00:00Z',
  returned_at: null, lost_at: null, status: 'accepted',
  ...over,
})

const catalogue: AssetCatalogue = {
  categories: [
    { key: 'laptop_desktop', name: 'Laptop / Desktop', is_active: true, created_at: T, created_by: null, updated_at: T, updated_by: null },
    { key: 'phone', name: 'Phone', is_active: true, created_at: T, created_by: null, updated_at: T, updated_by: null },
    { key: 'other', name: 'Other', is_active: true, created_at: T, created_by: null, updated_at: T, updated_by: null },
  ],
  products: [],
}

const people: Record<string, string> = { u1: 'Priya', u2: 'Rahul' }
const lookup = (id: string) => people[id] ?? null

const assets = [
  asset('l1', { status: 'assigned' }),                                  // Priya, accepted
  asset('p1', { status: 'assigned', asset_type: 'phone' }),              // Priya, pending since 2026-08-03
  asset('l2', { status: 'assigned', condition: 'damaged' }),             // Rahul, accepted, damaged
  asset('l3', { status: 'available' }),                                  // stock
  asset('l4', { status: 'available', condition: 'good' }),               // stock
  asset('l5', { status: 'under_repair' }),
  asset('p2', { status: 'lost', asset_type: 'phone' }),
  asset('o1', { status: 'retired', asset_type: 'other', condition: 'poor' }),
  asset('l6', { status: 'assigned' }),                                   // no custody record
  asset('l7', { status: 'available', warranty_expiry_date: '2026-10-10' }),
]
const assignments = [
  custody('l1', 'u1'),
  custody('p1', 'u1', { status: 'pending_acceptance', accepted_at: null }),
  custody('l2', 'u2'),
]
const rows = buildAssetRows(assets, assignments, lookup, NOW, catalogue)
const attention = attentionItems(rows, NOW)

describe('the summary counts', () => {
  test('active excludes retired / disposed; the parts add up', () => {
    const s = summariseAssets(rows, attention)
    assert.equal(s.active, 9)
    assert.equal(s.outOfService, 1)
    assert.equal(s.assigned, 4)
    assert.equal(s.available, 3)
    assert.equal(s.underRepair, 1)
    assert.equal(s.lost, 1)
    assert.equal(s.assigned + s.available + s.underRepair + s.lost, s.active)
  })

  test('needs-attention counts ASSETS, not reasons', () => {
    const s = summariseAssets(rows, attention)
    assert.equal(s.needsAttention, new Set(attention.map(i => i.row.asset.id)).size)
  })
})

describe('needs attention', () => {
  const reasonsFor = (id: string) => attention.filter(i => i.row.asset.id === id).map(i => i.reason)

  test('available stock is never an attention item', () => {
    assert.deepEqual(reasonsFor('l3'), [])
    assert.deepEqual(reasonsFor('l4'), [])
  })

  test('an unaccepted handover is flagged, with how long it has waited', () => {
    const item = attention.find(i => i.row.asset.id === 'p1')
    assert.equal(item?.reason, 'awaiting_acceptance')
    assert.equal(item?.days, 55)
    assert.match(item?.detail ?? '', /Priya has not accepted the handover \(55 days\)/)
  })

  test('lost, under repair and poor condition are flagged; a retired asset is not', () => {
    assert.deepEqual(reasonsFor('p2'), ['lost'])
    assert.deepEqual(reasonsFor('l5'), ['under_repair'])
    assert.deepEqual(reasonsFor('l2'), ['poor_condition'])
    assert.deepEqual(reasonsFor('o1'), [])
  })

  test('"assigned" with no holder on record is a record to review', () => {
    assert.deepEqual(reasonsFor('l6'), ['custody_mismatch'])
    assert.match(attention.find(i => i.row.asset.id === 'l6')!.detail, /no holder is recorded/)
  })

  test('only a RECORDED warranty can be ending soon', () => {
    assert.deepEqual(reasonsFor('l7'), ['warranty_expiring'])
    // Every other asset has no expiry recorded and is not flagged for it.
    assert.equal(attention.filter(i => i.reason === 'warranty_expiring').length, 1)
  })

  test('data problems come first, then what is waiting on a person', () => {
    assert.deepEqual([...new Set(attention.map(i => i.reason))],
      ['custody_mismatch', 'lost', 'awaiting_acceptance', 'under_repair', 'poor_condition', 'warranty_expiring'])
  })

  test('an empty inventory needs nothing', () => {
    assert.deepEqual(attentionItems([], NOW), [])
  })

  test('grouped by asset, an asset with two reasons is listed ONCE, where its first reason puts it', () => {
    const extra = buildAssetRows(
      [asset('m1', { status: 'assigned', condition: 'damaged' })],
      [custody('m1', 'u2', { status: 'pending_acceptance', accepted_at: null })],
      lookup, NOW, catalogue,
    )
    const groups = attentionByAsset(attentionItems([...rows, ...extra], NOW))
    const m1 = groups.filter(g => g.row.asset.id === 'm1')
    assert.equal(m1.length, 1)
    assert.deepEqual(m1[0].items.map(i => i.reason), ['awaiting_acceptance', 'poor_condition'])
    // The group count is the tile's count.
    const all = attentionItems([...rows, ...extra], NOW)
    const s = summariseAssets([...rows, ...extra], all)
    assert.equal(groups.length, s.needsAttention)
  })
})

describe('by person', () => {
  const byPerson = holdingsByPerson(rows)

  test('everyone with an open custody record, alphabetically, and no one else', () => {
    assert.deepEqual(byPerson.map(p => p.name), ['Priya', 'Rahul'])
  })

  test('counts, pending handovers and categories per person', () => {
    const priya = byPerson.find(p => p.employeeId === 'u1')!
    assert.equal(priya.total, 2)
    assert.equal(priya.awaitingAcceptance, 1)
    assert.deepEqual(priya.categories, [{ name: 'Laptop / Desktop', count: 1 }, { name: 'Phone', count: 1 }])
  })
})

describe('by category', () => {
  const byCat = countsByCategory(rows)

  test('one row per category in use, Other last, columns that add up', () => {
    assert.deepEqual(byCat.map(c => c.name), ['Laptop / Desktop', 'Phone', 'Other'])
    for (const c of byCat) {
      assert.equal(c.assigned + c.available + c.other + c.outOfService, c.total, c.name)
    }
  })

  test('assigned and available are told apart', () => {
    const laptops = byCat.find(c => c.categoryKey === 'laptop_desktop')!
    assert.equal(laptops.total, 7)
    assert.equal(laptops.assigned, 3)
    assert.equal(laptops.available, 3)
    assert.equal(laptops.other, 1)
    const other = byCat.find(c => c.categoryKey === 'other')!
    assert.equal(other.outOfService, 1)
  })
})

// ─── The Active tile and its list agree (review finding 2 on #240) ──────────

describe('the Active assets tile opens exactly the rows it counts', () => {
  test('filtering the list by the tile status returns the tile count, and no retired row', () => {
    const s = summariseAssets(rows, attention)
    const opened = filterAssetRows(rows, { ...EMPTY_ASSET_FILTERS, status: ACTIVE_STATUS_FILTER })
    assert.equal(opened.length, s.active)
    assert.ok(!opened.some(r => OUT_OF_SERVICE_STATUSES.has(r.asset.status)))
    // …whereas the unfiltered list (what the tile used to open) is longer.
    assert.equal(filterAssetRows(rows, EMPTY_ASSET_FILTERS).length, s.active + s.outOfService)
  })

  test('Assigned and Available open their own counts too', () => {
    const s = summariseAssets(rows, attention)
    assert.equal(filterAssetRows(rows, { ...EMPTY_ASSET_FILTERS, status: 'assigned' }).length, s.assigned)
    assert.equal(filterAssetRows(rows, { ...EMPTY_ASSET_FILTERS, status: 'available' }).length, s.available)
  })

  test('"active" combines with the other filters like any status', () => {
    const phones = filterAssetRows(rows, { ...EMPTY_ASSET_FILTERS, status: ACTIVE_STATUS_FILTER, category: 'phone' })
    assert.deepEqual(phones.map(r => r.asset.id).sort(), ['p1', 'p2'])
  })

  test('the page wires the tile to that filter, and offers it in the Status dropdown', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/assets-access/page.tsx'), 'utf8')
    assert.match(src, /showList\(\{ status: target === 'active' \? ACTIVE_STATUS_FILTER : target \}\)/)
    assert.match(src, /value: ACTIVE_STATUS_FILTER, label: 'Active \(not retired \/ disposed\)'/)
  })
})
