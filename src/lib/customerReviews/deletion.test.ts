/**
 * VERIFIER DELETION, AND ADD-VERSUS-REPLACE AT APPROVAL.
 *
 * What this file can and cannot prove, stated first because the split matters:
 *
 *   THIS FILE proves the CONTRACT — that the migration says what it must say,
 *   that the browser's copies of the authority rules match the database's, and
 *   that no screen offers a control the function would refuse. It reads source.
 *
 *   supabase/tests/customer_review_test_card_assertions.sql proves the
 *   BEHAVIOUR — that a deleted review is actually refused, actually invisible,
 *   and that a replacement actually leaves booked work alone — by executing
 *   against a real database with the real migrations applied.
 *
 * Neither substitutes for the other. An earlier round of this module shipped a
 * policy defect past 364 passing unit tests precisely because nothing executed
 * the SQL, and a text audit that "checks" a `for update` is reading a string.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/deletion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  availableActions,
  canBookCard,
  canDeleteCard,
  canUnbookCard,
  deletionSeverity,
  deletionWarning,
  replacementSummary,
} from './status'
import {
  TEST_CARD_AVAILABLE_COLUMNS,
  TEST_CARD_COLUMNS,
  TEST_CARD_DELETION_SOURCES,
  TEST_CARD_PENDING_COLUMNS,
  type TestCard,
  type TestCardStatus,
} from './types'

const ROOT = join(process.cwd())
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = read('supabase/migrations/20261030000000_review_workflow_deletion_and_replacement.sql')
const LEGACY = read('supabase/migrations/20261025000000_review_workflow_remove_legacy_test_data.sql')
const LIST = read('src/app/customer-reviews/TestCardListScreen.tsx')
const DETAIL = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
const PENDING = read('src/components/customerReviews/PendingBatches.tsx')
const DELETE_UI = read('src/components/customerReviews/DeleteReviews.tsx')
const CHOICE_UI = read('src/components/customerReviews/ApprovalChoice.tsx')

/**
 * Source with comments stripped, so a rule "found" in the SQL is a rule the
 * database will run rather than a sentence somebody wrote about it. Every text
 * assertion below that claims behaviour uses this.
 */
const executable = (source: string) =>
  source
    .split('\n')
    .filter(l => !l.trimStart().startsWith('--') && !l.trimStart().startsWith('//'))
    .join('\n')

const SQL = executable(MIGRATION)

/** The body of one plpgsql function, so a claim about it cannot match elsewhere. */
function fn(name: string): string {
  const at = SQL.indexOf(`create or replace function public.${name}(`)
  assert.ok(at >= 0, `${name} is not defined in the migration`)
  const end = SQL.indexOf('\n$$;', at)
  assert.ok(end > at, `${name} has no terminator`)
  return SQL.slice(at, end)
}

const card = (over: Partial<TestCard> = {}): TestCard => ({
  id: 'card-1',
  status: 'available' as TestCardStatus,
  card_ref: 'RW-000101',
  test_category: 'restaurant_test',
  test_title: 'A title',
  test_body: 'A body long enough to be a body.',
  batch_id: 'batch-1',
  review_type: 'text',
  // ASSIGNED TO THE CANDIDATE BY DEFAULT, because booking now requires it and
  // this file's subject is DELETION. A fixture assigned to nobody would make
  // every "not bookable" assertion here pass for the wrong reason — the
  // tombstone would be credited with a refusal the missing assignment had
  // already produced.
  assigned_to: HOLDER,
  assigned_at: '2026-09-01T09:00:00Z',
  assigned_by: 'user-verifier',
  image_group_id: null,
  approved_at: null,
  approved_by: null,
  draft_edited_at: null,
  draft_edited_by: null,
  booked_by: null,
  booked_at: null,
  whatsapp_opened_at: null,
  whatsapp_opened_count: 0,
  whatsapp_target_last_four: null,
  sent_confirmed_at: null,
  sent_confirmed_by: null,
  submitted_at: null,
  submitted_by: null,
  verified_at: null,
  verified_by: null,
  verification_note: null,
  returned_at: null,
  returned_by: null,
  return_reason: null,
  deleted_at: null,
  deleted_by: null,
  deleted_source: null,
  replaced_by_batch_id: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...over,
})

const HOLDER = 'user-holder'
const candidate = { userId: HOLDER, canUse: true, canVerify: false }
const verifier  = { userId: 'user-verifier', canUse: false, canVerify: true }
/** An administrator whose `verify` was revoked in Control Center. */
const revokedAdmin = { userId: 'user-admin', canUse: true, canVerify: false }

// ══ 1. DELETION IS SOFT, AND THAT IS A PROPERTY OF THE SQL ══════════════════

