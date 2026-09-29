import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiCommissionSummary, PiDiscountWordingNotice } from './PiInternalDetails'

const noop = () => {}

describe('PiCommissionSummary — the middleman answer in the PI summary', () => {
  test('a blank PI shows "Not answered" as a state, says what is needed before review, and offers the editor to its owner', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary row={{}} canEdit onEdit={noop} />)
    assert.match(html, /Middleman commission/)
    assert.match(html, /class="pi-detail-state-chip">Not answered</)
    assert.match(html, /Never printed on the client PI/)
    // THE DATES ARE ASKED FOR AT SUBMISSION (2026-09-27), so a blank date is
    // never the warning here; the unanswered middleman question is.
    assert.match(html, /Needed before review: answer &quot;Is there a middleman commission\?&quot;\./)
    assert.doesNotMatch(html, /confirmation date\./)
    assert.match(html, />Enter and confirm</)
    // The dates are the summary's own band; this block never repeats them.
    assert.doesNotMatch(html, /Order confirmation date|Due date/)
  })

  test('unanswered with the dates in: the warning names the missing answer', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary canEdit onEdit={noop}
      row={{ status: 'draft', order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }} />)
    assert.match(html, /pi-detail-internal-status--needed/)
    assert.match(html, /Needed before review: answer &quot;Is there a middleman commission\?&quot;\./)
  })

  test('answered, dates still blank: a neutral line, no warning — Submit collects the dates', () => {
    for (const status of ['draft', 'needs_changes']) {
      const html = renderToStaticMarkup(<PiCommissionSummary canEdit onEdit={noop}
        row={{ status, middleman_commission: 'no' }} />)
      assert.doesNotMatch(html, /pi-detail-internal-status--needed/, status)
      assert.doesNotMatch(html, /Needed before review/, status)
      assert.match(html, /pi-detail-internal-status--neutral/, status)
      assert.match(html, /entered in Internal order details and confirmed when this PI is submitted/, status)
    }
  })

  test('the reviewer reads the confirmed answer, with no edit control and no dates', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary canEdit={false} onEdit={noop} row={{
      order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
      middleman_commission: 'yes', middleman_recipient: 'ASSERT agent',
      middleman_commission_basis: 'percent', middleman_commission_percent: 2.5,
      middleman_commission_percent_of: 'total_before_gst',
      internal_details_confirmed_at: '2026-09-26T11:00:00Z', internal_details_confirmed_by: 'x',
    }} />)
    assert.match(html, /class="pi-detail-internal-value">Yes — ASSERT agent, 2\.5% of Total before GST</)
    assert.match(html, /Confirmed 26 Sep 2026/)
    assert.doesNotMatch(html, /20 Sep 2026|20 Nov 2026/)
    assert.doesNotMatch(html, /<button/)
  })

  test('answered "No" and confirmed: the owner may still edit', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary canEdit onEdit={noop} row={{
      order_confirmation_date: '2026-09-20', due_date: '2026-11-20', middleman_commission: 'no',
      internal_details_confirmed_at: '2026-09-26T11:00:00Z' }} />)
    assert.match(html, /class="pi-detail-internal-value">No</)
    assert.match(html, />Edit</)
  })

  test('a viewer who may not read the commission is told so, never shown "Not answered"', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary canEdit={false} onEdit={noop}
      row={{ commission_restricted: true, order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }} />)
    assert.match(html, /pi-detail-internal-restricted">Restricted/)
    assert.doesNotMatch(html, /Not answered/)
  })

  // "Needed before review" is only true while the PI is being prepared.
  test('a submitted or approved PI never says "Needed before review"', () => {
    for (const status of ['submitted', 'approved', 'rejected']) {
      const html = renderToStaticMarkup(<PiCommissionSummary canEdit={false} onEdit={noop}
        row={{ status, order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }} />)
      assert.doesNotMatch(html, /Needed before review/, status)
      assert.match(html, /Not confirmed in the app before this PI was sent for review\./, status)
    }
    for (const status of ['draft', 'needs_changes']) {
      const html = renderToStaticMarkup(<PiCommissionSummary canEdit onEdit={noop}
        row={{ status, order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }} />)
      assert.match(html, /Needed before review: answer/, status)
    }
    const confirmed = renderToStaticMarkup(<PiCommissionSummary canEdit={false} onEdit={noop} row={{
      status: 'approved', order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
      middleman_commission: 'no', internal_details_confirmed_at: '2026-09-26T11:00:00Z' }} />)
    assert.match(confirmed, /Confirmed 26 Sep 2026/)
  })

  test('the PI page has no separate Internal details card any more', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8')
    assert.doesNotMatch(page, /PiInternalDetailsCard/)
    assert.match(page, /internal=\{\s*<PiCommissionSummary/)
    assert.match(page, /dateNotes=\{workbookDateNotes\(submission\)\}/)
  })
})

describe('PiDiscountWordingNotice', () => {
  test('renders nothing when there is nothing to check', () => {
    assert.equal(renderToStaticMarkup(<PiDiscountWordingNotice notice={null} />), '')
  })

  test('the PI page offers no Design Fee choice — a non-zero deduction is always Discount on the client PI', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8')
    assert.doesNotMatch(page, /design_fee|DeductionLabelControl|set_order_submission_deduction_label/)
  })
})
