import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { adjustment, borrowable, byLikeness, lineWood, pickedCaseNo, readPick, taughtPrice, withPick, writePick, type TaughtCase } from './match'

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
