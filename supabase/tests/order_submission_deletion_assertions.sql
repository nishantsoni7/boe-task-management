-- Permanent PI deletion assertions
-- ===========================================================================
-- Covers 20260914000000_order_submission_permanent_deletion.sql: an owner or an
-- administrator erasing one PI submission and everything that belongs solely to
-- it, nobody else erasing anything, and — the reason this design exists — no
-- sequence of events leaving a live PI whose files have been destroyed.
--
--   A. the allow-list, and what is deliberately not in it
--   B. the owner deletes their own draft, returned and rejected PIs
--   C. an administrator deletes somebody else's eligible PI
--   D. everybody else is refused — including every permission that looks close
--   E. a PI under review is untouchable, admin included
--   F. approved, and any state not on the allow-list, fails closed
--   G. the children go, and nothing else does
--   H. direct SQL cannot bypass any of it
--   I. the storage keys are reported, and no object is removed by the database
--   J. repeat clicks, and rows that are already gone
--   K. THE RESERVATION: a claimed PI cannot be submitted, replaced, reviewed or
--      transitioned by anybody, through any route
--   L. failure, release, retry, staleness and takeover
--   M. claims cannot be forged, borrowed or replayed
--   N. no approval, no number, no payment, and no advance behaviour changed
--   O. privileges — nothing internal became callable by a client role
--   P. A RECORD THAT MUST SURVIVE refuses the deletion — an allocated payment
--      and a correction request, demonstrated; every such reference, including
--      a Confirmed Order's, enumerated from the catalog — and it refuses
--      without destroying, releasing or changing anything
--
-- THE INVARIANT SECTIONS K–M EXIST FOR. Storage and Postgres cannot share a
-- transaction, so the files are removed between two database calls. If an
-- ordinary status change could slip into that gap, the second call would be
-- correctly refused and a VALID SUBMITTED PI WOULD SURVIVE WITH ITS WORKBOOK AND
-- IMAGES DESTROYED. The reservation closes the gap rather than narrowing it, and
-- these sections prove the gap is closed rather than small.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded and nothing is left behind.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may set session GUCs and owns the tables
--     (standard Supabase `postgres`).
--   * Replace the SIX real user UUIDs below; all must exist, be active and be
--     distinct:
--       test.owner     a NON-admin who holds orders.view + orders.create.
--                      Owns the fixture submissions.
--       test.other     a NON-admin colleague with orders.view and nothing else.
--       test.viewall   a NON-admin holding orders.view + orders.view_all.
--       test.reviewer  a NON-admin holding orders.view + orders.approve_order.
--       test.approver  a NON-admin holding orders.view +
--                      orders.approve_advance_exception.
--       test.admin     a public.users row with role = 'admin', is_active.
--
--   The script GRANTS those permissions itself through
--   employee_permission_overrides and removes them on rollback, so the six
--   accounts need no prior configuration beyond existing and being active.
--
-- Every guard under test is a trigger or a SECURITY DEFINER function, so this
-- script simulates the session with request.jwt.claims rather than SET ROLE —
-- the same idiom the other assertion scripts in this directory use.
--
-- SECTION P IS THE EXCEPTION TO THE LINE BELOW, and deliberately narrow: it
-- inserts one payment and one allocation of its own, entirely inside this
-- transaction, because the defect it pins down is a foreign key from Finance
-- into Orders and cannot be demonstrated without one. It approves nothing, links
-- nothing to a real record, and rolls back with everything else.
--
-- NOTHING HERE PAYS OR APPROVES ANYBODY. No payment table is read or written, no
-- finance record is created, and no submission reaches 'approved' by any route
-- the product offers — section F reaches it only by suspending the transition
-- trigger for one insert, inside this transaction, to prove that a state the
-- product cannot yet produce is already refused.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ────────────────────────────────────
do $$
begin
  perform set_config('test.owner',    '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.other',    '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.viewall',  '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('test.reviewer', '44444444-4444-4444-4444-444444444444', true); -- REPLACE
  perform set_config('test.approver', '55555555-5555-5555-5555-555555555555', true); -- REPLACE
  perform set_config('test.admin',    '66666666-6666-6666-6666-666666666666', true); -- REPLACE
end $$;

do $$
declare
  v_ids uuid[] := array[
    current_setting('test.owner')::uuid,
    current_setting('test.other')::uuid,
    current_setting('test.viewall')::uuid,
    current_setting('test.reviewer')::uuid,
    current_setting('test.approver')::uuid,
    current_setting('test.admin')::uuid
  ];
begin
  assert (select count(distinct id) from public.users
           where id = any (v_ids) and is_active
             and coalesce(is_deleted, false) = false) = 6,
    'the six configured user ids must all exist, be active and be distinct — replace the placeholders';
  assert (select role = 'admin' from public.users where id = current_setting('test.admin')::uuid),
    'test.admin must be an administrator';
  assert (select bool_and(role <> 'admin') from public.users
           where id = any (v_ids) and id <> current_setting('test.admin')::uuid),
    'the other five must NOT be administrators, or the denials prove nothing';
end $$;

-- ── Helpers ──────────────────────────────────────────────────────────────────

create or replace function pg_temp.fails_with(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

create or replace function pg_temp.act_as(p_user text)
returns void
language plpgsql
as $$
declare
  v_id text := current_setting('test.' || p_user, true);
begin
  if coalesce(v_id, '') = '' then
    raise exception 'test.% is not configured', p_user;
  end if;
  perform set_config('test.uid', v_id, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'ASSERTION FAILED: %', p_what;
  end if;
end $$;

create or replace function pg_temp.grant_action(p_user text, p_action text)
returns void
language plpgsql
as $$
begin
  -- granted_by is NOT NULL (20260660000000 §6) and has no default, so the grant
  -- has to name a granter. The configured admin is the only account in this
  -- script entitled to hand out a permission, which is also what a real grant
  -- would record.
  insert into public.employee_permission_overrides
    (user_id, module_id, action_id, allowed, granted_by)
  select current_setting('test.' || p_user)::uuid, m.id, a.id, true,
         current_setting('test.admin')::uuid
  from public.permission_modules m, public.permission_actions a
  where m.module_key = 'orders' and a.action_key = p_action
  on conflict (user_id, module_id, action_id) do update set allowed = true;
end $$;

/**
 * One complete fixture PI, with a workbook object, a product line, a picture and
 * its picture object, owned by whichever configured user is named.
 *
 * Built through direct inserts, as the other scripts in this directory build
 * theirs, because the parse writer is service-role-only and is not what this
 * script tests.
 */
create or replace function pg_temp.make_submission(p_owner text default 'owner')
returns uuid
language plpgsql
as $$
declare
  v_owner uuid := current_setting('test.' || p_owner)::uuid;
  v_id    uuid;
  v_item  uuid;
  v_sha   text := repeat('b', 64);
  v_wpath text;
  v_ipath text;
begin
  insert into public.order_submissions
    (submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values (v_owner, v_owner, 'Deletion Assertions Client', 100000, 0, 118000)
  returning id into v_id;

  insert into public.order_submission_items
    (submission_id, source_row, item_sequence, product_name, quantity,
     cost_per_piece, total_amount, sort_order)
  values (v_id, 30, 'B001', 'Fixture product', 1, 100000, 100000, 0)
  returning id into v_item;

  v_wpath := 'submissions/' || v_id::text || '/original/fixture.xlsx';
  v_ipath := 'submissions/' || v_id::text || '/images/' || v_item::text
             || '/representative/0-' || v_sha || '.png';

  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_wpath,
          jsonb_build_object('mimetype',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_ipath, jsonb_build_object('mimetype', 'image/png'));

  insert into public.order_submission_item_images
    (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values (v_id, v_item, 'representative', 0, v_ipath, 'image/png', v_sha, 30);

  update public.order_submissions
     set source_workbook_path = v_wpath, source_workbook_name = 'fixture.xlsx'
   where id = v_id;

  -- One history entry, so "the trail goes with the record" has something to
  -- prove. Written through the logger, which is how every real entry is written.
  perform public.log_order_submission_activity(
    v_id, v_owner, 'submission_created', null, 'draft', null, '{}'::jsonb);

  return v_id;
end $$;

/**
 * Move a fixture through the REAL workflow, never by writing `status` directly.
 *
 * The status graph, the frozen-column guard and the advance guard all refuse a
 * hand-written transition — correctly — so these go through the same RPCs the
 * screens call. Each one leaves the session acting as the user it needed, so
 * callers re-assert who they are afterwards.
 */
create or replace function pg_temp.submit(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(p_id, null, 'standard', null, null);
end $$;

create or replace function pg_temp.send_back(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform pg_temp.submit(p_id);
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(p_id, 'Correct the fabric name.');
end $$;

create or replace function pg_temp.reject(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform pg_temp.submit(p_id);
  perform pg_temp.act_as('reviewer');
  perform public.reject_order_submission(p_id, 'The client withdrew.');
end $$;

/**
 * The whole deletion, exactly as the server route performs it.
 *
 *   1. reserve the record and collect the keys it owns
 *   2. remove the objects  (the route uses the service role; this script owns
 *      its own fixtures, so it removes them directly)
 *   3. finalize on the claim
 */
create or replace function pg_temp.delete_pi(p_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_claim jsonb;
begin
  v_claim := public.begin_order_submission_deletion(p_id);

  delete from storage.objects
   where bucket_id = 'order-files'
     and name in (select jsonb_array_elements_text(v_claim -> 'storage_paths'));

  return public.finalize_order_submission_deletion(
    p_id, (v_claim ->> 'claim_token')::uuid);
end $$;

/** Reserve, and hand back the token. */
create or replace function pg_temp.claim(p_id uuid)
returns uuid
language sql
as $$ select (public.begin_order_submission_deletion(p_id) ->> 'claim_token')::uuid $$;

/** Age a live claim past the TTL, which only the claim columns may do. */
create or replace function pg_temp.age_claim(p_id uuid)
returns void
language plpgsql
as $$
begin
  update public.order_submissions
     set deletion_claimed_at = now() - public.order_submission_deletion_claim_ttl()
                                     - interval '1 minute'
   where id = p_id;
end $$;

create or replace function pg_temp.is_claimed(p_id uuid)
returns boolean
language sql
as $$
  select coalesce((select deletion_claim_token is not null
                   from public.order_submissions where id = p_id), false)
$$;

create or replace function pg_temp.alive(p_id uuid)
returns boolean
language sql
as $$ select exists (select 1 from public.order_submissions where id = p_id) $$;

-- ── Fixture permissions ──────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.grant_action('owner', 'view');
  perform pg_temp.grant_action('owner', 'create');

  perform pg_temp.grant_action('other', 'view');

  -- Each of these three holds a permission that lets them SEE or DECIDE a PI.
  -- Section D exists to prove that none of them may erase one.
  perform pg_temp.grant_action('viewall', 'view');
  perform pg_temp.grant_action('viewall', 'view_all');

  perform pg_temp.grant_action('reviewer', 'view');
  perform pg_temp.grant_action('reviewer', 'approve_order');

  perform pg_temp.grant_action('approver', 'view');
  perform pg_temp.grant_action('approver', 'approve_advance_exception');
end $$;

-- ═══ A. The allow-list ══════════════════════════════════════════════════════

do $$
declare
  v_allowed text[] := public.order_submission_deletable_statuses();
begin
  perform pg_temp.ok(v_allowed @> array['draft', 'needs_changes', 'rejected'],
    'A1. the three eligible statuses are the three the business named');
  perform pg_temp.ok(array_length(v_allowed, 1) = 3,
    'A2. and there are exactly three — a fourth must be a deliberate migration');
  perform pg_temp.ok(not ('submitted' = any (v_allowed)),
    'A3. a PI under review is not deletable by anybody');
  perform pg_temp.ok(not ('approved' = any (v_allowed)),
    'A4. an approved PI is not deletable by anybody');

  -- FAIL CLOSED. Every status the column admits that is NOT on the list must be
  -- refused, so a status a later phase adds is refused until it is written in.
  perform pg_temp.ok(
    not exists (
      select 1 from unnest(array['submitted', 'approved']) s(status)
      where s.status = any (v_allowed)),
    'A5. the list is an allow-list, not a deny-list');
end $$;

-- ═══ B. The owner deletes their own ═════════════════════════════════════════

do $$
declare
  v_draft    uuid;
  v_returned uuid;
  v_rejected uuid;
  v_result   jsonb;
begin
  perform pg_temp.act_as('owner');

  -- B1. A private draft.
  v_draft := pg_temp.make_submission();
  v_result := pg_temp.delete_pi(v_draft);
  perform pg_temp.ok(not pg_temp.alive(v_draft), 'B1. the owner deletes their own draft');
  perform pg_temp.ok(v_result ->> 'status' = 'draft',
    'B2. and the result reports the state it was deleted from');

  -- B3. A PI management returned for changes — deletable IMMEDIATELY, with no
  --     further permission and no second decision.
  v_returned := pg_temp.make_submission();
  perform pg_temp.send_back(v_returned);
  perform pg_temp.act_as('owner');
  perform pg_temp.delete_pi(v_returned);
  perform pg_temp.ok(not pg_temp.alive(v_returned),
    'B3. the owner deletes their own returned PI');

  -- B4. A rejected PI. The business does not require it kept.
  v_rejected := pg_temp.make_submission();
  perform pg_temp.reject(v_rejected);
  perform pg_temp.act_as('owner');
  perform pg_temp.delete_pi(v_rejected);
  perform pg_temp.ok(not pg_temp.alive(v_rejected),
    'B4. the owner deletes their own rejected PI');
end $$;

-- ═══ C. An administrator deletes somebody else's ════════════════════════════

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();

  perform pg_temp.act_as('admin');
  perform pg_temp.delete_pi(v_id);
  perform pg_temp.ok(not pg_temp.alive(v_id),
    'C1. an admin deletes another employee''s eligible PI');

  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  perform pg_temp.reject(v_id);
  perform pg_temp.act_as('admin');
  perform pg_temp.delete_pi(v_id);
  perform pg_temp.ok(not pg_temp.alive(v_id),
    'C2. including a rejected one');
end $$;

-- ═══ D. Everybody else is refused ═══════════════════════════════════════════
--
-- The four accounts below hold, between them, every permission that might look
-- like authority over somebody else's PI. None of them is.

do $$
declare
  v_id  uuid;
  v_err text;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();

  foreach v_err in array array['other', 'viewall', 'reviewer', 'approver']
  loop
    perform pg_temp.act_as(v_err);
    perform pg_temp.ok(
      pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
        like '42501|ORDER_SUBMISSION_DELETE_DENIED%',
      format('D. %s must not be able to delete another employee''s PI', v_err));
    perform pg_temp.ok(pg_temp.alive(v_id),
      format('D. and the PI survives %s trying', v_err));
  end loop;

  -- Said again as the rule itself, so the refusal is the rule's and not an
  -- accident of the RPC's ordering.
  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.viewall')::uuid),
    'D5. orders.view_all is sight, not authority');
  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.reviewer')::uuid),
    'D6. orders.approve_order decides a PI; it does not erase one');
  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.approver')::uuid),
    'D7. orders.approve_advance_exception settles one term and nothing else');
  perform pg_temp.ok(
    public.order_submission_deletable_by(v_id, current_setting('test.owner')::uuid),
    'D8. and the owner may, which is what makes the four denials meaningful');

  -- orders.delete means "remove an Order Request" (20260901000000). Granting it
  -- to an unrelated colleague must change nothing here.
  perform pg_temp.grant_action('other', 'delete');
  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.other')::uuid),
    'D9. orders.delete does not reach a PI submission');

  perform pg_temp.act_as('other');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like '42501|ORDER_SUBMISSION_DELETE_DENIED%',
    'D10. and the RPC agrees');

  -- A soft-deleted or deactivated owner keeps no power over their old records.
  update public.users set is_active = false where id = current_setting('test.owner')::uuid;
  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.owner')::uuid),
    'D11. a deactivated owner is not an owner');
  update public.users set is_active = true where id = current_setting('test.owner')::uuid;
end $$;

-- ═══ E. A PI under review is untouchable ════════════════════════════════════

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  perform pg_temp.submit(v_id);

  perform pg_temp.act_as('owner');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like 'P0001|ORDER_SUBMISSION_DELETE_STATUS%',
    'E1. the owner cannot delete a PI that is under review');

  perform pg_temp.act_as('admin');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like 'P0001|ORDER_SUBMISSION_DELETE_STATUS%',
    'E2. and neither can an administrator');

  perform pg_temp.ok(pg_temp.alive(v_id), 'E3. it is still there');
  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.admin')::uuid),
    'E4. the rule says so on its own');

  -- The refusal is about the STATE, not about the person: both get the same
  -- answer, so neither goes looking for a grant that would not have helped.
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'Correct the fabric name.');
  perform pg_temp.act_as('owner');
  perform pg_temp.delete_pi(v_id);
  perform pg_temp.ok(not pg_temp.alive(v_id),
    'E5. and once it comes back, the owner may delete it');
