/**
 * THE DUPLICATE APPROVAL IS GONE, AND THE RULE THAT WAS MEANT IS ENFORCED.
 *
 * A PI used to need two sign-offs for one question — has Finance looked at the
 * money? A document-level verification (verify_pi_finance_check, stamped into
 * finance_verified_*) AND Finance's decision on each individual payment. Only
 * the second is derived from money that actually arrived, so the first is the
 * one that goes.
 *
 * Removing it uncovered a real hole, and this file pins both halves:
 *
 *   THE REMOVAL      no surface asks for a PI-level finance verification, and
 *                    neither approval door refuses without one.
 *   THE REPLACEMENT  no PI may become an Order while ANY payment attached to it
 *                    is awaiting Finance's decision — a case the old payment
 *                    gate could not refuse, because it only complained about
 *                    unverified money when the PI was ALSO short of 40%.
 *
 * WHY SOME OF THIS IS READ AS TEXT. The database is the authority and re-derives
 * every rule under a row lock, but asserting that in CI would need a live
 * Postgres and would WRITE to it. These assertions read the migration as text,
 * so review and CI check the same properties without a database and without
 * touching a shared fixture.
 *
 *   npx tsx --test src/lib/orders/piFinanceVerificationRemoval.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  describeApprovalReadiness,
  describeReviewDecision,
  APPROVAL_BLOCKED_PAYMENT_AWAITING,
  APPROVAL_BLOCKED_PAYMENT_UNKNOWN,
  APPROVAL_BLOCKED_DELETION,
  type ApprovalReadinessInput,
} from './finalApproval'
import { PAYMENT_AWAITING_VERIFICATION } from './paymentGate'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const MIGRATION_FILE = '20261226000000_order_submission_finance_verification_no_longer_required.sql'

// Line endings are normalised at the door: this repository checks out CRLF on
// Windows and LF elsewhere, and an assertion that matched one and not the other
// would pass or fail by machine rather than by content.
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const SQL = lf(readFileSync(join(MIGRATIONS, MIGRATION_FILE), 'utf8'))

/**
 * The migration with every `--` comment line removed.
 *
 * WHY THE DISTINCTION MATTERS. This migration EXPLAINS itself at length, and
 * its explanation necessarily names the things it is leaving alone —
 * verify_pi_finance_check, the finance_verified_* columns, can_verify_pi_finance.
 * An assertion that those names are absent from the FILE would fail on the
 * prose that promises not to touch them, which is the opposite of the property
 * being checked. Every "this migration does not touch X" assertion below reads
 * the code.
 */
const SQL_CODE = SQL
  .split('\n')
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n')

/** The body of one function in the migration, from its header to its `$$;`. */
function body(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is re-emitted by this migration`)
  const end = SQL.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} is dollar-quoted and terminated`)
  return SQL.slice(start, end)
}

/**
 * A PI whose every other condition is satisfied.
 *
 * Every test below changes ONE field, so a failure names the rule that broke
 * rather than the fixture that drifted.
 */
const READY: ApprovalReadinessInput = {
  status: 'submitted',
  paymentPosition: 'standard_met',
  neededForStandard: null,
  awaitingVerificationAmount: 0,
  hasBlockingIssues: false,
  productCount: 1,
  incompleteSummary: null,
  deletionClaimed: false,
}

// ── 1. A confirmed payment does not trigger a finance blocker ────────────────

