// Scan first (owner, 2026-11-03): what the reader does with BOE's own papers. Every number, name and code here
// is INVENTED: the real sample papers hold client names and GSTINs, and this repository is public.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DISPATCH_PAPER_SYSTEM_PROMPT, DISPATCH_PAPER_TOOL, dispatchPaperInstruction } from './dispatchPaperPrompt'
import {
  invoiceVsEway,
  normalizeProductCode,
  paperOrderMismatch,
  parsePaperReading,
  placePaper,
  readingSummary,
  type PaperReading,
} from './dispatchPaperReading'

// Order 0540 has four lines; their item_sequences are NOT the codes' numbers, as on a real Order.
const KNOWN = new Set(['3', '7', '9', '12'])
const CODES = new Map([['540-BE0001', '3'], ['540-BE0002', '7'], ['540-BE0003', '9'], ['540-BE0004', '12']])
const blank = parsePaperReading({}, KNOWN, CODES)
const reading = (over: Partial<PaperReading>): PaperReading => ({ ...blank, ...over })

describe('a BOE product code, however it was printed', () => {
  it('becomes the one form the app uses', () => {
    assert.equal(normalizeProductCode('395-BE0007'), '395-BE0007')
    assert.equal(normalizeProductCode('395 - be 7 TRAY TABLE'), '395-BE0007')
    assert.equal(normalizeProductCode('0536-BE0012'), '536-BE0012')
    assert.equal(normalizeProductCode('TRAY TABLE'), null)
    assert.equal(normalizeProductCode(null), null)
    assert.equal(normalizeProductCode(42), null)
  })
})

describe('matching goods to the Order', () => {
  it('matches by the printed code, even when the model named the wrong line', () => {
    const r = parsePaperReading({ goods: [
      { item_sequence: '3', code: '540-BE0002', quantity: 5 },
      { code: '540 - BE 3', quantity: 2 },
    ] }, KNOWN, CODES)
    assert.deepEqual(r.goods, [{ itemSequence: '7', quantity: 5 }, { itemSequence: '9', quantity: 2 }])
  })
  it('falls back to the model\'s own match when the line has no code', () => {
    const r = parsePaperReading({ goods: [{ item_sequence: '12', quantity: 4 }] }, KNOWN, CODES)
    assert.deepEqual(r.goods, [{ itemSequence: '12', quantity: 4 }])
  })
  it('drops a line whose code is not this Order\'s, but remembers the code', () => {
    const r = parsePaperReading({ goods: [{ item_sequence: '3', code: '395-BE0007', quantity: 22 }] }, KNOWN, CODES)
    assert.deepEqual(r.goods.length, 1, 'the model named line 3 by meaning, which is still a line of this Order')
    const only = parsePaperReading({ goods: [{ code: '395-BE0007', quantity: 22 }] }, KNOWN, CODES)
    assert.deepEqual(only.goods, [])
    assert.deepEqual(only.printedCodes, ['395-BE0007'])
  })
})

