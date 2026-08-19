/**
 * Repository check: the Phase C migration keeps the guarantees this phase exists
 * to establish.
 *
 * WHY A REPO CHECK
 * ----------------
 * Every promise below lives only in SQL, and each fails SILENTLY if a later
 * change "helpfully" relaxes it:
 *
 *   1. An Order NUMBER comes from the existing allocator or it does not come.
 *      No second allocator, no sequence, no max(display_number)+1, and nothing
 *      in a browser. A number allocated any other way would look identical on
 *      screen and be wrong in the register.
 *   2. Approval is reachable from exactly one status, through exactly one
 *      function. The transition trigger is what makes that true for the service
 *      role and for psql, not merely for a signed-in client.
 *   3. ONE submission, ONE Order — guaranteed by two partial unique indexes
 *      pointing in opposite directions, not by the RPC that writes them.
 *   4. A failed approval consumes nothing: the number cycle advances inside the
 *      caller's transaction and rolls back with it.
 *   5. Finance verification is a SECOND authority, and it goes stale the moment
 *      the record moves.
 *   6. Nothing in this phase writes a payment, a request or a receipt.
 *   7. Not one applied migration is edited.
 *
 * TypeScript sees none of this. These tests read the migration itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/finalApprovalSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const read = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

const FILE = '20260915000000_order_submission_final_approval.sql'
const APPLIED_PHASE_B = '20260914000000_order_submission_permanent_deletion.sql'
const ADVANCE = '20260913000000_order_submission_advance_exceptions.sql'
const PHASE_A = '20260910000000_order_submission_phase_a_review.sql'
const SUBMISSIONS = '20260908000000_order_pi_submissions.sql'
const NUMBER_CYCLE = '20260703000000_confirmed_order_number_cycle.sql'
const FOUR_DIGIT = '20260704000000_confirmed_order_four_digit_numbers.sql'

const sql = read(FILE)

/**
 * The migration with `--` comments removed.
 *
 * ESSENTIAL HERE. The header deliberately NAMES the things this phase must not
 * do — "no second Order-number allocator", "max(display_number)+1", "records no
 * payment" — in order to explain why it does not do them. A check scanning raw
 * text would fail on the sentences promising the very thing it verifies.
 */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** Executable SQL minus `comment on ... is '...';`, whose prose has the same
 *  problem as the `--` comments and legitimately contains semicolons. */
const declarations = code.replace(/comment on [\s\S]*?is\s+'(?:[^']|'')*'\s*;/gi, '')

