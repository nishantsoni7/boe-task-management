/**
 * CLEARING A MODULE: the rule, the copy, the gates and the wiring.
 *
 * WHY THESE ARE WORTH TESTING. This facility empties two modules. Almost every
 * property that makes it safe is a property about ABSENCE — no id from the
 * browser, no prefix from the browser, no phrase trusted from the browser, no
 * cascade relied on, no RLS relaxed, no release once files may be gone — and
 * absence is exactly what stops being noticed on the third read of a file.
 *
 * NONE OF THIS IS THE ACCESS CONTROL. begin_order_finance_test_reset() and
 * finalize_order_finance_test_reset() re-derive the admin check, the enabled
 * flag, the scope, the reason, the exact phrase, the plan hash and the census
 * inside the database, under locks, on every call. The BEHAVIOUR of all of that
 * is proved against a real PostgreSQL by
 * supabase/tests/order_finance_reset_assertions.sql; what is asserted here is
 * that the SCREEN and the ROUTE cannot ask for something the database would have
 * to refuse, and that the migration says what it claims to say.
 *
 * Pure functions, source text and migration files only. No DB, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderFinanceTestReset.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NUMBER_RESET_ACKNOWLEDGEMENT,
  RESET_ACKNOWLEDGEMENT,
  RESET_CONFIRMATION,
  RESET_COUNT_ORDER,
  RESET_REMOVES,
  RESET_RETAINS,
  RESET_SCOPES,
  RESET_STAGE_LABEL,
  RESET_TITLE,
  canOfferNumberReset,
  classifyResetError,
  describeResetFailure,
  formatStorageSize,
  isResetScope,
  orderedCounts,
  previewIsEmpty,
  projectRefFromUrl,
  readyToRun,
  stageFromClaim,
  stagesFor,
  type ResetScope,
} from './testDataReset'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql'
const ROUTE = 'src/app/api/orders/test-data-reset/route.ts'
const PAGE = 'src/app/admin/control-center/data-management/page.tsx'
const ASSERTIONS = 'supabase/tests/order_finance_reset_assertions.sql'
const SHAPED = 'supabase/tests/_order_finance_reset_shaped_schema.sql'

const sql = () => read(MIGRATION)
const route = () => read(ROUTE)
const page = () => read(PAGE)

/** Source with comments stripped, for assertions about what the CODE does. */
const codeOf = (text: string) => text.split('\n')
  .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//')
    && !line.trim().startsWith('--'))
  .join('\n')

// ── The two scopes, and the words that separate them ─────────────────────────

describe('the two scopes are told apart everywhere', () => {
  test('there are exactly two, and both are recognised', () => {
    assert.deepEqual([...RESET_SCOPES], ['finance_module', 'order_finance_module'])
    for (const scope of RESET_SCOPES) assert.ok(isResetScope(scope))
    for (const other of ['', 'orders', 'everything', 'ORDER_FINANCE_MODULE', null, 7]) {
      assert.ok(!isResetScope(other), `${String(other)} must not be a scope`)
    }
  })

  test('THE PHRASES DIFFER, so one cannot confirm the other', () => {
    assert.equal(RESET_CONFIRMATION.finance_module, 'DELETE FINANCE TEST DATA')
    assert.equal(RESET_CONFIRMATION.order_finance_module, 'DELETE ALL ORDER AND FINANCE TEST DATA')
    assert.notEqual(RESET_CONFIRMATION.finance_module, RESET_CONFIRMATION.order_finance_module)
    // And neither is the chain protocol's phrase, which is a different act.
    for (const scope of RESET_SCOPES) {
      assert.notEqual(RESET_CONFIRMATION[scope], 'DELETE TEST DATA')
    }
  })

  test('the database checks the phrase for the scope it was asked for', () => {
    const body = sql()
    assert.ok(body.includes("when 'finance_module'       then 'DELETE FINANCE TEST DATA'"))
    assert.ok(body.includes("else                             'DELETE ALL ORDER AND FINANCE TEST DATA'"))
    assert.ok(body.includes('CLEANUP_CONFIRMATION_INVALID'))
  })

  test('each scope says what it removes AND what it leaves alone', () => {
    for (const scope of RESET_SCOPES) {
      assert.ok(RESET_TITLE[scope].length > 0)
      assert.ok(RESET_REMOVES[scope].length >= 3, `${scope} must say what it removes`)
      assert.ok(RESET_RETAINS[scope].length >= 3, `${scope} must say what survives`)
    }
    // The Finance card has to promise the thing that makes it usable.
    assert.ok(RESET_RETAINS.finance_module.some(line => /Confirmed Order and every PI Draft/.test(line)))
    assert.ok(RESET_RETAINS.finance_module.some(line => /return to zero/.test(line)))
  })

  test('unrelated modules are named as surviving, because absence is invisible', () => {
    const all = RESET_RETAINS.order_finance_module.join(' ')
    for (const survivor of ['Payroll', 'attendance', 'tasks', 'permissions', 'Access Control']) {
      assert.ok(new RegExp(survivor, 'i').test(all), `${survivor} must be named as surviving`)
    }
  })
})

// ── What the admin has to do ─────────────────────────────────────────────────

describe('the destructive button is live only when all four things are true', () => {
  const base = (over: Partial<Parameters<typeof readyToRun>[0]> = {}) => ({
    scope: 'finance_module' as ResetScope,
    acknowledged: true,
    typed: RESET_CONFIRMATION.finance_module,
    reason: 'clearing after a test run',
    planHash: 'abc123',
    ...over,
  })

  test('all four, and it is ready', () => {
    assert.equal(readyToRun(base()), true)
  })

  test('no scope, no acknowledgement, no reason or no plan — and it is not', () => {
    assert.equal(readyToRun(base({ scope: null })), false)
    assert.equal(readyToRun(base({ acknowledged: false })), false)
    assert.equal(readyToRun(base({ reason: '   ' })), false)
    assert.equal(readyToRun(base({ planHash: null })), false)
  })

  test('THE PHRASE IS COMPARED EXACTLY: not trimmed, not case-folded', () => {
    for (const typed of [
      'delete finance test data',
      'DELETE FINANCE TEST DATA ',
      ' DELETE FINANCE TEST DATA',
      'DELETE  FINANCE TEST DATA',
      'DELETE TEST DATA',
      RESET_CONFIRMATION.order_finance_module,
    ]) {
      assert.equal(readyToRun(base({ typed })), false, `"${typed}" must not confirm`)
    }
  })

  test('the full scope needs its own phrase and nothing shorter', () => {
    assert.equal(readyToRun(base({
      scope: 'order_finance_module', typed: RESET_CONFIRMATION.finance_module })), false)
    assert.equal(readyToRun(base({
      scope: 'order_finance_module', typed: RESET_CONFIRMATION.order_finance_module })), true)
  })

  test('the acknowledgement says what it acknowledges', () => {
    assert.ok(/permanently deletes/.test(RESET_ACKNOWLEDGEMENT))
    assert.ok(/cannot be undone/.test(RESET_ACKNOWLEDGEMENT))
    assert.ok(/connected project/.test(RESET_ACKNOWLEDGEMENT))
  })
})

