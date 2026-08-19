/**
 * Repository check: the advance is declared as an AMOUNT, and nothing applied
 * moves to make that true.
 *
 * WHY A REPO CHECK
 * ----------------
 * Every promise this change makes lives in SQL, where TypeScript cannot see it:
 *
 *   1. CLASSIFICATION IS THE AMOUNT, never a rounded percentage. A figure a
 *      paisa short of 40% is an exception, whatever it displays as.
 *   2. THE PERCENTAGE IS TRUNCATED, never rounded up, so a stored or displayed
 *      figure can never claim the requirement is met by an amount that does not
 *      meet it — and can never breach the applied `< 40` constraint.
 *   3. AN AMOUNT AND ITS GRAND TOTAL CANNOT DISAGREE. Replacing the total clears
 *      the amount, for every caller, by trigger rather than by convention.
 *   4. NO PAYMENT EXISTS. No payment column, no Finance reference, no receipt,
 *      no verification of receipt, no allocation, no reconciliation.
 *   5. THE APPLIED DOORS DO NOT CHANGE. Three RPCs and two internals keep their
 *      exact names, signatures and behaviour, and Phase C's applied approval
 *      function is not restated.
 *   6. THE APPLIED MIGRATIONS ARE NOT EDITED. Seven of them are already in
 *      production; changing one changes history for a database that has run it.
 *
 * Each of those fails silently if a later edit relaxes it, so they are asserted
 * against the migration text itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/advanceAmountSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  ADVANCE_STANDARD_PERCENT,
  ADVANCE_AMOUNT_MAX_DECIMALS,
  PI_ADVANCE_COLUMNS,
  standardAdvanceAmount,
  derivedAdvancePercent,
} from './advanceRequirement'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const readMigration = (file: string) => lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))

const FILE = '20260917000000_order_submission_advance_amount.sql'
const PHASE_B = '20260913000000_order_submission_advance_exceptions.sql'
const PHASE_C = '20260915000000_order_submission_final_approval.sql'

/** Everything already run against production. None may be touched. */
const APPLIED = [
  '20260908000000_order_pi_submissions.sql',
  '20260909000000_order_submission_item_images.sql',
  '20260910000000_order_submission_phase_a_review.sql',
  '20260911000000_order_submission_employee_reply.sql',
  PHASE_B,
  '20260914000000_order_submission_permanent_deletion.sql',
  PHASE_C,
] as const

const sql = readMigration(FILE)

/**
 * The migration with `--` comments removed.
 *
 * Essential: the header prose deliberately NAMES what this change must not do —
 * payments, verification, linking — in order to explain why it does not do them.
 * A check reading raw text would fail on the sentences promising the very thing
 * it verifies.
 */
const code = sql.replace(/--[^\n]*/g, '')

/** Executable SQL minus `comment on … is '…';`, for the same reason. */
const statements = code.replace(/comment on [\s\S]*?is\s+'(?:[^']|'')*'\s*;/g, '')

/** One function's body, so an assertion about it cannot be satisfied by another. */
function body(name: string): string {
  const start = statements.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `${name} is not defined in ${FILE}`)
  const open = statements.indexOf('as $$', start)
  const close = statements.indexOf('$$;', open)
  assert.ok(open >= 0 && close > open, `${name} has no readable body`)
  return statements.slice(open, close)
}

// ── The file ──────────────────────────────────────────────────────────────────

