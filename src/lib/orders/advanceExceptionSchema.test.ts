/**
 * Repository check: the Phase B migration adds the advance workflow, and adds
 * nothing else.
 *
 * WHY A REPO CHECK
 * ----------------
 * Phase B's promises are mostly about ABSENCE and about ENFORCEMENT, and every
 * one of them lives in SQL where TypeScript cannot see it:
 *
 *   1. Nothing can be APPROVED. 'approved' is still reachable from no state, for
 *      every caller including the service role — the transition trigger is
 *      untouched, and approving an advance EXCEPTION leaves the PI submitted.
 *   2. No payment exists. No payment column, no Finance reference, no
 *      finance_payment_requests linkage, no proof, no receipt, no reconciliation.
 *   3. The exception authority is its OWN protected permission. Reusing
 *      orders.approve_order would have handed a money decision to everybody who
 *      can already send a PI back.
 *   4. The persisted model cannot represent a malformed state — for direct SQL
 *      and the service role too, because the rules are CHECK constraints and a
 *      trigger rather than lines in an RPC.
 *   5. Every RPC derives auth.uid(), locks the row, verifies state, and writes
 *      state plus activity atomically.
 *   6. THE APPLIED MIGRATIONS ARE NOT EDITED. Four of them are already in
 *      production; changing one changes history for a database that has run it.
 *
 * Each of those fails silently if a later edit relaxes it, so they are asserted
 * against the migration text itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/advanceExceptionSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { isProtectedAction, ACTION_DEPENDENCIES } from '../permissions/levels'
import { deriveOrdersCapabilities } from '../permissions/orders'
import { PI_ACTIVITY_LABEL } from './submissionActivity'
import { ADVANCE_STANDARD_PERCENT } from './advanceRequirement'
import { getRegisteredModules } from '../permissions/registry'
import '../permissions/modules'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')

const readMigration = (file: string) => lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))

const PHASE_B_FILE = '20260913000000_order_submission_advance_exceptions.sql'

/** The four already applied to production. None may be touched. */
const APPLIED = [
  '20260908000000_order_pi_submissions.sql',
  '20260909000000_order_submission_item_images.sql',
  '20260910000000_order_submission_phase_a_review.sql',
  '20260911000000_order_submission_employee_reply.sql',
] as const

const sql = readMigration(PHASE_B_FILE)

/**
 * The migration with `--` comments removed.
 *
 * Essential: the header prose deliberately NAMES what this phase must not do —
 * approval, numbering, payments — in order to explain why it does not do them. A
 * check reading raw text would fail on the sentences promising the very thing it
 * verifies.
 */
const code = sql.replace(/--[^\n]*/g, '')

/** Executable SQL minus `comment on … is '…';`, for the same reason. */
const statements = code.replace(/comment on [\s\S]*?is\s+'(?:[^']|'')*'\s*;/g, '')

/**
 * Everything BEFORE the final assertion block.
 *
 * The migration's own assertions legitimately name the things it must not do —
 * they are the checks that fail the apply if an approval function ever appears —
 * so a forbidden-token search has to read what the migration DECLARES.
 */
const declarations = statements.slice(0, statements.lastIndexOf('do $$'))

/** The full text of one `create or replace function public.<name>(…) … $$;` */
function functionBlock(name: string): string {
  const needle = `create or replace function public.${name}(`
  const start = code.indexOf(needle)
  assert.ok(start >= 0, `function ${name} not found in ${PHASE_B_FILE}`)
  const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))?.[0]
  assert.ok(tag, `function ${name} has no dollar-quoted body`)
  const bodyOpen = code.indexOf(tag, start)
  const bodyClose = code.indexOf(tag, bodyOpen + tag.length)
  assert.ok(bodyClose > 0, `function ${name} body is not closed`)
  return code.slice(start, bodyClose + tag.length)
}

/** One named CHECK constraint's definition, from `add constraint` to its end. */
function constraintBlock(name: string): string {
  const start = code.indexOf(`add constraint ${name}`)
  assert.ok(start >= 0, `constraint ${name} not found`)
  const next = code.indexOf('add constraint ', start + 1)
  const end = next < 0 ? code.indexOf(';', start) : Math.min(next, code.indexOf(';', start))
  return code.slice(start, end < 0 ? code.length : end)
}

const SUBMIT = functionBlock('submit_order_submission_advance_internal')
const APPROVE = functionBlock('approve_pi_advance_exception')
const REJECT = functionBlock('reject_pi_advance_exception')
const GUARD = functionBlock('order_submissions_guard_advance_exception')
const PREDICATE = functionBlock('order_submission_advance_ready')

// ── The file itself ───────────────────────────────────────────────────────────

