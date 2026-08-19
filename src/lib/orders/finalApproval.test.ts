/**
 * Phase C — the rules the browser applies, and the words it applies them in.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Two decisions arrive with this phase, and both of them are gated by rules that
 * exist twice: once in SQL, where they decide what may happen, and once here,
 * where they decide what a person is shown. This file proves the second copy
 * behaves like the first — the staleness rule, the two-authority split, the
 * eligibility order — and proves the browser never acquires an opinion about an
 * Order number.
 *
 * The SQL half is covered by finalApprovalSchema.test.ts, which reads the
 * migration itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/finalApproval.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  APPROVAL_BLOCKED_ADVANCE_PENDING,
  APPROVAL_BLOCKED_ADVANCE_REJECTED,
  APPROVAL_BLOCKED_ADVANCE_UNDECLARED,
  APPROVAL_BLOCKED_BLOCKING_ISSUES,
  APPROVAL_BLOCKED_DELETION,
  APPROVAL_BLOCKED_FINANCE,
  APPROVAL_BLOCKED_NO_LINES,
  APPROVE_ORDER_BUTTON_LABEL,
  APPROVE_ORDER_CONFIRM_LABEL,
  APPROVE_ORDER_DIALOG_TITLE,
  APPROVE_ORDER_FINAL_NOTE,
  APPROVE_ORDER_NOT_A_PAYMENT,
  FINANCE_PENDING_TEXT,
  PI_APPROVAL_COLUMNS,
  PI_FINANCE_COLUMNS,
  VERIFY_FINANCE_BUTTON_LABEL,
  VERIFY_FINANCE_CONFIRM,
  VERIFY_FINANCE_NOT_A_PAYMENT,
  describeApprovalReadiness,
  describeFinanceStatus,
  financeVerificationIsCurrent,
  financeVerifiedLine,
  orderHref,
  readApprovalOutcome,
  type PersistedFinanceVerification,
} from './finalApproval'
import { deriveOrdersCapabilities } from '../permissions/orders'
import { deriveFinanceCapabilities } from '../permissions/finance'
import { isProtectedAction } from '../permissions/levels'
import type { EffectivePermission } from '../permissions/types'
import type { PersistedAdvance } from './advanceRequirement'

const perms = (actions: string[]): EffectivePermission[] =>
  actions.map(actionKey => ({ actionKey, allowed: true, source: 'role' }))

/**
 * A TypeScript source with its `//` comments removed.
 *
 * Every module in this feature documents at length what it must NOT do, naming
 * the forbidden thing in order to explain why it is absent. A forbidden-text
 * check reading raw text would fail on those sentences, so it reads code.
 */