describe('the amount declaration is one new forward migration', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

  test('it exists and sorts after everything it builds on', () => {
    assert.ok(files.includes(FILE))
    for (const earlier of APPLIED) {
      assert.ok(files.includes(earlier), `${earlier} is missing`)
      assert.ok(FILE > earlier, `${FILE} must sort after ${earlier}`)
    }
  })

  test('it is one file, and this change adds no other', () => {
    assert.deepEqual(files.filter(f => f.includes('advance_amount')), [FILE])
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
})

describe('every applied migration is unchanged', () => {
  test('THE APPLIED MIGRATIONS ARE BYTE-IDENTICAL to what production ran', () => {
    // Editing an applied migration changes history for a database that has
    // already run it: the file and the schema stop agreeing, and nothing warns.
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
      '20260913000000_order_submission_advance_exceptions.sql':
        '4218edf84abef63bd6ec970c6caa7b7c59982176bc82997e8bb7cc1b286fe050',
      '20260914000000_order_submission_permanent_deletion.sql':
        '293b395644e8e9384b75d9b6b727eeb3acae55978edfe1e59a72394763bdd584',
      '20260915000000_order_submission_final_approval.sql':
        'b8f1c254c0cec98a228a355d77889687b5b8e61f640ad3f2ac898fd75828eca9',
    })
  })

  test('and none of them mentions the declared amount', () => {
    for (const file of APPLIED) {
      assert.ok(!readMigration(file).includes('advance_declared_amount'),
        `${file} must not mention a column that did not exist when it ran`)
    }
  })

  test('it adds one column and creates no table', () => {
    assert.ok(statements.includes('add column advance_declared_amount numeric'))
    assert.ok(!/create table/i.test(statements), 'this adds behaviour and one column, not tables')
    assert.ok(!/drop table|drop column|drop policy|drop function/i.test(statements))
  })

  test('the column is PLAIN numeric, so excess precision is refused not rounded', () => {
    // numeric(12,2) would silently store ₹1,250.01 for a typed ₹1,250.005 — a
    // figure the employee never declared. Plain numeric plus a scale CHECK
    // REFUSES it, for every caller including direct SQL and the service role.
    assert.ok(!/advance_declared_amount numeric\s*\(/.test(statements))
    assert.ok(statements.includes('advance_declared_amount = round(advance_declared_amount, 2)'))
    assert.equal(ADVANCE_AMOUNT_MAX_DECIMALS, 2)
  })
})

// ── The rules that live in the table ─────────────────────────────────────────

describe('the persisted model cannot represent a contradiction', () => {
  const constraint = (name: string): string => {
    const at = statements.indexOf(`add constraint ${name} check (`)
    assert.ok(at >= 0, `${name} is not added by this migration`)
    const rest = statements.slice(at)
    const end = Math.min(
      ...[rest.indexOf('\n  ),'), rest.indexOf('\n  );')].filter(i => i >= 0))
    return rest.slice(0, end)
  }

  test('the classification compares the AMOUNT with 40% of the grand total', () => {
    const check = constraint('order_submissions_advance_amount_matches_condition')
    assert.ok(check.includes("advance_condition = 'standard'"))
    assert.ok(check.includes("advance_condition = 'exception'"))
    // EXACT arithmetic on the total, and NOT a comparison against a percentage
    // column that has been rounded for display.
    assert.ok(check.includes('advance_declared_amount >= grand_total * 40 / 100'))
    assert.ok(check.includes('advance_declared_amount <  grand_total * 40 / 100'))
    assert.ok(!check.includes('advance_exception_percent'),
      'classification must not read a rounded percentage')
  })

  test('the duplicated 40 is asserted equal to the configured rule', () => {
    // A CHECK is not re-validated when a function it calls is replaced, so the
    // literal is written out — and the migration fails if the two disagree.
    assert.ok(statements.includes('public.order_submission_standard_advance_percent() <> 40'))
    assert.equal(ADVANCE_STANDARD_PERCENT, 40)
  })

  test('an amount cannot exceed the order, be negative, or be NaN', () => {
    assert.ok(constraint('order_submissions_advance_amount_within_total')
      .includes('advance_declared_amount <= grand_total'))
    const valid = constraint('order_submissions_advance_amount_valid')
    assert.ok(valid.includes("advance_declared_amount <> 'NaN'::numeric"))
    assert.ok(valid.includes('advance_declared_amount >= 0'))
  })

  test('an amount cannot exist without a declaration and a total to measure it', () => {
    const check = constraint('order_submissions_advance_amount_needs_declaration')
    assert.ok(check.includes('advance_condition is not null'))
    assert.ok(check.includes('grand_total is not null'))
  })

  test('₹0 implies 0%, and the converse is deliberately NOT asserted', () => {
    // ₹5 against a ₹10,00,000 total is 0.0005%, which truncates to 0.00 and is a
    // real positive advance all the same. Asserting the converse would refuse it.
    const check = constraint('order_submissions_advance_amount_zero_is_zero_percent')
    assert.ok(check.includes('advance_declared_amount <> 0'))
    assert.ok(check.includes('advance_exception_percent = 0'))
    assert.equal(derivedAdvancePercent(1000000, 5), 0, 'the case the one-way rule exists for')
  })

  test('a replaced grand total clears the amount, by trigger and not by convention', () => {
    // 20260913000000 stored no rupee figure precisely because it "could disagree
    // with the total it came from". The business now needs the amount first, so
    // the disagreement is PREVENTED rather than avoided.
    const trigger = body('order_submissions_advance_amount_follows_total')
    assert.ok(trigger.includes('new.grand_total is distinct from old.grand_total'))
    assert.ok(trigger.includes('new.advance_declared_amount := null'))
    assert.ok(trigger.includes(
      'new.advance_declared_amount is not distinct from old.advance_declared_amount'),
      'a statement writing a new amount against a new total is coherent and is left alone')
    assert.ok(statements.includes('before update on public.order_submissions'))
    assert.ok(statements.includes(
      'create trigger order_submissions_advance_amount_follows_total'))
  })

  test('replace_order_submission_parse is NOT restated to achieve that', () => {
    assert.ok(!statements.includes('replace_order_submission_parse'),
      'a BEFORE ROW trigger runs before the CHECKs, so the only writer of grand_total is untouched')
  })
})

