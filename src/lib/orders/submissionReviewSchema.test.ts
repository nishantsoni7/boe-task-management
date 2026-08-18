/**
 * Repository check: the Phase A migration adds review, and adds nothing else.
 *
 * WHY A REPO CHECK
 * ----------------
 * Phase A's promises are almost entirely about ABSENCE, and every one of them
 * lives in SQL where TypeScript cannot see it:
 *
 *   1. Nothing can be APPROVED. 'approved' is still reachable from no state, for
 *      every caller including the service role — the transition trigger is the
 *      proof, not the absence of a button.
 *   2. No order number is allocated, no Order row is created, no payment or
 *      advance rule appears. A later phase owns all of that.
 *   3. Rejection is the ONE new move, it requires orders.approve_order, it
 *      demands a reason, and it takes the row lock before it judges the state.
 *   4. History stays append-only and the write privileges stay revoked. A
 *      permissive policy added later would look like a fix while re-opening a
 *      table.
 *   5. submitted_at is written by the DATABASE. A column a browser could set is
 *      a timestamp nobody should trust.
 *
 * Each of those fails silently if a later edit relaxes it, so they are asserted
 * against the migration text itself.
 *
 * THE APPLIED MIGRATIONS ARE NOT EDITED. That is checked here too: Phase A is
 * additive, and 20260908000000 and 20260909000000 must still contain what they
 * always did.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionReviewSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { isProtectedAction } from '../permissions/levels'
import { deriveOrdersCapabilities } from '../permissions/orders'
import { PI_ACTIVITY_LABEL } from './submissionActivity'
import '../permissions/modules'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')

const readMigration = (file: string) => lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))

const PHASE_A_FILE = '20260910000000_order_submission_phase_a_review.sql'
const SUBMISSIONS_FILE = '20260908000000_order_pi_submissions.sql'
const IMAGES_FILE = '20260909000000_order_submission_item_images.sql'

const sql = readMigration(PHASE_A_FILE)

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
 * The migration split at its assertion block.
 *
 * The assertions legitimately NAME the things this phase must not do — they are
 * the checks that fail the migration if an approval function or a numbering
 * action ever appears — so a forbidden-token search has to read what the
 * migration DECLARES, not what it forbids. Everything from the last `do $$`
 * onward is the assertion block.
 */
const assertionsAt = statements.lastIndexOf('do $$')
const declarations = statements.slice(0, assertionsAt)

/**
 * The backfill's own DO block — the first one in the file.
 *
 * Read as its own unit because what is being asserted about it is an ORDER:
 * inspect, then disable, then write, then re-enable, then prove. A search across
 * the whole migration would happily find those five things in the wrong
 * sequence, which is the one arrangement that would be unsafe.
 */
const backfillBlockStart = code.indexOf('do $$')
const backfillBlockEnd = code.indexOf('end $$;', backfillBlockStart) + 'end $$;'.length
const backfill = code.slice(backfillBlockStart, backfillBlockEnd)

/** The full text of one `create or replace function public.<name>(…) … $$;` */
function functionBlock(name: string): string {
  const needle = `create or replace function public.${name}(`
  const start = code.indexOf(needle)
  assert.ok(start >= 0, `function ${name} not found in ${PHASE_A_FILE}`)
  const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))?.[0]
  assert.ok(tag, `function ${name} has no dollar-quoted body`)
  const bodyOpen = code.indexOf(tag, start)
  const bodyClose = code.indexOf(tag, bodyOpen + tag.length)
  assert.ok(bodyClose > 0, `function ${name} body is not closed`)
  return code.slice(start, bodyClose + tag.length)
}

const REJECT = functionBlock('reject_order_submission')
const TRANSITION = functionBlock('order_submissions_enforce_status_transition')
const GUARD = functionBlock('order_submissions_guard_frozen_columns')

// ── The file itself ───────────────────────────────────────────────────────────

