// A revised PI workbook, read for the Admin before approval (acceptance review of
// #209, 2026-09-26). The preview must say what the approval will do: lines
// continue by item number exactly as approve_order_pi_revision() matches them,
// the terms the approval keeps are carried, and a photo counts as changed only
// when its bytes differ.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiWorkbook } from '@/lib/pi/types'
import { diffPi, normalizePi, type PiContent } from './piEdit'
import { approvalAdvanceNote, previewWorkbookRevision, WORKBOOK_REVISION_KEPT_FIELDS } from './workbookRevisionPreview'

const amt = (amount: number | null) => ({ amount, text: amount === null ? '' : String(amount) })
const bytes = (tag: string) => new TextEncoder().encode(tag)
// A deterministic stand-in for SHA-256: the picture's own text.
const hash = async (b: Uint8Array) => new TextDecoder().decode(b)

type P = { seq: string | null; name: string; qty: number; cost: number; photo?: string }
function workbook(products: P[], extra: { grand?: number } = {}): PiWorkbook {
  const gross = products.reduce((s, p) => s + p.qty * p.cost, 0)
  const rows = products.map((p, i) => 32 + i)
  return {
    header: {
      sourceOrderNumber: '407', creationDate: { iso: '2026-09-26', text: '' }, createdBy: 'Riya', boeGst: null,
      contactNumber: '9812345670', billToName: 'Saffron Residency Hotels Pvt Ltd', billToPhone: null, billToGst: null,
      billingAddress: 'Jaipur', shipToName: 'Site Store', shipToPhone: null, shipToGst: null, shippingAddress: 'Jaipur',
      orderConfirmationDate: { iso: '2026-09-25', text: '' }, dispatchCommitment: { iso: '2026-11-27', text: '2026-11-27' },
    },
    commercial: {
      discount: 0, grossProductAmount: gross, totalBeforeGst: amt(gross), gst: amt(Math.round(gross * 0.18)),
      grandTotal: amt(extra.grand ?? gross + Math.round(gross * 0.18)),
    },
    products: products.map((p, i) => ({
      row: rows[i], itemSequence: p.seq, sourceProductCode: null, productName: p.name, quantity: p.qty,
      dimensions: null, material: null, customization: null, costPerPiece: p.cost, lineTotal: p.qty * p.cost,
      representativeImage: null, customizationImages: [],
    })),
    representativeImages: products.flatMap((p, i) => p.photo ? [{ row: rows[i], bytes: bytes(p.photo) }] : []),
    customizationImages: [],
  } as unknown as PiWorkbook
}

function inForce(items: { id: string; seq: string | null; name: string; qty: number; cost: number; photo?: string }[]): PiContent {
  const gross = items.reduce((s, i) => s + i.qty * i.cost, 0)
  return {
    submission: {
      client_name: 'Saffron Residency Hotels Pvt Ltd', client_city: 'Jaipur', fabric_responsibility: 'boe',
      payment_terms: '40% advance', billing_terms: 'On dispatch', commercial_terms_note: 'Ex-factory', billing_percentage: 100,
      contact_number: '9812345670', bill_to_name: 'Saffron Residency Hotels Pvt Ltd', billing_address: 'Jaipur',
      ship_to_name: 'Site Store', shipping_address: 'Jaipur', creation_date: '2026-09-26',
      order_confirmation_date: '2026-09-25', due_date: '2026-11-27', dispatch_commitment: '2026-11-27',
      gross_product_amount: gross, discount_amount: 0, total_before_gst: gross, gst_amount: Math.round(gross * 0.18),
      grand_total: gross + Math.round(gross * 0.18),
    },
    items: items.map((i, n) => ({
      id: i.id, source_row: 32 + n, item_sequence: i.seq, source_product_code: null, product_name: i.name,
      quantity: i.qty, dimensions: null, material: null, customization: null, cost_per_piece: i.cost,
      total_amount: i.qty * i.cost, sort_order: n,
    })),
    images: items.filter(i => i.photo).map(i => ({
      item_id: i.id, role: 'representative' as const, position: 0, storage_path: `stored/${i.id}.png`,
      mime_type: 'image/png', sha256: i.photo!, anchor_row: null,
    })),
  }
}

const CURRENT = inForce([
  { id: 'a', seq: 'B001', name: 'Lounge Chair', qty: 30, cost: 18500, photo: 'teak' },
  { id: 'b', seq: 'B002', name: 'Coffee Table', qty: 8, cost: 32000, photo: 'marble' },
  { id: 'c', seq: 'B006', name: 'Console Table', qty: 4, cost: 27500, photo: 'walnut' },
])

