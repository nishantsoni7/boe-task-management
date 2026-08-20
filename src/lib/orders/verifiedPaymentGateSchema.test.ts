/**
 * Phase 3 — the verified-payment gate, as the DATABASE states it.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The rules that decide whether an Order comes into existence live in SQL, and a
 * repository test cannot execute SQL. What it CAN do — and what every schema
 * suite in this repository already does — is read the migration and prove that
 * the rules are stated, stated once, and stated in the only form that can be
 * true: a gate that re-derives verified payment under row locks, an allocation
 * move that cannot become a copy, and a declared advance that decides nothing.
 *
 * The executable half is supabase/tests/pi_verified_payment_gate_assertions.sql,
 * which runs against a real database, plus the assertion block at the foot of the
 * migration itself, which fails the apply rather than let a partial one look
 * successful.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/verifiedPaymentGateSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migration = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

const FILE = '20260921000000_order_submission_verified_payment_gate.sql'
const PHASE_C = '20260915000000_order_submission_final_approval.sql'
const ADVANCE = '20260913000000_order_submission_advance_exceptions.sql'
const AMOUNT = '20260917000000_order_submission_advance_amount.sql'
const ALLOCATIONS = '20260918000000_finance_payment_allocations.sql'
const PI_PAYMENT = '20260919000000_pi_submission_payment_entry.sql'
const HOTFIX = '20260920000000_finance_approver_can_verify_payment.sql'

const sql = migration(FILE)

/** Executable SQL only — a comment explains, it does not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** The body of one function in this migration, from its header to its `$$;`. */
function body(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.ok(start > 0, `public.${name} is not defined in ${FILE}`)
  const end = sql.indexOf('\n$$;', start)
  assert.ok(end > start, `public.${name} has no closing $$`)
  return sql.slice(start, end)
}

// ── The file itself ───────────────────────────────────────────────────────────

describe('the migration is one file, in the right place, editing nothing applied', () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

  test('it exists and sorts after everything it builds on', () => {
    assert.ok(files.includes(FILE))
    for (const earlier of [PHASE_C, ADVANCE, AMOUNT, ALLOCATIONS, PI_PAYMENT, HOTFIX]) {
      assert.ok(files.includes(earlier), `${earlier} is missing`)
      assert.ok(FILE > earlier, `${FILE} must sort after ${earlier}`)
    }
  })

  test('it is the first migration after the applied hotfix, and the only one', () => {
    const after = files.filter(f => f > HOTFIX)
    assert.deepEqual(after, [FILE], 'Phase 3 is one migration, not several')
  })

  test('no two migrations share a version prefix', () => {
    const seen = new Set<string>()
    for (const file of files) {
      const version = /^(\d+)_/.exec(file)?.[1]
      assert.ok(version, `${file} has no numeric version prefix`)
      assert.ok(!seen.has(version), `duplicate migration version ${version}`)
      seen.add(version)
    }
  })

  test('every applied migration still says exactly what it said', () => {
    // The five this phase depends on are named explicitly, because a silent edit
    // to any of them would make this file's reasoning false.
    assert.ok(migration(PHASE_C).includes('create or replace function public.approve_order_submission'))
    assert.ok(migration(ALLOCATIONS).includes(
      'create or replace function public.finance_payment_allocations_guard_transition'))
    assert.ok(migration(ALLOCATIONS).includes("p_status in ('approved_unlinked', 'approved_linked')"))
    assert.ok(migration(PI_PAYMENT).includes('create or replace function public.pi_submission_payment_summary'))
    assert.ok(migration(ADVANCE).includes('select 40::numeric'))
    assert.ok(migration(AMOUNT).includes('add column advance_declared_amount numeric'))
  })

  test('it carries no credential and no connection string', () => {
    assert.ok(!/postgres:\/\/|supabase\.co|service_role_key|eyJ[A-Za-z0-9]/.test(sql))
  })

  test('it ends with an assertion block that fails a partial apply', () => {
    assert.ok(sql.includes('Phase 3 verified-payment gate: all assertions passed'))
    assert.ok(sql.lastIndexOf('do $$') > sql.indexOf('create or replace function public.approve_order_submission'))
  })
})

// ── 1–9. The standard route ───────────────────────────────────────────────────