describe('Phase B is one additive migration, correctly sequenced', () => {
  test('it sorts after every migration it builds on, and is the only one', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    for (const applied of APPLIED) {
      assert.ok(PHASE_B_FILE > applied, `it must sequence after ${applied}`)
    }
    const advanceFiles = files.filter(f => f.includes('advance_exception'))
    assert.deepEqual(advanceFiles, [PHASE_B_FILE],
      'the advance workflow is one migration, not several')
  })

  test('it claims a version no other migration claims', () => {
    // THIS IS WHY THE FILE IS NUMBERED 20260913000000 AND NOT 20260912000000.
    //
    // Phase B was originally written as 20260912000000. While it was in review,
    // main shipped 20260912000000_quotation_request_action_label.sql and took
    // that version first. Supabase keys supabase_migrations.schema_migrations on
    // the numeric prefix rather than the filename, so two files sharing one
    // version means only ONE can ever be recorded: the second is silently
    // treated as already applied and skipped, with no error and no warning.
    // Pushing the collision would have left production without a single advance
    // column while `migration list` reported the version as applied.
    //
    // The rename is the whole fix, and this is the assertion that stops it being
    // undone by a future renumber.
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'))
    const version = /^(\d+)_/.exec(PHASE_B_FILE)?.[1]
    assert.equal(version, '20260913000000')

    const sharing = files.filter(f => f.startsWith(`${version}_`))
    assert.deepEqual(sharing, [PHASE_B_FILE],
      `version ${version} must be claimed by Phase B alone`)
  })

  test('the quotation migration that took the earlier version is untouched', () => {
    // Phase B renumbered around it. It must still be there, doing its own job,
    // and Phase B must not reference or duplicate any part of it.
    const quotation = '20260912000000_quotation_request_action_label.sql'
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'))
    assert.ok(files.includes(quotation), 'the quotation migration must still exist')
    assert.ok(quotation < PHASE_B_FILE, 'and it keeps the earlier version')

    const text = lf(readFileSync(join(MIGRATIONS_DIR, quotation), 'utf8'))
    assert.ok(text.includes('manage_quotations'),
      'its own purpose is intact and was not weakened by the renumber')
    assert.ok(!sql.includes('manage_quotations'),
      'and Phase B does not reach into the quotation permission at all')
    assert.ok(!sql.includes('quotation'),
      'the two migrations stay separate concerns')
  })

  test('THE APPLIED MIGRATIONS ARE BYTE-IDENTICAL to what production ran', () => {
    // Editing an applied migration changes history for a database that has
    // already run it: the file and the schema stop agreeing, and nothing warns.
    // The hashes below were taken from the checkout at the Phase A baseline;
    // a change to any of these four files is a change to the past.
    const digests = Object.fromEntries(APPLIED.map(file => [
      file,
      createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, file))).digest('hex'),
    ]))
    assert.deepEqual(digests, {
      '20260908000000_order_pi_submissions.sql':
        '9d98be89c8dad75dc1ef737f9f2366eeaee139c70759d61c6fcd5cb674a7564c',
      '20260909000000_order_submission_item_images.sql':
        'febfc7251311eebee664a7c215454401adbce415876ffd280591c106c1edce87',
      '20260910000000_order_submission_phase_a_review.sql':
        'ecde9acc724c500c86fe7cb36bbfa370d853d512f2c07b51bdcc46feb993888d',
      '20260911000000_order_submission_employee_reply.sql':
        '865867579e2cb9132e27a6817178c51e82ce9afc4ee34a5901c7dd7fcd9f11b3',
    })
  })

  test('and none of them so much as mentions this phase', () => {
    for (const file of APPLIED) {
      const applied = readMigration(file)
      for (const token of [
        'advance_condition', 'advance_exception_status', 'approve_advance_exception',
        'approve_pi_advance_exception', 'reject_pi_advance_exception',
        'submit_order_submission_with_advance', 'order_submission_advance_ready',
      ]) {
        assert.ok(!applied.includes(token), `${file} must not mention ${token}`)
      }
      // The one column Phase B REUSES was already there, reserved for it.
      if (file === APPLIED[0]) {
        assert.ok(applied.includes('advance_exception_reason text'),
          '20260908000000 reserved the reason column and left it unwritten')
      }
    }
  })

  test('it creates no table, drops no column and drops no policy', () => {
    assert.ok(!/create table/i.test(declarations), 'Phase B adds behaviour and columns, not tables')
    assert.ok(!/drop table/i.test(declarations))
    assert.ok(!/drop column/i.test(declarations))
    assert.ok(!/drop policy/i.test(declarations))
    assert.ok(!/drop function/i.test(declarations))
    assert.ok(!/drop trigger if exists order_submissions_enforce_status_transition/i.test(declarations),
      'the status transition trigger is not touched')

    // The ONE constraint it replaces is the activity action CHECK.
    const drops = declarations.match(/drop constraint/g) ?? []
    assert.equal(drops.length, 1, 'exactly one constraint is replaced: the activity action set')
  })

  test('it alters exactly the two submission tables and nothing else', () => {
    const altered = [...declarations.matchAll(/alter table\s+public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(altered)].sort(),
      ['order_submission_activity', 'order_submissions'])
  })

  test('nothing outside the submission tables is written', () => {
    for (const table of [
      'public.orders', 'order_number_cycle', 'finance_payment', 'order_requests', 'public.users',
    ]) {
      assert.ok(!declarations.includes(`update ${table}`), `${table} must not be written`)
      assert.ok(!declarations.includes(`insert into ${table}`), `${table} must not be written`)
    }
    // The two permission-registry inserts are the only writes to another table,
    // and they register an ACTION rather than grant it to anybody.
    const inserts = [...declarations.matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(inserts)].sort(),
      ['module_permission_actions', 'permission_actions'])
  })

  test('no credential or project identifier is in the file', () => {
    assert.ok(!/postgres:\/\/|supabase\.co|service_role_key|eyJ[A-Za-z0-9]/.test(sql))
  })
})