const code = (source: string): string =>
  source.split('\n').filter(line => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')).join('\n')

const SUBMITTED_AT = '2026-08-03T04:00:00Z'
const VERIFIER = '22222222-2222-4222-8222-222222222222'

const unverified: PersistedFinanceVerification = {
  finance_verified_by: null,
  finance_verified_at: null,
  finance_verified_submission_at: null,
}

const verified = (boundTo: string = SUBMITTED_AT): PersistedFinanceVerification => ({
  finance_verified_by: VERIFIER,
  finance_verified_at: '2026-08-03T09:30:00Z',
  finance_verified_submission_at: boundTo,
})

const noAdvance: PersistedAdvance = {
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
}

const standard: PersistedAdvance = { ...noAdvance, advance_condition: 'standard' }

const exception = (
  percent: number,
  status: 'pending' | 'approved' | 'rejected',
): PersistedAdvance => ({
  ...noAdvance,
  advance_condition: 'exception',
  advance_exception_percent: percent,
  advance_exception_reason: 'Client settles on delivery.',
  advance_exception_status: status,
  advance_exception_requested_by: VERIFIER,
  advance_exception_requested_at: SUBMITTED_AT,
})

// ── The staleness rule ────────────────────────────────────────────────────────

describe('a finance verification is current only for the submission it was made against', () => {
  test('a verification bound to THIS submission is current', () => {
    assert.equal(financeVerificationIsCurrent(verified(), SUBMITTED_AT), true)
  })

  test('no verification is not a current one', () => {
    assert.equal(financeVerificationIsCurrent(unverified, SUBMITTED_AT), false)
  })

  test('a verification carried over from an EARLIER submission is stale', () => {
    // The case the whole design exists for: the PI was returned, corrected and
    // resubmitted, which took a new submitted_at. The sign-off was made against
    // a document that is no longer the one under review.
    const stale = verified('2026-07-20T04:00:00Z')
    assert.equal(financeVerificationIsCurrent(stale, SUBMITTED_AT), false)
  })

  test('a record that was never submitted can carry no current verification', () => {
    assert.equal(financeVerificationIsCurrent(verified(), null), false)
  })

  test('half a verification is not a verification', () => {
    assert.equal(financeVerificationIsCurrent(
      { ...verified(), finance_verified_at: null }, SUBMITTED_AT), false)
    assert.equal(financeVerificationIsCurrent(
      { ...verified(), finance_verified_submission_at: null }, SUBMITTED_AT), false)
  })

  test('the same instant written two ways is still the same instant', () => {
    // PostgREST may render a timestamptz as '+00:00' or as 'Z'. A string
    // comparison would call one submission's own verification stale, which is
    // the sort of defect that only shows up in production.
    assert.equal(
      financeVerificationIsCurrent(verified('2026-08-03T04:00:00+00:00'), '2026-08-03T04:00:00Z'),
      true,
    )
  })

  test('the browser rule mirrors the database predicate, name for name', () => {
    const source = readFileSync('src/lib/orders/finalApproval.ts', 'utf8')
    assert.ok(source.includes('order_submission_finance_verified'),
      'and says which database function it is the mirror of')
  })
})

// ── The finance line ──────────────────────────────────────────────────────────

describe('what the workflow area says about finance', () => {
  const base = {
    submittedAtIso: SUBMITTED_AT,
    canVerifyFinance: false,
    verifiedAt: '03 Aug 2026, 03:00 pm',
    verifierName: 'Asha Menon',
  }

  test('a submitted, unverified PI says verification is pending', () => {
    const view = describeFinanceStatus({ ...base, status: 'submitted', verification: unverified })
    assert.equal(view?.verified, false)
    assert.equal(view?.text, FINANCE_PENDING_TEXT)
    assert.equal(FINANCE_PENDING_TEXT, 'Finance verification pending.')
  })

  test('a verified PI names the verifier and the time', () => {
    const view = describeFinanceStatus({ ...base, status: 'submitted', verification: verified() })
    assert.equal(view?.verified, true)
    assert.equal(view?.text, 'Verified by Asha Menon · 03 Aug 2026, 03:00 pm')
    assert.equal(view?.text, financeVerifiedLine('Asha Menon', '03 Aug 2026, 03:00 pm'))
  })

  test('a stale verification reads as pending, not as verified', () => {
    const view = describeFinanceStatus({
      ...base, status: 'submitted', verification: verified('2026-07-20T04:00:00Z'),
    })
    assert.equal(view?.verified, false)
    assert.equal(view?.text, FINANCE_PENDING_TEXT)
  })

  test('the question does not arise on a draft, a returned or a rejected record', () => {
    for (const status of ['draft', 'needs_changes', 'rejected']) {
      assert.equal(
        describeFinanceStatus({ ...base, status, verification: unverified }), null,
        `${status} has nothing to verify`)
    }
  })

  test('an approved record keeps its verification on screen, forever', () => {
    // Who signed the figures off is part of the approved record's history. The
    // database deliberately does NOT clear it at approval, and this reads it
    // straight rather than re-testing it against a submitted_at that no longer
    // moves.
    const view = describeFinanceStatus({ ...base, status: 'approved', verification: verified() })
    assert.equal(view?.verified, true)
    assert.equal(view?.canVerify, false, 'and there is nothing left to verify')
  })

  test('EVERYBODY who can read the PI sees the state; only the control is gated', () => {
    const withoutAuthority = describeFinanceStatus({
      ...base, status: 'submitted', verification: unverified, canVerifyFinance: false,
    })
    const withAuthority = describeFinanceStatus({
      ...base, status: 'submitted', verification: unverified, canVerifyFinance: true,
    })
    assert.equal(withoutAuthority?.text, withAuthority?.text, 'the same state either way')
    assert.equal(withoutAuthority?.canVerify, false)
    assert.equal(withAuthority?.canVerify, true)
  })

  test('an already-verified PI offers no second verification', () => {
    const view = describeFinanceStatus({
      ...base, status: 'submitted', verification: verified(), canVerifyFinance: true,
    })
    assert.equal(view?.canVerify, false)
  })
})

// ── Eligibility ───────────────────────────────────────────────────────────────

describe('whether the final approval control may be pressed', () => {
  const ready = {
    status: 'submitted',
    financeVerified: true,
    advance: standard,
    hasBlockingIssues: false,
    productCount: 3,
    deletionClaimed: false,
  }

  test('a verified, standard-advance, clean submitted PI is ready', () => {
    const outcome = describeApprovalReadiness(ready)
    assert.equal(outcome.ready, true)
    assert.equal(outcome.blocker, null)
  })

  test('approval is blocked before finance has verified', () => {
    const outcome = describeApprovalReadiness({ ...ready, financeVerified: false })
    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_FINANCE)
  })

  test('a PENDING advance exception blocks approval', () => {
    const outcome = describeApprovalReadiness({ ...ready, advance: exception(12.5, 'pending') })
    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_ADVANCE_PENDING)
  })

  test('a REJECTED advance exception blocks approval', () => {
    const outcome = describeApprovalReadiness({ ...ready, advance: exception(12.5, 'rejected') })
    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_ADVANCE_REJECTED)
  })

  test('an APPROVED exception — reduced or zero — is ready', () => {
    for (const percent of [0, 0.5, 12.5, 39.99]) {
      const outcome = describeApprovalReadiness({ ...ready, advance: exception(percent, 'approved') })
      assert.equal(outcome.ready, true, `${percent}% approved`)
    }
  })

  test('an undeclared advance requirement blocks approval', () => {
    const outcome = describeApprovalReadiness({ ...ready, advance: noAdvance })
    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_ADVANCE_UNDECLARED)
  })

  test('blocking diagnostics block approval', () => {
    const outcome = describeApprovalReadiness({ ...ready, hasBlockingIssues: true })
    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_BLOCKING_ISSUES)
  })

  test('a PI with no stored product lines blocks approval', () => {
    const outcome = describeApprovalReadiness({ ...ready, productCount: 0 })
    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_NO_LINES)
  })

  test('a deletion reservation blocks approval, ahead of everything else', () => {
    // A record being erased is not a record to decide on, and it is checked
    // first because every other blocker would be describing a record that is
    // about to stop existing.
    const outcome = describeApprovalReadiness({
      ...ready, deletionClaimed: true, financeVerified: false, hasBlockingIssues: true,
    })
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_DELETION)
  })

  test('draft, needs_changes, rejected and approved are never ready', () => {
    for (const status of ['draft', 'needs_changes', 'rejected', 'approved']) {
      const outcome = describeApprovalReadiness({ ...ready, status })
      assert.equal(outcome.ready, false, status)
      assert.equal(outcome.blocker, null,
        'and no blocker either: the control is not drawn at all, so there is nothing to explain')
    }
  })

  test('every blocker is an actionable task, never a note about the roadmap', () => {
    for (const message of [
      APPROVAL_BLOCKED_FINANCE, APPROVAL_BLOCKED_ADVANCE_PENDING,
      APPROVAL_BLOCKED_ADVANCE_REJECTED, APPROVAL_BLOCKED_ADVANCE_UNDECLARED,
      APPROVAL_BLOCKED_BLOCKING_ISSUES, APPROVAL_BLOCKED_NO_LINES, APPROVAL_BLOCKED_DELETION,
    ]) {
      assert.ok(message.length > 0)
      assert.ok(!/phase|coming|soon|not yet available/i.test(message), message)
    }
  })

  test('the browser check follows the RPC’s own order of checks', () => {
    // A reviewer who fixes what the screen told them to fix must not then be
    // refused for something the screen would have mentioned second.
    const source = readFileSync('src/lib/orders/finalApproval.ts', 'utf8')
    const order = ['deletionClaimed', 'financeVerified', 'advanceIsReady', 'hasBlockingIssues', 'productCount']
    let cursor = source.indexOf('export function describeApprovalReadiness')
    for (const step of order) {
      const next = source.indexOf(step, cursor)
      assert.ok(next > cursor, `${step} is checked out of order`)
      cursor = next
    }
  })
})

