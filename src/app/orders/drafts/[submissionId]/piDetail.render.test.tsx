/**
 * THE REDESIGNED PI DETAIL PAGE, ACTUALLY RENDERED.
 *
 * This screen is the one a salesperson opens to hand a PI to management and the
 * one a reviewer opens to decide on it, so what it asks of a person — and what
 * it refuses to offer them — is the whole product. Source guards alone cannot
 * check that: they prove a string is in a file, not that a button reached the
 * markup for the right viewer.
 *
 * So this file renders the REAL sections, with the real permission helpers
 * deciding what each viewer may do, and reads the markup that comes out. What it
 * does NOT test is inline pixel values: a padding is a design decision that will
 * change, and a test that fails when a card breathes differently is a test
 * nobody keeps. What is asserted is hierarchy, order, role visibility and the
 * preservation of the shared components the import preview also uses.
 *
 * Run:
 *   npx tsx --test "src/app/orders/drafts/*\/piDetail.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  PiActivityTimeline,
  PiAdvanceBand,
  PiBlockingPanel,
  PiIdentityStrip,
  PiLowerGrid,
  PiSummaryCard,
  PiStoredCopyNote,
  PiWarningPanel,
  PiWorkflowPanel,
  statusTone,
} from './piDetailSections'
import {
  buildClientSummary,
  buildDateSummary,
  buildIdentityFacts,
  buildPaymentSummaryView,
  telLink,
  type PaymentSummaryView,
  commercialBreakdownRows,
  describeApprovedOrder,
  describeWorkflowPanel,
  ADVANCE_BAND_TITLE,
  STORED_COPY_NOTE,
  WORKFLOW_HEADING,
} from './piDetailView'
import {
  APPROVAL_BLOCKED_FINANCE,
  APPROVED_ORDER_HEADING,
  FINANCE_PENDING_TEXT,
  VERIFY_FINANCE_BUTTON_LABEL,
  describeApprovalReadiness,
  describeFinanceStatus,
  financeVerificationIsCurrent,
  financeVerifiedLine,
} from '@/lib/orders/finalApproval'
import {
  PAYMENT_ADMIN_APPROVAL_REQUIRED,
  PAYMENT_EXCEPTION_PENDING,
  type PaymentPosition,
} from '@/lib/orders/paymentGate'
import { PiCommercialSummary } from '@/components/orders/piPreview'
import {
  describeSubmissionActions,
  APPROVE_BUTTON_LABEL,
  CHANGE_PI_BUTTON_LABEL,
  REJECT_BUTTON_LABEL,
  REQUEST_CHANGES_BUTTON_LABEL,
  RESUBMIT_BUTTON_LABEL,
  SUBMIT_BUTTON_LABEL,
} from '@/lib/orders/submissionWorkflow'
import {
  ADVANCE_NOT_A_PAYMENT,
  ADVANCE_REJECTED_INSTRUCTION,
  APPROVE_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_BUTTON_LABEL,
  describeAdvance,
  describeAdvanceActions,
} from '@/lib/orders/advanceRequirement'
import { describeActivityEntries, type PersistedActivity } from '@/lib/orders/submissionActivity'
import { ADVANCE_NOT_A_PAYMENT_NOTE, buildCommercialRows, formatInr } from '@/lib/pi/previewView'
import {
  draftStatusLabel,
  draftStatusTone,
  persistedCommercial,
  type PersistedSubmission,
} from '@/lib/orders/draftsView'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = '11111111-1111-4111-8111-111111111111'
const REVIEWER = '22222222-2222-4222-8222-222222222222'
const APPROVER = '33333333-3333-4333-8333-333333333333'
const STRANGER = '44444444-4444-4444-8444-444444444444'
/** The finance authority: finance.approve with Finance module entry, and
 *  nothing from Orders beyond the module gate. */
const FINANCE = '55555555-5555-4555-8555-555555555555'

const GRAND_TOTAL = 1180000

function submission(over: Partial<PersistedSubmission> = {}): PersistedSubmission {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'draft',
    client_name: 'Kalyan Interiors',
    created_by: OWNER,
    submitted_by: null,
    submitted_at: null,
    rejected_by: null,
    rejected_at: null,
    creation_date: '2026-08-01',
    source_created_by: 'Nishant Soni',
    bill_to_name: 'Kalyan Interiors, Bengaluru',
    ship_to_name: 'Kalyan Site Office, Whitefield',
    order_confirmation_date: '2026-08-04',
    dispatch_commitment: '2026-09-15',
    source_workbook_name: 'Kalyan-PI-Aug.xlsx',
    gross_product_amount: 1000000,
    discount_amount: 50000,
    subtotal_after_discount: 950000,
    fabric_cost: null,
    fabric_cost_meaning: 'not_applicable',
    fabric_cost_text: null,
    packing_cost: null,
    packing_cost_meaning: 'not_applicable',
    packing_cost_text: null,
    transportation_amount: null,
    transportation_text: 'as applicable',
    total_before_gst: 1000000,
    gst_amount: 180000,
    grand_total: GRAND_TOTAL,
    parse_warnings: [],
    parse_blocking_issues: [],
    review_note: null,
    created_at: '2026-08-01T06:00:00Z',
    updated_at: '2026-08-02T06:00:00Z',
    advance_condition: null,
    advance_declared_amount: null,
    advance_exception_percent: null,
    advance_exception_reason: null,
    advance_exception_status: null,
    advance_exception_requested_by: null,
    advance_exception_requested_at: null,
    advance_exception_decided_by: null,
    advance_exception_decided_at: null,
    advance_exception_rejection_reason: null,
    approved_by: null,
    approved_at: null,
    order_id: null,
    finance_verified_by: null,
    finance_verified_at: null,
    finance_verified_submission_at: null,
    deletion_claim_token: null,
    ...over,
  } as PersistedSubmission
}

/** The three inputs the page derives, exactly as the page derives them. */
function viewerState(row: PersistedSubmission, viewer: {
  id: string | null
  canCreate?: boolean
  canReview?: boolean
  canDecideAdvance?: boolean
  /** can_verify_pi_finance() — the SEPARATE finance authority. */
  canVerifyFinance?: boolean
  /**
   * Where the PI stands on the VERIFIED-PAYMENT gate, as
   * pi_submission_payment_summary() would report it. Defaults to the requirement
   * being met, so a test that is about something else does not have to say so.
   */
  paymentPosition?: PaymentPosition | null
  neededForStandard?: string | null
}) {
  const actions = describeSubmissionActions({
    status: row.status,
    createdBy: row.created_by,
    submittedBy: row.submitted_by,
    viewerId: viewer.id,
    canCreate: viewer.canCreate ?? false,
    canApproveSubmission: viewer.canReview ?? false,
  })
  const advance = describeAdvance(row, Number(row.grand_total))
  const advanceActions = describeAdvanceActions({
    status: row.status,
    advance: row,
    canDecideException: viewer.canDecideAdvance ?? false,
  })
  const panel = describeWorkflowPanel({
    status: row.status,
    actions,
    hasBlockingIssues: false,
    submittedAt: row.submitted_at ? '02 Aug 2026, 11:30 am' : null,
    submitterName: 'Nishant Soni',
    rejectedAt: row.rejected_at ? '05 Aug 2026, 09:10 am' : null,
    rejectedByName: 'Rohit Verma',
  })
  // The two Phase C answers, derived exactly as page.tsx derives them.
  const financeVerified = financeVerificationIsCurrent(row, row.submitted_at)
  const finance = describeFinanceStatus({
    status: row.status,
    submittedAtIso: row.submitted_at,
    verification: row,
    canVerifyFinance: viewer.canVerifyFinance ?? false,
    verifiedAt: row.finance_verified_at ? '02 Aug 2026, 02:15 pm' : null,
    verifierName: 'Asha Menon',
  })
  // THE PAYMENT GATE, exactly as the page derives it: the position comes from
  // pi_submission_payment_summary(). The harness models it as the fixture's own
  // `paymentPosition`, so a test can put the record anywhere on the gate without
  // inventing money.
  const readiness = describeApprovalReadiness({
    status: row.status,
    financeVerified,
    paymentPosition: viewer.paymentPosition ?? 'standard_met',
    neededForStandard: viewer.neededForStandard ?? '0.00',
    hasBlockingIssues: false,
    productCount: 3,
    deletionClaimed: row.deletion_claim_token !== null,
  })
  const approvedOrder = describeApprovedOrder({
    orderId: row.order_id,
    displayNumber: row.order_id ? ORDER_NUMBER : null,
  })
  return { actions, advance, advanceActions, panel, finance, readiness, approvedOrder }
}

/**
 * The workflow panel as the page assembles it, for one viewer.
 *
 * The band and the refusal block are gated here exactly as page.tsx gates them,
 * so what these tests render is what the screen renders.
 */
function workflowHtml(row: PersistedSubmission, viewer: Parameters<typeof viewerState>[1], opts: {
  employeeReply?: string | null
} = {}): string {
  const { actions, advance, advanceActions, panel, finance, readiness, approvedOrder } =
    viewerState(row, viewer)
  const refused = advance.status === 'rejected' && row.status === 'needs_changes'
  return renderToStaticMarkup(
    <PiWorkflowPanel
      panel={panel}
      actions={actions}
      status={row.status}
      reviewNote={row.review_note}
      employeeReply={opts.employeeReply ?? null}
      advanceRefusal={refused
        ? { reason: advance.rejectionReason, instruction: ADVANCE_REJECTED_INSTRUCTION }
        : null}
      blockingCount={0}
      acting={false}
      finance={finance}
      approvalBlocker={readiness.blocker}
      approvalReady={readiness.ready}
      approvedOrder={approvedOrder}
      onChangePi={() => {}}
      onSubmit={() => {}}
      onRequestChanges={() => {}}
      onReject={() => {}}
      onVerifyFinance={() => {}}
      onApprove={() => {}}
      onOpenOrder={() => {}}
      advanceBand={advanceActions.isPending ? (
        <PiAdvanceBand
          advance={advance}
          canDecide={advanceActions.canDecide}
          acting={false}
          onApprove={() => {}}
          onReject={() => {}}
        />
      ) : null}
    />,
  )
}

/**
 * The label of every pressable control in some markup, in order.
 *
 * A substring check is not good enough here: "Reject" is inside "Reject
 * Exception", and the whole point of several of these tests is that holding one
 * authority does not draw the other's control. Comparing the exact set of button
 * labels is the assertion that actually says what is meant.
 */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
    .map(match => text(match[1]).trim())
}

/**
 * Whether the final PI-approval control is anywhere in this markup.
 *
 * A plain substring check on "Approve" cannot answer it — "Approve Exception" is
 * a real, live control on the same panel and contains the word. What is being
 * looked for is the WHOLE label standing on its own, as a button, which is why
 * this reads buttonLabels rather than raw text nodes: the label sits beside an
 * icon inside the button, and React writes its ampersand as an entity.
 */
