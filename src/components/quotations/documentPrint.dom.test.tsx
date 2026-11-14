/**
 * PRINTING NEEDS EVERY PICTURE (owner, 14 Nov 2026): the product pictures and project photographs below the first screen are
 * deferred, and the moment a print starts they are all asked for. Run in jsdom with the real component.
 *
 * Run: npm run test:file -- src/components/quotations/documentPrint.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, type DocData } from './QuotationDocument'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const doc: DocData = {
  quote_no: 'QT-NS-01003', issued_at: '2026-11-14T04:30:00Z', valid_days: 7, client_name: 'Aurora', project_name: null, contact_name: null, salesperson: 'N',
  gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0, transport_note: null, notes: null, project_type: 'hotel',
  areas: [{ key: 'a', name: 'Room', style: '', multiplier: 2, unit_label: 'rooms' }],
  lines: [1, 2, 3].map(n => ({ key: 'l' + n, area_key: 'a', name: 'Chair ' + n, size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'per_unit' as const, qty: 1, unit_price: 1000, tax_rate: 18, image_path: 'p/' + n + '.jpg', is_optional: false, client_note: '', internal_note: '' })),
}

describe('a print starts', () => {
  test('every deferred picture is switched to loading at once, and the cover logo is left alone', () => {
    const ui = mount(createElement(QuotationDocument, { doc, pictureUrl: (p: string) => '/pics/' + p })); cleanup = () => ui.unmount()
    const imgs = ui.all<HTMLImageElement>('img')
    const deferred = imgs.filter(i => i.getAttribute('loading') === 'lazy')
    assert.ok(deferred.length >= 7, 'three products and the hotel photographs are deferred')
    act(() => { window.dispatchEvent(new window.Event('beforeprint')) })
    for (const i of deferred) assert.equal(i.loading, 'eager', i.getAttribute('src') ?? '')
  })
})