describe('Phase A is one additive migration', () => {
  test('it sequences after the applied migrations, and nothing later takes it over', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    assert.ok(PHASE_A_FILE > IMAGES_FILE && PHASE_A_FILE > SUBMISSIONS_FILE,
      'it must sequence after every migration it builds on')

    // Later migrations are allowed — the employee-reply follow-up is one — but
    // none may redefine what Phase A owns: the rejection RPC, the transition
    // trigger, the frozen-column guard or the submitted_at column.
    for (const file of files.filter(f => f > PHASE_A_FILE)) {
      const later = lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
      for (const owned of [
        'create or replace function public.reject_order_submission',
        'create or replace function public.order_submissions_enforce_status_transition',
        'create or replace function public.order_submissions_guard_frozen_columns',
        'add column submitted_at',
      ]) {
        assert.ok(!later.includes(owned), `${file} must not redefine: ${owned}`)
      }
    }
  })

  test('the two applied migrations are untouched', () => {
    // Editing an applied migration changes history for a database that has
    // already run it: the file and the schema stop agreeing, and nothing warns.
    const submissions = readMigration(SUBMISSIONS_FILE)
    const images = readMigration(IMAGES_FILE)

    assert.ok(submissions.includes('create table public.order_submissions ('))
    assert.ok(submissions.includes("check (action in (\n                      'submission_created',"),
      'the original action constraint is still written as it was')
    assert.ok(!submissions.includes('submitted_at'),
      'submitted_at belongs to Phase A, not retro-fitted into an applied file')
    assert.ok(!submissions.includes('reject_order_submission'))
    assert.ok(!images.includes('reject_order_submission'))
    assert.ok(!images.includes('submitted_at'))
  })

  test('it creates no persistent table, drops no column and touches no unrelated object', () => {
    assert.ok(!/drop column/i.test(declarations))
    assert.ok(!/drop function/i.test(declarations))
    assert.ok(!/drop policy/i.test(declarations))

    // The only table it creates is the backfill's own snapshot, and it is
    // TEMPORARY and dropped in the same block. Nothing persistent is added.
    const creates = declarations.match(/create (temporary )?table/gi) ?? []
    assert.deepEqual(creates.map(s => s.toLowerCase()), ['create temporary table'],
      'Phase A adds behaviour, not structure')
    const dropped = declarations.match(/drop table (\w+)/g) ?? []
    assert.deepEqual(dropped, ['drop table _phase_a_updated_at_before'],
      'and the snapshot is the only thing dropped')

    // The one constraint it replaces is the activity action CHECK.
    const drops = declarations.match(/drop constraint/g) ?? []
    assert.equal(drops.length, 1, 'exactly one constraint is replaced: the activity action set')
  })

  test('nothing outside the submission tables is written', () => {
    for (const table of [
      'public.orders', 'order_number_cycle', 'finance_payment', 'order_requests', 'public.users',
    ]) {
      assert.ok(!declarations.includes(`update ${table}`), `${table} must not be written`)
      assert.ok(!declarations.includes(`insert into ${table}`), `${table} must not be written`)
    }
  })
})

// ── Approval remains unreachable ──────────────────────────────────────────────