// ── Approval remains unreachable ──────────────────────────────────────────────

describe('this phase still cannot approve a PI', () => {
  test('nothing sets the PI status to approved, anywhere', () => {
    // Anchored to the PI's OWN status column. advance_exception_status =
    // 'approved' is a different column and a legitimate, frequent phrase, so a
    // bare search for the word would fail on the very thing this phase adds.
    assert.ok(!/set status\s*=\s*'approved'/.test(code))
    assert.ok(!/(^|[^_])\bnew\.status\s*(:?=)\s*'approved'/.test(code))
    assert.ok(!/(^|[^_.])\bstatus\s*=\s*'approved'\s*,/.test(declarations),
      'no UPDATE anywhere assigns the PI status the value approved')
  })

  test('the transition trigger is not restated, so its graph cannot have moved', () => {
    assert.ok(!code.includes('create or replace function public.order_submissions_enforce_status_transition'),
      'Phase A owns that function and Phase B must not redefine it')
    assert.ok(sql.includes('the transition trigger names approved'),
      'and the migration fails its own apply if it ever does')
  })

  test('no approval, numbering, conversion or document function is defined', () => {
    for (const forbidden of [
      'approve_order_submission', 'allocate_confirmed_order_number',
      'format_confirmed_order_number', 'order_number_cycle', 'display_number',
      'next_order_display_number', 'generate_', 'pdfkit', 'pi_to_order',
    ]) {
      assert.ok(!declarations.toLowerCase().includes(forbidden.toLowerCase()),
        `${forbidden} belongs to a later phase`)
    }
    // NOT a blanket search for "xlsx": the inherited workbook validation
    // legitimately says "the stored workbook is not an .xlsx file". What must be
    // absent is document GENERATION.
    assert.ok(SUBMIT.includes('ORDER_SUBMISSION_WORKBOOK_NOT_XLSX'),
      'while the workbook type check it inherited is still there')
    assert.ok(!/create[\s\S]{0,40}(workbook|excel|pdf)/i.test(declarations),
      'nothing generates a document')
  })

  test('order_id is never written', () => {
    assert.ok(!/order_id\s*=/.test(declarations))
    assert.ok(sql.includes('where order_id is not null'),
      'and the migration refuses to apply over a linked record')
  })

  test('approving the EXCEPTION explicitly leaves the PI submitted', () => {
    assert.ok(APPROVE.includes("advance_exception_status = 'approved'"))
    assert.ok(!/\bset\b[\s\S]{0,200}\bstatus\s*=/.test(APPROVE.slice(APPROVE.indexOf('update public'))),
      'the approval UPDATE does not touch the PI status at all')
    assert.ok(APPROVE.includes("'status', 'submitted'"), 'and it answers that the PI is still submitted')
    assert.ok(GUARD.includes("approving an advance exception must leave the PI submitted"),
      'enforced by the guard for every caller, not only by the RPC')
  })

  test('the browser has no PI approval to call either', () => {
    const admin = deriveOrdersCapabilities('admin', [])
    assert.equal(admin.canApproveOrderSubmission, true, 'review authority is unchanged')
    const member = deriveOrdersCapabilities('member', [{ actionKey: 'view', allowed: true, source: 'role' }])
    assert.equal(member.canApproveOrderSubmission, false)
  })
})

// ── The payment boundary ──────────────────────────────────────────────────────

describe('nothing about payment is created, referenced or implied', () => {
  test('no payment structure is named in anything the migration EXECUTES', () => {
    // Read from `declarations` rather than from `sql`: the header prose
    // deliberately NAMES what this phase must not touch — "no
    // finance_payment_requests reference", "no reconciliation" — in order to
    // state the boundary. A check reading the raw text would fail on the
    // sentences promising the very thing it verifies.
    for (const forbidden of [
      'finance_payment_requests', 'finance_payments', 'payment_request', 'payment_target',
      'payment_proof', 'payment_received', 'payment_status', 'payment_allocation',
      'reconcil', 'add_payment', 'collect_payment', 'receipt',
    ]) {
      assert.ok(!declarations.toLowerCase().includes(forbidden.toLowerCase()),
        `${forbidden} is out of scope for this phase`)
    }
    // And the boundary IS stated, in the prose, so a later reader knows it was
    // a decision rather than an oversight.
    assert.ok(/THIS RECORDS A COMMERCIAL CONDITION\. IT IS NOT A PAYMENT\./.test(sql))
  })

  test('no payment column is added to the submission table', () => {
    const added = [...code.matchAll(/add column (\w+)/g)].map(m => m[1])
    assert.ok(added.length > 0)
    for (const column of added) {
      for (const forbidden of ['payment', 'paid', 'received', 'receipt', 'proof', 'settled']) {
        assert.ok(!column.includes(forbidden), `${column} names a payment concept`)
      }
    }
    // And the migration asserts the same thing at apply time.
    assert.ok(sql.includes('order_submissions gained payment columns'))
  })

  test('the stored model records a REQUIREMENT, not money', () => {
    const added = [...code.matchAll(/add column (\w+)/g)].map(m => m[1])
    assert.deepEqual(added.sort(), [
      'advance_condition',
      'advance_exception_decided_at',
      'advance_exception_decided_by',
      'advance_exception_percent',
      'advance_exception_rejection_reason',
      'advance_exception_requested_at',
      'advance_exception_requested_by',
      'advance_exception_status',
    ])
  })

  test('the rupee amount is DERIVED and never stored', () => {
    assert.ok(!/add column \w*amount/.test(code), 'no amount column is added')
    assert.ok(code.includes('create or replace function public.order_submission_advance_amount('),
      'the figure comes from a function over grand_total and the percentage')
    assert.ok(sql.includes('The RUPEE FIGURE IS NOT STORED'))
    assert.ok(sql.includes('there would be no way to tell which one the business meant'))
  })
})

