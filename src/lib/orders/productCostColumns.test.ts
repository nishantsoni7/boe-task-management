/**
 * The product list's fabric and packing (owner, 2026-10-30): every figure is
 * the cost sheet's own rule, picked out per product and summed the workbook's
 * way. Pure; no database.
 *
 * Run:
 *   npx tsx --test src/lib/orders/productCostColumns.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { FabricFinishData, FabricFinishLine, LineValues } from './fabricFinishCost'
import {
  approvalsLine,
  comparisonText,
  costLineFor,
  productCost,
  productCostSummary,
} from './productCostColumns'

const values = (over: Partial<LineValues> = {}): LineValues => ({
  fabricMetresPerPiece: null, fabricPricePerMetre: null, packingCostPerPiece: null, packingType: null, finish: [], ...over,
})

const line = (over: Partial<FabricFinishLine> & { itemSequence: string }): FabricFinishLine => ({
  itemId: null, productName: null, productCode: null, quantity: 1, sortOrder: 0,
  sheet: null, typed: null, typedByName: null, typedAt: null, ...over,
})

const fabric = (value: string) => ({ heading: 'Fabric Approval', value, imagePath: null })

// The mockup's PI: four upholstered lines and a table, ₹58,880 fabric and ₹39,810 packing.
const LINES: FabricFinishLine[] = [
  line({ itemSequence: 'B001', itemId: 'i1', productName: 'Dining chair', quantity: 40,
    sheet: values({ fabricMetresPerPiece: 0.8, fabricPricePerMetre: 480, packingCostPerPiece: 250, packingType: 'Carton + foam', finish: [fabric('Velvet Teal V-214')] }) }),
  line({ itemSequence: 'B002', itemId: 'i2', productName: 'Bar stool', quantity: 12,
    sheet: values({ fabricMetresPerPiece: 0.6, fabricPricePerMetre: 480, packingCostPerPiece: 300, packingType: 'Carton', finish: [fabric('Leatherette Tan L-08')] }) }),
  line({ itemSequence: 'B003', itemId: 'i3', productName: 'Booth sofa', quantity: 6,
    sheet: values({ fabricMetresPerPiece: 7.5, fabricPricePerMetre: 620, packingCostPerPiece: 2200, packingType: 'Wooden crate', finish: [fabric('Velvet Teal V-214')] }) }),
  line({ itemSequence: 'B004', itemId: 'i4', productName: 'Lounge armchair', quantity: 6,
    sheet: values({ fabricMetresPerPiece: 3, fabricPricePerMetre: 676, packingCostPerPiece: 900, packingType: 'Carton + foam', finish: [fabric('PENDING')] }) }),
  line({ itemSequence: 'B005', itemId: 'i5', productName: 'Dining table', quantity: 10,
    sheet: values({ packingCostPerPiece: 761, packingType: 'Wooden crate', finish: [{ heading: 'Marble/Rope Approval', value: 'Statuario', imagePath: null }] }) }),
]

const data = (over: Partial<FabricFinishData> = {}): FabricFinishData => ({
  submissionId: 's1', status: 'draft', orderId: null, orderStatus: null, displayNumber: null, clientName: null,
  workbookName: null, sheetReadAt: null, canEdit: true,
  piFabricCost: { amount: 58880, meaning: 'numeric', text: null },
  piPackingCost: { amount: 39810, meaning: 'numeric', text: null },
  lines: LINES,
  ...over,
})

describe('one product’s fabric and packing', () => {
  test('metres, amount and rate for the fabric; amount, type and rate for the packing', () => {
    const cost = productCost(LINES[0])
    assert.equal(cost.metres, 32)
    assert.equal(cost.fabricAmount, 15360)
    assert.equal(cost.pricePerMetre, 480)
    assert.equal(cost.packingAmount, 10000)
    assert.equal(cost.packingType, 'Carton + foam')
    assert.equal(cost.packingPerPiece, 250)
    assert.deepEqual(cost.choice, { text: 'Velvet Teal V-214', done: true })
  })

  test('PENDING is a pending approval, not a choice', () => {
    assert.deepEqual(productCost(LINES[3]).choice, { text: 'PENDING', done: false })
  })

  test('no fabric heading: the first finish choice stands for the line', () => {
    const cost = productCost(LINES[4])
    assert.equal(cost.fabricAmount, null)
    assert.equal(cost.metres, null)
    assert.deepEqual(cost.choice, { text: 'Statuario', done: true })
  })

  test('nothing recorded: no choice at all', () => {
    assert.equal(productCost(line({ itemSequence: 'X' })).choice, null)
  })

  test('a typed value wins over the sheet’s, as on the cost sheet', () => {
    const typed = productCost({ ...LINES[0], typed: values({ fabricPricePerMetre: 500 }) })
    assert.equal(typed.pricePerMetre, 500)
    assert.equal(typed.fabricAmount, 16000)
  })
})

describe('matching a sheet line to its product row', () => {
  test('by the item row’s id first, then by the item number', () => {
    assert.equal(costLineFor(data(), { id: 'i3', itemSequence: 'B999' })?.itemSequence, 'B003')
    assert.equal(costLineFor(data(), { id: 'nope', itemSequence: 'B002' })?.itemSequence, 'B002')
    assert.equal(costLineFor(data(), { id: 'nope', itemSequence: null }), null)
    assert.equal(costLineFor(null, { id: 'i1', itemSequence: 'B001' }), null)
  })
})

describe('the three figures over the table', () => {
  test('fabric and packing totals the workbook’s way, and whether each matches the PI', () => {
    const summary = productCostSummary(data())
    assert.equal(summary.fabric.sum, 58884)
    assert.equal(summary.fabric.rounded, 58880, 'ROUND(SUM, -1), as the Master sheet does')
    assert.equal(summary.fabric.metres, 102.2)
    assert.equal(summary.fabric.products, 4)
    assert.equal(summary.fabric.comparison.state, 'matches')
    assert.equal(summary.packing.rounded, 39810)
    assert.equal(summary.packing.products, 5)
    assert.equal(comparisonText(summary.fabric.comparison, n => `₹${n}`), 'Matches the PI')
  })

  test('a PI line that disagrees says by how much, and which way', () => {
    const summary = productCostSummary(data({ piPackingCost: { amount: 39800, meaning: 'numeric', text: null } }))
    assert.equal(comparisonText(summary.packing.comparison, n => `₹${n}`), 'Differs from the PI by ₹10 more')
  })

  test('approvals: the products whose fabric and finish are approved, and the one that is not', () => {
    const { approvals } = productCostSummary(data())
    assert.equal(approvals.done, 4)
    assert.equal(approvals.total, 5)
    assert.deepEqual(approvals.pending, ['B004 Lounge armchair'])
    assert.equal(approvalsLine(approvals), '1 pending: B004 Lounge armchair')
    assert.equal(approvalsLine({ done: 5, total: 5, pending: [] }), 'All approved')
    assert.equal(approvalsLine({ done: 2, total: 5, pending: ['a', 'b', 'c'] }), '3 pending')
  })

  test('nothing quoted is "as applicable" — a null total, never ₹0', () => {
    const summary = productCostSummary(data({ lines: [line({ itemSequence: 'B1' })] }))
    assert.equal(summary.fabric.rounded, null)
    assert.equal(summary.packing.rounded, null)
  })
})
