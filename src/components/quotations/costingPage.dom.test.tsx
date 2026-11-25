/**
 * THE FABRIC AND PACKING PAGE, run for real in jsdom (owner, 21 Nov 2026; simplified 25 Nov 2026): one row per product with its picture and,
 * under its name, the fabric chosen in its Client choices (read only); fabric priced as metres per piece × rate per metre, packing per piece,
 * each multiplied by the quantity. Fabric and finish are not chosen here any more.
 *
 * Run: npm run test:file -- src/components/quotations/costingPage.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, useEffect, useState } from 'react'
import '@/lib/testing/cssModuleStub'
import { CostingPage, fabricLine } from './CostingPage'
import { AREA_TINTS } from './areaTint'
import type { LineChoice, QuoteArea, QuoteLine } from '@/lib/quotations/math'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const AREAS: QuoteArea[] = [{ key: 'a', name: 'Lobby lounge', style: '', multiplier: 1, unit_label: 'rooms' }]
const line = (key: string, name: string, qty: number, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key, area_key: 'a', name, size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'fixed', qty, unit_price: 10000, tax_rate: 18,
  image_path: `u/${key}.jpg`, is_optional: false, client_note: '', internal_note: '', ...over,
})
const fabric = (f: Omit<LineChoice, 'status'>): QuoteLine['choices'] => ({ fabric: { status: 'to_confirm', ...f } })
const START = () => [line('p1', 'Rocking chair', 3), line('p2', 'Side table', 1), line('p3', 'Bar stool', 6)]

let latest: QuoteLine[] = []
function Parent({ start = START(), editable = true, areas = AREAS }: { start?: QuoteLine[]; editable?: boolean; areas?: QuoteArea[] }) {
  const [lines, setLines] = useState(start)
  useEffect(() => { latest = lines })
  return createElement(CostingPage, {
    groups: areas.map(a => ({ area: a, lines: lines.filter(l => l.area_key === a.key) })), areas, lines, editable,
    qtyOf: (k: string) => lines.find(l => l.key === k)?.qty ?? 0,
    url: (p: string) => `/img/${p}`, onChange: (key: string, patch: Partial<QuoteLine>) => setLines(p => p.map(l => (l.key === key ? { ...l, ...patch } : l))),
  })
}
type UI = ReturnType<typeof mount>
const input = (ui: UI, label: string) => ui.one<HTMLInputElement>(`[aria-label="${label}"]`)
const row = (ui: UI, key: string) => ui.one(`#cost-${key}`)
const cells = (ui: UI, key: string) => [...row(ui, key).querySelectorAll('td')].map(td => (td.textContent ?? '').trim())
const fabricOf = (ui: UI, key: string) => row(ui, key).querySelector('.cpFabric')?.textContent
/** Which column (0-based) a cell starts in, counting the colSpans before it. */
const colOf = (cell: Element) => { let n = 0; for (let c = cell.previousElementSibling; c; c = c.previousElementSibling) n += (c as HTMLTableCellElement).colSpan; return n }