// ── The persisted model ───────────────────────────────────────────────────────

describe('a malformed advance state is not representable', () => {
  test('the percentage is plain numeric, so precision is refused not rounded', () => {
    assert.ok(code.includes('add column advance_exception_percent          numeric,'))
    assert.ok(!/advance_exception_percent\s+numeric\(/.test(code),
      'a fixed scale would silently round a figure nobody typed')
    assert.ok(sql.includes('advance_exception_percent has a fixed scale'),
      'and the migration fails its own apply if that ever changes')
  })

  test('the range and the precision are both CHECK constraints', () => {
    const check = constraintBlock('order_submissions_advance_exception_percent_valid')
    assert.ok(check.includes('advance_exception_percent >= 0'), '0% is legitimate')
    assert.ok(check.includes(`advance_exception_percent < ${ADVANCE_STANDARD_PERCENT}`),
      'the standard itself is not an exception')
    assert.ok(check.includes('advance_exception_percent = round(advance_exception_percent, 2)'),
      'two decimal places, refused rather than rounded')
    assert.ok(check.includes("advance_exception_percent <> 'NaN'::numeric"))
  })

  test('standard and undeclared records may carry no exception data', () => {
    const check = constraintBlock('order_submissions_advance_exception_fields_need_exception')
    // `is not distinct from`, not `=`: a NULL condition makes `=` evaluate to
    // NULL, and a CHECK passes on NULL. That is the hole this spelling closes.
    assert.ok(check.includes("advance_condition is not distinct from 'exception'"),
      'an undeclared record must not be free to carry a full exception')
    for (const column of [
      'advance_exception_percent', 'advance_exception_reason', 'advance_exception_status',
      'advance_exception_requested_by', 'advance_exception_requested_at',
      'advance_exception_decided_by', 'advance_exception_decided_at',
      'advance_exception_rejection_reason',
    ]) {
      assert.ok(check.includes(`${column} is null`), `${column} must be forbidden`)
    }
  })

  test('an exception is never half-written', () => {
    const check = constraintBlock('order_submissions_advance_exception_is_complete')
    for (const required of [
      'advance_exception_percent is not null',
      'advance_exception_reason is not null',
      "btrim(advance_exception_reason) <> ''",
      'advance_exception_status is not null',
      'advance_exception_requested_by is not null',
      'advance_exception_requested_at is not null',
    ]) {
      assert.ok(check.includes(required), `${required} must be required`)
    }
  })

  test('each decision state is complete and exclusive', () => {
    const check = constraintBlock('order_submissions_advance_decision_consistency')
    // pending: no decision at all
    assert.ok(check.includes("advance_exception_status = 'pending'\n        and advance_exception_decided_by is null"))
    // approved: an actor and a time, and no rejection reason
    assert.ok(check.includes("advance_exception_status = 'approved'\n        and advance_exception_decided_by is not null"))
    assert.ok(/'approved'[\s\S]{0,220}advance_exception_rejection_reason is null/.test(check))
    // rejected: an actor, a time and a non-blank reason
    assert.ok(/'rejected'[\s\S]{0,320}btrim\(advance_exception_rejection_reason\) <> ''/.test(check))
  })

  test('a declaration against an unknown grand total is refused', () => {
    const check = constraintBlock('order_submissions_advance_needs_grand_total')
    assert.ok(check.includes('advance_condition is null or grand_total is not null'),
      'fail closed: a percentage of an unknown is not a figure')
  })

  test('only the two known conditions and three known statuses exist', () => {
    assert.ok(constraintBlock('order_submissions_advance_condition_known')
      .includes("advance_condition in ('standard', 'exception')"))
    assert.ok(constraintBlock('order_submissions_advance_exception_status_known')
      .includes("advance_exception_status in ('pending', 'approved', 'rejected')"))
  })

  test('every constraint is asserted present AND validated at apply time', () => {
    assert.ok(sql.includes('c.convalidated'),
      'a NOT VALID constraint would look enforced and not be')
    assert.ok(sql.includes('these advance constraints are missing or unvalidated'))
  })
})

// ── The guard ─────────────────────────────────────────────────────────────────

describe('the guard says WHEN the state may move, for every caller', () => {
  test('it fires on INSERT as well as UPDATE', () => {
    // Guarding only UPDATE would leave a row creatable WITH a decided exception
    // by anything holding an INSERT privilege — which is the service role, and
    // the service role bypasses RLS.
    assert.ok(code.includes('before insert or update on public.order_submissions'))
    assert.ok(GUARD.includes("if tg_op = 'INSERT' then"))
    assert.ok(GUARD.includes('a submission is created with no advance declaration'))
    assert.ok(sql.includes('the advance guard is not attached for both INSERT and UPDATE'))
  })

  test('the declaration is written only by submitting', () => {
    assert.ok(GUARD.includes('new.advance_condition is distinct from old.advance_condition'))
    assert.ok(GUARD.includes("not (new.status = 'submitted' and old.status in ('draft', 'needs_changes'))"))
  })

  test('a decision is possible only on a PENDING request on a SUBMITTED PI', () => {
    assert.ok(GUARD.includes("old.advance_exception_status is distinct from 'pending'"))
    assert.ok(GUARD.includes("old.status <> 'submitted'"))
    assert.ok(GUARD.includes('ORDER_SUBMISSION_ADVANCE_NOT_PENDING'),
      'so a double click and a stale decision both fail safely')
  })

  test('a rejection must return the PI, and an approval must not', () => {
    assert.ok(GUARD.includes("new.advance_exception_status = 'rejected' and new.status <> 'needs_changes'"))
    assert.ok(GUARD.includes("new.advance_exception_status = 'approved' and new.status <> 'submitted'"))
  })

  test('the exception clears only by resubmitting under the standard', () => {
    assert.ok(GUARD.includes("new.advance_condition is distinct from 'standard' or new.status <> 'submitted'"))
  })

  test('it sorts AFTER the status transition trigger, so the status is already legal', () => {
    // Triggers of the same timing fire in NAME order.
    const names = [
      'order_submissions_enforce_status_transition',
      'order_submissions_guard_advance_exception',
      'order_submissions_guard_frozen_columns',
      'order_submissions_set_updated_at',
    ]
    assert.deepEqual([...names].sort(), names, 'the intended firing order is the alphabetical one')
    assert.ok(sql.includes('Expected 4 triggers on order_submissions, found'),
      'and the migration counts them at apply time')
  })

  test('it is executable by no role', () => {
    assert.ok(code.includes(
      'revoke execute on function public.order_submissions_guard_advance_exception()\n  from public, anon, authenticated, service_role;'))
  })
})

// ── The Phase C predicate ─────────────────────────────────────────────────────

describe('the advance-ready rule is a reusable server-side predicate', () => {
  test('it is exactly the two cases, and nothing is undefined', () => {
    assert.ok(PREDICATE.includes("p_advance_condition = 'standard'"))
    assert.ok(PREDICATE.includes("p_advance_condition = 'exception'"))
    assert.ok(PREDICATE.includes("p_advance_exception_status = 'approved'"))
    assert.ok(PREDICATE.includes('p_advance_percent >= 0'))
    assert.ok(PREDICATE.includes('p_advance_percent < public.order_submission_standard_advance_percent()'),
      'bounded by the standard rule itself, so the two cannot drift')
    assert.ok(PREDICATE.includes('coalesce('),
      'a NULL answer to "is this ready?" must read as no')
  })

  test('every case is proven at apply time rather than promised', () => {
    for (const proof of [
      'the standard requirement must be advance-ready',
      'an approved zero-percent exception must be advance-ready',
      'a % exception must NOT be advance-ready',
      'an undeclared condition must NOT be advance-ready',
      'an exception at the standard is not an exception and must NOT be advance-ready',
      'a negative exception must NOT be advance-ready',
      'a NaN exception must NOT be advance-ready',
      'an undecided exception must NOT be advance-ready',
    ]) {
      assert.ok(sql.includes(proof), `the migration must prove: ${proof}`)
    }
  })

  test('it authorises nothing and there is no RPC that acts on it', () => {
    assert.ok(!/approve[\w_]*\s*\([^)]*\)[\s\S]{0,200}order_submission_advance_ready/.test(code))
    assert.ok(sql.includes('It grants nothing'))
    assert.ok(!declarations.includes('advance_ready'.concat('_and_approve')))
  })

  test('the by-id helper is visibility-gated, and says why that is not the rule', () => {
    const byId = functionBlock('order_submission_is_advance_ready')
    assert.ok(byId.includes('public.can_view_order_submission(s.id)'),
      'it must not reveal anything about a record the caller cannot read')
    assert.ok(sql.includes('THIS IS THE READING ROUTE, NOT THE DECIDING ROUTE'),
      'so a future approval path is told to consult the pure rule instead')
  })
})