end $$;

-- ═══ F. Approved, and anything not on the list, fails closed ════════════════
--
-- 'approved' is unreachable through the product: the transition trigger refuses
-- it for every caller, which is asserted in section K. It is reached here for
-- ONE insert, with that trigger suspended inside this transaction, purely to
-- prove that the deletion RPC already refuses a state no phase can yet produce.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();

  -- The transition guard, the advance guard and the frozen-column guard all
  -- refuse this — correctly, and section N asserts the first of them still does.
  -- They are suspended for exactly these two statements, inside a transaction
  -- that rolls back, so that the DELETION rule can be asked about a state the
  -- product cannot yet reach.
  alter table public.order_submissions disable trigger order_submissions_enforce_status_transition;
  alter table public.order_submissions disable trigger order_submissions_guard_advance_exception;
  alter table public.order_submissions disable trigger order_submissions_guard_frozen_columns;
  update public.order_submissions
     set status = 'approved',
         approved_by = current_setting('test.admin')::uuid,
         approved_at = now(),
         advance_condition = 'standard'
   where id = v_id;
  alter table public.order_submissions enable trigger order_submissions_enforce_status_transition;
  alter table public.order_submissions enable trigger order_submissions_guard_advance_exception;
  alter table public.order_submissions enable trigger order_submissions_guard_frozen_columns;

  perform pg_temp.act_as('owner');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like 'P0001|ORDER_SUBMISSION_DELETE_STATUS%',
    'F1. an approved PI cannot be deleted by its owner');

  perform pg_temp.act_as('admin');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like 'P0001|ORDER_SUBMISSION_DELETE_STATUS%',
    'F2. nor by an administrator');

  perform pg_temp.ok(
    not public.order_submission_deletable_by(v_id, current_setting('test.admin')::uuid),
    'F3. the rule refuses it without being asked twice');
  perform pg_temp.ok(pg_temp.alive(v_id), 'F4. and it is still there');

  -- Clean the fixture up the only way the guard allows.
  alter table public.order_submissions disable trigger order_submissions_enforce_status_transition;
  alter table public.order_submissions disable trigger order_submissions_guard_advance_exception;
  alter table public.order_submissions disable trigger order_submissions_guard_frozen_columns;
  update public.order_submissions
     set status = 'draft', approved_by = null, approved_at = null,
         advance_condition = null
   where id = v_id;
  alter table public.order_submissions enable trigger order_submissions_enforce_status_transition;
  alter table public.order_submissions enable trigger order_submissions_guard_advance_exception;
  alter table public.order_submissions enable trigger order_submissions_guard_frozen_columns;
  perform pg_temp.act_as('owner');
  perform pg_temp.delete_pi(v_id);
