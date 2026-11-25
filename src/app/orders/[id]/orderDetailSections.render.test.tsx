/**
 * The Order's detail sections and the facts line, rendered (Nitish / Operations, 24 Nov 2026; the sections
 * opened and rearranged at the owner's word, 25 Nov 2026).
 *
 * Every component is a function of its props; these check what they SAY, that nothing is folded, that every
 * body is mounted from the first draw (so nothing it loads moves), that the grid puts each section where the
 * owner put it, and that the strip without a bar is exactly what it was.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderDetailSections.render.test.tsx"
 */

import '@/lib/testing/cssModuleStub'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderDetailSections, OrderTermsAndMoney, SECTION_TITLE, type SectionKey } from './OrderDetailSections'
import { OrderStatusStrip } from './OrderRedesign'
import { OrderSummaryPanel } from './OrderWorkspace'
import type { OrderSummaryView } from '@/lib/orders/orderWorkspace'
import { orderBarGates } from '@/lib/orders/orderBarGates'
import type { AdvanceReadiness } from '@/lib/orders/advanceReadiness'

const advance = (over: Partial<AdvanceReadiness> = {}): AdvanceReadiness => ({
  order_value: 1240000, advance_base: 1240000, value_known: true, verified: 645000, awaiting: 0, required: 496000,
  shortfall: 0, percent: 52, threshold_percent: 40, below: false, ready: true, exception: null, hold: null, ...over,
})

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SRC = read('src/app/orders/[id]/OrderDetailSections.tsx')

const termsAndMoney = (attached = false) => (
  <OrderTermsAndMoney
    attached={attached}
    terms={<p data-body="terms">terms body</p>}
    pendencies={<p data-body="pend">pendencies body</p>}
    totals={<p data-body="totals">totals body</p>}
  />
)

// the page draws the terms and the money at the foot of the Products card, then the sections below: the two together
const sections = () => renderToStaticMarkup(
  <>
    {termsAndMoney()}
    <OrderDetailSections
      payment={{ actions: <button type="button" data-body="pay-actions">Add payment</button>, body: <p data-body="pay">payment body</p> }}
      dates={<p data-body="dates">dates body</p>}
      client={<p data-body="client">client body</p>}
      activity={<p data-body="act">activity body</p>}
    />
  </>,
)