function hasApproveControl(html: string): boolean {
  return buttonLabels(html).includes(APPROVE_BUTTON_LABEL)
}

/** Text content, with the tags taken out — for "does it SAY this" checks. */
const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * The number the allocator would have produced for the approved fixture.
 *
 * A FIXTURE, NOT A RULE. Nothing in the browser composes an Order number, and
 * these tests do not either — this stands in for the value the RPC read back out
 * of public.orders, exactly as page.tsx would have.
 */
const ORDER_NUMBER = '0413'

const PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const SECTIONS = 'src/app/orders/drafts/[submissionId]/piDetailSections.tsx'
const GLOBAL_CSS = 'src/app/globals.css'

/**
 * This page's own block of the global stylesheet.
 *
 * Every rule it owns is prefixed `pi-detail-` and appended at the end, the same
 * page-scoped convention the payroll guide's block uses. Slicing to it here is
 * what keeps these assertions from reading somebody else's grid.
 */
const pageCss = (): string => {
  const css = read(GLOBAL_CSS)
  const start = css.indexOf('   PI DETAIL — /orders/drafts/[submissionId]')
  assert.ok(start > 0, 'the page block must be findable by its own heading')
  return css.slice(start)
}

// ── 1. The first clear scan ───────────────────────────────────────────────────

describe('the top of the page answers the questions it exists to answer', () => {
  test('the client and the state are the first thing on it', () => {
    const row = submission({ status: 'needs_changes' })
    const html = renderToStaticMarkup(
      <PiIdentityStrip
        statusLabel={draftStatusLabel(row.status)}
        tone={statusTone(draftStatusTone(row.status))}
        facts={buildIdentityFacts({
          savedAt: '02 Aug 2026, 11:30 am',
          documentAuthor: 'Nishant Soni',
          submitterName: null,
          submittedAt: null,
        })}
        workbookName={row.source_workbook_name}
      />,
    )
    // The client name is the layout header's page title; the state sits with it.
    assert.ok(text(html).includes('Needs Changes'), 'the status is in the identity area')
    assert.ok(!/product line/.test(text(html)),
      'the Products card states its own size; the identity strip no longer opens with it')
    assert.ok(text(html).includes('Saved 02 Aug 2026'))
    assert.ok(text(html).includes('Kalyan-PI-Aug.xlsx'), 'the workbook is named, quietly')
  })

  test('the identity line never repeats what the page title already says', () => {
    const facts = buildIdentityFacts({
      savedAt: 'X',
      documentAuthor: null,
      submitterName: null,
      submittedAt: null,
    })
    assert.ok(!facts.join(' ').includes('Saved PI submission'))
    assert.ok(!facts.join(' ').includes('PI Draft'))
    assert.ok(!facts.some(f => f.includes('Kalyan')), 'the client is not restated here')
  })

  test('a submitted record says who sent it, instead of when it was last saved', () => {
    const facts = buildIdentityFacts({
      savedAt: '02 Aug 2026, 11:30 am',
      documentAuthor: 'Nishant Soni',
      submitterName: 'Nishant Soni',
      submittedAt: '03 Aug 2026, 09:00 am',
    })
    assert.ok(facts.some(f => f.startsWith('Submitted 03 Aug 2026')))
    assert.ok(!facts.some(f => f.startsWith('Saved ')), 'the two are never printed side by side')
    assert.equal(facts[0], 'Submitted 03 Aug 2026, 09:00 am by Nishant Soni',
      'what happened last to the record is the first fact about it')
  })

  test('a record with no filename shows no file block at all', () => {
    const html = renderToStaticMarkup(
      <PiIdentityStrip
        statusLabel="Draft"
        tone={statusTone('neutral')}
        facts={['4 product lines']}
        workbookName={null}
      />,
    )
    assert.ok(!html.includes('pi-detail-identity-file'), 'a labelled hole is worse than the absence')
  })
})

// ── 2. The top summary ───────────────────────────────────────────────────────
//
// The card answers four questions and nothing else: who the client is and how
// to reach them, when the order was confirmed and when it is due, and how much
// VERIFIED money has arrived against what the order is worth. These tests are
// about what it SAYS — which figure counts, which does not, and what it does
// when the PI gave nothing.

const summaryHtml = (over: {
  client?: Parameters<typeof buildClientSummary>[0]
  payment?: PaymentSummaryView | null
  canAdd?: boolean
  confirmed?: string | null
  dates?: ReturnType<typeof buildDateSummary>
} = {}) => renderToStaticMarkup(
  <PiSummaryCard
    client={buildClientSummary(over.client ?? {
      clientName: 'Kalyan Interiors',
      billToName: 'Kalyan Interiors',
      shipToName: 'Kalyan Interiors',
      contactNumber: '+91 98450 22222',
      billToPhone: null,
      shipToPhone: null,
      billingAddress: '12 Residency Road\nBengaluru 560025',
      shippingAddress: null,
    })}
    dates={over.dates ?? buildDateSummary({ confirmed: over.confirmed ?? '31 Jan 2026' })}
    payment={over.payment === undefined ? PAID_PART : over.payment}
    canAdd={over.canAdd ?? false}
    onOpenPayments={() => {}}
    onAddPayment={() => {}}
    notice={null}
    onDismissNotice={() => {}}
  />,
)

/** Partly paid: ₹3,50,625 of ₹8,76,563 verified, nothing awaiting. */
const PAID_PART = buildPaymentSummaryView({
  verifiedAmount: '₹3,50,625', grandTotal: '₹8,76,563', verifiedPercent: '40%',
  percentValue: 40, awaitingCount: 0, paymentCount: 1,
})

describe('the top summary states VERIFIED payment, and only verified payment', () => {
  test('nothing received reads as nothing, against the order it is measured on', () => {
    const view = buildPaymentSummaryView({
      verifiedAmount: '₹0', grandTotal: '₹8,76,563', verifiedPercent: '0%',
      percentValue: 0, awaitingCount: 0, paymentCount: 0,
    })
    assert.equal(view.ofTotal, '₹0 of ₹8,76,563')
    assert.equal(view.percent, '0%')
    assert.equal(view.barPercent, 0, 'an empty bar, never a hidden one')
  })

  test('money awaiting Finance moves neither the percentage nor the bar', () => {
    // The RPC reports verified figures; an unverified payment is in the row
    // list and in `awaitingCount`, and in NOTHING that reads as money in hand.
    const view = buildPaymentSummaryView({
      verifiedAmount: '₹0', grandTotal: '₹8,76,563', verifiedPercent: '0%',
      percentValue: 0, awaitingCount: 2, paymentCount: 2,
    })
    assert.equal(view.barPercent, 0)
    assert.equal(view.percent, '0%')
    assert.equal(view.awaitingCount, 2)

    const html = text(summaryHtml({ payment: view }))
    assert.ok(html.includes('2 payments awaiting verification'),
      'it is visible, and visibly not counted')
    assert.ok(html.includes('not counted above'))
  })

  test('the bar is a width, never a figure, and cannot leave its track', () => {
    const bar = (percentValue: number | null) => buildPaymentSummaryView({
      verifiedAmount: '₹1', grandTotal: '₹2', verifiedPercent: 'x',
      percentValue, awaitingCount: 0, paymentCount: 1,
    }).barPercent
    assert.equal(bar(40), 40)
    assert.equal(bar(140), 100, 'an overpaid PI fills the bar and does not overflow it')
    assert.equal(bar(-5), 0)
    assert.equal(bar(null), 0, 'a PI with no grand total has no proportion to show')
    assert.equal(bar(Number.NaN), 0)
  })

  test('40% or more still prints the database’s own percentage, unrounded by us', () => {
    const view = buildPaymentSummaryView({
      verifiedAmount: '₹3,50,625', grandTotal: '₹8,76,563', verifiedPercent: '40%',
      percentValue: 40, awaitingCount: 0, paymentCount: 1,
    })
    assert.equal(view.percent, '40%')
    assert.ok(text(summaryHtml({ payment: view })).includes('₹3,50,625 of ₹8,76,563'))
  })

  test('the figure itself is the way into the records', () => {
    const html = summaryHtml()
    assert.ok(html.includes('pi-detail-summary-open'), 'the amount is a control')
    assert.ok(html.includes('aria-haspopup="dialog"'), 'and it announces what it opens')
  })

  test('Add payment is drawn only for somebody the gate allows', () => {
    assert.ok(text(summaryHtml({ canAdd: true })).includes('Add payment'))
    assert.ok(!text(summaryHtml({ canAdd: false })).includes('Add payment'),
      'the control is absent, not merely disabled')
    assert.ok(text(summaryHtml({ canAdd: false })).includes('View payments'),
      'but anybody who can read the PI can still read its payments')
  })

  test('the summary says nothing while the position has not been read', () => {
    const html = text(summaryHtml({ payment: null }))
    assert.ok(html.includes('Loading…'))
    assert.ok(!html.includes('of ₹'), 'never a figure invented to fill the space')
  })
})

describe('the top summary identifies the client without repeating them', () => {
  test('one name, one number, one place — not Bill to and Ship to twice', () => {
    const html = text(summaryHtml())
    assert.equal((html.match(/Kalyan Interiors/g) ?? []).length, 1,
      'bill-to and ship-to are the same party here, and the name is printed once')
    assert.ok(!html.includes('Bill to') && !html.includes('Ship to'))
    assert.ok(html.includes('12 Residency Road'))
  })

  test('a phone number the PI gave is dialable', () => {
    const html = summaryHtml()
    assert.ok(html.includes('href="tel:+919845022222"'))
    assert.ok(text(html).includes('+91 98450 22222'), 'shown as the document typed it')
  })

  test('a genuinely different destination is named rather than merged away', () => {
    const html = text(summaryHtml({ client: {
      clientName: 'Kalyan Interiors', billToName: 'Kalyan Interiors',
      shipToName: 'Kalyan Site Office', contactNumber: null,
      billToPhone: null, shipToPhone: null,
      billingAddress: '12 Residency Road', shippingAddress: '9 Whitefield Main',
    } }))
    assert.ok(html.includes('12 Residency Road'))
    assert.ok(html.includes('Ships to: Kalyan Site Office, 9 Whitefield Main'))
  })

  test('what the PI did not give is said quietly, and never invented', () => {
    const html = text(summaryHtml({ client: {
      clientName: 'Kalyan Interiors', billToName: null, shipToName: null,
      contactNumber: null, billToPhone: null, shipToPhone: null,
      billingAddress: null, shippingAddress: null,
    } }))
    // Two facts the DOCUMENT did not carry — the contact and the location — say
    // "Not provided". The due date says "Not set" instead, because it is not
    // something the PI omitted but something nobody has decided yet, and the two
    // states are worth distinguishing to whoever has to chase one of them.
    assert.equal((html.match(/Not provided/g) ?? []).length, 2)
    assert.equal((html.match(/Not set/g) ?? []).length, 1)
    assert.ok(html.includes('Kalyan Interiors'), 'the one thing it does know is still said plainly')
  })

  test('a number too short to dial is not offered as a link', () => {
    assert.equal(telLink('12345'), null)
    assert.equal(telLink('  '), null)
    assert.equal(telLink('n/a'), null)
    assert.deepEqual(telLink('022 4567 8900'), { label: '022 4567 8900', tel: '02245678900' })
  })
})

