/**
 * THE FABRIC, FINISH AND PACKING PAGE, run for real in jsdom (owner, 21 Nov 2026): one row per product with its picture; fabric and packing
 * priced per piece and multiplied by the quantity; finish only a code and a picture.
 *
 * Run: npm run test:file -- src/components/quotations/costingPage.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement, useEffect, useState } from 'react'
import '@/lib/testing/cssModuleStub'
import { CostingPage } from './CostingPage'
import type { QuoteArea, QuoteLine } from '@/lib/quotations/math'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const AREAS: QuoteArea[] = [{ key: 'a', name: 'Lobby lounge', style: '', multiplier: 1, unit_label: 'rooms' }]
const line = (key: string, name: string, qty: number, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key, area_key: 'a', name, size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'fixed', qty, unit_price: 10000, tax_rate: 18,
  image_path: `u/${key}.jpg`, is_optional: false, client_note: '', internal_note: '', ...over,
})
const START = () => [line('p1', 'Rocking chair', 3), line('p2', 'Side table', 1), line('p3', 'Bar stool', 6)]

let latest: QuoteLine[] = []
let uploads: File[] = []
function Parent({ start = START(), editable = true }: { start?: QuoteLine[]; editable?: boolean }) {
  const [lines, setLines] = useState(start)
  useEffect(() => { latest = lines })
  return createElement(CostingPage, {
    groups: [{ area: AREAS[0], lines }], areas: AREAS, lines, editable, qtyOf: (k: string) => lines.find(l => l.key === k)?.qty ?? 0,
    url: (p: string) => `/img/${p}`, onChange: (key: string, patch: Partial<QuoteLine>) => setLines(p => p.map(l => (l.key === key ? { ...l, ...patch } : l))),
    onUploadSwatch: async (f: File) => { uploads.push(f); return '00000000-0000-0000-0000-0000000000b2/11111111-1111-1111-1111-111111111111.jpg' },
  })
}
const input = (ui: ReturnType<typeof mount>, label: string) => ui.one<HTMLInputElement>(`[aria-label="${label}"]`)
const row = (ui: ReturnType<typeof mount>, key: string) => ui.one(`#cost-${key}`)

describe('the sheet', () => {
  test('one row per product with its picture, quantity and the three groups; finish has no price column', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    const text = ui.text()
    for (const w of ['Rocking chair', 'Side table', 'Bar stool', 'Fabric', 'Finish', 'Packing', 'Per piece × quantity', 'Lobby lounge']) assert.match(text, new RegExp(w))
    assert.equal(ui.all('tbody tr[id^="cost-"]').length, 3)
    assert.equal(row(ui, 'p1').querySelector('img')?.getAttribute('src'), '/img/u/p1.jpg', 'the product picture is in the first column')
    assert.doesNotMatch(text, /Finish ₹/, 'finish has no price')
    assert.equal(row(ui, 'p1').querySelectorAll('td')[0].textContent, '3', 'the quantity')
  })
  test('with nothing typed, nothing is priced and the totals boxes stay as typed', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    assert.match(ui.text(), /Nothing is priced yet, so the Fabric and Packing boxes below stay as they were typed/)
  })
})

describe('packing: price per piece × quantity', () => {
  test('₹650 on 3 chairs is ₹1,950, and the sums and the note follow', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Packing type for Rocking chair'), 'Carton with foam corners')
    ui.type(input(ui, 'Packing price per piece for Rocking chair'), '650')
    assert.match(row(ui, 'p1').textContent ?? '', /₹650/)
    assert.match(row(ui, 'p1').textContent ?? '', /₹1,950/)
    assert.deepEqual(latest[0].costing, { packing: { type: 'Carton with foam corners', per_piece: 650 } })
    assert.match(ui.text(), /Added to the totals below: fabric ₹0, packing ₹1,950/)
  })
  test('a type with no price waits and is named under the sheet', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Packing type for Side table'), 'Carton')
    assert.match(ui.text(), /Not counted yet: Side table packing \(price to come\)/)
  })
})

describe('fabric: metres per piece × rate per metre, then × quantity', () => {
  test('1.6 m at ₹850 is ₹1,360 a piece and ₹4,080 for 3 pieces', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Fabric name for Rocking chair'), 'Berlin velvet')
    ui.type(input(ui, 'Fabric code for Rocking chair'), 'F18')
    ui.type(input(ui, 'Metres of fabric per piece for Rocking chair'), '1.6')
    ui.type(input(ui, 'Fabric price per metre for Rocking chair'), '850')
    assert.match(row(ui, 'p1').textContent ?? '', /₹1,360/)
    assert.match(row(ui, 'p1').textContent ?? '', /₹4,080/)
    assert.deepEqual(latest[0].choices?.fabric, { source: 'catalog', status: 'to_confirm', name: 'Berlin velvet', code: 'F18' })
    assert.deepEqual(latest[0].costing, { fabric: { metres: 1.6, rate: 850 } })
  })
  test('a fabric with no price says so, and a rate with no metres asks for them', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Fabric name for Bar stool'), 'Velvet')
    assert.match(row(ui, 'p3').textContent ?? '', /Price to come/)
    ui.type(input(ui, 'Fabric price per metre for Bar stool'), '700')
    assert.match(row(ui, 'p3').textContent ?? '', /Add metres/)
    assert.match(ui.text(), /Bar stool fabric \(metres per piece missing\)/)
    ui.type(input(ui, 'Metres of fabric per piece for Bar stool'), '1.2')
    assert.match(row(ui, 'p3').textContent ?? '', /₹840/)
    assert.match(row(ui, 'p3').textContent ?? '', /₹5,040/)
  })
  test('the client\'s own fabric is no charge, and the client\'s code is its own source', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Fabric name for Side table'), 'Own linen')
    const src = ui.one<HTMLSelectElement>('[aria-label="Where the fabric of Side table comes from"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    act(() => { setter.call(src, 'client'); src.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.match(row(ui, 'p2').textContent ?? '', /No charge/)
    act(() => { setter.call(src, 'code'); src.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(latest[1].choices?.fabric?.source, 'code')
    assert.match(row(ui, 'p2').textContent ?? '', /Price to come/)
  })
  test('the From box works on a row with nothing typed yet, and going back to the catalog leaves nothing behind', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    const src = ui.one<HTMLSelectElement>('[aria-label="Where the fabric of Bar stool comes from"]')
    assert.equal(src.disabled, false, 'open although no fabric name or code is typed')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    act(() => { setter.call(src, 'client'); src.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.deepEqual(latest[2].choices?.fabric, { source: 'client', status: 'to_confirm' })
    assert.equal(input(ui, 'Fabric name for Bar stool').placeholder, 'Their fabric')
    assert.match(row(ui, 'p3').textContent ?? '', /—/, 'no name or code, so nothing is priced')
    act(() => { setter.call(src, 'catalog'); src.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(latest[2].choices?.fabric, undefined)
  })
  test('an emptied fabric leaves nothing behind', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Fabric name for Rocking chair'), 'Velvet')
    assert.ok(latest[0].choices?.fabric)
    ui.type(input(ui, 'Fabric name for Rocking chair'), '')
    assert.equal(latest[0].choices?.fabric, undefined)
  })
})

describe('finish: a code and a picture, no price', () => {
  test('a code is kept in the client choices; a picture is uploaded and shown; both can be taken away', async () => {
    uploads = []
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Finish code for Rocking chair'), 'W-04')
    assert.deepEqual(latest[0].choices?.finish, { source: 'catalog', status: 'to_confirm', code: 'W-04' })
    assert.deepEqual(latest[0].costing ?? {}, {}, 'a finish adds no costing')
    const file = ui.one<HTMLInputElement>('input[type=file]')
    Object.defineProperty(file, 'files', { value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })], configurable: true })
    ui.click(ui.one('[aria-label="Add a finish picture for Rocking chair"]'))
    await act(async () => { file.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(uploads.length, 1)
    assert.match(latest[0].choices?.finish?.photo ?? '', /\.jpg$/)
    assert.equal(row(ui, 'p1').querySelectorAll('img').length, 2, 'the product picture and the finish picture')
    ui.click(ui.one('[aria-label="Remove the finish picture of Rocking chair"]'))
    assert.equal(latest[0].choices?.finish?.photo ?? null, null)
    ui.type(input(ui, 'Finish code for Rocking chair'), '')
    assert.equal(latest[0].choices?.finish, undefined)
  })
})

describe('fill down, and a quotation nobody may edit', () => {
  test('Fill down copies the first product\'s packing to the others; fabric copies the rate, not the metres', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Packing type for Rocking chair'), 'Carton')
    ui.type(input(ui, 'Packing price per piece for Rocking chair'), '400')
    ui.type(input(ui, 'Fabric name for Rocking chair'), 'Velvet')
    ui.type(input(ui, 'Metres of fabric per piece for Rocking chair'), '1.6')
    ui.type(input(ui, 'Fabric price per metre for Rocking chair'), '850')
    const fills = ui.all<HTMLButtonElement>('button').filter(b => b.textContent === 'Fill down')
    assert.equal(fills.length, 3)
    ui.click(fills[2])
    assert.deepEqual(latest.map(l => l.costing?.packing), [{ type: 'Carton', per_piece: 400 }, { type: 'Carton', per_piece: 400 }, { type: 'Carton', per_piece: 400 }])
    ui.click(fills[0])
    assert.deepEqual(latest[1].costing?.fabric, { rate: 850 }, 'the rate, not the metres')
    assert.equal(latest[1].choices?.fabric?.name, 'Velvet')
    assert.equal(latest[1].choices?.fabric?.status, 'to_confirm')
    assert.match(ui.text(), /Fabric copied from Rocking chair to 2 other products\. Metres per piece were not copied/)
  })
  test('when nobody may edit, every box is closed and there is no Fill down', () => {
    const ui = mount(createElement(Parent, { editable: false })); cleanup = () => ui.unmount()
    assert.ok(ui.all<HTMLInputElement>('input:not([type=file])').every(i => i.disabled))
    assert.ok(ui.all<HTMLSelectElement>('select').every(i => i.disabled))
    assert.equal(ui.all('button').filter(b => b.textContent === 'Fill down').length, 0)
  })
})
