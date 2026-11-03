// Scan first (owner, 2026-11-03): the box under each heading on the Record dispatch screen, and the screen's order.
// Every file name and number here is invented.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DISPATCH_PAPER_ACCEPT } from '@/lib/orders/dispatchPaperReading'
import { DispatchScanBox, type ScanPaperView } from './DispatchScanBox'

const noop = () => {}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim()
const paper = (over: Partial<ScanPaperView> = {}): ScanPaperView => ({
  key: 'p1', fileName: 'invoice-0540.pdf', state: 'read', line: 'Read 8 details · 4 products matched', selected: false, ...over,
})
const box = (papers: ScanPaperView[], over: { noun?: string; optional?: boolean; disabled?: boolean } = {}) =>
  renderToStaticMarkup(
    <DispatchScanBox noun={over.noun ?? 'invoice'} optional={over.optional} papers={papers} disabled={over.disabled ?? false}
      onFiles={noop} onOpen={noop} onRemove={noop} />,
  )

describe('a scan box with nothing in it', () => {
  const html = box([])
  it('says what to do, in the paper\'s own name, and offers a file and, on a phone, the camera', () => {
    assert.equal(text(html), 'Scan the invoice Upload the PDF or a photo and the details below fill in for you. Take photo Choose file')
    assert.ok(html.includes('class="odr-scan"'), 'a dashed box, not a finished one')
    assert.ok(html.includes('odr-scan-camera'))
  })
  it('takes PDFs and photos, several at a time, and the camera takes a photo', () => {
    assert.ok(html.includes(`accept="${DISPATCH_PAPER_ACCEPT}"`))
    assert.ok(html.includes('multiple'))
    assert.ok(html.includes('capture="environment"'))
  })
  it('names the e-way bill in its own box', () => {
    assert.ok(text(box([], { noun: 'e-way bill' })).startsWith('Scan the e-way bill'))
  })
  it('is switched off while the screen is saving', () => {
    assert.equal((box([], { disabled: true }).match(/disabled=""/g) ?? []).length, 2, 'both inputs')
  })
})

