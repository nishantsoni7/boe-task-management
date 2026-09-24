/**
 * ONE "EDIT PI" — the pure rules (20270103000000).
 *
 * Offline: no database, no React. What the database does with a proposal
 * (pending → authorized → accepted, V1 kept in force meanwhile) is proved in
 * supabase/tests/order_pi_edit_revisions_assertions.sql.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piEdit.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEditProposal,
  diffPi,
  editChangesSomething,
  initialEditState,
  newEditItem,
  normalizePi,
  normalizeProposal,
  parseAmount,
  priceEdit,
  retiredSequenceProblems,
  summarizeChanges,
  validateEdit,
  type PiContent,
  type PiEditState,
} from './piEdit'

const SUB = '11111111-1111-4111-8111-111111111111'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SHA = 'c'.repeat(64)

/** A PI whose workbook arithmetic is deliberately NOT our formula. */
const current = (): PiContent => ({
  submission: {
    client_name: 'Meridian Hotels', client_city: 'Coimbatore', contact_number: '9000000001',
    bill_to_name: 'Meridian Hotels Pvt Ltd', billing_address: '1 Invented Road, Coimbatore',
    ship_to_name: 'Site office', shipping_address: '2 Fictional Lane',
    creation_date: '2026-02-26', order_confirmation_date: '2026-03-01', due_date: '2026-05-01',
    dispatch_commitment: 'Within 60 days',
    payment_terms: '50% advance', billing_terms: null, commercial_terms_note: 'Ex-factory.',
    fabric_responsibility: 'client', billing_percentage: null,
    gross_product_amount: 300000, discount_amount: 0, subtotal_after_discount: 300000,
    fabric_cost: null, fabric_cost_meaning: 'notApplicable', fabric_cost_text: null,
    packing_cost: 5000, packing_cost_meaning: 'numeric', packing_cost_text: null,
    transportation_amount: null, transportation_text: 'as applicable',
    total_before_gst: 305000, gst_amount: 54900, grand_total: 359901, // ₹1 off, as a real workbook might be
    source_workbook_path: `submissions/${SUB}/original/v1.xlsx`, source_workbook_name: 'PI.xlsx',
    source_workbook_sha256: SHA, source_created_by: 'Dhruv', boe_gst: 'GSTIN', source_order_number: '0412',
  },
  items: [
    { id: A, source_row: 32, item_sequence: 'B001', source_product_code: '407-B001', product_name: 'Lounge chair',
      quantity: 10, dimensions: '30x30', material: 'Teak', customization: null, cost_per_piece: 20000,
      total_amount: 200000, sort_order: 0 },
    { id: B, source_row: 33, item_sequence: 'B002', source_product_code: '407-B002', product_name: 'Coffee table',
      quantity: 5, dimensions: null, material: 'Oak', customization: 'Round top', cost_per_piece: 20000,
      total_amount: 100000, sort_order: 1 },
  ],
  images: [
    { item_id: A, role: 'representative', position: 0, storage_path: `submissions/${SUB}/images/${A}/representative/0-${SHA}.png`,
      mime_type: 'image/png', sha256: SHA, anchor_row: 32 },
    { item_id: B, role: 'customization', position: 1, storage_path: `submissions/${SUB}/images/${B}/customization/1-${SHA}.png`,
      mime_type: 'image/png', sha256: SHA, anchor_row: 33 },
  ],
})

let n = 0
const build = (state: PiEditState, content = current()) => buildEditProposal({
  current: content, state, priced: priceEdit(content, state), baseVersionId: 'v1',
  newId: () => `dddddddd-dddd-4ddd-8ddd-${String(++n).padStart(12, '0')}`,
  fingerprint: json => `fp-${json.length}`,
})

describe('the editor opens on the version in force', () => {
  test('every field, every line, in order', () => {
    const s = initialEditState(current())
    assert.equal(s.header.client_name, 'Meridian Hotels')
    assert.equal(s.header.client_city, 'Coimbatore')
    assert.equal(s.terms.fabric_responsibility, 'client')
    assert.deepEqual(s.items.map(i => i.product_name), ['Lounge chair', 'Coffee table'])
    assert.equal(s.items[0].quantity, '10')
    assert.equal(s.commercial.gst_percent, '18', 'GST % is read off the stored figures')
    assert.equal(s.commercial.fabric_cost, '', 'a worded cost is not turned into a number')
  })
  test('an untouched edit validates and changes nothing', () => {
    const s = initialEditState(current())
    assert.deepEqual(validateEdit(s), [])
    const diff = diffPi(normalizePi(current()), normalizeProposal(build(s)))
    assert.equal(editChangesSomething(diff), false)
    assert.deepEqual(summarizeChanges(diff), ['No changes'])
  })
})