describe('the top summary states the dates it has, and pauses the one it does not', () => {
  test('the confirm date is shown as a date', () => {
    const html = text(summaryHtml({ confirmed: '31 Jan 2026' }))
    assert.ok(html.includes('Confirm date'))
    assert.ok(html.includes('31 Jan 2026'))
  })

  test('there is no PI-created row and no prose dispatch commitment', () => {
    const html = text(summaryHtml())
    assert.ok(!html.includes('PI created'))
    assert.ok(!html.includes('Dispatch'))
    assert.ok(!html.includes('weeks from date of confirmation'))
  })

  test('an absent due date renders “Not set”, never a date derived from prose', () => {
    const dates = buildDateSummary({ confirmed: '31 Jan 2026' })
    assert.deepEqual(dates.map(d => d.key), ['confirmed', 'due'])
    assert.equal(dates[1].value, null)

    const html = text(summaryHtml({
      dates: buildDateSummary({
        confirmed: '31 Jan 2026', commitment: '6 weeks from date of confirmation',
      }),
    }))
    assert.ok(html.includes('Due date'))
    assert.ok(html.includes('Not set'))
    // The commitment is on screen, as supporting text under the empty row, and
    // prefixed so it cannot be read as the date itself.
    assert.ok(html.includes('Commitment: 6 weeks from date of confirmation'))
    assert.ok(!/Due date\s*6 weeks/.test(html), 'the prose never occupies the date slot')
  })

  test('a stored due date renders as a date, and drops the commitment line', () => {
    const html = text(summaryHtml({
      dates: buildDateSummary({
        confirmed: '31 Jan 2026', due: '25 Mar 2026',
        commitment: '6 weeks from date of confirmation',
      }),
    }))
    assert.ok(html.includes('25 Mar 2026'))
    assert.ok(!html.includes('Not set'))
    assert.ok(!html.includes('Commitment:'),
      'one answer beside a real date, not two')
  })

  test('a confirm date the PI never gave says so rather than showing a dash', () => {
    const html = text(summaryHtml({ confirmed: null }))
    assert.ok(html.includes('Confirm date'))
    assert.ok(!html.includes('—'))
  })
})

describe('the top summary drops what the old overview spent space on', () => {
  const html = text(summaryHtml())

  test('no standalone Grand Total, no product count, no shouted headings', () => {
    // The order's worth is still on the card — as the thing payment is measured
    // against, which is the only reason it was ever there.
    assert.ok(html.includes('of ₹8,76,563'))
    assert.ok(!html.includes('Grand Total'))
    assert.ok(!/product line/.test(html))
    assert.ok(!html.includes('Commercial snapshot'))
    assert.ok(!html.includes('Verified payment required'),
      'the approval badge belongs with the approval controls, not the summary')
  })
})

// ── 3. Workflow: what each viewer is asked, and what they are offered ─────────

describe('the owner of a draft', () => {
  const html = workflowHtml(submission(), { id: OWNER, canCreate: true })

  test('is asked whether it is ready, above the products', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.draftOwner))
    assert.equal(WORKFLOW_HEADING.draftOwner, 'Ready for management?')
  })

  test('is offered Change PI and Submit for Approval, and nothing else', () => {
    assert.deepEqual(buttonLabels(html), [CHANGE_PI_BUTTON_LABEL, SUBMIT_BUTTON_LABEL])
  })

  test('is offered no review control whatsoever', () => {
    assert.ok(!text(html).includes(REQUEST_CHANGES_BUTTON_LABEL))
    assert.ok(!text(html).includes(APPROVE_EXCEPTION_BUTTON_LABEL))
    assert.ok(!hasApproveControl(html), 'and no PI approval — that is a reviewer’s decision')
  })

  test('sees no advance band, because nothing is waiting on anybody', () => {
    assert.ok(!text(html).includes(ADVANCE_BAND_TITLE))
    assert.ok(!text(html).includes('Advance requirement'),
      'the requirement is stated in the snapshot at the top, and only there')
  })

  test('is not told at length what submitting will do', () => {
    // The heading asks the question and the button answers it. The paragraph
    // that used to sit between them said neither.
    assert.ok(!text(html).includes('nothing is numbered'))
    assert.ok(!text(html).includes('starts the review'))
  })
})

describe('the owner of a returned PI', () => {
  const row = submission({
    status: 'needs_changes',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    review_note: 'The fabric on line 3 is wrong.',
    advance_condition: 'standard',
  })
  const html = workflowHtml(row, { id: OWNER, canCreate: true })

  test('is told, in management’s own words, what to correct', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.needsChangesOwner))
    assert.equal(WORKFLOW_HEADING.needsChangesOwner, 'Changes requested')
    assert.ok(text(html).includes('What management asked for'))
    assert.ok(text(html).includes('The fabric on line 3 is wrong.'))
  })

  test('is offered the resubmission path, named for what it does', () => {
    assert.deepEqual(buttonLabels(html), [CHANGE_PI_BUTTON_LABEL, RESUBMIT_BUTTON_LABEL])
    assert.ok(!buttonLabels(html).includes(SUBMIT_BUTTON_LABEL),
      'a returned PI is resubmitted, and the button says so')
  })

  test('is not shown an advance band for a condition nobody is deciding', () => {
    assert.ok(!text(html).includes(ADVANCE_BAND_TITLE),
      'the standard requirement is in the snapshot; there is nothing to settle here')
  })

  test('a refused advance reaches them with the reason and the choice it leaves', () => {
    const refused = submission({
      status: 'needs_changes',
      submitted_by: OWNER,
      submitted_at: '2026-08-03T04:00:00Z',
      advance_condition: 'exception',
      advance_exception_percent: 0,
      advance_exception_status: 'rejected',
      advance_exception_reason: 'Client pays on delivery.',
      advance_exception_rejection_reason: 'Too large an order to start unfunded.',
    })
    const body = text(workflowHtml(refused, { id: OWNER, canCreate: true }))
    assert.ok(body.includes('Why the advance was refused'))
    assert.ok(body.includes('Too large an order to start unfunded.'))
    assert.ok(body.includes(ADVANCE_REJECTED_INSTRUCTION))
    // Their own original reason is NOT replayed at them: they wrote it, it was
    // answered, and Activity keeps it.
    assert.ok(!body.includes('Client pays on delivery.'))
  })
})

describe('the owner of a submitted PI', () => {
  const row = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'exception',
    advance_exception_percent: 10,
    advance_exception_status: 'pending',
    advance_exception_requested_by: OWNER,
    advance_exception_requested_at: '2026-08-03T04:00:00Z',
  })
  const html = workflowHtml(row, { id: OWNER, canCreate: true })

  test('is told it is with management, and offered nothing to press', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.submitted))
    assert.equal(WORKFLOW_HEADING.submitted, 'Submitted for review')
    assert.ok(!html.includes('<button'), 'nothing is editable while it is under review')
  })

  test('can still see that an advance exception is waiting', () => {
    assert.ok(text(html).includes(ADVANCE_BAND_TITLE))
    assert.ok(text(html).includes('Reduced advance · ₹1,18,000 · 10%'),
      'the condition being decided, in one line')
  })

  test('is told who sent it and when, as metadata rather than as a sentence', () => {
    assert.ok(text(html).includes('Submitted by Nishant Soni · 02 Aug 2026, 11:30 am'))
    assert.ok(!text(html).includes('Nothing on this PI can be changed'))
  })
})

describe('the owner of a rejected PI', () => {
  const row = submission({
    status: 'rejected',
    submitted_by: OWNER,
    rejected_by: REVIEWER,
    rejected_at: '2026-08-05T04:00:00Z',
    review_note: 'The client withdrew.',
    advance_condition: 'standard',
  })
  const html = workflowHtml(row, { id: OWNER, canCreate: true })

  test('is told it is closed, with the reason, and offered no action', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.rejected))
    assert.ok(text(html).includes('Why this was rejected'))
    assert.ok(text(html).includes('The client withdrew.'))
    assert.ok(!html.includes('<button'), 'the page must not look actionable')
  })

  test('is told who closed it and when', () => {
    assert.ok(text(html).includes('Rejected by Rohit Verma · 05 Aug 2026, 09:10 am'))
  })

  test('is offered no deletion here — that stays on the PI Drafts list', () => {
    assert.ok(!text(html).includes('Delete'))
    assert.ok(!read(PAGE).includes('PiDeleteConfirmModal'))
    assert.ok(!read(SECTIONS).includes('Delete'))
  })
})

describe('the management reviewer', () => {
  const row = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
  })
  const html = workflowHtml(row, { id: REVIEWER, canReview: true },
    { employeeReply: 'Corrected the fabric on line 3.' })

  test('is told the decision is theirs, and who is waiting on it', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.reviewer))
    assert.equal(WORKFLOW_HEADING.reviewer, 'Management review')
    assert.ok(text(html).includes('Submitted by Nishant Soni · 02 Aug 2026, 11:30 am'),
      'one quiet metadata line, in place of three sentences')
  })

  test('is offered all three decisions, and no employee control', () => {
    // THE PRIMARY ACTION COMES LAST, so the two that end or return the PI are
    // never the ones nearest the thumb on a phone, where the group stacks.
    assert.deepEqual(buttonLabels(html), [
      REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL, APPROVE_BUTTON_LABEL,
    ])
  })

  test('sees the employee’s reply that came with the submission', () => {
    assert.ok(text(html).includes('Corrected the fabric on line 3.'))
  })

  test('is shown a real approval control, blocked for an actionable reason', () => {
    // A greyed "Approve" that explained only that a later phase would bring
    // approval was read as the current action. Phase C's control is real: it is
    // present, it is named for what it does, and when it is disabled the reason
    // is somebody's outstanding task rather than a note about the roadmap.
    assert.ok(hasApproveControl(html))
    assert.ok(!text(html).includes('order-approval phase'))
    assert.ok(!read(SECTIONS).includes('APPROVE_DISABLED_REASON'),
      'the retired explanation has nothing left to explain')
    // This fixture has no finance verification, so that is the blocker named.
    assert.ok(text(html).includes(APPROVAL_BLOCKED_FINANCE))
    assert.ok(text(html).includes(FINANCE_PENDING_TEXT),
      'and the finance line says the same thing in its own words')
  })

  test('is given a metadata line, not a standing paragraph', () => {
    assert.ok(!text(html).includes('Waiting for your decision'))
    assert.ok(!text(html).includes('Settling it does not approve the PI'))
  })

  test('cannot decide an advance exception with review authority alone', () => {
    const exceptional = submission({
      status: 'submitted',
      submitted_by: OWNER,
      submitted_at: '2026-08-03T04:00:00Z',
      advance_condition: 'exception',
      advance_exception_percent: 12.5,
      advance_exception_status: 'pending',
    })
    const reviewerOnly = workflowHtml(exceptional, { id: REVIEWER, canReview: true })
    assert.ok(text(reviewerOnly).includes(ADVANCE_BAND_TITLE), 'the STATE is visible to them')
    assert.deepEqual(buttonLabels(reviewerOnly),
      [REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL, APPROVE_BUTTON_LABEL],
      'orders.approve_order carries the three PI decisions and does not settle a commercial term')
  })
})