// ── The three derivations ────────────────────────────────────────────────────

describe('the browser mirrors the database, function for function', () => {
  test('the threshold is the CEILING of 40%, in both', () => {
    assert.ok(body('order_submission_standard_advance_amount')
      .includes('ceil(p_grand_total * 40) / 100'))
    // 40% of ₹100.01 is ₹40.004 — not a payable figure. Rounding gives ₹40.00,
    // BELOW the requirement, which the constraint above would then refuse.
    assert.equal(standardAdvanceAmount(100.01), 40.01)
    assert.equal(standardAdvanceAmount(2537000), 1014800)
  })

  test('the percentage is TRUNCATED to two places, in both', () => {
    assert.ok(body('order_submission_advance_percent_of')
      .includes('trunc(p_amount * 100 / p_grand_total, 2)'))
    assert.ok(!body('order_submission_advance_percent_of').includes('round(p_amount'),
      'rounding could report 40.00 for an amount below the requirement')
    assert.equal(derivedAdvancePercent(100000, 39999.99), 39.99)
    assert.ok(derivedAdvancePercent(100000, 39999.99)! < ADVANCE_STANDARD_PERCENT)
  })

  test('a percentage of an absent or non-positive total is NULL, not zero', () => {
    const fn = body('order_submission_advance_percent_of')
    assert.ok(fn.includes('p_grand_total <= 0 then null'))
    assert.equal(derivedAdvancePercent(0, 0), null)
  })

  test('a record with no stored amount still means what it always meant', () => {
    const fn = body('order_submission_effective_advance_amount')
    assert.ok(fn.includes('p_advance_declared_amount is not null then p_advance_declared_amount'),
      'a declared amount always wins')
    assert.ok(fn.includes('public.order_submission_standard_advance_amount(p_grand_total)'),
      'a standard record with no amount reads as the standard 40%')
    assert.ok(fn.includes('public.order_submission_advance_amount(p_grand_total, p_advance_percent)'),
      'an exception with no amount reads as its stored percentage of the total')
  })

  test('the module selects the column, so a screen can show it', () => {
    assert.ok(PI_ADVANCE_COLUMNS.includes('advance_declared_amount'))
  })
})

