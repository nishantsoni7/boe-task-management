/**
 * The Order bar and the folded rows, rendered (Nitish / Operations, 24 Nov 2026).
 *
 * Every component is a function of its props; these check what they SAY, that a
 * closed row keeps its body mounted (so nothing it loads moves), that nothing
 * depends on colour alone, and that the strip without a bar is exactly what it
 * was.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderDetailRows.render.test.tsx"
 */

import '@/lib/testing/cssModuleStub'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderDetailRows } from './OrderDetailRows'
import { OrderStatusStrip } from './OrderRedesign'
import { OrderSummaryPanel } from './OrderWorkspace'
import type { OrderSummaryView } from '@/lib/orders/orderWorkspace'
import { DETAIL_ROW_ORDER, detailRows, orderBarGates, type DetailRowKey } from '@/lib/orders/orderDetailRows'
import type { AdvanceReadiness } from '@/lib/orders/advanceReadiness'
import type { ApprovalKindStanding } from '@/lib/orders/orderApprovals'

const advance = (over: Partial<AdvanceReadiness> = {}): AdvanceReadiness => ({
  order_value: 1240000, advance_base: 1240000, value_known: true, verified: 645000, awaiting: 0, required: 496000,
  shortfall: 0, percent: 52, threshold_percent: 40, below: false, ready: true, exception: null, hold: null, ...over,
})

const kind = (label: 'Fabric' | 'Finish', status: ApprovalKindStanding['status']): ApprovalKindStanding => ({
  kind: label === 'Fabric' ? 'fabric' : 'finish', label, status,
  tone: status === 'fully_approved' ? 'green' : 'amber', at: null, approver: null, actorId: null, evidencePath: null, history: [],
} as ApprovalKindStanding)

const rowsFor = (over: Parameters<typeof detailRows>[0] extends infer T ? Partial<T> : never = {}) => detailRows({
  clientRows: [{ key: 'client', label: 'Client', value: 'Aarav Interiors' }],
  salesRows: [],
  dates: { confirm: '17 Nov', approved: '21 Nov', due: '20 Dec', daysToDue: 26 },
  payment: { loaded: true, verifiedPercent: '52', orderValue: '₹1', awaiting: '₹0', awaitingCount: 0 },
  advance: advance(),
  approvals: [kind('Fabric', 'fully_approved'), kind('Finish', 'fully_approved')],
  pendingFromClient: 0,
  internalRows: [],
  termsCount: 0,
  commercial: [],
  activity: { count: 0, latestLabel: null, latestWhen: null, newCount: 0 },
  acceptBlockedByAdvance: false,
  ...over,
} as Parameters<typeof detailRows>[0])

const bodies = Object.fromEntries(
  DETAIL_ROW_ORDER.map(k => [k, <p key={k} data-body={k}>body of {k}</p>]),
) as Record<DetailRowKey, React.ReactNode>

describe('the folded rows', () => {
  test('seven rows under one heading, each a button that is closed and a region that is hidden', () => {
    const html = renderToStaticMarkup(<OrderDetailRows rows={rowsFor()} bodies={bodies} />)
    assert.match(html, /<h2 class="order-rows-title">Order details<\/h2>/)
    assert.equal((html.match(/class="order-row-head"/g) ?? []).length, 7)
    assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 7)
    assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 0)
    assert.equal((html.match(/role="region"/g) ?? []).length, 7)
    assert.equal((html.match(/ hidden=""/g) ?? []).length, 7)
  })

  test('a closed row KEEPS its body in the markup: nothing it loads on mount moves', () => {
    const html = renderToStaticMarkup(<OrderDetailRows rows={rowsFor()} bodies={bodies} />)
    for (const k of DETAIL_ROW_ORDER) assert.ok(html.includes(`data-body="${k}"`), `${k} body must stay mounted`)
  })

  test('each button names the region it controls, and the ids match', () => {
    const html = renderToStaticMarkup(<OrderDetailRows rows={rowsFor()} bodies={bodies} />)
    for (const k of DETAIL_ROW_ORDER) {
      assert.ok(html.includes(`aria-controls="order-row-body-${k}"`))
      assert.ok(html.includes(`id="order-row-body-${k}"`))
      assert.ok(html.includes(`id="order-row-${k}"`))
    }
  })

  test('titles and one-line summaries are drawn as words, in the agreed order', () => {
    const html = renderToStaticMarkup(<OrderDetailRows rows={rowsFor()} bodies={bodies} />)
    const titles = ['Client and sale', 'Dates', 'Payment', 'Pendencies', 'Internal details and terms', 'Commercial breakdown', 'Activity']
    const at = titles.map(t => html.indexOf(`<span class="order-row-title">${t}</span>`))
    assert.ok(at.every(p => p > 0))
    assert.deepEqual([...at].sort((a, b) => a - b), at)
    assert.ok(html.includes('Aarav Interiors'))
    assert.ok(html.includes('Due 20 Dec (26 days left)'))
  })

  test('a row that holds up the reader\'s decision opens by itself; the others stay folded', () => {
    const short = advance({ percent: 25, below: true, ready: false, shortfall: 186000 })
    const html = renderToStaticMarkup(
      <OrderDetailRows rows={rowsFor({ advance: short, acceptBlockedByAdvance: true })} bodies={bodies} />,
    )
    assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1)
    assert.match(html, /aria-controls="order-row-body-pay"/)
    const pay = html.slice(html.indexOf('id="order-row-body-pay"'), html.indexOf('id="order-row-body-pend"'))
    assert.equal(pay.includes(' hidden=""'), false, 'the Payment body is shown')
    assert.equal((html.match(/ hidden=""/g) ?? []).length, 6)
  })

  test('a badge is words for a screen reader, never a bare number', () => {
    const html = renderToStaticMarkup(
      <OrderDetailRows rows={rowsFor({ pendingFromClient: 2, approvals: [kind('Fabric', 'partially_approved'), kind('Finish', 'not_approved')] })} bodies={bodies} />,
    )
    assert.match(html, /<span aria-hidden="true">2<\/span><span class="order-row-sr">2 items pending from the client<\/span>/)
    assert.ok(html.includes('order-row--amber'), 'the row\'s icon is tinted, and the words above say the same')
  })

  test('presentation only: no link, no storage, no read, no write', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/orders/[id]/OrderDetailRows.tsx'), 'utf8')
    for (const banned of ['href=', 'next/link', 'localStorage', 'sessionStorage', 'supabase', 'fetch(', '.rpc(', '.from(']) {
      assert.equal(src.includes(banned), false, banned)
    }
  })
})