describe('this phase still cannot approve anything', () => {
  test('the transition trigger admits four moves, and approval is not one', () => {
    for (const move of [
      "old.status = 'draft'         and new.status = 'submitted'",
      "old.status = 'needs_changes' and new.status = 'submitted'",
      "old.status = 'submitted'     and new.status = 'needs_changes'",
      "old.status = 'submitted'     and new.status = 'rejected'",
    ]) {
      assert.ok(TRANSITION.includes(move), `the graph must contain: ${move}`)
    }
    assert.ok(!TRANSITION.includes("'approved'"),
      'no branch may name approved; it must stay reachable from nothing')
  })

  test('the trigger still guards INSERT as well as UPDATE', () => {
    // Guarding only UPDATE would leave a submission creatable AT 'approved' by
    // anything holding an INSERT privilege — which is the service role, and the
    // service role bypasses RLS.
    assert.ok(TRANSITION.includes("if tg_op = 'INSERT' then"))
    assert.ok(TRANSITION.includes("if new.status <> 'draft' then"))
    assert.ok(readMigration(SUBMISSIONS_FILE).includes('before insert or update on public.order_submissions'),
      'and the trigger it replaces is still attached for both')
  })

  test('no approval, numbering, advance or payment function is defined', () => {
    for (const forbidden of [
      'approve_order_submission', 'allocate_confirmed_order_number', 'format_confirmed_order_number',
      'order_number_cycle', 'display_number', 'advance_exception', 'payment',
    ]) {
      assert.ok(!declarations.includes(forbidden), `${forbidden} belongs to a later phase`)
    }
  })

  test('no submission is linked to an Order, and the assertion says so', () => {
    assert.ok(sql.includes('a submission is linked to an Order; this phase creates none'))
    assert.ok(sql.includes("where status = 'approved'"),
      'the migration fails rather than apply over an approved record')
  })

  test('the browser has no approval to call either', () => {
    // canApproveOrderSubmission is the REVIEW capability — send back, reject —
    // and stays what it was. Nothing in this phase turns it into an approval.
    const admin = deriveOrdersCapabilities('admin', [])
    assert.equal(admin.canApproveOrderSubmission, true)
    const member = deriveOrdersCapabilities('member', [{ actionKey: 'view', allowed: true, source: 'role' }])
    assert.equal(member.canApproveOrderSubmission, false)
  })
})

// ── submitted_at ──────────────────────────────────────────────────────────────

describe('the submission time is the database’s to write', () => {
  test('the column is added nullable, and nothing more', () => {
    assert.ok(code.includes('add column submitted_at timestamptz'))
    assert.ok(!/submitted_at\s+timestamptz\s+not null/i.test(code),
      'a record that has never been submitted has no submission time')
  })

  test('only the status transition sets it', () => {
    assert.ok(TRANSITION.includes('new.submitted_at := now()'),
      'the transaction’s own clock, never a value the caller supplied')
    assert.ok(TRANSITION.includes("if new.status = 'submitted' then"))
    assert.ok(TRANSITION.includes('new.submitted_at := old.submitted_at'),
      'and a return or a rejection neither moves nor erases it')
  })

  test('a resubmission replaces the earlier time rather than keeping the first', () => {
    // needs_changes → submitted is one of the moves that reaches the stamp, so
    // the column answers "when did this last reach a reviewer".
    const stampAt = TRANSITION.indexOf('new.submitted_at := now()')
    const graphAt = TRANSITION.indexOf("old.status = 'needs_changes' and new.status = 'submitted'")
    assert.ok(graphAt > -1 && stampAt > graphAt, 'the stamp is applied after the move is allowed')
  })

  test('every other write to it is refused', () => {
    assert.ok(GUARD.includes('new.submitted_at is distinct from old.submitted_at'))
    assert.ok(GUARD.includes("not (new.status = 'submitted' and old.status in ('draft', 'needs_changes'))"),
      'a service-role update, a data fix or a future RPC cannot set a nicer time')
    assert.ok(GUARD.includes('ORDER_SUBMISSION_FIELD_FROZEN'))
    assert.ok(GUARD.includes('new.created_by is distinct from old.created_by'),
      'and the creation record it already froze is still frozen')
  })

  test('the browser cannot write the column, because it cannot write the table', () => {
    const submissions = readMigration(SUBMISSIONS_FILE)
    assert.ok(submissions.includes('revoke insert, update, delete, truncate, references, trigger\n  on public.order_submissions        from anon, authenticated;'))
    assert.ok(sql.includes('client roles hold write privileges'),
      'and Phase A asserts that nothing was re-opened')
  })

  test('the backfill takes history, never a guess, and runs before the guard tightens', () => {
    assert.ok(code.includes("where a.action = 'submitted'"),
      'the source is the append-only trail, which no client role can write')
    assert.ok(code.includes('where s.submitted_at is null'), 'and it never overwrites a real value')
    const backfillAt = code.indexOf('update public.order_submissions s')
    const guardAt = code.indexOf('create or replace function public.order_submissions_guard_frozen_columns')
    assert.ok(backfillAt > -1 && guardAt > backfillAt,
      'the recovery runs under the old guard, so the new rule needs no exception carved into it')
    assert.ok(sql.includes('carry a submitted time with no submission in their history'),
      'and the migration fails if anything was invented')
  })

  test('records with no reliable submitted activity are left null', () => {
    // An inner JOIN against the trail, not a left join with a fallback: a record
    // the history cannot vouch for gets nothing rather than an invented time.
    assert.ok(code.includes('join (\n    select a.submission_id, max(a.created_at) as at'),
      'the newest submitted event, and only for records that have one')
    assert.ok(!/coalesce\([^)]*now\(\)/.test(code.slice(backfillBlockStart, backfillBlockEnd)),
      'nothing substitutes the migration time for a missing event')
  })
})