// ── The doors ────────────────────────────────────────────────────────────────

describe('one implementation, four doors, and three of them do not change', () => {
  test('the applied doors are not restated', () => {
    for (const applied of [
      'create or replace function public.submit_order_submission(',
      'create or replace function public.submit_order_submission_with_note(',
      'create or replace function public.submit_order_submission_with_advance(\n',
      'create or replace function public.approve_order_submission(',
      'create or replace function public.order_submission_advance_ready(',
    ]) {
      assert.ok(!statements.includes(applied), `${applied.trim()} must not be restated`)
    }
  })

  test('the applied implementation becomes a one-line delegate, unchanged in shape', () => {
    const delegate = body('submit_order_submission_advance_internal')
    assert.ok(delegate.includes('submit_order_submission_advance_v2_internal'))
    assert.ok(delegate.includes("then 'percent' else 'none' end"),
      'so an old caller still declares by percentage, exactly as it always did')
    assert.ok(statements.includes(
      'submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text)'),
      'the signature and argument names are identical')
  })

  test('the new door is a SEPARATE NAME, because PostgREST resolves by argument names', () => {
    assert.ok(statements.includes(
      'create or replace function public.submit_order_submission_with_advance_amount('))
    assert.ok(statements.includes('p_advance_amount    numeric'))
    const door = body('submit_order_submission_with_advance_amount')
    assert.ok(door.includes("'amount'"), 'it declares by amount and nothing else')
  })

  test('every function is revoked from public and anon, and the internals from everybody', () => {
    for (const fn of [
      'order_submission_standard_advance_amount(numeric)',
      'order_submission_advance_percent_of(numeric, numeric)',
      'order_submission_effective_advance_amount(text, numeric, numeric, numeric)',
      'submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)',
    ]) {
      assert.ok(statements.includes(`revoke execute on function public.${fn}\n  from public, anon`)
        || statements.includes(`revoke execute on function public.${fn} from public, anon`),
        `${fn} must be revoked from public and anon`)
    }
    for (const fn of [
      'submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text)',
      'submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text)',
      'order_submissions_advance_amount_follows_total()',
    ]) {
      assert.ok(new RegExp(`revoke execute on function public\\.${fn.replace(/[()]/g, '\\$&')}\\s+from public, anon, authenticated, service_role`)
        .test(statements), `${fn} must be executable by no role`)
    }
  })

  test('every function pins its search_path, or is immutable and reads nothing', () => {
    for (const fn of [
      'submit_order_submission_advance_v2_internal',
      'submit_order_submission_advance_internal',
      'submit_order_submission_with_advance_amount',
      'order_submission_effective_advance_amount',
      'order_submissions_advance_amount_follows_total',
    ]) {
      const at = statements.indexOf(`create or replace function public.${fn}(`)
      const head = statements.slice(at, statements.indexOf('as $$', at))
      assert.ok(head.includes('set search_path = public, pg_temp'), `${fn} must pin its search_path`)
    }
  })

  test('the implementation classifies on the amount and derives the percentage', () => {
    const impl = body('submit_order_submission_advance_v2_internal')
    assert.ok(impl.includes('public.order_submission_standard_advance_amount(v_sub.grand_total)'))
    assert.ok(impl.includes('ORDER_SUBMISSION_ADVANCE_AMOUNT_BELOW_STANDARD'))
    assert.ok(impl.includes('ORDER_SUBMISSION_ADVANCE_AMOUNT_NOT_REDUCED'))
    assert.ok(impl.includes('ORDER_SUBMISSION_ADVANCE_AMOUNT_ABOVE_TOTAL'))
    assert.ok(impl.includes('public.order_submission_advance_percent_of(v_sub.grand_total, v_amount)'))
  })

  test('it still locks the row before it judges the record', () => {
    const impl = body('submit_order_submission_advance_v2_internal')
    const lock = impl.indexOf('for update')
    assert.ok(lock > 0)
    assert.ok(impl.indexOf('can_edit_order_submission') > lock, 'state is judged on the locked row')
    assert.ok(impl.indexOf('update public.order_submissions') > lock)
  })

  test('only the owner may propose an exception, and an unknown total fails closed', () => {
    const impl = body('submit_order_submission_advance_v2_internal')
    assert.ok(impl.includes('ORDER_SUBMISSION_ADVANCE_NOT_OWNER'))
    assert.ok(impl.includes('ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING'))
    assert.ok(impl.includes("actor_has_module_permission('orders', 'create')"))
  })

  test('an approved exception survives only when BOTH figures and the reason match', () => {
    const impl = body('submit_order_submission_advance_v2_internal')
    assert.ok(impl.includes('public.order_submission_effective_advance_amount(\n'
      + '              v_sub.advance_condition, v_sub.advance_declared_amount,\n'
      + '              v_sub.advance_exception_percent, v_sub.grand_total) = v_amount'))
    assert.ok(impl.includes('v_sub.advance_exception_percent = v_percent'))
    assert.ok(impl.includes('v_sub.advance_exception_reason is not distinct from v_reason'))
  })

  test('the return shape is unchanged, so every existing caller still parses it', () => {
    assert.ok(body('submit_order_submission_advance_v2_internal').includes(
      "jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count)"))
  })
})