// ── The Order number series ──────────────────────────────────────────────────

describe('Order numbering is a separate decision from clearing records', () => {
  test('it is never offered for a Finance-only cleanup', () => {
    assert.equal(canOfferNumberReset('finance_module'), false)
    assert.equal(canOfferNumberReset('order_finance_module'), true)
  })

  test('it has an acknowledgement of its own', () => {
    assert.notEqual(NUMBER_RESET_ACKNOWLEDGEMENT, RESET_ACKNOWLEDGEMENT)
    assert.ok(/0001/.test(NUMBER_RESET_ACKNOWLEDGEMENT))
  })

  test('the page defaults it OFF and clears it when the option is untoggled', () => {
    const body = page()
    assert.ok(body.includes('useState(false)'))
    assert.ok(body.includes('if (!next) setNumbersAcknowledged(false)'),
      'un-ticking the option must not leave a stale acknowledgement behind')
    assert.ok(body.includes('(!resetNumbers || numbersAcknowledged)'),
      'the second acknowledgement gates the run')
  })

  test('the route only ever asks for it on a full cleanup', () => {
    assert.ok(route().includes("body.resetOrderNumbers === true && scope === 'order_finance_module'"),
      'a Finance-only cleanup must not be able to reset the series')
  })

  test('and it uses the CANONICAL function rather than a second one', () => {
    assert.ok(route().includes("'reset_confirmed_order_number_cycle'"))
    // The migration must not define a numbering reset of its own.
    assert.ok(!codeOf(sql()).includes('create or replace function public.reset_confirmed_order_number_cycle'),
      'the applied reset function is reused, never restated')
  })

  test('a refused reset is NOT reported as a failed cleanup', () => {
    // The records really are gone by then; saying otherwise sends an admin
    // looking for them.
    assert.ok(route().includes('numberingRefused'))
    assert.ok(/The records were cleared, but the Order number series was left unchanged/
      .test(describeResetFailure('NUMBER_RESET_REFUSED').message))
  })
})

// ── The migration ────────────────────────────────────────────────────────────