describe('a PI whose payment is confirmed is not held up by anything about finance', () => {
  test('₹7,50,000 confirmed and ₹0 awaiting approves, with no blocker at all', () => {
    // The exact shape of the case in the report: the money is in, verified, and
    // nothing is pending. There is no second signature to collect.
    const outcome = describeApprovalReadiness({ ...READY, awaitingVerificationAmount: 0 })

    assert.equal(outcome.ready, true)
    assert.equal(outcome.blocker, null,
      'a fully verified PI shows no finance blocker, and no blocker of any kind')
  })

  test('a zero expressed as the database would send it is still zero', () => {
    // pi_submission_payment_summary() returns numeric, which arrives over
    // PostgREST as a STRING. '0', '0.00' and 0 are the same amount of money and
    // none of them is a payment awaiting anybody.
    for (const zero of [0, '0', '0.00', '  0  ']) {
      const outcome = describeApprovalReadiness({ ...READY, awaitingVerificationAmount: zero })
      assert.equal(outcome.ready, true, `${JSON.stringify(zero)} is not money in flight`)
    }
  })

  test('an unreadable figure raises no blocker of its own', () => {
    // FAILS OPEN, deliberately, and it is the one place in this rule that does.
    // The amount only ever RAISES a blocker, so a value the page could not read
    // must not invent one — the database asks the same question under a row
    // lock and refuses on its own answer.
    for (const unreadable of [null, undefined, '', 'not-a-number']) {
      const outcome = describeApprovalReadiness({
        ...READY,
        awaitingVerificationAmount: unreadable as string | number | null,
      })
      assert.equal(outcome.ready, true)
      assert.equal(outcome.blocker, null)
    }
  })
})

// ── 2 & 3. Awaiting blocks; confirming it unblocks ───────────────────────────

describe('a payment still with Finance blocks the Order, and clearing it releases', () => {
  test('an awaiting payment blocks approval even though the 40% is met', () => {
    // THE HOLE THIS CLOSES. 'standard_met' is resolved BEFORE unverified money
    // is considered, so this PI reported a satisfied payment gate while a
    // second payment sat undecided.
    const outcome = describeApprovalReadiness({
      ...READY,
      paymentPosition: 'standard_met',
      awaitingVerificationAmount: '50000',
    })

    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_PAYMENT_AWAITING)
  })

  test('it blocks under an approved exception too, where the route is also clear', () => {
    const outcome = describeApprovalReadiness({
      ...READY,
      paymentPosition: 'exception_approved',
      awaitingVerificationAmount: '1',
    })

    assert.equal(outcome.ready, false)
    assert.equal(outcome.blocker, APPROVAL_BLOCKED_PAYMENT_AWAITING)
  })

  test('verifying that payment removes the blocker and nothing else is asked for', () => {
    // The whole journey, in one test: the same PI before and after Finance
    // decides. No other field moves, so the only thing that released the
    // control is the payment being verified.
    const pending = describeApprovalReadiness({ ...READY, awaitingVerificationAmount: '50000' })
    const verified = describeApprovalReadiness({ ...READY, awaitingVerificationAmount: '0' })

    assert.equal(pending.ready, false)
    assert.equal(pending.blocker, APPROVAL_BLOCKED_PAYMENT_AWAITING)
    assert.equal(verified.ready, true)
    assert.equal(verified.blocker, null,
      'no separate finance confirmation stands between the verified payment and approval')
  })

  test('the sentence names the awaiting payment, and only when one exists', () => {
    // The requirement in the report: the screen explains that an awaiting
    // payment must be approved, BUT ONLY WHEN SUCH A PAYMENT ACTUALLY EXISTS.
    assert.match(APPROVAL_BLOCKED_PAYMENT_AWAITING, /awaiting Finance verification/)
    assert.equal(describeApprovalReadiness({ ...READY, awaitingVerificationAmount: 0 }).blocker, null)
  })

  test('the primary control stays shut rather than offering the PI-only door', () => {
    // 'standard_met' is not a PAYMENT_ONLY position, so a PI held up solely by
    // money in flight reports 'blocked' and carries the sentence. The rule is
    // that Approve PI & Create Order stays shut until nothing is awaiting.
    const decision = describeReviewDecision({
      readiness: { ...READY, awaitingVerificationAmount: '50000' },
      piApproved: false,
      canApprove: true,
    })

    assert.equal(decision.mode, 'blocked')
    assert.equal(decision.rpc, null, 'no RPC is offered while a payment is undecided')
    assert.equal(decision.note, APPROVAL_BLOCKED_PAYMENT_AWAITING)
  })
})