describe('deletion never removes a row, and never touches storage', () => {
  test('neither deletion function contains a DELETE or a storage reference', () => {
    for (const name of [
      'delete_customer_review_test_cards',
      'delete_all_customer_review_test_cards',
      'customer_review_replace_available',
    ]) {
      const body = fn(name)
      assert.equal(/delete\s+from/i.test(body), false, `${name} physically deletes rows`)
      assert.equal(/storage\./i.test(body), false, `${name} reaches into storage`)
    }
  })

  test('and the migration asserts the same thing about itself, at apply time', () => {
    // The grep runs over pg_proc, so it reads what was installed rather than
    // what this file says. A future edit that added a DELETE would fail the
    // migration rather than this test.
    assert.ok(SQL.includes("raise exception 'DELETION TOUCHES STORAGE OR DELETES ROWS: %()', v_name"))
  })

  test('a screenshot row is never removed by an ordinary deletion', () => {
    // The whole reason deletion is soft: storage.objects refuses a SQL delete,
    // so removing the row would strand the object it names.
    assert.equal(fn('delete_customer_review_test_cards')
      .includes('customer_review_test_card_screenshots'), false,
      'deletion reaches the screenshot table')
    assert.equal(fn('delete_all_customer_review_test_cards')
      .includes('customer_review_test_card_screenshots'), false)
  })

  test('THERE IS NO RESTORE, and the trigger makes one unexpressible', () => {
    assert.ok(SQL.includes('when (old.deleted_at is not null)'),
      'the freeze trigger is not conditional on the row already being deleted')
    assert.ok(SQL.includes('before update on public.customer_review_test_cards'))
    // Nothing anywhere sets deleted_at back to null.
    assert.equal(/deleted_at\s*=\s*null/i.test(SQL), false,
      'something clears deleted_at, which would be an un-delete')
  })

  test('the four tombstone columns travel together, or not at all', () => {
    assert.ok(SQL.includes('customer_review_test_cards_deletion_consistent'))
    assert.ok(SQL.includes('(deleted_at is null and deleted_by is null and deleted_source is null)'))
    assert.ok(SQL.includes("check (replaced_by_batch_id is null or deleted_source = 'replacement')"))
  })

  test('the recorded sources are exactly the four the browser knows', () => {
    assert.deepEqual([...TEST_CARD_DELETION_SOURCES],
      ['single', 'selected', 'all', 'replacement'])
    for (const s of TEST_CARD_DELETION_SOURCES) {
      assert.ok(SQL.includes(`'${s}'`), `${s} is not a value the CHECK allows`)
    }
  })
})

// ══ 2. THE AUDIT ROW CARRIES WHERE THE REVIEW WAS ═══════════════════════════

describe('the trail records what was thrown away, and from which stage', () => {
  test('deleted and replaced are event types, and both REQUIRE a prior status', () => {
    assert.ok(SQL.includes("'deleted',"))
    assert.ok(SQL.includes("'replaced'"))
    assert.ok(SQL.includes(
      "(event_type in ('deleted', 'replaced')\n        and previous_status is not null and new_status is null)"),
      'the deletion events do not require the stage the review was in')
  })

  test('THE EVENT IS WRITTEN BEFORE THE TOMBSTONE, or the trigger would refuse it', () => {
    // The freeze trigger refuses any UPDATE of an already-deleted row, so an
    // implementation that stamped deleted_at first and then tried to read
    // `status` for the event would be writing about a row it had just frozen.
    // Ordering is behaviour here, not style.
    for (const name of ['delete_customer_review_test_cards', 'delete_all_customer_review_test_cards',
                        'customer_review_replace_available']) {
      const body = fn(name)
      const insertAt = body.indexOf('insert into public.customer_review_test_card_events')
      const updateAt = body.indexOf('set deleted_at')
      assert.ok(insertAt > 0 && updateAt > 0, `${name} is missing the event or the tombstone`)
      assert.ok(insertAt < updateAt,
        `${name} stamps the tombstone before writing the event`)
    }
  })

  test('a replacement event names the batch that displaced the review', () => {
    const body = fn('customer_review_replace_available')
    assert.ok(body.includes("'replaced'"))
    assert.ok(body.includes('replaced_by_batch_id = p_batch_id'))
    assert.ok(body.includes('p_actor_id'), 'the replacement does not record who did it')
  })
})

// ══ 3. AUTHORITY: `verify`, RESOLVED, AT THREE LAYERS ═══════════════════════

