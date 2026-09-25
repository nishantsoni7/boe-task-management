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
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BOE_STANDARD_COMMERCIAL_TERMS,
  COMMERCIAL_TERMS_ABSENT,
  FABRIC_RESPONSIBILITY_UNANSWERED,
} from '@/lib/orders/piTerms'

import { PiClientDetailsModal } from '@/components/orders/piReviewModals'
import type { PiReadiness, PiRequirement } from '@/lib/orders/piReadiness'
import {
  PAYMENT_DETAILS_LABEL,
  PiActivityTimeline,
  PiAdvanceBand,
  PiBlockingPanel,
  PiCommercialBreakdown,
  PiContextRow,
  PiLowerGrid,
  PiPaymentStatusCard,
  PiPaymentStatusCardView,
  PiSummaryCard,
  PiStoredCopyNote,
  PiWarningPanel,
  PiWorkflowPanel,
  statusTone,
} from './piDetailSections'
import {
  BILLING_NOT_DECLARED_LABEL,
  BILLING_VALUE_LABEL,
  CLIENT_CONTACT_LABEL,
  CLIENT_FACT_ABSENT,
  CLIENT_LOCATION_LABEL,
  CREATED_LABEL,
  PAYMENT_COLLAPSED_HINT,
  PAYMENT_PANEL_ID,
  PAYMENT_STATUS_TITLE,
  RESERVED_ORDER_LABEL,
  SALESPERSON_ABSENT,
  SUBMISSION_CELL_HEADING,
  SUBMITTED_BY_LABEL,
  barWidth,
  buildBillingSummary,
  buildBreakdownView,
  buildClientDetails,
  buildPaymentStatusView,
  buildSubmissionContext,
  NOT_PROVIDED,
  buildDateSummary,
  summaryCommercialFigures,
  telLink,
  type PaymentStatusView,
  commercialBreakdownRows,
  describeApprovedOrder,
  describeWorkflowPanel,
  ADVANCE_BAND_TITLE,
  STORED_COPY_NOTE,
  WORKFLOW_HEADING,
} from './piDetailView'
import { SALESPERSON_LABEL } from '@/lib/orders/orderConfirmation'
import { RESERVE_ACTION_LABEL, type ReservationView } from '@/lib/orders/orderNumberReservation'
import {
  APPROVED_ORDER_HEADING,
  describeApprovalReadiness,
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
  NUMBER_NOT_ALLOTTED,
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
  awaitingVerificationAmount?: string | number | null
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
  // THE PAYMENT GATE, exactly as the page derives it: the position comes from
  // pi_submission_payment_summary(). The harness models it as the fixture's own
  // `paymentPosition`, so a test can put the record anywhere on the gate without
  // inventing money.
  const readiness = describeApprovalReadiness({
    status: row.status,
    awaitingVerificationAmount: viewer.awaitingVerificationAmount ?? 0,
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
  return { actions, advance, advanceActions, panel, readiness, approvedOrder }
}

/**
 * The workflow panel as the page assembles it, for one viewer.
 *
 * The band and the refusal block are gated here exactly as page.tsx gates them,
 * so what these tests render is what the screen renders.
 */
function workflowHtml(row: PersistedSubmission, viewer: Parameters<typeof viewerState>[1], opts: {
  employeeReply?: string | null
  /** What piReadiness('submission') said, when a test is about that list. */
  readiness?: PiReadiness | null
  onFixReadiness?: ((section: PiRequirement['section']) => void) | null
} = {}): string {
  const { actions, advance, advanceActions, panel, readiness, approvedOrder } =
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
      readiness={opts.readiness ?? null}
      onFixReadiness={opts.onFixReadiness ?? null}
      blockingCount={0}
      acting={false}
      approvalBlocker={readiness.blocker}
      approvalReady={readiness.ready}
      approvedOrder={approvedOrder}
      onChangePi={() => {}}
      onSubmit={() => {}}
      onRequestChanges={() => {}}
      onReject={() => {}}
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
/**
 * What a cell-splitting read of rendered markup uses as its boundary.
 *
 * Built with fromCharCode rather than typed as a literal: a real control byte
 * in this file makes git treat the source as binary, which turns every later
 * diff of it into a whole-file rewrite.
 */
const CELL_SEPARATOR = String.fromCharCode(0)

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

// ── 1. The context row: the reserved number beside where review stands ────────

/** A held reservation, as describeReservation would report one. A fixture. */
const HELD: ReservationView = {
  state: 'awaiting_revised_pi',
  number: '0521',
  standing: 'Reserved for this PI. The Confirmed Order will carry it.',
  blockedReason: null,
  canCopy: true,
}

const contextHtml = (over: {
  status?: string
  salesperson?: string | null
  submittedAt?: string | null
  submitterName?: string | null
  createdOn?: string | null
  finance?: { verified: boolean; text: string } | null
  piApprovedLine?: string | null
  rejectedLine?: string | null
  reservation?: ReservationView
  draftReference?: string | null
  copied?: boolean
  confirmedNumber?: string | null
} = {}) => {
  const status = over.status ?? 'submitted'
  return renderToStaticMarkup(
    <PiContextRow
      reservation={over.reservation ?? HELD}
      confirmedNumber={over.confirmedNumber ?? null}
      draftReference={over.draftReference === undefined ? 'PID-00042' : over.draftReference}
      onCopy={() => {}}
      copied={over.copied ?? false}
      context={buildSubmissionContext({
        status,
        salesperson: over.salesperson === undefined ? 'Dhruv Mehta' : over.salesperson,
        submitterName: over.submitterName === undefined ? 'Nishant Soni' : over.submitterName,
        submittedAt: over.submittedAt === undefined ? '03 Aug 2026, 09:30 am' : over.submittedAt,
        createdOn: over.createdOn === undefined ? '02 Sep 2026' : over.createdOn,
        piApprovedLine: over.piApprovedLine ?? null,
        rejectedLine: over.rejectedLine ?? null,
        hasOrder: false,
      })}
      statusLabel={draftStatusLabel(status)}
      tone={statusTone(draftStatusTone(status))}
    />,
  )
}

describe('the context row puts the reserved number beside where review stands', () => {
  test('one card, two sections, the number first', () => {
    const html = contextHtml()
    assert.ok(html.includes('class="pi-detail-context"'))
    assert.equal((html.match(/class="pi-detail-context-cell"/g) ?? []).length, 2)
    const t = text(html)
    assert.ok(t.indexOf(RESERVED_ORDER_LABEL) < t.indexOf(SALESPERSON_LABEL),
      'the Order number on the left, who the PI is from on the right')
    assert.ok(html.includes(`aria-label="${SUBMISSION_CELL_HEADING}"`),
      'and the whole cell is named for assistive technology, not just its first label')
  })

  test('the number is prominent, copyable, and explained in exactly one line', () => {
    const html = contextHtml()
    assert.ok(html.includes('class="pi-detail-context-number"'))
    assert.ok(text(html).includes('Reserved number 0521'),
      'a held reservation reads "Reserved number 0521" (20270114000000)')
    assert.ok(text(html).includes(NUMBER_NOT_ALLOTTED),
      'and, until the Order exists, says in words that no Order number is allotted')
    assert.ok(text(html).includes('Draft reference PID-00042'), 'beside the draft’s own reference')
    assert.ok(html.includes('aria-label="Copy Order number 0521"'))
    assert.equal((text(html).match(/Reserved for this PI/g) ?? []).length, 1)
    assert.ok(text(contextHtml({ copied: true })).includes('Copied'))
  })

  test('no number: "Order number not allotted", the draft reference, and no Reserve control', () => {
    const none: ReservationView = {
      state: 'blocked', number: null, standing: 'BOE allots the Order number when this PI is approved.',
      blockedReason: null, canCopy: false,
    }
    const quiet = contextHtml({ reservation: none })
    assert.ok(!buttonLabels(quiet).includes(RESERVE_ACTION_LABEL), 'a PI Draft no longer reserves (20270114000000)')
    assert.ok(text(quiet).includes(NUMBER_NOT_ALLOTTED))
    assert.equal((text(quiet).match(/Order number not allotted/g) ?? []).length, 1, 'said once')
    assert.ok(text(quiet).includes('Draft reference PID-00042'))
    assert.ok(!quiet.includes('Copy Order number'), 'nothing to copy')
    assert.ok(!text(quiet).includes('Reserved number'), 'and no number is implied')
  })

  test('the Confirmed Order number, once there is one, keeps its own label', () => {
    const t = text(contextHtml({ status: 'approved', confirmedNumber: '0521' }))
    assert.ok(t.includes('Confirmed Order number 0521'))
    assert.ok(!t.includes(NUMBER_NOT_ALLOTTED), 'and "not allotted" is gone once it is')
  })

  test('THE SALESPERSON LEADS, and the badge sits beside them', () => {
    const html = contextHtml()
    const t = text(html)
    assert.ok(t.includes(SALESPERSON_LABEL), 'the small label says whose name this is')
    assert.ok(t.includes('Dhruv Mehta'), 'and the name the PI itself carries is shown')
    assert.ok(html.includes('class="pi-detail-context-name"'), 'at the cell headline weight')
    assert.ok(t.includes('Submitted for Review'), 'the status badge is on the same line')
    const head = html.slice(html.indexOf('class="pi-detail-context-head"'))
    assert.ok(head.indexOf('Dhruv Mehta') < head.indexOf('Submitted for Review'),
      'name first, badge after it')
  })

  test('the SUBMITTER is named separately — never borrowed from the salesperson', () => {
    const t = text(contextHtml())
    assert.ok(t.includes(`${SUBMITTED_BY_LABEL} Nishant Soni`))
    assert.ok(t.includes('03 Aug 2026, 09:30 am'), 'with when they submitted it')
    // Two different people, each printed once under their own label.
    assert.equal(t.split('Dhruv Mehta').length - 1, 1)
    assert.equal(t.split('Nishant Soni').length - 1, 1)
  })

  test('the CREATED DATE is here, where the PI is described', () => {
    const t = text(contextHtml({ createdOn: '02 Sep 2026' }))
    assert.ok(t.includes(`${CREATED_LABEL} 02 Sep 2026`))
    // A record with no date at all prints no labelled hole.
    assert.ok(!text(contextHtml({ createdOn: null })).includes(CREATED_LABEL))
  })

  test('a PI that named no salesperson says so quietly, and still shows the rest', () => {
    const t = text(contextHtml({ salesperson: null }))
    assert.ok(t.includes(SALESPERSON_ABSENT))
    assert.ok(t.includes(`${SUBMITTED_BY_LABEL} Nishant Soni`))
    // An em dash is the workbook's "nothing here", not a name.
    assert.ok(text(contextHtml({ salesperson: '—' })).includes(SALESPERSON_ABSENT))
  })

  test('the review line is still there, and no finance status joins it', () => {
    const t = text(contextHtml())
    assert.ok(t.includes('Awaiting management review'))
    assert.ok(!t.includes('Finance'), 'nothing PR #186 removed comes back')
    assert.ok(!t.includes('Verified by'))
  })

  test('a standing PI decision reads as such, and no finance line joins it', () => {
    const t = text(contextHtml({
      piApprovedLine: 'PI approved by Rohit Verma · 04 Aug 2026, 10:00 am',
    }))
    assert.ok(t.includes('PI approved by Rohit Verma'))
    assert.ok(!t.includes('Verified by Asha Menon'),
      'the PI-level finance line was removed by 20261226000000')
  })

  test('a draft says it has not been submitted, and raises no finance question', () => {
    const t = text(contextHtml({ status: 'draft', submittedAt: null, submitterName: null }))
    assert.ok(t.includes('Not submitted yet'))
    assert.ok(!t.includes('Finance'), 'no finance line exists on any record')
    assert.ok(t.includes('Draft — not yet with management'))
  })

  test('every state has its own words, and colour is never the only channel', () => {
    const line = (status: string, extra: Partial<Parameters<typeof buildSubmissionContext>[0]> = {}) =>
      buildSubmissionContext({
        status, salesperson: 'D', submitterName: 'N', submittedAt: 'x', createdOn: '01 Aug 2026',
        piApprovedLine: null, rejectedLine: null, hasOrder: false, ...extra,
      }).lines[0]
    assert.deepEqual(line('needs_changes'), { key: 'review', label: 'Review', text: 'Returned for changes', tone: 'amber' })
    assert.equal(line('rejected', { rejectedLine: 'Rejected by R · 05 Aug' }).text, 'Rejected by R · 05 Aug')
    assert.equal(line('rejected', { rejectedLine: 'Rejected by R · 05 Aug' }).tone, 'red')
    assert.equal(line('approved', { hasOrder: true }).text, 'Approved · Order created')
    assert.equal(line('submitted').text, 'Awaiting management review')
    const html = contextHtml()
    assert.ok((html.match(/class="pi-detail-context-line-label"/g) ?? []).length >= 1,
      'each dot sits beside a word saying what it means')
    assert.ok(/class="pi-detail-context-dot"[^>]*aria-hidden="true"/.test(html))
  })
})

// ── 2. The PI overview ───────────────────────────────────────────────────────

/** The breakdown's own rows, so the card's figures come from where they will
 *  in the page: one array, shared by the overview and the breakdown. */
const COMMERCIAL_ROWS = commercialBreakdownRows(buildCommercialRows(persistedCommercial(submission())))

const summaryHtml = (over: {
  client?: Parameters<typeof buildClientDetails>[0]
  confirmed?: string | null
  dates?: ReturnType<typeof buildDateSummary>
  figures?: ReturnType<typeof summaryCommercialFigures>
  billing?: ReturnType<typeof buildBillingSummary>
  canEditBilling?: boolean
  canEditDetails?: boolean
  onRequestCorrection?: (() => void) | null
  missingSummary?: string | null
  workbookName?: string | null
} = {}) => renderToStaticMarkup(
  <PiSummaryCard
    canEditDetails={over.canEditDetails ?? false}
    onEditDetails={() => {}}
    onEditSchedule={() => {}}
    onRequestCorrection={over.onRequestCorrection ?? null}
    missingSummary={over.missingSummary ?? null}
    workbookName={over.workbookName === undefined ? 'Kalyan-PI-Aug.xlsx' : over.workbookName}
    onOpenClient={() => {}}
    client={buildClientDetails(over.client ?? {
      clientName: 'Kalyan Interiors',
      clientCity: 'Bengaluru',
      billToName: 'Kalyan Interiors',
      shipToName: 'Kalyan Interiors',
      billToPhone: '+91 98450 22222',
      shipToPhone: null,
      billingAddress: '12 Residency Road\nBengaluru 560025',
      shippingAddress: null,
    })}
    dates={over.dates ?? buildDateSummary({ confirmed: over.confirmed ?? '31 Jan 2026' })}
    figures={over.figures ?? summaryCommercialFigures(COMMERCIAL_ROWS)}
    billing={over.billing ?? buildBillingSummary({ raw: null, totalBeforeGst: 742850 })}
    canEditBilling={over.canEditBilling ?? false}
    onEditBilling={() => {}}
  />,
)

describe('the card headed by the client name carries the CLIENT, and nobody else', () => {
  test('THE BOE SIDE IS GONE from under the client name', () => {
    const t = text(summaryHtml())
    // Each of these used to sit in a four-item strip under the client's name,
    // where three BOE facts and a date read as the client's own.
    for (const gone of ['Salesperson', 'Salesperson contact', 'PI submitted by', 'Created date']) {
      assert.ok(!t.includes(gone), `${gone} belongs to the context row now, not to the client`)
    }
    for (const retired of ['PI created by', 'Sales candidate', 'Sales Candidate', 'Assignee']) {
      assert.ok(!t.includes(retired), `${retired} is a second word for somebody already named`)
    }
  })

  test('the salesperson’s number is nowhere near the client’s contact line', () => {
    // order_submissions.contact_number is the BOE-side number at workbook G22.
    // It is the one value that must never be printed as the client's, because
    // a reader who presses "call the client" would be dialling BOE.
    const html = summaryHtml({ client: {
      clientName: 'Kalyan Interiors', clientCity: 'Bengaluru',
      billToName: 'Kalyan Interiors', shipToName: null,
      billToPhone: '+91 98450 22222', shipToPhone: null,
      billingAddress: null, shippingAddress: null,
    } })
    const sections = readFileSync(
      join(process.cwd(), 'src/app/orders/drafts/[submissionId]/piDetailSections.tsx'), 'utf8')
    assert.ok(!sections.includes('contact_number'), 'the card never reads that column')
    assert.ok(!sections.includes('salespersonPhone'))
    assert.ok(text(html).includes('+91 98450 22222'), 'the number shown is the client’s own')
  })

  test('the client’s two facts sit in the strip, each labelled and iconed once', () => {
    const html = summaryHtml()
    const t = text(html)
    for (const label of [CLIENT_CONTACT_LABEL, CLIENT_LOCATION_LABEL]) {
      assert.equal(t.split(label).length - 1, 1, `${label} appears once`)
    }
    assert.ok(t.includes('+91 98450 22222'), 'the client’s contact number')
    assert.ok(t.includes('Bengaluru'), 'and where they are')
    const strip = html.slice(html.indexOf('class="pi-detail-meta"'), html.indexOf('class="pi-detail-dates"'))
    assert.equal((strip.match(/aria-hidden="true"/g) ?? []).length, 2, 'two icons, both hidden')
  })

  test('a number that cannot be dialled is still shown, as the text it is', () => {
    const t = text(summaryHtml({ client: {
      clientName: 'Kalyan Interiors', clientCity: 'Bengaluru',
      billToName: null, shipToName: null,
      billToPhone: 'ext 4102', shipToPhone: null,
      billingAddress: null, shippingAddress: null,
    } }))
    assert.ok(t.includes('ext 4102'), 'what the document said beats being told there is nothing')
  })

  test('an empty contact or location is a quiet absence, not a fault', () => {
    const t = text(summaryHtml({ client: {
      clientName: 'Kalyan Interiors', clientCity: null,
      billToName: null, shipToName: null, billToPhone: null, shipToPhone: null,
      billingAddress: null, shippingAddress: null,
    } }))
    assert.equal(t.split(CLIENT_FACT_ABSENT).length - 1, 2, 'both say it the same quiet way')
    assert.ok(!t.includes('Contact not provided'))
    assert.ok(!t.includes('Location not provided'))
  })

  test('the workbook is named quietly, and a record with none shows no block', () => {
    assert.ok(text(summaryHtml()).includes('Kalyan-PI-Aug.xlsx'))
    assert.ok(!summaryHtml({ workbookName: null }).includes('pi-detail-overview-file'),
      'a labelled hole is worse than the absence')
  })

  test('there is no payment in the overview — payment has its own card', () => {
    const html = summaryHtml()
    for (const gone of ['Payment', 'Add payment', PAYMENT_DETAILS_LABEL, 'role="progressbar"']) {
      assert.ok(!html.includes(gone), `${gone} belongs to the payment status card`)
    }
  })
})

describe('the overview repeats two commercial figures, and only two', () => {
  test('each one is the Commercial breakdown’s own string, character for character', () => {
    const figures = summaryCommercialFigures(COMMERCIAL_ROWS)
    const byKey = Object.fromEntries(COMMERCIAL_ROWS.map(r => [r.key, r.value]))

    assert.equal(figures.length, 2)
    assert.deepEqual(figures.map(f => f.key), ['gross', 'beforeGst'])
    assert.equal(figures[0].value, byKey.gross, 'Product value IS Gross product amount')
    assert.equal(figures[1].value, byKey.beforeGst, 'Total before GST IS Total before GST')

    const html = text(summaryHtml())
    assert.ok(html.includes('Product value'))
    assert.ok(html.includes('Total before GST'))
    assert.ok(html.includes(byKey.gross))
    assert.ok(html.includes(byKey.beforeGst))
  })

  test('the label is the summary’s wording, the figure is the breakdown’s', () => {
    const figures = summaryCommercialFigures(COMMERCIAL_ROWS)
    assert.equal(figures[0].label, 'Product value')
    assert.equal(figures[1].label, 'Total before GST')
    assert.equal(COMMERCIAL_ROWS.find(r => r.key === 'gross')?.label, 'Gross product amount')
  })

  test('a figure the PI never stated is an em dash, never a ₹0', () => {
    const rows = commercialBreakdownRows(buildCommercialRows(
      persistedCommercial(submission({ total_before_gst: null }))))
    const beforeGst = summaryCommercialFigures(rows)[1]
    assert.equal(beforeGst.kind, 'missing')
    assert.equal(beforeGst.value, '—')
    const html = summaryHtml({ figures: summaryCommercialFigures(rows) })
    assert.ok(html.includes('class="pi-detail-figure-absent"'))
  })

  test('a genuine zero still prints as a zero', () => {
    const rows = commercialBreakdownRows(buildCommercialRows(
      persistedCommercial(submission({ gross_product_amount: 0 }))))
    const gross = summaryCommercialFigures(rows)[0]
    assert.equal(gross.kind, 'amount')
    assert.equal(gross.value, formatInr(0))
  })

  test('the rest of the breakdown stays in the breakdown', () => {
    const html = text(summaryHtml()).split('Total before GST').join('')
    for (const elsewhere of ['GST', 'Discount', 'Packing', 'Transportation', 'Subtotal', 'Fabric', 'Grand']) {
      assert.ok(!html.includes(elsewhere), `${elsewhere} belongs to the Commercial breakdown alone`)
    }
  })

  test('three figures, as three cells of one grid', () => {
    const html = summaryHtml()
    const grid = html.slice(html.indexOf('class="pi-detail-figures-grid"'))
    assert.equal((grid.match(/class="pi-detail-figure"/g) ?? []).length, 3)
  })
})

describe('the card names the client, and holds the ADDRESSES behind that name', () => {
  test('the name once, the contact and city shown, the addresses still in the dialog', () => {
    const html = text(summaryHtml())
    assert.equal((html.match(/Kalyan Interiors/g) ?? []).length, 1,
      'bill-to and ship-to are the same party here, and the name is printed once')
    assert.ok(!html.includes('Bill to') && !html.includes('Ship to'))
    assert.ok(!html.includes('12 Residency Road'), 'the address is not in the card')
    assert.ok(html.includes('98450'), 'but the client’s own number now is')
    assert.ok(!summaryHtml().includes('href="tel:'),
      'as TEXT — the dialog behind the name is the one place a number is offered to press')
  })

  test('the name is a control, and still reads as the name', () => {
    const html = summaryHtml()
    assert.ok(html.includes('pi-detail-summary-client'), 'a button carries Enter, Space and focus')
    assert.ok(html.includes('aria-haspopup="dialog"'), 'and says what it opens')
    assert.ok(html.includes('pi-detail-summary-client-more'), 'with an affordance beside it')
    const css = pageCss()
    assert.ok(/\.pi-detail-summary-client \{[^}]*background: none/.test(css))
    assert.ok(/\.pi-detail-summary-client \{[^}]*border: none/.test(css))
    assert.ok(/\.pi-detail-summary-client:focus-visible \{[^}]*outline/.test(css),
      'but it is still visibly focusable')
  })

  test('a client that gave nothing but a name still shows the name', () => {
    const html = text(summaryHtml({ client: {
      clientName: 'Kalyan Interiors', clientCity: null, billToName: null, shipToName: null,
      billToPhone: null, shipToPhone: null,
      billingAddress: null, shippingAddress: null,
    } }))
    assert.ok(html.includes('Kalyan Interiors'))
    assert.ok(!html.includes('Contact not provided'))
    assert.ok(!html.includes('Location not provided'))
    assert.equal((html.match(/Not set/g) ?? []).length, 1)
  })

  test('a number too short to dial is not offered as a link', () => {
    assert.equal(telLink('12345'), null)
    assert.equal(telLink('  '), null)
    assert.equal(telLink('n/a'), null)
    assert.deepEqual(telLink('022 4567 8900'), { label: '022 4567 8900', tel: '02245678900' })
  })
})

describe('the billing declaration, as the third figure', () => {
  const billed = (raw: unknown, totalBeforeGst: number | null = 742850) =>
    buildBillingSummary({ raw, totalBeforeGst })

  test('undeclared is a clear STATE, and offers Set to somebody who may declare one', () => {
    const html = summaryHtml({ billing: billed(null), canEditBilling: true })
    const t = text(html)
    assert.ok(t.includes('Billing percentage'))
    assert.ok(html.includes(`class="pi-detail-state-chip">${BILLING_NOT_DECLARED_LABEL}<`),
      'a chip, not a muted word standing where a figure should be')
    assert.ok(t.includes('Set'))
    const block = t.slice(t.indexOf('Billing percentage'))
    assert.ok(!/\b0%/.test(block), 'undeclared is not zero')
    assert.ok(!/\b100%/.test(block), 'and it is not "bill everything" either')
    assert.ok(!t.includes('Billing value'), 'and there is nothing to value yet')
  })

  test('declared shows the percentage as a figure, its value under it, and Edit', () => {
    const html = text(summaryHtml({ billing: billed('65.00'), canEditBilling: true }))
    assert.ok(html.includes('65%'))
    assert.ok(html.includes('Billing value'))
    assert.ok(html.includes('₹4,82,852.50'), '65% of ₹7,42,850')
    assert.ok(html.includes('Edit') && !html.includes('>Set<'))
  })

  test('a read-only viewer sees the value and NO control', () => {
    for (const raw of [null, '65.00']) {
      const html = summaryHtml({ billing: billed(raw), canEditBilling: false })
      assert.ok(!html.includes('pi-detail-summary-billing-action'),
        'no Set and no Edit for somebody who may not change it')
      assert.ok(text(html).includes(raw === null ? BILLING_NOT_DECLARED_LABEL : '65%'),
        'but the fact itself is still readable')
    }
  })

  test('the ends of the band, and a decimal, all render', () => {
    assert.ok(text(summaryHtml({ billing: billed('35.00') })).includes('35%'))
    assert.ok(text(summaryHtml({ billing: billed('100.00') })).includes('100%'))
    const half = text(summaryHtml({ billing: billed('35.50') }))
    assert.ok(half.includes('35.5%'))
    assert.ok(half.includes('₹2,63,711.75'), '35.5% of ₹7,42,850')
  })

  test('a missing pre-GST total gives no billing value, and never ₹0', () => {
    const html = text(summaryHtml({ billing: billed('65.00', null) }))
    assert.ok(html.includes('65%'), 'the declaration still stands')
    assert.ok(html.includes('Billing value'))
    assert.ok(!html.includes('₹0'), 'a total the PI never stated is not zero')
    assert.ok(html.includes('—'), 'it takes the card’s own missing treatment')
  })

  test('it changes no other figure on the card', () => {
    const plain = text(summaryHtml({ billing: billed(null) }))
    const declared = text(summaryHtml({ billing: billed('65.00') }))
    const byKey = Object.fromEntries(COMMERCIAL_ROWS.map(r => [r.key, r.value]))
    for (const untouched of [byKey.gross, byKey.beforeGst]) {
      assert.ok(plain.includes(untouched), `${untouched} missing while undeclared`)
      assert.ok(declared.includes(untouched), `${untouched} changed once declared`)
    }
  })

  test('the control follows the DATABASE’s capability, in all eight cases', () => {
    const cases = [
      { who: 'owner, draft',                    editable: true },
      { who: 'owner, needs_changes',            editable: true },
      { who: 'non-owner active admin, draft',   editable: true },
      { who: 'non-owner admin, needs_changes',  editable: true },
      { who: 'owner, submitted',                editable: false },
      { who: 'admin, submitted',                editable: false },
      { who: 'unauthorised viewer',             editable: false },
      { who: 'anyone, record has an Order',     editable: false },
    ]
    for (const c of cases) {
      const html = summaryHtml({ billing: billed(null), canEditBilling: c.editable })
      assert.equal(html.includes('pi-detail-summary-billing-action'), c.editable,
        `${c.who}: the control should be ${c.editable ? 'visible' : 'hidden'}`)
      assert.ok(text(html).includes(BILLING_NOT_DECLARED_LABEL), `${c.who}: the value is still shown`)
    }
  })

  test('and that capability is asked, never restated in the browser', () => {
    const page = read(PAGE)
    assert.ok(page.includes("supabase.rpc('can_edit_order_submission', { p_submission_id: submissionId })"),
      'the authority is asked of the database')
    assert.ok(page.includes("supabase.rpc('can_admin_edit_order_submission', { p_submission_id: submissionId })"),
      'and so is the admin authority, which the owner rule cannot answer')
    // Since 20270115000000 the billing percentage is edited inside the one Edit
    // PI, which both answers together open; the card's own control is off.
    assert.ok(page.includes('const mayEditPi = (canEditSubmission || canAdminAmend) && !piIsOrder'),
      'and both answers together are what opens Edit PI')
    assert.ok(page.includes('canEditBilling={false}'), 'the per-field billing door is no longer drawn')
    assert.ok(!/canEditBilling=\{actions\./.test(page),
      'not describeSubmissionActions, which knows only about the owner')
    const code = page
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.ok(!/users\.role|role === ['"]admin['"]/.test(code),
      'and no role is read on this page to decide an authority')
    // The id-only group now starts together with the record itself
    // (usability pass), so it is named rather than found by its await.
    const inParallel = page.slice(page.indexOf('const detailReads = Promise.all(['), page.indexOf('itemsResult.error'))
    assert.ok(inParallel.includes("supabase.rpc('can_edit_order_submission'"),
      'resolved in the existing parallel load')
    assert.ok(page.includes('editableResult.error ? false : editableResult.data === true'),
      'and a capability that could not be resolved is not a capability')
  })

  test('the RPC refuses whenever that capability is false, whatever the UI did', () => {
    const migration = readFileSync(join(process.cwd(),
      'supabase/migrations/20260923000000_order_submission_billing_percentage.sql'), 'utf8')
    const fn = migration.slice(
      migration.indexOf('create or replace function public.set_order_submission_billing_percentage'))
    assert.ok(fn.includes('if not public.can_edit_order_submission(p_submission_id) then'))
    assert.ok(fn.includes('ORDER_SUBMISSION_BILLING_NOT_EDITABLE'))
    assert.ok(fn.indexOf('for update') < fn.indexOf('can_edit_order_submission'),
      'the row is locked before the authority is asked')
  })

  test('the state chip is a quiet state, not a warning and not a card', () => {
    const css = pageCss()
    assert.ok(/\.pi-detail-state-chip \{[^}]*border-radius: 6px/.test(css))
    assert.ok(!/\.pi-detail-state-chip \{[^}]*(box-shadow|gradient|#d94f4f)/i.test(css))
  })
})

// ── 2a. Payment status ────────────────────────────────────────────────────────

// The mixed position is the default: ₹2,50,000 confirmed and ₹2,45,000 awaiting
// verification against a ₹11,80,000 PI — the figures pi_submission_payment_summary()
// would return, formatted as the page formats them.
const statusView = (over: Partial<Parameters<typeof buildPaymentStatusView>[0]> = {}): PaymentStatusView =>
  buildPaymentStatusView({
    received: '₹4,95,000',
    receivedPercent: '41.94%',
    receivedPercentValue: 41.94,
    confirmed: '₹2,50,000',
    confirmedCount: 2,
    required: '₹4,72,000',
    total: '₹11,80,000',
    standardPercent: '40%',
    standardPercentValue: 40,
    verifiedPercent: '21.18%',
    verifiedPercentValue: 21.18,
    meetsStandard: false,
    pendingCount: 1,
    pendingAmount: '₹2,45,000',
    pendingPercent: '20.76%',
    ...over,
  })

const NO_PAYMENTS = {
  received: '₹0', receivedPercent: '0%', receivedPercentValue: 0,
  confirmed: '₹0', confirmedCount: 0, verifiedPercent: '0%', verifiedPercentValue: 0,
  pendingCount: 0, pendingAmount: '₹0', pendingPercent: '0%',
}
const CONFIRMED_ONLY = {
  received: '₹2,50,000', receivedPercent: '21.18%', receivedPercentValue: 21.18,
  confirmed: '₹2,50,000', confirmedCount: 2, verifiedPercent: '21.18%', verifiedPercentValue: 21.18,
  pendingCount: 0, pendingAmount: '₹0', pendingPercent: '0%',
}
const AWAITING_ONLY = {
  received: '₹2,00,000', receivedPercent: '16.94%', receivedPercentValue: 16.94,
  confirmed: '₹0', confirmedCount: 0, verifiedPercent: '0%', verifiedPercentValue: 0,
  pendingCount: 2, pendingAmount: '₹2,00,000', pendingPercent: '16.94%',
}

type StatusCardProps = Parameters<typeof PiPaymentStatusCard>[0]

const statusProps = (over: Partial<StatusCardProps> = {}): StatusCardProps => ({
  status: statusView(),
  canAdd: false,
  canVerify: false,
  decidableCount: 0,
  onAddPayment: () => {},
  onOpenDetails: () => {},
  notice: null,
  onDismissNotice: () => {},
  ...over,
})

/**
 * The card AS OPENED. Every assertion below about figures, the bar and the
 * three controls is about the card a reader has expanded — which is the only
 * state those things exist in. The closed state has its own suite.
 *
 * PiPaymentStatusCardView is the same drawing the stateful card renders; the
 * card adds a useState and hands it down, and nothing else.
 */
const statusHtml = (over: Partial<StatusCardProps> = {}) =>
  renderToStaticMarkup(<PiPaymentStatusCardView {...openProps(over)} />)

const openProps = (over: Partial<StatusCardProps> = {}) =>
  ({ ...statusProps(over), expanded: true, onToggleExpanded: () => {} })

/** The card as the page mounts it — no props about disclosure at all. */
const closedHtml = (over: Partial<StatusCardProps> = {}) =>
  renderToStaticMarkup(<PiPaymentStatusCard {...statusProps(over)} />)

// The bar's three shares, read off the rendered track. Green, amber and red are
// the colors.green / colors.amber / colors.red tokens, pinned to the tokens in
// piPaymentDetails.render.test.tsx.
const segment = (html: string, name: 'confirmed' | 'awaiting' | 'unpaid') =>
  html.match(new RegExp(`data-segment="${name}" style="([^"]*)"`))?.[1] ?? null
const GREEN = 'background:#45A870'
const AMBER = 'background:#E8A030'
const RED = 'background:#D94F4F'

/** The element one part of the received figure was drawn as: button or div. */
const metricTag = (html: string, key: 'confirmed' | 'awaiting'): string | null =>
  html.match(new RegExp(`<(button|div)\\b[^>]*data-metric="${key}"`))?.[1] ?? null

describe('payment status: how much has been received, and what it is made of', () => {
  test('the headline is received — confirmed plus awaiting — as a share of the full PI total', () => {
    const t = text(statusHtml())
    assert.ok(t.includes('Payment status'))
    assert.ok(t.includes('41.94% received'))
    assert.ok(t.includes('₹4,95,000 received of ₹11,80,000 PI Total'))
    assert.ok(!t.includes('Required') && !t.includes('₹4,72,000'), 'the requirement is not a figure on this card')
    assert.ok(!t.includes('Confirmed %'), 'the verified-only headline is gone')
  })

  test('beside it, Confirmed and Awaiting verification — each an amount, a count and a share', () => {
    const t = text(statusHtml())
    assert.ok(t.includes('Confirmed ₹2,50,000 2 payments · 21.18% of PI Total'))
    assert.ok(t.includes('Awaiting verification ₹2,45,000 1 payment · 20.76% of PI Total'))
    assert.ok(!/failed|unpaid|non-confirmed/i.test(t), 'money waiting on Finance is never called failed or unpaid')
  })

  test('every figure comes off the view — nothing is re-added in the browser', () => {
    const t = text(statusHtml({ status: statusView({ received: '₹9,99,999', receivedPercent: '12.34%' }) }))
    assert.ok(t.includes('12.34% received') && t.includes('₹9,99,999 received of ₹11,80,000 PI Total'),
      'deliberately inconsistent figures survive unchanged')
  })

  test('no payments: 0% received, two quiet parts, and the whole track red', () => {
    const html = statusHtml({ status: statusView(NO_PAYMENTS) })
    const t = text(html)
    assert.ok(t.includes('0% received') && t.includes('₹0 received of ₹11,80,000 PI Total'))
    assert.ok(t.includes('No confirmed payments yet') && t.includes('Nothing awaiting verification'))
    assert.equal(metricTag(html, 'confirmed'), 'div')
    assert.equal(metricTag(html, 'awaiting'), 'div')
    assert.equal(segment(html, 'confirmed'), null)
    assert.equal(segment(html, 'awaiting'), null)
    assert.ok(segment(html, 'unpaid')?.includes(RED))
    assert.ok(html.includes('aria-valuenow="0"'))
  })

  test('confirmed only: green, then red for the rest — and only Confirmed opens anything', () => {
    const html = statusHtml({ status: statusView(CONFIRMED_ONLY) })
    assert.ok(text(html).includes('21.18% received'))
    assert.equal(metricTag(html, 'confirmed'), 'button')
    assert.equal(metricTag(html, 'awaiting'), 'div')
    assert.ok(segment(html, 'confirmed')?.includes('width:21.18%'))
    assert.ok(segment(html, 'confirmed')?.includes(GREEN))
    assert.equal(segment(html, 'awaiting'), null)
    assert.ok(segment(html, 'unpaid')?.includes(RED))
  })

  test('awaiting verification only: amber for that share, red for the balance', () => {
    const html = statusHtml({ status: statusView(AWAITING_ONLY) })
    assert.ok(text(html).includes('16.94% received'))
    assert.equal(metricTag(html, 'confirmed'), 'div')
    assert.equal(metricTag(html, 'awaiting'), 'button')
    assert.equal(segment(html, 'confirmed'), null)
    assert.ok(segment(html, 'awaiting')?.includes('width:16.94%'))
    assert.ok(segment(html, 'awaiting')?.includes(AMBER))
    assert.ok(segment(html, 'unpaid')?.includes(RED))
  })

  test('mixed: green, amber, then red for the part not yet received', () => {
    const html = statusHtml()
    assert.equal(metricTag(html, 'confirmed'), 'button')
    assert.equal(metricTag(html, 'awaiting'), 'button')
    assert.ok(segment(html, 'confirmed')?.includes('width:21.18%'))
    assert.ok(segment(html, 'awaiting')?.includes('width:20.76%'))
    assert.ok(segment(html, 'unpaid')?.includes(RED), 'the remaining unpaid portion is red')
    assert.ok(html.includes('aria-valuenow="42"'))
  })

  test('below, exactly at and above 40%: the tick marks the requirement and changes no colour', () => {
    const cases = [
      { receivedPercent: '39.99%', receivedPercentValue: 39.99, verifiedPercent: '39.99%', verifiedPercentValue: 39.99, pendingCount: 0 },
      { receivedPercent: '40%', receivedPercentValue: 40, verifiedPercent: '25%', verifiedPercentValue: 25 },
      { receivedPercent: '75%', receivedPercentValue: 75, verifiedPercent: '60%', verifiedPercentValue: 60, meetsStandard: true },
    ]
    for (const over of cases) {
      const html = statusHtml({ status: statusView(over) })
      assert.ok(html.includes('left:40%'), 'the 40% marker stays on the bar')
      assert.ok(segment(html, 'confirmed')?.includes(GREEN))
      assert.ok(segment(html, 'unpaid')?.includes(RED), 'meeting the advance does not stop the rest being red')
      assert.ok(text(html).includes('40% advance marker'))
      assert.ok(text(html).includes(`${over.receivedPercent} received`))
    }
    assert.equal(segment(statusHtml({ status: statusView(cases[0]) }), 'awaiting'), null)
    assert.ok(segment(statusHtml({ status: statusView(cases[1]) }), 'awaiting')?.includes('width:15%'))
    assert.ok(segment(statusHtml({ status: statusView(cases[2]) }), 'awaiting')?.includes('width:15%'))
  })

  test('100% confirmed: the track is entirely green', () => {
    const html = statusHtml({ status: statusView({
      received: '₹11,80,000', receivedPercent: '100%', receivedPercentValue: 100,
      confirmed: '₹11,80,000', confirmedCount: 3, verifiedPercent: '100%', verifiedPercentValue: 100,
      pendingCount: 0, pendingAmount: '₹0', pendingPercent: '0%', meetsStandard: true,
    }) })
    assert.ok(text(html).includes('100% received'))
    assert.ok(segment(html, 'confirmed')?.includes('width:100%'))
    assert.equal(segment(html, 'awaiting'), null)
    assert.equal(segment(html, 'unpaid'), null, 'no red share on the track — only the legend keeps its red swatch')
  })

  test('overpayment: the true figure is printed and the track is capped at full', () => {
    const view = statusView({
      received: '₹12,50,000', receivedPercent: '105.93%', receivedPercentValue: 105.93,
      confirmed: '₹12,50,000', confirmedCount: 3, verifiedPercent: '105.93%', verifiedPercentValue: 105.93,
      pendingCount: 0, pendingAmount: '₹0', pendingPercent: '0%', meetsStandard: true,
    })
    assert.equal(view.barPercent, 100)
    assert.equal(view.receivedBarPercent, 100)
    const html = statusHtml({ status: view })
    assert.ok(text(html).includes('105.93% received'), 'the percentage is the database’s, uncapped')
    assert.ok(text(html).includes('₹12,50,000 received of ₹11,80,000 PI Total'))
    assert.ok(segment(html, 'confirmed')?.includes('width:100%'))
    assert.equal(segment(html, 'unpaid'), null)
  })

  test('a bar width is a width, never a figure', () => {
    assert.equal(barWidth(null), 0)
    assert.equal(barWidth(Number.NaN), 0)
    assert.equal(barWidth(-5), 0)
    assert.equal(barWidth(40), 40)
    assert.equal(statusView({ receivedPercentValue: 10 }).receivedBarPercent, 21.18,
      'received never draws short of confirmed')
    assert.equal(statusView({ receivedPercentValue: null }).receivedBarPercent, 21.18)
  })

  test('a PI with no total leads with the amount rather than a dash', () => {
    const t = text(statusHtml({ status: statusView({ receivedPercent: '—', receivedPercentValue: null, total: '—' }) }))
    assert.ok(t.includes('₹4,95,000 received') && t.includes('PI Total not available'))
  })

  test('an unknown requirement is a dash, and no note or tick label is invented for it', () => {
    const view = statusView({ required: null, standardPercent: null, standardPercentValue: null })
    assert.equal(view.required, '—')
    assert.equal(view.requiredNote, null)
    assert.equal(view.thresholdLabel, null)
    assert.ok(!text(statusHtml({ status: view })).includes('advance marker'))
  })
})

// The card as a tree of elements rather than markup, so a press can be made.
// Every component on this path is a plain function of its props, so each is
// called directly: nothing is mounted, nothing fetches.
type AnyElement = { type: unknown; props: Record<string, unknown> }
const isElement = (node: unknown): node is AnyElement =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

function pressables(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) pressables(child, out)
    return out
  }
  if (!isElement(node)) return out
  if (typeof node.type === 'function') {
    return pressables((node.type as (props: unknown) => unknown)(node.props), out)
  }
  if (typeof node.props.onClick === 'function') out.push(node)
  pressables(node.props.children, out)
  return out
}

const labelOf = (control: AnyElement): string =>
  text(renderToStaticMarkup(control as unknown as Parameters<typeof renderToStaticMarkup>[0])).trim()

describe('each part opens the rows it is made of', () => {
  test('Confirmed opens confirmed rows, Awaiting verification the pending ones, Payment details all of them', () => {
    const opened: string[] = []
    const controls = pressables(PiPaymentStatusCardView(openProps({
      canAdd: true, canVerify: true, decidableCount: 1,
      onAddPayment: () => opened.push('add'),
      onOpenDetails: filter => opened.push(filter),
    })))
    const press = (prefix: string) => {
      const control = controls.find(c => labelOf(c).startsWith(prefix))
      assert.ok(control, `${prefix} must be pressable`)
      ;(control.props.onClick as () => void)()
    }
    press('Confirmed')
    press('Awaiting verification')
    press('Payment details')
    press('Verify 1 pending')
    press('Add payment')
    assert.deepEqual(opened, ['confirmed', 'awaiting', 'all', 'awaiting', 'add'])
  })

  test('a part with nothing behind it cannot be pressed at all', () => {
    const controls = pressables(PiPaymentStatusCardView(openProps({ status: statusView(NO_PAYMENTS) })))
    assert.deepEqual(controls.map(labelOf).filter(l => l !== PAYMENT_STATUS_TITLE),
      [PAYMENT_DETAILS_LABEL], 'only the way into every row remains')
  })

  test('only native buttons answer a press, so every control is reachable by keyboard', () => {
    const controls = pressables(PiPaymentStatusCardView(openProps({ canAdd: true, canVerify: true, decidableCount: 1 })))
    assert.equal(controls.length, 6, 'the five it always had, plus the disclosure header')
    for (const control of controls) {
      assert.equal(control.type, 'button', 'no clickable div')
      assert.equal(control.props.type, 'button')
    }
    const html = statusHtml()
    assert.ok(!html.includes('tabindex'))
    assert.equal((html.match(/<button[^>]*data-metric="[a-z]+"[^>]*aria-haspopup="dialog"/g) ?? []).length, 2,
      'each part announces that it opens a dialog')
  })

  test('hover and keyboard focus are visible; an empty part keeps a plain cursor', () => {
    const css = pageCss()
    assert.ok(/button\.pi-detail-paystatus-metric \{[^}]*cursor: pointer/.test(css))
    assert.ok(/button\.pi-detail-paystatus-metric-confirmed:hover \{[^}]*background/.test(css))
    assert.ok(/button\.pi-detail-paystatus-metric-awaiting:hover \{[^}]*background/.test(css))
    assert.ok(/button\.pi-detail-paystatus-metric:focus-visible \{[^}]*outline: 2px solid/.test(css))
    assert.ok(/\.pi-detail-payfilter:focus-visible \{[^}]*outline: 2px solid/.test(css))
    assert.ok(!/^\.pi-detail-paystatus-metric(\.is-empty)? \{[^}]*cursor: pointer/m.test(css),
      'the pointer cursor belongs to the button form alone')
  })
})

describe('the card’s actions keep their gates and their place', () => {
  test('Add payment only where the gate allows; Payment details for everybody', () => {
    assert.ok(buttonLabels(statusHtml({ canAdd: true })).includes('Add payment'))
    assert.ok(!buttonLabels(statusHtml({ canAdd: false })).includes('Add payment'))
    assert.ok(buttonLabels(statusHtml()).includes(PAYMENT_DETAILS_LABEL))
  })

  test('the verify control is drawn only for a payment verifier with something to decide', () => {
    const has = (html: string) => buttonLabels(html).some(l => /^Verify \d+ pending$/.test(l))
    assert.ok(!has(statusHtml({ canVerify: false, decidableCount: 2 })), 'no authority, no control')
    assert.ok(!has(statusHtml({ canVerify: true, decidableCount: 0 })), 'nothing pending, no control')
    assert.ok(buttonLabels(statusHtml({ canVerify: true, decidableCount: 2 })).includes('Verify 2 pending'))
  })

  test('the actions sit together at the top of the opened card, once each', () => {
    const html = statusHtml({ canAdd: true, canVerify: true, decidableCount: 2 })
    const top = text(html.slice(html.indexOf('pi-detail-paystatus-actions'), html.indexOf('pi-detail-paystatus-body')))
    for (const label of ['Verify 2 pending', 'Add payment', PAYMENT_DETAILS_LABEL]) {
      assert.equal(buttonLabels(html).filter(l => l === label).length, 1, `${label} once`)
      assert.ok(top.includes(label), `${label} above the figures`)
    }
  })

  test('no payment action is duplicated in Management review', () => {
    const sections = read(SECTIONS)
    const panel = sections.slice(sections.indexOf('export function PiWorkflowPanel('),
      sections.indexOf('// ── Finance verification, as one line'))
    assert.ok(panel.length > 0)
    for (const leak of ['onOpenDetails', 'onAddPayment', 'Add payment', 'PAYMENT_DETAILS_LABEL', 'decidableCount', 'PiPaymentMetric']) {
      assert.ok(!panel.includes(leak), `${leak} belongs to the payment status card`)
    }
  })

  test('nothing is shown or guessed until the summary has been read', () => {
    const html = statusHtml({ status: null })
    assert.ok(text(html).includes('Loading…'))
    assert.ok(!text(html).includes('received'))
    assert.ok(!html.includes('role="progressbar"'))
    assert.ok(!html.includes('data-metric'))
  })
})

describe('payment status opens closed, and is a real disclosure', () => {
  test('EVERY new page load starts collapsed — nothing is remembered anywhere', () => {
    const html = closedHtml({ canAdd: true, canVerify: true, decidableCount: 2 })
    assert.ok(html.includes('aria-expanded="false"'), 'the card the page mounts is shut')
    assert.equal((html.match(/aria-expanded=/g) ?? []).length, 1, 'one trigger, not one per control')
    const sections = read(SECTIONS)
    const card = sections.slice(sections.indexOf('export function PiPaymentStatusCard('))
    assert.ok(card.includes('useState(false)'), 'and it is local state, closed to begin with')
    for (const persisted of ['localStorage', 'sessionStorage', 'supabase', 'searchParams']) {
      assert.ok(!card.includes(persisted), `the open state must not be kept in ${persisted}`)
    }
  })

  test('the closed card shows its name, a hint and a chevron — and NOT ONE FIGURE', () => {
    const html = closedHtml({ canAdd: true, canVerify: true, decidableCount: 2, notice: 'Payment recorded' })
    const t = text(html)
    assert.ok(t.includes(PAYMENT_STATUS_TITLE))
    assert.ok(t.includes(PAYMENT_COLLAPSED_HINT))
    assert.ok(html.includes('pi-detail-paystatus-chevron'), 'with a visible expand indicator')

    // The amounts, the shares and the bar.
    for (const figure of ['₹', '%', 'received', 'Confirmed', 'Awaiting verification']) {
      assert.ok(!t.includes(figure), `${figure} must not be readable while the card is shut`)
    }
    assert.ok(!html.includes('role="progressbar"'), 'no progress bar')
    assert.ok(!html.includes('data-metric'), 'no confirmed/awaiting blocks')
    assert.ok(!html.includes('data-segment'), 'no bar segments')

    // The payment COUNT, which the verify control would otherwise announce.
    assert.ok(!t.includes('Verify 2 pending'), 'no payment-count information')
    assert.ok(!/\d+ payment/.test(t))

    // And every control that acts on money.
    for (const control of ['Add payment', PAYMENT_DETAILS_LABEL]) {
      assert.ok(!buttonLabels(html).includes(control), `${control} is behind the disclosure`)
    }
    assert.equal(buttonLabels(html).length, 1, 'the header is the only thing to press')
  })

  test('opening it reveals the whole card, with every control it always had', () => {
    const open = statusHtml({ canAdd: true, canVerify: true, decidableCount: 2 })
    const t = text(open)
    assert.ok(open.includes('aria-expanded="true"'))
    assert.ok(!t.includes(PAYMENT_COLLAPSED_HINT), 'the hint has done its job and gone')
    for (const part of ['received', 'Confirmed', 'Awaiting verification', 'PI Total']) {
      assert.ok(t.includes(part), `${part} is back`)
    }
    assert.ok(open.includes('role="progressbar"'))
    assert.ok(open.includes('data-segment="confirmed"'))
    for (const control of ['Verify 2 pending', 'Add payment', PAYMENT_DETAILS_LABEL]) {
      assert.ok(buttonLabels(open).includes(control), `${control} is offered again`)
    }
  })

  test('closing it hides them again — the same props, the other state', () => {
    const props = { canAdd: true, canVerify: true, decidableCount: 2 } as const
    const open = statusHtml(props)
    const shut = renderToStaticMarkup(
      <PiPaymentStatusCardView {...statusProps(props)} expanded={false} onToggleExpanded={() => {}} />)
    assert.ok(text(open).includes('₹') && !text(shut).includes('₹'))
    assert.ok(open.includes('role="progressbar"') && !shut.includes('role="progressbar"'))
    for (const control of ['Verify 2 pending', 'Add payment', PAYMENT_DETAILS_LABEL]) {
      assert.ok(buttonLabels(open).includes(control))
      assert.ok(!buttonLabels(shut).includes(control), `${control} is hidden again`)
    }
  })

  test('aria-expanded follows the state, and names the panel it controls', () => {
    const shut = closedHtml()
    const open = statusHtml()
    assert.ok(shut.includes('aria-expanded="false"'))
    assert.ok(open.includes('aria-expanded="true"'))
    const named = open.match(/aria-controls="([^"]+)"/)
    assert.ok(named, 'the trigger says what it opens')
    assert.equal(named![1], PAYMENT_PANEL_ID)
    assert.ok(open.includes(`id="${PAYMENT_PANEL_ID}"`), 'and that panel is in the tree once open')
    // The chevron turns over, so the direction is not carried by the word alone.
    const chevron = (html: string) =>
      html.match(/class="lucide lucide-(chevron-[a-z]+) pi-detail-paystatus-chevron"/)?.[1] ?? null
    assert.equal(chevron(shut), 'chevron-down', 'shut: points to what opening would reveal')
    assert.equal(chevron(open), 'chevron-up', 'open: points back to closing it')
  })

  test('the trigger is a real button with a visible focus ring and a tappable header', () => {
    const html = closedHtml()
    assert.ok(/<button[^>]*class="pi-detail-paystatus-toggle"/.test(html), 'a button, not a clickable div')
    assert.ok(html.includes('type="button"'))
    assert.ok(!html.includes('tabindex'), 'keyboard reach comes from the element, not a tabindex')
    const css = pageCss()
    assert.ok(/\.pi-detail-paystatus-toggle:focus-visible {[^}]*outline: 2px solid/.test(css))
    assert.ok(/\.pi-detail-paystatus-toggle {[^}]*min-height: 44px/.test(css), 'the project’s tap minimum')
    assert.ok(/\.pi-detail-paystatus-toggle {[^}]*width: 100%/.test(css), 'the FULL header is the control')
  })

  test('the disclosure conceals; it decides nothing', () => {
    // A viewer with no authority is offered no control in EITHER state — the
    // gate is the prop it always was, and hiding is not a permission.
    const open = statusHtml({ canAdd: false, canVerify: false, decidableCount: 2 })
    assert.ok(!buttonLabels(open).includes('Add payment'))
    assert.ok(!buttonLabels(open).some(l => /^Verify \d+ pending$/.test(l)))
    const sections = read(SECTIONS)
    const card = sections.slice(sections.indexOf('export function PiPaymentStatusCardView('))
    for (const decided of ['canApprove', 'getEffectivePermissions', 'role ===', 'supabase']) {
      assert.ok(!card.includes(decided), `${decided} is not the card’s to decide`)
    }
  })

  test('the two decision cards stay top-aligned, so a shut card leaves no hole', () => {
    const css = pageCss()
    const grid = css.slice(css.indexOf('@container (min-width: 900px)'))
    const block = grid.slice(0, grid.indexOf('}\r\n}') + 3 || grid.indexOf('\n}\n}') + 3)
    assert.ok(/align-items: start/.test(block.slice(0, 600)),
      'the grid must not stretch Payment status to the review card’s height')
  })
})

describe('the client dialog answers billing and shipping separately', () => {
  const both = {
    clientName: 'Kalyan Interiors', clientCity: 'Bengaluru',
    billToName: 'Kalyan Interiors',
    shipToName: 'Kalyan Interiors',
    billToPhone: '+91 98450 22222', shipToPhone: null,
    billingAddress: '12 Residency Road\nBengaluru 560025',
    shippingAddress: '12 Residency Road\nBengaluru 560025',
  }
  const dialog = (over: Partial<Parameters<typeof buildClientDetails>[0]> = {}) =>
    renderToStaticMarkup(
      <PiClientDetailsModal client={buildClientDetails({ ...both, ...over })} onClose={() => {}} />)

  test('IDENTICAL addresses are still shown twice, under their own headings', () => {
    // The card was right to merge them into one line. A details dialog is where
    // somebody checks where an order is going, and "same as billing" is an
    // answer they must be shown rather than left to infer from an absence.
    const html = text(dialog())
    assert.ok(html.includes('Billing details'))
    assert.ok(html.includes('Shipping details'))
    assert.equal((html.match(/12 Residency Road/g) ?? []).length, 2,
      'both questions are answered, even with the same answer')
  })

  test('an absent value says so, in the dialog, rather than leaving a gap', () => {
    const html = text(dialog({ billToPhone: null, shippingAddress: null }))
    assert.ok(html.includes('Billing details') && html.includes('Shipping details'))
    assert.ok(html.includes(NOT_PROVIDED))
  })

  test('a dialable number is a tel: link; one that is not stays text', () => {
    assert.ok(dialog().includes('href="tel:+919845022222"'))
    const short = dialog({ billToPhone: '1234', shipToPhone: null })
    assert.ok(!short.includes('href="tel:'), 'nothing offers to dial four digits')
    assert.ok(text(short).includes('1234'), 'but what the document said is still shown')
  })

  test('it is announced as a modal, with a name and a way out', () => {
    const html = dialog()
    assert.ok(html.includes('role="dialog"'))
    assert.ok(html.includes('aria-modal="true"'))
    assert.ok(/aria-label="Client details"/.test(html))
    assert.ok(text(html).includes('Client details'), 'and titled on screen')
  })

  test('focus goes in, cannot get out, and comes back', () => {
    // aria-modal="true" tells assistive technology the rest of the page is
    // inert. Without these three moves that was a lie: Tab walked out of the
    // dialog into the payment controls behind it, and closing left focus on
    // <body>. Verified in a browser as well as here.
    const source = readFileSync(
      join(process.cwd(), 'src/components/orders/piReviewModals.tsx'), 'utf8')
    const dialog = source.slice(source.indexOf('export function PiClientDetailsModal'))
    assert.ok(dialog.includes('const opener = document.activeElement'), 'remembers the opener')
    assert.ok(dialog.includes('dialogRef.current?.focus()'), 'focuses the dialog on open')
    assert.ok(/return \(\) => \{ opener\?\.focus\?\.\(\) \}/.test(dialog), 'restores it on close')
    assert.ok(dialog.includes('resolveTrapTarget('), 'traps Tab with the shared helper')
    assert.ok(dialog.includes("e.key !== 'Tab'") && dialog.includes('e.shiftKey'),
      'in both directions')
    assert.ok(dialog.includes("addEventListener('keydown', onKey, true)"),
      'in the capture phase, so nothing inside can swallow the key first')
    assert.ok(dialog.includes("if (e.key === 'Escape') { onClose(); return }"))
    assert.ok(dialog.includes('tabIndex={-1}'), 'and the panel itself can hold focus')
  })

  test('it reads the page’s own values — no request, no route', () => {
    const page = readFileSync(
      join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8')
    assert.ok(page.includes('<PiClientDetailsModal client={clientDetails}'),
      'the object already built for the card is the object the dialog shows')
    const source = readFileSync(
      join(process.cwd(), 'src/components/orders/piReviewModals.tsx'), 'utf8')
    // BOUNDED to this component. The file gained a second dialog after it, and a
    // slice running to end-of-file would be judging that one's code as well.
    const from = source.indexOf('export function PiClientDetailsModal')
    const next = source.indexOf('export function ', from + 10)
    const dialogSource = source.slice(from, next > from ? next : undefined)
    // Names what it means. `useEffect` used to be on this list as a proxy for
    // "does not fetch" — the dialog has two effects now, both about focus, and
    // a guard that would fail on those is guarding the wrong thing.
    for (const forbidden of ['supabase', 'fetch(', 'router', 'href="/', 'useState']) {
      assert.ok(!dialogSource.includes(forbidden),
        `the dialog must not ${forbidden} — every value is already on the page`)
    }
    assert.ok(!/useEffect\([\s\S]{0,400}?(await|then\()/.test(dialogSource),
      'and no effect of its own goes and gets anything')
  })
})

describe('the overview states the two dates it has, large, and pauses the one it does not', () => {
  test('the confirm date is shown as a date', () => {
    const html = text(summaryHtml({ confirmed: '31 Jan 2026' }))
    assert.ok(html.includes('Confirm date'))
    assert.ok(html.includes('31 Jan 2026'))
  })

  test('the dates band holds the two schedule dates and nothing else', () => {
    const html = summaryHtml()
    const band = html.slice(html.indexOf('class="pi-detail-dates"'), html.indexOf('class="pi-detail-figures"'))
    const labels = [...band.matchAll(/class="pi-detail-date-label">([^<]+)</g)].map(m => m[1])
    assert.deepEqual(labels, ['Confirm date', 'Due date'])
    const t = text(html)
    assert.ok(!t.includes('Dispatch'))
    assert.ok(!t.includes('weeks from date of confirmation'))
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
    assert.ok(!html.includes('Commitment:'), 'one answer beside a real date, not two')
  })

  test('a confirm date the PI never gave says so rather than showing a dash', () => {
    const html = text(summaryHtml({ confirmed: null }))
    assert.ok(html.includes('Confirm date'))
    assert.ok(!html.includes('—'))
  })

  test('the date VALUES carry the weight — materially larger and heavier than their labels', () => {
    const css = pageCss()
    const size = (cls: string) => Number(new RegExp(`\\.${cls} \\{[^}]*font-size: ([\\d.]+)px`).exec(css)?.[1])
    const weight = (cls: string) => Number(new RegExp(`\\.${cls} \\{[^}]*font-weight: (\\d+)`).exec(css)?.[1])
    assert.ok(size('pi-detail-date-value') >= 20, 'a date reads at a glance')
    assert.ok(size('pi-detail-date-value') >= size('pi-detail-date-label') * 1.6,
      'the value, not the label, is what grew')
    assert.ok(weight('pi-detail-date-value') >= 700)
    assert.ok(size('pi-detail-date-note') <= 11.5, 'the commitment stays secondary')
  })
})

describe('the overview drops what the old one spent space on', () => {
  const html = text(summaryHtml())

  test('no standalone Grand Total, no product count, no shouted headings', () => {
    assert.ok(!html.includes('Grand Total'))
    assert.ok(!/product line/.test(html))
    assert.ok(!html.includes('Commercial snapshot'))
    assert.ok(!html.includes('Verified payment required'),
      'the approval badge belongs with the approval controls, not the summary')
  })
})

// ── 2b. The workflow panel, beside the context row ────────────────────────────

describe('Management review: every decision state keeps a readable approval control', () => {
  const row = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
  })
  type Decision = NonNullable<Parameters<typeof PiWorkflowPanel>[0]['decision']>

  const render = (decision: Decision, acting = false) => {
    const s = viewerState(row, { id: REVIEWER, canReview: true })
    return renderToStaticMarkup(
      <PiWorkflowPanel
        panel={s.panel}
        actions={s.actions}
        status={row.status}
        reviewNote={null}
        employeeReply={null}
        advanceRefusal={null}
        readiness={null}
        onFixReadiness={null}
        blockingCount={0}
        acting={acting}
        approvalBlocker={s.readiness.blocker}
        approvalReady={s.readiness.ready}
        decision={decision}
        approvedOrder={null}
        onChangePi={() => {}}
        onSubmit={() => {}}
        onRequestChanges={() => {}}
        onReject={() => {}}
        onApprove={() => {}}
        onOpenOrder={() => {}}
        advanceBand={null}
        statusShownAbove
      />,
    )
  }
  /** The green approval control: its opening-tag attributes and its label. */
  const approval = (html: string) => {
    const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .filter(m => m[1].includes('pi-approve-btn'))
    assert.equal(found.length, 1, 'exactly one approval control')
    return { attrs: found[0][1], label: text(found[0][2]).trim() }
  }

  test('before approval: Approve PI & Create Order, enabled, styled by class alone', () => {
    const b = approval(render({ mode: 'approve_and_create', label: 'Approve PI & Create Order', rpc: 'approve_order_submission', note: null }))
    assert.equal(b.label, 'Approve PI & Create Order')
    assert.ok(!b.attrs.includes('disabled'))
    assert.ok(!b.attrs.includes('style='), 'no inline colour to fight the readable states')
  })

  test('the PI can be approved while the Order waits: Approve PI, with its note', () => {
    const html = render({ mode: 'approve_pi', label: 'Approve PI', rpc: 'approve_pi_review', note: 'The PI can be approved now; the Confirmed Order waits for the payment condition: 40% verified' })
    const b = approval(html)
    assert.equal(b.label, 'Approve PI')
    assert.ok(!b.attrs.includes('disabled'))
    assert.ok(text(html).includes('The PI can be approved now'))
  })

  test('after PI approval, awaiting payment: the control is disabled but keeps the readable class, and the note says why', () => {
    const html = render({ mode: 'awaiting_payment', label: null, rpc: null, note: 'PI approved. The Confirmed Order will be created once the payment condition is cleared: 40% verified' })
    const b = approval(html)
    assert.ok(b.attrs.includes('disabled=""'))
    assert.ok(!b.attrs.includes('style='))
    assert.ok(text(html).includes('PI approved. The Confirmed Order will be created'))
  })

  test('Create Order available: Create Confirmed Order, enabled', () => {
    const b = approval(render({ mode: 'create_order', label: 'Create Confirmed Order', rpc: 'approve_order_submission', note: null }))
    assert.equal(b.label, 'Create Confirmed Order')
    assert.ok(!b.attrs.includes('disabled'))
  })

  test('a busy panel disables the approval control without losing its readable styling', () => {
    const b = approval(render({ mode: 'create_order', label: 'Create Confirmed Order', rpc: 'approve_order_submission', note: null }, true))
    assert.ok(b.attrs.includes('disabled=""'))
    assert.ok(b.attrs.includes('class="boe-btn boe-btn-primary pi-approve-btn"'))
  })

  test('the review decisions stay in the review card: no payment control appears here', () => {
    const html = render({ mode: 'create_order', label: 'Create Confirmed Order', rpc: 'approve_order_submission', note: null })
    for (const label of buttonLabels(html)) {
      assert.ok(!/payment/i.test(label), `${label} belongs to Payment status`)
    }
  })
})

describe('the workflow panel does not repeat what the context row already says', () => {
  const submitted = submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
  })

  const panelHtml = (
    row: PersistedSubmission,
    viewer: Parameters<typeof viewerState>[1],
    statusShownAbove: boolean,
    piApprovedLine: string | null = null,
  ) => {
    const s = viewerState(row, viewer)
    return renderToStaticMarkup(
      <PiWorkflowPanel
        panel={s.panel}
        actions={s.actions}
        status={row.status}
        reviewNote={row.review_note}
        employeeReply={null}
        advanceRefusal={null}
        readiness={null}
        onFixReadiness={null}
        blockingCount={0}
        acting={false}
        approvalBlocker={s.readiness.blocker}
        approvalReady={s.readiness.ready}
        piApprovedLine={piApprovedLine}
        approvedOrder={s.approvedOrder}
        onChangePi={() => {}}
        onSubmit={() => {}}
        onRequestChanges={() => {}}
        onReject={() => {}}
        onApprove={() => {}}
        onOpenOrder={() => {}}
        advanceBand={null}
        statusShownAbove={statusShownAbove}
      />,
    )
  }

  test('the owner of a submitted PI, with nothing to press, gets no second status card', () => {
    const owner = { id: OWNER, canCreate: true }
    assert.ok(text(panelHtml(submitted, owner, false)).includes('Submitted by'),
      'on its own the panel still says who and when')
    assert.equal(panelHtml(submitted, owner, true), '',
      'beside the context row it has nothing left to say')
  })

  test('a reviewer keeps every decision, without the metadata line or the finance sentence', () => {
    const html = panelHtml(submitted, { id: REVIEWER, canReview: true }, true)
    const labels = buttonLabels(html)
    for (const label of [REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL]) {
      assert.ok(labels.includes(label), `${label} must survive`)
    }
    assert.ok(!text(html).includes('Submitted by'))
    assert.ok(!text(html).includes('Finance verification pending'))
  })

  test('a standing PI decision is said once', () => {
    const line = 'PI approved by Rohit Verma · 04 Aug 2026, 10:00 am'
    const reviewer = { id: REVIEWER, canReview: true }
    assert.ok(text(panelHtml(submitted, reviewer, false, line)).includes(line))
    assert.ok(!text(panelHtml(submitted, reviewer, true, line)).includes(line))
  })

  test('the page asks for exactly that', () => {
    assert.ok(/statusShownAbove\s*\/>/.test(read(PAGE)))
  })
})

// ── 6a. The commercial breakdown card ─────────────────────────────────────────

describe('the commercial breakdown leads with the PI total and keeps only lines that say something', () => {
  const rows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(submission())))
  const view = buildBreakdownView(rows)
  const html = renderToStaticMarkup(<PiCommercialBreakdown view={view} />)

  test('the PI total is large, first, and the builder’s own string', () => {
    const total = rows.find(r => r.key === 'grandTotal')
    assert.ok(total)
    assert.equal(view.total?.value, total.value)
    assert.ok(html.includes(`class="pi-detail-breakdown-total-value">${total.value}<`))
    assert.ok(html.indexOf('pi-detail-breakdown-total') < html.indexOf('pi-detail-breakdown-rows'))
    assert.ok(!view.rows.some(r => r.key === 'grandTotal'), 'and it is not repeated as a row')
  })

  test('every line shown is the shared builder’s string, character for character', () => {
    for (const shown of view.rows) {
      assert.equal(shown.value, rows.find(r => r.key === shown.key)?.value, shown.key)
    }
  })

  test('no line the PI never stated, none marked not applicable, and never the advance', () => {
    const keys = view.rows.map(r => r.key)
    for (const hidden of rows.filter(r => r.kind === 'missing' || r.kind === 'notApplicable')) {
      assert.ok(!keys.includes(hidden.key), `${hidden.key} says nothing here`)
    }
    assert.ok(!keys.includes('advance'))
    assert.ok(!text(html).includes('Required advance'))
    for (const kept of ['gross', 'discount', 'subtotal', 'beforeGst', 'gst']) {
      assert.ok(keys.includes(kept), `${kept} is information and stays`)
    }
  })

  test('a zero discount and a subtotal identical to the product value are not repeated', () => {
    const plain = buildBreakdownView(commercialBreakdownRows(buildCommercialRows(persistedCommercial(
      submission({ discount_amount: 0, subtotal_after_discount: 1000000 }))))).rows.map(r => r.key)
    assert.ok(!plain.includes('discount'))
    assert.ok(!plain.includes('subtotal'))
    assert.ok(plain.includes('gross') && plain.includes('beforeGst'))
  })

  test('product value is called what the overview calls it', () => {
    assert.equal(view.rows[0].key, 'gross')
    assert.equal(view.rows[0].label, 'Product value')
  })

  test('amounts are figures, and tax opens the one group', () => {
    assert.equal((html.match(/pi-detail-breakdown-subtotal/g) ?? []).length, 1)
    // From the end of the row's opening tag, so the text starts at its label.
    const subtotalRow = html.slice(html.indexOf('>', html.indexOf('pi-detail-breakdown-subtotal')) + 1)
    assert.ok(text(subtotalRow).trim().startsWith('Total before GST'))
    const css = pageCss()
    assert.ok(/\.pi-detail-breakdown-row \{[^}]*justify-content: space-between/.test(css))
    assert.ok(/\.pi-detail-breakdown-row dd \{[^}]*text-align: right/.test(css))
    assert.ok(/\.pi-detail-breakdown-amount \{[^}]*font-variant-numeric: tabular-nums/.test(css))
    assert.ok(/\.pi-detail-breakdown-total-value \{[^}]*font-size: 24px/.test(css))
  })

  test('a PI with no stated total says so, muted, rather than printing zero', () => {
    const missing = buildBreakdownView(commercialBreakdownRows(buildCommercialRows(persistedCommercial(
      submission({ grand_total: null })))))
    assert.ok(renderToStaticMarkup(<PiCommercialBreakdown view={missing} />)
      .includes('class="pi-detail-breakdown-total-absent"'))
  })
})

// ── 6b. What the card says about the fabric and the terms ────────────────────

describe('the breakdown states who provides the fabric, beside the figure', () => {
  // A PI THAT ACTUALLY CHARGES FOR FABRIC. The default fixture leaves the
  // cell not-applicable, which buildBreakdownView correctly drops — and the
  // whole point of these assertions is where the statement lands RELATIVE TO
  // the figure, so there has to be a figure.
  const rows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(
    submission({ fabric_cost: 40000, fabric_cost_meaning: 'numeric', fabric_cost_text: null }))))
  const view = buildBreakdownView(rows)

  const card = (over: {
    fabricResponsibility?: string | null
    commercialTerms?: string | null
  } = {}) => renderToStaticMarkup(
    <PiCommercialBreakdown
      view={view}
      fabricResponsibility={'fabricResponsibility' in over ? over.fabricResponsibility : 'boe'}
      commercialTerms={'commercialTerms' in over ? over.commercialTerms : BOE_STANDARD_COMMERCIAL_TERMS}
    />)

  test('the sentence sits DIRECTLY under the fabric cost it explains', () => {
    const html = card({ fabricResponsibility: 'client' })
    // A figure and the sentence that says what it means have to be read
    // together. 'Fabric cost Rs. 40,000' six lines above 'Fabric will be
    // provided by client' is two facts a reader has to assemble, and the
    // assembly is where they get it wrong.
    const fabricRow = html.indexOf('Fabric cost')
    assert.notEqual(fabricRow, -1, 'the fixture must carry a fabric line')
    const statement = html.indexOf('Fabric will be provided by client.')
    assert.ok(statement > fabricRow, 'the statement follows its figure')
    // Nothing else between them: the very next row is the statement.
    const between = text(html.slice(fabricRow, statement))
    assert.ok(!/Packing|Transportation|GST|Grand Total/.test(between),
      'no other line comes between the fabric cost and what it means')
  })

  test('each of the three answers prints its own sentence', () => {
    assert.ok(text(card({ fabricResponsibility: 'boe' })).includes('Fabric will be provided by BOE.'))
    assert.ok(text(card({ fabricResponsibility: 'client' })).includes('Fabric will be provided by client.'))
    assert.ok(text(card({ fabricResponsibility: 'not_selected' })).includes('Fabric not selected yet.'))
  })

  test('a client-supplied PI never reads as though BOE will source it', () => {
    const said = text(card({ fabricResponsibility: 'client' }))
    assert.ok(!said.includes('Fabric will be provided by BOE'))
  })

  test('AN UNANSWERED PI SAYS SO, and does not borrow a deliberate answer', () => {
    const said = text(card({ fabricResponsibility: null }))
    assert.ok(said.includes(FABRIC_RESPONSIBILITY_UNANSWERED))
    assert.ok(!said.includes('Fabric not selected yet'),
      'nobody-has-answered must not print the answer "not selected yet"')
    assert.ok(!said.includes('provided by'))
  })

  test('the question is answered even on a PI with no fabric line at all', () => {
    const noFabric = buildBreakdownView(commercialBreakdownRows(buildCommercialRows(
      persistedCommercial(submission({ fabric_cost: null })))))
    const html = renderToStaticMarkup(
      <PiCommercialBreakdown view={noFabric} fabricResponsibility='client' />)
    assert.ok(text(html).includes('Fabric will be provided by client.'),
      'the answer is about the order, not about the line')
    assert.equal((html.match(/Fabric will be provided by client\./g) ?? []).length, 1,
      'and it is said exactly once')
  })

  test('the terms are printed under the figures they qualify', () => {
    const html = card()
    assert.ok(text(html).includes(BOE_STANDARD_COMMERCIAL_TERMS))
    assert.ok(html.indexOf('pi-detail-breakdown-rows') < html.indexOf('pi-detail-breakdown-terms'),
      'they qualify the amounts, so they come after them')
  })

  test('edited terms are printed verbatim, standard wording and all', () => {
    const edited = 'Prices include fabric and packing. Transport at actual.'
    assert.ok(text(card({ commercialTerms: edited })).includes(edited))
    assert.ok(!text(card({ commercialTerms: edited })).includes('ex-factory'),
      'the standard sentence is not printed alongside an edit')
  })

  test('a PI with no terms says so rather than leaving a gap', () => {
    assert.ok(text(card({ commercialTerms: null })).includes(COMMERCIAL_TERMS_ABSENT))
  })

  test('the Edit control appears only where the viewer may edit', () => {
    const withEdit = renderToStaticMarkup(
      <PiCommercialBreakdown view={view} fabricResponsibility='boe' onEditTerms={() => {}} />)
    assert.ok(withEdit.includes('aria-label="Edit PI terms and fabric responsibility"'))
    const readOnly = renderToStaticMarkup(
      <PiCommercialBreakdown view={view} fabricResponsibility='boe' onEditTerms={null} />)
    assert.ok(!readOnly.includes('aria-label="Edit PI terms and fabric responsibility"'),
      'a control that cannot act must not be offered')
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
    // WHAT THIS FIXTURE USED TO DEMONSTRATE: it carried no finance
    // verification, so "Finance must verify this PI" was the blocker named,
    // and the finance line said the same thing beside it. Neither exists now.
    assert.ok(!text(html).includes('Finance must verify'))
    assert.ok(!text(html).includes('Finance verification pending'))
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
  // The payment position matches the record: a pending exception IS the PI's
  // position on the payment gate, and it is what now holds the approval up.
  const raw = workflowHtml(row, {
    id: REVIEWER, canReview: true, canDecideAdvance: true, paymentPosition: 'exception_pending',
  })
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
    assert.ok(html.includes(PAYMENT_EXCEPTION_PENDING),
      'the pending exception is what is outstanding, and it is named')
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

// ── Phase C: the final approval ───────────────────────────────────────────────

describe('the finance line is gone from the workflow area', () => {
  const submitted = (over: Partial<PersistedSubmission> = {}) => submission({
    status: 'submitted',
    submitted_by: OWNER,
    submitted_at: '2026-08-03T04:00:00Z',
    advance_condition: 'standard',
    ...over,
  })

  // WHAT THIS BLOCK USED TO PROVE (before 20261226000000): that a submitted PI
  // showed "Finance verification pending." to every viewer, that only the
  // finance authority was offered the Verify Finance control, that a
  // verification went stale with a resubmission, and that the whole thing was a
  // line rather than a card.
  //
  // WHAT IT PROVES NOW: none of that is rendered, because the step does not
  // exist. The assertions are kept as ABSENCES rather than deleted, so a future
  // edit that reintroduces the control has to delete a test that says why.

  test('no viewer is shown a PI-level finance state', () => {
    for (const viewer of [
      { id: REVIEWER, canReview: true },
      { id: OWNER },
      { id: STRANGER },
    ]) {
      const html = text(workflowHtml(submitted(), viewer))
      assert.ok(!html.includes('Finance verification pending'),
        'there is no document-level sign-off to be pending')
      assert.ok(!html.includes('Verified by Asha Menon'),
        'and none to report as done')
    }
  })

  test('nobody is offered a Verify Finance control', () => {
    for (const viewer of [
      { id: REVIEWER, canReview: true },
      { id: FINANCE },
      { id: OWNER },
    ]) {
      assert.ok(!buttonLabels(workflowHtml(submitted(), viewer)).includes('Verify Finance'),
        'the control is gone for everybody, whatever they hold')
    }
  })

  test('a PI carrying a historical verification renders exactly as one without', () => {
    // THE RECORD IS KEPT, AND IS SIMPLY NOT READ HERE. The columns still hold
    // every verification ever made; the panel no longer has an opinion about
    // them, so two records that differ only in those three columns must render
    // identically.
    const withHistory = submitted({
      finance_verified_by: FINANCE,
      finance_verified_at: '2026-08-03T09:30:00Z',
      finance_verified_submission_at: '2026-08-03T04:00:00Z',
    })
    assert.equal(
      workflowHtml(withHistory, { id: REVIEWER, canReview: true }),
      workflowHtml(submitted(), { id: REVIEWER, canReview: true }),
      'a past finance verification changes nothing on screen')
  })

  test('the panel still keeps exactly one heading', () => {
    const html = workflowHtml(submitted(), { id: REVIEWER, canReview: true })
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
    assert.ok(!text(html).includes('Finance must verify'), 'and nothing left to explain')
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
    assert.ok(!hasApproveControl(workflowHtml(ready(), { id: FINANCE })),
      'verifying the figures is not approving the PI')
  })

  test('the blocker is addressed to the reviewer, and to nobody else', () => {
    // The blocker used to be the missing finance verification. It is now money
    // still with Finance — the same property, about the thing that decides.
    const awaiting = { awaitingVerificationAmount: '50000' }
    assert.ok(text(workflowHtml(ready(), { id: REVIEWER, canReview: true, ...awaiting }))
      .includes('awaiting Finance verification'))
    assert.ok(!text(workflowHtml(ready(), { id: OWNER, ...awaiting }))
      .includes('awaiting Finance verification'),
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

  test('no longer displays a finance verification, though the record keeps one', () => {
    // WHAT THIS TEST USED TO SAY: an approved PI kept its finance verification
    // on screen forever, because who signed the figures off was part of the
    // approved record's history.
    //
    // WHAT IT SAYS NOW: the sign-off is not a step, so the screen does not
    // report it. THE DATA IS UNTOUCHED — finance_verified_by/_at/
    // _submission_at still hold whatever was written to them, and
    // 20261226000000 does not read, clear or drop them. This is a rendering
    // change, and the test says so rather than implying the history was lost.
    assert.ok(!text(html).includes('Verified by Asha Menon'))
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
  test('gets no panel at all, because it would hold nothing but the status', () => {
    // It used to render a bordered white card whose entire content was the word
    // "Draft" — directly under a summary whose badge already says it. A
    // restatement is not worth a section of the page, and it pushed the product
    // table down for nothing.
    const html = workflowHtml(submission(), { id: STRANGER, canCreate: true })
    assert.equal(html, '', 'an empty panel is not drawn')
  })

  test('but every state that carries something still renders', () => {
    // The test is EMPTINESS, not the draft state. Each of these sets hasActions
    // or hasBody, and each must survive.
    const owner = workflowHtml(submission(), { id: OWNER, canCreate: true })
    assert.ok(owner.includes('<button'), 'the owner keeps Change PI and Submit')

    const reviewer = workflowHtml(submission({ status: 'submitted' }),
      { id: STRANGER, canReview: true })
    assert.ok(reviewer.includes('<button'), 'a reviewer keeps their decisions')

    const returned = workflowHtml(
      submission({ status: 'needs_changes', review_note: 'Fix the rates on rows 4-9.' }),
      { id: OWNER, canCreate: true })
    assert.ok(text(returned).includes('Fix the rates on rows 4-9.'),
      'management’s note is body, and body keeps the panel')
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

  test('both readings line their digits up and group before tax', () => {
    // THESE THREE WERE NEVER ABOUT WHICH SCREEN YOU WERE ON. Digits that line
    // up, a rule that separates the tax group from the costs above it, and a
    // Grand Total a reader can find are properties of a column of money, and
    // the upload preview is the same column of the same money. They were once
    // gated to the detail card only because that card was the thing being
    // worked on; the upload preview has now caught up to it.
    //
    // The detail card's markup did not move to get there — it already had all
    // three — which is what the paired assertions below hold in place.
    for (const [name, html] of [['preview', preview], ['detail', detail]] as const) {
      assert.ok(html.includes('font-variant-numeric:tabular-nums'),
        `the ${name} lines its digits up`)
      assert.ok(html.includes('class="pi-commercial-grand-total"'),
        `the ${name}'s Grand Total takes the one highlight`)
    }
    // The Grand Total's own rule is heavier and comes from CSS, so every inline
    // hairline here is a SEPARATOR and each one is counted. The detail column
    // has one — the group before tax. The preview has that one and the rule
    // under which the advance callout sits, and no third.
    assert.equal((detail.match(/border-top:1px solid/g) ?? []).length, 1)
    assert.equal((preview.match(/border-top:1px solid/g) ?? []).length, 2)
    // Not even a serialised zero. A falsy-but-PRESENT style value still reaches
    // the markup — `marginTop: 0` would emit `margin-top:0` on every row — so
    // the group's own offset stays `undefined` everywhere it does not apply.
    assert.ok(!preview.includes('margin-top:0'))
    assert.ok(!detail.includes('margin-top:0'))
  })

  test('the advance is a callout below the total, not a tenth row of the sum', () => {
    // It is a CONSEQUENCE of the grand total, not a term in it, and as a row it
    // was read as one more addend. The figure, the label and the note are the
    // builder's own strings either way — this only moves where they sit.
    assert.ok(text(preview).includes('Required advance (40%)'))
    assert.ok(text(preview).includes(ADVANCE_NOT_A_PAYMENT_NOTE))
    const totalAt = preview.indexOf('pi-commercial-grand-total')
    const advanceAt = preview.indexOf('Required advance')
    assert.ok(totalAt > -1 && advanceAt > totalAt, 'and it sits below the Grand Total')
    // The detail card never had one: its own top-of-page snapshot owns the
    // advance and would contradict this on a PI with an approved exception.
    assert.ok(!text(detail).includes('Required advance'))
  })

  test('its heading is untouched', () => {
    assert.ok(text(preview).includes('Commercial summary'))
  })

  test('every label and every figure is the builder’s own string, in its own order', () => {
    // THE VALUE GUARD. The refinement moved things on this card; it must not
    // have changed, reformatted, merged or dropped one of them. Rather than
    // pinning a fixture's amounts — which would only prove it for one PI — the
    // expectation is BUILT FROM THE ROWS the component was handed, so this
    // holds for any workbook: the ledger in the builder's order, label then
    // amount, then the advance's label, its amount and its note.
    const cells = (html: string) => html
      // A separator that cannot occur in rendered text, built rather than
      // written: a control character typed into this file would make git treat
      // the source as binary.
      .replace(/<[^>]*>/g, CELL_SEPARATOR)
      .split(CELL_SEPARATOR)
      .map(s => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').trim())
      .filter(Boolean)

    const ledger = rows.filter(r => r.emphasis !== 'advance')
    const advance = rows.find(r => r.emphasis === 'advance')
    assert.ok(advance, 'the preview is the one place that states a required advance')

    const expected = ['Commercial summary']
    for (const row of ledger) expected.push(row.label, row.value)
    expected.push(advance.label, advance.value)
    if (advance.note) expected.push(advance.note)

    assert.deepEqual(cells(preview), expected,
      'nothing was added to the card, and nothing was taken off it')
  })

  test('the detail column renders the same way, minus the advance it never shows', () => {
    // The same property for the saved-draft card, so the two cannot drift: it
    // renders exactly the rows it is handed, label then amount, and it is
    // handed the ledger without the advance.
    const cells = (html: string) => html
      .replace(/<[^>]*>/g, CELL_SEPARATOR)
      .split(CELL_SEPARATOR)
      .map(s => s.trim())
      .filter(Boolean)

    const detailRows = commercialBreakdownRows(rows)
    const expected = ['Commercial breakdown']
    for (const row of detailRows) expected.push(row.label, row.value)
    assert.deepEqual(cells(detail), expected)
    assert.ok(!detailRows.some(r => r.emphasis === 'advance'))
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

describe('the layout is CSS, at real breakpoints', () => {
  const css = pageCss()

  test('the context row is one column, then exactly two equal columns from tablet width', () => {
    assert.ok(/\.pi-detail-context \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css))
    assert.ok(/@media \(min-width: 768px\) \{\s*\.pi-detail-context \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css))
    // The divider is the second cell's own edge: a rule on top while stacked,
    // on its left side by side — never both.
    assert.ok(/\.pi-detail-context-cell \+ \.pi-detail-context-cell \{[^}]*border-top: 1px solid/.test(css))
    assert.ok(/@media \(min-width: 768px\)[\s\S]*?\.pi-detail-context-cell \+ \.pi-detail-context-cell \{\s*border-top: none;\s*border-left: 1px solid/.test(css))
  })

  test('the overview is one column, then two balanced columns of equal height', () => {
    assert.ok(/\.pi-detail-overview \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css))
    assert.ok(/@media \(min-width: 1024px\) \{\s*\.pi-detail-overview \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css))
    assert.ok(/@media \(min-width: 1024px\) \{\s*\.pi-detail-overview \{[^}]*align-items: stretch/.test(css),
      'the figures column is as tall as the one beside it — no dead space under them')
  })

  test('the three figures fill their column, measured on the column itself', () => {
    assert.ok(/\.pi-detail-figures \{[^}]*container-type: inline-size/.test(css))
    assert.ok(/\.pi-detail-figures-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css))
    assert.ok(/@container \(min-width: 480px\) \{\s*\.pi-detail-figures-grid \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(css))
    assert.ok(/\.pi-detail-figures-grid \{[^}]*flex: 1 1 auto/.test(css), 'the grid fills the container’s height')
    assert.ok(/\.pi-detail-figure \{[^}]*justify-content: center/.test(css))
    assert.ok(/\.pi-detail-figure-value,\s*\.pi-detail-figure-absent \{[^}]*font-size: 22px/.test(css), 'large values')
    assert.ok(/\.pi-detail-figure-label \{[^}]*font-size: 11\.5px/.test(css), 'and muted labels')
  })

  test('payment status: headline beside its parts when wide, stacked when narrow, never wider than its column', () => {
    assert.ok(/\.pi-detail-paystatus-body \{[^}]*container-type: inline-size/.test(css), 'measured on the card, not the viewport')
    assert.ok(/\.pi-detail-paystatus-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css), 'stacked by default')
    assert.ok(/@container \(min-width: 600px\) \{\s*\.pi-detail-paystatus-grid \{\s*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 3fr\)/.test(css),
      'the headline beside its two parts once the card is wide enough')
    assert.ok(/\.pi-detail-paystatus-metrics \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css))
    assert.ok(/@container \(max-width: 360px\) \{\s*\.pi-detail-paystatus-metrics \{\s*grid-template-columns: minmax\(0, 1fr\)/.test(css),
      'one part per line on a phone')
    assert.ok(/@media \(max-width: 480px\) \{\s*\.pi-detail-paystatus-actions \{\s*width: 100%/.test(css))
    assert.ok(/\.pi-detail-paystatus-percent \{[^}]*font-size: 34px/.test(css), 'the headline is the largest figure on the card')
    for (const cls of ['percent', 'of', 'metric-value', 'metric-meta']) {
      assert.ok(new RegExp(`\\.pi-detail-paystatus-${cls} \\{[^}]*overflow-wrap: anywhere`).test(css),
        `${cls} wraps instead of widening the card`)
    }
    assert.ok(/^\.pi-detail-paystatus-metric \{[^}]*min-width: 0/m.test(css))
    assert.ok(/\.pi-detail-paystatus-legend \{[^}]*flex-wrap: wrap/.test(css))
    assert.ok(!/\.pi-detail-paystatus-(figures|pending) \{/.test(css), 'the two-figure layout and the pending chip are gone')
  })

  test('Payment status and Management review share one row: ~70/30 on a wide column, stacked when narrow', () => {
    const page = read(PAGE)
    const start = page.indexOf('<div className="pi-detail-decision-row">')
    const end = page.indexOf('{/* ── 4. What stops this being submitted')
    assert.ok(start > 0 && end > start, 'the row wraps the two sections, above the blocking panel')
    const row = page.slice(start, end)
    assert.ok(row.includes('<div className="pi-detail-decision-grid">'))
    assert.ok(row.indexOf('<PiPaymentStatusCard') > 0 && row.indexOf('<PiPaymentStatusCard') < row.indexOf('<PiWorkflowPanel'),
      'payment first, which is also the order they stack in')
    assert.equal((row.match(/<(PiPaymentStatusCard|PiWorkflowPanel)\b/g) ?? []).length, 2, 'and nothing else in the row')

    assert.ok(/\.pi-detail-decision-row \{[^}]*container-type: inline-size/.test(css), 'measured on the column, not the viewport')
    assert.ok(/\.pi-detail-decision-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css), 'stacked by default')
    assert.ok(/@container \(min-width: 900px\) \{\s*\.pi-detail-decision-grid \{\s*grid-template-columns: minmax\(0, 7fr\) minmax\(0, 3fr\)/.test(css),
      'seven to three once the column is wide enough for the review card to breathe')
    assert.ok(/\.pi-detail-decision-grid > :only-child \{\s*grid-column: 1 \/ -1/.test(css),
      'a panel that draws nothing leaves Payment status the whole row')
    assert.ok(/\.pi-detail-decision-grid \.pi-detail-workflow-actions > \.pi-approve-btn \{\s*flex-basis: 100%/.test(css),
      'the approval control gets its own line in the narrow column')
    assert.ok(!/\.pi-detail-decision-[a-z-]* \{[^}]*\border:/.test(css), 'CSS order never moves one card past the other')
  })

  test('the green approval controls stay readable in every state', () => {
    const rule = (selector: string) => {
      const match = css.match(new RegExp(`${selector.replace(/[.:]/g, m => `\\${m}`)} \\{([^}]*)\\}`))
      assert.ok(match, `${selector} must be styled`)
      return match[1]
    }
    for (const state of ['', ':hover', ':active']) {
      const body = rule(`.boe-btn-primary.pi-approve-btn${state}`)
      assert.ok(body.includes('color: #FFFFFF'), `white text and icon${state ? ` on ${state}` : ''}`)
    }
    assert.ok(rule('.boe-btn-primary.pi-approve-btn').includes('background: #2F7A52'))
    assert.ok(rule('.boe-btn-primary.pi-approve-btn:focus-visible').includes('outline: 2px solid #1F5A3A'))
    const disabled = rule('.boe-btn-primary.pi-approve-btn:disabled')
    assert.ok(disabled.includes('background: #E3F0E8') && disabled.includes('color: #1F5A3A'),
      'disabled: pale green with dark-green text, never grey text on the green ground')
    assert.ok(css.indexOf('.boe-btn-primary.pi-approve-btn:disabled') > css.indexOf('.boe-btn-primary.pi-approve-btn:hover'),
      'the disabled rule comes last, so hovering a disabled control changes nothing')

    const sections = read(SECTIONS)
    assert.ok(!sections.includes("background: '#2F7A52'"), 'no inline green that the disabled rule cannot reach')
    assert.equal((sections.match(/className="boe-btn boe-btn-primary pi-approve-btn"/g) ?? []).length, 2,
      'the review decision and the advance decision')
  })

  test('the progress bar cannot overflow its track', () => {
    assert.ok(read('src/components/orders/PiPaymentCard.tsx').includes("overflow: 'hidden'"))
    assert.ok(read('src/app/orders/drafts/[submissionId]/piDetailView.ts')
      .includes('return Math.max(0, Math.min(100, value))'))
  })

  test('actions take a readable full width on a narrow phone', () => {
    assert.ok(/@media \(max-width: 480px\)[\s\S]*?\.pi-detail-workflow-actions \{\s*width: 100%/.test(css))
  })

  test('no new surface shouts: no shadow and no gradient', () => {
    for (const sel of ['context', 'overview', 'figures', 'dates', 'paystatus', 'breakdown', 'decision']) {
      assert.ok(!new RegExp(`\\.pi-detail-${sel}[a-z-]* \\{[^}]*(box-shadow|gradient)`).test(css),
        `${sel}: no shadow and no gradient`)
    }
  })

  test('the Confirmed Order page keeps the summary rules it still renders', () => {
    // OrderPiSections draws the approved PI with these classes. The PI Draft no
    // longer uses them; their rules were deliberately left in place.
    const order = read('src/app/orders/[id]/OrderPiSections.tsx')
    for (const cls of ['pi-detail-summary-schedule', 'pi-detail-summary-paycard', 'pi-detail-summary-money',
      'pi-detail-summary-client', 'pi-detail-summary-billing-head']) {
      assert.ok(order.includes(cls), `${cls} is still the Order page’s`)
      assert.ok(new RegExp(`\\.${cls} \\{`).test(css), `${cls} keeps its rule`)
    }
  })

  test('every column of this page is minmax(0, …), so nothing can widen it', () => {
    const tracks = [...css.matchAll(/grid-template-columns: ([^;]+);/g)].map(m => m[1])
    assert.ok(tracks.length >= 4, 'the block really does define the grids')
    for (const value of tracks) {
      // `repeat(N, minmax(0, …))` is just as bounded as a list of minmax()
      // tracks; unwrapping it is what lets the same check cover both.
      for (const track of value.replace(/repeat\(\d+,\s*/g, '').split(/\)\s+/)) {
        // A FIXED length cannot be widened by its content either, so the rule is
        // "bounded", not "spelled minmax". Anything flexible has to say minmax(0, …).
        assert.ok(track.startsWith('minmax(0,') || /^\d+px\b/.test(track),
          `${value} must not be able to overflow its grid`)
      }
    }
  })

  test('the block is scoped to this page and modifies nothing above it', () => {
    const global = read(GLOBAL_CSS)
    const selectors = [...global.matchAll(/^\.([a-z0-9-]+)/gm)].map(m => m[1])
    const mine = selectors.filter(name => name.startsWith('pi-detail-'))
    assert.ok(mine.length >= 15, 'the page owns a real block')
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

  test('is one short line, and says what now actually waits for approval', () => {
    assert.ok(html.includes(STORED_COPY_NOTE))
    assert.ok(STORED_COPY_NOTE.length < 130, 'a paragraph became a line')
    // IT USED TO PIN "numbering begins after management approval", and
    // 20261009000000 made that false: the NUMBER is reserved as soon as the PI
    // has a workbook, so that the revised PI can carry it. What still waits for
    // approval is the Confirmed Order, and that is what this must say — beside a
    // panel showing a reserved number, the old sentence was a contradiction.
    assert.ok(/Confirmed Order is created at management approval/.test(STORED_COPY_NOTE))
    assert.ok(!/numbering begins after management approval/.test(STORED_COPY_NOTE),
      'the superseded rule must not survive anywhere on this screen')
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
      '<PiSummaryCard',
      '<PiWorkflowPanel',
      '<PiBlockingPanel',
      '{/* Products */}',
    ].map(at)
    assert.deepEqual([...order].sort((a, b) => a - b), order,
      'nobody should scroll a product table to find out what is being asked of them')
  })

  test('the payment position is answered in exactly one place on the page', () => {
    assert.equal((page.match(/<PiPaymentStatusCard/g) ?? []).length, 1)
    assert.equal((page.match(/<PiSummaryCard/g) ?? []).length, 1)
    assert.ok(!page.includes('<PiPaymentCard'), 'the standalone payments section is gone')
    assert.equal((page.match(/<PiPaymentDetailsModal/g) ?? []).length, 1,
      'and the records open in the dialog the rest of the application uses')
  })

  test('status and dates first, then value, then payment, then the decisions', () => {
    const order = [
      '{justSaved && <PiSavedStrip />}',
      '<PiContextRow',
      '<PiSummaryCard',
      '<PiPaymentStatusCard',
      '<PiWorkflowPanel',
    ].map(at)
    assert.deepEqual([...order].sort((a, b) => a - b), order,
      'the context row sits directly under the save banner, above the overview')
    assert.ok(!page.includes('<PiOrderNumberPanel'), 'the reserved number has one home, in the context row')
  })

  test('the commercial breakdown and the activity trail come after them, together', () => {
    assert.ok(at('{/* Products */}') < at('<PiLowerGrid'))
    const grid = page.slice(at('<PiLowerGrid'), at('<PiWarningPanel'))
    assert.ok(grid.includes('<PiCommercialBreakdown'), 'the breakdown is in the grid')
    assert.ok(grid.includes('view={breakdown}'), 'and it renders the selection, not a rebuild')
    assert.ok(grid.includes('<PiActivityTimeline'), 'and so is the trail')
    assert.ok(grid.indexOf('<PiCommercialBreakdown') < grid.indexOf('<PiActivityTimeline'),
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
    workflowHtml(verified, { id: FINANCE }),
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
      // THE ROWS THIS IS ABOUT are the ones laid out inline: the PI-decision
      // line and the created-Order strip. The third was the finance line, and
      // 20261226000000 removed it — so a panel whose only content is the
      // button group (which is laid out by a CSS class, not by an inline
      // style) now has no inline row for this rule to be about.
      if (!html.includes('display:flex')) continue
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
            readiness: null,
            onFixReadiness: null,
            reviewNote: null,
            employeeReply: null,
            advanceRefusal: null,
            blockingCount: 0,
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

  test('the same RPCs are called, plus the billing writer, and no others', () => {
    // The allowlist is the point: a new RPC has to be added here on purpose,
    // which is how a stray call gets noticed. set_order_submission_billing_percentage
    // is the one write the billing field needs, and it is the only addition.
    const rpcs = [...page.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(rpcs)].sort(), [
      'approve_order_submission',
      'approve_pi_advance_exception',
      // The PI decision on its own (20261119000000): the same authority as
      // approve_order_submission, taken while the payment condition is still
      // unresolved. Writes three columns and one event; creates no Order.
      'approve_pi_review',
      // A read, not a write: the database's own answer to "may this viewer edit
      // this record", asked instead of being restated in the browser.
      // Two capability reads, not one. The second carries the revised rule that
      // an ACTIVE ADMIN may amend a PI at any stage; the first remains the
      // owner rule and is deliberately unwidened.
      'can_admin_edit_order_submission',
      'can_edit_order_submission',
      'reject_order_submission',
      'reject_pi_advance_exception',
      // The order the lines are printed in (20261002000000). One write over
      // every line at once, so it cannot half-apply, and it requires the full
      // set of ids — a partial list is refused. It adds nothing, removes
      // nothing and moves no figure.
      'reorder_order_submission_items',
      'request_order_submission_changes',
      'request_order_submission_correction',
      'set_order_submission_billing_percentage',
      // submit_pi_for_review is reached through the supporting-documents
      // sender (submit_pi_for_review_with_documents, 20270112000000 §11),
      // pinned in the submit-door tests; the page itself calls no submit RPC.
      // The client and party details editor (20260928000000). The one write on
      // this page that supplies BUSINESS DATA rather than moving a status, and
      // the answer to a PI imported without a client name — which previously
      // dead-ended the workflow with no way anywhere to fix it.
      'update_order_submission_client_details',
      // One product line's DESCRIPTION (20261002000000): number, code, name,
      // dimensions, material, specification note. Quantity, rate and the line
      // total are refused BY NAME with the reason — the workbook's formulas
      // produce them and this system transcribes rather than computes them.
      'update_order_submission_item_details',
      // The PI terms editor (20261225000000): date of creation, commercial
      // terms note, fabric responsibility. Three named columns; a fabric
      // COST aimed at it is refused by name, which is what makes changing
      // the fabric answer unable to remove a figure.
      'update_order_submission_pi_terms',
      'update_order_submission_schedule_terms',
      // NO verify_pi_finance_check (20261226000000). The PI-level finance
      // sign-off is not a step any more, so this page no longer calls the RPC
      // that recorded it. The function itself still exists in the database,
      // still holds its grants, and every verification it ever wrote is still
      // there — it simply has no caller here and gates nothing.
    ])
  })

  test('billing is READ with the record, not with a request of its own', () => {
    // One query, as before. The column joins the existing select list; nothing
    // fetches it separately and nothing falls back to a second read.
    assert.ok(read('src/lib/orders/draftsView.ts').includes("'billing_percentage'"),
      'the column is in PI_DRAFT_DETAIL_COLUMNS')
    const selects = [...page.matchAll(/\.from\('order_submissions'\)/g)]
    assert.ok(selects.length <= 1, 'still at most one order_submissions read on this page')
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

  test('payment decisions reach the database only through Finance’s own doors', () => {
    // The page writes no payment and names no payment table or RPC. Approve and
    // Reject run through the one shared helper, which calls only the two
    // server-gated decision RPCs — see src/lib/finance/paymentDecision.test.ts.
    assert.ok(page.includes("import { decidePayment, loadOwnPaymentIds, NO_OWN_PAYMENTS, type PaymentDecision } from '@/lib/finance/paymentDecision'"))
    // A non-admin verifier's own pending payments draw no decision; an admin's do.
    assert.ok(page.includes('canApprovePayments && !canDecideOwnPayments ? ownPaymentIds : NO_OWN_PAYMENTS'))
    assert.ok(page.includes('setCanDecideOwnPayments(financeCaps.canDecideOwnPayment)'),
      'the override comes from the Finance capability helper, never a role literal')
    assert.ok(page.includes('ownPaymentIds={decisionOwnPaymentIds}'))
    assert.equal((page.match(/decidePayment\(/g) ?? []).length, 1, 'one call site')
    assert.ok(!/approve_finance_payment_request|reject_finance_payment_request|finance_payment_requests/.test(page))
  })

  test('only the Finance approval authority draws a payment decision', () => {
    assert.equal((page.match(/setCanApprovePayments\(/g) ?? []).length, 1, 'set in one place')
    assert.ok(page.includes('setCanApprovePayments(financeCaps.canApprovePayment)'),
      'from the capability the Finance screens read — never an Orders capability')
    assert.ok(page.includes('onDecide={canApprovePayments ? decidePendingPayment : null}'))
    assert.ok(page.includes('canVerify={canApprovePayments}'))
  })

  test('and that authority grants nothing on the PI itself', () => {
    const slice = (from: string, to: string) => {
      const start = page.indexOf(from)
      assert.ok(start > 0, `${from} must be on the page`)
      return page.slice(start, page.indexOf(to, start))
    }
    const regions: [string, string][] = [
      ['the PI decision rules', slice('const actions = describeSubmissionActions({', '})')],
      ['who may record a payment', slice('const canAddPayment = canAddPiPayment(', 'const clientDetails')],
      ['the workflow panel', slice('<PiWorkflowPanel', 'statusShownAbove')],
      ['the product editors', slice('const canEditProducts =', '\n')],
    ]
    for (const [name, region] of regions) {
      assert.ok(!region.includes('canApprovePayments'), `${name} must not read the payment authority`)
    }
    // The one Edit PI (20270115000000) carries the billing percentage; it is
    // opened by the same two authorities and never by the payment authority.
    assert.ok(page.includes('const mayEditPi = (canEditSubmission || canAdminAmend) && !piIsOrder'))
    assert.ok(!slice('const mayEditPi =', '\n').includes('canApprovePayments'))
  })
})

// ══ THREE EDIT CONTROLS, EACH BESIDE WHAT IT CHANGES ═════════════════════════
//
// The card grew three separate editing responsibilities and put all three
// controls in one place — the finance surface — where only one of them belonged.
// "Dates and terms" sat between the billing label and the billing control, so
// the button nearest "Billing percentage" was the one that did not change it;
// the client editor was reachable only from the missing-data strip, which meant
// a wrong phone number on an otherwise complete PI had no way in at all.
//
// What these tests hold is the arrangement, not the styling: each control next
// to the information it modifies, and no control offering an edit it does not
// perform.

describe('each edit control sits beside what it edits', () => {
  /**
   * The markup between two named regions. Boundaries are given EXPLICITLY: the
   * card's regions appear in a known order, so naming both ends is both simpler
   * and correct.
   */
  const region = (html: string, from: string, to: string): string => {
    const start = html.indexOf(`class="${from}"`)
    assert.notEqual(start, -1, `no .${from} in the card`)
    const end = html.indexOf(to, start)
    assert.notEqual(end, -1, `no .${to} after .${from}`)
    return html.slice(start, end)
  }

  const editable = { canEditDetails: true, canEditBilling: true }

  test('the client editor is reachable from the customer area', () => {
    const html = summaryHtml(editable)
    const party = region(html, 'pi-detail-summary-party', 'pi-detail-meta')
    assert.match(party, /aria-label="Edit customer details"/,
      'the control beside the name must open the client editor')
    assert.ok(!/pi-detail-summary-client"[^>]*>[\s\S]{0,400}?aria-label="Edit customer details"[\s\S]{0,80}?<\/button>\s*<\/button>/.test(html),
      'the edit control must not be nested inside the name button')
  })

  test('the client editor is NOT reachable without permission', () => {
    assert.ok(!summaryHtml({ canEditDetails: false }).includes('aria-label="Edit customer details"'))
  })

  test('the owner’s correction channel takes the same slot, and never both', () => {
    const html = summaryHtml({ canEditDetails: false, onRequestCorrection: () => {} })
    const party = region(html, 'pi-detail-summary-party', 'pi-detail-meta')
    assert.match(party, /Request correction/)
    assert.ok(!party.includes('aria-label="Edit customer details"'))

    const both = region(summaryHtml({ ...editable, onRequestCorrection: () => {} }),
                        'pi-detail-summary-party', 'pi-detail-meta')
    assert.match(both, /aria-label="Edit customer details"/)
    assert.ok(!both.includes('Request correction'))
  })

  test('the dates editor is inside the dates band, not in the figures column', () => {
    const html = summaryHtml(editable)
    const band = region(html, 'pi-detail-dates', 'pi-detail-figures')
    assert.match(band, /aria-label="Edit dates and terms"/)
    const figures = html.slice(html.indexOf('class="pi-detail-figures"'))
    assert.ok(!figures.includes('Dates and terms') && !figures.includes('Edit dates and terms'))
  })

  test('the dates band has no control where there is nothing to press', () => {
    assert.ok(!summaryHtml({ canEditDetails: false }).includes('pi-detail-dates-edit'))
  })

  test('the billing control is the FIRST thing after its own label', () => {
    const html = summaryHtml(editable)
    const head = html.slice(html.indexOf('pi-detail-figure-head'))
    const label = head.indexOf('Billing percentage')
    const action = head.indexOf('pi-detail-summary-billing-action')
    assert.ok(label !== -1 && action !== -1 && label < action)
    const tag = head.lastIndexOf('<button', action)
    assert.ok(tag > label, 'the billing control opens before its own label')
    assert.ok(!head.slice(label, tag).includes('<button'),
      'another control sits between the billing label and its own control')
  })

  test('the billing control is absent where billing may not be declared', () => {
    const html = summaryHtml({ canEditDetails: true, canEditBilling: false })
    assert.ok(!html.includes('pi-detail-summary-billing-action'))
    assert.match(html, /aria-label="Edit dates and terms"/, 'the two authorities are separate')
  })

  test('Billing value still reads below the percentage', () => {
    const declared = buildBillingSummary({ raw: 60, totalBeforeGst: 742850 })
    const html = summaryHtml({ ...editable, billing: declared })
    const percentAt = html.indexOf('60%')
    const valueAt = html.indexOf(BILLING_VALUE_LABEL)
    assert.ok(percentAt !== -1 && valueAt !== -1 && percentAt < valueAt,
      'the value must follow the percentage it is derived from')
  })

  test('exactly three edit controls, and no fourth', () => {
    const html = summaryHtml({ ...editable, onRequestCorrection: () => {} })
    assert.equal((html.match(/pi-detail-summary-inline-action/g) ?? []).length, 2, 'customer and dates')
    assert.equal((html.match(/pi-detail-summary-billing-action/g) ?? []).length, 1, 'billing percentage')
  })
})

describe('the three dialogs stay separate', () => {
  const modals = readFileSync(
    join(process.cwd(), 'src/components/orders/piReviewModals.tsx'), 'utf8')

  test('the dates dialog no longer offers billing percentage', () => {
    const start = modals.indexOf('export function PiScheduleTermsEditModal')
    const end = modals.indexOf('export function', start + 10)
    const body = modals.slice(start, end)
    assert.ok(!body.includes('onEditBilling'),
      'one dialog must not be the way into two unrelated edits')
    assert.ok(!body.includes('BILLING_LABEL'))
    assert.ok(!body.includes('billingLabel'))
  })

  test('the dates dialog still carries all five schedule fields', () => {
    const start = modals.indexOf('export function PiScheduleTermsEditModal')
    const end = modals.indexOf('export function', start + 10)
    assert.match(modals.slice(start, end), /PI_SCHEDULE_FIELDS\.map/)
    for (const field of ['order_confirmation_date', 'due_date', 'dispatch_commitment',
                         'payment_terms', 'billing_terms']) {
      assert.ok(modals.includes(`'${field}'`), `${field} left the schedule editor`)
    }
  })

  test('each dialog announces the section it edits', () => {
    // All three shared one aria-label, so a screen-reader user opening any of
    // them from three different controls heard the same undifferentiated name.
    for (const label of ['Edit client details', 'Edit dates and terms', 'Edit product line']) {
      assert.ok(modals.includes(`aria-label="${label}"`), `no dialog named "${label}"`)
    }
  })
})
