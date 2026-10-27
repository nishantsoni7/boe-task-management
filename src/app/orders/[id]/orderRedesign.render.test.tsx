// The redesigned top band and bottom cards of the Confirmed Order page.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  OrderDatesTimelineCard,
  OrderInternalDetailsCard,
  OrderStatusStrip,
} from './OrderRedesign'
import { orderDatesTimeline } from '../../../lib/orders/orderDatesTimeline'
import { popoverWhen } from './OrderStatusWorkspace'
import { OrderActivityList, type OrderActivityItem } from './OrderWorkspace'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')

const strip = (isSample: boolean, fullNote: string | null = null) => renderToStaticMarkup(
  <OrderStatusStrip
    erp={{ label: 'Not Aligned', tone: 'amber', line: 'Awaiting production alignment.' }}
    production={{ label: 'Running', tone: 'blue' }}
    isSample={isSample}
    sampleLabel={isSample ? 'Sample order only' : null}
    fullNote={fullNote}
  />,
)

describe('the status strip', () => {
  test('states ERP, production and the order type', () => {
    const body = text(strip(false))
    for (const s of ['ERP', 'Not Aligned', 'Awaiting production alignment.', 'Production', 'Running', 'Order type', 'Full order']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('a sample order is loud (red, pulsing dot); a full order is not', () => {
    const sample = strip(true)
    assert.ok(sample.includes('order-stage--sample'))
    assert.ok(sample.includes('order-sample-dot'))
    assert.ok(text(sample).includes('Sample order'))
    const full = strip(false)
    assert.equal(full.includes('order-sample-dot'), false)
    assert.equal(full.includes('order-stage--sample'), false)
  })

  test('sampling-first is noted on a full order, quietly', () => {
    assert.ok(text(strip(false, 'sampling first')).includes('Full order · sampling first'))
  })

  test('the pulse stops for readers who ask for reduced motion', () => {
    assert.match(css, /prefers-reduced-motion: reduce\) \{ \.order-sample-dot \{ animation: none; \} \}/)
  })
})

const timelineMarkup = (over: { confirm?: string | null; uploadedAt?: string | null; approved?: string | null; due?: string | null } = {}) => {
  const timeline = orderDatesTimeline({
    confirmDate: over.confirm === undefined ? '2026-09-26' : over.confirm,
    uploadedAt: over.uploadedAt === undefined ? '2026-10-26T12:24:00Z' : over.uploadedAt,
    dueDate: over.due === undefined ? '2026-11-12' : over.due,
    now: new Date('2026-10-26T12:00:00Z'),
  })
  return renderToStaticMarkup(
    <OrderDatesTimelineCard
      title="Important dates"
      confirm="26 Sep 2026"
      upload="26 Oct 2026, 5:54 pm"
      approved={over.approved === undefined ? null : over.approved}
      due="12 Nov 2026"
      timeline={timeline}
      overdue={false}
    />,
  )
}

describe('the dates timeline', () => {
  test('lists the four dates in order, with an approval that has not happened saying Awaiting', () => {
    const body = text(timelineMarkup())
    const at = (s: string) => body.indexOf(s)
    assert.ok(at('Confirmed') < at('PI uploaded by salesperson'))
    assert.ok(at('PI uploaded by salesperson') < at('Approved by admin team'))
    assert.ok(at('Approved by admin team') < at('Due date'))
    assert.ok(body.includes('Awaiting'))
  })

  test('flags a late upload and counts down to the due date', () => {
    const html = timelineMarkup()
    assert.ok(text(html).includes('30 days after the confirm date'))
    assert.ok(html.includes('order-timeline-stop--flag'))
    assert.ok(text(html).includes('17 days left'))
    assert.ok(text(html).includes('Uploaded today'))
  })

  test('a prompt upload is not flagged', () => {
    const html = timelineMarkup({ confirm: '2026-10-25' })
    assert.equal(html.includes('order-timeline-flag'), false)
    assert.equal(html.includes('order-timeline-stop--flag'), false)
  })
})

describe('the internal details card, with the general terms inside it', () => {
  const card = (termsPoints: string[]) => renderToStaticMarkup(
    <OrderInternalDetailsCard
      title="Internal Order Details"
      rows={[
        { key: 'fabric_responsibility', label: 'Fabric responsibility', value: 'Fabric will be provided by BOE', muted: false },
        { key: 'billing_percentage', label: 'Bill / cash percentage', value: 'Bill 70% · Cash 30%', muted: false },
        { key: 'middleman_commission', label: 'Middleman commission', value: 'Restricted', muted: true },
        { key: 'middleman_name', label: 'Middleman name', value: 'Restricted', muted: true },
      ]}
      termsPoints={termsPoints}
    />,
  )

  test('lists the four rows in order, then General Terms in the same card', () => {
    const body = text(card(['Prices are ex-factory.', 'GST extra.']))
    const at = (x: string) => body.indexOf(x)
    for (const x of ['Internal Order Details', 'Fabric responsibility', 'Bill / cash percentage', 'Middleman commission', 'Middleman name', 'General Terms']) {
      assert.ok(at(x) >= 0, x)
    }
    assert.ok(at('Fabric responsibility') < at('Bill / cash percentage'))
    assert.ok(at('Bill / cash percentage') < at('Middleman commission'))
    assert.ok(at('Middleman commission') < at('Middleman name'))
    assert.ok(at('Middleman name') < at('General Terms'))
    assert.ok(body.includes('Prices are ex-factory. GST extra.'))
    assert.equal((card([]).match(/class="order-info-card"/g) ?? []).length, 1, 'one card, not two')
  })

  test('restricted values are muted, and an empty terms note says so', () => {
    assert.equal((card([]).match(/is-muted/g) ?? []).length, 2)
    assert.ok(text(card([])).includes('No general terms are recorded on the PI.'))
  })
})

describe('the sample choice lives in the internal details card, not in Documents', () => {
  const withSample = (canEdit: boolean, value: 'sample_order' | null) => renderToStaticMarkup(
    <OrderInternalDetailsCard
      title="Internal Order Details"
      rows={[]}
      termsPoints={[]}
      sample={{ value, canEdit, saving: false, failure: null, onChange: () => {} }}
    />,
  )

  test('an editor draws a select; a reader sees the words', () => {
    const editor = withSample(true, null)
    assert.match(editor, /<select[^>]*aria-label="Sample"/)
    assert.ok(text(editor).includes('Not a sample'))
    const reader = withSample(false, 'sample_order')
    assert.equal(reader.includes('<select'), false)
    assert.ok(text(reader).includes('Sample order only'))
  })

  test('the page hands the sample to the card and the Documents card no longer draws Internal order details', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')
    const status = readFileSync(join(process.cwd(), 'src/app/orders/[id]/OrderStatusWorkspace.tsx'), 'utf8')
    assert.match(page, /<OrderInternalDetailsCard[\s\S]*?sample=\{\{/)
    assert.equal(/internalDetails=/.test(page), false)
    assert.equal(/order-docs-internal/.test(status), false)
  })
})

describe('the fabric responsibility note under the fabric cost', () => {
  test('is a small, subtle red line, not a pill', () => {
    assert.match(css, /\.order-breakdown-line:not\(\.order-breakdown-line--final\) \.order-breakdown-note \{[^}]*color: #C26A62/)
  })
})

describe('the commercial column is about 20% wider (owner, 2026-10-26)', () => {
  test('432px at most, 360px at least, instead of 360 / 300', () => {
    assert.match(css, /\.order-lower \{ grid-template-columns: minmax\(0, 1fr\) minmax\(360px, 432px\); \}/)
  })
})

describe('the Main PI details popover (owner, 2026-10-26)', () => {
  test('a date and its time read on one line, with a dot between them', () => {
    assert.equal(popoverWhen('25 Oct 2026, 02:18 pm'), '25 Oct 2026 · 02:18 pm')
    assert.equal(popoverWhen('2026-09-01'), '2026-09-01', 'a plain date is left alone')
  })

  test('each row is an icon, a label and a nowrap value; the pointer and the one-line rule are in the CSS', () => {
    assert.match(css, /\.order-pi-details-pop dd \{[^}]*white-space: nowrap/)
    assert.match(css, /\.order-pi-details-pop::before \{/)
    const source = readFileSync(join(process.cwd(), 'src/app/orders/[id]/OrderStatusWorkspace.tsx'), 'utf8')
    assert.ok(source.includes('order-pi-pop-ic'))
    assert.ok(source.includes('{popoverWhen(uploadedAt)}'))
  })
})

describe('the Activity list shows only the main activity (owner, 2026-10-27)', () => {
  const entry = (key: string, label: string, minor = false): OrderActivityItem => ({
    key, label, detail: null, lines: [], actor: 'Nishant Soni', when: '26 Oct 2026, 05:56 pm',
    dot: <span className="order-activity-dot" />, fromPi: false, minor,
  })
  const items = [
    entry('a', 'PI approved'),
    entry('b', 'Order product codes assigned', true),
    entry('c', 'Payments moved onto the Order', true),
    entry('d', 'Order amended'),
  ]

  test('minor events are left out, and the count says how many are behind the toggle', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={items} />)
    const body = text(html)
    assert.ok(body.includes('PI approved') && body.includes('Order amended'))
    assert.equal(body.includes('Order product codes assigned'), false)
    assert.equal(body.includes('Payments moved onto the Order'), false)
    assert.ok(body.includes('2 events'))
    assert.ok(body.includes('Show 2 minor events'))
    assert.match(html, /aria-pressed="false"/)
  })

  test('no minor events, no toggle; only minor events says there is no main activity yet', () => {
    assert.equal(text(renderToStaticMarkup(<OrderActivityList items={[entry('a', 'PI approved')]} />)).includes('minor event'), false)
    const onlyMinor = text(renderToStaticMarkup(<OrderActivityList items={[entry('b', 'Order product codes assigned', true)]} />))
    assert.ok(onlyMinor.includes('No main activity yet.'))
    assert.ok(onlyMinor.includes('Show 1 minor event'))
  })

  test('the page marks each entry minor by the importance rule', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')
    assert.ok(page.includes('minor: !isMainActivityEvent('))
  })
})

describe('the dates timeline takes both PI dates from the first version (owner, 2026-10-27)', () => {
  test('the page asks firstPiMilestones for the upload and the approval, never the version in force', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')
    assert.ok(page.includes('firstPiMilestones(piVersions, firstApprovalEventAt)'))
    assert.equal(page.includes('currentPiVersion'), false, 'a later revision must not supply the upload date')
  })
})