describe('the migration is unapplied, numbered 110, and says its apply order', () => {
  test('it declares itself unapplied', () => {
    assert.ok(/NOT APPLIED/.test(sql()))
    assert.ok(/before `supabase db push`/.test(sql()))
  })

  test('IT NAMES THE FILE IT MUST FOLLOW, because 109 carries the lower number', () => {
    const header = sql().slice(0, 4000)
    assert.ok(header.includes('20261009000000'))
    assert.ok(/Push 109, then\s*\n?--\s*110/.test(header) || /Push 109, then/.test(header))
  })

  test('107 and 108 are named as frozen and are not edited', () => {
    assert.ok(/107 and 108 are frozen/.test(sql()))
    assert.ok(!sql().includes('20261007000000_retire_order_requests'))
    assert.ok(!sql().includes('20261008000000_finance_payment_classification'))
  })

  test('109, 110 AND 111 all live here, in that order, and none is duplicated', () => {
    // THE WHOLE REASON THIS FEATURE IS ON THIS BRANCH. 110 must be applied after
    // 109; two unapplied migrations in one tree apply in filename order whatever
    // sequence the branches merge in, and a 110 sitting on a branch without 109
    // makes that branch un-deployable on its own. 111 (Payment ID, admin-only
    // payment deletion, multi-target allocation) extends 110's own durable
    // claim protocol and so is stacked after it for the same reason.
    const files = readdirSync(join(ROOT, 'supabase/migrations'))
    assert.equal(files.filter(f => f.startsWith('20261009')).length, 1)
    assert.equal(files.filter(f => f.startsWith('20261010')).length, 1)
    assert.equal(files.filter(f => f.startsWith('20261011')).length, 1)
    assert.equal(files.filter(f => f.startsWith('20261012')).length, 1)
    assert.equal(files.filter(f => f.startsWith('20261013')).length, 1)
    assert.equal(files.filter(f => f.startsWith('20261015')).length, 1)
    assert.equal(files.filter(f => f.startsWith('20261016')).length, 1)
    const pending = files
      .filter(f => /^\d{14}_/.test(f) && f.slice(0, 14) > '20261008000000')
      .filter(f => !f.startsWith('20261015'))   // applied — see FROZEN
      // 116 (notifications.activity_log_id) has since been APPLIED — see the
      // FROZEN ledger in participantAndOrderTotalSecurity.test.ts — so it is
      // excluded here for the same reason 115 is. It belongs to Task
      // Management and touched neither the reset protocol, the deletion claim
      // nor the allocation ledger, which is why applying it out ahead of
      // 109-114 changed nothing for any of them.
      .filter(f => !f.startsWith('20261016'))
      .sort()
    assert.deepEqual(pending, [
      '20261009000000_split_payment_entry_and_order_submission_number_reservation.sql',
      '20261010000000_order_submission_and_finance_test_data_reset.sql',
      '20261011000000_admin_payment_deletion_and_payment_id.sql',
      // 112. Makes active allocation rows the single financial source in SQL as
      // well as in the application, and drops the Link/Unlink write surface. It
      // touches neither the reset protocol nor the deletion claim, and stacks
      // after 111 for the ordinary reason: it replaces the view 111 leaves.
      '20261012000000_allocation_ledger_as_single_source.sql',
      // 113. The payment-entry destination model. It stacks after 112 for the
      // ordinary reason — it restates functions 112 leaves behind — and it
      // touches neither the reset protocol nor the deletion claim, both of
      // which it re-asserts rather than changes.
      '20261013000000_payment_entry_destination_model.sql',
      // 114. The destination a payment SHOWS, the four current payment modes,
      // and the PNB/Paytm custody event log. It stacks after 113 for the
      // ordinary reason — it restates the entry RPCs 113 leaves behind — and it
      // touches neither the reset protocol nor the deletion claim: its new
      // tables carry the project's is_test_data marker and cascade from the
      // payment, so the reset and the tombstone reach them unchanged.
      '20261014000000_payment_destination_display_modes_and_custody.sql',
      // 117. Customer Review Outreach — also pending, and last in filename
      // order, so it applies after every migration above it whatever sequence
      // the branches merge in. It touches neither the reset protocol nor the
      // deletion claim: it creates three tables of its own and alters nothing
      // that exists. Its tables carry no is_test_data marker because they hold
      // no order or payment data for a reset to reach.
      '20261017000000_customer_review_outreach.sql',
      // 115 (run_task_health_check stops inserting notifications) is NOT in
      // this list: it has been applied, so it is pinned in FROZEN over in
      // participantAndOrderTotalSecurity.test.ts instead. It touched neither
      // the reset protocol nor the deletion claim — it replaced one function
      // body and read or wrote no table either of them cares about.
      //
      // 118 (Top 3 Focus unpin) IS in this list: it is unapplied. It touches
      // user_top_tasks and reads tasks.status, so it reaches neither the reset
      // protocol nor the deletion claim, and carrying the highest number it
      // cannot apply ahead of 109-114.
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      // 120 (Image Editor module registration) is unapplied too, writes only
      // permission_modules and permission_actions rows, and carries a higher
      // number still.
      '20261020000000_register_image_editor_module.sql',
      '20261021000000_seed_customer_review_test_cards.sql',
      // 122. The Image Editor result history is unapplied too. It creates a
      // private bucket and one table of its own, holds no order or payment
      // data for a reset to reach, and carries the highest number of all.
      '20261022000000_image_editor_result_history.sql',
      '20261023000000_review_workflow_ai_drafts.sql',
      // The batch-approval pair, in the order they must apply. The deletion
      // migration runs FIRST so the schema one lands on an empty card table
      // and can enforce its approval invariants without a legacy exemption.
      '20261025000000_review_workflow_remove_legacy_test_data.sql',
      '20261026000000_review_workflow_batch_approval.sql',
      // Provider-call idempotency: a request key is CLAIMED before the model
      // is called, so two simultaneous requests cannot both be billed for.
      '20261027000000_review_workflow_generation_claims.sql',
      // Assets & Access, from a separate branch: the delegated Access Register
      // permission and the asset handover acknowledgement. Neither touches
      // this work's tables, policies or functions.
      '20261028000000_assets_access_manage_access_records.sql',
      '20261029000000_asset_handover_acknowledgement.sql',
      // Verifier deletion, and the Add-versus-Replace choice at approval.
      '20261030000000_review_workflow_deletion_and_replacement.sql',
      // Twelve drafts a batch, editing a pending draft before approval, and up
      // to four review images. Touches only the Review Workflow's own tables.
      '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
      // BOE Credits Phase 1A: the append-only credit ledger, its derived balance
      // view, the settings table and the service-role posting functions. Two new
      // tables of its own; it touches nothing any other module creates.
      '20261101000000_boe_credits_foundation.sql',
      // BOE Credits Phase 1B: re-creates transition_customer_review_test_card() so a
      // verified review posts its review_reward in the same transaction. One
      // function, no table, no data.
      '20261102000000_boe_credits_review_reward.sql',
      // BOE Credits Phase 1C: the attendance redemption record table and the
      // service-role function that covers one attendance day with credits. One
      // new table of its own; it touches nothing any other module creates.
      '20261103000000_boe_credits_attendance_redemption.sql',
      // BOE Credits Phase 1D: configurable settings, monthly review qualification
      // and the payroll salary addition. Three new credits tables of its own; it
      // touches nothing any other module creates.
      '20261104000000_boe_credits_phase_1d.sql',
      // Half-day company holidays: two nullable/defaulted columns and one CHECK
      // constraint on payroll_holidays, an Attendance/Payroll table. It creates
      // no table and touches neither the reset protocol nor the deletion claim.
      '20261105000000_holiday_half_day.sql',
      // Employee designation level: one nullable, informational column on
      // public.users, granted to authenticated. Reaches nothing here.
      '20261106000000_employee_designation_level.sql',
      // Review types, batch assignment and the project image library: two new
      // tables of its own, columns on customer_review_test_cards and one on
      // boe_credit_settings. It reaches nothing here.
      '20261107000000_review_types_assignment_and_image_groups.sql',
      // Variable Review Workflow batch size: three CHECKs on its own batch and
      // claim tables widened from 12 to a 6-20 range, two nullable columns added
      // to customer_review_draft_batches, and three of its own functions
      // redefined. It creates no table and reaches nothing here.
      '20261108000000_review_workflow_variable_batch_size.sql',
      // Performance: Personal Performance and Team Performance become separately
      // configurable capabilities. It registers two actions on the existing
      // `performance` permission module and seeds the admin/manager role grants
      // that reproduce today's role checks exactly. It creates no table, alters
      // no table and defines no function, so it reaches nothing asserted here.
      '20261109000000_performance_personal_and_team_capabilities.sql',
      // The forward-only correction to it: Performance management visibility is
      // granted per employee, never inherited from the `manager` role name. It
      // deletes two role_permissions rows and inserts two
      // employee_permission_overrides rows. It creates no table, alters no table
      // and defines no function, so it reaches nothing asserted here.
      '20261110000000_performance_team_visibility_is_granted_not_inherited.sql',
      // The two permission_modules rows whose display_name and description had
      // drifted from src/lib/permissions/modules.ts, moved onto the registry text.
      // Two UPDATE statements against display text. It creates no table, alters no
      // table and defines no function, so it reaches nothing asserted here.
      '20261111000000_permission_module_labels_follow_the_registry.sql',
    ])
  })

  test('109 is not modified by this work — its bytes are its own', () => {
    // The Order-number reservation migration is a separate piece of work that
    // happened to arrive first. Nothing in the module reset needs it changed:
    // the deletion graph is identical with and without it, and its own trigger
    // on order_number_cycle already refuses a reset at or below a reserved
    // number, so reset_confirmed_order_number_cycle() needed no edit either.
    const nine = read(
      'supabase/migrations/20261009000000_split_payment_entry_and_order_submission_number_reservation.sql')
    assert.ok(!nine.includes('order_finance_test_reset'),
      '109 must know nothing about the module reset')
    assert.ok(nine.includes('order_number_cycle_respects_reservations'),
      'and must still carry the reservation gate the reset relies on')
  })
})

