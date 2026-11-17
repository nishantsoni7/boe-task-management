// What the PI sheet card draws for an old order: the products with picture, rupees, totals, the notes
// and the words when there is no list. Invented data; real orders never enter the repository.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { PiSheetCard, type PiSheetReply } from './PiSheetSection'
import type { PiSheetView } from '@/lib/orders/clickupPiSheet'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const sheet = (patch: Partial<PiSheetView> = {}): PiSheetView => ({
  kind: 'pi', title: null, footnotes: [],
  piNo: '407', date: '30 Sep 2026', salesperson: 'Salesperson One',
  billTo: { name: 'Example Buyer Ltd', phone: '9000000002', address: '1 Invented Road' },
  shipTo: { name: null, phone: null, address: null },
  lines: [
    { row: 32, code: '407-B001', name: 'Bed', quantity: 6, size: 'King Size', material: 'Teak', rate: 47500, total: 285000, customization: null, picture: 'data:image/jpeg;base64,AAAA' },
    { row: 33, code: '407-B002', name: 'Sidetable', quantity: 12, size: null, material: null, rate: 14800, total: 177600, customization: null, picture: null },
  ],
  totals: [{ label: 'Subtotal', value: '₹4,62,600' }, { label: 'Grand total', value: '₹5,45,868' }],
  problems: [], missingPictures: 1,
  ...patch,
})

const reply = (patch: Partial<PiSheetReply> = {}): PiSheetReply => ({
  applies: true, files: [{ id: 'a.xlsx', name: '407 Sample ji.xlsx', uploaded_at: '2026-10-01T12:09:56.000Z' }], current: 'a.xlsx', sheet: sheet(), reason: null, ...patch,
})

describe('the PI sheet card', () => {
  test('products with picture, code, name, size, quantity, rate and total in rupees, then the totals', () => {
    const html = renderToStaticMarkup(<PiSheetCard reply={reply()} />)
    const t = text(html)
    assert.ok(html.includes('src="data:image/jpeg;base64,AAAA"'))
    for (const word of ['407-B001', 'Bed', 'King Size', 'Teak', '₹47,500', '₹2,85,000', 'Sidetable', '₹1,77,600', 'Subtotal', 'Grand total', '₹5,45,868', 'Example Buyer Ltd', 'PI 407']) {
      assert.ok(t.includes(word), `${word} is drawn`)
    }
    assert.ok(t.includes('1 of 2 lines have no picture in the sheet'))
    assert.ok(t.includes('read from 407 Sample ji.xlsx'))
  })

  test('the Customization column appears only when a line has one', () => {
    assert.equal(text(renderToStaticMarkup(<PiSheetCard reply={reply()} />)).includes('Customization'), false)
    const withOne = sheet({ lines: [{ ...sheet().lines[0], customization: 'Walnut finish' }] })
    const t = text(renderToStaticMarkup(<PiSheetCard reply={reply({ sheet: withOne })} />))
    assert.ok(t.includes('Customization') && t.includes('Walnut finish'))
  })

  test('a sheet with problems says to check the Excel and lists them', () => {
    const html = renderToStaticMarkup(<PiSheetCard reply={reply({ sheet: sheet({ problems: ['Row 33 has no valid price.'] }) })} />)
    assert.ok(html.includes('role="alert"'))
    assert.ok(text(html).includes('Check the Excel') && text(html).includes('Row 33 has no valid price.'))
  })

  test('several Excel files give a switch, newest first, each with its upload date', () => {
    const files = [
      { id: 'b.xlsx', name: '407 Final.xlsx', uploaded_at: '2026-10-05T12:00:00.000Z' },
      { id: 'a.xlsx', name: '407 First.xlsx', uploaded_at: '2026-10-01T12:00:00.000Z' },
    ]
    const html = renderToStaticMarkup(<PiSheetCard reply={reply({ files, current: 'b.xlsx' })} />)
    assert.ok(html.includes('<select'))
    assert.ok(html.indexOf('407 Final.xlsx') < html.indexOf('407 First.xlsx'))
    assert.ok(/<option[^>]*value="b.xlsx"[^>]*selected|<option[^>]*selected[^>]*value="b.xlsx"/.test(html) || html.includes('value="b.xlsx"'))
    assert.equal(renderToStaticMarkup(<PiSheetCard reply={reply()} />).includes('<select'), false, 'one file needs no switch')
  })

  test('a quotation is worded as one: Description, Unit price, Notes, the client, the note under the totals', () => {
    const q = sheet({
      kind: 'quotation', title: 'Invented Cafe Project', piNo: 'QT-XX-00001', salesperson: null,
      lines: [{ row: 7, code: '900-BE001', name: 'Two Seater Table', quantity: 10, size: 'Acacia wood', material: null, rate: 8600, total: 86000, customization: 'Frame size to be confirmed', picture: null }],
      totals: [{ label: 'Subtotal', value: '₹86,000' }, { label: 'Discount', value: '-₹2,000' }],
      footnotes: ['Packing extra - 5000/-'], missingPictures: 1,
    })
    const html = renderToStaticMarkup(<PiSheetCard reply={reply({ sheet: q })} />)
    const t = text(html)
    for (const word of ['Quotation', 'Invented Cafe Project', 'Ref QT-XX-00001', 'Client', 'Description', 'Unit price', 'Notes', 'Acacia wood', '₹8,600', '-₹2,000', 'Packing extra - 5000/-', 'not a PI. The totals are as printed on the sheet']) {
      assert.ok(t.includes(word), `${word} is drawn`)
    }
    assert.equal(t.includes('Material'), false, 'a quotation has no Material column')
    assert.equal(t.includes('Bill to'), false)
    assert.ok(html.includes('aria-label="Quotation"'))
  })

  test('a PI keeps its own words', () => {
    const t = text(renderToStaticMarkup(<PiSheetCard reply={reply()} />))
    for (const word of ['PI sheet', 'Bill to', 'Size', 'Material', 'Rate']) assert.ok(t.includes(word), word)
    assert.equal(t.includes('not a PI'), false)
  })

  test('with no list it says why and points to the Excel under Files', () => {
    const t = text(renderToStaticMarkup(<PiSheetCard reply={reply({ sheet: null, reason: 'This Excel has no PI sheet (it may be a quotation).' })} />))
    assert.ok(t.includes('This Excel has no PI sheet'))
    assert.ok(t.includes('The Excel is under Files below.'))
  })
})