end $$;

-- ═══ G. The children go, and nothing else does ══════════════════════════════

do $$
declare
  v_doomed    uuid;
  v_bystander uuid;
  v_result    jsonb;
  v_users     bigint;
  v_orders    bigint;
begin
  perform pg_temp.act_as('owner');
  v_doomed    := pg_temp.make_submission();
  v_bystander := pg_temp.make_submission();

  select count(*) into v_users  from public.users;
  select count(*) into v_orders from public.orders;

  v_result := pg_temp.delete_pi(v_doomed);

  perform pg_temp.ok(
    not exists (select 1 from public.order_submission_items where submission_id = v_doomed),
    'G1. the product lines are gone');
  perform pg_temp.ok(
    not exists (select 1 from public.order_submission_item_images where submission_id = v_doomed),
    'G2. the picture metadata is gone');
  perform pg_temp.ok(
    not exists (select 1 from public.order_submission_activity where submission_id = v_doomed),
    'G3. the activity trail is gone');
  perform pg_temp.ok((v_result ->> 'items')::int = 1
                 and (v_result ->> 'images')::int = 1
                 and (v_result ->> 'activity')::int >= 1,
    'G4. and the result counts what it actually removed');

  perform pg_temp.ok(pg_temp.alive(v_bystander),
    'G5. THE OTHER PI IS UNTOUCHED');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_items where submission_id = v_bystander) = 1,
    'G6. including its product lines');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_item_images where submission_id = v_bystander) = 1,
    'G7. and its pictures');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_activity where submission_id = v_bystander) >= 1,
    'G8. and its history');

  perform pg_temp.ok((select count(*) from public.users)  = v_users,
    'G9. no user was removed');
  perform pg_temp.ok((select count(*) from public.orders) = v_orders,
    'G10. no Order was removed');

  perform pg_temp.delete_pi(v_bystander);