describe('a revised workbook, previewed as the approval will apply it', () => {
  test('a line continues the line in force with the same item number (case and spaces ignored)', async () => {
    const wb = workbook([
      { seq: ' b001 ', name: 'Lounge Chair', qty: 30, cost: 18500, photo: 'teak' },
      { seq: 'B002', name: 'Coffee Table', qty: 8, cost: 32000, photo: 'marble' },
      { seq: 'B006', name: 'Console Table', qty: 4, cost: 27500, photo: 'walnut' },
    ])
    const { pi, needsReview } = await previewWorkbookRevision(wb, CURRENT, hash)
    assert.deepEqual(pi.lines.map(l => l.id), ['a', 'b', 'c'])
    assert.deepEqual(needsReview, [])
    const d = diffPi(normalizePi(CURRENT), pi)
    assert.equal(d.added.length, 0)
    assert.equal(d.removed.length, 0)
    assert.equal(d.changed.length, 0, 'the same lines, prices and photos are no change')
  })

  test('a new item number is an added product; an in-force line with no continuation is removed; a price change is a change', async () => {
    const wb = workbook([
      { seq: 'B001', name: 'Lounge Chair', qty: 30, cost: 18500, photo: 'teak' },
      { seq: 'B002', name: 'Coffee Table', qty: 8, cost: 33000, photo: 'marble' },
      { seq: 'B008', name: 'Accent Chair', qty: 4, cost: 21500, photo: 'cane' },
    ])
    const { pi } = await previewWorkbookRevision(wb, CURRENT, hash)
    const d = diffPi(normalizePi(CURRENT), pi)
    assert.deepEqual(d.added.map(l => l.name), ['Accent Chair'])
    assert.deepEqual(d.removed.map(l => l.name), ['Console Table'])
    assert.deepEqual(d.changed.map(c => c.name), ['Coffee Table'])
  })

  test('a blank or repeated item number is flagged for the Admin to match, and is not silently matched', async () => {
    const wb = workbook([
      { seq: null, name: 'Lounge Chair', qty: 30, cost: 18500 },
      { seq: 'B002', name: 'Coffee Table', qty: 8, cost: 32000 },
      { seq: 'B002', name: 'Coffee Table (spare)', qty: 1, cost: 32000 },
    ])
    const { pi, needsReview } = await previewWorkbookRevision(wb, CURRENT, hash)
    assert.deepEqual(needsReview.map(r => [r.name, r.why]), [
      ['Lounge Chair', 'no item number'],
      ['Coffee Table', 'item number used more than once'],
      ['Coffee Table (spare)', 'item number used more than once'],
    ])
    assert.ok(pi.lines.every(l => !['a', 'b'].includes(l.id)), 'none of them continues a line in force')
  })

  test('the terms the approval keeps are carried from the PI in force, never shown as a change', async () => {
    const { pi } = await previewWorkbookRevision(workbook([{ seq: 'B001', name: 'Lounge Chair', qty: 30, cost: 18500 }]), CURRENT, hash)
    const before = normalizePi(CURRENT)
    for (const key of WORKBOOK_REVISION_KEPT_FIELDS) assert.equal(pi.fields[key], before.fields[key], key)
  })

  test('the figures the approval replaces come from the workbook', async () => {
    const { pi } = await previewWorkbookRevision(workbook([{ seq: 'B001', name: 'Lounge Chair', qty: 40, cost: 18500 }], { grand: 873200 }), CURRENT, hash)
    assert.equal(pi.grandTotal, 873200)
    assert.equal(pi.fields.gross_product_amount, '740000')
  })

  test('a photo counts as changed only when its bytes differ', async () => {
    const wb = workbook([
      { seq: 'B001', name: 'Lounge Chair', qty: 30, cost: 18500, photo: 'teak' },
      { seq: 'B002', name: 'Coffee Table', qty: 8, cost: 32000, photo: 'marble-v2' },
      { seq: 'B006', name: 'Console Table', qty: 4, cost: 27500, photo: 'walnut' },
    ])
    const { pi } = await previewWorkbookRevision(wb, CURRENT, hash)
    const d = diffPi(normalizePi(CURRENT), pi)
    assert.deepEqual(d.changed.filter(c => c.photoChanged).map(c => c.name), ['Coffee Table'])
  })
})

describe('what approving does to the 40% position', () => {
  test('silent while the verified advance still covers the new value', () => {
    assert.equal(approvalAdvanceNote(735000, 1814132), null)
    assert.equal(approvalAdvanceNote(null, 1814132), null)
    assert.equal(approvalAdvanceNote(735000, null), null)
  })

  test('says a hold opens, with the figures the hold will carry (Order 0526, PI V2)', () => {
    const note = approvalAdvanceNote(675000, 1831832)
    assert.ok(note)
    assert.match(note!, /puts production on hold/)
    assert.match(note!, /₹6,75,000\.00 is 36\.85% of the new ₹18,31,832\.00/)
    assert.match(note!, /₹57,732\.80 more must be verified/)
  })
})