// ── The backfill must not restamp updated_at ──────────────────────────────────

describe('the backfill preserves the historical updated_at', () => {
  test('the migration knows exactly which trigger would restamp it', () => {
    // public.order_submissions carries a BEFORE UPDATE trigger whose whole body
    // is `NEW.updated_at = now()`. A plain UPDATE here would replace the genuine
    // "last written" time of a real commercial record with the migration's own,
    // irreversibly — and the drafts screens read that column as "Last saved" and
    // order the working list by it.
    const base = readMigration(SUBMISSIONS_FILE)
    assert.ok(base.includes('create trigger order_submissions_set_updated_at'))
    assert.ok(base.includes('before update on public.order_submissions'))
    assert.ok(base.includes('for each row execute function public.set_updated_at();'))
    assert.ok(backfill.includes('order_submissions_set_updated_at'),
      'and Phase A names that exact trigger')
  })

  test('exactly one trigger is disabled, by name', () => {
    const disables = declarations.match(/disable trigger [\w.]+/g) ?? []
    assert.deepEqual(disables, ['disable trigger order_submissions_set_updated_at'],
      'the transition trigger and the frozen-column guard stay armed throughout')
  })

  test('the blunt instruments are refused', () => {
    // session_replication_role would switch off EVERY trigger on the table —
    // the status transition and the frozen-column guard with it — and change
    // RLS behaviour. `disable trigger all` and `disable trigger user` are the
    // same mistake spelled differently.
    assert.ok(!/session_replication_role/i.test(declarations))
    assert.ok(!/disable trigger all/i.test(declarations))
    assert.ok(!/disable trigger user/i.test(declarations))
    assert.ok(!/disable row level security/i.test(declarations))
    assert.ok(!/alter table[\s\S]{0,80}disable trigger order_submissions_(enforce|guard)/i.test(declarations),
      'the two protections are never suppressed')
  })

  test('it is re-enabled in the same statement that disabled it', () => {
    const disableAt = backfill.indexOf('disable trigger order_submissions_set_updated_at')
    const updateAt = backfill.indexOf('update public.order_submissions s')
    const enableAt = backfill.indexOf('enable trigger order_submissions_set_updated_at')
    assert.ok(disableAt > -1 && updateAt > disableAt && enableAt > updateAt,
      'disable, backfill, re-enable — in that order')

    // All three live inside ONE do-block. A DO block is a single statement and
    // is therefore atomic on its own: a failure in the UPDATE rolls the disable
    // back, whether or not the migration runner wraps the file in its own
    // transaction. There is no failure path that commits a disabled trigger.
    assert.ok(backfill.trim().startsWith('do $$'))
    assert.ok(backfill.trim().endsWith('end $$;'))
  })

  test('it fails closed when the trigger is missing or has changed', () => {
    for (const guard of [
      'ORDER_SUBMISSION_BACKFILL_UNSAFE',
      'BEFORE UPDATE ON (public\\.)?order_submissions[[:space:]]',
      'FOR EACH ROW',
      'EXECUTE (FUNCTION|PROCEDURE) (public\\.)?set_updated_at\\(\\)',
    ]) {
      assert.ok(backfill.includes(guard), `the definition check must assert: ${guard}`)
    }
    // Anything other than the ordinary enabled state is a database this
    // migration has not reasoned about: re-enabling would CHANGE that state
    // rather than restore it.
    assert.ok(backfill.includes("if v_state <> 'O' then"))
    const checkAt = backfill.indexOf('pg_get_triggerdef')
    const disableAt = backfill.indexOf('disable trigger')
    assert.ok(checkAt > -1 && disableAt > checkAt,
      'the trigger is inspected BEFORE anything is disabled')
  })

  test('the definition check tolerates how the catalog actually renders names', () => {
    // THE DEFECT THIS PINS. pg_get_triggerdef renders each name against the
    // CURRENT search_path, so on a connection whose path includes public it
    // prints the function UNQUALIFIED:
    //
    //   … ON public.order_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    //
    // An earlier draft of this check demanded `public.set_updated_at()` and
    // therefore fail-closed on a perfectly correct trigger — which would have
    // blocked the whole migration on a real database. Verified against a
    // disposable PostgreSQL 16 instance, which prints exactly that.
    assert.ok(backfill.includes('(public\\.)?set_updated_at'),
      'the schema prefix on the FUNCTION must be optional')
    assert.ok(backfill.includes('(public\\.)?order_submissions'),
      'and on the table, for the same reason')
    assert.ok(!/[^)]public\\\.set_updated_at/.test(backfill),
      'no pattern may require the qualified form')

    // Identity is not left to the regex: the catalog join pins the schema, the
    // table and the trigger name, and a separate pg_proc check pins the
    // function to public.set_updated_at.
    assert.ok(backfill.includes("where n.nspname = 'public'"))
    assert.ok(backfill.includes("and c.relname = 'order_submissions'"))
    assert.ok(backfill.includes("and t.tgname  = 'order_submissions_set_updated_at'"))
    assert.ok(backfill.includes("and p.proname = 'set_updated_at'"))
  })

  test('preservation is proved at apply time, not merely intended', () => {
    assert.ok(backfill.includes('create temporary table _phase_a_updated_at_before'),
      'every affected row’s updated_at is snapshotted first')
    assert.ok(backfill.includes('where s.updated_at is distinct from b.updated_at'),
      'and compared afterwards')
    assert.ok(backfill.includes('had updated_at changed'),
      'a single moved value aborts the migration')
    const enableAt = backfill.indexOf('enable trigger')
    const proveAt = backfill.indexOf('is distinct from b.updated_at')
    assert.ok(proveAt > enableAt, 'and the proof runs after the trigger is back')
  })

  test('only submitted_at is written', () => {
    assert.ok(backfill.includes('set submitted_at = b.submitted_at'))
    const setList = backfill.slice(backfill.indexOf('set submitted_at = b.submitted_at'))
      .slice(0, backfill.slice(backfill.indexOf('set submitted_at = b.submitted_at')).indexOf(';'))
    assert.ok(!/updated_at\s*=/.test(setList),
      'updated_at is never assigned — a BEFORE trigger would overwrite it anyway')
    assert.ok(!/status\s*=|review_note\s*=|rejected_/.test(setList),
      'no other value on a commercial record can move')
  })

  test('the migration asserts no trigger was left disabled', () => {
    assert.ok(sql.includes('These triggers on order_submissions are not enabled'))
    assert.ok(sql.includes("and t.tgenabled <> 'O'"))
    assert.ok(sql.includes('Expected 3 triggers on order_submissions'),
      'the timestamp stamper, the transition trigger and the frozen-column guard')
    assert.ok(sql.includes('the backfill snapshot table was left behind'))
    assert.ok(sql.includes('RLS was weakened on'))
  })
})