/** One `create or replace function` block, body included. */
function fn(name: string, source = code): string {
  const start = source.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is missing`)
  const tag = /\$[A-Za-z_]*\$/.exec(source.slice(start))?.[0]
  assert.ok(tag, `${name} has no dollar-quoted body`)
  const open = source.indexOf(tag, start)
  const close = source.indexOf(tag, open + tag.length)
  assert.ok(close > 0, `${name} body is not closed`)
  return source.slice(start, close + tag.length)
}

const APPROVE = fn('approve_order_submission')
const VERIFY = fn('verify_pi_finance_check')
const TRANSITION = fn('order_submissions_enforce_status_transition')
const ORDER_LINK = fn('order_submissions_guard_order_link')
const FINANCE_GUARD = fn('order_submissions_guard_finance_verification')
const CAN_VERIFY = fn('can_verify_pi_finance')
const VERIFIED_PRED = fn('order_submission_finance_verified')

// ── The file ──────────────────────────────────────────────────────────────────

describe('the migration is one new forward file, in the right place', () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

  test('it exists and is named for what it does', () => {
    assert.ok(files.includes(FILE))
  })

  test('it sorts after every applied migration it builds on', () => {
    for (const earlier of [APPLIED_PHASE_B, ADVANCE, PHASE_A, SUBMISSIONS, NUMBER_CYCLE, FOUR_DIGIT]) {
      assert.ok(files.includes(earlier), `${earlier} is missing`)
      assert.ok(FILE > earlier, `${FILE} must sort after ${earlier}`)
    }
    assert.equal(files[files.indexOf(APPLIED_PHASE_B) + 1], FILE,
      'and nothing was slipped in between')
  })

  test('Phase C ITSELF added exactly ONE migration', () => {
    // Between the applied Phase B migration and this one, inclusive, there is
    // exactly one new file. Later work adds its own — 20260916000000 fixes the
    // Test Data Cleanup defect this phase's mutual foreign key exposed — and is
    // not counted here.
    assert.deepEqual(files.filter(f => f > APPLIED_PHASE_B && f <= FILE), [FILE])
  })

// A later migration is allowed to exist — the company ships other things. What
// this guard is really protecting is that it does not REACH INTO the PI
// submission tables. Until 20260918000000 the filename was a good enough proxy
// for that, because every later file so far belonged to this feature; the first
// unrelated phase to land made the proxy wrong rather than the property wrong.
//
// So the property is now tested directly: a later file passes if it belongs to
// this feature by name, OR if it does not restructure order_submissions or its
// children. Naming one of those tables as a FOREIGN KEY TARGET or reading it is
// explicitly fine — that is what a neighbouring module is supposed to do, and it
// changes nothing about approval, deletion or the schema this suite guards.
// The ONE structural change an outside phase is allowed to make to these tables,
// and the reason it is allowed: order_submission_activity.action is a CLOSED set,
// and 20260915000000 §10 states that a phase producing a new kind of event
// extends it "in its own migration — a visible change rather than a silent new
// event type". That IS the sanctioned extension point, so a migration that only
// drops and re-adds the action CHECK is doing what the design asks of it.
//
// Nothing else is forgiven: the statements below are removed before the
// structural test runs, so a file that also alters a column, adds a policy, or
// writes a row still fails on that.
const PI_ACTIVITY_ACTION_CHECK_EXTENSION =
  /(?:execute\s+format\(\s*'alter\s+table\s+(?:public\.)?order_submission_activity\s+drop\s+constraint[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+(?:drop|add)\s+constraint\s+[^;]*order_submission_activity_action_check[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+add\s+constraint\s+order_submission_activity_action_check[^;]*;)/gi

function withoutSanctionedActivityExtension(sql: string): string {
  return sql.replace(PI_ACTIVITY_ACTION_CHECK_EXTENSION, '')
}

const PI_STRUCTURAL_CHANGE =
  /(alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*|drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*|(?:alter|drop|create)\s+policy\s+[^;]*\bon\s+(?:public\.)?order_submission\w*)/i

function reachesIntoPiSubmissions(file: string): boolean {
  if (/order_submission/i.test(file)) return false          // this feature's own work
  const sql = withoutSanctionedActivityExtension(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8'))
  return PI_STRUCTURAL_CHANGE.test(sql)
}

  test('anything that lands after it belongs to this same feature', () => {
    // It WAS the newest when it was written, and demanding it stay so would make
    // this suite fail every time the company ships anything else — which says
    // nothing about whether approval is still safe. THE PROPERTY THAT MATTERS is
    // narrower: a later file may exist, but it must be part of the PI submission
    // feature rather than unrelated work reaching into these tables.
    for (const file of files.filter(f => f > FILE)) {
      assert.equal(reachesIntoPiSubmissions(file), false,
        `${file} lands after Phase C and restructures the PI submission tables`)
    }
  })

  test('no two migrations share a version prefix', () => {
    // Supabase keys schema_migrations on the numeric prefix, not the filename:
    // two files sharing one version means only ONE is ever recorded, silently.
    const seen = new Set<string>()
    for (const file of files) {
      const version = /^(\d+)_/.exec(file)?.[1]
      assert.ok(version, `${file} has no numeric version prefix`)
      assert.ok(!seen.has(version), `duplicate migration version ${version}`)
      seen.add(version)
    }
  })

  test('it carries no credential and no connection string', () => {
    assert.ok(!/postgres:\/\/|supabase\.co|service_role_key|eyJ[A-Za-z0-9]/.test(sql))
  })
})

describe('the applied migrations are untouched', () => {
  test('every one of them still says exactly what it said', () => {
    // Editing an applied migration changes history for a database that has
    // already run it: the file and the schema stop agreeing, and nothing warns.
    const submissions = read(SUBMISSIONS)
    assert.ok(submissions.includes('create table public.order_submissions ('))
    assert.ok(submissions.includes('Reserved for the approval phase.'),
      'including the comment that reserved advance_exception_reason for this one')

    assert.ok(read(PHASE_A).includes('the transition trigger names approved'),
      'Phase A still fails its own apply if IT ever names approved')
    assert.ok(read(ADVANCE).includes('order_submission_advance_ready'))
    assert.ok(read(APPLIED_PHASE_B).includes('order_submission_deletable_statuses'))

    // The numbering migrations, above all.
    assert.ok(read(NUMBER_CYCLE).includes('create or replace function public.allocate_confirmed_order_number'))
    assert.ok(read(NUMBER_CYCLE).includes('create trigger orders_assign_display_number'))
    assert.ok(read(FOUR_DIGIT).includes("lpad(p_number::text, 4, '0')"))
  })

  test('this migration drops no table, column, policy or constraint it does not own', () => {
    const drops = [...declarations.matchAll(/drop\s+(table|column|policy|function|index)\s+/gi)]
      .map(m => m[0])
    assert.deepEqual(drops, [],
      'the only drops are `drop trigger if exists` and the action CHECK it replaces in place')
    // The one constraint it drops is the activity action set, which every phase
    // of this feature replaces the same way in order to widen it.
    const constraintDrops = [...declarations.matchAll(/drop constraint %I|drop constraint (\w+)/gi)]
    assert.equal(constraintDrops.length, 1)
  })

  test('it alters only the two tables it must, and only by ADDING', () => {
    const altered = [...declarations.matchAll(/alter table public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(altered)].sort(),
      ['order_submission_activity', 'order_submissions', 'orders'])
    for (const statement of declarations.split(';')) {
      if (!/alter table/i.test(statement)) continue
      assert.ok(!/drop column|alter column|rename/i.test(statement),
        `an ALTER must add, never reshape: ${statement.trim().slice(0, 90)}`)
    }
  })
})

// ── 1. The Order number ───────────────────────────────────────────────────────

describe('the Order number comes from the existing allocator, or not at all', () => {
  test('this migration defines no allocator, sequence or counter of its own', () => {
    for (const forbidden of [
      'create or replace function public.allocate_confirmed_order_number',
      'create function public.allocate_confirmed_order_number',
      'create sequence', 'nextval', 'setval',
      'create or replace function public.format_confirmed_order_number',
      'create or replace function public.next_order_display_number',
      'create table public.order_number_cycle',
    ]) {
      assert.ok(!declarations.includes(forbidden), `${forbidden} must not appear here`)
    }
  })

  test('nothing computes a number from the existing ones', () => {
    assert.ok(!/max\s*\(\s*display_number/i.test(declarations),
      'max(display_number)+1 is the defect the cycle exists to prevent')
    assert.ok(!/display_number\s*(\+|\|\|)/.test(declarations))
    assert.ok(!/lpad\s*\(/i.test(declarations), 'the format is the four-digit migration’s to decide')
  })

  test('the approval INSERT does not name display_number at all', () => {
    const insert = APPROVE.slice(APPROVE.indexOf('insert into public.orders'))
    const columns = insert.slice(0, insert.indexOf(')'))
    assert.ok(!columns.includes('display_number'),
      'the BEFORE INSERT trigger assigns it unconditionally; supplying one would be discarded anyway')
    assert.ok(/returning id, display_number into v_order_id, v_number/.test(APPROVE),
      'and RETURNING reads back the value the trigger actually assigned')
  })

  test('the RPC never reaches for the cycle itself', () => {
    for (const forbidden of [
      'allocate_confirmed_order_number', 'order_number_cycle',
      'next_order_display_number', 'set_next_confirmed_order_number',
    ]) {
      assert.ok(!APPROVE.includes(forbidden),
        `${forbidden} is the trigger's to call, never the RPC's`)
    }
  })

  test('the migration asserts at apply time that there is exactly ONE allocator', () => {
    assert.ok(code.includes("p.proname = 'allocate_confirmed_order_number'"))
    assert.ok(code.includes('expected exactly one confirmed Order number allocator'))
    assert.ok(code.includes("t.tgname = 'orders_assign_display_number'"),
      'and that the stamping trigger is still attached')
  })

  test('no number is allocated before approval', () => {
    // The only INSERT into public.orders in this file is inside the approval
    // RPC, after every eligibility check. A draft, a submitted, a returned and a
    // rejected PI therefore never reach the allocator at all.
    const inserts = [...declarations.matchAll(/insert into public\.orders\b/g)]
    assert.equal(inserts.length, 1, 'exactly one Order is ever created by this file')
    assert.ok(APPROVE.includes('insert into public.orders'))
    const before = APPROVE.slice(0, APPROVE.indexOf('insert into public.orders'))
    for (const gate of [
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW',
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED',
      'ORDER_SUBMISSION_ADVANCE_NOT_READY',
      'ORDER_SUBMISSION_BLOCKED',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_DELETION_CLAIMED',
    ]) {
      assert.ok(before.includes(gate), `${gate} must be checked BEFORE a number is allocated`)
    }
  })

  test('a failed approval burns nothing, because allocation is transactional', () => {
    // Not asserted about this file — asserted about the mechanism it reuses. The
    // cycle is an ordinary table row advanced under FOR UPDATE inside the
    // caller's transaction, which is exactly what the retired sequence was not.
    const cycle = read(NUMBER_CYCLE)
    assert.ok(cycle.includes('for update'))
    assert.ok(cycle.includes('update public.order_number_cycle\n     set next_number = v_next + 1'))
    assert.ok(!/nextval\s*\(/.test(cycle.split('-- ')[0] ?? ''))
  })
})

// ── 2. Approval is reachable one way only ─────────────────────────────────────

describe('approved is reachable from one status, through one function', () => {
  test('the transition graph adds submitted -> approved and nothing else', () => {
    for (const move of [
      "(old.status = 'draft'            and new.status = 'submitted')",
      "(old.status = 'needs_changes' and new.status = 'submitted')",
      "(old.status = 'submitted'     and new.status = 'needs_changes')",
      "(old.status = 'submitted'     and new.status = 'rejected')",
      "(old.status = 'submitted'     and new.status = 'approved')",
    ]) {
      assert.ok(TRANSITION.includes(move), `the graph must contain: ${move}`)
    }
    // Approval is terminal: nothing leaves it.
    assert.ok(!/old\.status = 'approved'/.test(TRANSITION),
      'there is no transition OUT of approved, and there must not be one')
  })

  test('a legal transition is still refused outside the approval RPC', () => {
    assert.ok(TRANSITION.includes("if new.status = 'approved' and not public.in_pi_submission_approval(old.id)"))
    assert.ok(TRANSITION.includes('ORDER_SUBMISSION_APPROVAL_PATH_REQUIRED'))
  })

  test('the trigger fires on INSERT as well as UPDATE, so nothing is born approved', () => {
    assert.ok(TRANSITION.includes("if new.status <> 'draft' then"))
    assert.ok(code.includes('before insert or update on public.order_submissions'))
  })

  test('the approval context is transaction-local and names ONE submission', () => {
    const marker = fn('in_pi_submission_approval')
    assert.ok(marker.includes("current_setting('boe.pi_submission_approval_id', true)"))
    assert.ok(marker.includes('v_marker = p_submission_id::text'),
      'a marker naming a specific id cannot authorise a second record')
    assert.ok(APPROVE.includes("set_config('boe.pi_submission_approval_id', p_submission_id::text, true)"),
      'the third argument is true: local to the transaction')
    assert.ok(APPROVE.includes("set_config('boe.pi_submission_approval_id', '', true)"),
      'and it is closed again before returning')
    assert.ok(code.includes('revoke execute on function public.in_pi_submission_approval(uuid)\n  from public, anon, authenticated, service_role;'),
      'no role may open the context by hand')
  })

  test('order_id is written once, only in that context, and never re-pointed', () => {
    assert.ok(ORDER_LINK.includes('ORDER_SUBMISSION_ORDER_LINK_IMMUTABLE'))
    assert.ok(ORDER_LINK.includes('old.order_id is null and new.order_id is not null'))
    assert.ok(ORDER_LINK.includes('not public.in_pi_submission_approval(old.id)'))
    assert.ok(ORDER_LINK.includes('ORDER_SUBMISSION_APPROVAL_PATH_REQUIRED'))
  })

  test('the approval audit fields move only as part of an approval', () => {
    assert.ok(ORDER_LINK.includes('new.approved_by is distinct from old.approved_by'))
    assert.ok(ORDER_LINK.includes('ORDER_SUBMISSION_FIELD_FROZEN'))
  })

  test('an approved record always carries its Order, in the same statement', () => {
    assert.ok(ORDER_LINK.includes("if new.status = 'approved' and old.status = 'submitted' and new.order_id is null"))
    const update = APPROVE.slice(APPROVE.indexOf('update public.order_submissions'))
    for (const field of ["status      = 'approved'", 'approved_by = v_actor', 'approved_at = v_now', 'order_id    = v_order_id']) {
      assert.ok(update.includes(field), `${field} must land in the same UPDATE`)
    }
  })

  test('no client role can create an Order or write a submission directly', () => {
    assert.ok(code.includes("privilege_type in ('INSERT', 'DELETE', 'TRUNCATE')"))
    assert.ok(code.includes('client roles hold creation privileges that would bypass the workflow'))
    assert.ok(code.includes('unexpected client write policies'))
    // And this file adds no grant or policy that would open one.
    assert.ok(!/grant\s+(insert|update|delete)/i.test(declarations))
    assert.ok(!/create policy/i.test(declarations),
      'the one visibility change is an ALTER of an existing SELECT policy, not a new policy')
  })
})

// ── 3. One submission, one Order ──────────────────────────────────────────────

describe('exactly one Order per approved PI, guaranteed by the database', () => {
  test('both partial unique indexes exist, pointing in opposite directions', () => {
    assert.ok(code.includes('create unique index if not exists orders_source_order_submission_id_uidx'))
    assert.ok(code.includes('where source_order_submission_id is not null'))
    // The submission-side one is 20260908000000's and is asserted, not restated.
    assert.ok(read(SUBMISSIONS).includes('create unique index order_submissions_order_id_key'))
    assert.ok(code.includes("c.relname = 'order_submissions_order_id_key'"),
      'and this migration refuses to apply if it has gone missing')
  })

  test('the source column is immutable once set', () => {
    const guard = fn('prevent_order_source_submission_change')
    assert.ok(guard.includes('ORDER_SOURCE_SUBMISSION_IMMUTABLE'))
    assert.ok(guard.includes('old.source_order_submission_id is not null'),
      'setting it from NULL exactly once is what lets the RPC populate it')
    assert.ok(code.includes('create trigger orders_protect_source_submission'))
  })

  test('the FK refuses to let an approved PI be hard-deleted', () => {
    assert.ok(code.includes('add column if not exists source_order_submission_id uuid references public.order_submissions(id)'))
    assert.ok(!/source_order_submission_id[\s\S]{0,120}on delete/i.test(code),
      'NO ACTION is the default and is the guarantee; a cascade would erase provenance')
  })

  test('a concurrent or repeated call returns the existing Order, allocating nothing', () => {
    const already = APPROVE.slice(APPROVE.indexOf("if v_sub.status = 'approved'"))
    assert.ok(already.includes("'already_approved', true"))
    assert.ok(already.slice(0, already.indexOf('end if;')).includes('select o.display_number'),
      'it reads the EXISTING number back rather than allocating a new one')
    // And the branch sits before every write, so nothing else runs.
    assert.ok(APPROVE.indexOf("'already_approved', true")
      < APPROVE.indexOf('insert into public.orders'))
  })

  test('the row lock is taken BEFORE any mutable state is judged', () => {
    const lock = APPROVE.indexOf('for update')
    assert.ok(lock > 0)
    for (const check of [
      "if v_sub.status = 'approved'",
      "if v_sub.status <> 'submitted'",
      'order_submission_finance_verified',
      'order_submission_advance_ready',
      'deletion_claim_token is not null',
    ]) {
      assert.ok(APPROVE.indexOf(check) > lock, `${check} must be judged under the lock`)
    }
  })
})

// ── 4. Eligibility ────────────────────────────────────────────────────────────

describe('every eligibility rule is re-derived from the locked row', () => {
  test('the RPC takes an id and nothing else', () => {
    assert.ok(APPROVE.includes('approve_order_submission(p_submission_id uuid)'))
    // No total, no client name, no status, no number: there is no payload for a
    // caller to shape.
    const signature = APPROVE.slice(0, APPROVE.indexOf(')'))
    assert.ok(!/numeric|text|boolean/.test(signature))
  })

  test('the actor is derived server-side, never accepted', () => {
    assert.ok(APPROVE.includes('v_actor      uuid := public.assert_order_submission_actor()'),
      'which proves a real, ACTIVE, non-deleted account')
    assert.ok(!/p_actor|p_user_id|p_approved_by/.test(APPROVE))
  })

  test('the authority is orders.approve_order, through the shared resolver', () => {
    assert.ok(APPROVE.includes("public.actor_has_module_permission('orders', 'approve_order')"))
    assert.ok(APPROVE.includes('You do not have permission to approve order submissions'))
  })

  test('the advance rule is the VALUE form, as Phase B instructed', () => {
    // order_submission_is_advance_ready(uuid) answers on behalf of whoever is
    // signed in and returns false for a caller who cannot see the record —
    // exactly the wrong question for a definer function holding the locked row.
    assert.ok(APPROVE.includes('public.order_submission_advance_ready(\n       v_sub.advance_condition, v_sub.advance_exception_percent, v_sub.advance_exception_status)'))
    assert.ok(!APPROVE.includes('order_submission_is_advance_ready'))
    assert.ok(read(ADVANCE).includes('a future SECURITY DEFINER approval\n-- function must NOT ask this one'),
      'and Phase B said so in as many words')
  })

  test('a pending or rejected exception is refused by the same predicate', () => {
    // The predicate is approved-only, which is what makes both cases fail
    // without this file restating either.
    assert.ok(read(ADVANCE).includes("p_advance_exception_status = 'approved'"))
    assert.ok(APPROVE.includes('ORDER_SUBMISSION_ADVANCE_NOT_READY'))
  })

  test('a deletion reservation blocks both decisions', () => {
    assert.ok(APPROVE.includes('ORDER_SUBMISSION_DELETION_CLAIMED'))
    assert.ok(VERIFY.includes('ORDER_SUBMISSION_DELETION_CLAIMED'))
  })

  test('the stored workbook is re-validated at approval time, not trusted', () => {
    for (const rule of [
      "'^submissions/' || p_submission_id::text || '/original/[^/]+$'",
      "o.bucket_id = 'order-files'",
      "'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'",
    ]) {
      assert.ok(APPROVE.includes(rule), `the workbook check must include: ${rule}`)
    }
  })

  test('every product line and every image is re-validated too', () => {
    assert.ok(APPROVE.includes('ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'))
    assert.ok(APPROVE.includes('item_sequence is null or product_name is null'))
    assert.ok(APPROVE.includes('ORDER_SUBMISSION_IMAGE_NOT_STORED'))
  })

  test('images are judged on the table that actually holds them', () => {
    // 20260909000000 MOVED the pictures: a product line has exactly one
    // representative image and any number of customization images, each a child
    // row in order_submission_item_images with its own role and position in the
    // storage key. order_submission_items.image_storage_path is the earlier
    // shape and is no longer authoritative — judging it would refuse every PI
    // submitted since that migration, which is every PI.
    assert.ok(APPROVE.includes('public.order_submission_item_images'))
    assert.ok(!/i\.image_storage_path/.test(APPROVE),
      'the retired per-item column must not decide anything')
    assert.ok(APPROVE.includes("m.role = 'representative'"))
    assert.ok(APPROVE.includes(') <> 1'), 'exactly one representative image per line')
  })

  test('the image path must name the submission, the item, the role, the slot and the bytes', () => {
    assert.ok(APPROVE.includes("'/images/' || m.item_id::text"))
    assert.ok(APPROVE.includes("|| '/' || m.role || '/' || m.position::text || '-' || m.sha256"),
      'which is what stops one product’s photograph being presented as another’s')
  })

  test('and it is the SAME rule the submit path applies', () => {
    // What was true when the employee submitted must still be true when the
    // Order is created, and the two paths must agree about what "still true"
    // means. Asserted against the applied migration rather than restated.
    const images = read('20260909000000_order_submission_item_images.sql')
    for (const shared of [
      "m.role = 'representative'",
      "|| '/' || m.role || '/' || m.position::text || '-' || m.sha256",
      "o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')",
    ]) {
      assert.ok(images.includes(shared), `the submit path must also apply: ${shared}`)
      assert.ok(APPROVE.includes(shared), `and so must approval: ${shared}`)
    }
  })

  test('blocking diagnostics refuse approval', () => {
    assert.ok(APPROVE.includes('jsonb_array_length(v_sub.parse_blocking_issues) > 0'))
  })
})

// ── 5. Finance verification ───────────────────────────────────────────────────

describe('finance verification is a second authority, and it goes stale', () => {
  test('the authority is finance.approve WITH Finance module entry, or an active admin', () => {
    assert.ok(CAN_VERIFY.includes("public.actor_has_permission('finance', 'approve')"))
    assert.ok(CAN_VERIFY.includes("public.module_entry_open('finance')"))
    assert.ok(CAN_VERIFY.includes("u.role = 'admin'"))
    assert.ok(CAN_VERIFY.includes('u.is_active'))
    assert.ok(CAN_VERIFY.includes('coalesce(u.is_deleted, false) = false'),
      'a deactivated admin keeps no authority')
  })

  test('orders.approve_order confers NO finance authority', () => {
    assert.ok(!CAN_VERIFY.includes('approve_order'))
    assert.ok(VERIFY.includes('public.can_verify_pi_finance()'))
    assert.ok(!VERIFY.includes("actor_has_module_permission('orders'"),
      'the verification door must not admit a PI reviewer as such')
  })

  test('a finance verifier cannot approve the PI', () => {
    assert.ok(!APPROVE.includes('can_verify_pi_finance'),
      'the approval door checks orders.approve_order and nothing else for authority')
  })

  test('verification does not approve the PI or create an Order', () => {
    assert.ok(!VERIFY.includes('insert into public.orders'))
    assert.ok(!/status\s*=\s*'approved'/.test(VERIFY))
    assert.ok(!VERIFY.includes('order_id'))
    assert.ok(VERIFY.includes("'submitted', 'submitted'"),
      'the activity entry records that the PI stayed exactly where it was')
  })

  test('it writes no payment, request, receipt or reconciliation', () => {
    // Scoped to the two RPC BODIES on purpose. The apply-time assertion block at
    // the foot of the migration legitimately names finance_payment_requests in
    // order to refuse it, and a whole-file scan would fail on the guard rather
    // than on a breach.
    for (const body of [APPROVE, VERIFY]) {
      for (const table of [
        'finance_payment_requests', 'payment_proof_attachments',
        'finance_payment_request_activity_log',
      ]) {
        assert.ok(!body.includes(table), `${table} is out of scope for this phase`)
      }
    }
    assert.ok(!/insert into public\.(finance|payment)/i.test(declarations))
    assert.ok(code.includes('approve_order_submission writes a payment record'),
      'and the migration asserts it at apply time')
  })

  test('a repeated verification records nothing a second time', () => {
    const branch = VERIFY.slice(VERIFY.indexOf('public.order_submission_finance_verified('))
    assert.ok(branch.includes("'already_verified',   true"))
    assert.ok(VERIFY.indexOf("'already_verified',   true") < VERIFY.indexOf('update public.order_submissions'),
      'the idempotent branch returns before any write')
  })

  test('the verification is version-bound to the submission it was made against', () => {
    assert.ok(VERIFY.includes('finance_verified_submission_at = v_sub.submitted_at'))
    assert.ok(VERIFIED_PRED.includes('p_finance_verified_submission_at = p_submitted_at'))
    assert.ok(FINANCE_GUARD.includes('new.finance_verified_submission_at is distinct from new.submitted_at'))
  })

  test('it is CLEARED outright whenever the record moves', () => {
    // Two independent reasons a stale sign-off cannot be presented as current:
    // the guard erases it, and the binding would not match even if it had not.
    assert.ok(FINANCE_GUARD.includes('new.finance_verified_by            := null'))
    assert.ok(FINANCE_GUARD.includes('if new.status is distinct from old.status then'))
  })

  test('...except at approval, where it is part of the record’s history', () => {
    // Read from `code`, whose comments are stripped: what matters is the branch,
    // not the sentence explaining it.
    const guard = fn('order_submissions_guard_finance_verification', code)
    const approvedBranch = guard.slice(guard.indexOf("if new.status = 'approved' then"))
    assert.ok(approvedBranch.startsWith("if new.status = 'approved' then"))
    assert.ok(approvedBranch.slice(0, approvedBranch.indexOf('end if;')).includes('return new;'),
      'approval keeps the verification verbatim rather than clearing it')
  })

  test('nothing can be verified except a submitted PI', () => {
    assert.ok(FINANCE_GUARD.includes("if new.status <> 'submitted' or old.status <> 'submitted' then"))
    assert.ok(FINANCE_GUARD.includes('ORDER_SUBMISSION_FINANCE_NOT_UNDER_REVIEW'))
    assert.ok(VERIFY.includes("if v_sub.status <> 'submitted' then"))
  })

  test('a submission is created with no verification, for every caller', () => {
    assert.ok(FINANCE_GUARD.includes("if tg_op = 'INSERT' then"))
    assert.ok(FINANCE_GUARD.includes('ORDER_SUBMISSION_FINANCE_INVALID: a submission is created with no finance verification'))
  })

  test('Needs Changes and Reject stay reachable after verification', () => {
    // Nothing in this file touches either RPC, and the guard's only reaction to
    // those transitions is to clear the sign-off — never to refuse the move.
    for (const untouched of ['request_order_submission_changes', 'reject_order_submission']) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`),
        `${untouched} belongs to an applied migration and must not be restated`)
    }
    assert.ok(TRANSITION.includes("(old.status = 'submitted'     and new.status = 'needs_changes')"))
    assert.ok(TRANSITION.includes("(old.status = 'submitted'     and new.status = 'rejected')"))
  })
})