// ── 4. No separate PI-level finance approval is required ─────────────────────

describe('nothing asks for a PI-level finance verification any more', () => {
  test('the readiness rule has no finance input and no finance blocker', () => {
    // Structural, not behavioural: a caller CANNOT pass a finance verification
    // in, so no surface can accidentally start requiring one again.
    assert.equal('financeVerified' in READY, false)

    const source = lf(readFileSync(join(ROOT, 'src', 'lib', 'orders', 'finalApproval.ts'), 'utf8'))
    assert.equal(source.includes('APPROVAL_BLOCKED_FINANCE'), false,
      'the "Finance must verify this PI" blocker no longer exists')

    // THE TWO RULES, read as source. Scoped to the functions that DECIDE rather
    // than to the whole module: describeFinanceStatus and financeVerifiedLine
    // still exist here, unreferenced by the PI review screen and rendered by
    // nothing. They are dead, not dangerous — and an assertion that the module
    // never says "financeVerified" anywhere would be a claim about tidiness
    // rather than about the rule.
    for (const fn of ['describeApprovalReadiness', 'describeReviewDecision']) {
      const start = source.indexOf(`export function ${fn}(`)
      assert.notEqual(start, -1, `${fn} is defined`)
      const end = source.indexOf('\n}\n', start)
      const rule = source.slice(start, end)
      assert.equal(/financeVerified|financeVerification/.test(rule), false,
        `${fn} consults no finance verification`)
    }
  })

  test('an unverified PI — in the old sense — approves', () => {
    // There is no longer any way to express "finance has not signed this off",
    // which is the point. What remains is the money, and the money is fine.
    const outcome = describeApprovalReadiness(READY)
    assert.equal(outcome.ready, true)
  })

  test('neither approval door refuses for a missing finance verification', () => {
    for (const fn of ['approve_pi_review', 'approve_order_submission']) {
      const sql = body(fn)
      assert.equal(sql.includes('ORDER_SUBMISSION_FINANCE_NOT_VERIFIED'), false,
        `${fn} no longer raises the finance-verification refusal`)
      assert.equal(sql.includes('order_submission_finance_verified('), false,
        `${fn} no longer calls the finance-verification predicate`)
    }
  })

  test('the PI review screen renders no finance status and no Verify Finance control', () => {
    const screens = [
      join(ROOT, 'src', 'app', 'orders', 'drafts', '[submissionId]', 'page.tsx'),
      join(ROOT, 'src', 'app', 'orders', 'drafts', '[submissionId]', 'piDetailSections.tsx'),
    ]
    for (const file of screens) {
      const source = lf(readFileSync(file, 'utf8'))
      for (const gone of [
        'VERIFY_FINANCE_BUTTON_LABEL',
        'FINANCE_PENDING_TEXT',
        'describeFinanceStatus',
        'PiFinanceLine',
        'onVerifyFinance',
      ]) {
        assert.equal(source.includes(gone), false, `${gone} is gone from ${file}`)
      }
    }
  })
})

// ── 5. Only confirmed payments count as received ─────────────────────────────

describe('only money Finance has approved counts', () => {
  test('the gate reads the verified sum, and the verified sum counts only approved payments', () => {
    // The definition is 20260921000000's and this migration does not touch it.
    // Pinned here because "only confirmed payments count" is the rule the whole
    // correction rests on: if unverified money ever counted toward the 40%, the
    // removal of the document-level check would remove a real control.
    const sql = body('approve_order_submission')
    assert.ok(sql.includes('public.order_submission_verified_payment(p_submission_id)'),
      'the requirement is measured against VERIFIED money')
    assert.ok(sql.includes('v_verified >= v_required'),
      'and the route opens only when verified money meets the requirement')

    const source = lf(readFileSync(
      join(MIGRATIONS, '20260921000000_order_submission_verified_payment_gate.sql'), 'utf8'))
    assert.ok(source.includes('public.finance_payment_status_is_verified(f.status)'),
      'verified money is exactly the approved payments')
  })

  test('awaiting money is counted separately and toward nothing', () => {
    const sql = body('approve_order_submission')
    assert.ok(sql.includes('public.order_submission_unverified_payment(p_submission_id)'))
    // It is never added to the verified figure, anywhere.
    assert.equal(/v_verified\s*:?=.*v_unverified/.test(sql), false,
      'unverified money is never folded into the verified total')
  })
})