describe('the sheet', () => {
  test('one row per product with its picture, name and pieces; Qty, then Fabric and Packing groups with the new columns', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    assert.equal(ui.all('tbody tr[id^="cost-"]').length, 3)
    assert.equal(row(ui, 'p1').querySelector('img')?.getAttribute('src'), '/img/u/p1.jpg', 'the product picture is in the first column')
    assert.match(row(ui, 'p1').querySelector('th')?.textContent ?? '', /Rocking chair3 pieces/)
    assert.match(row(ui, 'p2').querySelector('th')?.textContent ?? '', /Side table1 piece(?!s)/)
    assert.equal(cells(ui, 'p1')[0], '3', 'the quantity')
    const heads = ui.all('thead th').map(th => (th.textContent ?? '').trim())
    assert.deepEqual(heads, ['Product and its fabric', 'Qty', 'Fabric', 'Packing', 'Metres / pc', '₹ / metre', 'Fabric / pc', 'Fabric × qty', 'Type', 'Packing / pc', 'Packing × qty'])
    assert.equal(row(ui, 'p1').children.length, 9, 'nine cells a row')
  })
  test('the removed columns are gone: From, fabric Name and Code, Finish code and picture, Extras, Total × qty', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    const heads = ui.all('thead th').map(th => (th.textContent ?? '').trim())
    for (const gone of ['From', 'Name', 'Code', 'Finish', 'Picture', 'Extras ₹ / pc', 'Total × qty']) assert.ok(!heads.includes(gone), `no ${gone} column`)
    assert.doesNotMatch(ui.text(), /Extras|Total × qty/)
  })
  test('there is no way to edit a choice here: no select, no file box, only the four pricing boxes a row', () => {
    const ui = mount(createElement(Parent, { start: [line('p1', 'Rocking chair', 3, { choices: fabric({ source: 'catalog', name: 'Velvet' }) })] })); cleanup = () => ui.unmount()
    assert.equal(ui.all('select').length, 0)
    assert.equal(ui.all('input[type=file]').length, 0)
    assert.deepEqual(ui.all<HTMLInputElement>('#cost-p1 input').map(i => i.getAttribute('aria-label')), [
      'Metres of fabric per piece for Rocking chair', 'Fabric price per metre for Rocking chair', 'Packing type for Rocking chair', 'Packing price per piece for Rocking chair',
    ])
    assert.ok(!ui.all('[aria-label]').some(e => /fabric name|fabric code|finish|where the fabric/i.test(e.getAttribute('aria-label') ?? '')))
  })
  test('a blank name reads "Untitled product"; an optional product says it is not counted', () => {
    const ui = mount(createElement(Parent, { start: [line('p1', '  ', 2), line('p2', 'Lamp', 4, { is_optional: true })] })); cleanup = () => ui.unmount()
    assert.match(row(ui, 'p1').querySelector('th')?.textContent ?? '', /Untitled product2 pieces/)
    assert.match(row(ui, 'p2').querySelector('th')?.textContent ?? '', /4 pieces · optional, not counted/)
  })
  test('an area heading spans all nine columns and carries the area tint', () => {
    const areas: QuoteArea[] = [...AREAS, { key: 'b', name: 'Terrace', style: '', multiplier: 2, unit_label: 'rooms' }]
    const ui = mount(createElement(Parent, { areas, start: [line('p1', 'Rocking chair', 3), line('p2', 'Lounger', 1, { area_key: 'b' })] })); cleanup = () => ui.unmount()
    const heads = ui.all<HTMLTableRowElement>('tr.cpArea')
    assert.equal(heads.length, 2)
    assert.equal(heads[0].querySelector('th')?.colSpan, 9)
    assert.equal(heads[0].textContent, 'Lobby lounge')
    assert.equal(heads[1].textContent, 'Terrace × 2 rooms')
    assert.equal(heads[0].style.getPropertyValue('--area-tint'), AREA_TINTS[0].tint)
    assert.equal(heads[1].style.getPropertyValue('--area-tint'), AREA_TINTS[1].tint)
    assert.equal(heads[1].style.getPropertyValue('--area-line'), AREA_TINTS[1].line)
    assert.equal(heads[1].style.getPropertyValue('--area-strong'), AREA_TINTS[1].strong)
  })
  test('with nothing typed, nothing is priced and the totals boxes stay as typed', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    assert.match(ui.text(), /Nothing is priced yet, so the Fabric and Packing boxes below stay as they were typed/)
  })
})