// ── 6. Visibility ─────────────────────────────────────────────────────────────

describe('a finance verifier can see what they are asked to verify, and no more', () => {
  test('the widening covers submitted and approved records only', () => {
    const view = fn('can_view_order_submission')
    assert.ok(view.includes("s.status in ('submitted', 'approved') and public.can_verify_pi_finance()"))
    assert.ok(!/'draft'|'needs_changes'|'rejected'/.test(view),
      'a PI not yet handed to management, or already closed, is nobody’s to verify')
  })

  test('the policy and the helper say the same thing', () => {
    assert.ok(code.includes('alter policy "order_submissions_select" on public.order_submissions'))
    assert.ok(code.includes("or (status in ('submitted', 'approved') and public.can_verify_pi_finance())"))
  })

  test('the RESTRICTIVE Order Management entry gate is untouched', () => {
    // No statement creates, alters or drops one. The only mention of the gates
    // in this file is the apply-time assertion that they are still restrictive.
    for (const statement of declarations.split(';')) {
      if (!/module_entry_gate/.test(statement)) continue
      assert.ok(!/(create|alter|drop)\s+policy/i.test(statement),
        `a gate must not be redefined: ${statement.trim().slice(0, 90)}`)
    }
    assert.ok(code.includes('expected 3 RESTRICTIVE module entry gates'),
      'and the migration refuses to apply if they stopped being restrictive')
  })

  test('a verifier reads every file and writes none', () => {
    assert.ok(!declarations.includes('create or replace function public.can_write_order_submission_file'),
      'the write predicate is 20260908000000’s and is not restated')
    assert.ok(code.includes('the file write predicate now admits a finance verifier'),
      'and the migration asserts at apply time that it never grew one')
  })
})