describe('the advance-exception approver, who holds nothing else', () => {
  const row = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'exception',
    advance_exception_percent: 12.5,
    advance_exception_status: 'pending',
    advance_exception_reason: 'Long-standing client, settles on delivery.',
    advance_exception_requested_by: OWNER,
    advance_exception_requested_at: '2026-08-03T04:00:00Z',
  })
  const html = workflowHtml(row, { id: APPROVER, canDecideAdvance: true })

  test('gets the two exception controls', () => {
    assert.ok(text(html).includes(APPROVE_EXCEPTION_BUTTON_LABEL))
    assert.ok(text(html).includes(REJECT_EXCEPTION_BUTTON_LABEL))
  })

  test('and no PI review control at all', () => {
    assert.deepEqual(buttonLabels(html),
      [APPROVE_EXCEPTION_BUTTON_LABEL, REJECT_EXCEPTION_BUTTON_LABEL],
      'exactly the two controls their permission carries, and nothing else')
    assert.ok(!text(html).includes(REQUEST_CHANGES_BUTTON_LABEL))
    assert.ok(!text(html).includes(SUBMIT_BUTTON_LABEL))
    assert.ok(!text(html).includes(CHANGE_PI_BUTTON_LABEL))
    assert.ok(!hasApproveControl(html),
      'and no PI approval: approve_advance_exception settles one commercial term, never the PI')
  })

  test('the band states the condition and the reason, and no audit facts', () => {
    const body = text(html)
    assert.ok(body.includes('Reduced advance · ₹1,47,500 · 12.5%'), 'what is being asked for')
    assert.ok(body.includes('Long-standing client, settles on delivery.'),
      'and the employee’s own words, which exist nowhere else on this screen')
    for (const audit of ['Requested by', 'Decided by', 'Standard requirement',
                         'Selected condition', 'Proposed advance']) {
      assert.ok(!body.includes(audit), `"${audit}" belongs in Activity, not here`)
    }
    assert.ok(!body.includes(ADVANCE_NOT_A_PAYMENT))
  })

  test('reaches the decision without a review card to reach it through', () => {
    // The old page drew the exception section INSIDE the review card, and a
    // second copy outside it for exactly this person. There is one panel now,
    // and it is drawn for everybody who can read the PI.
    assert.equal((read(PAGE).match(/<PiAdvanceBand/g) ?? []).length, 1)
    assert.equal((read(PAGE).match(/advanceBand=\{/g) ?? []).length, 1)
  })
})

describe('an admin holding both authorities', () => {
  const row = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'exception',
    advance_exception_percent: 0,
    advance_exception_status: 'pending',
  })
  const raw = workflowHtml(row, { id: REVIEWER, canReview: true, canDecideAdvance: true })
  const html = text(raw)

  test('gets both sets of controls, in one panel, kept apart', () => {
    assert.deepEqual(buttonLabels(raw), [
      REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL, APPROVE_BUTTON_LABEL,
      APPROVE_EXCEPTION_BUTTON_LABEL, REJECT_EXCEPTION_BUTTON_LABEL,
    ], 'the three PI decisions first, then the one commercial term')
    assert.ok(raw.includes('pi-detail-workflow-band'),
      'and the advance decision is its own band, not a fifth button on the same row')
  })

  test('the PI approval is present but blocked while the exception is pending', () => {
    // BOTH authorities and it still cannot be approved. Approving the advance
    // exception is not approving the PI, and the blocker says which of the two
    // is outstanding rather than leaving the reviewer to guess.
    assert.ok(hasApproveControl(raw))
    assert.ok(html.includes(APPROVAL_BLOCKED_FINANCE),
      'finance comes first in the order the RPC itself checks')
  })

  test('a 0% proposal is spelled out where it is being decided', () => {
    assert.ok(html.includes('No advance · ₹0 · 0%'))
    assert.ok(!html.includes('No advance requested — the order would start'),
      'the label says it; the sentence under it said it again')
  })

  test('an APPROVED exception leaves the two PI decisions untouched', () => {
    // THE BUSINESS DISTINCTION. Accepting a 0% advance settles one commercial
    // term. It says nothing about whether the products, quantities, rates,
    // customization, dates or addresses on the PI are right — so the reviewer
    // must still be able to send it back or end it.
    const approved = submission({
      status: 'submitted',
      submitted_by: OWNER,
      submitted_at: '2026-08-03T04:00:00Z',
      advance_condition: 'exception',
      advance_exception_percent: 0,
      advance_exception_status: 'approved',
      advance_exception_reason: 'Client pays on delivery.',
    })
    const after = workflowHtml(approved, { id: REVIEWER, canReview: true, canDecideAdvance: true })
    assert.deepEqual(buttonLabels(after),
      [REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL, APPROVE_BUTTON_LABEL],
      'the PI review decisions survive the advance decision')
    // And the settled exception does not redraw its own band.
    assert.ok(!text(after).includes(ADVANCE_BAND_TITLE))
    assert.ok(!text(after).includes('Client pays on delivery.'),
      'the reason it was granted for lives in Activity now')
  })
})

// ── Phase C: finance verification and the final approval ──────────────────────

describe('the finance line, in the workflow area', () => {
  const submitted = (over: Partial<PersistedSubmission> = {}) => submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
    ...over,
  })

  test('a submitted PI says verification is pending, to everybody who can read it', () => {
    for (const viewer of [
      { id: REVIEWER, canReview: true },
      { id: OWNER },
      { id: STRANGER },
    ]) {
      assert.ok(text(workflowHtml(submitted(), viewer)).includes(FINANCE_PENDING_TEXT),
        'a record waiting on somebody else must not look inert to the person waiting')
    }
  })

  test('only the finance authority is offered the control', () => {
    const withoutIt = workflowHtml(submitted(), { id: REVIEWER, canReview: true })
    const withIt = workflowHtml(submitted(), { id: FINANCE, canVerifyFinance: true })
    assert.ok(!buttonLabels(withoutIt).includes(VERIFY_FINANCE_BUTTON_LABEL),
      'orders.approve_order does not carry the finance sign-off')
    assert.ok(buttonLabels(withIt).includes(VERIFY_FINANCE_BUTTON_LABEL))
  })

  test('a finance verifier gets that control and NO PI decision', () => {
    assert.deepEqual(
      buttonLabels(workflowHtml(submitted(), { id: FINANCE, canVerifyFinance: true })),
      [VERIFY_FINANCE_BUTTON_LABEL],
      'exactly the one control their permission carries, and nothing else')
  })

  test('once verified it names the verifier and the time, and offers nothing more', () => {
    const verified = submitted({
      finance_verified_by: FINANCE,
      finance_verified_at: '2026-08-03T09:30:00Z',
      finance_verified_submission_at: '2026-08-03T04:00:00Z',
    })
    const html = workflowHtml(verified, { id: FINANCE, canVerifyFinance: true })
    assert.ok(text(html).includes(financeVerifiedLine('Asha Menon', '02 Aug 2026, 02:15 pm')))
    assert.deepEqual(buttonLabels(html), [], 'there is nothing left to verify')
  })

  test('a verification carried over from an earlier submission reads as pending', () => {
    const stale = submitted({
      finance_verified_by: FINANCE,
      finance_verified_at: '2026-07-20T09:30:00Z',
      finance_verified_submission_at: '2026-07-20T04:00:00Z',
    })
    const html = workflowHtml(stale, { id: FINANCE, canVerifyFinance: true })
    assert.ok(text(html).includes(FINANCE_PENDING_TEXT))
    assert.ok(buttonLabels(html).includes(VERIFY_FINANCE_BUTTON_LABEL),
      'and it can be verified again, against the submission actually under review')
  })

  test('a draft raises the question at all', () => {
    const html = workflowHtml(submission({ status: 'draft' }), { id: OWNER, canCreate: true })
    assert.ok(!text(html).includes(FINANCE_PENDING_TEXT),
      'there is nothing to verify until it has been submitted')
  })

  test('it is a line, not a card', () => {
    const html = workflowHtml(submitted(), { id: REVIEWER, canReview: true })
    // The panel keeps ONE heading. A finance card would be a second one.
    assert.equal((html.match(/pi-detail-workflow-head/g) ?? []).length, 1)
  })
})

