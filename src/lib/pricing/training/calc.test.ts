import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyForm, emptyLine, problems, saveDoc, structureRest, toLine, totals, workCase, sizeOf, type Line } from './doc'
import { faceArea, newCalc, packCalc, unpackCalc, type Calc } from './calc'

const line = (p: Partial<Line>): Line => ({ ...emptyLine(), ...p })
const pct = (v: string, of: 'cost' | 'above' = 'cost'): Calc => ({ type: 'percent', pct: v, of })

// The shapes of the owner's two worked examples (23 Nov 2026), with made-up rupees: this repository is public, and his
// real costs and margins stay out of it.
describe('a chair: parts of the cost, then two percentages on top', () => {
  const cost = [line({ element: 'Wooden structure', kind: 'structure', amount: '1000' }), line({ element: 'Finish', amount: '400' }),
    line({ element: 'Seat weaving', kind: 'labour', amount: '300' }), line({ element: 'Back weaving', kind: 'labour', amount: '200' }), line({ element: 'Other', kind: 'other', amount: '100' })]
  test('added on the cost: 2,000 + 15% + 10% = 2,500', () => {
    const rows = [...cost, line({ element: 'Factory expense', kind: 'overhead', calc: pct('15') }), line({ element: 'Margin', kind: 'margin', calc: pct('10') })]
    assert.deepEqual(workCase(rows).map(w => w.amount), [1000, 400, 300, 200, 100, 300, 200])
    assert.equal(totals(rows).total, 2500)
  })
  test('stacked on everything above: 2,530, which is why each % row says which', () => {
    const rows = [...cost, line({ element: 'Factory expense', kind: 'overhead', calc: pct('15', 'above') }), line({ element: 'Margin', kind: 'margin', calc: pct('10', 'above') })]
    assert.equal(totals(rows).total, 2530)
  })
  test('a percentage counts the cost wherever it stands in the list', () => {
    const rows = [line({ element: 'Margin', kind: 'margin', calc: pct('25') }), ...cost]
    assert.equal(totals(rows).total, 2500)
  })
})

describe('a coffee table: top and four sides × a rate per sq ft, + finishing, + a percentage', () => {
  const form = { ...emptyForm(), name: 'Coffee table', width_in: '36', depth_in: '36', height_in: '24' }
  const rows = [line({ element: 'Top and sides', kind: 'material', calc: { type: 'area', faces: 'top_sides', rate: '200' } }),
    line({ element: 'Finishing', kind: 'labour', amount: '800' }), line({ element: 'Margin', kind: 'margin', calc: pct('30') })]
  test('36 × 36 × 24 in is 33 sq ft of top and sides: 6,600, and 9,620 in all', () => {
    assert.equal(faceArea('top_sides', sizeOf(form)), 33)
    const w = workCase(rows, sizeOf(form))
    assert.deepEqual(w.map(x => x.amount), [6600, 800, 2220])
    assert.equal(totals(rows, sizeOf(form)).total, 9620)
  })
  test('the same rule on a 48 × 24 × 18 in table: 26 sq ft, 7,800', () => {
    assert.equal(totals(rows, sizeOf({ width_in: '48', depth_in: '24', height_in: '18' })).total, 7800)
  })
  test('the area row keeps sq ft × rate in its own columns, and its calc', () => {
    const doc = saveDoc(form, rows)
    assert.deepEqual([doc.lines[0].quantity, doc.lines[0].unit, doc.lines[0].rate, doc.lines[0].amount], [33, 'sq ft', 200, 6600])
    assert.deepEqual(doc.lines[0].calc, { type: 'area', faces: 'top_sides', rate: 200 })
    assert.deepEqual([doc.lines[2].quantity, doc.lines[2].rate, doc.lines[2].amount], [null, null, 2220])
  })
  test('without the size the area cannot be worked out, and sending says so', () => {
    assert.deepEqual(problems({ ...form, height_in: '' }, rows, true), ["Element 1: Give the product's width and depth and height first."])
    assert.deepEqual(problems(form, rows, true), [])
  })
})