// ── 7. Field mapping ──────────────────────────────────────────────────────────

describe('the Order is built from the stored submission, and from nothing else', () => {
  const insert = APPROVE.slice(
    APPROVE.indexOf('insert into public.orders'),
    APPROVE.indexOf('returning id, display_number'))

  test('every value comes off the locked row or from the actor', () => {
    for (const mapping of [
      'v_client', 'v_sub.submitted_by', 'v_sub.grand_total',
      'v_sub.gross_product_amount', 'v_actor',
    ]) {
      assert.ok(insert.includes(mapping), `${mapping} must be part of the mapping`)
    }
    assert.ok(insert.includes("coalesce(v_sub.order_confirmation_date, v_now::date)"),
      'the PI’s own confirmation date, with the approval date as the honest fallback')
  })

  test('the confirmed Order starts at running, stated rather than defaulted', () => {
    assert.ok(insert.includes("'running'"))
    assert.ok(read('20260702000000_retire_requested_order_status.sql').includes("alter column status set default 'running'"))
  })

  test('due_date and lead_source are left alone, and notes stays empty', () => {
    assert.ok(!insert.includes('due_date'),
      'dispatch_commitment is free text; a made-up delivery date is worse than none')
    assert.ok(!insert.includes('lead_source'), 'a PI records none')
    assert.ok(!insert.includes('notes'),
      'addresses, the breakdown and the advance terms live on the submission this Order names')
  })

  test('nothing about the mapping comes from a parameter', () => {
    assert.ok(!/p_client|p_total|p_status|p_display_number|p_number/.test(APPROVE))
  })

  test('provenance is written in the creating INSERT itself', () => {
    assert.ok(insert.includes('source_order_submission_id'))
    assert.ok(insert.includes('p_submission_id'))
  })
})