describe('the migration deletes in foreign-key order, and proves the order', () => {
  const body = () => codeOf(sql())

  test('allocations go FIRST: three NO ACTION keys hang off them', () => {
    const text = body()
    const allocations = text.indexOf('delete from public.finance_payment_allocations')
    const payments = text.indexOf('delete from public.finance_payment_requests')
    const submissions = text.indexOf('delete from public.order_submissions where id')
    const orders = text.indexOf('delete from public.orders where id')
    assert.ok(allocations > 0 && allocations < payments, 'allocations before payments')
    assert.ok(allocations < submissions, 'allocations before PI Drafts')
    assert.ok(allocations < orders, 'allocations before Orders')
  })

  test('correction requests go BEFORE PI activity, which they name', () => {
    const text = body()
    const corrections = text.indexOf('delete from public.order_submission_correction_requests')
    const activity = text.indexOf('delete from public.order_submission_activity')
    assert.ok(corrections > 0 && corrections < activity,
      'a resolved correction request names an activity row with NO ACTION')
  })

  test('PI Drafts and requests go BEFORE Orders, which both of them name', () => {
    const text = body()
    const submissions = text.indexOf('delete from public.order_submissions where id')
    const requests = text.indexOf('delete from public.order_requests where id')
    const orders = text.indexOf('delete from public.orders where id')
    assert.ok(submissions < orders && requests < orders)
  })

  test('both directions of the mutual provenance keys are released first', () => {
    const text = body()
    const release = text.indexOf('set source_order_submission_id = null')
    const submissions = text.indexOf('delete from public.order_submissions where id')
    assert.ok(release > 0 && release < submissions)
    assert.ok(text.includes('set converted_order_id = null'))
  })

  test('the Order document register is deleted explicitly, not left to a cascade', () => {
    assert.ok(body().includes('delete from public.order_document_versions where order_id'))
  })

  test('NOTHING IS DISABLED, TRUNCATED OR DROPPED to make the deletes work', () => {
    const text = body().toLowerCase()
    for (const forbidden of [
      'disable trigger', 'alter table public.orders disable', 'set session_replication_role',
      'truncate', 'drop constraint order_', 'drop policy', 'alter table public.orders disable row level security',
    ]) {
      assert.ok(!text.includes(forbidden), `${forbidden} must not appear`)
    }
    assert.ok(!/\bcascade\b/.test(text.replace(/on delete cascade/g, '')),
      'no broad CASCADE anywhere')
  })

  test('IT RESHAPES NOTHING: no column is added to any PI table', () => {
    // An earlier form of this file added order_submissions.is_test_data, which
    // meant three separate suites guarding the PI submission tables had to be
    // taught to forgive it. They are not taught anything now, because there is
    // nothing to forgive: the reset covers the module rather than a tag, so the
    // column bought nothing and 20260916000000 §11's decision stands.
    const structural = [...body().matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*[^;]*;/gi)]
    assert.deepEqual(structural.map(m => m[0]), [])
    assert.ok(!/(?:alter|drop|create)\s+policy\s[^;]*\bon\s+(?:public\.)?order_submission/i
      .test(body()))
  })

  test('and the migration asserts that absence itself, at apply time', () => {
    const text = sql()
    assert.ok(text.includes('order_submissions.is_test_data exists; 20260916000000 §11 declined it'))
  })

  test('NO SCOPE ANYWHERE FILTERS ON is_test_data', () => {
    // The correction this file exists in its present form to make. Asserted in
    // the source AND at apply time from pg_get_functiondef, because a reset
    // that silently covers less than its own name says is the failure mode.
    const text = sql()
    // The two function bodies that decide what is deleted, taken whole.
    for (const fn of ['order_finance_test_reset_census', 'finalize_order_finance_test_reset']) {
      const start = text.indexOf(`create or replace function public.${fn}`)
      assert.ok(start > 0, `${fn} must exist`)
      const fnBody = text.slice(start, text.indexOf('\n$$;', start))
      assert.ok(!fnBody.includes('is_test_data'), `${fn} must not filter on the tag`)
    }
    // The only mentions left in the file are the two apply-time assertions that
    // REFUSE the tag, and the prose explaining why.
    assert.ok(text.includes('the census filters on is_test_data; a module reset must cover the module'))
    assert.ok(text.includes('the finalizer filters on is_test_data; a module reset must cover the module'))
  })

  test('every payment is in scope, whatever its status', () => {
    const census = body().slice(body().indexOf('order_finance_test_reset_census'))
    assert.ok(/into v_payments\s*\n\s*from public\.finance_payment_requests f;/.test(census),
      'the payment selection carries no predicate at all')
  })

  test('and auth.users is never touched', () => {
    // The prose names it in the list of things this file does not do; the CODE
    // must not name it at all.
    assert.ok(!body().includes('auth.users'))
    assert.ok(/does not .*auth\.users|auth\.users\./.test(sql()),
      'and the file says so where the next reader will look')
  })

  test('the delete order is asserted against pg_constraint at apply time', () => {
    const text = sql()
    assert.ok(text.includes('from pg_constraint c'))
    assert.ok(text.includes("c.confdeltype in ('a', 'r')"),
      'only the rules that REFUSE a delete are the ones that constrain the order')
    assert.ok(text.includes('the NO ACTION references into the cleanup parents are not the ones the finalizer handles'))
  })
})

describe('the production protections are kept, not stood down', () => {
  test('the four delete guards are asserted still armed', () => {
    const text = sql()
    for (const guard of [
      'orders_prevent_delete',
      'order_requests_prevent_converted_delete',
      'finance_payment_requests_guard_approved_delete',
      'finance_payment_allocations_guard_delete',
    ]) {
      assert.ok(text.includes(guard), `${guard} must be asserted`)
    }
    assert.ok(text.includes('production protection % is missing or disabled'))
  })

  test('the only exemption is the transaction-local marker no client can set', () => {
    const text = codeOf(sql())
    assert.ok(text.includes("set_config('boe.cleanup_context', 'test_data_cleanup', true)"))
    assert.ok(text.includes("set_config('boe.cleanup_context', '', true)"),
      'and it is cleared again inside the same transaction')
    assert.ok(!text.includes("current_setting('boe.cleanup_context'"),
      'the marker is written here and read only by the applied guards')
  })

  test('no RLS is weakened and no client grant is widened', () => {
    const text = codeOf(sql())
    assert.ok(!/disable row level security/i.test(text))
    assert.ok(!/create policy/i.test(text))
    assert.ok(!/grant (select|insert|update|delete)/i.test(text),
      'no table privilege is granted to any role')
    // Every function grant is EXECUTE to authenticated, and every one of those
    // functions re-checks admin itself.
    for (const fn of [
      'preview_order_finance_test_reset', 'begin_order_finance_test_reset',
      'finalize_order_finance_test_reset', 'release_order_finance_test_reset',
      'order_finance_test_reset_status',
    ]) {
      assert.ok(new RegExp(`grant\\s+execute on function public\\.${fn}`).test(text),
        `${fn} must be executable by a signed-in caller`)
      assert.ok(new RegExp(`revoke all\\s+on function public\\.${fn}[^;]*from public, anon`).test(text),
        `${fn} must be revoked from anon`)
    }
  })

  test('the internals are reachable by nobody, service role included', () => {
    const text = sql()
    for (const fn of ['order_finance_reset_write_guard', 'open_order_finance_reset_scope',
                      'order_finance_test_reset_census']) {
      assert.ok(new RegExp(`revoke execute on function public\\.${fn}[\\s\\S]{0,120}service_role`).test(text)
        || new RegExp(`revoke all\\s+on function public\\.${fn}[\\s\\S]{0,120}service_role`).test(text),
        `${fn} must not be callable by service_role`)
    }
  })
})