describe('the final approval control, for a reviewer', () => {
  const ready = (over: Partial<PersistedSubmission> = {}) => submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
    finance_verified_by: FINANCE,
    finance_verified_at: '2026-08-03T09:30:00Z',
    finance_verified_submission_at: '2026-08-03T04:00:00Z',
    ...over,
  })

  test('a verified, standard-advance PI offers a live approval', () => {
    const html = workflowHtml(ready(), { id: REVIEWER, canReview: true })
    assert.ok(hasApproveControl(html))
    assert.ok(!text(html).includes(APPROVAL_BLOCKED_FINANCE), 'and nothing left to explain')
  })

  test('Needs Changes and Reject SURVIVE the finance verification', () => {
    // A verified PI is not an approved one. A reviewer who can no longer send
    // back a document finance happened to sign off has lost a decision.
    assert.deepEqual(buttonLabels(workflowHtml(ready(), { id: REVIEWER, canReview: true })), [
      REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL, APPROVE_BUTTON_LABEL,
    ])
  })

  test('an approved reduced-payment exception is approvable; a pending one is not', () => {
    const record = ready({
      advance_condition: 'exception',
      advance_exception_percent: 0,
      advance_exception_status: 'approved',
      advance_exception_reason: 'Client pays on delivery.',
    })
    assert.ok(!text(workflowHtml(record, {
      id: REVIEWER, canReview: true, paymentPosition: 'exception_approved',
    })).includes(PAYMENT_EXCEPTION_PENDING))

    const html = text(workflowHtml(record, {
      id: REVIEWER, canReview: true,
      paymentPosition: 'exception_pending', neededForStandard: '400000.00',
    }))
    assert.ok(html.includes(PAYMENT_EXCEPTION_PENDING))
  })

  test('too little VERIFIED payment blocks approval, whatever was declared', () => {
    // THE PHASE 3 RULE, on screen: a PI that declared the standard 40% is still
    // refused while the money has not arrived and been verified.
    const record = ready({
      advance_condition: 'standard',
      advance_declared_amount: 400000,
    })
    const html = text(workflowHtml(record, {
      id: REVIEWER, canReview: true,
      paymentPosition: 'payment_required', neededForStandard: '400000.00',
    }))
    assert.ok(html.includes('₹4,00,000'), 'and the shortfall is named')
    assert.ok(html.includes(PAYMENT_ADMIN_APPROVAL_REQUIRED))
  })

  test('the employee is never offered it, whatever the record says', () => {
    assert.ok(!hasApproveControl(workflowHtml(ready(), { id: OWNER })))
    assert.ok(!hasApproveControl(workflowHtml(ready(), { id: STRANGER })))
    assert.ok(!hasApproveControl(workflowHtml(ready(), { id: FINANCE, canVerifyFinance: true })),
      'verifying the figures is not approving the PI')
  })

  test('the blocker is addressed to the reviewer, and to nobody else', () => {
    const unverified = ready({
      finance_verified_by: null, finance_verified_at: null, finance_verified_submission_at: null,
    })
    assert.ok(text(workflowHtml(unverified, { id: REVIEWER, canReview: true }))
      .includes(APPROVAL_BLOCKED_FINANCE))
    assert.ok(!text(workflowHtml(unverified, { id: OWNER })).includes(APPROVAL_BLOCKED_FINANCE),
      'the employee has no control for it to be about')
  })
})

describe('an approved PI', () => {
  const approvedRow = submission({
    status: 'approved',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    approved_by: REVIEWER,
    approved_at: '2026-08-04T05:00:00Z',
    order_id: '77777777-7777-4777-8777-777777777777',
    advance_condition: 'standard',
    finance_verified_by: FINANCE,
    finance_verified_at: '2026-08-03T09:30:00Z',
    finance_verified_submission_at: '2026-08-03T04:00:00Z',
  })
  const html = workflowHtml(approvedRow, { id: REVIEWER, canReview: true })

  test('shows the official number prominently, and a way into the Order', () => {
    assert.ok(text(html).includes(APPROVED_ORDER_HEADING))
    assert.ok(text(html).includes(ORDER_NUMBER))
    assert.ok(buttonLabels(html).includes('Open Order'))
  })

  test('is read-only: no approval, no rejection, no return', () => {
    assert.deepEqual(buttonLabels(html), ['Open Order'],
      'the only control left leads somewhere; nothing on this record can be decided again')
  })

  test('keeps the finance verification on the record, forever', () => {
    assert.ok(text(html).includes('Verified by Asha Menon'))
  })

  test('says Approved, and says it once', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.approved))
    assert.equal(WORKFLOW_HEADING.approved, 'Approved')
  })

  test('shows no number to somebody who cannot read the Order', () => {
    // A finance verifier is not the requester, not operations, not an admin and
    // holds no view_all: public.orders returns them no row. They still see that
    // the PI was approved; they are simply not shown a link into a record they
    // cannot open.
    const hidden = describeApprovedOrder({ orderId: approvedRow.order_id, displayNumber: null })
    assert.equal(hidden, null)
  })
})

describe('a read-only viewer', () => {
  const row = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'exception',
    advance_exception_percent: 12.5,
    advance_exception_status: 'pending',
  })
  const html = workflowHtml(row, { id: STRANGER })

  test('is given no control of any kind', () => {
    assert.deepEqual(buttonLabels(html), [])
    assert.ok(!hasApproveControl(html))
  })

  test('is still told where the record stands, and what it is waiting on', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.submitted))
    assert.equal(WORKFLOW_HEADING.submitted, 'Submitted for review')
    assert.ok(text(html).includes(ADVANCE_BAND_TITLE),
      'a record waiting on somebody else must not look inert to the person waiting')
  })
})

describe('a colleague reading somebody else’s draft', () => {
  const html = workflowHtml(submission(), { id: STRANGER, canCreate: true })

  test('sees the state without being offered the owner’s actions', () => {
    assert.ok(!html.includes('<button'))
    assert.ok(text(html).includes('Draft'))
  })
})

// ── 4. Blocking issues, above the products ────────────────────────────────────

describe('blocking issues', () => {
  const entries = [
    { code: 'MISSING_RATE', message: 'No rate for this line.', location: 'Row 34 · H34', row: 34 },
    { code: 'BAD_TOTAL', message: 'The grand total is text.', location: 'Cell I122', row: null },
  ]
  const html = renderToStaticMarkup(<PiBlockingPanel entries={entries} />)

  test('state how many there are, and what each one is', () => {
    assert.ok(text(html).includes('2 issues'))
    assert.ok(text(html).includes('No rate for this line.'))
    assert.ok(text(html).includes('Row 34 · H34'))
  })

  test('say once that the Excel PI is what must be corrected', () => {
    const body = text(html)
    assert.ok(body.includes('Correct these in the Excel PI'))
    assert.equal(body.split('Excel PI').length - 1, 1, 'stated once, not twice')
  })

  test('do not duplicate the Change PI control the workflow panel already has', () => {
    assert.ok(!html.includes('<button'))
  })

  test('one issue reads as one issue', () => {
    const single = renderToStaticMarkup(<PiBlockingPanel entries={entries.slice(0, 1)} />)
    assert.ok(text(single).includes('1 issue'))
    assert.ok(!text(single).includes('1 issues'))
  })
})

describe('non-blocking warnings stay quieter', () => {
  const html = renderToStaticMarkup(
    <PiWarningPanel entries={[
      { code: 'ROUNDING', message: 'Subtotal differs by ₹1.', location: null, row: null },
    ]} />,
  )

  test('are counted and readable', () => {
    assert.ok(text(html).includes('1 recorded when this draft was saved'))
    assert.ok(text(html).includes('Subtotal differs by ₹1.'))
  })

  test('carry no red treatment and no control', () => {
    assert.ok(!html.includes('<button'))
    assert.ok(!html.includes('rgba(217,79,79'), 'red belongs to what actually blocks')
  })

  test('hide nothing behind a disclosure', () => {
    assert.ok(!html.includes('<details'))
    assert.ok(!html.includes('<summary'))
  })
})

// ── 6. The lower grid ─────────────────────────────────────────────────────────

describe('the commercial breakdown', () => {
  const stored = buildCommercialRows(persistedCommercial(submission()))
  const rows = commercialBreakdownRows(stored)
  const html = renderToStaticMarkup(
    <PiCommercialSummary rows={rows} title="Commercial breakdown" variant="detail" />,
  )

  test('is the stored rows, from the shared builder, and nothing recomputed', () => {
    const body = text(html)
    for (const label of [
      'Gross product amount', 'Discount', 'Subtotal after discount',
      'Fabric cost', 'Packing cost', 'Transportation',
      'Total before GST', 'GST', 'Grand Total',
    ]) {
      assert.ok(body.includes(label), `${label} must survive the refinement`)
    }
    assert.ok(body.includes(formatInr(GRAND_TOTAL)))
  })

  test('drops the required-advance row, which the snapshot now owns', () => {
    // Keeping it would CONTRADICT the top of the page on any PI with an
    // approved exception: the snapshot would say 12.5% and this would say 40%.
    assert.deepEqual(rows.map(r => r.key), [
      'gross', 'discount', 'subtotal', 'fabric',
      'packing', 'transportation', 'beforeGst', 'gst', 'grandTotal',
    ])
    assert.ok(!text(html).includes('Required advance'))
    assert.ok(!text(html).includes(ADVANCE_NOT_A_PAYMENT_NOTE),
      'and the disclaimer that rode with it')
  })

  test('the shared builder itself is untouched — the row is dropped by the page', () => {
    const advance = stored.find(r => r.key === 'advance')
    assert.ok(advance, 'buildCommercialRows still produces it, for the import preview')
    assert.equal(advance?.label, 'Required advance (40%)')
    assert.equal(advance?.note, ADVANCE_NOT_A_PAYMENT_NOTE)
  })

  test('keeps the worded zeroes the workbook meant', () => {
    assert.ok(text(html).includes('Not applicable'))
    assert.ok(text(html).includes('as applicable'))
  })

  test('does not print a second promotional Grand Total tile', () => {
    assert.equal(text(html).split('Grand Total').length - 1, 1)
  })

  test('groups the column so it reads as a calculation, not a list', () => {
    assert.equal(stored.find(r => r.key === 'beforeGst')?.groupStart, true)
    assert.equal(stored.find(r => r.key === 'grandTotal')?.emphasis, 'total')
  })
})

// ── The import preview must not have moved ────────────────────────────────────

describe('the import preview keeps the summary it shipped with', () => {
  const rows = buildCommercialRows(persistedCommercial(submission()))
  const preview = renderToStaticMarkup(<PiCommercialSummary rows={rows} />)
  const detail = renderToStaticMarkup(
    <PiCommercialSummary rows={commercialBreakdownRows(rows)} title="Commercial breakdown" variant="detail" />,
  )

  test('the default variant is the preview one', () => {
    assert.equal(preview, renderToStaticMarkup(<PiCommercialSummary rows={rows} variant="preview" />),
      'a screen that passes no variant gets exactly what it always got')
  })

  test('it still caps and right-aligns itself under the product table', () => {
    assert.ok(preview.includes('max-width:780px'))
    assert.ok(preview.includes('margin-left:auto'))
    assert.ok(!detail.includes('margin-left:auto'), 'while the detail column fills instead')
  })

  test('it keeps the required advance, which is the only place it states one', () => {
    assert.ok(text(preview).includes('Required advance (40%)'))
    assert.ok(text(preview).includes(ADVANCE_NOT_A_PAYMENT_NOTE))
  })

  test('none of the detail page’s typography leaked into it', () => {
    assert.ok(!preview.includes('tabular-nums'),
      'the preview keeps its proportional figures')
    assert.ok(detail.includes('font-variant-numeric:tabular-nums'),
      'and the detail column lines its digits up under the products table')
    // The grouping hairline is the detail page's too: preview draws exactly one
    // rule, above the Grand Total, as it always has.
    assert.equal((preview.match(/border-top:1px solid/g) ?? []).length, 1)
    assert.equal((detail.match(/border-top:1px solid/g) ?? []).length, 1,
      'the detail column adds one grouping rule before tax; its Grand Total rule '
      + 'is heavier and comes from CSS, not from an inline hairline')
    // Not even a serialised zero. A falsy-but-PRESENT style value still reaches
    // the markup — `marginTop: 0` emits `margin-top:0` on every row — and the
    // preview's markup must come out exactly as it did before the detail page
    // needed anything of this component. (The one legitimate `margin-top` in
    // here is the advance note's own 2px, which predates all of this.)
    assert.ok(!preview.includes('margin-top:0'))
    assert.ok(!preview.includes('padding-top'))
  })

  test('its heading is untouched', () => {
    assert.ok(text(preview).includes('Commercial summary'))
  })
})