// ── The two authorities ───────────────────────────────────────────────────────

describe('verification and approval are separate authorities, in both directions', () => {
  test('orders.approve_order approves and does NOT verify', () => {
    const orders = deriveOrdersCapabilities('employee', perms(['view', 'approve_order']))
    const finance = deriveFinanceCapabilities('employee', perms([]))
    assert.equal(orders.canApproveOrderSubmission, true)
    assert.equal(finance.canApprovePayment, false, 'approve_order confers no finance authority')
  })

  test('finance.approve verifies and does NOT approve', () => {
    const orders = deriveOrdersCapabilities('employee', perms(['view']))
    const finance = deriveFinanceCapabilities('employee', perms(['view', 'approve']))
    assert.equal(finance.canApprovePayment, true)
    assert.equal(orders.canApproveOrderSubmission, false, 'finance.approve confers no PI approval')
  })

  test('finance.approve without Finance module entry verifies nothing', () => {
    // The withEntry rule: an employee whose Finance access was switched off does
    // not keep signing off Finance decisions because an action row survived.
    const finance = deriveFinanceCapabilities('employee', perms(['approve']))
    assert.equal(finance.canApprovePayment, false)
  })

  test('an active admin holds both, exactly as the database has it', () => {
    assert.equal(deriveOrdersCapabilities('admin', []).canApproveOrderSubmission, true)
    assert.equal(deriveFinanceCapabilities('admin', []).canApprovePayment, true)
  })

  test('approve_order is still protected, so no preset hands out PI approval', () => {
    assert.equal(isProtectedAction('approve_order'), true)
  })
})