// ── The RPCs ──────────────────────────────────────────────────────────────────

describe('every write path is written the way the applied ones are', () => {
  const RPCS: [string, string][] = [
    ['submit_order_submission_advance_internal', SUBMIT],
    ['approve_pi_advance_exception', APPROVE],
    ['reject_pi_advance_exception', REJECT],
  ]

  for (const [name, body] of RPCS) {
    test(`${name}: SECURITY DEFINER with a pinned search_path`, () => {
      assert.ok(body.includes('security definer'))
      assert.ok(body.includes('set search_path = public, pg_temp'))
    })

    test(`${name}: derives its actor from auth.uid(), never from an argument`, () => {
      assert.ok(body.includes('public.assert_order_submission_actor()'))
      assert.ok(!/p_actor|p_user_id/.test(body), 'no caller-supplied identity')
    })

    test(`${name}: locks the submission row BEFORE it judges the state`, () => {
      const lock = body.indexOf('for update')
      assert.ok(lock > 0, 'the row is locked')
      const judged = body.indexOf('if not found')
      assert.ok(judged > lock, 'and every state check happens after the lock')
    })

    test(`${name}: records what it did in the append-only trail`, () => {
      assert.ok(body.includes('public.log_order_submission_activity('))
    })
  }

  test('the two decisions require the NEW permission and refuse the old one', () => {
    for (const [name, body] of [['approve', APPROVE], ['reject', REJECT]] as const) {
      assert.ok(body.includes("public.actor_has_module_permission('orders', 'approve_advance_exception')"),
        `${name} must require the exception permission`)
      assert.ok(!body.includes("'approve_order'"),
        `${name} must not accept orders.approve_order as the authority for a financial exception`)
    }
  })

  test('an exception may be requested only by the OWNER', () => {
    // can_edit_order_submission admits an active admin too, which is right for
    // correcting a record and wrong for asking the business a commercial
    // question in somebody else's name.
    assert.ok(SUBMIT.includes('v_sub.created_by = v_actor or v_sub.submitted_by = v_actor'))
    assert.ok(SUBMIT.includes('ORDER_SUBMISSION_ADVANCE_NOT_OWNER'))
    assert.ok(/v_condition = 'exception'\s*\n\s*and not \(v_sub\.created_by/.test(SUBMIT),
      'and the ownership rule applies to the EXCEPTION, not to the stricter standard choice')
  })

  test('the submission path validates every numeric rule the constraint does', () => {
    for (const rule of [
      "v_percent = 'NaN'::numeric",
      'v_percent < 0 or v_percent >= v_standard',
      'v_percent <> round(v_percent, 2)',
      'ORDER_SUBMISSION_ADVANCE_REASON_REQUIRED',
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING',
      'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID',
    ]) {
      assert.ok(SUBMIT.includes(rule), `the submission path must enforce: ${rule}`)
    }
    assert.ok(SUBMIT.includes('nullif(btrim(coalesce(p_advance_reason'),
      'and a whitespace reason is no reason')
  })

  test('the rejection is ONE atomic write: the decision and the return together', () => {
    const update = REJECT.slice(REJECT.indexOf('update public.order_submissions'))
    for (const field of [
      "advance_exception_status = 'rejected'",
      'advance_exception_decided_by = v_actor',
      'advance_exception_decided_at = now()',
      'advance_exception_rejection_reason = v_reason',
      "status = 'needs_changes'",
      'review_note = v_reason',
    ]) {
      assert.ok(update.includes(field), `${field} must land in the same statement`)
    }
    assert.equal((REJECT.match(/update public\.order_submissions/g) ?? []).length, 1,
      'one statement, so no half of it can be committed alone')
  })

  test('the rejection reason becomes the visible correction instruction', () => {
    assert.ok(REJECT.includes('review_note = v_reason'))
    assert.ok(REJECT.includes('ORDER_SUBMISSION_ADVANCE_DECISION_REASON_REQUIRED'))
  })

  test('the PI itself is NOT rejected when its advance is refused', () => {
    // advance_exception_status = 'rejected' is the point of the function. What
    // must be absent is any write to the PI's OWN rejection columns or status.
    const update = REJECT.slice(REJECT.indexOf('update public.order_submissions'))
    assert.ok(!/(^|[^_])\bstatus\s*=\s*'rejected'/.test(update),
      'the PI status is set to needs_changes, never to rejected')
    assert.ok(!update.includes('rejected_by'))
    assert.ok(!update.includes('rejected_at'))
    assert.ok(update.includes("status = 'needs_changes'"))
  })

  test('selecting the standard clears the whole actionable exception state', () => {
    const standard = SUBMIT.slice(SUBMIT.indexOf("elsif v_condition = 'standard'"))
    for (const cleared of [
      'advance_exception_percent = null', 'advance_exception_reason = null',
      'advance_exception_status = null', 'advance_exception_requested_by = null',
      'advance_exception_requested_at = null', 'advance_exception_decided_by = null',
      'advance_exception_decided_at = null', 'advance_exception_rejection_reason = null',
    ]) {
      assert.ok(standard.includes(cleared), `${cleared} must be cleared`)
    }
    assert.ok(sql.includes('nothing there is deleted or rewritten'),
      'while the permanent record of what was asked stays in the trail')
  })

  test('a revised exception becomes a FRESH pending request', () => {
    assert.ok(SUBMIT.includes("advance_exception_status = 'pending'"))
    assert.ok(SUBMIT.includes('advance_exception_requested_by = v_actor'))
    assert.ok(SUBMIT.includes('advance_exception_requested_at = now()'))
    // …with the earlier decision cleared, so nothing carries over.
    const fresh = SUBMIT.slice(SUBMIT.indexOf("advance_exception_status = 'pending'"))
    assert.ok(fresh.includes('advance_exception_decided_by = null'))
    assert.ok(fresh.includes('advance_exception_decided_at = null'))
    assert.ok(fresh.includes('advance_exception_rejection_reason = null'))
  })

  test('an unchanged approved exception survives, and any change does not', () => {
    assert.ok(SUBMIT.includes("v_sub.advance_exception_status = 'approved'"))
    assert.ok(SUBMIT.includes('v_sub.advance_exception_percent = v_percent'))
    assert.ok(SUBMIT.includes('v_sub.advance_exception_reason is not distinct from v_reason'))
  })
})

describe('the Phase A doors are preserved exactly', () => {
  test('neither public submit RPC is redefined', () => {
    assert.ok(!code.includes('create or replace function public.submit_order_submission('))
    assert.ok(!code.includes('create or replace function public.submit_order_submission_with_note('))
  })

  test('the internal delegate keeps its exact signature', () => {
    const internal = functionBlock('submit_order_submission_internal')
    assert.ok(internal.includes('p_submission_id uuid'))
    assert.ok(internal.includes('p_note          text'))
    assert.ok(internal.includes('public.submit_order_submission_advance_internal(\n    p_submission_id, p_note, false, null, null, null)'),
      'so an old caller declares nothing and changes nothing about the advance')
    assert.ok(sql.includes('submit_order_submission_internal(uuid, text) changed shape'),
      'and the migration fails its own apply if it ever does')
  })

  test('declaring nothing leaves the declaration exactly as it was', () => {
    const plain = SUBMIT.slice(SUBMIT.indexOf('if not p_declare_advance then'))
    const firstUpdate = plain.slice(0, plain.indexOf('elsif'))
    assert.ok(!firstUpdate.includes('advance_'),
      'the no-declaration path writes no advance column at all')
  })

  test('the return shape is unchanged, so an existing caller still parses it', () => {
    assert.ok(SUBMIT.includes("jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count)"))
  })

  test('no name is overloaded, which PostgREST would resolve by argument keys', () => {
    assert.ok(sql.includes('is overloaded (% variants); PostgREST would resolve it by argument names'))
    for (const name of [
      'submit_order_submission', 'submit_order_submission_with_note',
      'submit_order_submission_with_advance', 'approve_pi_advance_exception',
      'reject_pi_advance_exception',
    ]) {
      assert.ok(sql.includes(`'${name}'`), `${name} must be in the overload check`)
    }
  })
})

// ── Privileges ────────────────────────────────────────────────────────────────

describe('privileges: three doors out, and nothing else reachable', () => {
  test('the implementation is executable by NO role', () => {
    assert.ok(code.includes(
      'revoke execute on function public.submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text)\n  from public, anon, authenticated, service_role;'))
    assert.ok(code.includes(
      'revoke execute on function public.submit_order_submission_internal(uuid, text)\n  from public, anon, authenticated, service_role;'))
  })

  test('every client-callable function is revoked from public and anon first', () => {
    for (const [name, args] of [
      ['submit_order_submission_with_advance', '(uuid, text, text, numeric, text)'],
      ['approve_pi_advance_exception', '(uuid)'],
      ['reject_pi_advance_exception', '(uuid, text)'],
      ['order_submission_is_advance_ready', '(uuid)'],
      ['order_submission_advance_ready', '(text, numeric, text)'],
      ['order_submission_advance_amount', '(numeric, numeric)'],
      ['order_submission_standard_advance_percent', '()'],
    ] as const) {
      assert.ok(code.includes(`revoke execute on function public.${name}${args}`),
        `${name} must be revoked from public and anon`)
      assert.ok(code.includes(`grant  execute on function public.${name}${args}`)
        || code.includes(`grant  execute on function public.${name}${args}\n  to authenticated`),
        `${name} must be granted to authenticated`)
    }
  })

  test('no client role gains a table write', () => {
    assert.ok(!/grant[^;]*(insert|update|delete)[^;]*(anon|authenticated)/i.test(declarations))
    assert.ok(sql.includes('client roles hold write privileges'),
      'and the migration asserts nothing was re-opened')
  })

  test('history stays append-only and its logger reaches no role', () => {
    assert.ok(sql.includes('order_submission_activity has write policies'))
    assert.ok(sql.includes('log_order_submission_activity is executable by a role'))
    assert.ok(!code.includes('create policy'), 'no new policy is added to any table')
  })

  test('RLS and the module entry gates are re-asserted, not weakened', () => {
    assert.ok(sql.includes('RLS is not enabled on'))
    assert.ok(sql.includes('expected 4 restrictive module entry gates'))
    assert.ok(!/alter table[^;]*disable row level security/i.test(code))
  })
})

// ── The permission ────────────────────────────────────────────────────────────

describe('orders.approve_advance_exception is its own protected authority', () => {
  test('it is registered deny-by-default against the Orders module', () => {
    assert.ok(code.includes("values ('approve_advance_exception', 'Approve Advance Exceptions', false)"))
    assert.ok(code.includes('select pm.id, pa.id, false'), 'default_allowed = false')
    assert.ok(sql.includes('orders.approve_advance_exception is not registered as deny-by-default'))
  })

  test('the migration grants it to nobody, and refuses to apply if a role holds it', () => {
    assert.ok(!/insert into public\.role_permissions/i.test(code))
    assert.ok(!/insert into public\.employee_permission_overrides/i.test(code))
    assert.ok(sql.includes('it is granted per person or not at all'))
  })

  test('the TypeScript registry declares the same action on the same module', () => {
    const orders = getRegisteredModules().find(m => m.moduleKey === 'orders')
    assert.ok(orders, 'the Orders module must be registered')
    const action = orders.actions.find(a => a.actionKey === 'approve_advance_exception')
    assert.ok(action, 'the action must be registered in code as well as in SQL')
    assert.equal(action.displayName, 'Approve Advance Exceptions',
      'and with the same display name the migration inserts')
  })

  test('it is PROTECTED, so no preset can reach it', () => {
    assert.equal(isProtectedAction('approve_advance_exception'), true)
  })

  test('it depends on module entry, and NOT on approve_order', () => {
    assert.equal(ACTION_DEPENDENCIES['approve_advance_exception'], 'view',
      'the existing module-parent gating convention still applies')
    assert.notEqual(ACTION_DEPENDENCIES['approve_advance_exception'], 'approve_order',
      'the two authorities are independent in both directions')
  })

  test('orders.approve_order alone confers no exception authority', () => {
    const reviewer = deriveOrdersCapabilities('member', [
      { actionKey: 'view', allowed: true, source: 'role' },
      { actionKey: 'approve_order', allowed: true, source: 'employee_override' },
    ])
    assert.equal(reviewer.canApproveOrderSubmission, true)
    assert.equal(reviewer.canApproveAdvanceException, false)
  })

  test('and the exception authority confers nothing else', () => {
    const approver = deriveOrdersCapabilities('member', [
      { actionKey: 'view', allowed: true, source: 'role' },
      { actionKey: 'approve_advance_exception', allowed: true, source: 'employee_override' },
    ])
    assert.equal(approver.canApproveAdvanceException, true)
    for (const [name, value] of Object.entries(approver)) {
      if (name === 'canApproveAdvanceException' || name === 'canAccessOrdersModule') continue
      assert.equal(value, false, `${name} must not come with the exception permission`)
    }
  })
})

// ── The activity trail ────────────────────────────────────────────────────────

describe('the closed activity action set grows by exactly three', () => {
  const start = code.indexOf('add constraint order_submission_activity_action_check')
  const constraint = code.slice(start, code.indexOf(';', start))

  test('the eight actions are the whole set', () => {
    for (const action of [
      'submission_created', 'parse_replaced', 'submitted', 'changes_requested', 'rejected',
      'advance_exception_requested', 'advance_exception_approved', 'advance_exception_rejected',
    ]) {
      assert.ok(constraint.includes(`'${action}'`), `${action} must be admitted`)
    }
    const admitted = [...constraint.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.equal(admitted.length, 8, 'eight and no more')
    assert.equal(Object.keys(PI_ACTIVITY_LABEL).length, 8,
      'and the screen has words for each of them')
  })

  test('nothing about approval, numbering or payment is admitted', () => {
    for (const forbidden of ['order_number', 'payment', 'order_created', 'advance_recorded']) {
      assert.ok(!constraint.includes(forbidden), `${forbidden} belongs to a later phase`)
    }
    // 'approved' appears only inside 'advance_exception_approved'.
    assert.ok(!/'approved'/.test(constraint), 'no bare approved action')
  })

  test('the old constraint is located by its definition, not by an assumed name', () => {
    assert.ok(code.includes("pg_get_constraintdef(c.oid) like '%changes_requested%'"))
    assert.ok(code.includes('the order_submission_activity action constraint was not found'),
      'and the migration fails loudly rather than silently skipping the drop')
  })

  test('ONE event for one management action on a rejection', () => {
    assert.ok(REJECT.includes("'advance_exception_rejected', 'submitted', 'needs_changes'"),
      'the single event carries the whole outcome')
    assert.ok(!REJECT.includes("'changes_requested'"),
      'no duplicate entry beside it for the same click')
    assert.equal((REJECT.match(/log_order_submission_activity/g) ?? []).length, 1)
  })

  test('the standard choice adds no action of its own', () => {
    assert.ok(!code.includes("'advance_standard_selected'"))
    assert.ok(sql.includes('a fourth action would be noise'))
    // It is recorded by the submitted event's safe metadata instead.
    assert.ok(SUBMIT.includes("'advance_condition', v_condition"))
  })

  test('every advance event records the percentage and the calculation inputs', () => {
    for (const body of [SUBMIT, APPROVE, REJECT]) {
      assert.ok(body.includes("'advance_percent'"))
      assert.ok(body.includes("'standard_percent'"))
      assert.ok(body.includes("'grand_total'"))
      assert.ok(body.includes("'advance_amount'"))
    }
    assert.ok(APPROVE.includes("'exception_status',  'approved'"))
    assert.ok(REJECT.includes("'exception_status',  'rejected'"))
  })
})