// ── 8. The trail ──────────────────────────────────────────────────────────────

describe('the history is append-only and records what happened', () => {
  test('the action set is widened by exactly two', () => {
    const constraint = code.slice(code.indexOf('add constraint order_submission_activity_action_check'))
    for (const action of [
      'submission_created', 'parse_replaced', 'submitted', 'changes_requested', 'rejected',
      'advance_exception_requested', 'advance_exception_approved', 'advance_exception_rejected',
      'finance_verified', 'approved',
    ]) {
      assert.ok(constraint.includes(`'${action}'`), `${action} must remain in the set`)
    }
  })

  test('the approval entry carries the Order id and its display number', () => {
    assert.ok(APPROVE.includes("'approved', 'submitted', 'approved'"))
    assert.ok(APPROVE.includes("'order_id',             v_order_id"))
    assert.ok(APPROVE.includes("'order_display_number', v_number"))
  })

  test('the Order gets its own provenance entry', () => {
    assert.ok(APPROVE.includes("'order_created_from_pi_submission'"))
    assert.ok(APPROVE.includes("'order_submission_id', p_submission_id"))
  })

  test('history is written only through the logger no role can execute', () => {
    assert.ok(APPROVE.includes('perform public.log_order_submission_activity('))
    assert.ok(VERIFY.includes('perform public.log_order_submission_activity('))
    assert.ok(!/insert into public\.order_submission_activity/.test(declarations))
    assert.ok(read(SUBMISSIONS).includes('revoke execute on function public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)\n  from public, anon, authenticated, service_role'))
  })

  test('no UPDATE or DELETE policy is added to the trail', () => {
    assert.ok(!/on public\.order_submission_activity[\s\S]{0,80}for (update|delete)/i.test(declarations))
  })
})