describe('the chosen fabric, read only under the product', () => {
  test('fabricLine names each source in a few words', () => {
    assert.equal(fabricLine(undefined), '')
    assert.equal(fabricLine({ source: 'catalog', status: 'to_confirm', name: 'Berlin velvet', code: 'F18' }), 'Berlin velvet F18')
    assert.equal(fabricLine({ source: 'catalog', status: 'to_confirm', code: 'F18' }), 'F18')
    assert.equal(fabricLine({ source: 'catalog', status: 'to_confirm', name: '  ' }), 'Not named yet')
    assert.equal(fabricLine({ source: 'client', status: 'to_confirm' }), 'Client’s own')
    assert.equal(fabricLine({ source: 'client', status: 'confirmed', name: ' linen ' }), 'Client’s own: linen')
    assert.equal(fabricLine({ source: 'code', status: 'to_confirm', code: 'RW-22' }), 'Client’s code RW-22, we source it')
    assert.equal(fabricLine({ source: 'code', status: 'to_confirm' }), 'Client’s code, we source it')
  })
  test('each row shows its fabric, or "No fabric chosen"', () => {
    const ui = mount(createElement(Parent, { start: [
      line('p1', 'Rocking chair', 3, { choices: fabric({ source: 'catalog', name: 'Berlin velvet', code: 'F18' }) }),
      line('p2', 'Side table', 1, { choices: fabric({ source: 'client', name: 'linen' }) }),
      line('p3', 'Bar stool', 6, { choices: fabric({ source: 'code', code: 'RW-22' }) }),
      line('p4', 'Sofa', 2, { choices: fabric({ source: 'catalog' }) }),
      line('p5', 'Lamp', 1),
    ] })); cleanup = () => ui.unmount()
    assert.equal(fabricOf(ui, 'p1'), 'Berlin velvet F18')
    assert.equal(fabricOf(ui, 'p2'), 'Client’s own: linen')
    assert.equal(fabricOf(ui, 'p3'), 'Client’s code RW-22, we source it')
    assert.equal(fabricOf(ui, 'p4'), 'Not named yet')
    assert.equal(fabricOf(ui, 'p5'), 'No fabric chosen')
  })
  test('the rate box says "No charge" for the client\'s own fabric and "To come" otherwise', () => {
    const ui = mount(createElement(Parent, { start: [
      line('p1', 'Rocking chair', 3, { choices: fabric({ source: 'client' }) }),
      line('p2', 'Side table', 1, { choices: fabric({ source: 'code', code: 'RW-22' }) }),
      line('p3', 'Bar stool', 6),
    ] })); cleanup = () => ui.unmount()
    assert.equal(input(ui, 'Fabric price per metre for Rocking chair').placeholder, 'No charge')
    assert.equal(input(ui, 'Fabric price per metre for Side table').placeholder, 'To come')
    assert.equal(input(ui, 'Fabric price per metre for Bar stool').placeholder, 'To come')
  })
})

describe('fabric: metres per piece × rate per metre, then × quantity', () => {
  test('1.6 m at ₹850 is ₹1,360 a piece and ₹4,080 for 3 pieces, under Fabric / pc and Fabric × qty; the choice is untouched', () => {
    const choices = fabric({ source: 'catalog', name: 'Berlin velvet', code: 'F18' })
    const ui = mount(createElement(Parent, { start: [line('p1', 'Rocking chair', 3, { choices })] })); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Metres of fabric per piece for Rocking chair'), '1.6')
    ui.type(input(ui, 'Fabric price per metre for Rocking chair'), '850')
    assert.equal(cells(ui, 'p1')[3], '₹1,360')
    assert.match(cells(ui, 'p1')[4], /₹4,080/)
    assert.deepEqual(latest[0].costing, { fabric: { metres: 1.6, rate: 850 } })
    assert.deepEqual(latest[0].choices, choices, 'the sheet never changes a choice')
  })
  test('no fabric shows "—"; a named fabric with no price says "Price to come"; a rate with no metres asks for them', () => {
    const ui = mount(createElement(Parent, { start: [line('p1', 'Rocking chair', 3), line('p3', 'Bar stool', 6, { choices: fabric({ source: 'catalog', name: 'Velvet' }) })] })); cleanup = () => ui.unmount()
    assert.deepEqual(cells(ui, 'p1').slice(3, 5), ['—', '—'])
    assert.deepEqual(cells(ui, 'p3').slice(3, 5), ['Price to come', '—'])
    assert.match(ui.text(), /Not counted yet: Bar stool fabric \(price to come\)/)
    ui.type(input(ui, 'Fabric price per metre for Bar stool'), '700')
    assert.deepEqual(cells(ui, 'p3').slice(3, 5), ['Add metres', '—'])
    assert.match(ui.text(), /Bar stool fabric \(metres per piece missing\)/)
    ui.type(input(ui, 'Metres of fabric per piece for Bar stool'), '1.2')
    assert.equal(cells(ui, 'p3')[3], '₹840')
    assert.match(cells(ui, 'p3')[4], /₹5,040/)
  })
  test('the client\'s own fabric with no rate is "No charge" and adds nothing', () => {
    const ui = mount(createElement(Parent, { start: [line('p2', 'Side table', 1, { choices: fabric({ source: 'client', name: 'linen' }) })] })); cleanup = () => ui.unmount()
    assert.deepEqual(cells(ui, 'p2').slice(3, 5), ['No charge', '—'])
    assert.doesNotMatch(ui.text(), /Not counted yet/)
  })
})