describe('an invoice printed three times is read once', () => {
  const lines = (copies: number) => Array.from({ length: copies }, () => [
    { code: '540-BE0001', quantity: 22 }, { code: '540-BE0002', quantity: 4 }, { code: '540-BE0003', quantity: 8 },
  ]).flat()

  it('counts every product once when each came back once per copy, and says so', () => {
    const r = parsePaperReading({ goods: lines(3) }, KNOWN, CODES)
    assert.deepEqual(r.goods, [
      { itemSequence: '3', quantity: 22 }, { itemSequence: '7', quantity: 4 }, { itemSequence: '9', quantity: 8 },
    ])
    assert.equal(r.copies, 3)
    assert.equal(parsePaperReading({ goods: lines(2) }, KNOWN, CODES).copies, 2)
  })
  it('reads an invoice printed once as it is', () => {
    const r = parsePaperReading({ goods: lines(1) }, KNOWN, CODES)
    assert.equal(r.copies, 1)
    assert.equal(r.goods.length, 3)
  })
  it('still adds up one product that is on two lines of one invoice', () => {
    const r = parsePaperReading({ goods: [
      { code: '540-BE0001', quantity: 10 }, { code: '540-BE0001', quantity: 12 }, { code: '540-BE0002', quantity: 4 },
    ] }, KNOWN, CODES)
    assert.deepEqual(r.goods, [{ itemSequence: '3', quantity: 22 }, { itemSequence: '7', quantity: 4 }])
    assert.equal(r.copies, 1)
  })
  it('does not call it copies when the repeats differ', () => {
    const r = parsePaperReading({ goods: [
      { code: '540-BE0001', quantity: 10 }, { code: '540-BE0001', quantity: 12 },
      { code: '540-BE0002', quantity: 4 }, { code: '540-BE0002', quantity: 4 },
    ] }, KNOWN, CODES)
    assert.deepEqual(r.goods, [{ itemSequence: '3', quantity: 22 }, { itemSequence: '7', quantity: 8 }])
    assert.equal(r.copies, 1)
  })
})

describe('the e-way bill number is twelve digits', () => {
  it('is saved without spaces or hyphens, so the invoice and the e-way bill agree', () => {
    for (const printed of ['7616 8509 0730', '761685090730', ' 7616-8509-0730 ']) {
      assert.equal(parsePaperReading({ eway_bill_number: printed }, KNOWN).ewayBillNumber, '761685090730', printed)
    }
  })
  it('keeps anything else as printed, tidied', () => {
    assert.equal(parsePaperReading({ eway_bill_number: 'EWB  12 34' }, KNOWN).ewayBillNumber, 'EWB 12 34')
  })
})

describe('what a box says under a paper that was read', () => {
  it('counts the details and the products, and says an invoice was printed more than once', () => {
    const r = reading({
      kind: 'invoice', invoiceNumber: 'BE/26/170', invoiceDate: '2026-10-28', invoiceTotal: '1000', vehicleNumber: 'RJ19GH4963',
      goods: [{ itemSequence: '3', quantity: 1 }, { itemSequence: '7', quantity: 2 }], copies: 3,
    })
    assert.equal(readingSummary(r), 'Read 4 details · 2 products matched · printed 3 times, counted once')
  })
  it('is plain for one detail and nothing else', () => {
    assert.equal(readingSummary(reading({ ewayBillNumber: '761685090730' })), 'Read 1 detail')
  })
})

describe('papers for another Order', () => {
  it('names the other Order when its codes are not this Order\'s', () => {
    const r = reading({ printedCodes: ['395-BE0007', '395-BE0001'] })
    assert.equal(paperOrderMismatch(r, '0540'), '395')
  })
  it('is silent when the codes name this Order, with the stored number\'s zeros ignored', () => {
    assert.equal(paperOrderMismatch(reading({ printedCodes: ['540-BE0001'] }), '0540'), null)
    assert.equal(paperOrderMismatch(reading({ printedCodes: ['540-BE0001', '395-BE0001'] }), '0540'), null)
  })
  it('is silent when the paper prints no code, or the number is unknown', () => {
    assert.equal(paperOrderMismatch(reading({}), '0540'), null)
    assert.equal(paperOrderMismatch(reading({ printedCodes: ['395-BE0001'] }), null), null)
  })
})

describe('does the e-way bill cover the invoice', () => {
  it('matches the same document number whatever the spacing and case', () => {
    const check = invoiceVsEway([
      reading({ kind: 'invoice', invoiceNumber: 'BE/26/170' }), reading({ kind: 'eway_bill', invoiceNumber: 'be/26/170 ' }),
    ])
    assert.equal(check?.state, 'match')
  })
  it('says when they differ, and names both', () => {
    const check = invoiceVsEway([
      reading({ kind: 'invoice', invoiceNumber: 'BE/26/170' }), reading({ kind: 'eway_bill', invoiceNumber: 'BE/26/171' }),
    ])
    assert.deepEqual(check, { state: 'differ', invoice: 'BE/26/170', eway: 'BE/26/171' })
  })
  it('says nothing until both papers named a document', () => {
    assert.equal(invoiceVsEway([reading({ kind: 'invoice', invoiceNumber: 'BE/26/170' })]), null)
    assert.equal(invoiceVsEway([reading({ kind: 'eway_bill', invoiceNumber: 'BE/26/170' }), reading({ kind: 'invoice' })]), null)
  })
})