// ── The Order number never comes from here ────────────────────────────────────

describe('the browser has no opinion about an Order number', () => {
  test('the RPC result is read, never composed', () => {
    const outcome = readApprovalOutcome({
      submission_id: 'sub', order_id: 'order-1', display_number: '0413', already_approved: false,
    })
    assert.deepEqual(outcome, { orderId: 'order-1', displayNumber: '0413', alreadyApproved: false })
  })

  test('a retry that found the PI already approved is reported as such', () => {
    const outcome = readApprovalOutcome({
      order_id: 'order-1', display_number: '0413', already_approved: true,
    })
    assert.equal(outcome?.alreadyApproved, true)
    assert.equal(outcome?.displayNumber, '0413', 'and carries the number that already exists')
  })

  test('a response missing the number yields null, never a made-up one', () => {
    for (const value of [
      null, undefined, {}, 'ok', 42,
      { order_id: 'order-1' },
      { display_number: '0413' },
      { order_id: 'order-1', display_number: '' },
      { order_id: '', display_number: '0413' },
      { order_id: 'order-1', display_number: 413 },
    ]) {
      assert.equal(readApprovalOutcome(value), null, JSON.stringify(value ?? null))
    }
  })

  test('the module contains no numbering arithmetic of any kind', () => {
    // CODE, not commentary. The header legitimately EXPLAINS that a number is
    // allocated elsewhere, and a check reading raw text would fail on the very
    // sentence promising the thing it verifies — the same reason the migration
    // suites strip comments before scanning.
    const source = code(readFileSync('src/lib/orders/finalApproval.ts', 'utf8'))
    for (const forbidden of [
      'padStart', 'padEnd', 'toString(10)', 'Math.max', '+ 1', 'display_number +',
      'allocate', 'sequence', 'nextval',
    ]) {
      assert.ok(!source.includes(forbidden), `${forbidden} would be the browser inventing a number`)
    }
  })

  test('the Order link is built in one place', () => {
    assert.equal(orderHref('abc-123'), '/orders/abc-123')
    assert.equal(orderHref('a b'), '/orders/a%20b', 'and the id is encoded')
  })
})