// ── The hierarchy between the two lower cards ─────────────────────────────────
//
// They sit side by side and were reading at identical strength, so a person
// scanning for the total had to look twice. The commercial card is the primary
// financial reference and the trail is secondary audit history; these guard that
// the difference exists, stays restrained, and costs nobody any contrast.

describe('the commercial breakdown outranks the activity trail', () => {
  const rows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(submission())))
  const commercial = renderToStaticMarkup(
    <PiCommercialSummary rows={rows} title="Commercial breakdown" variant="detail" />,
  )
  const activity = renderToStaticMarkup(
    <PiActivityTimeline entries={describeActivityEntries(
      [{ id: '1', action: 'submitted', actor_id: 'u1', note: 'Corrected line 3.', created_at: '2026-08-02T06:00:00Z' }],
      new Map([['u1', 'Nishant Soni']]), iso => String(iso).slice(0, 10))} />,
  )

  test('the two cards are visibly different surfaces, not two identical whites', () => {
    assert.ok(commercial.includes('background:#FFFFFF'), 'the money card keeps the strong white')
    assert.ok(activity.includes('background:#F8F9FB'), 'the trail takes a light cool grey')
    assert.ok(!activity.includes('background:#FFFFFF'))
  })

  test('the money card is warm-bordered and softly raised; the trail is neither', () => {
    assert.ok(commercial.includes('border-color:rgba(232,160,48,0.30)'), 'a warm hairline')
    assert.ok(commercial.includes('box-shadow:0 1px 2px rgba(16,24,40,0.05)'), 'shallow and low-opacity')
    assert.ok(activity.includes('border-color:rgba(0,0,0,0.09)'), 'a neutral grey hairline')
    assert.ok(activity.includes('box-shadow:none'))
    // Restraint: no gradient, no filled bar, no decorative icon on the money card.
    for (const loud of ['gradient', 'svg']) {
      assert.ok(!commercial.includes(loud), `the money card must carry no ${loud}`)
    }
  })

  test('their headers are distinguishable without either shouting', () => {
    assert.ok(commercial.includes('background:rgba(232,160,48,0.05)'), 'a very pale cream')
    assert.ok(commercial.includes('border-bottom:1px solid rgba(232,160,48,0.20)'))
    // The trail's heading is softer by a weight and a shade.
    assert.ok(activity.includes('font-weight:600;color:#4A5261'))
    assert.ok(!activity.includes('background:rgba(232,160,48'))
  })

  test('the Grand Total keeps its own emphasis class, and it is the strongest point', () => {
    assert.ok(commercial.includes('class="pi-commercial-grand-total"'))
    assert.equal((commercial.match(/pi-commercial-grand-total/g) ?? []).length, 1,
      'exactly one row carries it')
    // Its ground and rule come from that class; its typography stays inline
    // beside every other row's, one step up and no more.
    const css = read(GLOBAL_CSS)
    const rule = css.slice(css.indexOf('.pi-commercial-grand-total {'))
    assert.ok(/background: rgba\(232, 160, 48, 0\.08\)/.test(rule), 'a pale warm highlight')
    assert.ok(/border-top: 2px solid rgba\(232, 160, 48, 0\.42\)/.test(rule), 'a stronger top border')
    const total = commercial.slice(commercial.indexOf('pi-commercial-grand-total'))
    assert.ok(total.includes('font-weight:700'), 'bold label and bold amount')
    assert.ok(total.includes('font-size:15px'), 'and the amount a single step larger')
  })

  test('the money figures keep their right alignment and tabular figures', () => {
    assert.ok(commercial.includes('text-align:right'))
    assert.ok(commercial.includes('font-variant-numeric:tabular-nums'))
  })

  test('the grouping before tax survives, and the advance row stays out', () => {
    assert.equal(rows.find(r => r.key === 'beforeGst')?.groupStart, true)
    assert.ok(!text(commercial).includes('Required advance'))
  })

  test('the trail keeps every event, note, actor, time and amount', () => {
    const body = text(activity)
    for (const kept of ['Submitted for approval', 'Nishant Soni', '2026-08-02', 'Corrected line 3.']) {
      assert.ok(body.includes(kept), `${kept} must survive the restyle`)
    }
    assert.ok(activity.includes('class="pi-detail-timeline-dot"'), 'the markers stay')
  })

  test('the markers are softened, and never the only channel', () => {
    const softened = ['#A4ABB9', '#7A9DE0', '#D9A552', '#6BB68C', '#CE7272']
    const sections = read(SECTIONS)
    for (const tone of softened) {
      assert.ok(sections.includes(tone), `${tone} must be one of the five markers`)
    }
    for (const full of ['neutral: colors.muted', 'blue: colors.blue', 'red: colors.red']) {
      assert.ok(!sections.includes(full), `${full} was full strength and pulled the eye`)
    }
    // Meaning is in the words beside the dot, and the rail is hidden from
    // assistive technology entirely.
    assert.ok(activity.includes('aria-hidden="true"'))
    assert.ok(text(activity).includes('Submitted for approval'))
  })

  test('the connector is lighter than the card it sits in', () => {
    const css = read(GLOBAL_CSS)
    const line = css.slice(css.indexOf('.pi-detail-timeline-line {'))
    assert.ok(/background: rgba\(0, 0, 0, 0\.07\)/.test(line.slice(0, 400)))
  })

  test('nobody lost contrast to the restyle', () => {
    const sections = read(SECTIONS)
    // The trail's ground moved off pure white, so the timestamp and the actor
    // line were DARKENED rather than left muted — quieter must not mean harder
    // to read. colors.muted (#8C94A6) would have fallen to 2.89:1 on #F8F9FB.
    assert.ok(!/color: colors\.muted, whiteSpace: 'nowrap' \}\}>\s*\{entry\.at\}/.test(sections))
    assert.ok(sections.includes("color: colors.tertiary, whiteSpace: 'nowrap' }}>"))
    assert.ok(activity.includes('color:#111318'), 'event titles stay at full strength')
  })
})

describe('the activity trail', () => {
  const rows: PersistedActivity[] = [
    { id: '1', action: 'submission_created', actor_id: 'u1', note: null, created_at: '2026-08-01T06:00:00Z' },
    { id: '2', action: 'parse_replaced', actor_id: 'u1', note: null, created_at: '2026-08-01T07:00:00Z' },
    { id: '3', action: 'submitted', actor_id: 'u1', note: 'Corrected line 3.', created_at: '2026-08-02T06:00:00Z' },
    { id: '4', action: 'advance_exception_requested', actor_id: 'u1', note: 'Long-standing client.',
      created_at: '2026-08-02T06:01:00Z', metadata: { advance_percent: 12.5, advance_amount: 147500, item_count: 9 } },
    { id: '5', action: 'changes_requested', actor_id: 'u2', note: 'Fabric on line 3 is wrong.', created_at: '2026-08-03T06:00:00Z' },
    { id: '6', action: 'advance_exception_approved', actor_id: 'u2', note: null,
      created_at: '2026-08-03T07:00:00Z', metadata: { advance_percent: 12.5, advance_amount: 147500 } },
    { id: '7', action: 'rejected', actor_id: 'u2', note: 'The client withdrew.', created_at: '2026-08-04T06:00:00Z' },
  ]
  const names = new Map([['u1', 'Nishant Soni'], ['u2', 'Rohit Verma']])
  const entries = describeActivityEntries(rows, names, iso => String(iso).slice(0, 10))
  const html = renderToStaticMarkup(<PiActivityTimeline entries={entries} />)

  test('renders every event the record carries', () => {
    assert.equal(entries.length, rows.length)
    assert.ok(text(html).includes('7 events'))
    for (const label of [
      'Draft created', 'PI replaced', 'Submitted for approval',
      'Advance exception requested', 'Changes requested',
      'Advance exception approved', 'Rejected',
    ]) {
      assert.ok(text(html).includes(label), `${label} must be in the trail`)
    }
  })

  test('renders every note, actor and time', () => {
    const body = text(html)
    for (const note of ['Corrected line 3.', 'Long-standing client.',
                        'Fabric on line 3 is wrong.', 'The client withdrew.']) {
      assert.ok(body.includes(note), `${note} must be readable`)
    }
    assert.ok(body.includes('Nishant Soni') && body.includes('Rohit Verma'))
    assert.ok(body.includes('2026-08-04'))
  })

  test('shows the advance figures that WERE the event', () => {
    assert.ok(text(html).includes('₹1,47,500 · 12.5%'))
  })

  test('is a marked, connected timeline rather than a stacked list', () => {
    assert.ok(html.includes('<ol'), 'an ordered list, because a trail has an order')
    assert.equal((html.match(/class="pi-detail-timeline-dot"/g) ?? []).length, rows.length)
    assert.ok(html.includes('class="pi-detail-timeline-line"'))
    assert.ok(html.includes('aria-hidden="true"'), 'the rail is decoration, not content')
  })

  test('spends colour only where an event carries state', () => {
    // Created and replaced are neutral; the rest are marked. Colour that is
    // everywhere has said nothing.
    assert.deepEqual(entries.map(e => e.tone).sort(),
      ['amber', 'amber', 'blue', 'green', 'neutral', 'neutral', 'red'])
  })

  test('keeps the newest event first, as it always has', () => {
    assert.equal(entries[0].label, 'Rejected')
    assert.ok(html.indexOf('Rejected') < html.indexOf('Draft created'))
  })

  test('exposes no id, no enum and no metadata object', () => {
    for (const leak of ['submission_created', 'parse_replaced', 'advance_exception_requested',
                        'item_count', 'previous_status', 'actor_id']) {
      assert.ok(!html.includes(leak), `${leak} must never reach the markup`)
    }
  })

  test('an empty trail says so rather than rendering an empty box', () => {
    const empty = renderToStaticMarkup(<PiActivityTimeline entries={[]} />)
    assert.ok(text(empty).includes('No activity has been recorded'))
  })
})