describe('a wooden structure from a cut list', () => {
  const calc: Calc = { type: 'wood', waste_pct: '30', rate: '2200', labour: '700', hardware: '150',
    parts: [{ name: 'Back legs', qty: '2', length: '36', width: '3', thick: '2' }, { name: 'Front legs', qty: '2', length: '18', width: '2', thick: '2' }] }
  const row = line({ element: 'Wooden structure', kind: 'structure', material: 'Acacia', calc })
  test('cu ft with waste × rate is the wood share; labour and hardware are the rest', () => {
    const [w] = workCase([row])
    // (0.25 + 0.0833) cu ft × 1.3 = 0.4333 cu ft × 2,200 = 953.33
    assert.equal(w.wood, 953.33); assert.equal(w.amount, 1803.33)
    assert.equal(structureRest(row), 850)
    const doc = saveDoc({ ...emptyForm(), name: 'Chair' }, [row])
    assert.equal(doc.lines[0].wood_amount, 953.33); assert.equal(doc.lines[0].amount, 1803.33)
    assert.equal(doc.lines[0].quantity, null)
  })
  test('it survives a round trip to the database and back', () => {
    const saved = saveDoc({ ...emptyForm(), name: 'Chair' }, [row]).lines[0]
    const back = toLine(saved)
    assert.deepEqual(back.calc, calc)
    assert.equal(back.wood, ''); assert.equal(back.amount, '')
    assert.equal(workCase([back])[0].amount, 1803.33)
  })
  test('sending needs the sizes and the rate', () => {
    const empty = line({ element: 'Wooden structure', kind: 'structure', calc: newCalc('wood') })
    assert.deepEqual(problems({ ...emptyForm(), name: 'Chair' }, [empty], true), ['Element 1: Give the sizes of at least one part of the cut list.'])
    assert.deepEqual(problems({ ...emptyForm(), name: 'Chair' }, [empty], false), [])
  })
})

describe('a metal frame weighed', () => {
  test('kg + cut loss × rate, + fabrication per kg, + coating by area', () => {
    const calc: Calc = { type: 'metal', metal: 'MS tube and pipe', density: '7850', rate: '75', loss_pct: '5', fab_per_kg: '40', coat_per_sqft: '12',
      parts: [{ name: 'Legs', profile: 'sqtube', a: '25', b: '', t: '1.6', unit: 'mm', gauge: '', corners: 'round', length: '0.75', length_unit: 'm', qty: '4' }] }
    const [w] = workCase([line({ element: 'Frame', kind: 'metal', calc })])
    const kg = 1.6 * (0.0314 * 25 - 0.044877 * 1.6) * 3 * 1.05      // 3.594 kg bought
    const sqft = 0.1 * 3 * 10.7639                                   // 3.229 sq ft
    assert.ok(Math.abs(w.amount - (Math.round(kg * 75 * 100) / 100 + Math.round(kg * 40 * 100) / 100 + Math.round(sqft * 12 * 100) / 100)) < 0.02, String(w.amount))
    assert.equal(w.problem, undefined)
  })
  test('a slip in a size is named with its part', () => {
    const calc = newCalc('metal') as Extract<Calc, { type: 'metal' }>
    calc.rate = '75'; calc.parts[0] = { ...calc.parts[0], a: '25', t: '16', length: '1' }
    assert.match(workCase([line({ element: 'Frame', kind: 'metal', calc })])[0].problem!, /^Part 1: The wall or thickness is too big/)
  })
})

describe('what the database keeps', () => {
  test('numbers as numbers, blanks as null, and junk is dropped on the way back', () => {
    assert.deepEqual(packCalc(pct('12.5', 'above')), { type: 'percent', pct: 12.5, of: 'above' })
    assert.deepEqual(packCalc({ type: 'area', faces: 'all', rate: '' }), { type: 'area', faces: 'all', rate: null })
    assert.equal(packCalc(null), null)
    assert.equal(unpackCalc({ type: 'magic' }), null); assert.equal(unpackCalc('wood'), null); assert.equal(unpackCalc(null), null)
    assert.deepEqual(unpackCalc({ type: 'area', faces: 'sideways', rate: 9 }), { type: 'area', faces: 'top', rate: '9' })
    const m = unpackCalc({ type: 'metal', parts: [{ profile: 'zigzag', unit: 'yards', corners: 'x', qty: 2 }, 'junk'] })
    assert.ok(m && m.type === 'metal'); assert.equal(m.parts.length, 1)
    assert.deepEqual([m.parts[0].profile, m.parts[0].unit, m.parts[0].corners, m.parts[0].qty], ['sqtube', 'mm', 'round', '2'])
  })
  test('a case says what its price is: level, inclusions and set size', () => {
    const doc = saveDoc({ ...emptyForm(), name: 'Set of 2 coffee tables', price_level: 'cost', includes: ['delivery', 'packing'], per_set: '2' }, [])
    assert.equal(doc.price_level, 'cost'); assert.deepEqual(doc.includes, ['packing', 'delivery']); assert.equal(doc.per_set, 2)
    assert.deepEqual(problems({ ...emptyForm(), name: 'x', per_set: '1' }, [], false), ['A set is 2 to 50 pieces.'])
    assert.deepEqual(problems({ ...emptyForm(), name: 'x', per_set: '2.5' }, [], false), ['A set is 2 to 50 pieces.'])
  })
})