describe('what changes money, and what does not', () => {
  test('renaming a product and correcting an address keep every stored figure', () => {
    const s = initialEditState(current())
    s.items[0].product_name = 'Lounge chair (walnut)'
    s.header.billing_address = '1 Invented Road, Coimbatore 641001'
    const priced = priceEdit(current(), s)
    assert.equal(priced.moneyChanged, false)
    assert.equal(priced.commercial.grand_total, 359901, 'the workbook’s own ₹1 is not "corrected"')
    assert.equal(priced.lines[0].total_amount, 200000)
  })

  test('a changed quantity re-prices with the one stated formula', () => {
    const s = initialEditState(current())
    s.items[0].quantity = '12'
    const c = priceEdit(current(), s).commercial
    assert.equal(c.gross_product_amount, 340000)
    assert.equal(c.subtotal_after_discount, 340000)
    assert.equal(c.total_before_gst, 345000, 'packing 5,000 kept; worded fabric and transport count as 0')
    assert.equal(c.gst_amount, 62100)
    assert.equal(c.grand_total, 407100)
    assert.equal(c.transportation_text, 'as applicable', 'the words are kept')
  })

  test('"1,200" is a number and "twelve" is not', () => {
    assert.equal(parseAmount('1,200'), 1200)
    assert.equal(parseAmount('₹ 1,20,000.50'), 120000.5)
    assert.equal(parseAmount(''), null)
    assert.ok(Number.isNaN(parseAmount('twelve') as number))
  })
})

describe('adding, removing and changing products', () => {
  test('an added line gets a new id and the next source row; a removed one is gone', () => {
    const s = initialEditState(current())
    s.items[1].removed = true
    s.items.push({ ...newEditItem('new-1'), product_name: 'Side table', quantity: '2', cost_per_piece: '7500' })
    const p = build(s)
    const items = p.payload.items as { id: string; source_row: number; product_name: string; total_amount: number }[]
    assert.deepEqual(items.map(i => i.product_name), ['Lounge chair', 'Side table'])
    assert.notEqual(items[1].id, B)
    assert.equal(items[1].source_row, 34)
    assert.equal((items[1] as unknown as { item_sequence: string }).item_sequence, 'B003',
      'an added line takes the next free sequence, so the PI stays submittable')
    assert.equal(items[1].total_amount, 15000)
    assert.equal((p.payload.commercial as { gross_product_amount: number }).gross_product_amount, 215000)
    const images = p.payload.item_images as { item_id: string }[]
    assert.ok(!images.some(m => m.item_id === B), 'the removed line takes its pictures with it')
  })

  test('a replaced photo becomes the representative image, and the legacy fields follow', () => {
    const s = initialEditState(current())
    const path = `submissions/${SUB}/images/${A}/representative/0-${'e'.repeat(64)}.jpg`
    s.items[0].photo = { kind: 'new', storage_path: path, sha256: 'e'.repeat(64), mime_type: 'image/jpeg' }
    s.items[1].photo = { kind: 'keep' }
    const p = build(s)
    const images = p.payload.item_images as { item_id: string; role: string; storage_path: string }[]
    assert.equal(images.find(m => m.item_id === A && m.role === 'representative')?.storage_path, path)
    assert.ok(images.some(m => m.item_id === B && m.role === 'customization'), 'customization pictures are kept')
    assert.equal((p.payload.items as { image_storage_path: string }[])[0].image_storage_path, path)
    assert.ok(p.change_summary.includes('1 photo changed'))
  })

  test('a removed photo leaves the line without one', () => {
    const s = initialEditState(current())
    s.items[0].photo = { kind: 'remove' }
    const p = build(s)
    assert.ok(!(p.payload.item_images as { item_id: string; role: string }[])
      .some(m => m.item_id === A && m.role === 'representative'))
  })
})

describe('the proposal keeps its origins honest', () => {
  test('the original workbook stays the source of record, and no workbook warning rides along', () => {
    const p = build(initialEditState(current()))
    assert.equal((p.payload.source as { workbook_path: string }).workbook_path, `submissions/${SUB}/original/v1.xlsx`)
    assert.deepEqual(p.payload.parse, { warnings: [], blocking_issues: [] })
    assert.ok(typeof p.payload.fingerprint === 'string')
    assert.deepEqual(Object.keys(p.payload.seed_terms as object).sort(), ['client_city', 'commercial_terms_note', 'fabric_responsibility'])
  })
  test('terms travel with the proposal, to be applied at acceptance', () => {
    const s = initialEditState(current())
    s.terms.fabric_responsibility = 'boe'
    s.terms.payment_terms = '30% advance, 70% before dispatch'
    const p = build(s)
    assert.equal(p.terms.fabric_responsibility, 'boe')
    assert.equal(p.terms.payment_terms, '30% advance, 70% before dispatch')
  })
})

