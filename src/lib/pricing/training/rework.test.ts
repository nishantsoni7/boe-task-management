import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rateBook, rework, type ReworkCase, type SavedRow } from './rework'

// Made-up rupees (this repository is public).
const row = (p: Partial<SavedRow>): SavedRow => ({ element: 'x', kind: 'material', material: null, quantity: null, unit: null, rate: null, amount: 0, wood_amount: null, calc: null, ...p })
const book = rateBook([{ name: 'Acacia', rate: 2400 }, { name: 'Sheesham', rate: 3000 }, { name: 'Mango', rate: null }], [{ name: 'MS tube and pipe', rate: 80 }])

describe('a taught case worked out again for one quotation line', () => {
  const table: ReworkCase = { case_no: 1, name: 'Coffee table', width_in: 36, depth_in: 36, height_in: 24, per_set: null, rows: [
    row({ element: 'Top and sides', quantity: 33, unit: 'sq ft', rate: 200, amount: 6600, calc: { type: 'area', faces: 'top_sides', rate: 200 } }),
    row({ element: 'Finishing', kind: 'labour', amount: 800 }),
    row({ element: 'Margin', kind: 'margin', amount: 2220, calc: { type: 'percent', pct: 30, of: 'cost' } }),
  ] }
  test('an area rule follows the line\'s size, and the percentage follows the new cost', () => {
    const w = rework(table, { size: '48 x 24 x 18', wood: null }, book)
    assert.equal(w.taught, 9620); assert.equal(w.price, 7800); assert.equal(w.sized, true)
    assert.deepEqual(w.rows.map(r => r.amount), [5200, 800, 1800])
    assert.match(w.changes[0], /Area worked out for 48 × 24 × 18 in \(taught at 36 × 36 × 24\)/)
  })
  test('a line without a size readable as width and depth keeps the taught size', () => {
    for (const size of [null, 'Standard size', '36 x 36 x 24']) {
      const w = rework(table, { size, wood: null }, book)
      assert.equal(w.price, 9620); assert.equal(w.sized, false); assert.deepEqual(w.changes, [])
    }
  })

  const chair: ReworkCase = { case_no: 2, name: 'Dining chair', width_in: 18, depth_in: 20, height_in: 34, per_set: null, rows: [
    row({ element: 'Wooden structure', kind: 'structure', material: 'Acacia', amount: 1803.33, wood_amount: 953.33,
      calc: { type: 'wood', waste_pct: 30, rate: 2200, labour: 700, hardware: 150, parts: [{ name: 'Back legs', qty: 2, length: 36, width: 3, thick: 2 }, { name: 'Front legs', qty: 2, length: 18, width: 2, thick: 2 }] } }),
    row({ element: 'Margin', kind: 'margin', amount: 450.83, calc: { type: 'percent', pct: 25, of: 'cost' } }),
  ] }
  test('a cut list is priced at today\'s rate of its wood', () => {
    const w = rework(chair, { size: null, wood: null }, book)
    assert.equal(w.taught, 2254.16); assert.equal(w.price, 2363) // 0.4333 cu ft × 2,400 + 850, + 25%
    assert.equal(w.wood, 'Acacia')
    assert.ok(w.changes.some(x => /Acacia at ₹2,400 per cu ft today \(taught at ₹2,200\)/.test(x)))
  })
  test('in the line\'s wood when that wood has a rate; otherwise in the taught wood, and it says so', () => {
    const sh = rework(chair, { size: null, wood: 'sheesham' }, book)
    assert.equal(sh.price, 2688); assert.equal(sh.wood, 'Sheesham')     // 0.4333 × 3,000 + 850 = 2,150, + 25%
    const teak = rework(chair, { size: null, wood: 'Teak' }, book)
    assert.equal(teak.price, 2363); assert.equal(teak.wood, 'Acacia')
    assert.ok(teak.changes.some(x => /No rate for Teak yet: priced in Acacia/.test(x)))
  })

  test('one structure price with a wood share: in another wood only the wood share changes', () => {
    const c: ReworkCase = { case_no: 3, name: 'Arm chair', width_in: null, depth_in: null, height_in: null, per_set: null, rows: [
      row({ element: 'Wooden structure', kind: 'structure', material: 'Sheesham', amount: 4500, wood_amount: 2300 }),
      row({ element: 'Cane back', amount: 1000 }),
    ] }
    const b = rateBook([{ name: 'Sheesham', rate: 2300 }, { name: 'Teak', rate: 4600 }], [])
    const w = rework(c, { size: null, wood: 'Teak' }, b)
    assert.equal(w.price, 7800); assert.equal(w.wood, 'Teak')           // 5,500 - 2,300 + 2,300 × 4,600 / 2,300
    assert.equal(rework(c, { size: null, wood: null }, b).price, 5500)
    const noShare = rework({ ...c, rows: [row({ element: 'Wooden structure', kind: 'structure', material: 'Sheesham', amount: 4500 })] }, { size: null, wood: 'Teak' }, b)
    assert.equal(noShare.price, 4500); assert.ok(noShare.changes.some(x => /no wood share to price it in Teak/.test(x)))
  })

  test('a metal frame is priced at today\'s rate per kg of its metal', () => {
    const calc = { type: 'metal', metal: 'MS tube and pipe', density: 7850, rate: 75, loss_pct: 0, fab_per_kg: 0, coat_per_sqft: 0,
      parts: [{ name: 'Legs', profile: 'sqtube', a: 25, b: null, t: 1.6, unit: 'mm', gauge: null, corners: 'round', length: 1, length_unit: 'm', qty: 10 }] }
    const kg = 1.6 * (0.0314 * 25 - 0.044877 * 1.6) * 10                // 11.41 kg
    const c: ReworkCase = { case_no: 4, name: 'Frame', width_in: null, depth_in: null, height_in: null, per_set: null, rows: [row({ element: 'Frame', kind: 'metal', amount: Math.round(kg * 75 * 100) / 100, calc })] }
    const w = rework(c, { size: null, wood: null }, book)
    assert.equal(w.price, Math.round(kg * 80))
    assert.ok(w.changes.some(x => /MS tube and pipe at ₹80 per kg today \(taught at ₹75\)/.test(x)))
  })
})

describe('who gets what', () => {
  test('the route checks the person first, reads with the server credential, writes nothing, and sends rows only to Pricing people', () => {
    const route = readFileSync('src/app/api/pricing/taught/rework/route.ts', 'utf8')
    assert.ok(route.indexOf("rpc('quotation_my_access')") < route.indexOf('adminClient()'), 'the person is checked before the server credential is used')
    assert.match(route, /const sees = !pricing\.error/)
    assert.match(route, /return \[sees \? \{ \.\.\.base, rows: w\.rows, changes: w\.changes \} : base\]/)
    assert.doesNotMatch(route, /\.(insert|update|upsert|delete)\(/)
    assert.match(route, /\.eq\('status', 'submitted'\)/)
  })
  test('the builder asks after the typing stops, and the line shows the answer for the case it still picks', () => {
    const screen = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    assert.match(screen, /setTimeout\(\(\) => setSettledAsk\(reworkAsk\), 800\)/)
    assert.match(screen, /fetchRework\(supabase, JSON\.parse\(settledAsk\) as ReworkAsk\[\]\)/)
    const card = readFileSync('src/components/pricing/training/TaughtPrice.tsx', 'utf8')
    assert.match(card, /const fresh = c && rework && rework\.caseNo === c\.case_no \? rework : null/)
  })
})