describe('a scan box with a paper in it', () => {
  it('a paper that was read is green, says what was read, and can be removed or added to', () => {
    const html = box([paper()])
    assert.ok(html.includes('odr-scan odr-scan--done'))
    assert.ok(text(html).includes('invoice-0540.pdf Read 8 details · 4 products matched'))
    assert.ok(html.includes('aria-label="Remove invoice-0540.pdf"'))
    assert.ok(text(html).includes('Add another invoice paper'))
    assert.equal(html.includes('Scan the invoice'), false, 'the big box gives way to the paper')
  })
  it('a paper being read is blue and cannot be removed yet', () => {
    const html = box([paper({ state: 'reading', line: 'Reading…' })])
    assert.ok(html.includes('odr-scan--busy'))
    assert.ok(/<button[^>]*aria-label="Remove[^>]*disabled=""/.test(html))
  })
  it('a paper that could not be read is amber and says why, so the fields can be typed', () => {
    const html = box([paper({ state: 'unclear', line: 'Nothing could be read from this paper. The paper is kept; take it again or type the details.' })])
    assert.ok(html.includes('odr-scan--problem'))
    assert.ok(text(html).includes('Nothing could be read from this paper.'))
  })
  it('the paper showing in the preview is marked, and pressing its name opens it', () => {
    const html = box([paper({ selected: true })])
    assert.ok(html.includes('is-on'))
    assert.ok(html.includes('aria-pressed="true"'))
  })
  it('two papers for one invoice (the print and the e-invoice) sit one under the other', () => {
    const html = box([paper(), paper({ key: 'p2', fileName: 'e-invoice-0540.pdf' })])
    assert.equal((html.match(/odr-scan odr-scan--done/g) ?? []).length, 2)
    assert.equal((text(html).match(/Add another invoice paper/g) ?? []).length, 1)
  })
})

describe('the LR / bilty is optional, so it is a line and not a box', () => {
  it('empty: a question and a link', () => {
    const html = box([], { noun: 'LR / bilty', optional: true })
    assert.equal(text(html), 'Have a transporter\'s LR / bilty? Scan it too (optional)')
    assert.equal(html.includes('odr-scan"'), false)
  })
  it('with a paper it is a card like the others', () => {
    const html = box([paper({ fileName: 'bilty.jpg' })], { noun: 'LR / bilty', optional: true })
    assert.ok(html.includes('odr-scan--done'))
    assert.ok(text(html).includes('Add another LR / bilty paper'))
  })
})

describe('the Record dispatch screen, in order', () => {
  const src = readFileSync('src/app/orders/[id]/OrderDispatchRecord.tsx', 'utf8').replace(/\r\n/g, '\n')

  it('goes Invoice, then E-way bill, then Dispatch and transport, each box above its fields', () => {
    const one = src.indexOf('<span className="odr-step">1</span>Invoice')
    const two = src.indexOf('<span className="odr-step">2</span>E-way bill')
    const three = src.indexOf('<span className="odr-step">3</span>Dispatch and transport')
    assert.ok(one > 0 && one < two && two < three)
    assert.ok(src.indexOf("scan('invoice', 'invoice')") > one && src.indexOf("scan('invoice', 'invoice')") < src.indexOf('label="Invoice no."'))
    assert.ok(src.indexOf("scan('eway_bill', 'e-way bill')") > two && src.indexOf("scan('eway_bill', 'e-way bill')") < src.indexOf('label="E-way bill no."'))
    assert.ok(src.indexOf("scan('lr', 'LR / bilty', true)") > three)
  })

  it('keeps every field, so a paper that cannot be read, or a wrong detail, can be typed', () => {
    for (const label of ['Invoice no.', 'Invoice date', 'Taxable value (₹)', 'GST (₹)', 'Invoice total (₹)',
      'E-way bill no.', 'Generated on', 'Valid until', 'Dispatch date', 'Vehicle number', 'Transporter',
      'LR / bilty no.', 'Packages', 'Driver phone', 'Deliver to', 'Note']) {
      assert.ok(src.includes(`label="${label}"`), label)
    }
    assert.ok(src.includes('<Field label="Deliver to" wide'), 'a ship-to address is long: its own row')
  })

  it('the one combined upload button and the per-paper kind menu are gone', () => {
    assert.equal(src.includes('Add invoice, e-way bill or bilty'), false)
    assert.equal(src.includes('DISPATCH_PAPER_KINDS'), false)
    assert.equal(src.includes('odr-add-btn'), false)
  })

  it('warns when the papers name another Order, and says whether the e-way bill covers the invoice', () => {
    assert.ok(src.includes('These papers name Order {otherOrder}, not Order'))
    assert.ok(src.includes('paperOrderMismatch(r, data.displayNumber)'), 'the stored four-digit number, compared as a number')
    assert.ok(src.includes('Matches invoice {wayCheck.invoice}'))
    assert.ok(src.includes('The e-way bill covers {wayCheck.eway}; the invoice is {wayCheck.invoice}'))
  })

  it('tells the person, before Save, what it will do to the Order', () => {
    assert.ok(src.includes('This sends everything: the Order becomes Dispatched'))
    assert.ok(src.includes('The Order stays {STATUS_WORD[data.orderStatus]'))
    assert.ok(src.includes("(stay <= 0 ? 'close' : 'stay')"))
  })

  it('a paper moves to the box the reader says it belongs in, through the tested rule', () => {
    assert.ok(src.includes('placePaper(said, slot)'))
  })

  it('on a phone the paper beside the details is hidden and the buttons fill the width', () => {
    const css = readFileSync('src/app/globals.css', 'utf8').replace(/\r\n/g, '\n')
    assert.ok(css.includes('  .odr-paper-card { display: none; }'))
    assert.ok(css.includes('  .odr-scan .boe-btn { flex: 1 1 100%; }'))
    assert.ok(css.includes('.odr-scan-camera { display: inline-flex; }'), 'the camera button shows on a phone')
  })
})