// ── Rejection ─────────────────────────────────────────────────────────────────

describe('rejecting a submission', () => {
  test('is SECURITY DEFINER with a pinned search path', () => {
    assert.ok(REJECT.includes('security definer'))
    assert.ok(REJECT.includes('set search_path = public, pg_temp'))
  })

  test('requires an active actor and the review permission', () => {
    assert.ok(REJECT.includes('public.assert_order_submission_actor()'),
      'authenticated, active, not soft-deleted')
    assert.ok(REJECT.includes("public.actor_has_module_permission('orders', 'approve_order')"),
      'the authoritative helper, not a role literal')
    assert.ok(!/role = 'admin'/.test(REJECT), 'no hand-rolled admin branch beside the helper')
  })

  test('the reason is mandatory after trimming', () => {
    assert.ok(REJECT.includes("nullif(btrim(coalesce(p_reason, '')), '')"))
    assert.ok(REJECT.includes('ORDER_SUBMISSION_REASON_REQUIRED'))
  })

  test('the row is locked before its state is judged', () => {
    const lockAt = REJECT.indexOf('for update')
    const checkAt = REJECT.indexOf("if v_status <> 'submitted' then")
    const writeAt = REJECT.indexOf('update public.order_submissions')
    assert.ok(lockAt > -1 && checkAt > lockAt && writeAt > checkAt,
      'lock, then judge, then write — so two reviewers acting together resolve to one outcome')
  })

  test('only a submitted record can be rejected', () => {
    assert.ok(REJECT.includes('ORDER_SUBMISSION_NOT_UNDER_REVIEW'))
    assert.ok(TRANSITION.includes("old.status = 'submitted'     and new.status = 'rejected'"),
      'and the trigger refuses every other origin regardless of what a caller attempts')
  })

  test('the four fields are written in one statement', () => {
    for (const field of ["status      = 'rejected'", 'rejected_by = v_actor', 'rejected_at = now()', 'review_note = v_reason']) {
      assert.ok(REJECT.includes(field), `${field} must be part of the single update`)
    }
    const updates = REJECT.match(/update public\.order_submissions/g) ?? []
    assert.equal(updates.length, 1, 'one atomic write, so no half-rejected record can exist')
  })

  test('it writes the history entry it is supposed to', () => {
    assert.ok(REJECT.includes("'rejected', 'submitted', 'rejected', v_reason"),
      'action, previous status, new status, and the reason as the note')
    assert.ok(REJECT.includes('public.log_order_submission_activity('),
      'through the internal logger, which no client role can execute')
  })

  test('it returns the established shape and nothing commercial', () => {
    assert.ok(REJECT.includes("jsonb_build_object('id', p_submission_id, 'status', 'rejected')"))
    for (const leak of ['client_name', 'grand_total', 'source_workbook_path', 'p_reason,']) {
      assert.ok(!REJECT.includes(`'${leak}'`), `${leak} must not be returned`)
    }
  })

  test('errors name a marker, never commercial data', () => {
    const raises = [...REJECT.matchAll(/raise exception\s+'([^']+)'/g)].map(m => m[1])
    assert.ok(raises.length > 0)
    for (const message of raises) {
      assert.ok(!/client|amount|total|price|workbook/i.test(message),
        `an error must not quote commercial data: ${message}`)
    }
  })

  test('it is executable by signed-in callers only', () => {
    assert.ok(code.includes('revoke execute on function public.reject_order_submission(uuid, text) from public, anon;'))
    assert.ok(code.includes('grant  execute on function public.reject_order_submission(uuid, text) to authenticated;'))
    assert.ok(!/grant[\s\S]{0,80}reject_order_submission[\s\S]{0,40}to service_role/.test(code),
      'a reviewer acts as themselves; there is no server path that rejects on their behalf')
  })

  test('rejection is final in this phase', () => {
    assert.ok(!TRANSITION.includes("old.status = 'rejected'"),
      'no transition leaves rejected: a corrected PI is a new submission')
  })
})