describe('the cleanup lock is on the tables, not in the writers', () => {
  test('every Order and Finance table carries the guard', () => {
    const text = sql()
    for (const table of [
      'finance_payment_requests', 'finance_payment_allocations',
      'payment_proof_attachments', 'finance_payment_request_activity_log',
      'orders', 'order_activity_log', 'order_change_requests', 'order_document_versions',
      'order_submissions', 'order_submission_items', 'order_submission_item_images',
      'order_submission_activity', 'order_submission_correction_requests',
      'order_requests', 'order_request_activity', 'order_request_attachments',
    ]) {
      assert.ok(text.includes(`'${table}'`), `${table} must be in the lock list`)
    }
    assert.ok(text.includes('the cleanup write lock is not armed on public.%'),
      'and it is asserted at apply time')
  })

  test('it fires on INSERT as well as UPDATE and DELETE', () => {
    assert.ok(sql().includes('before insert or update or delete on public.%I'),
      'a census that can be overtaken by a new row is not a census')
  })

  test('a Finance-only reset does not freeze Orders', () => {
    assert.ok(codeOf(sql()).includes("if v_side = 'finance' or v_scope = 'order_finance_module' then"))
  })

  test('the refusal is retryable and readable, and names nothing', () => {
    const text = sql()
    assert.ok(text.includes("using errcode = '55P03'"))
    assert.ok(text.includes('Please try again in a few minutes.'))
    assert.ok(!/RESET_IN_PROGRESS[^']*%s|RESET_IN_PROGRESS[^']*\|\|/.test(text),
      'the message interpolates nothing')
  })

  test('unrelated modules carry no guard at all', () => {
    const text = sql()
    for (const table of ['payroll', 'attendance', 'tasks', 'assets', 'showroom', 'users']) {
      assert.ok(!new RegExp(`'${table}[a-z_]*'\\s*(,|\\n)`).test(text)
        || !text.includes(`${table}_reset_write_guard`),
        `${table} must not be frozen by an Order/Finance reset`)
    }
  })
})

describe('the PI deletion race is closed in the database', () => {
  test('both writers the existing claim missed are now refused', () => {
    const text = sql()
    assert.ok(text.includes('finance_payment_allocations_guard_pi_deletion'))
    assert.ok(text.includes('order_submission_corrections_guard_deletion'))
    assert.ok(text.includes('ORDER_SUBMISSION_DELETION_CLAIMED'))
  })

  test('and the reasoning names which writer was already closed and which was not', () => {
    // CORRECTED, AND STRENGTHENED. This used to accept the header calling
    // allocate_payment_to_target() NOT closed or OPEN. That was wrong against
    // the file: 20260921000000 takes `for update` on the PI row and raises
    // ALLOCATION_TARGET_CLAIMED on a standing claim, so the ordinary allocation
    // path is already refused. What it does NOT do is bind a caller that never
    // goes through it. Asserting the true distinction is what makes this test
    // worth having — a header that mislabels a writer sends the next reader
    // looking for a hole that is not there, and past the one that is.
    const header = sql()
    assert.ok(/approve_order_submission\(\)\s+CLOSED/.test(header),
      'the writer that meets the existing claim guard is named as closed')
    assert.ok(/allocate_payment_to_target\(\)\s+HALF/.test(header),
      'and the one that refuses through its RPC but binds no direct writer is not called open')
    // The header wraps across comment lines, so each claim is checked on its own
    // rather than as one adjacent phrase.
    const prose = header.split('\n').map(l => l.replace(/^--\s*/, '')).join(' ')
    assert.ok(/DOES lock the PI row and refuse a standing claim/.test(prose),
      'the header must say what allocate_payment_to_target actually does')
    assert.ok(/binds no direct SQL or service-role/.test(prose),
      'and name the gap that is actually left')
    assert.ok(/request_order_submission_correction\(\)/.test(prose)
      && /never reads deletion_claim_token/.test(prose),
      'the writer that genuinely checks nothing must still be named')
  })

  test('the guards are narrow: INSERT only, and only for the named PI', () => {
    const text = codeOf(sql())
    assert.ok(text.includes('before insert on public.finance_payment_allocations'))
    assert.ok(text.includes('before insert on public.order_submission_correction_requests'))
    assert.ok(text.includes('where s.id = new.order_submission_id'))
    assert.ok(text.includes('where s.id = new.submission_id'))
  })

  test('the individual PI deletion fix at 7b400d8 is intact', () => {
    // The bulk facility serves a different purpose and must not have replaced it.
    const deleteRoute = read('src/app/api/orders/submissions/delete/route.ts')
    assert.ok(deleteRoute.includes('readDeletionBlockers(service, submissionId)'),
      'blocker disclosure')
    assert.ok(deleteRoute.includes('const alreadyGone ='), 'idempotent success')
    assert.ok(deleteRoute.includes("'begin_order_submission_deletion'"))
    assert.ok(deleteRoute.includes('removeAllObjectsForSubmission('))
    const blockers = read('src/lib/orders/submissionDeletionBlockersServer.ts')
    assert.ok(blockers.includes('payment_allocation'))
    assert.ok(blockers.includes('correction_request'), 'correction-request blocking is preserved')
    assert.ok(blockers.includes('confirmed_order'))
  })
})

// ── The route ────────────────────────────────────────────────────────────────