describe('deleting needs the resolved verify permission and nothing else', () => {
  test('the browser mirror is verify and only verify', () => {
    assert.equal(canDeleteCard(verifier), true)
    assert.equal(canDeleteCard(candidate), false, 'a candidate was offered Delete')
    // THE CASE THE WHOLE ROLE CORRECTION EXISTS FOR: an administrator holds
    // `use` and would hold `verify`, but theirs was revoked in Control Center.
    // There is no isAdmin field to consult, which is what makes this true by
    // construction rather than by remembering to check.
    assert.equal(canDeleteCard(revokedAdmin), false,
      'an administrator whose verify was revoked was offered Delete')
    assert.equal(canDeleteCard({ userId: null, canVerify: true }), false)
  })

  test('a candidate holding the review still cannot delete it', () => {
    // Releasing a booking is the candidate's action; removing the review from
    // the workflow is a judgement about the text, which is not theirs.
    assert.equal(canDeleteCard({ userId: HOLDER, canVerify: false }), false)
  })

  test('both functions resolve verify from the engine, with no role branch', () => {
    for (const name of ['delete_customer_review_test_cards',
                        'delete_all_customer_review_test_cards',
                        'customer_review_deletion_summary']) {
      const body = fn(name)
      assert.ok(body.includes("resolve_permission(v_uid, 'customer_review_requests', 'verify')")
        || body.includes('can_verify_customer_review_test_cards()'),
        `${name} does not resolve verify`)
      assert.equal(/u\.role|users\.role|'admin'/.test(body), false,
        `${name} consults a role`)
    }
  })

  test('an inactive account is refused before the permission is considered', () => {
    for (const name of ['delete_customer_review_test_cards',
                        'delete_all_customer_review_test_cards']) {
      assert.ok(fn(name).includes('u.is_active'), `${name} does not check is_active`)
    }
  })

  test('the migration greps the installed catalog for a role bypass', () => {
    assert.ok(SQL.includes("raise exception 'ROLE BYPASS: %() consults a role', v_name"))
    for (const name of ['delete_customer_review_test_cards',
                        'delete_all_customer_review_test_cards',
                        'customer_review_replace_available',
                        'approve_customer_review_drafts']) {
      assert.ok(SQL.includes(`'${name}',`) || SQL.includes(`'${name}'\n`),
        `${name} is not covered by the apply-time role grep`)
    }
  })

  test('neither function is reachable by anon, and the helper by nobody', () => {
    assert.ok(SQL.includes('revoke execute on function public.delete_customer_review_test_cards(uuid[], text) from public, anon;'))
    assert.ok(SQL.includes('revoke execute on function public.delete_all_customer_review_test_cards() from public, anon;'))
    // The replacement helper is an internal step of a definer function that has
    // already resolved `verify`. Granting it would be a third door onto the
    // same write.
    assert.ok(SQL.includes('revoke execute on function public.customer_review_replace_available(uuid, uuid) from public, anon, authenticated;'))
    assert.equal(SQL.includes('grant  execute on function public.customer_review_replace_available'), false,
      'the replacement helper is callable in its own right')
  })

  test('and it is not security definer, so it cannot be a door at all', () => {
    assert.equal(fn('customer_review_replace_available').includes('security definer'), false)
  })
})

// ══ 4. A DELETED REVIEW IS REFUSED BY EVERY EXISTING ACTION ═════════════════

describe('every workflow action names deleted_at explicitly', () => {
  const GUARDED = [
    'book_customer_review_test_card',
    'unbook_customer_review_test_card',
    'transition_customer_review_test_card',
    'confirm_customer_review_test_card_sent',
    'record_customer_review_test_card_whatsapp_opened',
    'begin_customer_review_test_screenshot_removal',
    'assert_customer_review_test_card_submittable',
    'revise_customer_review_draft_batch',
    'approve_customer_review_drafts',
    'approve_customer_review_draft_batch',
    'can_view_customer_review_test_card',
  ]

  for (const name of GUARDED) {
    test(`${name} refuses a deleted review`, () => {
      assert.ok(fn(name).includes('deleted_at'), `${name} does not mention deleted_at`)
    })
  }

  test('and the migration asserts that list at apply time', () => {
    assert.ok(SQL.includes("raise exception 'GUARD MISSING: %() does not mention deleted_at', v_name"))
    for (const name of GUARDED) {
      assert.ok(SQL.includes(`      '${name}',`) || SQL.includes(`      '${name}'\n`),
        `${name} is not in the apply-time guard list`)
    }
  })

  test('BOOKING IS THE ONE THAT NEEDED A CLAUSE IN THE CLAIM ITSELF', () => {
    // Soft deletion does not move the status, so `where status = 'available'`
    // matches a deleted-but-available row. Without this the conditional UPDATE
    // that claims a card would hand a candidate a review a verifier deleted.
    const body = fn('book_customer_review_test_card')
    const claim = body.slice(body.indexOf('update public.customer_review_test_cards'))
    assert.ok(claim.includes("and status = 'available'"))
    assert.ok(claim.includes('and deleted_at is null'),
      'the booking claim can still match a deleted review')
  })

  test('and it tells the candidate which of the three things happened', () => {
    const body = fn('book_customer_review_test_card')
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_NOT_FOUND'))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_DELETED'))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_ALREADY_BOOKED'))
  })

  test('the freeze trigger is the backstop for anything not on that list', () => {
    assert.ok(SQL.includes('customer_review_test_cards_freeze_deleted'))
    assert.ok(SQL.includes("raise exception 'CUSTOMER_REVIEW_TEST_DELETED: % was deleted and can no longer be changed', old.card_ref"))
  })

  test('and no new screenshot can be attached to a deleted review', () => {
    assert.ok(SQL.includes('customer_review_screenshot_rejects_deleted'))
    assert.ok(SQL.includes('before insert on public.customer_review_test_card_screenshots'))
  })

  test('NEITHER TRIGGER FUNCTION IS CALLABLE BY NAME', () => {
    // Postgres grants EXECUTE to PUBLIC on a new function, which would put both
    // of these on the list of things a browser session can call. The trigger is
    // unaffected — EXECUTE is checked when a trigger is created, not when it
    // fires — and the assertions file's browser-callable allow-list is what
    // catches this if it is ever missed again.
    for (const t of ['customer_review_test_cards_freeze_deleted',
                     'customer_review_screenshot_rejects_deleted']) {
      assert.ok(SQL.includes(`revoke execute on function public.${t}()\n  from public, anon, authenticated;`),
        `${t} is still callable by an authenticated session`)
    }
  })
})