end $$;

-- ═══ H. Direct SQL cannot bypass any of it ══════════════════════════════════
--
-- RLS and table privileges already stop a signed-in client — there is no DELETE
-- policy and no DELETE grant — but both are bypassed by the service role and by
-- psql. The guard triggers are not, which is what makes these rules a property
-- of the database rather than of the API.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  perform pg_temp.submit(v_id);

  perform pg_temp.ok(
    pg_temp.fails_with(format('delete from public.order_submissions where id = %L', v_id))
      like '42501|ORDER_SUBMISSION_DELETE_DENIED%',
    'H1. a direct DELETE is refused even for a superuser');
  perform pg_temp.ok(pg_temp.alive(v_id), 'H2. and the row survives it');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'delete from public.order_submission_activity where submission_id = %L', v_id))
      like '42501|ORDER_SUBMISSION_ACTIVITY_IMMUTABLE%',
    'H3. the history stays append-only outside a purge');

  -- A forged marker naming a DIFFERENT submission authorizes nothing.
  perform set_config('boe.order_submission_purge_id', gen_random_uuid()::text, true);
  perform pg_temp.ok(
    pg_temp.fails_with(format('delete from public.order_submissions where id = %L', v_id))
      like '42501|ORDER_SUBMISSION_DELETE_DENIED%',
    'H4. the purge marker authorizes one submission, not any submission');
  perform set_config('boe.order_submission_purge_id', '', true);

  -- And the marker does not survive the RPC that sets it.
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'Correct the fabric name.');
  perform pg_temp.act_as('owner');
  perform pg_temp.delete_pi(v_id);
  perform pg_temp.ok(coalesce(current_setting('boe.order_submission_purge_id', true), '') = '',
    'H5. the marker is cleared when the purge finishes');
end $$;

-- ═══ I. The storage keys are reported, and no object is removed here ════════

do $$
declare
  v_id     uuid;
  v_claim  jsonb;
  v_paths  text[];
  v_before bigint;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();

  select count(*) into v_before from storage.objects where bucket_id = 'order-files';

  v_claim := public.begin_order_submission_deletion(v_id);
  select array_agg(value order by value) into v_paths
  from jsonb_array_elements_text(v_claim -> 'storage_paths');

  perform pg_temp.ok(array_length(v_paths, 1) = 2,
    'I1. the workbook and the picture are both reported');
  perform pg_temp.ok(
    (select bool_and(p like 'submissions/' || v_id::text || '/%') from unnest(v_paths) p),
    'I2. every reported key is under this submission''s own prefix');
  perform pg_temp.ok(
    v_claim ->> 'storage_prefix' = 'submissions/' || v_id::text,
    'I3. and the prefix the route sweeps is this submission''s own');

  -- REPORTED, NOT REMOVED. Postgres cannot delete a storage object's BYTES, only
  -- its row — and a row deleted here would strand the bytes with nothing left
  -- pointing at them, which is the one outcome nothing can clean up afterwards.
  -- The route removes both together through the Storage API.
  perform pg_temp.ok(
    (select count(*) from storage.objects where bucket_id = 'order-files') = v_before,
    'I4. the database removed no storage object');
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where bucket_id = 'order-files' and name = any (v_paths)) = 2,
    'I5. and the reported objects are exactly the ones still standing');

  -- Reserving is not deleting: nothing about the record has gone.
  perform pg_temp.ok(pg_temp.alive(v_id), 'I6. and the PI itself is untouched');

  perform public.release_order_submission_deletion(v_id,
    (v_claim ->> 'claim_token')::uuid);
  perform pg_temp.delete_pi(v_id);
end $$;

-- ═══ J. Repeat clicks, and rows that are already gone ═══════════════════════

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  perform pg_temp.delete_pi(v_id);

  -- A double click, or a second tab acting on a row that is already gone.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like 'P0002|ORDER_SUBMISSION_DELETE_MISSING%',
    'J1. deleting an already-deleted PI is a clear "no longer exists", not a crash');

  -- An id that never existed is the same answer, and leaks nothing.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', gen_random_uuid()))
      like 'P0002|ORDER_SUBMISSION_DELETE_MISSING%',
    'J2. and so is an id that never existed');

  -- THE RACE AT THE FRONT DOOR. The screen drew Delete against a draft; by the
  -- time the click lands, the PI has been submitted. The row is locked and the
  -- status re-read under that lock, so the refusal is about the CURRENT state —
  -- and it happens at BEGIN, before any file has been touched.
  v_id := pg_temp.make_submission();
  perform pg_temp.submit(v_id);
  perform pg_temp.act_as('owner');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like 'P0001|ORDER_SUBMISSION_DELETE_STATUS%',
    'J3. a PI that entered review between the read and the click is refused');
  perform pg_temp.ok(pg_temp.alive(v_id), 'J4. and it is still there for its reviewer');
  perform pg_temp.ok(not pg_temp.is_claimed(v_id),
    'J5. with no reservation left behind by the refusal');
  perform pg_temp.ok(
    (select count(*) from storage.objects where bucket_id = 'order-files'
      and name like 'submissions/' || v_id::text || '/%') = 2,
    'J6. AND ITS FILES INTACT — an ineligible PI never reaches the storage sweep');