describe('the route proves who is asking before it uses what it holds', () => {
  test('the caller is authenticated from the session, never from the body', () => {
    const text = route()
    assert.ok(text.includes('await authClient.auth.getUser()'))
    assert.ok(text.includes("return fail({ code: 'UNAUTHORIZED', status: 401 })"))
  })

  test('THE CANONICAL ADMIN CHECK, and nothing looser', () => {
    const text = route()
    assert.ok(text.includes("me.role !== 'admin'"))
    assert.ok(text.includes('me.is_active === false'))
    assert.ok(text.includes('me.is_deleted === true'))
    // NO ROLE LIST AND NO PERMISSION LOOKUP: either would admit somebody who is
    // not an admin. The check is one equality against 'admin' and two liveness
    // flags, and nothing else reads a role.
    const code = codeOf(text)
    assert.ok(!/\[\s*'admin'\s*,/.test(code), 'no allow-list of roles')
    assert.ok(!/role\s*(===|!==|==|!=)\s*'(?!admin')/.test(code))
    assert.ok(!/\.includes\(me\.role\)/.test(code))
    assert.ok(!/permission|can_|has_role/i.test(code), 'and no permission lookup')
    assert.equal((code.match(/me\.role/g) ?? []).length, 1, 'the role is read exactly once')
  })

  test('the admin check comes before anything destructive is asked for', () => {
    const text = route()
    const check = text.indexOf("me.role !== 'admin'")
    for (const rpc of ["'preview_order_finance_test_reset'", "'begin_order_finance_test_reset'",
                       "'finalize_order_finance_test_reset'"]) {
      assert.ok(text.indexOf(rpc) > check, `${rpc} must be downstream of the admin check`)
    }
  })

  test('cleanup is proven ATTEMPTABLE before anything is frozen', () => {
    const text = route()
    const guard = text.indexOf('if (!url || !serviceKey)')
    const begin = text.indexOf("'begin_order_finance_test_reset'")
    assert.ok(guard > 0 && begin > 0 && guard < begin)
  })

  test('THE ORDER IS freeze → sweep → say-so → finalize', () => {
    const text = route()
    const begin = text.indexOf("'begin_order_finance_test_reset'")
    const sweep = text.indexOf('removeResetStorage(')
    const mark = text.indexOf("'order_finance_test_reset_storage_done'")
    const finalize = text.indexOf("'finalize_order_finance_test_reset'")
    assert.ok(begin > 0 && sweep > begin && mark > sweep && finalize > mark,
      'the module is frozen before a byte is touched, and erased only after')
  })

  test('the client can name no id, no path and no token', () => {
    const text = codeOf(route())
    assert.ok(!/body\.(ids|paths|storagePaths|submissionIds|orderIds|claimToken|token)/.test(text))
    assert.ok(text.includes("parseResetManifest(claim?.storage_manifest)"),
      'the manifest comes from the claim')
    // The body is read for exactly six fields and no more.
    const bodyReads = [...text.matchAll(/body\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(bodyReads)].sort(),
      ['action', 'confirmation', 'planHash', 'reason', 'resetOrderNumbers', 'scope'])
  })

  test('the claim token never reaches the browser', () => {
    const text = route()
    const responses = [...text.matchAll(/NextResponse\.json\(\{[\s\S]{0,600}?\}\)/g)].map(m => m[0])
    for (const body of responses) {
      assert.ok(!body.includes('token'), `a response body names a token: ${body.slice(0, 80)}`)
      assert.ok(!body.includes('claim_token'))
    }
    assert.ok(!page().includes('claim_token'), 'and the page knows nothing about claims')
  })

  test('the preview returns counts, never the delete list', () => {
    const text = route()
    const preview = text.slice(text.indexOf("if (action === 'preview')"), text.indexOf('// ── run'))
    assert.ok(preview.includes('counts:'))
    assert.ok(preview.includes('planHash:'))
    assert.ok(!preview.includes('targets'), 'the ids are the claim’s business')
  })

  test('the phrase is re-checked here AND is not the only check', () => {
    const text = route()
    assert.ok(text.includes('confirmation !== RESET_CONFIRMATION[scope as ResetScope]'))
    assert.ok(/only saves a round trip/.test(text),
      'and the code says which check is the real one')
    assert.ok(sql().includes('CLEANUP_CONFIRMATION_INVALID'))
  })

  test('no raw database message is ever returned to the browser', () => {
    const text = route()
    assert.ok(!/claimErr\.message|finalErr\.message|error\.message/.test(text))
    assert.ok(text.includes('classifyResetError(claimErr)'))
    assert.ok(text.includes('classifyResetError(finalErr)'))
  })

  test('the service key never leaves the server', () => {
    assert.ok(route().includes('process.env.SUPABASE_SERVICE_ROLE_KEY'))
    assert.ok(!route().includes('NEXT_PUBLIC_SUPABASE_SERVICE'))
    const body = page()
    assert.ok(!body.includes('SERVICE_ROLE'))
    assert.ok(!body.includes('createServiceClient'))
    assert.ok(!body.includes('SUPABASE_URL'), 'and the URL is never read in browser code')
  })

  test('all five RPCs run as the signed-in ADMIN, never as the service role', () => {
    const text = route()
    for (const fn of ['preview_order_finance_test_reset', 'begin_order_finance_test_reset',
                      'finalize_order_finance_test_reset', 'release_order_finance_test_reset',
                      'order_finance_test_reset_status']) {
      assert.ok(text.includes(`'${fn}'`), `${fn} must be called`)
      assert.ok(!text.includes(`service.rpc('${fn}'`),
        `${fn} as the service role would bypass the actor it re-derives`)
    }
    assert.ok(text.includes('authClient.rpc('))
  })

  test('THERE IS NO TIMEOUT, because a promise race is not cancellation', () => {
    const text = codeOf(route())
    assert.ok(!text.includes('Promise.race'))
    assert.ok(!text.includes('setTimeout'))
    assert.ok(!text.includes('withTimeout'))
    assert.ok(!text.includes('AbortController'))
  })

  test('the claim is released ONLY when nothing destructive was issued', () => {
    const text = route()
    for (const match of [...text.matchAll(/await release\(\)/g)]) {
      const line = text.slice(text.lastIndexOf('\n', match.index!) + 1, match.index! + 15)
      assert.ok(/if \(!removalAttempted\)/.test(line), `an unguarded release: ${line.trim()}`)
    }
    assert.ok(text.includes('let removalAttempted = false'))
    assert.ok(text.includes('onRemoveAttempt: () => { removalAttempted = true }'))
    assert.ok(!codeOf(text).includes('finally {\n    await release'),
      'no finally-block release')
  })

  test('a refused finalization keeps the claim, because by then the files are gone', () => {
    const text = route()
    const branch = text.slice(text.indexOf('if (finalErr) {'), text.indexOf('// ── The Order number series'))
    assert.ok(!branch.includes('await release()'))
    assert.ok(branch.includes('THE CLAIM IS DELIBERATELY NOT RELEASED'))
    assert.ok(branch.includes('reserved: true'))
  })

  test('and it logs durations and counts only', () => {
    const text = route()
    const logs = text.match(/console\.(log|info|warn|error)\(/g) ?? []
    assert.equal(logs.length, 1)
    assert.ok(text.includes("console.info('[orders:test-data-reset]'"))
    const line = text.slice(text.indexOf("console.info('[orders:test-data-reset]'"))
      .slice(0, 400)
    assert.ok(!line.includes('token'))
    assert.ok(!line.includes('projectRef'))
    assert.ok(!line.includes('reason'))
  })
})

// ── The page ─────────────────────────────────────────────────────────────────

describe('the page cannot ask for something the database would have to refuse', () => {
  test('THE BROWSER NEVER TOUCHES A BUCKET', () => {
    const body = page()
    assert.ok(!body.includes('storage.from('))
    assert.ok(!body.includes('.remove('))
    assert.ok(body.includes("fetch('/api/orders/test-data-reset'"))
  })

  test('it never deletes a row directly either', () => {
    const body = codeOf(page())
    assert.ok(!/supabase\s*\.\s*from\([^)]*\)\s*\.\s*delete\(/.test(body))
    assert.ok(!body.includes('.rpc('), 'every destructive call goes through the protected route')
  })

  test('an unidentifiable project FAILS CLOSED', () => {
    const body = page()
    assert.ok(body.includes('projectRef !== null'), 'the run gate requires a known project')
    assert.ok(body.includes('The connected project could not be identified'))
  })

  test('the project is named before anything else on the page', () => {
    const body = page()
    assert.ok(body.indexOf('<ProjectBanner') < body.indexOf('<ScopeCard'))
    assert.ok(body.includes('This clears data in the connected Supabase project'))
  })

  test('a double click sends exactly one request', () => {
    const body = page()
    assert.ok(body.includes('if (!scope || !preview?.planHash || runningRef.current) return'))
    assert.ok(body.includes('runningRef.current = true'))
    assert.ok(body.includes('useRef(false)'))
  })

  test('changing the chosen card invalidates the phrase and the plan', () => {
    const body = page()
    const choose = body.slice(body.indexOf('const chooseScope'), body.indexOf('const intent'))
    for (const cleared of ['setPreview(null)', "setTyped('')", 'setAcknowledged(false)',
                           'setResetNumbers(false)']) {
      assert.ok(choose.includes(cleared), `${cleared} must be reset when the scope changes`)
    }
  })

  test('a stale plan re-reads the counts and clears the typed phrase', () => {
    const body = page()
    assert.ok(body.includes("const again = await post({ action: 'preview', scope })"))
    assert.ok(body.includes("setTyped('')"))
  })

  test('RED APPEARS ONCE, on the act itself', () => {
    const body = page()
    // One destructive style helper, used for the confirm control and the final
    // dialog's button — and nowhere in the two cards that open the page.
    assert.equal((body.match(/const btnDanger =/g) ?? []).length, 1)
    const cards = body.slice(body.indexOf('function ScopeCard'), body.indexOf('function Bullets'))
    assert.ok(!cards.includes('btnDanger'), 'the cards are not alarming before anything is chosen')
    assert.ok(!cards.includes('#B91C1C'))
  })

  test('the stages are announced, not merely drawn', () => {
    const body = page()
    assert.ok(body.includes('role="status"'))
    assert.ok(body.includes('aria-live="polite"'))
    assert.ok(body.includes('role="alert"'), 'and so are refusals')
    // The final confirmation is the shared Control Center dialog, which owns
    // role="dialog" and aria-modal="true" (src/components/controlCenter/CcPrimitives.tsx).
    assert.ok(body.includes('aria-modal="true"') || body.includes('<CcDialog'))
  })

  test('an interrupted reset is legible on reopening', () => {
    const body = page()
    for (const fact of ['started_by', 'started_at', 'RESET_STAGE_LABEL[stage]',
                        'existing.failure', 'Resume this cleanup']) {
      assert.ok(body.includes(fact), `${fact} must be shown`)
    }
    assert.ok(body.includes('Only the administrator who started it can finish it'))
  })

  test('and it never shows a secret while doing it', () => {
    const status = sql().slice(sql().indexOf('order_finance_test_reset_status'))
    assert.ok(status.includes('Never returns the claim token'))
    assert.ok(!/'claim_token',\s*v_claim\.claim_token/.test(
      sql().slice(sql().indexOf('create or replace function public.order_finance_test_reset_status'),
                  sql().indexOf('create or replace function public.order_finance_test_reset_storage_done'))))
  })
})

// ── The copy ─────────────────────────────────────────────────────────────────

describe('the numbers and the words', () => {
  test('every count the preview shows has a label', () => {
    for (const key of RESET_COUNT_ORDER) {
      assert.ok(orderedCounts({ [key]: 1 })[0]?.label, `${key} must have a label`)
      assert.notEqual(orderedCounts({ [key]: 1 })[0].label, key)
    }
  })

  test('the required counts are all present', () => {
    for (const required of ['payments', 'payment_allocations', 'orders', 'order_submissions',
                            'order_submission_items', 'correction_requests', 'storage_objects',
                            'payment_proofs', 'order_documents', 'notifications']) {
      assert.ok(RESET_COUNT_ORDER.includes(required), `${required} must be previewed`)
    }
  })

  test('a zero is not rendered, and an absent key is not rendered as zero', () => {
    assert.deepEqual(orderedCounts({ payments: 0 }), [])
    assert.deepEqual(orderedCounts({}), [])
    assert.deepEqual(orderedCounts({ payments: null }), [])
    assert.equal(previewIsEmpty({ payments: 0, orders: 0 }), true)
    assert.equal(previewIsEmpty({ payments: 1 }), false)
  })

  test('NULL STORAGE IS "not measured", never "0 B"', () => {
    assert.equal(formatStorageSize(null), 'not measured')
    assert.equal(formatStorageSize(undefined), 'not measured')
    assert.equal(formatStorageSize(-1), 'not measured')
    assert.equal(formatStorageSize(0), '0 B')
    assert.equal(formatStorageSize(512), '512 B')
    assert.equal(formatStorageSize(1024), '1.0 KB')
    assert.equal(formatStorageSize(1024 * 1024 * 3), '3.0 MB')
  })

  test('the stages are the ones the brief names, in order', () => {
    assert.deepEqual(stagesFor('order_finance_module').map(s => RESET_STAGE_LABEL[s]), [
      'Preparing cleanup', 'Freezing writes', 'Removing files',
      'Removing Finance records', 'Removing Orders and PI Drafts',
      'Verifying cleanup', 'Completed',
    ])
  })

  test('and a Finance-only reset does not claim to remove Orders', () => {
    assert.ok(!stagesFor('finance_module').includes('removing_orders'))
  })

  test('the database’s own stage words map onto the screen’s', () => {
    assert.equal(stageFromClaim('frozen'), 'freezing')
    assert.equal(stageFromClaim('storage_removed'), 'removing_files')
    assert.equal(stageFromClaim('completed'), 'completed')
    assert.equal(stageFromClaim('anything else'), 'preparing')
    assert.equal(stageFromClaim(null), 'preparing')
  })
})

describe('every refusal reaches the screen as a sentence', () => {
  test('each marker maps to its own code', () => {
    for (const [message, code] of [
      ['CLEANUP_DISABLED: permanently disabled', 'DISABLED'],
      ['CLEANUP_CONFIRMATION_INVALID: type it exactly', 'CONFIRMATION_INVALID'],
      ['CLEANUP_REASON_REQUIRED: say why', 'REASON_REQUIRED'],
      ['RESET_FORBIDDEN: only an active admin', 'FORBIDDEN'],
      ['RESET_SCOPE_INVALID: nope', 'SCOPE_INVALID'],
      ['RESET_PLAN_STALE: the records changed', 'PLAN_STALE'],
      ['RESET_BLOCKED: not test data', 'BLOCKED'],
      ['RESET_CLAIMED_BY_OTHER: somebody else', 'IN_PROGRESS'],
      ['RESET_CLAIM_INVALID: no', 'CLAIM_INVALID'],
      ['RESET_CLAIM_RELEASED: given back', 'CLAIM_INVALID'],
      ['RESET_STORAGE_INCOMPLETE: files', 'STORAGE_FAILED'],
      ['RESET_SCOPE_CHANGED: moved', 'SCOPE_CHANGED'],
      ['ORDER_NUMBER_RESET_ORDERS_EXIST: 3 Orders', 'NUMBER_RESET_REFUSED'],
      ['Authentication required', 'UNAUTHORIZED'],
    ] as const) {
      assert.equal(classifyResetError(new Error(message)), code, message)
    }
  })

  test('anything unrecognised is a plain retryable failure, never a leak', () => {
    const failure = describeResetFailure(classifyResetError(
      new Error('ERROR: relation "public.orders" does not exist at character 15')))
    assert.equal(failure.code, 'RESET_FAILED')
    assert.ok(!/relation|character|ERROR/.test(failure.message))
  })

  test('a blocked reset can name the reason without naming a record', () => {
    const failure = describeResetFailure('BLOCKED', [
      { kind: 'real_payment_allocation', label: 'PR-9',
        reason: 'a payment that is not test data is allocated to a record in this scope' },
      { kind: 'real_payment_allocation', label: 'PR-9',
        reason: 'a payment that is not test data is allocated to a record in this scope' },
    ])
    const reason = 'a payment that is not test data is allocated to a record in this scope'
    assert.ok(failure.message.includes(reason))
    assert.equal((failure.message.match(new RegExp(reason, 'g')) ?? []).length, 1,
      'two identical reasons are said once')
    assert.ok(!failure.message.includes('PR-9'),
      'and the record’s own number is never asserted onto the sentence')
  })

  test('nonsense detail still produces a sentence', () => {
    for (const detail of [undefined, null, 'yes', [], [{}], [{ reason: 7 }]]) {
      const failure = describeResetFailure('BLOCKED', detail)
      assert.ok(failure.message.length > 0)
      assert.ok(!/undefined|\[object|NaN/.test(failure.message))
    }
  })

  test('only the failures a retry can change are marked retryable', () => {
    for (const code of ['PLAN_STALE', 'STORAGE_FAILED', 'SCOPE_CHANGED', 'RESET_FAILED'] as const) {
      assert.equal(describeResetFailure(code).retryable, true, code)
    }
    for (const code of ['FORBIDDEN', 'DISABLED', 'CONFIRMATION_INVALID', 'BLOCKED',
                        'IN_PROGRESS', 'UNAUTHORIZED'] as const) {
      assert.equal(describeResetFailure(code).retryable, false, code)
    }
  })
})

describe('the project reference names the project and authorizes nothing', () => {
  test('a well-formed Supabase URL yields its ref', () => {
    assert.equal(projectRefFromUrl('https://abcdefghijklmnop.supabase.co'), 'abcdefghijklmnop')
    assert.equal(projectRefFromUrl('https://abcdefghijklmnop.supabase.co/'), 'abcdefghijklmnop')
    assert.equal(projectRefFromUrl('  https://ABCDEFGHIJKLMNOP.supabase.co  '), 'abcdefghijklmnop')
  })

  test('anything else is null, and the page fails closed on null', () => {
    for (const url of ['', 'not a url', 'http://abcdefghijklmnop.supabase.co',
                       'https://supabase.co', 'https://evil.com/abcdefgh.supabase.co',
                       'https://short.supabase.co', null, undefined, 42]) {
      assert.equal(projectRefFromUrl(url as string), null, String(url))
    }
  })

  test('it carries no key, host or path — only the ref', () => {
    const ref = projectRefFromUrl('https://abcdefghijklmnop.supabase.co')
    assert.ok(ref && !ref.includes('.') && !ref.includes('/') && !ref.includes(':'))
  })
})

// ── The executable proof ─────────────────────────────────────────────────────

describe('the behaviour is proved against a real PostgreSQL, not asserted here', () => {
  const assertions = read(ASSERTIONS)
  const shaped = read(SHAPED)
  const runner = read('supabase/tests/run_order_finance_reset_suite.sh')

  test('the suite builds a shaped database, applies the migration and asserts', () => {
    assert.ok(runner.includes('_order_finance_reset_shaped_schema.sql'))
    assert.ok(runner.includes('20261010000000_order_submission_and_finance_test_data_reset.sql'))
    assert.ok(runner.includes('order_finance_reset_assertions.sql'))
    assert.ok(runner.includes('ALL ASSERTIONS PASSED'))
    assert.ok(runner.includes('drop database'), 'and it leaves nothing behind')
  })

  test('it rolls back, so it can be run against a controlled environment safely', () => {
    assert.ok(assertions.trim().endsWith('rollback;'))
    assert.ok(assertions.includes('begin;'))
  })

  test('every section the brief asks for is covered', () => {
    for (const section of [
      'A. authorization', 'B. the gates', 'C. the census', 'D. blocking',
      'E. THE WRITE LOCK', 'F. one active reset', 'G. Finance-only', 'H. full',
      'I. storage discipline', 'J. idempotency', 'K. THE PI-DELETION RACE',
      'L. numbering', 'M. the chain protocol',
    ]) {
      assert.ok(assertions.includes(section), `${section} must be covered`)
    }
  })

  test('the shaped schema reproduces the real delete rules, not a sketch', () => {
    // If it got one wrong, the migration's own pg_constraint assertion refuses
    // itself when the suite applies it — which is what makes this fixture
    // trustworthy rather than merely convenient.
    assert.ok(shaped.includes('references public.orders(id) on delete set null'),
      'finance_payment_requests.order_id is SET NULL')
    assert.ok(shaped.includes('references public.order_submissions(id) on delete cascade'))
    assert.ok(shaped.includes('order_id       uuid    not null references public.orders(id)')
      || shaped.includes('order_id uuid not null references public.orders(id),'),
      'order_document_versions.order_id is NO ACTION')
    assert.ok(shaped.includes('THE FOREIGN KEY DELETE RULES ARE THE POINT'))
  })

  test('and it never talks to a linked project', () => {
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(!runner.includes('supabase db push'))
    assert.ok(!runner.includes('--linked'))
  })
})