// ── The payment boundary ─────────────────────────────────────────────────────

describe('nothing here reaches a payment, and nothing claims verification', () => {
  test('no payment table, column or concept is named in the executable SQL', () => {
    // MINUS THE FILE'S OWN GUARD, which necessarily NAMES the vocabulary it
    // searches its installed definitions for. Scanning it would fail on the very
    // line that enforces this rule.
    const withoutGuard = statements.replace(/pg_get_functiondef\(p\.oid\) ~\*[^\n]*/g, '')
    for (const forbidden of [
      'finance_payment_requests', 'payment_request', 'payment_allocation',
      'received_advance', 'payment_proof', 'receipt', 'reconcil',
    ]) {
      assert.ok(!withoutGuard.toLowerCase().includes(forbidden),
        `the executable SQL must not mention ${forbidden}`)
    }
  })

  test('and the migration proves it against its own installed definitions', () => {
    // A comment promising this is worth nothing. The file reads
    // pg_get_functiondef for every function it installs and fails the migration.
    assert.ok(statements.includes('pg_get_functiondef(p.oid) ~*'))
    assert.ok(statements.includes('ORDER_SUBMISSION_ADVANCE_AMOUNT_UNSAFE'))
  })

  test('it approves no PI, allocates no number and creates no Order', () => {
    for (const forbidden of [
      'allocate_confirmed_order_number', 'display_number', 'insert into public.orders',
    ]) {
      assert.ok(!statements.includes(forbidden), `${forbidden} is not this change's business`)
    }
    // The PI's OWN status, not advance_exception_status, which is a different
    // column recording a different decision and is read here all the time.
    assert.ok(!/(?<![_a-z])status\s*=\s*'approved'/.test(statements),
      'approving an advance is not approving a PI')
  })

  test('it grants no permission and registers no new action', () => {
    assert.ok(!statements.includes('permission_actions'))
    assert.ok(!statements.includes('module_permission_actions'))
    assert.ok(!/create policy|alter policy/i.test(statements))
  })

  test('the assertions prove Phase C still answers what this change relies on', () => {
    assert.ok(statements.includes("public.order_submission_advance_ready('standard', null, null)"))
    assert.ok(statements.includes("public.order_submission_advance_ready('exception', 39.99, 'approved')"))
    assert.ok(statements.includes("public.order_submission_advance_ready('exception', 12.5, 'pending')"))
  })
})