end $$;

-- ═══ K. THE RESERVATION: a claimed PI is frozen ═════════════════════════════
--
-- This is the section the redesign exists for. Storage is removed between begin
-- and finalize; if ANY of the transitions below could happen in that window, a
-- live PI could end up with its workbook and images destroyed.

do $$
declare
  v_id    uuid;
  v_token uuid;
  v_item  uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  v_token := pg_temp.claim(v_id);
  perform pg_temp.ok(pg_temp.is_claimed(v_id), 'K0. the record is reserved');

  -- 1. SUBMIT FOR APPROVAL — the exact race the old design lost.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, ''standard'', null, null)', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K1. a reserved PI cannot be submitted for approval');
  perform pg_temp.ok(
    (select status from public.order_submissions where id = v_id) = 'draft',
    'K1b. and it did not move');

  -- The Phase A doors are the same door underneath, and are refused too.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.submit_order_submission(%L)', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K2. including the Phase A submission RPC');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.submit_order_submission_with_note(%L, ''hello'')', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K3. and the one carrying a reply');

  -- 2. CHANGE PI. Its first step takes the processing lease, which is an UPDATE
  --    of this row; its later steps rewrite the product lines and the pictures.
  --    All three are refused.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.begin_order_submission_processing(%L, %L, %L)',
      v_id, current_setting('test.owner')::uuid, gen_random_uuid()))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K4. Change PI cannot even take its processing lease');

  select id into v_item from public.order_submission_items where submission_id = v_id limit 1;
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'delete from public.order_submission_items where submission_id = %L', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K5. and the product lines cannot be rewritten');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submission_item_images set anchor_row = 99 where submission_id = %L', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K6. nor the pictures');

  -- 3. MANAGEMENT REVIEW and the exception decisions. A claimed PI is never
  --    'submitted', so these are unreachable by status as well — asserted here
  --    so the two independent refusals are both on the record.
  perform pg_temp.act_as('reviewer');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.request_order_submission_changes(%L, ''fix it'')', v_id)) <> 'NO ERROR',
    'K7. a reserved PI cannot be sent back');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.reject_order_submission(%L, ''no'')', v_id)) <> 'NO ERROR',
    'K8. nor rejected');
  perform pg_temp.act_as('approver');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.approve_pi_advance_exception(%L)', v_id)) <> 'NO ERROR',
    'K9. nor can its advance exception be approved');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reject_pi_advance_exception(%L, ''no'')', v_id)) <> 'NO ERROR',
    'K10. nor refused');

  -- ANY status change at all, by any route, including a superuser writing SQL.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''submitted'' where id = %L', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K11. a raw status update is refused too');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set client_name = ''renamed'' where id = %L', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K12. and so is any other field');

  -- 13. THE INVARIANT, stated directly: nothing moved, so finalization cannot be
  --     refused for a reason that appeared after the files were removed.
  perform pg_temp.ok(
    (select status from public.order_submissions where id = v_id)
      = any (public.order_submission_deletable_statuses()),
    'K13. the record is still in a deletable state, because nothing could move it');

  perform pg_temp.act_as('owner');
  perform public.release_order_submission_deletion(v_id,
    (select deletion_claim_token from public.order_submissions where id = v_id));

  -- Released, the record works again exactly as before.
  perform pg_temp.ok(not pg_temp.is_claimed(v_id), 'K14. the reservation is gone');
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);
  perform pg_temp.ok(
    (select status from public.order_submissions where id = v_id) = 'submitted',
    'K15. and the PI submits normally once it is no longer reserved');
end $$;

-- ═══ L. Failure, release, retry, staleness and takeover ═════════════════════

do $$
declare
  v_id     uuid;
  v_token  uuid;
  v_token2 uuid;
  v_paths  text[];
  v_result jsonb;
