/**
 * Orders & Finance launch audit (2026-09-19) — the launch-blocking fixes, pinned.
 *
 *   1. A restricted Finance reader (finance.view, no view_all) saw a PARTIAL
 *      allocation total presented as complete — in the payment detail panel and
 *      in Allocate Funds' "Remaining" — while the list showed the true figures.
 *   2. Record Payment could record the same money twice after a failed proof
 *      upload.
 *   3. Amounts with more than two decimals could be entered and stored.
 *   4. Needs-clarification / reject could report success (and notify) when no
 *      row changed.
 *   5. The PI payment form refused today's date for 5.5 hours every morning.
 *   6. Confirmed Orders turned a failed read into "No orders found."
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildAllocatedAgainst,
  completeAllocatedTotal,
  completeAllocationSummary,
  type AllocationTargetRow,
} from './allocatedAgainst'
import { summarizePaymentAllocations } from './paymentAllocations'
import { isValidAmount, sanitizeAmountInput } from '@/lib/currency'
import { localTodayIso } from './piPaymentView'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const PAY = '30000000-0000-4000-8000-000000000099'
const ORDER_A = '10000000-0000-4000-8000-00000000000a'
const ORDER_B = '10000000-0000-4000-8000-00000000000b'
const PI_C = '20000000-0000-4000-8000-00000000000c'
const row = (id: string, type: 'order' | 'pi_draft', target: string, amount: string): AllocationTargetRow => ({
  payment_request_id: PAY, allocation_id: id, target_type: type, target_id: target,
  target_reference: type === 'order' ? '0601' : 'C.xlsx', reserved_order_number: null, allocated_amount: amount,
})

// The COMPLETE read, as received_payment_allocation_targets() returns it: every
// ACTIVE allocation, reversed ones already excluded by the RPC.
const COMPLETE = [
  row('a1', 'order', ORDER_A, '30000.00'),
  row('a2', 'order', ORDER_A, '20000.00'),   // a duplicate ledger row, same target
  row('a3', 'order', ORDER_B, '40000.00'),   // on an Order this reader cannot open
]

describe('1. a restricted reader is shown the COMPLETE totals, not their RLS slice', () => {
  test('the D1 scenario: ₹1,00,000, ₹50,000 visible on A, ₹40,000 hidden on B', () => {
    // What the reader's own RLS returned (A's rows only) — the old source.
    const partial = summarizePaymentAllocations(
      [{ id: PAY, amount: '100000.00' }],
      [
        { id: 'a1', payment_request_id: PAY, order_id: ORDER_A, order_submission_id: null, allocated_amount: '30000.00', status: 'active' },
        { id: 'a2', payment_request_id: PAY, order_id: ORDER_A, order_submission_id: null, allocated_amount: '20000.00', status: 'active' },
      ] as never,
    ).get(PAY)!
    assert.equal(partial.allocated, '50000.00', 'the defect: the RLS slice alone says ₹50,000')

    const complete = completeAllocationSummary({ id: PAY, amount: '100000.00' }, COMPLETE, { covered: true })!
    assert.equal(complete.allocated, '90000.00')
    assert.equal(complete.unallocated, '10000.00')
    assert.equal(complete.state, 'partial')
    assert.equal(complete.targets.length, 3, 'the detail keeps the ledger rows separate — history is not merged')

    // And it agrees with the list's own cell, which combines duplicates for display.
    const cell = buildAllocatedAgainst({ id: PAY, amount: '100000.00' }, COMPLETE, { covered: true })
    assert.equal(cell.kind, 'targets')
    if (cell.kind === 'targets') {
      assert.equal(cell.lines.length, 2, 'the list combines the two A rows into one line')
      assert.equal(cell.unallocated, complete.unallocated)
      assert.equal(cell.status, 'partial')
    }
  })

  test('Allocate Funds gets the complete existing total', () => {
    assert.equal(completeAllocatedTotal(PAY, COMPLETE, { covered: true }), '90000.00')
  })

  test('exact paise, no floating point', () => {
    const rows = [row('p1', 'order', ORDER_A, '250000.50'), row('p2', 'pi_draft', PI_C, '125000.25')]
    const s = completeAllocationSummary({ id: PAY, amount: '1000000.00' }, rows, { covered: true })!
    assert.equal(s.allocated, '375000.75')
    assert.equal(s.unallocated, '624999.25')
  })

  test('zero, full and over read exactly', () => {
    assert.equal(completeAllocationSummary({ id: PAY, amount: '1000000' }, [], { covered: true })!.state, 'unallocated')
    assert.equal(completeAllocationSummary({ id: PAY, amount: '1000000' }, [row('f', 'order', ORDER_A, '1000000.00')], { covered: true })!.state, 'full')
    assert.equal(completeAllocationSummary({ id: PAY, amount: '100' }, [row('o', 'order', ORDER_A, '100.01')], { covered: true })!.state, 'over')
  })

  test('no complete answer → null, and the caller keeps its conservative path', () => {
    assert.equal(completeAllocationSummary({ id: PAY, amount: '1' }, null, { covered: true }), null, 'still loading')
    assert.equal(completeAllocationSummary({ id: PAY, amount: '1' }, COMPLETE, { covered: false }), null, 'not covered')
    assert.equal(completeAllocationSummary({ id: PAY, amount: '1' }, COMPLETE, { covered: true, readFailed: true }), null, 'read failed')
    assert.equal(completeAllocatedTotal(PAY, [row('x', 'order', ORDER_A, 'garbage')], { covered: true }), null, 'unreadable amount')
  })

  test('the page uses the complete read for exactly those readers, and for Allocate Funds', () => {
    const view = code('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(view.includes('(!caps.canViewAllFinance && completeAllocationSummary(detailRequest, allocationTargets.rows, {'),
      'the detail panel: complete figures when the reader lacks view_all; admins keep the direct read')
    assert.ok(view.includes('allocated_total: completeAllocatedTotal(allocateFundsTarget.id, allocationTargets.rows, {'),
      'Allocate Funds: the complete existing total')
    assert.ok(view.includes('}) ?? allocateFundsTarget.allocated_total,'), 'falling back only when uncovered')
  })
})

describe('2. Record Payment cannot record the same money twice', () => {
  const src = code('src/app/finance/received/RecordSplitPaymentModal.tsx')

  test('a failed proof upload keeps the in-flight guard set and ends the form', () => {
    const save = src.slice(src.indexOf('const handleSave = async'))
    const branch = save.slice(save.indexOf('if (proofError) {'), save.indexOf('if (proofError) {') + 400)
    assert.ok(!branch.includes('submitting.current = false'), 'the guard is NOT reset once the payment exists')
    assert.ok(branch.includes('setRecordedWithoutProof({'))
  })

  test('what is left is Close, which refreshes the list, or a proof retry on the SAME payment', () => {
    assert.ok(src.includes('{recordedWithoutProof ? ('))
    assert.ok(src.includes('onClick={() => onRecorded(recordedWithoutProof)}'))
    const retry = src.slice(src.indexOf('const retryProof = async'), src.indexOf('const changeDestination'))
    assert.ok(retry.includes('paymentRequestId: recordedWithoutProof.paymentRequestId'),
      'the retry attaches the file to the payment already recorded')
    assert.ok(!retry.includes('.rpc('), 'and calls no payment door')
    assert.ok(src.includes('onClose: recordedWithoutProof ? () => onRecorded(recordedWithoutProof) : onClose,'),
      'X and Escape close at once too, with nothing left to discard')
    assert.ok(src.includes('if (blocked || saving || submitting.current) return'), 'the save still refuses re-entry')
  })
})

describe('3. money is rupees and paise — never more than two decimals', () => {
  test('validation', () => {
    // '12.' (mid-typing) and '.5' read as they always did — splitPaymentEntry.test.ts pins the first.
    for (const ok of ['1', '1000', '1000.5', '1000.50', '1000000.00', '0.01', '12.', '.5']) assert.ok(isValidAmount(ok), ok)
    for (const bad of ['', '.', '0', '0.00', '-5', '1000.005', '12.345', '1e5', 'abc', '1,000', '+5']) {
      assert.equal(isValidAmount(bad), false, bad)
    }
  })

  test('the input never truncates: a third decimal stays visible and is refused', () => {
    // CORRECTED (PR #172 review): cutting 1000.0059 to 1000.00 was itself a
    // silent change of amount. See src/app/finance/amountEntry.render.test.tsx.
    assert.equal(sanitizeAmountInput('1000.0059'), '1000.0059')
    assert.equal(isValidAmount(sanitizeAmountInput('1000.0059')), false)
    assert.equal(sanitizeAmountInput('₹10,00,000.5'), '1000000.5')
    assert.equal(sanitizeAmountInput('1.2.3'), '1.2.3')
  })
})

describe('4. a clarification or rejection that changed nothing does not report success', () => {
  // REVISED (PR #172 review): the modal no longer writes the table at all — a
  // direct UPDATE is refused in production by the reset guard. It decides through
  // request_finance_payment_clarification / reject_finance_payment_request, which
  // lock the row and act only while it is pending. The behaviour is proved in
  // src/lib/finance/reviewDecision.test.ts and the database suite; this keeps the
  // original promise pinned: a stale decision is an error and notifies nobody.
  const page = code('src/app/finance/page.tsx')
  const at = page.indexOf('await sendBackOrReject(supabase, { requestId: r.id, action, note: adminNote })')

  test('a stale decision is an error, and the creator is notified only after a real change', () => {
    assert.ok(at > -1)
    const stale = page.indexOf("if (outcome.kind === 'stale') { setError(REVIEW_STALE_MESSAGE); return }", at)
    const notify = page.indexOf('void notifyFinance({', at)
    assert.ok(stale > at && notify > stale)
  })
})

describe('5. the PI payment form accepts today in the reader\'s own time zone', () => {
  test('local date, not UTC', () => {
    // 02:00 local on 19 Sept — still 18 Sept in UTC for any zone east of UTC.
    assert.equal(localTodayIso(new Date(2026, 8, 19, 2, 0)), '2026-09-19')
    assert.equal(localTodayIso(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  })

  test('the PI page uses it', () => {
    const page = code('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(page.includes('todayIso={localTodayIso()}'))
    assert.ok(!page.includes("todayIso={new Date().toISOString().slice(0, 10)}"))
  })
})

describe('6. Confirmed Orders never states "No orders found" about a read that failed', () => {
  const page = code('src/app/orders/all/page.tsx')

  test('the error is read, and the rows on screen are kept', () => {
    const loader = page.slice(page.indexOf('const loadOrders = async'), page.indexOf('const loadOrders = async') + 1200)
    assert.ok(loader.includes('const { data, error } = await supabase'))
    const onError = loader.slice(loader.indexOf('if (error) {'), loader.indexOf('setLoadError(null)'))
    assert.ok(onError.includes('setLoadError(') && onError.includes('return'))
    assert.ok(!onError.includes('setOrders('), 'a failed refresh does not blank the list')
  })

  test('it says so and offers Retry; the empty statement is withheld', () => {
    assert.ok(page.includes('{loadError && ('))
    assert.ok(page.includes('role="alert"'))
    assert.ok(page.includes(') : loadError && orders.length === 0 ? ('))
  })
})
