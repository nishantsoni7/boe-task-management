/**
 * THERE IS ONE PAYMENT POPUP, AND THE DECISION IS A SECTION OF IT.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Payment Requests used to have two popups: the details window (from the row's
 * View icon) and a separate review window (from clicking the row, for a
 * verifier). Somebody who took the obvious route could end up in the one that
 * could not decide; somebody who clicked the row got a different, differently
 * designed window. They are now ONE: clicking anywhere on a row opens the
 * details popup for every reader and every status, and the verifier's decision
 * (Verify Payment / Needs Clarification / Reject) is a Decision section inside
 * it, drawn only for somebody who may decide.
 *
 * WHAT IS PINNED HERE
 *   * there is one popup and one way in (the row), and no View icon;
 *   * the decision rules and wiring are exactly what the review window had —
 *     the three decisions, the note rules, the approval RPC, the two doors for
 *     send-back and reject, the notifications, the double-click guard;
 *   * the Decision section is drawn only for a verifier and supersedes the admin
 *     status-correction select (which stays for everybody else who may correct);
 *   * Edit, Delete, the bank panel slot and the destination read are intact.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentVerificationModal.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const page = read('src/app/finance/page.tsx')
const table = read('src/app/finance/paymentRequestsTable.tsx')
const details = read('src/app/finance/paymentRequestsDetails.tsx')

/** Source with comments stripped — assertions about what the CODE does. */
const stripComments = (s: string) => s.split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*') && !l.trim().startsWith('{/*'))
  .join('\n')
const code = stripComments(details)
const pageCode = stripComments(page)
const tableCode = stripComments(table)

describe('there is one popup, opened from anywhere on the row', () => {
  test('the old review window is gone from the page and from the repository', () => {
    assert.ok(!pageCode.includes('AdminReviewModal'))
    assert.ok(!pageCode.includes('reviewRequest'))
    assert.ok(!pageCode.includes('setReviewRequest'))
    assert.throws(() => readFileSync(join(process.cwd(), 'src/app/finance/paymentRequestsAdminReview.tsx')))
  })

  test('a row click opens the details popup for everybody, whatever the status', () => {
    assert.ok(pageCode.includes('const handleRowClick = (r: PaymentRequest) => setDetailRequest(r)'))
  })

  test('a deep link (?request=, a notification) opens the same popup', () => {
    const block = page.slice(page.indexOf('if (match) {'), page.indexOf('router.replace(`/finance?tab='))
    assert.ok(block.includes('setDetailRequest(match)'))
    assert.ok(!block.includes('canApprovePayment'), 'no second route for a verifier')
  })

  test('the table has no View icon and no onView prop; the row itself is the control', () => {
    assert.ok(!tableCode.includes('onView'))
    assert.ok(!tableCode.includes('aria-label={`View payment request'))
    assert.ok(!/\bEye\b/.test(tableCode))
    assert.ok(table.includes('onClick={() => onRowClick(r)}'))
    // The keyboard can open it too, but only when the row itself has the focus:
    // Enter on a link or an icon inside the row is that control's own.
    assert.ok(table.includes('if (e.target !== e.currentTarget) return'))
    assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(table))
  })

  test('the Edit and Delete icons and the Against link do not open the popup', () => {
    assert.ok(table.includes('onClick={e => e.stopPropagation()}'), 'the action cluster and the link stop the row click')
  })

  test('only one payment popup is mounted', () => {
    assert.equal((pageCode.match(/<DetailsModal/g) ?? []).length, 1)
  })
})

describe('the Decision section: three outcomes, the rules the review window had', () => {
  test('the three decisions, in that order, with their wording', () => {
    assert.ok(details.includes("{ key: 'approve',             label: 'Verify Payment',"))
    assert.ok(details.includes("{ key: 'needs_clarification', label: 'Needs Clarification',"))
    assert.ok(details.includes("{ key: 'reject',              label: 'Reject',"))
    const order = ['Verify Payment', 'Needs Clarification', "label: 'Reject'"].map(s => details.indexOf(s))
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })

  test('the decisions are a radio list with a visible selected state', () => {
    assert.ok(code.includes('role="radiogroup"'))
    assert.ok(code.includes('role="radio"') && code.includes('aria-checked={on}'))
  })

  test('a note is required to send back or reject, optional to verify', () => {
    assert.ok(code.includes("const decisionNoteRequired = decisionAction === 'needs_clarification' || decisionAction === 'reject'"))
    assert.ok(code.includes("(!decisionNoteRequired || decisionNote.trim() !== '')"))
    assert.ok(code.includes('Rejection reason (required)'))
    assert.ok(code.includes('Note for the salesperson (optional)'))
  })

  test('APPROVAL LOGIC IS THE REVIEW WINDOW’S — the RPC, both doors and every notification', () => {
    assert.ok(code.includes("supabase.rpc('approve_finance_payment_request'"))
    // PR #172: send-back and rejection go through their doors; a direct status
    // write is refused in production by the reset guard.
    assert.ok(code.includes('await sendBackOrReject(supabase, { requestId: r.id, action: decisionAction, note: decisionNote })'))
    for (const event of ['finance_approved_suspense', 'finance_approved_linked', 'finance_clarification', 'finance_rejected']) {
      assert.ok(code.includes(event), `${event} must still be sent`)
    }
    assert.ok(code.includes('REVIEW_STALE_MESSAGE'), 'a decision that changed nothing is an error, not a success')
    assert.ok(code.includes("decisionAction !== 'needs_clarification' && r.order_id"), 'a rejection tells the Order; a clarification does not')
  })

  test('a double click cannot decide twice', () => {
    assert.ok(code.includes('const decidingRef = useRef(false)'))
    assert.ok(code.indexOf('decidingRef.current = true') < code.indexOf("supabase.rpc('approve_finance_payment_request'"),
      'the guard is set BEFORE the await')
  })

  test('it is drawn only for somebody who may decide, and supersedes the status select', () => {
    assert.ok(code.includes('const decisionBlock = canVerify && supabase && onCorrected ? ('))
    assert.ok(code.includes('canVerifyPayment(r.status, mayApprovePayments)'))
    assert.ok(code.includes('!isOwnPaymentDecision(r.submitted_by, userId, mayDecideOwnPayments)'))
    // Everybody else who may correct keeps the admin status select; a verifier
    // decides through the Decision section instead of a free-form status.
    assert.ok(code.includes('mayCorrectPayments && supabase && onCorrected && !isLinkageStatus && !canVerify'))
  })

  test('no approved status is ever an option in a status <select>', async () => {
    const { STATUS_CORRECTION_OPTIONS } = await import('./paymentRequestsAtoms')
    for (const o of STATUS_CORRECTION_OPTIONS) {
      assert.ok(!['approved_unlinked', 'approved_linked'].includes(o.value))
    }
  })

  test('the page reloads the list and the Confirmed Payments count after a decision', () => {
    const block = page.slice(page.indexOf('<DetailsModal'), page.indexOf('<EditPaymentModal'))
    assert.ok(block.includes('RECEIVED_PAYMENTS_COUNTS_KEY'))
    assert.ok(block.includes('refreshAfterMutation()'))
  })
})

describe('what the popup keeps', () => {
  test('the account is named by the shared resolver, so a legacy row still names one', async () => {
    const { paymentDestinationLabel } = await import('./paymentDestinations')
    assert.equal(paymentDestinationLabel('hdfc', null), 'HDFC PRI')
    assert.equal(paymentDestinationLabel('hdfc_sec', null), 'HDFC SEC')
    assert.equal(paymentDestinationLabel('bank_transfer', 'company_account'), 'HDFC PRI')
  })

  test('the destination is read once, and the popup still says what the payment is for', () => {
    assert.equal((code.match(/usePaymentDestination\(/g) ?? []).length, 1)
    assert.ok(code.includes('<PaymentDestinationSummary'))
  })

  test('Activity, the proof, the reference and the notes are still there', () => {
    assert.ok(code.includes('<PaymentRequestActivity'))
    assert.ok(code.includes('<PaymentProofView'))
    assert.ok(code.includes('r.proof_note'))
    assert.ok(code.includes('r.sales_note'))
  })

  test('Edit (or Reapply) and Delete are still in the pinned footer, on the same rules', () => {
    assert.ok(code.includes('onEdit && canManage'))
    assert.ok(code.includes('onDelete && canDelete'))
    assert.ok(code.includes("{!isAdmin && r.status === 'rejected' ? 'Reapply' : 'Edit'}"))
  })

  test('the page hands over Edit and Delete and closes the popup as they open', () => {
    assert.ok(pageCode.includes('onEdit={r => { setDetailRequest(null); setEditRequest(r) }}'))
    assert.ok(pageCode.includes('onDelete={r => { setDetailRequest(null); openDelete(r) }}'))
  })

  test('the bank-statement panel is a slot the page fills only for finance.reconcile', () => {
    assert.ok(code.includes('body={bankWindow && !showDetails ? bankPanel : undefined}') && code.includes('{!bankWindow && bankPanel}'))
    assert.ok(!code.includes('bank_statement') && !code.includes('link_bank_line_to_payment'), 'the popup knows nothing about the bank')
    assert.ok(pageCode.includes("bankPanel={caps.canReconcileBank && detailRequest.status !== 'rejected' ? ("))
    assert.ok(pageCode.includes('payment={detailRequest}'))
  })
})