begin
  -- 4. STORAGE FAILURE. The route releases and reports; the record and every
  --    one of its file references must survive intact and be retryable.
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  select array_agg(name order by name) into v_paths
  from storage.objects where bucket_id = 'order-files'
    and name like 'submissions/' || v_id::text || '/%';

  v_token := pg_temp.claim(v_id);
  -- …the sweep fails here, so nothing is removed…
  v_result := public.release_order_submission_deletion(v_id, v_token);

  perform pg_temp.ok((v_result ->> 'released')::boolean, 'L1. the reservation is released');
  perform pg_temp.ok(pg_temp.alive(v_id), 'L2. THE PI SURVIVES a failed storage sweep');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_items where submission_id = v_id) = 1,
    'L3. with its product lines');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_item_images where submission_id = v_id) = 1,
    'L4. and its picture metadata');
  perform pg_temp.ok(
    (select source_workbook_path is not null from public.order_submissions where id = v_id),
    'L5. the workbook path is still recorded, so the files stay discoverable');
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where bucket_id = 'order-files' and name = any (v_paths)) = 2,
    'L6. and the objects themselves are untouched');

  -- 5. RETRY. The same actor simply does it again, and it works.
  v_result := pg_temp.delete_pi(v_id);
  perform pg_temp.ok((v_result ->> 'deleted')::boolean and not pg_temp.alive(v_id),
    'L7. the owner retries after a storage failure and it succeeds');

  -- 6. A STALE CLAIM does not delete, and does not block forever.
  v_id := pg_temp.make_submission();
  v_token := pg_temp.claim(v_id);
  perform pg_temp.age_claim(v_id);

  -- It is still a reservation, so the freeze holds: an abandoned claim may mean
  -- files are already gone, and quietly unfreezing would assert what nobody knows.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, ''standard'', null, null)', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'L8. a stale reservation still freezes the record');

  -- But it can be taken over by a fresh attempt, which issues a NEW token…
  v_token2 := pg_temp.claim(v_id);
  perform pg_temp.ok(v_token2 <> v_token, 'L9. a takeover issues a new token');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_id, v_token))
      like '42501|ORDER_SUBMISSION_DELETION_CLAIM_INVALID%',
    'L10. …and the abandoned attempt can no longer finalize behind its back');

  -- …or released by hand, which is the escape from a claim nobody will finish.
  -- The takeover above reset the clock, so this one has to go stale in its turn:
  -- a LIVE claim is never released without its token, which L13 asserts.
  perform pg_temp.age_claim(v_id);
  v_result := public.release_order_submission_deletion(v_id, null);
  perform pg_temp.ok((v_result ->> 'released')::boolean and (v_result ->> 'was_stale')::boolean,
    'L11. a stale reservation can be released without the token');
  perform pg_temp.ok(not pg_temp.is_claimed(v_id) and pg_temp.alive(v_id),
    'L12. so a crashed request never blocks a PI forever');

  -- A LIVE claim is somebody else's attempt in flight and is not snatched away.
  v_token := pg_temp.claim(v_id);
  v_result := public.release_order_submission_deletion(v_id, null);
  perform pg_temp.ok(not (v_result ->> 'released')::boolean
                 and v_result ->> 'reason' = 'claim_active',
    'L13. a live reservation is not released without its token');

  -- 10. DOUBLE CLICK. The second attempt is told it is already happening, and
  --     the first completes exactly once.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.begin_order_submission_deletion(%L)', v_id))
      like '55P03|ORDER_SUBMISSION_DELETION_IN_PROGRESS%',
    'L14. a repeat request gets a neutral "already in progress"');

  perform public.finalize_order_submission_deletion(v_id, v_token);
  perform pg_temp.ok(not pg_temp.alive(v_id), 'L15. and exactly one deletion completes');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_id, v_token))
      like 'P0002|ORDER_SUBMISSION_DELETE_MISSING%',
    'L16. the second finalize finds nothing left to do');

  -- A non-holder releasing changes nothing.
  v_id := pg_temp.make_submission();
  v_token := pg_temp.claim(v_id);
  v_result := public.release_order_submission_deletion(v_id, gen_random_uuid());
  perform pg_temp.ok(not (v_result ->> 'released')::boolean
                 and v_result ->> 'reason' = 'not_holder',
    'L17. a wrong token releases nothing');
  perform pg_temp.ok(pg_temp.is_claimed(v_id), 'L18. and the reservation stands');
  perform public.finalize_order_submission_deletion(v_id, v_token);
end $$;

-- ═══ M. Claims cannot be forged, borrowed or replayed ═══════════════════════

do $$
declare
  v_a     uuid;
  v_b     uuid;
  v_token uuid;
begin
  perform pg_temp.act_as('owner');
  v_a := pg_temp.make_submission();
  v_b := pg_temp.make_submission();

  v_token := pg_temp.claim(v_a);

  -- 7. WRONG TOKEN.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_a, gen_random_uuid()))
      like '42501|ORDER_SUBMISSION_DELETION_CLAIM_INVALID%',
    'M1. a guessed token finalizes nothing');
  perform pg_temp.ok(pg_temp.alive(v_a), 'M2. and the PI is still there');

  -- 8. A CLAIM FOR ANOTHER SUBMISSION.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_b, v_token))
      like '42501|ORDER_SUBMISSION_DELETION_CLAIM_INVALID%',
    'M3. a token issued for one PI cannot delete another');
  perform pg_temp.ok(pg_temp.alive(v_b), 'M4. which is still there too');

  -- No claim at all.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_b, gen_random_uuid()))
      like '42501|ORDER_SUBMISSION_DELETION_CLAIM_INVALID%',
    'M5. an unreserved PI cannot be finalized at all');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, null)', v_a))
      like 'P0001|ORDER_SUBMISSION_DELETION_CLAIM_INVALID%',
    'M6. and a null claim is refused rather than treated as a wildcard');

  -- A LEAKED TOKEN IS NOT AUTHORITY. A colleague who somehow holds the token
  -- still cannot finalize, because they could not have deleted the record.
  perform pg_temp.act_as('other');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_a, v_token))
      like '42501|ORDER_SUBMISSION_DELETE_DENIED%',
    'M7. a leaked token does not make a colleague an owner');
  perform pg_temp.ok(pg_temp.alive(v_a), 'M8. and the PI survives them trying');

  -- REPLAY. Once used, the token dies with the record.
  perform pg_temp.act_as('owner');
  delete from storage.objects where bucket_id = 'order-files'
    and name like 'submissions/' || v_a::text || '/%';
  perform public.finalize_order_submission_deletion(v_a, v_token);
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.finalize_order_submission_deletion(%L, %L)', v_a, v_token))
      like 'P0002|ORDER_SUBMISSION_DELETE_MISSING%',
    'M9. a spent token has nothing left to act on');

  perform pg_temp.delete_pi(v_b);
end $$;

-- ═══ N. Nothing about approval, numbering, payment or advance changed ═══════

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission();
  perform pg_temp.submit(v_id);

  -- The transition graph is exactly as 20260910000000 left it.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''approved'', approved_by = %L, approved_at = now() where id = %L',
      current_setting('test.admin')::uuid, v_id)) <> 'NO ERROR',
    'N1. no route to approved was opened by this migration');

  perform pg_temp.ok(
    (select order_id is null from public.order_submissions where id = v_id),
    'N2. no Order was linked');

  -- The advance workflow is untouched: the columns, the predicate and the
  -- decision functions are all still exactly what 20260913000000 installed.
  perform pg_temp.ok(
    public.order_submission_standard_advance_percent() = 40,
    'N3. the standard advance percentage is unchanged');
  perform pg_temp.ok(
    public.order_submission_advance_ready('exception', 0, 'approved'),
    'N4. an approved 0% exception is still advance-ready');
  perform pg_temp.ok(
    not public.order_submission_advance_ready('exception', 0, 'pending'),
    'N5. and a pending one still is not');

  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'Correct the fabric name.');
  perform pg_temp.act_as('owner');
  perform pg_temp.delete_pi(v_id);
end $$;

-- ═══ O. Privileges ══════════════════════════════════════════════════════════