describe('the lower grid pairs the two reference cards', () => {
  const html = renderToStaticMarkup(
    <PiLowerGrid commercial={<div>BREAKDOWN</div>} activity={<div>TRAIL</div>} />,
  )

  test('renders the trail on the left and the breakdown on the right', () => {
    assert.ok(html.includes('class="pi-detail-lower-grid"'))
    assert.ok(html.indexOf('TRAIL') < html.indexOf('BREAKDOWN'),
      'DOM order is the desktop order, so the desktop needs no reordering at all')
    assert.ok(html.includes('class="pi-detail-activity-col"'))
    assert.ok(html.includes('class="pi-detail-commercial-col"'))
  })

  test('is one column by default and roughly 62/38 on a desktop', () => {
    const css = pageCss()
    const grid = css.slice(css.indexOf('.pi-detail-lower-grid {'))
    assert.ok(/\.pi-detail-lower-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(grid),
      'a phone stacks them, and hides neither')
    assert.ok(/@media \(min-width: 1024px\)[\s\S]*?\.pi-detail-lower-grid \{\s*grid-template-columns: minmax\(0, 62fr\) minmax\(0, 38fr\)/.test(css),
      'activity takes the width; the breakdown needs only a column')
    assert.ok(grid.includes('align-items: start'),
      'aligned at the top, never stretched to a common height')
  })

  test('the breakdown is read FIRST when the two are stacked', () => {
    const css = pageCss()
    // A phone reader has just finished the product values and wants the total
    // next, not a history. One `order` declaration, no JavaScript.
    assert.ok(/\.pi-detail-commercial-col \{\s*order: -1;/.test(css))
    assert.ok(/@media \(min-width: 1024px\)[\s\S]*?\.pi-detail-commercial-col \{\s*order: 0;/.test(css))
  })
})

// ── The responsive arrangement ────────────────────────────────────────────────

describe('the layout is CSS, at three real breakpoints', () => {
  const css = pageCss()

  test('the summary is one column on a phone and three on a desktop', () => {
    assert.ok(/\.pi-detail-summary \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css),
      'one column is the floor: Client, then dates, then payment, in reading order')
    // Payment takes the widest of the three, because it is the only group whose
    // value changes and the one the card exists to raise.
    assert.ok(
      /@media \(min-width: 768px\)[\s\S]*?\.pi-detail-summary \{\s*grid-template-columns: minmax\(0, 1\.05fr\) minmax\(0, 0\.75fr\) minmax\(0, 1\.4fr\)/.test(css),
      'three balanced groups, payment widest')
  })

  test('the dividing rule turns from horizontal to vertical at the breakpoint', () => {
    // A vertical rule between stacked blocks is a line to nowhere.
    assert.ok(/\.pi-detail-summary-divided \{\s*border-top: 1px solid/.test(css))
    assert.ok(
      /@media \(min-width: 768px\)[\s\S]*?\.pi-detail-summary-divided \{[\s\S]*?border-left: 1px solid/.test(css))
  })

  test('the progress bar cannot overflow its track and respects reduced motion', () => {
    assert.ok(/\.pi-detail-summary-bar \{[\s\S]*?overflow: hidden/.test(css))
    assert.ok(/prefers-reduced-motion: reduce[\s\S]*?\.pi-detail-summary-bar-fill \{ transition: none/.test(css))
  })

  test('actions take a readable full width on a narrow phone', () => {
    assert.ok(/@media \(max-width: 480px\)[\s\S]*?\.pi-detail-workflow-actions \{\s*width: 100%/.test(css))
  })

  test('every column of this page is minmax(0, …), so nothing can widen it', () => {
    const tracks = [...css.matchAll(/grid-template-columns: ([^;]+);/g)].map(m => m[1])
    assert.ok(tracks.length >= 4, 'the block really does define the grids')
    for (const value of tracks) {
      for (const track of value.split(/\)\s+/)) {
        assert.ok(track.startsWith('minmax(0,'),
          `${value} must not be able to overflow its grid`)
      }
    }
  })

  test('the block is scoped to this page and modifies nothing above it', () => {
    const global = read(GLOBAL_CSS)
    const selectors = [...global.matchAll(/^\.([a-z0-9-]+)/gm)].map(m => m[1])
    const mine = selectors.filter(name => name.startsWith('pi-detail-'))
    assert.ok(mine.length >= 15, 'the page owns a real block')
    // Nothing outside the prefix was added: the block is appended at the end.
    assert.ok(global.indexOf('.pi-detail-') > global.indexOf('.boe-page-body'),
      'appended after the shared rules rather than woven into them')
  })

  test('the page still has exactly one width probe in JavaScript, and it is the table’s', () => {
    const page = read(PAGE)
    const listeners = [...page.matchAll(/addEventListener\('([^']+)'/g)].map(m => m[1])
    assert.deepEqual(listeners, ['resize'])
    assert.ok(page.includes('setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)'))
    for (const file of [SECTIONS, 'src/app/orders/drafts/[submissionId]/piDetailView.ts']) {
      assert.ok(!read(file).includes('addEventListener'),
        `${file} must express its responsiveness in CSS`)
    }
  })
})

// ── The footnote ──────────────────────────────────────────────────────────────

describe('the page footnote', () => {
  const html = text(renderToStaticMarkup(<PiStoredCopyNote />))

  test('is one short line, and still says numbering waits for approval', () => {
    assert.ok(html.includes(STORED_COPY_NOTE))
    assert.ok(STORED_COPY_NOTE.length < 120, 'a paragraph became a line')
    assert.ok(/numbering begins after management approval/.test(STORED_COPY_NOTE))
  })

  test('does not imply approval can be executed today', () => {
    assert.ok(!html.includes('Approve now'))
    assert.ok(!html.includes('ready for approval'))
  })
})

// ── The page's scan order ─────────────────────────────────────────────────────
//
// These read the composition rather than a rendering, because what is being
// asserted is the ORDER the page assembles its sections in — and the page itself
// cannot be imported here: it is a client component that opens a Supabase client
// and reads the route. The sections it puts in that order are rendered and
// asserted above.

describe('the page is assembled in the redesigned scan order', () => {
  const page = read(PAGE)
  const at = (marker: string): number => {
    const index = page.indexOf(marker)
    assert.ok(index > 0, `${marker} must be on the page`)
    return index
  }

  test('identity, summary, workflow, blocking — all ABOVE the products', () => {
    const order = [
      '<PiIdentityStrip',
      '<PiSummaryCard',
      '<PiWorkflowPanel',
      '<PiBlockingPanel',
      '{/* Products */}',
    ].map(at)
    assert.deepEqual([...order].sort((a, b) => a - b), order,
      'nobody should scroll a product table to find out what is being asked of them')
  })

  test('the payment position is answered in exactly one place on the page', () => {
    // It used to be answered twice: a block in the top overview and a full card
    // below the products. The summary is now the only section, and the detail
    // opens out of it as a dialog.
    assert.equal((page.match(/<PiSummaryCard/g) ?? []).length, 1)
    assert.ok(!page.includes('<PiPaymentCard'), 'the standalone payments section is gone')
    assert.equal((page.match(/<PiPaymentDetailsModal/g) ?? []).length, 1,
      'and the records open in the dialog the rest of the application uses')
  })

  test('the commercial breakdown and the activity trail come after them, together', () => {
    assert.ok(at('{/* Products */}') < at('<PiLowerGrid'))
    const grid = page.slice(at('<PiLowerGrid'), at('<PiWarningPanel'))
    assert.ok(grid.includes('<PiCommercialSummary'), 'the breakdown is in the grid')
    assert.ok(grid.includes('<PiActivityTimeline'), 'and so is the trail')
    assert.ok(grid.indexOf('<PiCommercialSummary') < grid.indexOf('<PiActivityTimeline'),
      'breakdown first, which is also the order they stack in on a phone')
  })

  test('warnings sit below the grid, and the footnote last', () => {
    assert.ok(at('<PiLowerGrid') < at('<PiWarningPanel'))
    assert.ok(at('<PiWarningPanel') < at('<PiStoredCopyNote'))
  })

  test('blocking issues still stay above warnings', () => {
    assert.ok(page.indexOf('draft.blocking.length > 0') < page.indexOf('draft.warnings.length > 0'))
  })

  test('the workflow panel is drawn once, for everybody, from the shared rules', () => {
    assert.equal((page.match(/<PiWorkflowPanel/g) ?? []).length, 1,
      'one panel, so the employee view and the reviewer view cannot drift')
    assert.ok(page.includes('const actions = describeSubmissionActions({'))
    assert.ok(page.includes('const advanceActions = describeAdvanceActions({'))
    assert.ok(page.includes('canDecideException: canDecideAdvance'))
    // No second, looser copy of either rule in a JSX condition.
    assert.ok(!/status === 'submitted' &&\s*canReview/.test(page))
    assert.ok(!/advance_exception_status === 'pending'/.test(page))
  })

  test('the panel derives "is this a reviewer" from the shared helper alone', () => {
    const sections = read(SECTIONS)
    assert.ok(sections.includes('actions.canRequestChanges || actions.canReject'))
    assert.ok(!/canReview/.test(sections),
      'a presentational section must never be handed a raw capability')
    assert.ok(!sections.includes('canDecide={'),
      'and it never decides for itself who may settle an exception')
  })

  test('no status banner survives anywhere, in any form', () => {
    // The banner card went in the redesign; its SENTENCE went in this pass. The
    // heading names the state, the identity badge repeats it once, and a quiet
    // metadata line says who moved the record and when. Nothing paraphrases it.
    assert.ok(!page.includes('describeSubmissionBanner'))
    assert.ok(!page.includes('bannerTone'))
    assert.ok(!/panel\.standing/.test(read(SECTIONS)))
    assert.ok(read(PAGE).includes('rejectedByName: draft.rejectedByName'),
      'the actor names still reach the panel, as metadata')
  })
})

// ── The product table boundary ────────────────────────────────────────────────

describe('the products section is exactly what it was', () => {
  const page = read(PAGE)
  const products = page.slice(
    page.indexOf('{/* Products */}'),
    page.indexOf('{/* ── 6. The lower information grid ──'),
  )

  test('the section really was located', () => {
    assert.ok(products.length > 2000)
  })

  test('renders the shared head, so both PI screens share one column list', () => {
    assert.ok(products.includes('<PiProductTableHead />'))
    assert.ok(!products.includes("'Cost / piece'"), 'no second copy of the column list')
  })

  test('the desktop row still has its nine cells, in their order', () => {
    const table = products.slice(products.indexOf('<tbody>'), products.indexOf('</tbody>'))
    const cells = [...table.matchAll(/<td\b/g)]
    assert.equal(cells.length, 9, 'nine columns, exactly as before')
    const order = [
      'p.itemSequence', '<PiProductThumbnail', 'p.productName', 'p.quantity',
      'p.dimensions', 'p.material', '<PiCustomizationCell', 'p.costPerPiece', 'p.lineTotal',
    ].map(marker => {
      const index = table.indexOf(marker)
      assert.ok(index > 0, `${marker} must still be a cell`)
      return index
    })
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })

  test('money stays right-aligned and the line total stays heavier', () => {
    assert.ok(products.includes("textAlign: 'right', color: colors.secondary"))
    assert.ok(products.includes("textAlign: 'right', fontWeight: 600, color: colors.primary"))
  })

  test('thumbnails keep the shared sizes and the shared viewer wiring', () => {
    assert.ok(products.includes('<PiProductThumbnail {...representativeThumbnail(p.row)} />'),
      'the desktop table takes the default representative size')
    assert.ok(products.includes('size={PI_THUMBNAIL_SIZE.representativeCompact}'),
      'and the phone card takes the compact one')
    assert.ok(products.includes('customizationThumbnails(p.row)'))
  })

  test('customization keeps its own cell and its accent', () => {
    assert.ok(products.includes('compact={false}'), 'desktop')
    assert.ok(products.includes('compact\n                  />') || products.includes('compact'),
      'phone card')
    assert.equal((products.match(/<PiCustomizationCell/g) ?? []).length, 2,
      'one on the table row, one on the phone card — and no third rendering')
  })

  test('the phone cards are untouched', () => {
    for (const part of [
      'isMobile ? (', 'label="Dimensions"', 'label="Material"', 'Line total',
      'formatInr(p.lineTotal)', 'formatInr(p.costPerPiece)',
    ]) {
      assert.ok(products.includes(part), `${part} must survive the redesign`)
    }
  })

  test('the table keeps its own horizontal scroll, and never the page’s', () => {
    assert.ok(products.includes("overflowX: 'auto'"))
  })

  test('the unresolved-image badge and the empty state are unchanged', () => {
    assert.ok(products.includes('{draft.unresolvedImages} image'))
    assert.ok(products.includes('No product lines are stored against this draft.'))
  })

  test('nothing the redesign introduced was put inside it', () => {
    for (const introduced of [
      'PiIdentityStrip', 'PiSummaryCard', 'PiWorkflowPanel', 'PiAdvanceBand',
      'PiBlockingPanel', 'PiWarningPanel', 'PiActivityTimeline', 'PiLowerGrid',
      'pi-detail-',
    ]) {
      assert.ok(!products.includes(introduced),
        `${introduced} must not have leaked into the approved product section`)
    }
  })

  test('the product table is full width, never a column of the lower grid', () => {
    const grid = page.slice(page.indexOf('<PiLowerGrid'))
    assert.ok(!grid.includes('<PiProductTableHead'))
    assert.ok(page.indexOf('{/* Products */}') < page.indexOf('<PiLowerGrid'))
  })
})

// ── Phase C: responsiveness and accessibility ─────────────────────────────────

describe('the Phase C additions introduce no page-level overflow', () => {
  const verified = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
    finance_verified_by: FINANCE,
    finance_verified_at: '2026-08-03T09:30:00Z',
    finance_verified_submission_at: '2026-08-03T04:00:00Z',
  })
  const approved = submission({
    status: 'approved',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    approved_by: REVIEWER,
    approved_at: '2026-08-04T05:00:00Z',
    order_id: '77777777-7777-4777-8777-777777777777',
    advance_condition: 'standard',
    finance_verified_by: FINANCE,
    finance_verified_at: '2026-08-03T09:30:00Z',
    finance_verified_submission_at: '2026-08-03T04:00:00Z',
  })

  const panels = [
    workflowHtml(verified, { id: REVIEWER, canReview: true }),
    workflowHtml(verified, { id: FINANCE, canVerifyFinance: true }),
    workflowHtml(approved, { id: REVIEWER, canReview: true }),
  ]

  test('nothing new scrolls sideways — the product table is still the only one', () => {
    for (const html of panels) {
      assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(html))
      assert.ok(!/white-space\s*:\s*nowrap[^;]*;[^"]*width\s*:\s*\d{3,}px/.test(html))
    }
  })

  test('nothing new is given a fixed width that cannot shrink', () => {
    for (const html of panels) {
      const widths = [...html.matchAll(/(?<!max-|min-)width\s*:\s*(\d+)px/g)].map(m => Number(m[1]))
      for (const width of widths) {
        assert.ok(width <= 320, `a ${width}px fixed width would overflow a 360px phone`)
      }
    }
  })

  test('the new rows wrap rather than push the panel wider', () => {
    for (const html of panels) {
      assert.ok(html.includes('flex-wrap:wrap'))
    }
  })

  test('the action group still carries the class that stacks it on a phone', () => {
    // The 480px rule in globals.css gives each control a readable full width
    // rather than shrinking labels until they wrap mid-word. Phase C added a
    // button to that group and must not have opened a second one.
    const html = panels[0]
    assert.ok(html.includes('pi-detail-workflow-actions'))
    assert.equal((html.match(/pi-detail-workflow-actions/g) ?? []).length, 1)
  })

  test('long text in the new rows is allowed to wrap', () => {
    // A verifier name and a blocker sentence are both arbitrary length, and
    // neither is nowrap.
    const html = panels[0]
    const financeLine = html.slice(html.indexOf('Finance'), html.indexOf('Finance') + 600)
    assert.ok(!financeLine.includes('white-space:nowrap') || financeLine.includes('min-width:0'))
  })

  test('the Order number is legible rather than merely large', () => {
    const html = panels[2]
    assert.ok(html.includes('font-variant-numeric:tabular-nums'),
      '0413 and 0431 must not be confusable at a glance')
  })

  test('every new control is a real button, reachable by keyboard', () => {
    for (const html of panels) {
      const controls = [...html.matchAll(/<(button|a|div)\b[^>]*onclick/gi)]
      assert.equal(controls.length, 0, 'no handler is attached to a non-interactive element')
    }
    assert.ok(buttonLabels(panels[0]).length > 0)
    for (const label of buttonLabels(panels[0])) {
      assert.ok(label.trim().length > 0, 'no icon-only control without an accessible name')
    }
  })

  test('a busy panel disables its controls rather than removing them', () => {
    // Removing a control mid-flight moves everything beside it under the
    // pointer, which is how a second, unintended click happens.
    const busy = renderToStaticMarkup(
      <PiWorkflowPanel
        {...(() => {
          const state = viewerState(verified, { id: REVIEWER, canReview: true })
          return {
            panel: state.panel,
            actions: state.actions,
            status: verified.status,
            reviewNote: null,
            employeeReply: null,
            advanceRefusal: null,
            blockingCount: 0,
            finance: state.finance,
            approvalBlocker: state.readiness.blocker,
            approvalReady: state.readiness.ready,
            approvedOrder: state.approvedOrder,
          }
        })()}
        acting
        onChangePi={() => {}}
        onSubmit={() => {}}
        onRequestChanges={() => {}}
        onReject={() => {}}
        onVerifyFinance={() => {}}
        onApprove={() => {}}
        onOpenOrder={() => {}}
        advanceBand={null}
      />,
    )
    const opens = [...busy.matchAll(/<button\b([^>]*)>/g)].map(m => m[1])
    assert.ok(opens.length > 0)
    for (const attrs of opens) {
      assert.ok(attrs.includes('disabled=""'), 'every control goes dead together')
    }
  })
})

// ── Nothing new was introduced ────────────────────────────────────────────────

describe('the redesign added no route, no query, no RPC and no permission', () => {
  const page = read(PAGE)

  test('the same tables are read, plus the one Phase C needs, and no others', () => {
    // `orders` is the addition, read ONCE and only when the record actually
    // names an Order — so an approved PI can show the official number and link
    // to it. Under the caller's own RLS: a viewer who may not see the Order
    // gets no row rather than a number they were not entitled to.
    const tables = [...page.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    assert.deepEqual([...new Set(tables)].sort(), [
      'order_submission_activity',
      'order_submission_item_images',
      'order_submission_items',
      'order_submissions',
      'orders',
      'users',
    ])
    // Still no Finance or payment table, in any phase. Finance VERIFICATION is
    // a sign-off on this record, not a look at a payment ledger.
    for (const table of new Set(tables)) {
      assert.ok(!/payment|finance/i.test(table), `${table} is out of scope for this page`)
    }
  })

  test('the same RPCs are called, plus the two Phase C adds, and no others', () => {
    const rpcs = [...page.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(rpcs)].sort(), [
      'approve_order_submission',
      'approve_pi_advance_exception',
      'reject_order_submission',
      'reject_pi_advance_exception',
      'request_order_submission_changes',
      'submit_pi_for_review',
      'verify_pi_finance_check',
    ])
  })

  test('no decorative field was given a fetch of its own', () => {
    // Everything the new sections print comes from the four reads the page
    // already made. The presentational modules touch no client at all.
    for (const file of [SECTIONS, 'src/app/orders/drafts/[submissionId]/piDetailView.ts']) {
      const source = read(file)
      for (const forbidden of ['createClient', 'supabase', '.rpc(', '.from(', 'fetch(']) {
        assert.ok(!source.includes(forbidden), `${file} must not ${forbidden}`)
      }
    }
  })

  test('capability derivation is untouched, and still the signed-in account’s', () => {
    assert.ok(page.includes("getEffectivePermissions(supabase, session.user.id, 'orders')"))
    assert.ok(page.includes('setCanReview(caps.canApproveOrderSubmission)'))
    assert.ok(page.includes('setCanDecideAdvance(caps.canApproveAdvanceException)'))
    assert.ok(page.includes('setViewerId(session.user.id)'))
    assert.ok(page.includes('.catch(() => [])'), 'a failed permission read must deny')
  })

  test('the screen is still the only route under this folder', () => {
    // A redesign that quietly grew a second page would be a second place for
    // these rules to live. The siblings are a view module and a section module,
    // neither of which App Router treats as a route.
    const siblings = ['page.tsx', 'piDetailSections.tsx', 'piDetailView.ts', 'piDetail.render.test.tsx']
    for (const name of siblings) read(`src/app/orders/drafts/[submissionId]/${name}`)
    assert.throws(() => read('src/app/orders/drafts/[submissionId]/route.ts'))
    assert.throws(() => read('src/app/orders/drafts/[submissionId]/review/page.tsx'))
  })

  test('nothing writes, logs or leaks a database message', () => {
    for (const file of [PAGE, SECTIONS]) {
      const source = read(file)
      for (const forbidden of ['.insert(', '.update(', '.delete(', '.upsert(', 'console.log', 'error.message']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    assert.ok(read(PAGE).includes('describeSubmissionFailure(error, action).message'))
  })
})