describe('the open sections', () => {
  test('six sections in two cards, in the owner\'s order, each with its own heading', () => {
    const html = sections()
    // the terms and the money are a card of their own, apart from the rest (owner, 25 Nov 2026)
    assert.equal((html.match(/<section class="order-sections" aria-label="[^"]*">/g) ?? []).length, 2)
    assert.ok(html.includes('aria-label="Internal details and commercial breakdown"'))
    const second = html.indexOf('aria-label="Order details"')
    assert.ok(second > 0)
    assert.ok(html.indexOf('id="order-sec-terms"') < second && html.indexOf('id="order-sec-totals"') < second, 'Internal details and the breakdown are in the first card')
    assert.ok(html.indexOf('id="order-sec-pay"') > second && html.indexOf('id="order-sec-act"') > second, 'Payment, Dates, Client and Activity are in the second')
    const order: SectionKey[] = ['terms', 'totals', 'pay', 'dates', 'client', 'act']
    const at = order.map(k => html.indexOf(`id="order-sec-${k}"`))
    assert.ok(at.every(p => p > 0), 'every section is drawn')
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'Internal details, Commercial breakdown, Payment, Dates, Client and sale, Activity')
    for (const k of order) {
      assert.ok(html.includes(`<h2 class="order-section-title" id="order-sec-${k}-title">${SECTION_TITLE[k]}</h2>`), `${k} has a heading`)
      assert.ok(html.includes(`aria-labelledby="order-sec-${k}-title"`))
    }
    assert.deepEqual(Object.values(SECTION_TITLE), [
      'Internal details and terms', 'Commercial breakdown', 'Payment', 'Dates', 'Client and sale', 'Activity',
    ])
  })

  test('the terms and the money can be JOINED to the Products card: a modifier, nothing else changes', () => {
    const free = renderToStaticMarkup(termsAndMoney(false))
    const joined = renderToStaticMarkup(termsAndMoney(true))
    assert.ok(free.includes('<section class="order-sections" aria-label="Internal details and commercial breakdown">'))
    assert.ok(joined.includes('<section class="order-sections order-sections--attached" aria-label="Internal details and commercial breakdown">'))
    assert.equal(joined.replace(' order-sections--attached', ''), free, 'the same markup, only the class differs')
    // the details card is never joined
    assert.equal(sections().split('order-sections--attached').length - 1, 0)
  })

  test('NOTHING IS FOLDED: no toggle, no hidden region, no expanded state', () => {
    const html = sections()
    assert.equal(/aria-expanded|aria-controls| hidden=""|role="region"/.test(html), false)
    // the only button on the page is the one handed in for the Payment heading
    assert.equal((html.match(/<button/g) ?? []).length, 1)
  })

  test('every body is in the markup from the first draw: nothing it loads on mount moves', () => {
    const html = sections()
    for (const k of ['terms', 'pend', 'totals', 'pay', 'pay-actions', 'dates', 'client', 'act']) {
      assert.ok(html.includes(`data-body="${k}"`), `${k} must be mounted`)
    }
  })

  test('two columns of two, then Activity: the grid is the one the owner drew', () => {
    const html = sections()
    assert.equal((html.match(/order-sections-band order-sections-band--two/g) ?? []).length, 2)
    assert.equal((html.match(/order-sections-band order-sections-band--one/g) ?? []).length, 1)
    // row 1: Internal details and terms, with Pendencies at its foot, beside the Commercial breakdown
    const terms = html.slice(html.indexOf('id="order-sec-terms"'), html.indexOf('id="order-sec-totals"'))
    assert.ok(terms.indexOf('data-body="terms"') < terms.indexOf('<div class="order-section-foot">'), 'the terms body comes first')
    assert.ok(terms.indexOf('<div class="order-section-foot">') < terms.indexOf('data-body="pend"'), 'Pendencies are at the foot')
    // row 2: Payment, and Dates over Client and sale in one stack
    const stack = html.slice(html.indexOf('<div class="order-sections-stack">'), html.indexOf('id="order-sec-act"'))
    assert.ok(stack.indexOf('id="order-sec-dates"') > 0 && stack.indexOf('id="order-sec-dates"') < stack.indexOf('id="order-sec-client"'))
    assert.equal(stack.includes('id="order-sec-pay"'), false, 'Payment is the other column')
    assert.ok(html.indexOf('id="order-sec-pay"') < html.indexOf('<div class="order-sections-stack">'), 'Payment is on the left')
  })

  test('the Payment heading carries the controls handed in, and no other heading does', () => {
    const html = sections()
    assert.equal((html.match(/class="order-section-actions"/g) ?? []).length, 1)
    const pay = html.slice(html.indexOf('id="order-sec-pay"'), html.indexOf('data-body="pay"'))
    assert.ok(pay.includes('order-section-actions') && pay.includes('data-body="pay-actions"'))
  })

  test('presentation only: no link, no storage, no read, no write', () => {
    for (const banned of ['href=', 'next/link', 'localStorage', 'sessionStorage', 'supabase', 'fetch(', '.rpc(', '.from(']) {
      assert.equal(SRC.includes(banned), false, banned)
    }
  })

  test('a gate on the facts line scrolls to its section; #order-pendencies scrolls to the one Pendencies sit in; nothing is remembered', () => {
    assert.ok(SRC.includes("document.getElementById(`order-sec-${target.key}`)?.scrollIntoView("))
    assert.ok(SRC.includes("{ '#order-pendencies': 'terms' }"))
    assert.ok(SRC.includes("prefers-reduced-motion: reduce"))
    assert.equal(/localStorage|sessionStorage/.test(SRC), false)
    // the page asks for Payment from the Advance cell
    assert.ok(read('src/app/orders/[id]/OrderRedesign.tsx').includes('row="pay"'))
  })
})

describe('the facts line (the status strip with the due date and the Advance gate)', () => {
  const strip = (extra: Partial<Parameters<typeof orderBarGates>[0]> = {}, bar = true) => renderToStaticMarkup(
    <OrderStatusStrip
      erp={{ label: 'Not Aligned', tone: 'amber', line: 'Awaiting production alignment.' }}
      production={{ label: 'Running', tone: 'blue' }}
      isSample={false}
      sampleLabel={null}
      dispatch={{ text: '0 of 72 pcs', percent: 0, onOpen: () => {} }}
      bar={bar ? {
        ...orderBarGates({
          advance: advance(),
          dueDate: '20 Dec 2026', daysToDue: 26, ...extra,
        }),
        onOpen: () => {},
      } : null}
    />,
  )

  test('is ONE line with the Advance gate as a button, and says what it is in words', () => {
    const html = strip()
    assert.match(html, /class="order-stages order-stages--bar"/)
    assert.equal((html.match(/class="order-stage order-stage--gate"/g) ?? []).length, 1)
    assert.match(html, /aria-label="Advance: 52% of the Total before GST, verified by Finance; the 40% requirement is met\. Open the details\."/)
  })

  test('Dispatch, Fabric & Finish and From client are NOT on the line (owner: not required on top)', () => {
    const html = strip()
    assert.equal(html.includes('order-stage--dispatch'), false)
    assert.equal(html.includes('Dispatch'), false)
    assert.equal(html.includes('Fabric'), false)
    assert.equal(html.includes('From client'), false)
    assert.equal(html.includes('order-stage-gap'), false)
    // five cells: ERP, Production, Order type, Due, Advance
    assert.equal((html.match(/class="order-stage[ "]/g) ?? []).length, 5)
  })

  test('the due date counts down, and says OVERDUE in words once it has passed', () => {
    assert.ok(strip().includes('26 days left'))
    const late = strip({ daysToDue: -3, dueDate: '1 Nov' })
    assert.ok(late.includes('3 days overdue'))
    assert.match(late, /order-stage order-stage--due is-late/)
  })

  test('a short advance is a red chip with the database\'s own threshold', () => {
    const html = strip({ advance: advance({ percent: 25, below: true, ready: false, threshold_percent: 40 }) })
    assert.ok(html.includes('Below 40%'))
    assert.match(html, /order-bar-chip order-bar-chip--red/)
  })

  test('before the reads land the gates say a dash, not a claim', () => {
    const html = strip({ advance: null })
    assert.ok(html.includes('Not read yet'))
    assert.equal((html.match(/—/g) ?? []).length >= 1, true)
  })

  test('WITHOUT a bar it is exactly the four separate cells it always was', () => {
    const html = strip({}, false)
    assert.match(html, /<section class="order-stages" aria-label="Order stages">/)
    assert.equal(html.includes('order-stage--gate'), false)
    assert.equal(html.includes('order-stage--due'), false)
  })
})

