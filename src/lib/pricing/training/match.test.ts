import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { adjustment, borrowable, byLikeness, difference, lineWood, pickedCaseNo, pickPrice, quotedAgainst, readPick, taughtNow, taughtPrice, withPick, writePick, type TaughtCase, type TaughtQuote } from './match'

const WOODS = ['Sheesham', 'Teak', 'Mango']
const CHAIR: TaughtCase = { id: 'a', case_no: 12, name: 'Arm chair, cane back', variant: null, image_path: null, total: 5500, wood: 'sheesham', wood_amount: 2300, in_wood: { teak: 7800 } }

describe('a quotation line picks a taught product', () => {
  it('keeps the pick as a tag in the internal note, beside whatever else is written there', () => {
    assert.equal(pickedCaseNo('Client wants it darker'), null)
    const note = withPick('Client wants it darker', 12)
    assert.equal(note, 'Client wants it darker [Taught case #12]')
    assert.equal(pickedCaseNo(note), 12)
    assert.equal(withPick(note, 31), 'Client wants it darker [Taught case #31]')
    assert.equal(withPick(note, null), 'Client wants it darker')
    assert.equal(withPick(null, 7), '[Taught case #7]')
    assert.equal(withPick('[Taught case #7]', null), '')
  })

  it('reads the one wood a line names; none when it names two or none', () => {
    assert.equal(lineWood({ name: 'Chair C - 1', material: 'Solid teak wood, cane' }, WOODS), 'Teak')
    assert.equal(lineWood({ name: 'Chair', material: 'Teak or sheesham' }, WOODS), null)
    assert.equal(lineWood({ name: 'Chair', material: 'Steakhouse brown' }, WOODS), null)
  })

  it('gives the price in the line wood when the database worked one out, else the taught price', () => {
    assert.deepEqual(taughtPrice(CHAIR, { name: 'Chair', material: 'Teak' }, WOODS), { price: 7800, wood: 'Teak', swapped: true, noRate: null })
    assert.deepEqual(taughtPrice(CHAIR, { name: 'Chair', material: 'Sheesham' }, WOODS), { price: 5500, wood: 'sheesham', swapped: false, noRate: null })
    assert.deepEqual(taughtPrice(CHAIR, { name: 'Chair', material: 'Mango' }, WOODS), { price: 5500, wood: 'sheesham', swapped: false, noRate: 'Mango' })
    assert.deepEqual(taughtPrice(CHAIR, { name: 'Chair' }, WOODS), { price: 5500, wood: 'sheesham', swapped: false, noRate: null })
  })

  it('orders the picker with the most alike case first and drops none', () => {
    const table: TaughtCase = { ...CHAIR, id: 'b', case_no: 13, name: 'Dining table, marble top' }
    assert.deepEqual(byLikeness([table, CHAIR], { name: 'Armchair with cane back' }, WOODS).map(c => c.case_no), [12, 13])
  })
})

describe('a picked product that is different', () => {
  const A: TaughtCase = { ...CHAIR, parts: [{ element: 'Back weaving', kind: 'material', amount: 1000 }, { element: 'Finish; matte [PU]', kind: 'material', amount: 400 }] }
  const B: TaughtCase = { ...CHAIR, id: 'b', case_no: 4, name: 'Side chair', parts: [{ element: 'Brass caps', kind: 'material', amount: 350 }, { element: 'back weaving', kind: 'material', amount: 900 }] }

  it('writes the differences into the tag in words, and reads them back', () => {
    const pick = { caseNo: 12, without: ['Back weaving', 'Finish; matte [PU]'], with: [{ caseNo: 4, element: 'Brass caps' }] }
    const note = writePick('Darker', pick)
    assert.equal(note, 'Darker [Taught case #12; without Back weaving; without Finish matte PU; with #4 Brass caps]')
    assert.deepEqual(readPick(note), { caseNo: 12, without: ['Back weaving', 'Finish matte PU'], with: [{ caseNo: 4, element: 'Brass caps' }] })
    assert.equal(pickedCaseNo(note), 12)
    assert.equal(withPick(note, 12), 'Darker [Taught case #12]', 'picking a case again starts from the case as taught')
    assert.equal(writePick(note, null), 'Darker')
    assert.deepEqual(readPick('[Taught case #7]'), { caseNo: 7, without: [], with: [] })
  })

  it('moves the price by each element left out or added, and names what is no longer taught', () => {
    const pick = readPick('[Taught case #12; without back WEAVING; without Finish matte PU; without Cane seat; with #4 Brass caps; with #9 Arm pads]')!
    const a = adjustment(A, pick, [A, B])
    assert.equal(a.delta, -1000 - 400 + 350)
    assert.deepEqual(a.without.map(p => p.element), ['Back weaving', 'Finish; matte [PU]'])
    assert.deepEqual(a.with.map(x => [x.from.case_no, x.part.element]), [[4, 'Brass caps']])
    assert.deepEqual(a.lost, ['Cane seat', '#9 Arm pads'])
    assert.equal(adjustment(CHAIR, pick, [CHAIR]).delta, 0, 'before the migration is applied a case has no parts: nothing moves')
  })

  it('offers from other cases only the elements this case does not have', () => {
    assert.deepEqual(borrowable(A, [A, B]).map(x => x.part.element), ['Brass caps'])
    assert.deepEqual(borrowable(B, [A, B]).map(x => x.part.element), ['Finish; matte [PU]'])
  })
})