// ── The activity action set ───────────────────────────────────────────────────

describe('the closed activity action set grows by exactly one value', () => {
  test('the five actions are the whole set', () => {
    const start = declarations.indexOf('add constraint order_submission_activity_action_check')
    const constraint = declarations.slice(start, declarations.indexOf(';', start))
    for (const action of ['submission_created', 'parse_replaced', 'submitted', 'changes_requested', 'rejected']) {
      assert.ok(constraint.includes(`'${action}'`), `${action} must be admitted`)
    }
    for (const action of ['submission_created', 'parse_replaced', 'submitted',
                          'changes_requested', 'rejected']) {
      assert.ok(PI_ACTIVITY_LABEL[action], `${action} must have words on the screen`)
    }
    // The TOTAL is not asserted here. This file is about what PHASE A added, and
    // a later phase extending the closed set in its own migration — which is
    // exactly the discipline this constraint exists to enforce — is not a
    // regression in Phase A. submissionActivity.test.ts owns the current total.
    assert.ok(!constraint.includes('advance_exception'),
      'and Phase A itself still admits none of Phase B’s events')
  })

  test('nothing about approval, numbering, advances or payments is admitted', () => {
    // The constraint statement alone: from `add constraint` to its semicolon.
    const start = declarations.indexOf('add constraint order_submission_activity_action_check')
    const constraint = declarations.slice(start, declarations.indexOf(';', start))
    for (const forbidden of ['approved', 'order_number', 'advance', 'payment']) {
      assert.ok(!constraint.includes(forbidden), `${forbidden} belongs to a later phase`)
    }
  })

  test('the old constraint is located by its definition, not by an assumed name', () => {
    assert.ok(code.includes("pg_get_constraintdef(c.oid) like '%changes_requested%'"))
    assert.ok(code.includes('the order_submission_activity action constraint was not found'),
      'and the migration fails loudly rather than silently skipping the drop')
  })
})