describe('the pieces the sections reuse', () => {
  const row = (key: string, label: string, value: string) => ({ key, label, value, missing: false, detail: null, tone: 'neutral' as const })
  const view: OrderSummaryView = {
    client: { rows: [row('client', 'Client', 'Aarav Interiors'), row('contact', 'Contact', '+91 90000 12345'), row('location', 'Location', 'Pune')] },
    sales: {
      production: { label: 'Not Aligned', tone: 'amber', aligned: false, line: null },
      rows: [row('lead_source', 'Lead source', 'Instagram'), row('salesperson', 'Salesperson', 'Meera Shah')],
    },
    dates: [row('confirm_date', 'Confirmed', '17 Nov')],
  }

  test('the summary panel draws ONLY the client-and-sale group inside its section, and all three everywhere else', () => {
    const only = renderToStaticMarkup(<OrderSummaryPanel view={view} groups="client" datesSlot={<p>DATES SLOT</p>} pendenciesSlot={<p>PEND SLOT</p>} />)
    assert.ok(only.includes('Aarav Interiors') && only.includes('Meera Shah'))
    assert.equal(only.includes('DATES SLOT'), false)
    assert.equal(only.includes('PEND SLOT'), false)
    const all = renderToStaticMarkup(<OrderSummaryPanel view={view} datesSlot={<p>DATES SLOT</p>} pendenciesSlot={<p>PEND SLOT</p>} />)
    assert.ok(all.includes('DATES SLOT') && all.includes('PEND SLOT'))
  })

  test('Pendencies read once, from their own card, and report no count: the facts line no longer shows one', () => {
    const src = read('src/app/orders/[id]/OrderPendencies.tsx')
    assert.equal(src.split(".from('order_pendencies')").length - 1, 1, 'still exactly one read')
    assert.equal(src.includes('onCount'), false)
    assert.equal(/\bonCount\b|pendencyOpen/.test(read('src/app/orders/[id]/page.tsx')), false)
  })
})
