import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { byLikeness, lineWood, pickedCaseNo, taughtPrice, withPick, type TaughtCase } from './match'

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