describe('validation', () => {
  test('what makes an edit unsendable is named', () => {
    const s = initialEditState(current())
    s.header.client_name = ' '
    s.items[0].quantity = '0'
    s.items[1].cost_per_piece = 'abc'
    s.terms.fabric_responsibility = ''
    s.commercial.gst_percent = '40'
    const messages = validateEdit(s).map(p => p.message)
    assert.ok(messages.includes('Client name is required.'))
    assert.ok(messages.includes('Product 1: quantity must be more than 0.'))
    assert.ok(messages.includes('Product 2: price must be more than 0.'))
    assert.ok(messages.includes('Choose who provides the fabric.'))
    assert.ok(messages.includes('GST % must be a number from 0 to 28.'))
  })
  test('removing every product is refused', () => {
    const s = initialEditState(current())
    s.items.forEach(i => { i.removed = true })
    assert.ok(validateEdit(s).some(p => p.message === 'A PI needs at least one product.'))
  })
})

describe('the comparison an Admin reads', () => {
  test('changed fields with old and new values; product deltas; the grand total delta', () => {
    const s = initialEditState(current())
    s.header.client_city = 'Chennai'
    s.items[0].cost_per_piece = '21000'
    s.items.push({ ...newEditItem('new-2'), product_name: 'Bench', quantity: '1', cost_per_piece: '9000' })
    s.items[1].removed = true
    const diff = diffPi(normalizePi(current()), normalizeProposal(build(s)))
    assert.deepEqual(diff.fields.map(f => [f.label, f.before, f.after]).filter(([l]) => l === 'Client city'),
      [['Client city', 'Coimbatore', 'Chennai']])
    assert.deepEqual(diff.added.map(l => l.name), ['Bench'])
    assert.deepEqual(diff.removed.map(l => l.name), ['Coffee table'])
    const chair = diff.changed.find(c => c.name === 'Lounge chair')!
    assert.equal(chair.rateDelta, 1000)
    assert.equal(chair.totalDelta, 10000)
    assert.equal(chair.quantityDelta, null)
    assert.ok(diff.grandTotalDelta !== null && diff.grandTotalDelta < 0, 'a removed table outweighs a dearer chair')
    const summary = summarizeChanges(diff, x => `₹${x}`)
    assert.ok(summary.includes('1 product added') && summary.includes('1 product removed'))
    assert.ok(summary.some(l => l.startsWith('Grand total −₹')))
    // The summary STORED with a proposal is written in rupees, as screens show them.
    const stored = summarizeChanges(diff)
    assert.ok(stored.some(l => /^Grand total −₹\d{1,3}(,\d{2})*(,\d{3})?$/.test(l)), stored.join(' | '))
  })
})

describe('an item number once used on an Order is never handed out again (20270104000000)', () => {
  // V1 had B001 B002 B003; V2 removed B003. The Order remembers all three.
  const everUsed = ['B001', 'B002', 'B003']

  test('an added line skips every number the Order ever used, not only the current ones', () => {
    const s = initialEditState(current())
    s.items.push({ ...newEditItem('new-1'), product_name: 'Side table', quantity: '1', cost_per_piece: '5000' })
    const content = current()
    const p = buildEditProposal({
      current: content, state: s, priced: priceEdit(content, s), baseVersionId: 'v2',
      newId: () => 'eeeeeeee-eeee-4eee-8eee-000000000001', fingerprint: json => `fp-${json.length}`,
      retiredSequences: everUsed,
    })
    const items = p.payload.items as { item_sequence: string; product_name: string }[]
    assert.equal(items[2].item_sequence, 'B004', 'not B003, which a removed product held')
  })

  test('typing a removed product\'s number on an added line is refused while editing', () => {
    const s = initialEditState(current())
    s.items.push({ ...newEditItem('new-1'), item_sequence: 'b003', product_name: 'Lamp', quantity: '1', cost_per_piece: '4000' })
    const problems = retiredSequenceProblems(s, current(), everUsed)
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /already belonged to another product/)
  })

  test('a continuing line keeps its own number — renamed or not — but cannot take another\'s', () => {
    const s = initialEditState(current())
    s.items[0].product_name = 'Lounge chair, renamed'
    assert.deepEqual(retiredSequenceProblems(s, current(), everUsed), [], 'B001 stays with its own line')
    s.items[0].item_sequence = 'B002'
    assert.equal(retiredSequenceProblems(s, current(), everUsed).length, 1, 'but may not move to B002')
    s.items[0].item_sequence = 'B009'
    assert.deepEqual(retiredSequenceProblems(s, current(), everUsed), [], 'a never-used number is fine')
  })

  test('a removed line is not checked, and a blank number is left to the server to fill', () => {
    const s = initialEditState(current())
    s.items[1].removed = true
    s.items.push({ ...newEditItem('new-1'), product_name: 'Lamp', quantity: '1', cost_per_piece: '4000' })
    assert.deepEqual(retiredSequenceProblems(s, current(), everUsed), [])
  })
})