describe('the browser refuses a deleted review too, wherever it decides', () => {
  test('no action is offered on one, at any stage, to anybody', () => {
    for (const status of ['available', 'booked', 'submitted'] as TestCardStatus[]) {
      const dead = card({ status, booked_by: HOLDER, deleted_at: '2026-09-01T10:00:00Z' })
      assert.deepEqual(availableActions(dead, candidate), [], status)
      assert.deepEqual(availableActions(dead, { ...verifier, canUse: true }), [], status)
    }
  })

  test('a deleted AVAILABLE review is not bookable, though its status still says available', () => {
    const dead = card({ status: 'available', deleted_at: '2026-09-01T10:00:00Z' })
    assert.equal(dead.status, 'available', 'the fixture no longer exercises the real case')
    assert.equal(canBookCard(dead, candidate), false,
      'a deleted review was offered Book because its status is still available')
    // The live one is bookable, so the refusal above is the tombstone doing it.
    assert.equal(canBookCard(card({ status: 'available' }), candidate), true)
  })

  test('a deleted booking cannot be unbooked back into the pool', () => {
    const dead = card({ status: 'booked', booked_by: HOLDER, deleted_at: '2026-09-01T10:00:00Z' })
    assert.equal(canUnbookCard(dead, candidate), false)
    // The same card, live, IS unbookable — so the refusal is the deletion.
    assert.equal(canUnbookCard(card({ status: 'booked', booked_by: HOLDER }), candidate), true)
  })
})

// ══ 5. IT LEAVES EVERY LIST, AND ITS URL ════════════════════════════════════

describe('a deleted review is gone from the frontend', () => {
  test('every list query filters it out', () => {
    const code = executable(LIST)
    assert.ok(code.includes(".is('deleted_at', null)"),
      'the list query does not exclude deleted reviews')
    // The two head counts as well, or a verifier would see a pending badge for
    // drafts that no longer exist and a Replace would promise the wrong number.
    const counts = code.split("count: 'exact'")
    assert.ok(counts.length >= 3, 'the two head counts are gone')
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i].slice(0, 400).includes(".is('deleted_at', null)"),
        'a head count still includes deleted reviews')
    }
  })

  test('the direct URL becomes unavailable, the same way a verified one does', () => {
    const code = executable(DETAIL)
    assert.ok(code.includes('.deleted_at) {\n      setNotFound(true)')
      || /deleted_at\)\s*\{\s*\n\s*setNotFound\(true\)/.test(code),
      'the detail screen still renders a deleted review')
  })

  test('RLS is what stops a candidate, and the query is what stops a verifier', () => {
    // Two different mechanisms doing two different jobs, and the policy says so.
    assert.ok(SQL.includes('customer_review_test_cards.deleted_at is null\n      and public.can_use_customer_review_test_cards()'))
    assert.ok(SQL.includes('customer_review_test_cards.deleted_at is not null\n      and public.can_verify_customer_review_test_cards()'))
    assert.ok(SQL.includes("raise exception 'customer_review_test_cards_select does not filter deleted rows'"))
  })

  test('the tombstone stays readable to a verifier, which is the point of keeping it', () => {
    assert.ok(SQL.includes('can_verify_customer_review_test_cards'))
    assert.ok(SQL.includes("raise exception 'customer_review_test_cards_select does not gate the tombstone on verify'"))
  })

  test('AND STILL NO WRITE POLICY EXISTS ON THE TABLE', () => {
    // The module's central structural claim. Deletion is a definer function; if
    // it had been done with a policy instead, this is what would catch it.
    assert.ok(SQL.includes("raise exception 'a write policy appeared on customer_review_test_cards'"))
    assert.ok(SQL.includes("and pol.polcmd <> 'r'"))
  })

  test('the tombstone columns are selected, so the screen can tell', () => {
    for (const c of ['deleted_at', 'deleted_by', 'deleted_source', 'replaced_by_batch_id']) {
      assert.ok(TEST_CARD_COLUMNS.includes(c), `${c} is not selected by the detail query`)
    }
    assert.ok(TEST_CARD_AVAILABLE_COLUMNS.includes('deleted_at'))
    assert.ok(TEST_CARD_PENDING_COLUMNS.includes('deleted_at'))
  })
})

// ══ 6. ATOMICITY: ALL OF A SET, OR NONE OF IT ═══════════════════════════════