// ── 6. Payment-verification permissions are unchanged ────────────────────────

describe('who may verify a payment, and who may approve, is untouched', () => {
  test('the migration changes no permission, role or capability', () => {
    for (const untouched of [
      'can_verify_pi_finance',
      'actor_has_module_permission',
      'finance.approve',
      'create policy',
      'alter policy',
      'drop policy',
    ]) {
      assert.equal(SQL_CODE.includes(untouched), false,
        `${untouched} is not redefined by this migration`)
    }
  })

  test('authorization inside the doors is still the same single check', () => {
    for (const fn of ['approve_pi_review', 'approve_order_submission']) {
      assert.ok(body(fn).includes('public.actor_can_approve_order()'),
        `${fn} still authorizes on orders.approve_order and nothing else`)
    }
  })

  test('no role is hard-coded: the doors ask a permission, never a job title', () => {
    // The rule is permission-based. A literal 'admin'/'manager'/'finance' role
    // comparison in an approval door would be the thing the report forbids.
    for (const fn of ['approve_pi_review', 'approve_order_submission']) {
      const sql = body(fn)
      assert.equal(/role\s*=\s*'(admin|manager|finance)'/i.test(sql), false,
        `${fn} hard-codes no role`)
    }
  })

  test('both signatures, security modes, search_path and grants are as they were', () => {
    // SIGNATURES AND RETURN TYPES.
    assert.ok(SQL.includes('create or replace function public.approve_pi_review(p_submission_id uuid)'))
    assert.ok(SQL.includes([
      'create or replace function public.approve_order_submission(',
      '  p_submission_id uuid,',
      '  p_assigned_to   uuid,',
      '  p_confirm_date  date,',
      '  p_due_date      date,',
      '  p_lead_source   text',
      ')',
    ].join('\n')))
    assert.equal((SQL.match(/^returns jsonb$/gm) ?? []).length, 2)

    // SECURITY MODE AND SEARCH PATH, once per function.
    assert.equal((SQL.match(/^security definer$/gm) ?? []).length, 2)
    assert.equal((SQL.match(/^set search_path = public, pg_temp$/gm) ?? []).length, 2)

    // GRANTS, exactly the pair each function already held.
    for (const sig of [
      'public.approve_pi_review(uuid)',
      'public.approve_order_submission(uuid, uuid, date, date, text)',
    ]) {
      assert.ok(SQL.includes(`revoke execute on function ${sig} from public, anon;`))
      assert.ok(SQL.includes(`grant  execute on function ${sig} to authenticated;`))
    }
    // AND NOTHING WIDER. service_role is never granted, public never re-granted.
    assert.equal(/grant\s+execute[^;]*to[^;]*\b(public|anon)\b/.test(SQL), false)
  })
})

// ── 7. The direct RPC path cannot be walked past ─────────────────────────────