// ── 9. Security posture ───────────────────────────────────────────────────────

describe('the security posture matches every other write path in this feature', () => {
  test('both RPCs are SECURITY DEFINER with a pinned search_path', () => {
    for (const [name, body] of [['approve_order_submission', APPROVE], ['verify_pi_finance_check', VERIFY]] as const) {
      assert.ok(body.includes('security definer'), `${name} must be SECURITY DEFINER`)
      assert.ok(body.includes('set search_path = public, pg_temp'), `${name} must pin search_path`)
    }
    assert.ok(code.includes('these SECURITY DEFINER functions have a mutable search_path'),
      'and the migration asserts it at apply time')
  })

  test('both are revoked from public and anon, and granted only to authenticated', () => {
    for (const name of ['approve_order_submission(uuid)', 'verify_pi_finance_check(uuid)']) {
      assert.ok(code.includes(`revoke execute on function public.${name} from public, anon;`))
      assert.ok(code.includes(`grant  execute on function public.${name} to authenticated;`))
    }
  })

  test('every internal helper is executable by nobody', () => {
    for (const name of [
      'in_pi_submission_approval(uuid)',
      'order_submissions_guard_order_link()',
      'order_submissions_guard_finance_verification()',
      'prevent_order_source_submission_change()',
      'order_submissions_enforce_status_transition()',
    ]) {
      assert.ok(code.includes(`revoke execute on function public.${name}`), `${name} must be revoked`)
    }
    assert.ok(code.includes('these internal functions are executable by a client role'))
  })

  test('the migration proves at apply time that it approved and created nothing', () => {
    for (const assertion of [
      'a submission is already approved; this migration approves nothing',
      'an Order already names a PI submission; this migration creates none',
      'a submission is already finance-verified; this migration verifies nothing',
    ]) {
      assert.ok(code.includes(assertion), `missing apply-time assertion: ${assertion}`)
    }
  })

  test('it grants no permission to anybody', () => {
    assert.ok(!/insert into public\.employee_permission_overrides/i.test(declarations))
    assert.ok(!/insert into public\.role_permissions/i.test(declarations))
  })
})

// ── 10. Scope ─────────────────────────────────────────────────────────────────

describe('the phase stays inside its own boundary', () => {
  test('no document is generated, and none is promised', () => {
    assert.ok(!/create[\s\S]{0,40}(workbook|excel|pdf)/i.test(declarations))
    assert.ok(!declarations.includes('pdfkit'))
    assert.ok(!/orders\/.*\/versions\//.test(declarations),
      'the reserved versioned path stays reserved and unwritten')
  })

  test('nothing touches production tracking, amendments or dispatch', () => {
    for (const table of [
      'order_change_requests', 'order_requests', 'order_request_activity',
    ]) {
      assert.ok(!declarations.includes(table), `${table} is out of scope`)
    }
    assert.ok(!declarations.includes('amend_order'))
    assert.ok(!declarations.includes('cancel_order'))
  })

  test('it creates no order-items subsystem', () => {
    assert.ok(!/create table public\.order_(items|lines|products)/i.test(declarations),
      'Orders have never had product-line storage; the approved submission is the snapshot')
  })

  test('no existing Order is renumbered, restated or restatused', () => {
    assert.ok(!/update public\.orders\b/.test(declarations),
      'this file inserts one Order and updates none')
  })
})