describe('a group deletion cannot come apart', () => {
  test('every named row is locked in id order before anything is decided', () => {
    const body = fn('delete_customer_review_test_cards')
    assert.ok(body.includes('order by id\n       for update'),
      'the selection is not locked in id order')
    assert.ok(body.indexOf('for update') < body.indexOf('set deleted_at'),
      'rows are written before they are locked')
  })

  test('an already-deleted member refuses the whole call', () => {
    const body = fn('delete_customer_review_test_cards')
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_ALREADY_DELETED'))
    assert.ok(body.includes('nothing was changed'))
    // Rechecked AFTER the lock, which is the only place the check means
    // anything — before it, the answer can be stale by the time it is used.
    const lockAt = body.indexOf('for update')
    const checkAt = body.indexOf('and deleted_at is not null')
    assert.ok(checkAt > lockAt, 'the staleness check runs before the lock')
  })

  test('a missing member refuses the whole call too', () => {
    const body = fn('delete_customer_review_test_cards')
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_NOT_FOUND'))
    assert.ok(body.includes('nothing was deleted'))
  })

  test('the written count is checked against the asked count', () => {
    // A partial write is not expressible: if the two differ the function raises
    // and the transaction takes the difference with it.
    const body = fn('delete_customer_review_test_cards')
    assert.ok(body.includes('get diagnostics v_deleted = row_count;'))
    assert.ok(body.includes('if v_deleted <> v_asked then'))
  })

  test('REPEATED TAPS ARE ONE DELETION, not two tombstones', () => {
    const body = fn('delete_customer_review_test_cards')
    // The second call finds the row already deleted and raises, so the original
    // actor and timestamp survive rather than being overwritten by whoever
    // pressed last.
    assert.ok(body.includes('and deleted_at is null'),
      'the tombstone update can overwrite an existing one')
  })

  test('duplicate ids in one request are one review, not two', () => {
    assert.ok(fn('delete_customer_review_test_cards')
      .includes('select array_agg(distinct x) into v_ids'))
  })

  test('delete-all chooses and locks its set INSIDE the transaction', () => {
    const body = fn('delete_all_customer_review_test_cards')
    assert.ok(body.includes('where deleted_at is null\n       order by id\n         for update'),
      'delete-all does not lock the set it is about to write')
    // It takes no id list and no expected count: a number the browser supplied
    // could only ever refuse a deletion the verifier still wants.
    assert.ok(SQL.includes('create or replace function public.delete_all_customer_review_test_cards()'),
      'delete-all takes arguments, so the browser can steer which rows it hits')
  })

  test('and it returns exact counts, by stage', () => {
    for (const name of ['delete_customer_review_test_cards', 'delete_all_customer_review_test_cards']) {
      const body = fn(name)
      assert.ok(body.includes("'deleted',          count(*)"))
      for (const stage of ['pending_approval', 'available', 'booked', 'sent', 'submitted', 'verified']) {
        assert.ok(body.includes(`'${stage}',`), `${name} does not count ${stage}`)
      }
    }
  })

  test('the confirmation summary is read-only and verify-gated', () => {
    const body = fn('customer_review_deletion_summary')
    assert.ok(body.includes('stable'), 'the summary is not declared stable')
    assert.equal(/insert |update |delete /i.test(body), false, 'the summary writes')
    assert.ok(body.includes('can_verify_customer_review_test_cards()'))
    assert.ok(body.includes("where deleted_at is null"))
  })
})

// ══ 7. ADD VERSUS REPLACE ═══════════════════════════════════════════════════

describe('the approval functions take an explicit choice', () => {
  test('the single-argument signatures are DROPPED, not shadowed', () => {
    // Two PostgREST overloads differing only by a defaulted argument is
    // PGRST203 — it cannot choose one — and a superseded definer function a
    // service-role caller can still reach is a second door with the old lock.
    assert.ok(SQL.includes('drop function if exists public.approve_customer_review_drafts(uuid[]);'))
    assert.ok(SQL.includes('drop function if exists public.approve_customer_review_draft_batch(uuid);'))
    assert.ok(SQL.includes("raise exception 'the one-argument approve_customer_review_drafts is still callable'"))
  })

  test('p_replace has no default, so every caller states its intent', () => {
    assert.ok(SQL.includes('  p_card_ids uuid[],\n  p_replace  boolean\n)'))
    assert.ok(SQL.includes('  p_batch_id uuid,\n  p_replace  boolean\n)'))
    assert.equal(/p_replace\s+boolean\s+default/.test(SQL), false,
      'p_replace has a default, which is the PGRST203 shape')
  })

  test('and a null choice is refused rather than guessed', () => {
    for (const name of ['approve_customer_review_drafts', 'approve_customer_review_draft_batch']) {
      assert.ok(fn(name).includes('if p_replace is null then'), name)
    }
  })

  test('both return the two counts the screen reports', () => {
    for (const name of ['approve_customer_review_drafts', 'approve_customer_review_draft_batch']) {
      assert.ok(fn(name).includes("jsonb_build_object('approved'"), name)
      assert.ok(fn(name).includes("'replaced'"), name)
    }
  })
})