// ── The words ─────────────────────────────────────────────────────────────────

describe('the copy says what happens, and what does not', () => {
  test('the primary action names both halves of what it does', () => {
    assert.equal(APPROVE_ORDER_BUTTON_LABEL, 'Approve PI & Create Order')
    assert.equal(APPROVE_ORDER_DIALOG_TITLE, 'Approve PI & Create Order')
    assert.equal(APPROVE_ORDER_CONFIRM_LABEL, 'Approve & Create Order')
  })

  test('the approval dialog says approval is final, and that a number is assigned', () => {
    assert.ok(/final/i.test(APPROVE_ORDER_FINAL_NOTE))
    assert.ok(/official Order number/i.test(APPROVE_ORDER_FINAL_NOTE))
    assert.ok(/confirmed Order will be created/i.test(APPROVE_ORDER_FINAL_NOTE))
  })

  test('BOTH dialogs say, out loud, that no payment is recorded', () => {
    // The single most important sentence in this phase. "Verify" and "Approve"
    // beside a grand total are both read as "the money is in", and no payment
    // record exists anywhere here to make that true.
    assert.ok(/does not record receipt of any payment/i.test(APPROVE_ORDER_NOT_A_PAYMENT))
    assert.ok(/does not record receipt of any payment/i.test(VERIFY_FINANCE_NOT_A_PAYMENT))
    assert.ok(/No payment, request or receipt is created/i.test(VERIFY_FINANCE_NOT_A_PAYMENT))
  })

  test('the verification dialog says what it IS confirming', () => {
    assert.ok(/commercial figures/i.test(VERIFY_FINANCE_CONFIRM))
    assert.ok(/advance terms/i.test(VERIFY_FINANCE_CONFIRM))
    assert.equal(VERIFY_FINANCE_BUTTON_LABEL, 'Verify Finance')
  })

  test('nothing here promises a document that does not exist', () => {
    // Phase C generates no numbered .xlsx and no PDF. A "pending" label in the
    // employee UI would be a promise the product cannot keep.
    const source = readFileSync('src/lib/orders/finalApproval.ts', 'utf8')
    for (const forbidden of ['PDF', 'pdf', 'xlsx', 'download', 'Download', 'generation pending']) {
      assert.ok(!source.includes(forbidden), `${forbidden} belongs to a later phase`)
    }
  })
})

// ── The columns ───────────────────────────────────────────────────────────────

describe('the columns are named, never selected with a star', () => {
  test('the finance and approval columns are listed explicitly', () => {
    assert.deepEqual([...PI_FINANCE_COLUMNS], [
      'finance_verified_by', 'finance_verified_at', 'finance_verified_submission_at',
    ])
    assert.deepEqual([...PI_APPROVAL_COLUMNS], ['approved_by', 'approved_at', 'order_id'])
  })

  test('the detail read includes every one of them', () => {
    const view = readFileSync('src/lib/orders/draftsView.ts', 'utf8')
    assert.ok(view.includes('...PI_APPROVAL_COLUMNS'))
    assert.ok(view.includes('...PI_FINANCE_COLUMNS'))
    assert.ok(view.includes("'deletion_claim_token',"),
      'and the reservation, so a record being erased offers no decision')
    assert.ok(!code(view).includes("select('*')"),
      'in code; the comment above the list says so in words')
  })
})