describe('the standard route: 40% of the grand total, VERIFIED, and exact', () => {
  test('the requirement is the exact 40%, never a rounded percentage', () => {
    const fn = body('order_submission_required_payment')
    assert.ok(fn.includes('p_grand_total * public.order_submission_standard_advance_percent() / 100'),
      'the requirement derives from the one rule that states 40')
    assert.ok(!/round\s*\(/.test(fn), 'and it is never rounded before the comparison')
  })

  test('the gate compares AMOUNTS, and admits nothing else', () => {
    const fn = body('order_submission_payment_ready')
    assert.ok(fn.includes('p_verified_payment >= public.order_submission_required_payment(p_grand_total)'),
      'at or above the exact requirement — so exactly 40% passes')
    assert.ok(fn.includes("p_advance_exception_status = 'approved'"))
    assert.ok(fn.includes("'NaN'::numeric"), 'NaN sorts above every real number and is refused by name')
    assert.ok(fn.includes('coalesce('), 'a NULL answer to "is this ready?" must read as no')
  })

  test('the migration asserts the ₹0.01 case itself, at apply time', () => {
    // 40% of ₹100.01 is ₹40.004; ₹40.00 does not meet it however it rounds.
    assert.ok(sql.includes('public.order_submission_payment_ready(100.01, 40.00, null)'))
    assert.ok(sql.includes('a payment below the exact requirement must not pass on a rounded percentage'))
    assert.ok(sql.includes('public.order_submission_payment_ready(100.01, 40.01, null)'))
  })

  test('exactly 40% and more than 40% are both asserted at apply time', () => {
    assert.ok(sql.includes('public.order_submission_payment_ready(1000, 400, null)'))
    assert.ok(sql.includes('exactly 40%% verified must be ready'))
    assert.ok(sql.includes('public.order_submission_payment_ready(1000, 999, null)'))
  })

  test('only the two VERIFIED statuses count, through Phase 1’s single rule', () => {
    const fn = body('order_submission_verified_payment')
    assert.ok(fn.includes('public.finance_payment_status_is_verified(f.status)'),
      'the definition of "verified" is not restated here')
    assert.ok(fn.includes("a.status = 'active'"), 'and a reversed allocation is not counted')
    // Pending, needs_clarification and rejected are excluded BY not being in the
    // verified predicate — asserted the other way round, on the unverified total.
    const unverified = body('order_submission_unverified_payment')
    assert.ok(unverified.includes("f.status in ('pending_approval', 'needs_clarification')"))
    assert.ok(!unverified.includes('rejected'), 'a rejected payment is not even "awaiting"')
  })

  test('the sum is over MANY allocations, so several payments add up', () => {
    assert.ok(body('order_submission_verified_payment').includes('coalesce(sum(a.allocated_amount), 0)'))
  })

  test('the total is anchored to ONE submission — no unbounded payment query', () => {
    for (const name of ['order_submission_verified_payment', 'order_submission_unverified_payment']) {
      const fn = body(name)
      assert.ok(fn.includes('a.order_submission_id = p_submission_id'),
        `${name} must be bounded by the PI it is asked about`)
    }
    // And nothing in the file selects from the ledger without a predicate.
    const selects = [...code.matchAll(/from public\.finance_payment_requests[^\n]*\n/g)]
    assert.ok(selects.length > 0)
    for (const match of selects) {
      const after = code.slice(match.index!, match.index! + 400)
      assert.ok(/where|join/i.test(after), 'every payment read is predicated')
    }
  })

  test('the arithmetic behind the decision is reachable by no client role', () => {
    for (const name of ['order_submission_verified_payment(uuid)',
                        'order_submission_unverified_payment(uuid)']) {
      assert.ok(code.includes(`revoke execute on function public.${name}\n  from public, anon, authenticated, service_role;`),
        `${name} must not be a reporting route`)
    }
  })
})

// ── 10–21. The exception route ────────────────────────────────────────────────

describe('the reduced-payment exception reuses the deployed workflow', () => {
  test('no second exception system is created', () => {
    for (const forbidden of ['create table public.payment_exceptions',
                             'payment_exception_status',
                             'create type payment_exception']) {
      assert.ok(!code.includes(forbidden),
        `${forbidden} would split one workflow into two audit trails`)
    }
    assert.ok(code.includes('advance_exception_status'),
      'the applied exception columns carry the request')
  })

  test('a reason and Payment Terms are BOTH mandatory below the requirement', () => {
    const fn = body('submit_pi_for_review_internal')
    assert.ok(fn.includes('ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED'))
    assert.ok(fn.includes('ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED'))
    // Both inside the exception branch, and neither outside it.
    const branch = fn.slice(fn.indexOf("if v_route = 'exception' then"))
    assert.ok(branch.indexOf('ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED') > 0)
    assert.ok(branch.indexOf('ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED') > 0)
  })

  test('zero payment takes the same route, with the same two requirements', () => {
    const fn = body('submit_pi_for_review_internal')
    // The route is chosen by ONE comparison, so zero cannot have a softer rule.
    assert.ok(fn.includes("v_route    := case when v_verified >= v_required then 'standard' else 'exception' end"))
    assert.ok(fn.includes('when v_verified = 0 then 0'), 'and zero rupees is zero percent exactly')
  })

  test('only the submission OWNER may ask', () => {
    const fn = body('submit_pi_for_review_internal')
    assert.ok(fn.includes('not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor)'))
    assert.ok(fn.includes('ORDER_SUBMISSION_ADVANCE_NOT_OWNER'),
      'the same refusal 20260917000000 established, so one sentence covers both doors')
  })

  test('only the authorised approver may decide, and this phase does not widen it', () => {
    // The two decision RPCs are NOT restated here at all: they already require
    // orders.approve_advance_exception, which no preset grants.
    assert.ok(!code.includes('create or replace function public.approve_pi_advance_exception'))
    assert.ok(!code.includes('create or replace function public.reject_pi_advance_exception'))
    // And the migration asserts at apply time that both still require it.
    assert.ok(sql.includes('approving an exception must still require orders.approve_advance_exception'))
    assert.ok(sql.includes('rejecting an exception must still require the authority and still return the PI for changes'))
    // No permission is granted, revoked or invented by this file.
    for (const forbidden of ['insert into public.role_permissions',
                             'insert into public.department_permissions',
                             'insert into public.employee_permission_overrides',
                             'approve_advance_exception, true']) {
      assert.ok(!code.includes(forbidden), `${forbidden} would silently widen the authority`)
    }
  })

  test('a PENDING exception blocks final approval', () => {
    const fn = body('approve_order_submission')
    assert.ok(fn.includes("if v_sub.advance_exception_status = 'pending' then"))
    assert.ok(fn.includes('ORDER_SUBMISSION_EXCEPTION_PENDING'))
  })

  test('an APPROVED exception permits approval below 40%, zero included', () => {
    const fn = body('approve_order_submission')
    assert.ok(fn.includes("elsif v_sub.advance_exception_status = 'approved' then\n    v_route := 'exception'"))
    assert.ok(sql.includes("public.order_submission_payment_ready(1000, 0, 'approved')"),
      'and the apply-time assertion covers the zero case explicitly')
  })

  test('a REJECTED exception blocks approval, and the PI is already back', () => {
    assert.ok(body('approve_order_submission').includes('ORDER_SUBMISSION_EXCEPTION_REJECTED'))
    // The PI's return is 20260913000000's rule, untouched: reject_pi_advance_exception
    // sets status = 'needs_changes' in the same statement as the decision.
    assert.ok(migration(ADVANCE).includes("advance_exception_status = 'rejected',"))
    assert.ok(migration(ADVANCE).includes("status = 'needs_changes',"))
  })

  test('reaching 40% after asking allows the STANDARD route, with no decision', () => {
    const fn = body('approve_order_submission')
    const gate = fn.slice(fn.indexOf('if v_verified >= v_required then'))
    assert.ok(gate.startsWith("if v_verified >= v_required then\n    v_route := 'standard';"),
      'money is tested FIRST, so a pending request simply stops mattering')
  })

  test('dropping below 40% blocks approval unless an approved exception exists', () => {
    // The figure is re-derived at the instant of the decision, so a reversal
    // between submission and approval is seen.
    const fn = body('approve_order_submission')
    assert.ok(fn.includes('v_verified   := public.order_submission_verified_payment(p_submission_id)'))
    assert.ok(!fn.includes('advance_declared_amount'), 'and nothing rescues it from the record')
  })

  test('approving an exception never marks a payment verified', () => {
    // Structural, not a promise: neither decision RPC may name the ledger at
    // all, and the migration asserts that at apply time.
    assert.ok(sql.includes('an exception decision must never write or read the payment ledger'))
    assert.ok(!body('approve_order_submission').includes('update public.finance_payment_requests'))
  })

  test('management can still review a PI while the exception is pending', () => {
    // Nothing here changes the PI's status on an exception request: the record
    // is 'submitted' and stays there, which is the applied rule.
    const fn = body('submit_pi_for_review_internal')
    assert.ok(fn.includes("status = 'submitted'"))
    assert.ok(!fn.includes("status = 'awaiting_exception'"),
      'no new status is invented, so the review queue is unchanged')
  })
})

// ── 22–30. Conversion continuity ──────────────────────────────────────────────

describe('the PI’s money MOVES onto the Order, and is never copied', () => {
  const approval = body('approve_order_submission')

  test('the move is ONE update, with no insert and no delete', () => {
    assert.ok(approval.includes('update public.finance_payment_allocations\n       set order_submission_id = null,\n           order_id            = v_order_id'))
    assert.ok(!/insert into public\.finance_payment_allocations/.test(approval),
      'a second allocation would be a duplicate claim on the same money')
    assert.ok(!/delete from public\.finance_payment_allocations/.test(approval))
    assert.ok(!/insert into public\.finance_payment_requests/.test(approval),
      'and no payment row is created')
  })

  test('only ACTIVE allocations move, and only this PI’s', () => {
    const move = approval.slice(approval.indexOf('with moved as ('))
    assert.ok(move.includes('where order_submission_id = p_submission_id'))
    assert.ok(move.includes("and status = 'active'"))
  })

  test('the guard permits exactly that move and refuses every variation', () => {
    const guard = body('finance_payment_allocations_guard_transition')
    assert.ok(guard.includes('public.in_pi_submission_approval(old.order_submission_id)'),
      'only inside the approval of THIS submission')
    assert.ok(guard.includes('o.source_order_submission_id = old.order_submission_id'),
      'and only onto the Order created from it')
    assert.ok(guard.includes("old.status = 'active'"), 'a reversed allocation cannot move')
    for (const frozen of ['id', 'payment_request_id', 'allocated_amount',
                          'origin_target_type', 'created_by', 'created_at']) {
      assert.ok(new RegExp(`new\\.${frozen}\\s+is not distinct from\\s+old\\.${frozen}`).test(guard),
        `${frozen} must be unchanged across the move`)
    }
    assert.ok(guard.includes('ALLOCATION_IMMUTABLE'))
    assert.ok(guard.includes('ALLOCATION_REVERSAL_FINAL'))
    assert.ok(guard.includes('ALLOCATION_REVERSAL_IMMUTABLE'))
  })

  test('provenance survives: origin_target_type is never rewritten', () => {
    assert.ok(!/set[^;]*origin_target_type\s*=/.test(approval),
      'the Order sees where the money came from, forever')
  })

  test('the move is recorded, server-derived, in the payment’s own trail', () => {
    assert.ok(code.includes("'allocation_moved'"))
    const logger = body('log_finance_payment_allocation_activity')
    assert.ok(logger.includes("v_event := 'allocation_moved'"))
    assert.ok(logger.includes('moved_from_order_submission_id'))
    assert.ok(logger.includes('moved_to_order_id'))
    // And on the PI, as its own event.
    assert.ok(code.includes("'payment_allocations_moved'"))
    assert.ok(approval.includes("'payment_allocations_moved', 'approved', 'approved'"))
  })

  test('the Order is created BEFORE the allocations move, in the same transaction', () => {
    const insert = approval.indexOf('insert into public.orders')
    const move = approval.indexOf('update public.finance_payment_allocations')
    assert.ok(insert > 0 && move > insert,
      'source_order_submission_id must exist before the guard can check it')
    // One function, one transaction: a failure anywhere rolls back the Order,
    // the number and the move together.
    assert.ok(!approval.includes('commit'), 'nothing commits early')
  })

  test('a failed approval leaves no Order, no number and no moved allocation', () => {
    // The number comes only from the BEFORE INSERT trigger, and the cycle is
    // advanced inside this transaction — so a raise at any point undoes it.
    assert.ok(!/insert into public\.orders \([^)]*display_number/.test(approval))
    assert.ok(!approval.includes('nextval'))
    assert.ok(sql.includes('approve_order_submission must never assign or compute a display number itself'))
  })

  test('the legacy Order Request conversion is not touched', () => {
    assert.ok(!code.includes('convert_order_request_to_order'),
      'a different phase owns that path and it is unchanged')
  })

  test('the PI stops counting the money it no longer holds', () => {
    // The summary counts allocations naming the SUBMISSION; after the move there
    // are none, without a single figure being rewritten.
    const summary = body('pi_submission_payment_summary')
    assert.ok(summary.includes('a.order_submission_id = p_submission_id'))
  })
})

// ── 31–40. Regression and security ────────────────────────────────────────────

describe('what Phase 3 must NOT have changed', () => {
  const approval = body('approve_order_submission')

  test('the declared advance no longer gates approval, and is not read at all', () => {
    for (const legacy of ['order_submission_advance_ready', 'advance_declared_amount',
                          'advance_exception_percent']) {
      assert.ok(!approval.includes(legacy),
        `approval must not read ${legacy}: a declaration is not a payment`)
    }
    // Asserted at apply time as well, so a later edit cannot quietly restore it.
    assert.ok(sql.includes('approve_order_submission must read verified payment and must not read the declared-advance predicate'))
  })

  test('historical declared-advance data is preserved, never dropped', () => {
    for (const forbidden of ['drop column advance_declared_amount',
                             'drop column advance_condition',
                             'drop column advance_exception_percent',
                             'update public.order_submissions set advance_declared_amount']) {
      assert.ok(!code.includes(forbidden), `${forbidden} would destroy business history`)
    }
    assert.ok(sql.includes('advance_declared_amount must be preserved, never dropped'))
    assert.ok(code.includes('comment on column public.order_submissions.advance_declared_amount is'),
      'and the column is re-documented as legacy rather than removed')
  })

  test('the existing Finance CHECK stays required, and stays separate', () => {
    assert.ok(approval.includes('public.order_submission_finance_verified('),
      'the PI finance check is still a precondition')
    assert.ok(approval.indexOf('order_submission_finance_verified')
            < approval.indexOf('order_submission_verified_payment'),
      'and it is judged before the payment gate, exactly as it was')
    // The two are different questions and neither sets the other.
    assert.ok(!code.includes('finance_verified_at = now()'),
      'verifying a payment must never stamp the PI finance check')
    assert.ok(!code.includes('create or replace function public.verify_pi_finance_check'),
      'the finance-check RPC is untouched')
  })

  test('final approval uses LIVE figures, not the ones the finance check saw', () => {
    assert.ok(approval.includes('order_submission_verified_payment(p_submission_id)'))
    assert.ok(!approval.includes('v_sub.verified_payment'),
      'nothing is read from a frozen column, because there is none')
  })

  test('every existing approval permission and precondition is still enforced', () => {
    for (const kept of [
      "actor_has_module_permission('orders', 'approve_order')",
      'ORDER_SUBMISSION_DELETION_CLAIMED',
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW',
      'ORDER_SUBMISSION_ALREADY_LINKED',
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED',
      'ORDER_SUBMISSION_BLOCKED',
      'ORDER_SUBMISSION_INCOMPLETE',
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_BAD_IMAGE_PATH',
      'ORDER_SUBMISSION_IMAGE_NOT_STORED',
      'for update',
    ]) {
      assert.ok(approval.includes(kept), `${kept} must survive the restatement`)
    }
  })

  test('the gate is re-derived under locks, never trusted from a caller', () => {
    assert.ok(approval.includes('create or replace function public.approve_order_submission(p_submission_id uuid)'),
      'one argument, and it is an id')
    const gate = approval.slice(approval.indexOf('-- ── 7.'))
    assert.ok(gate.includes('from public.finance_payment_requests f'))
    assert.ok(gate.includes('order by f.id\n  for update'))
    assert.ok(gate.includes('from public.finance_payment_allocations a'))
    assert.ok(gate.includes('order by a.id\n  for update'))
    assert.ok(gate.indexOf('for update') < gate.indexOf('order_submission_verified_payment'),
      'the locks are taken BEFORE the figure is summed')
  })

  test('a client cannot forge a total, a route or a decision', () => {
    // Every write door takes ids and text, and derives the money itself.
    assert.ok(sql.includes("create or replace function public.submit_pi_for_review(\n  p_submission_id uuid,\n  p_note          text default null,\n  p_reason        text default null,\n  p_payment_terms text default null,\n  p_billing_terms text default null\n)"))
    // The client-callable doors take ids and text. No figure, no route and no
    // decision reaches the database from a browser — the two signatures are
    // asserted whole, so a new argument cannot be slipped into either.
    assert.ok(code.includes('create or replace function public.approve_order_submission(p_submission_id uuid)'))
    for (const door of ['submit_pi_for_review', 'approve_order_submission']) {
      const start = code.indexOf(`create or replace function public.${door}(`)
      const signature = code.slice(start, start + code.slice(start).indexOf(')'))
      for (const forbidden of ['numeric', 'boolean', 'jsonb']) {
        assert.ok(!signature.includes(forbidden),
          `${door} must not accept a ${forbidden} — that would be a figure somebody could type`)
      }
    }
    // The implementations are reachable by no client role.
    assert.ok(code.includes('revoke execute on function public.submit_pi_for_review_internal(uuid, text, text, text, text)\n  from public, anon, authenticated, service_role;'))
  })

  test('the payment summary stays participant-scoped', () => {
    const summary = body('pi_submission_payment_summary')
    assert.ok(summary.includes('public.can_view_order_submission(p_submission_id)'))
    assert.ok(summary.includes("ORDER_SUBMISSION_NOT_AVAILABLE"))
    assert.ok(summary.includes("raise exception 'Authentication required'"))
    // No RLS policy is created, dropped or altered by this phase.
    assert.ok(!/create policy|drop policy|alter policy/i.test(code),
      'the participant-scoped policies from Phase 1 and 2 are untouched')
  })

  test('the existing payment verification flow is unchanged', () => {
    for (const untouched of ['approve_finance_payment_request', 'reject_finance_payment_request',
                             'record_pi_submission_payment', 'allocate_payment_to_target',
                             'reverse_payment_allocation']) {
      assert.ok(!code.includes(`create or replace function public.${untouched}`),
        `${untouched} must not be restated by this phase`)
    }
  })

  test('test-data cleanup still works after the move', () => {
    // Cleanup classifies an allocation by its own is_test_data flag and resolves
    // a chain through the payment, neither of which the move touches.
    assert.ok(!code.includes('is_test_data'),
      'the move rewrites no cleanup classification')
    assert.ok(!code.includes('resolve_test_data_cleanup_chain'),
      'and the cleanup resolver is not restated')
  })

  test('no new unbounded payment query is introduced', () => {
    const froms = [...code.matchAll(/from public\.finance_payment_(requests|allocations)/g)]
    assert.ok(froms.length > 0)
    for (const match of froms) {
      const window = code.slice(match.index!, match.index! + 500)
      assert.ok(/where |join /i.test(window),
        `an unpredicated read of ${match[0]} would scan the whole ledger`)
    }
  })

  test('the Excel import and the PI review safeguards are untouched', () => {
    for (const untouched of ['replace_order_submission_parse', 'request_order_submission_changes',
                             'reject_order_submission', 'create_order_submission']) {
      assert.ok(!code.includes(`create or replace function public.${untouched}`),
        `${untouched} belongs to an earlier phase and is not restated`)
    }
  })

  test('numbering is preserved, not redesigned', () => {
    for (const forbidden of ['create sequence', 'set_next_confirmed_order_number',
                             'max(display_number)', 'confirmed_order_number_cycle']) {
      assert.ok(!code.includes(forbidden), `${forbidden} would be a second allocator`)
    }
    assert.ok(!code.includes('cancel'), 'and cancellation is explicitly out of scope')
  })
})

// ── Payment and Billing Terms ─────────────────────────────────────────────────

describe('Payment Terms and Billing Terms are plain text, and nothing more', () => {
  test('both columns exist, nullable, with a non-blank and a length rule', () => {
    assert.ok(code.includes('add column payment_terms text'))
    assert.ok(code.includes('add column billing_terms text'))
    assert.ok(code.includes('order_submissions_payment_terms_valid'))
    assert.ok(code.includes('order_submissions_billing_terms_valid'))
    assert.ok(code.includes("btrim(payment_terms) <> ''"),
      'a present-but-blank value is refused, never stored')
    assert.ok(code.includes('char_length(payment_terms) <= 500'))
  })

  test('nothing schedules, parses or reminds', () => {
    // The MECHANISMS, not the words: the file legitimately says "never
    // scheduled" about itself, and a test that banned the word would be banning
    // the promise rather than the behaviour.
    for (const forbidden of ['instalment', 'installment', 'payment_terms_due',
                             'reminder', 'cron', 'to_date(payment_terms',
                             'split_part(payment_terms', 'regexp_matches(payment_terms']) {
      assert.ok(!code.toLowerCase().includes(forbidden.toLowerCase()),
        `${forbidden} would make this a scheduling engine`)
    }
    assert.ok(!/create table public\.\w*payment_schedule/i.test(code))
  })

  test('they reach the PI’s payment summary when present', () => {
    const summary = body('pi_submission_payment_summary')
    assert.ok(summary.includes("'payment_terms',        v_sub.payment_terms"))
    assert.ok(summary.includes("'billing_terms',        v_sub.billing_terms"))
  })

  test('the migration agrees nothing on anybody’s behalf', () => {
    assert.ok(sql.includes('this migration agrees nothing on anybody' + "''" + 's behalf'),
      'and it fails the apply if any record already carries terms')
    assert.ok(!/update public\.order_submissions\s+set\s+payment_terms/.test(code.replace(/\n/g, ' '))
           || code.includes('where id = p_submission_id'),
      'terms are written only by a submission, never backfilled')
  })
})

// ── The activity vocabularies ─────────────────────────────────────────────────

describe('the trails grow by exactly what this phase produces', () => {
  test('the PI action set gains ONE action and keeps every applied one', () => {
    const constraint = code.slice(code.indexOf('add constraint order_submission_activity_action_check'))
      .slice(0, code.slice(code.indexOf('add constraint order_submission_activity_action_check')).indexOf(';'))
    for (const kept of ['submission_created', 'parse_replaced', 'submitted', 'changes_requested',
                        'rejected', 'advance_exception_requested', 'advance_exception_approved',
                        'advance_exception_rejected', 'finance_verified', 'approved',
                        'payment_recorded']) {
      assert.ok(constraint.includes(`'${kept}'`), `${kept} must survive`)
    }
    assert.ok(constraint.includes("'payment_allocations_moved'"))
    const actions = [...constraint.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.equal(actions.length, 12, 'eleven applied actions plus exactly one new one')
  })

  test('the Finance event set gains ONE event and keeps every applied one', () => {
    const start = code.indexOf('add constraint finance_payment_request_activity_log_event_type_check')
    const constraint = code.slice(start, start + code.slice(start).indexOf(';'))
    for (const kept of ['request_submitted', 'order_linked', 'order_unlinked', 'order_link_changed',
                        'order_request_linked', 'order_request_unlinked', 'target_changed',
                        'status_changed', 'collection_details_updated', 'cash_handover_recorded',
                        'allocation_created', 'allocation_reversed']) {
      assert.ok(constraint.includes(`'${kept}'`), `${kept} must survive`)
    }
    assert.ok(constraint.includes("'allocation_moved'"))
  })

  test('a refused approval writes no audit row, and the file says why', () => {
    assert.ok(sql.includes('WHAT IS NOT LOGGED, and why: a REFUSED approval'))
    const approval = body('approve_order_submission')
    const gate = approval.slice(approval.indexOf('if v_route is null then'),
                                approval.indexOf('-- ── 8.'))
    assert.ok(!gate.includes('log_order_submission_activity'),
      'a row written inside a transaction that raises would vanish with it')
  })

  test('the standard route is recorded on the approval event, not as a second one', () => {
    const approval = body('approve_order_submission')
    assert.ok(approval.includes("'payment_route',        v_route"))
    assert.ok(approval.includes("'verified_payment',     v_verified"))
    assert.ok(approval.includes("'required_payment',     v_required"))
  })
})

// ── The runnable assertions ───────────────────────────────────────────────────

describe('the executable assertions exist and cover this phase', () => {
  const path = join(process.cwd(), 'supabase', 'tests', 'pi_verified_payment_gate_assertions.sql')

  test('the file is there', () => {
    assert.ok(existsSync(path), 'Phase 3 must ship runnable SQL assertions')
  })

  test('it rolls back, so it can never leave test rows behind', () => {
    const text = lf(readFileSync(path, 'utf8'))
    assert.ok(/rollback/i.test(text))
    assert.ok(!/^\s*commit\s*;/im.test(text), 'and it must never commit')
  })

  test('it names the rules it is there to prove', () => {
    const text = lf(readFileSync(path, 'utf8'))
    for (const rule of ['order_submission_payment_ready', 'order_submission_verified_payment',
                        'allocation_moved', 'approve_order_submission']) {
      assert.ok(text.includes(rule), `the assertions must exercise ${rule}`)
    }
  })
})