describe('Replace displaces the available list and nothing else', () => {
  const body = fn('customer_review_replace_available')

  test('it selects available, live rows only', () => {
    assert.ok(body.includes("where status = 'available'\n         and deleted_at is null"),
      'the displaced set is not scoped to live available reviews')
  })

  test('BOOKED, SENT, SUBMITTED AND VERIFIED ARE NEVER IN THE SET', () => {
    // Proven by what the predicate says rather than by listing exclusions: a
    // status equality cannot match four other statuses. The disposable-database
    // assertions execute this against real rows of every stage.
    assert.equal(/status\s*in\s*\(/.test(body), false,
      'the displaced set matches more than one status')
    assert.equal(body.includes("'booked'"), false)
    assert.equal(body.includes("'submitted'"), false)
    assert.equal(body.includes("'verified'"), false)
  })

  test('and pending drafts are never in it either — in ANY batch', () => {
    assert.equal(body.includes("'pending_approval'"), false,
      'the replacement can reach a pending draft')
    // THE PREDICATE THAT CHOOSES THE SET, read on its own. `p_batch_id` appears
    // later in the function because the tombstone records which batch displaced
    // these rows — that is the write, not the selection, and scoping the
    // SELECTION by batch would be a different (wrong) meaning of Replace.
    const chooses = body.slice(body.indexOf('select array_agg'), body.indexOf(') c;'))
    assert.equal(chooses.includes('batch_id'), false,
      'the displaced set is scoped by batch, which is not what Replace means')
  })

  test('an already-deleted review is not re-deleted', () => {
    assert.ok(body.includes('and deleted_at is null'))
  })

  test('THE DISPLACEMENT HAPPENS BEFORE THE APPROVAL, in both entry points', () => {
    // Order is load-bearing rather than stylistic: displacing after approving
    // would delete the very reviews the call has just published.
    for (const name of ['approve_customer_review_drafts', 'approve_customer_review_draft_batch']) {
      const b = fn(name)
      const replaceAt = b.indexOf('customer_review_replace_available(')
      const approveAt = b.indexOf("set status      = 'available'")
      assert.ok(replaceAt > 0 && approveAt > 0, name)
      assert.ok(replaceAt < approveAt,
        `${name} approves before it displaces, so it would delete its own approvals`)
    }
  })

  test('a selection spanning two batches cannot record one replacement batch', () => {
    const b = fn('approve_customer_review_drafts')
    assert.ok(b.includes('select count(distinct batch_id), (array_agg(distinct batch_id))[1]'))
    assert.ok(b.includes('a replacement must come from one batch'))
    // NOT min(): there is no min(uuid) in Postgres. The first version of that
    // line used one, parsed cleanly, and failed the first time a Replace was
    // actually executed against a database.
    assert.equal(/min\(batch_id\)/.test(b), false)
  })

  test('a stale selection refuses everything, replacement included', () => {
    const b = fn('approve_customer_review_drafts')
    // The recheck names BOTH conditions, because deletion does not move status.
    assert.ok(b.includes("and (status <> 'pending_approval' or deleted_at is not null)"))
    assert.ok(b.includes('nothing was approved'))
    // And it happens before the replacement, so a refusal displaces nothing.
    assert.ok(b.indexOf('CUSTOMER_REVIEW_TEST_NOT_PENDING')
      < b.indexOf('customer_review_replace_available('),
      'the staleness check runs after the displacement')
  })

  test('the approval writes only pending, live rows', () => {
    for (const name of ['approve_customer_review_drafts', 'approve_customer_review_draft_batch']) {
      assert.ok(fn(name).includes("and status = 'pending_approval'\n     and deleted_at is null"), name)
    }
  })

  test('nothing rewrites the text a verifier approved', () => {
    // Approval publishes what was read. A function that touched test_title or
    // test_body here would be approving something else.
    for (const name of ['approve_customer_review_drafts', 'approve_customer_review_draft_batch']) {
      const b = fn(name)
      assert.equal(/set[\s\S]{0,200}test_title/.test(b), false, `${name} rewrites the title`)
      assert.equal(b.includes('test_body'), false, `${name} rewrites the body`)
    }
  })
})

// ══ 8. WHAT THE SCREENS OFFER ═══════════════════════════════════════════════

describe('the interface asks the choice at approval, every time', () => {
  test('the choice is not asked at generation', () => {
    const gen = executable(read('src/components/customerReviews/GenerateDrafts.tsx'))
    assert.equal(/ApprovalChoice|p_replace|'replace'/.test(gen), false,
      'the generator asks about replacing, before anybody has read a draft')
  })

  test('it is rendered inside the approval confirmation', () => {
    assert.ok(PENDING.includes('<ApprovalChoiceCards'))
    assert.ok(PENDING.includes('mode={mode}'))
  })

  test('ADD IS THE DEFAULT, and it is reset for every confirmation', () => {
    assert.ok(PENDING.includes("useState<ApprovalMode>('add')"))
    assert.ok(PENDING.includes("setMode('add')\n      setConfirm(next)"),
      'opening a confirmation does not reset the choice')
  })

  test('approving one review goes through the same confirmation', () => {
    // It used to be a bare tap. Every approval now has to answer the question,
    // so a single approval cannot silently mean "add".
    assert.ok(PENDING.includes("openConfirm({ kind: 'one', count: 1, ids: [card.id] })"))
  })

  test('the primary action names the outcome, not just the count', () => {
    assert.ok(PENDING.includes('Approve ${confirm.count} and replace the list'))
    assert.ok(PENDING.includes('Approve ${confirm.count} and keep the list'))
  })

  test('the modal states both numbers and what survives', () => {
    assert.ok(CHOICE_UI.includes('approveCount'))
    assert.ok(CHOICE_UI.includes('availableCount'))
    assert.ok(CHOICE_UI.includes('booked, sent, submitted or verified are not touched'))
  })

  test('and the browser never sends a boolean it was not given', () => {
    assert.ok(LIST.includes("p_replace: mode === 'replace'"))
  })
})

describe('deletion controls are placed where they cannot be hit by accident', () => {
  test('candidates are never rendered one', () => {
    // The card's Delete moved with the card: ReviewCard takes a `secondary`
    // slot, and the queue fills it only for a resolved verify holder.
    assert.ok(LIST.includes('canDeleteCard({ userId: profile?.id ?? null, canVerify: caps.canVerify })'))
    assert.ok(LIST.includes('{caps.canVerify && !listLoading && (\n          <DeleteAllReviewsBar'))
    assert.ok(DETAIL.includes('canDeleteCard({ userId: profile?.id ?? null, canVerify: caps.canVerify })'))
  })

  test('single delete is a secondary control, never a primary button', () => {
    assert.ok(DELETE_UI.includes('className="boe-btn boe-btn-ghost"'))
    assert.equal(DELETE_UI.includes('boe-btn-primary'), false,
      'a delete control is styled as the primary action')
  })

  test('Delete all is separated from generation and approval by a rule', () => {
    assert.ok(DELETE_UI.includes('borderTop: `1px solid ${colors.border}`'))
    // It is the last thing on the page, after the list — not a neighbour of the
    // generate panel at the top.
    // Delete all is the LAST thing on the queue page, below the cards. The
    // generator is no longer on this page at all — it lives on Batches — so
    // the ordering is asserted against the list it sits under.
    assert.ok(LIST.indexOf('<DeleteAllReviewsBar') > LIST.indexOf('<ReviewCardGrid>'))
    assert.ok(LIST.indexOf('<DeleteAllReviewsBar') > LIST.indexOf('<PendingBatches'))
  })

  test('Delete all needs a typed phrase, not a second tap', () => {
    assert.ok(DELETE_UI.includes("export const DELETE_ALL_PHRASE = 'DELETE ALL'"))
    assert.ok(DELETE_UI.includes('const armed = typed.trim().toUpperCase() === DELETE_ALL_PHRASE'))
    assert.ok(DELETE_UI.includes('disabled={busy || !armed'))
  })

  test('and the phrase is DISARMED the moment it is used', () => {
    // Clearing on press rather than on open, so a refusal — and every refusal
    // here is the database saying the world moved — leaves the button needing
    // the phrase typed again instead of one tap away from firing.
    assert.ok(DELETE_UI.includes("const confirmAndDisarm = () => { setTyped(''); onConfirm() }"))
    assert.ok(DELETE_UI.includes('onClick={confirmAndDisarm}'))
    // AND NO EFFECT RE-ESTABLISHES IT. The parent unmounts the sheet on cancel
    // and on success, so useState() already starts it empty; an effect calling
    // setState to say the same thing is the cascading render that
    // react-hooks/set-state-in-effect exists to catch.
    assert.equal(DELETE_UI.includes('useEffect'), false,
      'the delete sheet reintroduced an effect')
  })

  test('the counts behind Delete all are re-read, not taken from the tab', () => {
    // No tab reads `verified` rows by design, so a browser-side total would
    // leave part of "everything" out.
    assert.ok(LIST.includes("supabase.rpc('customer_review_deletion_summary')"))
    assert.ok(DELETE_UI.includes('Verified'))
  })

  test('a single delete is never one tap either', () => {
    assert.ok(LIST.includes('setDeleting({ cards: targets, source })'))
    assert.ok(LIST.includes('{deleting && (\n        <DeleteReviewsSheet'))
    assert.ok(DETAIL.includes('setDeleting(true)'))
  })

  test('every control clears 44px', () => {
    const heights = [...DELETE_UI.matchAll(/minHeight: '(\d+)px'/g)].map(m => Number(m[1]))
    assert.ok(heights.length > 0)
    for (const h of heights) assert.ok(h >= 44, `a control is ${h}px`)
    const choice = [...CHOICE_UI.matchAll(/minHeight: '(\d+)px'/g)].map(m => Number(m[1]))
    for (const h of choice) assert.ok(h >= 44, `a choice card is ${h}px`)
  })
})

// ══ 9. THE WORDING A VERIFIER READS ═════════════════════════════════════════

describe('the confirmation names the person, not the state', () => {
  test('an untouched review warns about nothing', () => {
    assert.equal(deletionWarning(card({ status: 'available' })), null)
    assert.equal(deletionWarning(card({ status: 'pending_approval' })), null)
    assert.equal(deletionSeverity(card({ status: 'available' })), 'unstarted')
  })

  test('a held review says somebody is holding it', () => {
    const held = card({ status: 'booked', booked_by: HOLDER })
    assert.equal(deletionSeverity(held), 'held')
    assert.match(deletionWarning(held)!, /holding this review right now/)
  })

  test('a SENT review says it reached a real recipient', () => {
    const sent = card({ status: 'booked', booked_by: HOLDER, sent_confirmed_at: '2026-09-01T09:00:00Z' })
    assert.equal(deletionSeverity(sent), 'sent')
    assert.match(deletionWarning(sent)!, /SENT this review to a real recipient/)
  })

  test('submitted and verified are the heaviest too', () => {
    assert.equal(deletionSeverity(card({ status: 'submitted' })), 'sent')
    assert.equal(deletionSeverity(card({ status: 'verified' })), 'sent')
    assert.match(deletionWarning(card({ status: 'submitted' }))!, /verification/)
  })

  test('Replace explains an empty pool rather than saying "0"', () => {
    assert.match(replacementSummary(0), /nothing to replace/)
    assert.match(replacementSummary(1), /The 1 review/)
    assert.match(replacementSummary(6), /The 6 reviews/)
  })

  test('NO SENTENCE LOSES ITS SPACE AFTER AN EXPRESSION', () => {
    // Next 16.2.6 drops the LEADING space of a JSX text node that contains an
    // HTML entity when that node follows an inline expression. It is invisible
    // in the source and obvious on screen: this sheet rendered "It
    // disappearsfrom every list" on a phone until the space was made explicit.
    //
    // THE RULE: an expression followed by a text node carrying an entity is
    // only safe when the space between them is written as {' '}.
    const files: [string, string][] = [['DeleteReviews', DELETE_UI], ['ApprovalChoice', CHOICE_UI]]
    // THE LOOKBEHIND IS WHAT MAKES THIS A TEST RATHER THAN A TRIPWIRE. A text
    // node that follows an explicit {' '} is exactly the correct form, and it
    // matches the same shape otherwise — so the correct form is excluded and
    // only the silent one is reported.
    const RISKY = /(?<!\{' ')\}\r?\n\s+[A-Za-z][^<>{}]*&[a-z]+;/g
    for (const [name, src] of files) {
      const hits = [...src.matchAll(RISKY)].map(m => m[0].slice(0, 60))
      assert.deepEqual(hits, [],
        `${name}: a text node carrying an entity follows an expression with no explicit space`)
    }
  })

  test('and the sheet never promises a permanent deletion', () => {
    // It is not one, and saying so would be a promise the module does not keep.
    // Read the RENDERED text, not the comments — the file explains at length
    // why it avoids that phrasing, and the explanation contains the phrase.
    assert.equal(/permanently deleted|deleted forever|gone for good/i.test(executable(DELETE_UI)), false)
    assert.ok(DELETE_UI.includes('audit trail'))
  })
})

// ══ 10. THE LEGACY MIGRATION'S GUARD, AFTER THE CORRECTION ══════════════════

describe('the legacy cleanup pins what cannot drift, and reports what can', () => {
  const legacy = executable(LEGACY)

  test('the 15-available / 1-booked split is no longer required', () => {
    assert.equal(legacy.includes('v_available <> 15'), false,
      'the guard still pins a split the product legitimately moves')
    assert.equal(legacy.includes('expected 15 available and 1 booked'), false)
  })

  test('the reference set is pinned exactly, RW-000002 absent', () => {
    assert.ok(legacy.includes("'TEST-002',"))
    assert.ok(legacy.includes("'RW-000001', 'RW-000003',"),
      'RW-000002 is in the expected set, but TEST-002 is the card that would carry it')
    assert.equal(/'RW-000002'/.test(legacy), false)
    // A symmetric difference, so an extra card fails as loudly as a missing one.
    assert.ok(legacy.includes('except'))
  })

  test('sixteen cards, none batched, no batch rows', () => {
    assert.ok(legacy.includes('if v_cards <> 16 then'))
    assert.ok(legacy.includes('if v_batches <> 0 then'))
    assert.ok(legacy.includes('where batch_id is not null'))
  })

  test('a submitted, verified or returned card blocks it', () => {
    assert.ok(legacy.includes("count(*) filter (where status not in ('available', 'booked'))"))
    assert.ok(legacy.includes('if v_other <> 0 then'))
    assert.ok(legacy.includes('or returned_at is not null'))
  })

  test('A SEND CONFIRMATION BLOCKS IT, and that is the new rule', () => {
    assert.ok(legacy.includes('where sent_confirmed_at is not null'))
    assert.ok(legacy.includes('REVIEW_WORKFLOW_LEGACY_SEND_CONFIRMED'))
  })

  test('whatsapp_opened alone does NOT block it', () => {
    // Opening a link is not a claim that anything was sent, and the module has
    // never read it as one. Reading it as one here would contradict the rest.
    assert.equal(/if\s+v_\w*open|whatsapp_opened_at is not null/.test(legacy), false,
      'the guard blocks on a WhatsApp open, which is not evidence of a send')
  })

  test('a screenshot row blocks it, and so does a stray storage object', () => {
    assert.ok(legacy.includes('REVIEW_WORKFLOW_LEGACY_SCREENSHOT'))
    assert.ok(legacy.includes('REVIEW_WORKFLOW_LEGACY_STORAGE'))
    assert.ok(legacy.includes("where bucket_id = 'customer-review-test-screenshots'"))
  })

  test('an empty database is still a clean no-op', () => {
    assert.ok(legacy.includes('if v_cards = 0 and v_batches = 0 then'))
    assert.ok(legacy.includes('SKIP  review-workflow legacy data'))
  })

  test('and it still deletes exactly sixteen, from one table', () => {
    assert.ok(legacy.includes('delete from public.customer_review_test_cards;'))
    assert.ok(legacy.includes('if v_deleted <> 16 then'))
    assert.equal((legacy.match(/delete from/g) ?? []).length, 1,
      'the legacy cleanup deletes from more than one table')
  })
})