describe('the database refuses a pending payment on its own', () => {
  test('approve_order_submission raises unconditionally on unverified money', () => {
    const sql = body('approve_order_submission')

    // The new check, and the fact that it is NOT inside the route-is-null arm
    // the old one lived in. `v_route` is resolved before it; the check runs
    // whatever the route says.
    const check = sql.indexOf('if v_unverified > 0 then')
    const routeResolved = sql.indexOf('if v_route is null then')
    assert.notEqual(check, -1, 'the gate exists')
    assert.ok(check > routeResolved,
      'it runs after the route is resolved, so a satisfied route does not skip it')

    // Two-space indentation: it sits at the function body's top level, not
    // nested inside another `if`. A nested copy would be reachable only on some
    // paths, which is exactly the defect being fixed.
    assert.ok(sql.includes('\n  if v_unverified > 0 then\n'),
      'the check is at the top level of the body, not inside a branch')
  })

  test('it refuses under a row lock, on the database’s own numbers', () => {
    const sql = body('approve_order_submission')
    const lock = sql.indexOf('for update')
    const measured = sql.indexOf('v_unverified := public.order_submission_unverified_payment')
    const check = sql.indexOf('if v_unverified > 0 then')

    assert.ok(lock < measured && measured < check,
      'the row is locked, then the money is measured, then the refusal is decided')
    assert.ok(sql.includes('ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION'))
  })

  test('the screen and the door agree, so the sentence is the refusal', () => {
    // The browser blocks for the same reason and names the same thing. A
    // PostgREST caller that skips the browser meets the same rule.
    assert.match(APPROVAL_BLOCKED_PAYMENT_AWAITING, /awaiting Finance verification/)
    assert.match(PAYMENT_AWAITING_VERIFICATION, /awaiting Finance verification/)
    assert.ok(body('approve_order_submission').includes('awaiting Finance verification'))
  })

  test('the other refusals the door already made are all still made', () => {
    // The removal took out ONE check. Everything else approve_order_submission
    // refused for, it still refuses for.
    const sql = body('approve_order_submission')
    for (const refusal of [
      'ORDER_SUBMISSION_DELETION_CLAIMED',
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW',
      'ORDER_SUBMISSION_ALREADY_LINKED',
      'ORDER_CONFIRMATION_SALESPERSON_REQUIRED',
      'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED',
      'ORDER_CONFIRMATION_DUE_DATE_REQUIRED',
      'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED',
      'ORDER_SUBMISSION_EXCEPTION_PENDING',
      'ORDER_SUBMISSION_EXCEPTION_REJECTED',
      'ORDER_SUBMISSION_EXCEPTION_STALE',
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT',
      'ORDER_SUBMISSION_BLOCKED',
      'ORDER_SUBMISSION_INCOMPLETE',
    ]) {
      assert.ok(sql.includes(refusal), `${refusal} still refuses`)
    }
  })

  test('and the browser still refuses everything it refused before', () => {
    assert.equal(
      describeApprovalReadiness({ ...READY, deletionClaimed: true }).blocker,
      APPROVAL_BLOCKED_DELETION)
    assert.equal(
      describeApprovalReadiness({ ...READY, paymentPosition: null }).blocker,
      APPROVAL_BLOCKED_PAYMENT_UNKNOWN)
    assert.equal(
      describeApprovalReadiness({ ...READY, hasBlockingIssues: true }).ready, false)
    assert.equal(
      describeApprovalReadiness({ ...READY, productCount: 0 }).ready, false)
    assert.equal(
      describeApprovalReadiness({ ...READY, status: 'draft' }).ready, false)
  })
})

// ── 8. Historical finance-verification data is not altered ───────────────────