do $$
begin
  perform pg_temp.ok(
    has_function_privilege('authenticated', 'public.begin_order_submission_deletion(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.finalize_order_submission_deletion(uuid, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.release_order_submission_deletion(uuid, uuid)', 'execute'),
    'O1. a signed-in caller may run the three deletion RPCs — they are the boundary');
  perform pg_temp.ok(
    not has_function_privilege('anon', 'public.begin_order_submission_deletion(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.finalize_order_submission_deletion(uuid, uuid)', 'execute'),
    'O2. an anonymous caller may not');

  perform pg_temp.ok(
    not has_function_privilege('authenticated',
      'public.order_submission_purge_in_progress(uuid)', 'execute'),
    'O3. the purge marker check is internal');
  perform pg_temp.ok(
    not has_function_privilege('service_role',
      'public.order_submissions_guard_delete()', 'execute'),
    'O4. and so is the guard');

  perform pg_temp.ok(
    has_function_privilege('authenticated',
      'public.order_submission_deletable_by(uuid, uuid)', 'execute'),
    'O5. the rule itself is readable, so a screen can match what the RPC allows');

  -- No client role gained a DELETE privilege on any of the four tables.
  perform pg_temp.ok(
    not has_table_privilege('authenticated', 'public.order_submissions', 'delete')
    and not has_table_privilege('authenticated', 'public.order_submission_items', 'delete')
    and not has_table_privilege('authenticated', 'public.order_submission_item_images', 'delete')
    and not has_table_privilege('authenticated', 'public.order_submission_activity', 'delete'),
    'O6. deletion is reachable only through the RPCs, never through the table');
end $$;

-- ═══ P. A record that must survive refuses the deletion ═════════════════════
--
-- THE PRODUCTION FAILURE THIS SECTION EXISTS FOR.
--
-- A PI Draft would not delete. The dialog reported "already being deleted", the
-- record stayed, and its workbook and every product image were already gone.
--
-- Nothing in sections K–M was wrong. The reservation freezes the submission and
-- the three child tables that belong to it alone, and it did. What refused the
-- deletion was a foreign key belonging to a DIFFERENT module: an allocated
-- payment names the PI, with the default NO ACTION rule, and
-- finalize_order_submission_deletion() neither deletes such a row nor should.
-- So the final DELETE came back as a raw constraint error, at the one moment
-- when the files were already gone and the route deliberately keeps the
-- reservation.
--
-- From there the record could not converge: each attempt past the TTL reserved
-- it again, found the bucket already empty, and was refused by the same foreign
-- key; each attempt inside the TTL met the neutral in-progress refusal instead.
--
-- WHAT IS ASSERTED HERE IS THE DATABASE HALF OF THE ANSWER. The route now
-- establishes these relationships BEFORE it reserves anything, so the refusal
-- arrives with the files intact — but a check in application code is only as
-- good as the list it checks, so P1 derives that list from the catalog. The rest
-- prove that the refusal is real, that it destroys and changes nothing, that the
-- reservation returns the record exactly as it was, and that the deletion
-- succeeds the moment the blocking record is legitimately gone.
--
-- NOTHING IS DELETED TO MAKE A DELETION SUCCEED. P6 removes the payment through
-- the path Finance already has for an unapproved one — which releases its
-- allocations by the trigger 20260918000000 §8a installed — and P7 proves that a
-- VERIFIED payment's allocation is not removable at all, so the PI stays.

do $$
declare
  v_no_action text[];
  v_expected  text[] := array[
    'finance_payment_allocations.order_submission_id',
    'order_submission_correction_requests.submission_id',
    'orders.source_order_submission_id'
  ];
begin
  -- ── P1. The list the application checks is the catalog's list ─────────────
  --
  -- Every foreign key pointing at order_submissions whose delete rule is NOT
  -- cascade, read from pg_constraint. A later phase that adds a fourth and does
  -- not teach the route about it fails HERE, rather than in production after a
  -- workbook has been destroyed.
  select coalesce(array_agg(entry order by entry), array[]::text[])
    into v_no_action
  from (
    select (c.conrelid::regclass::text || '.' ||
            (select string_agg(a.attname, ',' order by k.ord)
               from unnest(c.conkey) with ordinality as k(attnum, ord)
               join pg_attribute a
                 on a.attrelid = c.conrelid and a.attnum = k.attnum)) as entry
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid = 'public.order_submissions'::regclass
      and c.confdeltype <> 'c'
  ) refs;

  perform pg_temp.ok(v_no_action = v_expected,
    'P1. the NO ACTION references to order_submissions are exactly the three the route checks; found: '
    || array_to_string(v_no_action, ', '));

  -- And the three the submission owns really do cascade, so finalization's
  -- explicit deletes are belt and braces rather than the only thing holding.
  perform pg_temp.ok(
    (select count(*) from pg_constraint c
      where c.contype = 'f'
        and c.confrelid = 'public.order_submissions'::regclass
        and c.confdeltype = 'c') = 3,
    'P2. the submission''s own three child tables still cascade');
end $$;

-- ── P3. An allocated payment refuses the deletion, and changes nothing ───────
do $$
declare
  v_id      uuid;
  v_pay     uuid := gen_random_uuid();
  v_claim   uuid;
  v_err     text;
  v_items   integer;
  v_events  integer;
