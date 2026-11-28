import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyLine, totals, type Line } from './doc'
import type { Size } from './calc'
import { boxProblems, buildUp, emptyBoxes, mergeBoxes, splitBoxes, withOf, withPct, type Boxes } from './boxes'

const NO_SIZE: Size = { width: null, depth: null, height: null }
const row = (element: string, amount: string, kind: Line['kind'] = 'material'): Line => ({ ...emptyLine(), element, kind, amount })
const pct = (element: string, kind: 'overhead' | 'margin' | 'labour', p: string, of: 'cost' | 'above' = 'cost'): Line => ({ ...emptyLine(), element, kind, calc: { type: 'percent', pct: p, of } })
// The owner's chair of 23 Nov 2026: structure 1,700 + finish 500 + weaving 1,100 + other 200 = 3,500.
const chair = [row('Structure', '1700', 'structure'), row('Finish', '500'), row('Weaving', '1100'), row('Other', '200', 'other')]
const boxes = (o: string, m: string, of: 'cost' | 'above' = 'cost'): Boxes => { const b = emptyBoxes(); return { overhead: withPct(b.overhead, o), margin: withOf(withPct(b.margin, m), of) } }

describe('overhead and margin boxes', () => {
  test("the owner's chair: 3,500 + 20% factory + 20% margin, both on the cost, is 4,900", () => {
    const b = buildUp(chair, boxes('20', '20'), NO_SIZE)
    assert.deepEqual([b.cost, b.overhead, b.margin, b.total], [3500, 700, 700, 4900])
  })
  test('margin on the cost plus overhead is worked on 4,200', () => {
    const b = buildUp(chair, boxes('20', '20', 'above'), NO_SIZE)
    assert.deepEqual([b.above, b.margin, b.total], [4200, 840, 5040])
  })
  test('a blank or zero box adds no row and no money', () => {
    for (const b of [boxes('', ''), boxes('0', '0')]) {
      assert.equal(mergeBoxes(chair, b).length, chair.length)
      assert.equal(buildUp(chair, b, NO_SIZE).total, 3500)
    }
  })
  test('the boxes go after the elements, overhead first, so an element added later is still under both', () => {
    const merged = mergeBoxes([...chair, row('Hardware', '300')], boxes('10', '20'))
    assert.deepEqual(merged.slice(-2).map(l => l.kind), ['overhead', 'margin'])
    assert.equal(buildUp([...chair, row('Hardware', '300')], boxes('10', '20'), NO_SIZE).total, 4940) // 3,800 + 380 + 760
  })
  test('the cost shows by kind and a flat overhead amount is part of the cost', () => {
    const b = buildUp([row('Frame', '1000', 'structure'), row('Cane', '500'), row('Factory', '200', 'overhead')], boxes('10', ''), NO_SIZE)
    assert.deepEqual([b.byKind.structure, b.byKind.material, b.byKind.overhead, b.cost, b.overhead, b.total], [1000, 500, 200, 1700, 170, 1870])
  })
  test('a percentage left among the elements is counted once and shown on its own', () => {
    const lines = [...chair, pct('Labour uplift', 'labour', '10')]
    const b = buildUp(lines, boxes('20', ''), NO_SIZE)
    assert.deepEqual([b.cost, b.extra, b.overhead, b.total], [3500, 350, 700, 4550])
  })
  test('the percentage must be a number and not a slip', () => {
    assert.deepEqual(boxProblems(boxes('20', '')), [])
    assert.deepEqual(boxProblems(boxes('x', '600')), ['Overhead: the percentage must be a number.', 'Margin: 600% looks like a slip.'])
  })
})

describe('opening a saved case', () => {
  test('trailing overhead and margin rows move into the boxes and keep their own names; the price does not change', () => {
    const all = [...chair, pct('Factory Expense', 'overhead', '20'), pct('Margin', 'margin', '20', 'above')]
    const { lines, boxes: b } = splitBoxes(all, NO_SIZE)
    assert.equal(lines.length, chair.length)
    assert.equal(b.overhead.element, 'Factory Expense')
    assert.equal(buildUp(lines, b, NO_SIZE).total, totals(all, NO_SIZE).total)
  })
  test('an overhead "of the cost" in the middle moves too (it does not depend on where it stands)', () => {
    const all = [chair[0], pct('Overhead', 'overhead', '20'), ...chair.slice(1)]
    const { lines, boxes: b } = splitBoxes(all, NO_SIZE)
    assert.equal(lines.length, chair.length)
    assert.equal(b.overhead.calc?.type === 'percent' && b.overhead.calc.pct, '20')
    assert.equal(buildUp(lines, b, NO_SIZE).total, 4200)
  })
  test('a margin "of everything above" with elements below it stays a row, so no figure moves', () => {
    const all = [chair[0], pct('Margin', 'margin', '20', 'above'), ...chair.slice(1)]
    const { lines, boxes: b } = splitBoxes(all, NO_SIZE)
    assert.equal(lines.length, all.length)
    assert.equal(mergeBoxes(lines, b).length, all.length)
    assert.equal(totals(mergeBoxes(lines, b), NO_SIZE).total, totals(all, NO_SIZE).total)
  })
  test('a case with no overhead or margin row opens with two empty boxes', () => {
    const { lines, boxes: b } = splitBoxes(chair, NO_SIZE)
    assert.equal(lines.length, chair.length)
    assert.deepEqual([b.overhead.kind, b.margin.kind], ['overhead', 'margin'])
    assert.equal(mergeBoxes(lines, b).length, chair.length)
  })
  test('the rows saved and opened again give the same total, whatever was there', () => {
    const cases: Line[][] = [
      [...chair, pct('Overhead', 'overhead', '15'), pct('Margin', 'margin', '25')],
      [...chair, pct('Margin', 'margin', '25', 'above'), pct('Overhead', 'overhead', '15')],
      [pct('Overhead', 'overhead', '10'), ...chair, pct('Overhead 2', 'overhead', '5')],
      [...chair, row('Flat margin', '400', 'margin')],
    ]
    for (const all of cases) {
      const { lines, boxes: b } = splitBoxes(all, NO_SIZE)
      assert.equal(totals(mergeBoxes(lines, b), NO_SIZE).total, totals(all, NO_SIZE).total, all.map(l => l.element).join(', '))
    }
  })
})

describe('what a new case starts with', () => {
  test("a chair starts with the owner's 20% factory expense and 20% margin on the cost; anything else starts blank", async () => {
    const { startBoxes, boxPct } = await import('./boxes')
    for (const name of ['Chair', 'Dining chair, cane back', 'Wooden Chair']) {
      const b = startBoxes(name)
      assert.deepEqual([boxPct(b.overhead), boxPct(b.margin)], ['20', '20'], name)
      assert.deepEqual(buildUp(chair, b, NO_SIZE).total, 4900, 'his 23 Nov chair: 3,500 plus 40% on the cost')
    }
    for (const name of ['Coffee table', 'Booth sofa', '']) assert.deepEqual([boxPct(startBoxes(name).overhead), boxPct(startBoxes(name).margin)], ['', ''], name)
  })
})