describe('every finance verification ever recorded is left exactly as it is', () => {
  test('the migration writes no row and drops no structure', () => {
    for (const forbidden of [
      'drop function',
      'drop column',
      'drop table',
      'alter table',
      'delete from',
      'truncate',
      'update public.order_submissions set finance_verified',
    ]) {
      assert.equal(SQL_CODE.toLowerCase().includes(forbidden), false,
        `the migration contains no ${forbidden}`)
    }
  })

  test('it contains nothing but the two functions and their grants', () => {
    // Every top-level statement, counted. Anything else appearing here would be
    // scope this correction did not ask for.
    const statements = SQL
      .split('\n')
      .filter(line => /^(create or replace function|grant |revoke |comment on|alter |drop |insert |update |delete )/.test(line))
    assert.equal(statements.filter(s => s.startsWith('create or replace function')).length, 2)
    assert.equal(statements.filter(s => s.startsWith('grant ')).length, 2)
    assert.equal(statements.filter(s => s.startsWith('revoke ')).length, 2)
    assert.equal(statements.length, 6, 'six statements, and nothing else')
  })

  test('the columns and the reader that reaches them still exist untouched', () => {
    // NOT DROPPED THOUGH UNUSED. The verifications are evidence of what people
    // did; the requirement is what was removed, not the record.
    assert.equal(SQL_CODE.includes('finance_verified_by'), false)
    assert.equal(SQL_CODE.includes('finance_verified_at'), false)
    assert.equal(SQL_CODE.includes('finance_verified_submission_at'), false)
    assert.equal(SQL_CODE.includes('drop function public.order_submission_finance_verified'), false)
    assert.equal(SQL_CODE.includes('drop function public.verify_pi_finance_check'), false)
  })

  test('verify_pi_finance_check is left runnable, and its grants are not disturbed', () => {
    assert.equal(SQL_CODE.includes('verify_pi_finance_check'), false,
      'the migration does not redefine, revoke or drop it')
  })

  test('no applied migration was edited to achieve any of this', () => {
    // The correction is a NEW file. Rewriting 20261224000000 in place would
    // change a migration production has already run.
    const applied = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const at = applied.indexOf(MIGRATION_FILE)
    assert.ok(at >= 0, 'the migration is on disk')

    // WHAT THIS GUARD IS ACTUALLY FOR: this migration must apply AFTER
    // everything that was already applied when it was written. It used to say
    // so by requiring that it sorted LAST, which was true then and stopped
    // being true the moment a later feature added a file. The purpose did not
    // change; only the wording had to.
    //
    // So everything sorting after it is NAMED instead, which still refuses a
    // migration slipping in between this one and the state it was written
    // against — and still refuses this one being renumbered.
    assert.deepEqual(applied.slice(at), [
      MIGRATION_FILE,
      // The Confirmed Order's fabric and finish approvals. One new table, one
      // new private bucket, one write RPC. It neither re-emits
      // approve_order_submission nor reads a finance verification, so nothing
      // this file asserts is reachable from it.
      '20261227000000_order_fabric_finish_approvals.sql',
      '20261228000000_personal_module_order.sql',
      // The PI-to-operations handoff: two new tables, one trigger on
      // order_pi_versions and two RPCs. It re-emits no existing function,
      // alters no existing table, writes no row and drops nothing, so it
      // reaches nothing here.
      '20261229000000_order_operations_handoff.sql',
      // Order 0524's one-time handoff: one DO block writing one handoff, one
      // history row and one notification for ONE pinned Order. No DDL, and it
      // re-emits nothing, so it reaches nothing here.
      '20261230000000_order_0524_operations_handoff_for_existing_approval.sql',
      '20261231000000_order_document_submissions.sql',
      '20270101000000_order_submission_revised_pi_promotes_on_operations_acceptance.sql',
      '20270102000000_order_submission_numbering_at_conversion_and_exception_reasons.sql',
      '20270103000000_order_submission_pi_edit_revisions.sql',
      '20270104000000_order_pi_revision_in_force_at_admin_approval.sql',
      // Announcements (20270110000000): three new tables, their functions, a
      // private PDF bucket and its storage policies. Purely additive; it reads
      // public.users and touches nothing this suite is about.
      '20270110000000_announcements.sql',
    ])

    const previous = lf(readFileSync(
      join(MIGRATIONS, '20261224000000_order_submission_approval_permanent_grant_and_auto_approval.sql'),
      'utf8'))
    assert.ok(previous.includes('ORDER_SUBMISSION_FINANCE_NOT_VERIFIED'),
      'the migration that introduced the gate still reads as it did when it ran')
  })
})