// ── Everything that must NOT have moved ───────────────────────────────────────

describe('the guarantees the earlier phases established are re-asserted', () => {
  test('history is still append-only', () => {
    assert.ok(sql.includes('order_submission_activity has write policies'))
    assert.ok(sql.includes('log_order_submission_activity is executable by a role'))
    assert.ok(!/create policy[\s\S]{0,120}order_submission_activity/.test(declarations),
      'Phase A adds no policy to the history table')
  })

  test('RLS and the restrictive module gates are checked on all four tables', () => {
    assert.ok(sql.includes('expected 4 restrictive module entry gates'))
    assert.ok(sql.includes('RLS is not enabled on: %'))
  })

  test('the parsed-data writer is still unreachable from a browser', () => {
    assert.ok(sql.includes('replace_order_submission_parse must not be executable by a client role'))
    assert.ok(!declarations.includes('grant  execute on function public.replace_order_submission_parse'))
  })

  test('orders.approve_order is still deny-by-default and still protected', () => {
    assert.ok(sql.includes('orders.approve_order is not registered as deny-by-default'))
    assert.ok(isProtectedAction('approve_order'),
      'no Viewer / Contributor / Manager preset may reach it')
    assert.ok(!/insert into public\.employee_permission_overrides/.test(declarations),
      'and this migration grants it to nobody')
  })

  test('no credential, project reference or connection string is in the file', () => {
    assert.ok(!/postgres:\/\/|supabase\.co|service_role_key|eyJ[A-Za-z0-9]/.test(sql))
  })
})