describe('which box a paper belongs in', () => {
  it('stays where the person put it when the reader agrees', () => {
    assert.deepEqual(placePaper('invoice', 'invoice'), { slot: 'invoice', kind: 'invoice', moved: false })
    assert.deepEqual(placePaper('eway_bill', 'eway_bill'), { slot: 'eway_bill', kind: 'eway_bill', moved: false })
  })
  it('moves to the right box when the reader says it is something else', () => {
    assert.deepEqual(placePaper('eway_bill', 'invoice'), { slot: 'eway_bill', kind: 'eway_bill', moved: true })
    assert.deepEqual(placePaper('invoice', 'eway_bill'), { slot: 'invoice', kind: 'invoice', moved: true })
    assert.deepEqual(placePaper('lr', 'invoice'), { slot: 'lr', kind: 'lr', moved: true })
  })
  it('puts a packing list with the transport papers, and keeps its own kind', () => {
    assert.deepEqual(placePaper('packing_list', 'invoice'), { slot: 'lr', kind: 'packing_list', moved: true })
    assert.deepEqual(placePaper('packing_list', 'lr'), { slot: 'lr', kind: 'packing_list', moved: false })
  })
  it('trusts the box the person chose when the reader cannot say what it is', () => {
    assert.deepEqual(placePaper('other', 'invoice'), { slot: 'invoice', kind: 'invoice', moved: false })
    assert.deepEqual(placePaper('other', 'lr'), { slot: 'lr', kind: 'lr', moved: false })
  })
})

describe('what the reader is asked', () => {
  it('knows about triplicate copies, product codes, the twelve digits, loaded boxes and Ship To', () => {
    assert.match(DISPATCH_PAPER_SYSTEM_PROMPT, /Duplicate and Triplicate/)
    assert.match(DISPATCH_PAPER_SYSTEM_PROMPT, /Read it ONCE/)
    assert.match(DISPATCH_PAPER_SYSTEM_PROMPT, /395-BE0007/)
    assert.match(DISPATCH_PAPER_SYSTEM_PROMPT, /12 digits: return the digits only, without spaces/)
    assert.match(DISPATCH_PAPER_SYSTEM_PROMPT, /No of total loaded boxes/)
    assert.match(DISPATCH_PAPER_SYSTEM_PROMPT, /Ship To/)
    assert.equal(/as printed, including their spaces/.test(DISPATCH_PAPER_SYSTEM_PROMPT), false, 'the e-way number is no longer copied with its spaces')
  })
  it('lets a goods line carry a printed code, and needs only a quantity', () => {
    const goods = DISPATCH_PAPER_TOOL.input_schema.properties.goods.items
    assert.ok(Object.keys(goods.properties).includes('code'))
    assert.deepEqual(goods.required, ['quantity'])
  })
  it('gives each of the Order\'s lines its own code, still as JSON, and none when it has none', () => {
    const text = dispatchPaperInstruction([
      { itemSequence: '3', productName: 'Tray table', quantity: 22, code: '540-BE0001' },
      { itemSequence: '7', productName: 'Sofa', quantity: 3, code: null },
    ])
    assert.ok(text.includes('{"item_sequence":"3","name":"Tray table","ordered":22,"code":"540-BE0001"}'))
    assert.ok(text.includes('{"item_sequence":"7","name":"Sofa","ordered":3}'))
  })
})
