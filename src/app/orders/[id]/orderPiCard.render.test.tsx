/**
 * The PI card (Nitish / Operations, 24 Nov 2026): the Documents card redrawn as the Main PI and its real
 * downloads on one row, a four-cell strip (PI history, Product pictures, Design files, Client PO), the
 * absence note, and a footer for the Sales highlight and the Notes.
 *
 * The owner marked the first page 4 out of 10 on a real order, so these pin the things that went wrong
 * or could: the arrangement, that nothing was lost, and that the CSS cannot shrink the strip to its content.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderPiCard.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderDocumentsPanel } from './OrderStatusWorkspace'
import { designFilesDocument } from '@/lib/orders/orderDocumentsPanel'
import { mainPiCard } from '@/lib/orders/orderMainPi'
import { describePiVersionHistory, type PersistedPiVersion } from '@/lib/orders/orderPiVersions'
import { supportingRow } from '@/lib/orders/orderDocumentSubmissions'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const noop = () => {}
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const css = read('src/app/globals.css')
const page = read('src/app/orders/[id]/page.tsx')

const NAMES = new Map([['sales', 'Asha'], ['admin', 'Nishant']])
const V1: PersistedPiVersion = {
  id: 'v1', order_id: 'o1', submission_id: 's', version_number: 1, status: 'approved',
  workbook_path: 'k1', workbook_name: 'PI-771.xlsx', uploaded_by: 'sales', uploaded_at: '2026-09-01T00:00:00Z',
  revision_reason: null, decided_by: 'admin', decided_at: '2026-09-02T00:00:00Z', decision_reason: null, superseded_at: null,
  operations_reviewer: null, operations_decided_by: null, operations_decided_at: null, operations_reason: null,
}
const ABSENCE = 'Not provided — Asha confirmed sending the PI without design files on 2026-09-20.'

const card = (over: { footer?: React.ReactNode; withHistory?: boolean } = {}) => renderToStaticMarkup(
  <OrderDocumentsPanel
    mainPi={mainPiCard(describePiVersionHistory([V1], NAMES, when))}
    design={designFilesDocument({ kind: 'ready', counts: { representative: 2, customization: 0 } }, 2)}
    onView={noop} onDownload={noop} onHistory={noop} onManageDesign={noop} onOpenPdf={noop}
    viewing={false} downloading={false}
    piVersions={over.withHistory === false ? undefined : { count: 1, onOpen: noop, notice: null }}
    supporting={{ design: supportingRow({ rows: [], state: 'ready' }, 'design_files', ABSENCE), clientPo: supportingRow({ rows: [], state: 'ready' }, 'client_po', ABSENCE), formatWhen: when }}
    changes={[]}
    onOpenFile={noop} onDownloadFile={noop}
    pictures={{ state: { kind: 'ready', available: 33, unavailable: 0 }, onView: noop, onDownloadAll: noop, onDownloadErp: noop, downloading: false, message: null }}
    footer={over.footer}
  />,
)

describe('the PI card', () => {
  test('one card: the heading row first, then the strip, then the absence note, then the footer', () => {
    const html = card({ footer: <p>FOOTER TEXT</p> })
    const at = (s: string) => html.indexOf(s)
    assert.ok(at('order-pi-head') > 0 && at('order-pic-strip') > at('order-pi-head'))
    assert.ok(at('order-docs-absence') > at('order-pic-strip'))
    assert.ok(at('order-pic-footer') > at('order-docs-absence'))
    assert.ok(at('FOOTER TEXT') > at('order-pic-footer'))
    assert.equal(html.split('class="order-docs"').length - 1, 1, 'still one Documents card')
    assert.ok(html.includes('id="documents"') && html.includes('aria-label="Documents"'), 'the anchor and the label survive')
  })

  test('the heading row carries the title, the status, the dates and the PI history by it', () => {
    const html = card()
    const head = text(html.slice(html.indexOf('order-pi-head'), html.indexOf('order-pic-strip')))
    assert.ok(head.includes('Main PI · V1') && head.includes('Details'))
    assert.ok(head.includes('PI history') && head.includes('V1 · View history'))
    assert.equal(/Excel|ERP|PDF|ZIP/.test(head), false, 'no download in the heading row')
  })

  test('FIRST column is PI: the current PI as Excel, ERP and PDF, in that order, and nothing is added or removed', () => {
    const html = card()
    const strip = html.slice(html.indexOf('order-pic-strip'))
    const first = text(strip.slice(strip.indexOf('>') + 1, strip.indexOf('Product pictures')))
    assert.ok(first.trimStart().startsWith('PI '), 'the first cell is PI')
    const order = ['Excel', 'ERP', 'PDF'].map(w => first.indexOf(w))
    assert.ok(order.every(i => i > 0), 'all three are drawn')
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    assert.equal(/Update documents|Upload New PI|Upload Design Files|Upload Client PO|Document history/.test(text(html)), false, 'no removed control comes back, none is invented')
  })

  test('SECOND column is Product pictures: Download ZIP and View all (the popup); the strip order is PI, Pictures, Design Files, Client PO', () => {
    const strip = text(card().slice(card().indexOf('order-pic-strip')))
    const order = ['PI ', 'Product pictures', 'Design Files', 'Client PO'].map(w => strip.indexOf(w))
    assert.ok(order.every(i => i >= 0))
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    const pics = strip.slice(strip.indexOf('Product pictures'), strip.indexOf('Design Files'))
    assert.ok(pics.includes('Download ZIP') && pics.includes('View all (33)'))
    assert.ok(strip.includes('No design files') && strip.includes('No client PO'), 'an empty one is one muted word, not a box')
  })

  test('the absence note is said ONCE, under the strip, not in each empty cell', () => {
    const t = text(card())
    assert.equal((t.match(/confirmed sending the PI/g) ?? []).length, 1)
    assert.ok(t.includes('without these'), 'the two notes merged into one')
  })

  test('the footer is only drawn when the page gives one; the title stays for the label', () => {
    assert.equal(card().includes('order-pic-footer'), false)
    assert.ok(card({ footer: <p>x</p> }).includes('order-pic-footer'))
    assert.ok(card().includes('<h2 class="order-docs-title">Documents</h2>'))
  })

  test('no PI history without versions (legacy order or still loading)', () => {
    assert.equal(/PI history/.test(text(card({ withHistory: false }))), false)
  })
})

describe('the page hands the highlight and the Notes to the card', () => {
  test('both are the card\'s footer, once, and no longer drawn between the bar and the card', () => {
    const body = page.slice(page.indexOf('<OrderDocumentsRow>'), page.indexOf('</OrderDocumentsRow>'))
    assert.ok(body.includes('footer={('))
    assert.equal((page.match(/<OrderHighlightRemark\b/g) ?? []).length, 1)
    assert.equal((page.match(/aria-label="Order notes"/g) ?? []).length, 1)
    assert.ok(body.includes('<OrderHighlightRemark') && body.includes('aria-label="Order notes"'))
    assert.ok(page.indexOf('<OrderStatusStrip') < page.indexOf('<OrderDocumentsRow>'))
  })
})

describe('the card\'s styles', () => {
  const block = css.slice(css.indexOf('CONFIRMED ORDER: THE PI CARD'))

  test('the card body STRETCHES its children: an old rule aligned them to the start and shrank the strip to its content', () => {
    assert.match(block, /\.order-docs \.order-pic \{ display: flex; flex-direction: column; align-items: stretch;/)
  })

  test('the strip is four columns, two in a narrow card (a container query, not the viewport), one for the phone buttons', () => {
    // four columns that share the row by weight and never squeeze the buttons (the PI and pictures columns have a floor)
    assert.match(block, /\.order-pic-strip \{\s*display: grid; grid-template-columns: minmax\(250px, 1fr\) minmax\(304px, 1fr\) minmax\(0, 1\.15fr\) minmax\(0, 0\.8fr\);/)
    assert.match(block, /@container \(max-width: 1000px\) \{\s*\.order-docs \.order-pic \.order-pic-strip, \.order-docs \.order-pic \.order-pic-strip--short \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
    assert.match(block, /@container \(max-width: 640px\)[\s\S]*?min-height: 44px/)
  })

  test('labels share one size and line height so every cell\'s label sits on the same line', () => {
    assert.match(block, /\.order-doc-row-head \{ display: block; margin: 0; font-size: 12px; line-height: 1\.2; \}/)
  })

  test('an empty footer takes no space, no empty grid row is left under the card, and the old rules are untouched', () => {
    assert.match(css, /\.order-docs-row \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: 'docs'; grid-template-rows: auto; \}/)
    assert.match(block, /\.order-pic-footer:empty \{ display: none; \}/)
    assert.ok(css.includes('.order-docs-main .order-doc-section { grid-template-columns: minmax(0, 1fr); gap: 8px; }'))
  })
})