describe('the watcher: a quoted price against the taught one', () => {
  const C: TaughtCase = { ...CHAIR, parts: [{ element: 'Back weaving', kind: 'material', amount: 1000 }] }
  const lib = { cases: [C], woods: WOODS }
  const quote = (unit_price: number, internal_note: string, material = ''): TaughtQuote => ({ quotation_id: 'q', quote_no: 'Q-1', status: 'sent', updated_at: '2026-11-16', owner_name: 'A', name: 'Chair', material, unit_price, internal_note })

  it('asks only when the price is more than 5% away, and says which way', () => {
    assert.equal(difference(5500, 5500), null)
    assert.equal(difference(5225, 5500), null, 'exactly 5% is close enough')
    assert.deepEqual(difference(4840, 5500), { amount: 660, percent: 12, below: true })
    assert.deepEqual(difference(6050, 5500), { amount: 550, percent: 10, below: false })
    assert.equal(difference(null, 5500), null)
    assert.equal(difference(0, 5500), null)
  })

  it('keeps the reason in the tag, after the differences', () => {
    const note = writePick('', { caseNo: 12, without: ['Back weaving'], with: [], why: 'Quantity discount' })
    assert.equal(note, '[Taught case #12; without Back weaving; why Quantity discount]')
    assert.deepEqual(readPick(note), { caseNo: 12, without: ['Back weaving'], with: [], why: 'Quantity discount' })
    assert.equal(writePick(note, { ...readPick(note)!, why: null }), '[Taught case #12; without Back weaving]')
  })

  it('prices a pick whole: the wood of the line, then what it leaves out', () => {
    assert.equal(pickPrice(C, readPick('[Taught case #12; without Back weaving]')!, { name: 'Chair', material: 'Teak' }, lib), 6800)
  })

  it('sums up, per taught product, how the lines that picked it were priced', () => {
    const s = quotedAgainst(lib, [
      quote(5500, '[Taught case #12]'),
      quote(4000, '[Taught case #12; why Quantity discount]'),
      quote(4000, '[Taught case #12; why Quantity discount]'),
      quote(7000, '[Taught case #12]'),
      quote(4500, '[Taught case #12; without Back weaving]'),
      quote(9999, '[Taught case #77]'),
      quote(9999, 'no pick'),
    ]).get(12)!
    assert.deepEqual([s.lines, s.close, s.lower, s.higher], [5, 2, 2, 1])
    assert.deepEqual(s.reasons, { 'Quantity discount': 2 })
    assert.deepEqual(s.unexplained.map(u => [u.unit_price, u.taught]), [[7000, 5500]])
  })
})

describe('what a line\'s picked case comes to for the line (shown as "Your costing" in Why this price)', () => {
  const LIB = { cases: [CHAIR, { ...CHAIR, id: 'b', case_no: 4, name: 'Side chair', total: 4800, wood: 'teak', wood_amount: null, in_wood: {}, parts: [{ element: 'Brass caps', kind: 'material', amount: 350 }] }], woods: WOODS }
  it('is nothing for a line that picked nothing, or whose case is no longer submitted', () => {
    assert.equal(taughtNow(LIB, { name: 'Chair' }, 'Client wants it darker'), null)
    assert.equal(taughtNow(LIB, { name: 'Chair' }, '[Taught case #99]'), null)
  })
  it('is the price as taught, in the line wood when the database worked one out', () => {
    assert.deepEqual(taughtNow(LIB, { name: 'Chair', material: 'Sheesham' }, withPick('', 12)), { caseNo: 12, name: 'Arm chair, cane back', price: 5500 })
    assert.equal(taughtNow(LIB, { name: 'Chair', material: 'Teak' }, withPick('', 12))!.price, 7800)
  })
  it("is the server's answer once it has one for this case (and only for this case)", () => {
    assert.equal(taughtNow(LIB, { name: 'Chair' }, withPick('', 12), { caseNo: 12, price: 6100 })!.price, 6100)
    assert.equal(taughtNow(LIB, { name: 'Chair' }, withPick('', 12), { caseNo: 4, price: 1 })!.price, 5500, 'an answer for another case is ignored')
  })
  it('counts what the line leaves out or adds, as the Taught price box does', () => {
    const note = writePick('', { caseNo: 4, without: [], with: [] })
    assert.equal(taughtNow(LIB, { name: 'Chair' }, note)!.price, 4800)
    const added = writePick('', { caseNo: 12, without: [], with: [{ caseNo: 4, element: 'Brass caps' }] })
    assert.equal(taughtNow(LIB, { name: 'Chair' }, added)!.price, 5850)
  })
})