begin
  v_id := pg_temp.make_submission();

  -- The fixture is inserted directly: this script owns its own rows, and what is
  -- under test is the foreign key, not who may allocate. The row is the shape
  -- allocate_payment_to_target() writes.
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, received_in, status, submitted_by)
  values (v_pay, 'Deletion Assertions Payment', 5000.00, current_date, 'upi',
          'company_account', 'pending_approval', current_setting('test.owner')::uuid);

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_id, 5000.00, 'order_submission', current_setting('test.owner')::uuid);

  select count(*) into v_items  from public.order_submission_items where submission_id = v_id;
  select count(*) into v_events from public.order_submission_activity where submission_id = v_id;

  perform pg_temp.act_as('owner');

  -- The reservation is still granted: the PI is a draft the owner owns, and
  -- begin makes no promise about what else refers to it.
  v_claim := pg_temp.claim(v_id);
  perform pg_temp.ok(v_claim is not null, 'P3a. the reservation is still granted');

  -- FINALIZATION IS REFUSED, and this is the production symptom exactly: a
  -- foreign key violation, not one of this module's own markers.
  v_err := pg_temp.fails_with(format(
    'select public.finalize_order_submission_deletion(%L::uuid, %L::uuid)', v_id, v_claim));
  perform pg_temp.ok(v_err like '23503|%',
    'P3b. an allocated payment refuses the final delete with a foreign key violation; got: ' || v_err);
  perform pg_temp.ok(v_err like '%violates foreign key constraint%',
    'P3c. and with the text the route classifies as BLOCKED; got: ' || v_err);

  -- NOTHING WENT. Not the PI, not one child row, not the payment, not the
  -- allocation — the whole function body is one transaction and it rolled back.
  perform pg_temp.ok(pg_temp.alive(v_id), 'P3d. the PI survives the refusal');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_items where submission_id = v_id) = v_items,
    'P3e. every product line survives');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_activity where submission_id = v_id) = v_events,
    'P3f. and the whole activity trail');
  perform pg_temp.ok(
    (select count(*) from public.finance_payment_allocations
      where order_submission_id = v_id) = 1,
    'P3g. the allocation is untouched — money is never removed to clear a deletion');
  perform pg_temp.ok(
    exists (select 1 from public.finance_payment_requests where id = v_pay),
    'P3h. and neither is the payment');

  -- THE STORAGE OBJECTS ARE STILL THERE. In the fixed route they never would
  -- have been touched, because the check runs before the reservation; here the
  -- point is narrower and still worth pinning: the database removes no object,
  -- so a refusal at this stage cannot be what destroyed them.
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where bucket_id = 'order-files'
        and name like 'submissions/' || v_id::text || '/%') = 2,
    'P3i. the workbook and the image are both still in the bucket');

  -- ── P4. And the record comes back whole ───────────────────────────────────
  perform pg_temp.ok(
    (public.release_order_submission_deletion(v_id, v_claim) ->> 'released')::boolean,
    'P4a. the holder releases its own failed attempt');
  perform pg_temp.ok(not pg_temp.is_claimed(v_id),
    'P4b. and the PI is no longer reserved');
  perform pg_temp.ok(
    (select status = 'draft' from public.order_submissions where id = v_id),
    'P4c. in exactly the state it was in before any of this');

  -- ── P5. A second attempt is refused identically, not differently ──────────
  v_claim := pg_temp.claim(v_id);
  v_err := pg_temp.fails_with(format(
    'select public.finalize_order_submission_deletion(%L::uuid, %L::uuid)', v_id, v_claim));
  perform pg_temp.ok(v_err like '23503|%',
    'P5. a retry meets the same refusal, so nothing about it degrades');
  perform public.release_order_submission_deletion(v_id, v_claim);

  -- ── P6. Once the blocking payment is gone, the same PI deletes cleanly ────
  --
  -- Through the path Finance already has: an UNAPPROVED payment is deletable by
  -- its submitter, and 20260918000000 §8a releases its allocations with it. No
  -- allocation is deleted in its own right, here or anywhere.
  delete from public.finance_payment_requests where id = v_pay;
  perform pg_temp.ok(
    (select count(*) from public.finance_payment_allocations
      where order_submission_id = v_id) = 0,
    'P6a. deleting the unapproved payment released its allocation');

  perform pg_temp.act_as('owner');
  perform pg_temp.ok((pg_temp.delete_pi(v_id) ->> 'deleted')::boolean,
    'P6b. and the PI now deletes, through the ordinary protocol');
  perform pg_temp.ok(not pg_temp.alive(v_id), 'P6c. it is gone');
  perform pg_temp.ok(
    (select count(*) from storage.objects
      where bucket_id = 'order-files'
        and name like 'submissions/' || v_id::text || '/%') = 0,
    'P6d. with no orphaned workbook or image left behind');
end $$;

-- ── P7. A VERIFIED payment's allocation is permanent, and so is the refusal ──
do $$
declare
  v_id    uuid;
  v_pay   uuid := gen_random_uuid();
  v_claim uuid;
  v_err   text;
begin
  v_id := pg_temp.make_submission();

  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, received_in, status,
     submitted_by, approved_by, approved_at)
  values (v_pay, 'Deletion Assertions Verified', 5000.00, current_date, 'bank_transfer',
          'company_account', 'approved_unlinked', current_setting('test.owner')::uuid,
          current_setting('test.admin')::uuid, now());

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_id, 5000.00, 'order_submission', current_setting('test.owner')::uuid);

  perform pg_temp.act_as('owner');
  v_claim := pg_temp.claim(v_id);
  v_err := pg_temp.fails_with(format(
    'select public.finalize_order_submission_deletion(%L::uuid, %L::uuid)', v_id, v_claim));
  perform pg_temp.ok(v_err like '23503|%', 'P7a. verified money refuses the deletion too');
  perform public.release_order_submission_deletion(v_id, v_claim);

  -- AND IT IS NOT MEANT TO BE CLEARED. A verified payment is undeletable, so its
  -- allocation is permanent and this PI is permanently undeletable — which is the
  -- correct business answer, and the one the screen now gives instead of "could
  -- not be deleted just now".
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'delete from public.finance_payment_requests where id = %L::uuid', v_pay)) <> 'NO ERROR',
    'P7b. and the verified payment behind it cannot be deleted to clear the way');
  perform pg_temp.ok(pg_temp.alive(v_id), 'P7c. so the PI stays, with its files intact');
end $$;

-- ── P8. A correction request refuses it as well ──────────────────────────────
--
-- A KNOWN, DELIBERATE DEAD END, recorded here rather than worked around. A
-- correction request is never deleted (20260930000000), finalization does not
-- purge it, and its foreign key is NO ACTION — so a PI that was returned for
-- changes after its owner raised one cannot be deleted at all. The route now
-- says so plainly instead of failing generically. Giving such a PI a route out
-- would need a forward-only migration that purges correction requests with their
-- submission, in the way the activity trail already is; that is a database
-- change and is deliberately not made here.
do $$
declare
  v_id    uuid;
  v_claim uuid;
  v_err   text;
begin
  v_id := pg_temp.make_submission();
  perform pg_temp.submit(v_id);

  perform pg_temp.act_as('owner');
  perform public.request_order_submission_correction(
    v_id, 'products', 'The fabric name is wrong on line 3.', 'It was entered from an old quote.');

  -- Back to a status the deletion allow-list admits, with the request surviving.
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'Correct the fabric name.');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_correction_requests
      where submission_id = v_id) = 1,
    'P8a. the correction request survives the return for changes');

  perform pg_temp.act_as('owner');
  v_claim := pg_temp.claim(v_id);
  v_err := pg_temp.fails_with(format(
    'select public.finalize_order_submission_deletion(%L::uuid, %L::uuid)', v_id, v_claim));
  perform pg_temp.ok(v_err like '23503|%',
    'P8b. a correction request refuses the deletion; got: ' || v_err);
  perform pg_temp.ok(pg_temp.alive(v_id), 'P8c. and the PI and its request both survive');
  perform pg_temp.ok(
    (select count(*) from public.order_submission_correction_requests
      where submission_id = v_id) = 1,
    'P8d. nothing removed the request to make room');
  perform public.release_order_submission_deletion(v_id, v_claim);
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
