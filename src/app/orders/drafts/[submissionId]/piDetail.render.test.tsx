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
  PiOrderOverview,
  PiStoredCopyNote,
  PiWarningPanel,
  PiWorkflowPanel,
  statusTone,
} from './piDetailSections'
import {
  buildCommercialSnapshot,
  buildIdentityFacts,
  buildOverviewDates,
  commercialBreakdownRows,
  describeWorkflowPanel,
  omitDash,
  ADVANCE_REQUESTED_LABEL,
  ADVANCE_REQUIREMENT_LABEL,
  STORED_COPY_NOTE,
  WORKFLOW_HEADING,
} from './piDetailView'
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
    advance_exception_percent: null,
    advance_exception_reason: null,
    advance_exception_status: null,
    advance_exception_requested_by: null,
    advance_exception_requested_at: null,
    advance_exception_decided_by: null,
    advance_exception_decided_at: null,
    advance_exception_rejection_reason: null,
    ...over,
  } as PersistedSubmission
}

/** The three inputs the page derives, exactly as the page derives them. */
function viewerState(row: PersistedSubmission, viewer: {
  id: string | null
  canCreate?: boolean
  canReview?: boolean
  canDecideAdvance?: boolean
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
  return { actions, advance, advanceActions, panel }
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
  const { actions, advance, advanceActions, panel } = viewerState(row, viewer)
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
      onChangePi={() => {}}
      onSubmit={() => {}}
      onRequestChanges={() => {}}
      onReject={() => {}}
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

function overviewHtml(row: PersistedSubmission, productCount = 12): string {
  const advance = describeAdvance(row, Number(row.grand_total))
  return renderToStaticMarkup(
    <PiOrderOverview
      billTo={omitDash(row.bill_to_name ?? '—')}
      shipTo={omitDash(row.ship_to_name ?? '—')}
      dates={buildOverviewDates({
        created: '01 Aug 2026',
        confirmed: '04 Aug 2026',
        dispatch: '15 Sep 2026',
        submittedAt: row.submitted_at ? '02 Aug 2026, 11:30 am' : null,
      })}
      snapshot={buildCommercialSnapshot({
        grandTotal: formatInr(Number(row.grand_total)),
        productCount,
        advance,
        status: row.status,
      })}
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
 * Whether an inert PI-approval control is anywhere in this markup.
 *
 * A plain substring check on "Approve" cannot answer it — "Approve Exception" is
 * a real, live control on the same panel and contains the word. What is being
 * looked for is the label standing on its OWN, which is what the disabled span
 * rendered.
 */
function hasInertApprove(html: string): boolean {
  const labels = [...html.matchAll(/>([^<>]+)</g)].map(m => m[1].trim())
  return labels.includes(APPROVE_BUTTON_LABEL)
}

/** Text content, with the tags taken out — for "does it SAY this" checks. */
const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const read = (path: string): string => readFileSync(path, 'utf8')

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
          productCount: 12,
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
    assert.ok(text(html).includes('12 product lines'))
    assert.ok(text(html).includes('Saved 02 Aug 2026'))
    assert.ok(text(html).includes('Kalyan-PI-Aug.xlsx'), 'the workbook is named, quietly')
  })

  test('the identity line never repeats what the page title already says', () => {
    const facts = buildIdentityFacts({
      productCount: 3,
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
      productCount: 1,
      savedAt: '02 Aug 2026, 11:30 am',
      documentAuthor: 'Nishant Soni',
      submitterName: 'Nishant Soni',
      submittedAt: '03 Aug 2026, 09:00 am',
    })
    assert.ok(facts.some(f => f.startsWith('Submitted 03 Aug 2026')))
    assert.ok(!facts.some(f => f.startsWith('Saved ')), 'the two are never printed side by side')
    assert.equal(facts[0], '1 product line', 'one product reads as one product')
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

// ── 2. The commercial snapshot ────────────────────────────────────────────────

describe('the advance condition is stated ONCE, in the top snapshot', () => {
  test('the Grand Total is in the snapshot section, as the largest figure', () => {
    const html = overviewHtml(submission())
    const snapshot = html.slice(html.indexOf('class="pi-detail-overview-section pi-detail-snapshot'))
    assert.ok(snapshot.includes(formatInr(GRAND_TOTAL)), '₹11,80,000 is inside the snapshot')
    assert.ok(snapshot.includes('pi-detail-snapshot-total'))
    assert.equal((html.match(/pi-detail-snapshot-total/g) ?? []).length, 1)
  })

  test('a standard requirement is one label, one figure line, no status', () => {
    const html = text(overviewHtml(submission({ status: 'submitted', advance_condition: 'standard' })))
    assert.ok(html.includes(ADVANCE_REQUIREMENT_LABEL))
    assert.ok(html.includes(`40% · ${formatInr(472000)}`))
    // The four rows this replaced are gone: no separate condition label, no
    // "Proposed advance" row, no second amount to compare against.
    for (const gone of ['Advance condition', 'Proposed advance', 'Standard advance (40%)',
                        'Selected condition', 'Standard requirement']) {
      assert.ok(!html.includes(gone), `"${gone}" must not be printed any more`)
    }
  })

  test('a pending reduction reads as something ASKED for, with its state', () => {
    const html = text(overviewHtml(submission({
      status: 'submitted', advance_condition: 'exception',
      advance_exception_percent: 12.5, advance_exception_status: 'pending',
    })))
    assert.ok(html.includes(ADVANCE_REQUESTED_LABEL))
    assert.ok(html.includes(`12.5% · ${formatInr(147500)}`))
    assert.ok(html.includes('Pending'))
    assert.ok(!html.includes(formatInr(472000)),
      'the standard amount is not shown beside it — two figures read as two things owed')
  })

  test('an approved reduction becomes the requirement that stands', () => {
    const html = text(overviewHtml(submission({
      status: 'submitted', advance_condition: 'exception',
      advance_exception_percent: 12.5, advance_exception_status: 'approved',
    })))
    assert.ok(html.includes(ADVANCE_REQUIREMENT_LABEL))
    assert.ok(!html.includes(ADVANCE_REQUESTED_LABEL))
    assert.ok(html.includes('Exception approved'))
  })

  test('0% is named before it is numbered, in every decision state', () => {
    const zero = (status: string) => text(overviewHtml(submission({
      status: 'submitted', advance_condition: 'exception',
      advance_exception_percent: 0, advance_exception_status: status,
    })))
    for (const [status, label, state] of [
      ['pending', ADVANCE_REQUESTED_LABEL, 'Pending'],
      ['approved', ADVANCE_REQUIREMENT_LABEL, 'Exception approved'],
      ['rejected', ADVANCE_REQUESTED_LABEL, 'Rejected'],
    ] as const) {
      const html = zero(status)
      assert.ok(html.includes(label), `${status} uses "${label}"`)
      assert.ok(html.includes('No advance · 0% · ₹0'),
        '"0% · ₹0" alone is a figure somebody has to interpret')
      assert.ok(html.includes(state))
    }
  })

  test('a record that declared nothing says so, once', () => {
    const html = text(overviewHtml(submission({ status: 'submitted' })))
    assert.ok(html.includes(ADVANCE_REQUIREMENT_LABEL))
    assert.ok(html.includes('Not declared'))
  })

  test('a draft that has declared nothing gets no advance block at all', () => {
    const html = text(overviewHtml(submission({ status: 'draft' })))
    assert.ok(!html.includes(ADVANCE_REQUIREMENT_LABEL))
    assert.ok(!html.includes('Not declared'),
      'nothing IS declared until submission; a permanent block would answer nobody')
    assert.ok(html.includes(formatInr(GRAND_TOTAL)), 'the total is still there')
  })

  test('no figure on the snapshot claims a payment, and none explains itself', () => {
    const html = text(overviewHtml(submission({
      status: 'submitted', advance_condition: 'exception',
      advance_exception_percent: 10, advance_exception_status: 'approved',
    })))
    for (const claim of ['received', 'paid', 'collected', 'Payment']) {
      assert.ok(!html.includes(claim), `the snapshot must not say "${claim}"`)
    }
    assert.ok(!html.includes(ADVANCE_NOT_A_PAYMENT),
      'the disclaimer belongs to the dialog where the declaration is made')
  })
})

describe('the overview spends no space on what the PI did not say', () => {
  test('a date the PI never gave is not a row', () => {
    const dates = buildOverviewDates({
      created: '01 Aug 2026', confirmed: '—', dispatch: '', submittedAt: null,
    })
    assert.deepEqual(dates.map(d => d.key), ['created'])
  })

  test('a PI with no dates at all leaves no timeline section behind', () => {
    const html = renderToStaticMarkup(
      <PiOrderOverview
        billTo="Kalyan Interiors, Bengaluru"
        shipTo={null}
        dates={buildOverviewDates({ created: '—', confirmed: '—', dispatch: '—', submittedAt: null })}
        snapshot={buildCommercialSnapshot({
          grandTotal: formatInr(GRAND_TOTAL), productCount: 4,
          advance: describeAdvance(submission(), GRAND_TOTAL), status: 'draft',
        })}
      />,
    )
    assert.ok(!text(html).includes('Timeline'))
    assert.ok(!text(html).includes('Not provided'),
      'three stacked placeholders was the largest dead space on the page')
    assert.ok(!text(html).includes('Ship to'), 'and an absent destination is simply absent')
    assert.ok(text(html).includes('Bill to'), 'while the one it DID give is kept')
    // Two populated groups, so the card lays out as two — never three with a
    // column-shaped hole in it.
    assert.ok(html.includes('pi-detail-overview-2'))
  })

  test('the column count follows the groups that survived', () => {
    const overview = (billTo: string | null, dateCount: 0 | 1) => renderToStaticMarkup(
      <PiOrderOverview
        billTo={billTo}
        shipTo={null}
        dates={dateCount === 0 ? [] : [{ key: 'created', label: 'PI created', value: '01 Aug 2026' }]}
        snapshot={buildCommercialSnapshot({
          grandTotal: formatInr(GRAND_TOTAL), productCount: 4,
          advance: describeAdvance(submission(), GRAND_TOTAL), status: 'draft',
        })}
      />,
    )
    assert.ok(overview('Kalyan', 1).includes('pi-detail-overview-3'))
    assert.ok(overview('Kalyan', 0).includes('pi-detail-overview-2'))
    assert.ok(overview(null, 1).includes('pi-detail-overview-2'))
    assert.ok(overview(null, 0).includes('pi-detail-overview-1'),
      'a record with neither leaves the snapshot the whole card')
  })

  test('a submission stamp is never dropped, because it is a fact about progress', () => {
    const dates = buildOverviewDates({
      created: '—', confirmed: '—', dispatch: '—', submittedAt: '02 Aug 2026, 11:30 am',
    })
    assert.deepEqual(dates.map(d => d.key), ['submitted'])
  })

  test('the client is not repeated inside the card under its own title', () => {
    const html = text(overviewHtml(submission()))
    assert.ok(html.includes('Bill to') && html.includes('Ship to'))
    assert.ok(!html.includes('Client:'))
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
    assert.ok(!hasInertApprove(html))
  })

  test('sees no advance band, because nothing is waiting on anybody', () => {
    assert.ok(!text(html).includes('Advance exception'))
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
    assert.ok(!text(html).includes('Advance exception'),
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
    assert.ok(text(html).includes('Advance exception'))
    assert.ok(text(html).includes('Reduced advance · 10% · '),
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

  test('is offered Needs Changes and Reject, and no employee control', () => {
    assert.deepEqual(buttonLabels(html), [REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL])
  })

  test('sees the employee’s reply that came with the submission', () => {
    assert.ok(text(html).includes('Corrected the fabric on line 3.'))
  })

  test('is shown NO final approval control at all, disabled or otherwise', () => {
    // A greyed "Approve" beside two live buttons was read as the current
    // approval action rather than as a promise about a later one. There is no
    // approval RPC in this phase; absence is the honest answer, and Phase C
    // introduces a real, unambiguous control.
    assert.ok(!hasInertApprove(html))
    assert.ok(!html.includes('cursor:not-allowed'))
    assert.ok(!text(html).includes('order-approval phase'))
    assert.ok(!read(SECTIONS).includes('APPROVE_DISABLED_REASON'),
      'the explanation has nothing left to explain')
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
    assert.ok(text(reviewerOnly).includes('Advance exception'), 'the STATE is visible to them')
    assert.deepEqual(buttonLabels(reviewerOnly),
      [REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL],
      'orders.approve_order does not settle a commercial term')
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
    assert.ok(!hasInertApprove(html), 'and no inert PI approval either')
  })

  test('the band states the condition and the reason, and no audit facts', () => {
    const body = text(html)
    assert.ok(body.includes('Reduced advance · 12.5% · '), 'what is being asked for')
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
      REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL,
      APPROVE_EXCEPTION_BUTTON_LABEL, REJECT_EXCEPTION_BUTTON_LABEL,
    ], 'the PI decisions first, then the one commercial term')
    assert.ok(raw.includes('pi-detail-workflow-band'),
      'and the advance decision is its own band, not a fourth button on the same row')
  })

  test('and no final PI approval is offered to either authority', () => {
    assert.ok(!hasInertApprove(raw))
  })

  test('a 0% proposal is spelled out where it is being decided', () => {
    assert.ok(html.includes('No advance · 0% · ₹0'))
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
    assert.deepEqual(buttonLabels(after), [REQUEST_CHANGES_BUTTON_LABEL, REJECT_BUTTON_LABEL],
      'the PI review decisions survive the advance decision')
    // And the settled exception does not redraw its own band.
    assert.ok(!text(after).includes('Advance exception'))
    assert.ok(!text(after).includes('Client pays on delivery.'),
      'the reason it was granted for lives in Activity now')
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
    assert.ok(!hasInertApprove(html))
  })

  test('is still told where the record stands, and what it is waiting on', () => {
    assert.ok(text(html).includes(WORKFLOW_HEADING.submitted))
    assert.equal(WORKFLOW_HEADING.submitted, 'Submitted for review')
    assert.ok(text(html).includes('Advance exception'),
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
    assert.ok(text(html).includes('12.5% · ₹1,47,500'))
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

  test('the overview columns follow the groups the record actually filled', () => {
    assert.ok(/\.pi-detail-overview \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css),
      'one column is the floor, for every case')
    // Two populated groups stay two columns at every width above the phone.
    assert.ok(/@media \(min-width: 768px\)[\s\S]*?\.pi-detail-overview-2 \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css))
    // Three become two on a tablet (snapshot spanning) and three on a desktop.
    assert.ok(/@media \(min-width: 768px\)[\s\S]*?\.pi-detail-overview-3 \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css))
    assert.ok(/@media \(min-width: 1180px\)[\s\S]*?\.pi-detail-overview-3 \{\s*grid-template-columns: minmax\(0, 1\.05fr\) minmax\(0, 0\.8fr\) minmax\(0, 1fr\)/.test(css))
    // And a lone snapshot is allowed to be bigger rather than leaving a gap.
    assert.ok(/\.pi-detail-overview-1 \.pi-detail-snapshot-total/.test(css))
  })

  test('the commercial snapshot is read first on a phone and spans the tablet row', () => {
    assert.ok(/\.pi-detail-snapshot \{\s*order: -1;/.test(css))
    assert.ok(/@media \(min-width: 768px\)[\s\S]*?\.pi-detail-overview-3 \.pi-detail-snapshot \{[\s\S]*?grid-column: 1 \/ -1/.test(css))
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

  test('identity, overview, workflow, blocking — all ABOVE the products', () => {
    const order = [
      '<PiIdentityStrip',
      '<PiOrderOverview',
      '<PiWorkflowPanel',
      '<PiBlockingPanel',
      '{/* Products */}',
    ].map(at)
    assert.deepEqual([...order].sort((a, b) => a - b), order,
      'nobody should scroll a product table to find out what is being asked of them')
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
      'PiIdentityStrip', 'PiOrderOverview', 'PiWorkflowPanel', 'PiAdvanceBand',
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

// ── Nothing new was introduced ────────────────────────────────────────────────

describe('the redesign added no route, no query, no RPC and no permission', () => {
  const page = read(PAGE)

  test('the same five tables are read, and no others', () => {
    const tables = [...page.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    assert.deepEqual([...new Set(tables)].sort(), [
      'order_submission_activity',
      'order_submission_item_images',
      'order_submission_items',
      'order_submissions',
      'users',
    ])
  })

  test('the same five RPCs are called, and no others', () => {
    const rpcs = [...page.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(rpcs)].sort(), [
      'approve_pi_advance_exception',
      'reject_order_submission',
      'reject_pi_advance_exception',
      'request_order_submission_changes',
      'submit_order_submission_with_advance',
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