describe('packing: price per piece × quantity', () => {
  test('₹650 on 3 chairs is ₹1,950 under Packing × qty, and the sums and the note follow', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Packing type for Rocking chair'), 'Carton with foam corners')
    ui.type(input(ui, 'Packing price per piece for Rocking chair'), '650')
    assert.match(cells(ui, 'p1')[7], /₹1,950/)
    assert.equal(cells(ui, 'p2')[7], '—')
    assert.deepEqual(latest[0].costing, { packing: { type: 'Carton with foam corners', per_piece: 650 } })
    assert.match(ui.text(), /Added to the totals below: fabric ₹0, packing ₹1,950 \(before GST\)\./)
  })
  test('a type with no price waits and is named under the sheet', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Packing type for Side table'), 'Carton')
    assert.equal(cells(ui, 'p2')[7], '—')
    assert.match(ui.text(), /Not counted yet: Side table packing \(price to come\)/)
  })
})

describe('the All pieces footer', () => {
  test('the fabric sum sits under Fabric × qty and the packing sum under Packing × qty; an optional product is not counted', () => {
    const ui = mount(createElement(Parent, { start: [
      line('p1', 'Rocking chair', 3, { choices: fabric({ source: 'catalog', name: 'Velvet' }), costing: { fabric: { metres: 1.6, rate: 850 }, packing: { per_piece: 650 } } }),
      line('p2', 'Bar stool', 6, { costing: { packing: { per_piece: 100 } } }),
      line('p3', 'Lamp', 2, { is_optional: true, costing: { packing: { per_piece: 5000 } } }),
    ] })); cleanup = () => ui.unmount()
    const heads = ui.all('thead tr:nth-child(2) th')
    const fabricCol = 2 + heads.findIndex(th => th.textContent === 'Fabric × qty'), packingCol = 2 + heads.findIndex(th => th.textContent === 'Packing × qty')
    const foot = ui.all('tfoot .cpFoot')
    assert.equal(foot.length, 2)
    assert.match(ui.one('tfoot th').textContent ?? '', /All pieces/)
    assert.equal(colOf(foot[0]), fabricCol)
    assert.equal(colOf(foot[1]), packingCol)
    assert.match(foot[0].textContent ?? '', /₹4,080all fabric/)
    assert.match(foot[1].textContent ?? '', /₹2,550all packing/)
    assert.match(ui.text(), /Added to the totals below: fabric ₹4,080, packing ₹2,550 \(before GST\)\./)
  })
})

describe('fill down, and a quotation nobody may edit', () => {
  test('Fill down copies only the first product\'s packing to the others; fabric stays as it was', () => {
    const ui = mount(createElement(Parent)); cleanup = () => ui.unmount()
    ui.type(input(ui, 'Packing type for Rocking chair'), 'Carton')
    ui.type(input(ui, 'Packing price per piece for Rocking chair'), '400')
    ui.type(input(ui, 'Metres of fabric per piece for Rocking chair'), '1.6')
    ui.type(input(ui, 'Fabric price per metre for Rocking chair'), '850')
    assert.equal(ui.all('[aria-label^="Fill down"]').length, 1, 'one Fill down, on the packing Type column')
    ui.click(ui.one('[aria-label="Fill down the packing"]'))
    assert.deepEqual(latest.map(l => l.costing?.packing), [{ type: 'Carton', per_piece: 400 }, { type: 'Carton', per_piece: 400 }, { type: 'Carton', per_piece: 400 }])
    assert.deepEqual(latest.slice(1).map(l => l.costing?.fabric), [undefined, undefined], 'fabric is not filled down')
    assert.match(ui.one('[role=status]').textContent ?? '', /^Packing copied from Rocking chair to 2 other products\.$/)
  })
  test('with one product there is nothing to fill down', () => {
    const ui = mount(createElement(Parent, { start: [line('p1', 'Rocking chair', 3)] })); cleanup = () => ui.unmount()
    assert.equal(ui.all('[aria-label="Fill down the packing"]').length, 0)
  })
  test('when nobody may edit, every box is closed and there is no Fill down', () => {
    const ui = mount(createElement(Parent, { editable: false })); cleanup = () => ui.unmount()
    const boxes = ui.all<HTMLInputElement>('input')
    assert.equal(boxes.length, 12)
    assert.ok(boxes.every(i => i.disabled))
    assert.equal(ui.all('[aria-label="Fill down the packing"]').length, 0)
  })
})