describe('the Order bar (the status strip with the due date and three gates)', () => {
  const strip = (extra: Partial<Parameters<typeof orderBarGates>[0]> = {}, bar = true) => renderToStaticMarkup(
    <OrderStatusStrip
      erp={{ label: 'Not Aligned', tone: 'amber', line: 'Awaiting production alignment.' }}
      production={{ label: 'Running', tone: 'blue' }}
      isSample={false}
      sampleLabel={null}
      dispatch={{ text: '0 of 72 pcs', percent: 0, onOpen: () => {} }}
      bar={bar ? {
        ...orderBarGates({
          advance: advance(), approvals: [kind('Fabric', 'partially_approved'), kind('Finish', 'not_approved')],
          pendingFromClient: 2, dueDate: '20 Dec 2026', daysToDue: 26, ...extra,
        }),
        onOpen: () => {},
      } : null}
    />,
  )

  test('is ONE card with the three gates as buttons, and says what each one is in words', () => {
    const html = strip()
    assert.match(html, /class="order-stages order-stages--bar"/)
    assert.equal((html.match(/class="order-stage order-stage--gate"/g) ?? []).length, 3)
    assert.match(html, /aria-label="Advance: 52% of the Total before GST, verified by Finance; the 40% requirement is met\. Open the details\."/)
    assert.match(html, /aria-label="Fabric &amp; Finish: Fabric Partially Approved, Finish Not Approved\. Open the details\."/)
    assert.match(html, /aria-label="From client: 2 items pending from the client\. Open the details\."/)
    assert.ok(html.includes('Fabric partial · Finish not approved'))
    assert.ok(!html.includes('of 2'), 'never a loose count of approvals')
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
    const html = strip({ advance: null, approvals: [], pendingFromClient: null })
    assert.ok(html.includes('Not read yet'))
    assert.equal((html.match(/—/g) ?? []).length >= 3, true)
  })

  test('WITHOUT a bar it is exactly the four separate cells it always was', () => {
    const html = strip({}, false)
    assert.match(html, /<section class="order-stages" aria-label="Order stages">/)
    assert.equal(html.includes('order-stage--gate'), false)
    assert.equal(html.includes('order-stage--due'), false)
  })
})

describe('the pieces the rows reuse', () => {
  const row = (key: string, label: string, value: string) => ({ key, label, value, missing: false, detail: null, tone: 'neutral' as const })
  const view: OrderSummaryView = {
    client: { rows: [row('client', 'Client', 'Aarav Interiors'), row('contact', 'Contact', '+91 90000 12345'), row('location', 'Location', 'Pune')] },
    sales: {
      production: { label: 'Not Aligned', tone: 'amber', aligned: false, line: null },
      rows: [row('lead_source', 'Lead source', 'Instagram'), row('salesperson', 'Salesperson', 'Meera Shah')],
    },
    dates: [row('confirm_date', 'Confirmed', '17 Nov')],
  }

  test('the summary panel draws ONLY the client-and-sale group inside its row, and all three everywhere else', () => {
    const only = renderToStaticMarkup(<OrderSummaryPanel view={view} groups="client" datesSlot={<p>DATES SLOT</p>} pendenciesSlot={<p>PEND SLOT</p>} />)
    assert.ok(only.includes('Aarav Interiors') && only.includes('Meera Shah'))
    assert.equal(only.includes('DATES SLOT'), false)
    assert.equal(only.includes('PEND SLOT'), false)
    const all = renderToStaticMarkup(<OrderSummaryPanel view={view} datesSlot={<p>DATES SLOT</p>} pendenciesSlot={<p>PEND SLOT</p>} />)
    assert.ok(all.includes('DATES SLOT') && all.includes('PEND SLOT'))
  })

  test('Pendencies reports its count from its OWN read: the page adds no read of its own', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/orders/[id]/OrderPendencies.tsx'), 'utf8')
    assert.equal(src.split(".from('order_pendencies')").length - 1, 1, 'still exactly one read')
    assert.ok(src.includes('useEffect(() => { onCount?.(reportedCount) }, [onCount, reportedCount])'))
    // Unreadable or not yet read is null, never zero: the bar must not claim "None".
    assert.ok(src.includes('const reportedCount = unreadable ? null : openCount'))
    assert.ok(src.includes('const openCount = rows === null ? null : splitPendencies(rows).open.length'))
    // The hooks run before the early returns, so the count is reported whatever the card draws.
    assert.ok(src.indexOf('onCount?.(reportedCount)') < src.indexOf('if (unreadable) return null'))
  })
})
