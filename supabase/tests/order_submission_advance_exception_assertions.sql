-- Advance requirement and exception assertions
-- ===========================================================================
-- Covers 20260913000000_order_submission_advance_exceptions.sql:
--
--   A. the standard rule, the derived amount, and the Phase C predicate
--   B. submit_order_submission_with_advance — the declaration and its validation
--   C. owner-only exception requests
--   D. exception authority: the new protected permission, and what it is not
--   E. approve / reject, their atomicity, and their races
--   F. resubmission — standard clears, a revision becomes a fresh Pending
--   G. the persisted model refuses malformed states, for direct SQL too
--   H. history stays append-only, and approval stays unreachable
--   I. privileges — nothing internal became callable by a client role
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded and nothing is left behind.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may set session GUCs (standard Supabase
--     `postgres`).
--   * Replace the FOUR real user UUIDs below; all must exist, be active and be
--     distinct:
--       test.owner       a NON-admin who holds orders.view + orders.create.
--                        Owns the fixture submission.
--       test.reviewer    a NON-admin who holds orders.view + orders.approve_order
--                        and NOT orders.approve_advance_exception.
--       test.approver    a NON-admin who holds orders.view +
--                        orders.approve_advance_exception and NOT
--                        orders.approve_order.
--       test.admin       a public.users row with role = 'admin', is_active.
--
--   The script GRANTS those permissions itself through
--   employee_permission_overrides and removes them on rollback, so the four
--   accounts need no prior configuration beyond existing and being active.
--
-- Every guard under test is a trigger, a CHECK or a SECURITY DEFINER function,
-- so this script simulates the session with request.jwt.claims and a
-- test.uid GUC rather than SET ROLE — the same idiom the other assertion
-- scripts in this directory use.
--
-- NOTHING HERE PAYS ANYBODY. No payment table is read or written, no finance
-- record is created, and no submission reaches 'approved' — section H proves
-- both.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ────────────────────────────────────
do $$
begin
  perform set_config('test.owner',    '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.reviewer', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.approver', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('test.admin',    '44444444-4444-4444-4444-444444444444', true); -- REPLACE
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

-- Becomes the given user for the rest of the transaction.
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

-- The stored record's advance readiness, by the rule itself, independent of who
-- happens to be looking. order_submission_is_advance_ready(uuid) deliberately
-- answers false for a caller who cannot SEE the record, and section D's
-- exception approver is exactly such a caller — that separation is the point of
-- the new permission, so it is asserted on its own rather than assumed here.
create or replace function pg_temp.ready(p_id uuid)
returns boolean
language sql
as $$
  select public.order_submission_advance_ready(
           s.advance_condition, s.advance_exception_percent, s.advance_exception_status)
  from public.order_submissions s where s.id = p_id
$$;

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

-- One complete, submittable fixture PI owned by test.owner. Built through
-- direct inserts, as the other scripts in this directory build theirs, because
-- the parse writer is service-role-only and is not what this script tests.
create or replace function pg_temp.make_submission(p_grand_total numeric)
returns uuid
language plpgsql
as $$
declare
  v_id     uuid;
  v_item   uuid;
  v_sha    text := repeat('a', 64);
  v_wpath  text;
  v_ipath  text;
begin
  insert into public.order_submissions
    (submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values
    (current_setting('test.owner')::uuid, current_setting('test.owner')::uuid,
     'Advance Assertions Client', 100000, 0, p_grand_total)
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

  return v_id;
end $$;

-- ── Fixture permissions ──────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.grant_action('owner', 'view');
  perform pg_temp.grant_action('owner', 'create');

  perform pg_temp.grant_action('reviewer', 'view');
  perform pg_temp.grant_action('reviewer', 'approve_order');

  -- The exception approver holds the NEW permission and nothing else that
  -- touches a PI decision. Section D depends on that being exactly true.
  perform pg_temp.grant_action('approver', 'view');
  perform pg_temp.grant_action('approver', 'approve_advance_exception');
end $$;

-- ═══ A. The rule, the amount, and the predicate ═════════════════════════════

do $$
begin
  perform pg_temp.ok(public.order_submission_standard_advance_percent() = 40,
    'the standard advance is 40%');

  perform pg_temp.ok(public.order_submission_advance_amount(100000, 40) = 40000,
    'the standard advance on 1,00,000 is 40,000');
  perform pg_temp.ok(public.order_submission_advance_amount(100000, 0) = 0,
    'a zero-percent advance is zero, not null');
  perform pg_temp.ok(public.order_submission_advance_amount(123456.78, 12.5) = 15432.10,
    'the derived amount is rounded to paise');
  perform pg_temp.ok(public.order_submission_advance_amount(null, 40) is null,
    'an unknown total derives no amount');
  perform pg_temp.ok(public.order_submission_advance_amount(100000, 'NaN'::numeric) is null,
    'a NaN percentage derives no amount');

  -- The Phase C predicate, every case.
  perform pg_temp.ok(public.order_submission_advance_ready('standard', null, null),
    'standard is advance-ready');
  perform pg_temp.ok(public.order_submission_advance_ready('exception', 0, 'approved'),
    'an approved 0% exception is advance-ready');
  perform pg_temp.ok(public.order_submission_advance_ready('exception', 39.99, 'approved'),
    'an approved 39.99% exception is advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready('exception', 10, 'pending'),
    'a pending exception is NOT advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready('exception', 10, 'rejected'),
    'a rejected exception is NOT advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready(null, null, null),
    'an undeclared condition is NOT advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready('exception', 40, 'approved'),
    'an exception AT the standard is NOT advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready('exception', -1, 'approved'),
    'a negative exception is NOT advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready('exception', 'NaN'::numeric, 'approved'),
    'a NaN exception is NOT advance-ready');
  perform pg_temp.ok(not public.order_submission_advance_ready('exception', null, 'approved'),
    'an approved exception with no percentage is NOT advance-ready');
end $$;

-- ═══ B. Declaring the advance at submission ═════════════════════════════════

do $$
declare
  v_id  uuid;
  v_err text;
  v_row public.order_submissions%rowtype;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);

  -- ── Every rejected percentage, one at a time ──
  for v_err in
    select unnest(array['40', '40.01', '100', '-0.01', '-5', '12.345', '0.001'])
  loop
    perform pg_temp.ok(
      pg_temp.fails_with(format(
        'select public.submit_order_submission_with_advance(%L, null, %L, %s, %L)',
        v_id, 'exception', v_err, 'because')) like '%ADVANCE_PERCENT_INVALID%',
      format('%s%% must be refused as an exception percentage', v_err));
  end loop;

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, ''NaN''::numeric, %L)',
      v_id, 'exception', 'because')) like '%ADVANCE_PERCENT_INVALID%',
    'NaN must be refused as an exception percentage');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, null, %L)',
      v_id, 'exception', 'because')) like '%ADVANCE_PERCENT_INVALID%',
    'an exception with no percentage must be refused');

  -- ── The reason is mandatory, and whitespace is not a reason ──
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, 10, null)',
      v_id, 'exception')) like '%ADVANCE_REASON_REQUIRED%',
    'an exception with no reason must be refused');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, 10, %L)',
      v_id, 'exception', '   ')) like '%ADVANCE_REASON_REQUIRED%',
    'a whitespace reason is not a reason');

  -- ── An unknown condition, and a standard carrying exception data ──
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, null, null)',
      v_id, 'whatever')) like '%ADVANCE_CONDITION_INVALID%',
    'an unknown advance condition must be refused');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, 10, %L)',
      v_id, 'standard', 'because')) like '%ADVANCE_CONDITION_INVALID%',
    'the standard requirement must not carry a percentage or a reason');

  -- ── The standard declaration succeeds, and is stored as exactly that ──
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);
  select * into v_row from public.order_submissions where id = v_id;
  perform pg_temp.ok(v_row.status = 'submitted', 'a standard declaration submits the PI');
  perform pg_temp.ok(v_row.advance_condition = 'standard', 'and records the standard condition');
  perform pg_temp.ok(v_row.advance_exception_percent is null
                     and v_row.advance_exception_reason is null
                     and v_row.advance_exception_status is null,
    'and carries no exception data at all');
  perform pg_temp.ok(pg_temp.ready(v_id),
    'a standard declaration is advance-ready');
end $$;

-- ── A missing grand total fails closed ──────────────────────────────────────

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  -- grand_total is nullable by design: a workbook may print words in I122.
  v_id := pg_temp.make_submission(null);

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, null, null)',
      v_id, 'standard')) like '%ADVANCE_TOTAL_MISSING%',
    'no standard declaration may be made against an unknown total');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, 10, %L)',
      v_id, 'exception', 'because')) like '%ADVANCE_TOTAL_MISSING%',
    'and no exception either');

  -- The same rule as a table CONSTRAINT, so direct SQL cannot route around it.
  -- The write below is shaped the way the guard trigger permits — the
  -- declaration arrives WITH the move to 'submitted' — so what refuses it is
  -- the constraint itself and nothing else.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''submitted'', advance_condition = ''standard''
         where id = %L', v_id))
      like '%advance_needs_grand_total%',
    'the missing-total rule is a constraint, not only an RPC check');
end $$;

-- ═══ C. Only the owner may propose an exception ═════════════════════════════

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);

  -- An active admin may EDIT and submit somebody's record — that is what
  -- can_edit_order_submission has always allowed — and still may not ask the
  -- business a commercial question in their name.
  perform pg_temp.act_as('admin');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.submit_order_submission_with_advance(%L, null, %L, 10, %L)',
      v_id, 'exception', 'because')) like '%ADVANCE_NOT_OWNER%',
    'an admin may not request an exception on somebody else''s PI');

  -- The stricter choice is not a request, so it is not owner-gated.
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);
  perform pg_temp.ok(
    (select advance_condition from public.order_submissions where id = v_id) = 'standard',
    'the standard requirement may be declared by anyone who may submit');
end $$;

-- ═══ D. Exception authority ═════════════════════════════════════════════════

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 12.5, 'client is a repeat buyer');

  -- The owner cannot decide their own request.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.approve_pi_advance_exception(%L)', v_id))
      like '%do not have permission%',
    'the requester may not decide their own exception');

  -- orders.approve_order ALONE is not enough. This is the whole point of the
  -- separate permission: the PI reviewer can send this record back and reject
  -- it, and still may not settle its advance.
  perform pg_temp.act_as('reviewer');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.approve_pi_advance_exception(%L)', v_id))
      like '%do not have permission%',
    'orders.approve_order alone cannot approve an advance exception');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reject_pi_advance_exception(%L, %L)', v_id, 'no'))
      like '%do not have permission%',
    'orders.approve_order alone cannot reject one either');

  -- And the exception approver holds NO PI review authority in return.
  perform pg_temp.act_as('approver');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.request_order_submission_changes(%L, %L)', v_id, 'x'))
      like '%do not have permission%',
    'the exception approver cannot send a PI back');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reject_order_submission(%L, %L)', v_id, 'x'))
      like '%do not have permission%',
    'the exception approver cannot reject a PI');

  -- The explicit grant works.
  perform public.approve_pi_advance_exception(v_id);
  perform pg_temp.ok(
    (select advance_exception_status from public.order_submissions where id = v_id) = 'approved',
    'orders.approve_advance_exception approves the exception');

  -- APPROVING THE EXCEPTION IS NOT APPROVING THE PI.
  perform pg_temp.ok(
    (select status from public.order_submissions where id = v_id) = 'submitted',
    'and leaves the PI submitted');
  perform pg_temp.ok(pg_temp.ready(v_id),
    'an approved exception is advance-ready');

  -- A second click finds nothing pending.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.approve_pi_advance_exception(%L)', v_id))
      like '%ADVANCE_NOT_PENDING%',
    'a double click cannot decide the same exception twice');
end $$;

-- An active ADMIN needs no explicit grant.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 0, 'no advance, long-standing account');

  perform pg_temp.ok(
    (select advance_exception_percent from public.order_submissions where id = v_id) = 0,
    '0%% is a legitimate proposal');

  perform pg_temp.act_as('admin');
  perform public.approve_pi_advance_exception(v_id);
  perform pg_temp.ok(
    (select advance_exception_status from public.order_submissions where id = v_id) = 'approved',
    'an active admin may decide an exception without an explicit grant');
end $$;

-- The by-id helper answers only for somebody who may already see the record, and
-- holding the exception permission alone confers no such sight.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);

  perform pg_temp.ok(public.order_submission_is_advance_ready(v_id),
    'the owner is told their own record is advance-ready');

  perform pg_temp.act_as('reviewer');
  perform pg_temp.ok(public.order_submission_is_advance_ready(v_id),
    'and so is the PI reviewer, who may see it');

  -- orders.approve_advance_exception grants the DECISION and nothing else: no
  -- order visibility, no Finance, no payment. So this caller is told nothing.
  perform pg_temp.act_as('approver');
  perform pg_temp.ok(not public.order_submission_is_advance_ready(v_id),
    'the exception permission alone reveals nothing about a record it cannot see');

  perform pg_temp.ok(pg_temp.ready(v_id),
    'while the rule itself, applied to the stored row, is unchanged by who asks');
end $$;

-- ═══ E. Rejection: atomic, mandatory reason, PI returned ════════════════════

do $$
declare
  v_id  uuid;
  v_row public.order_submissions%rowtype;
  v_n   integer;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(200000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 25, 'client pays on delivery');

  perform pg_temp.act_as('approver');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reject_pi_advance_exception(%L, null)', v_id))
      like '%ADVANCE_DECISION_REASON_REQUIRED%',
    'a rejection without a reason is refused');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reject_pi_advance_exception(%L, %L)', v_id, '   '))
      like '%ADVANCE_DECISION_REASON_REQUIRED%',
    'and whitespace is not a reason');

  perform public.reject_pi_advance_exception(v_id, '25% is too low for a first order');

  select * into v_row from public.order_submissions where id = v_id;
  perform pg_temp.ok(v_row.advance_exception_status = 'rejected', 'the exception is rejected');
  perform pg_temp.ok(v_row.status = 'needs_changes', 'and the PI is returned for correction');
  perform pg_temp.ok(v_row.review_note = '25% is too low for a first order',
    'and the reason becomes the visible correction instruction');
  perform pg_temp.ok(v_row.advance_exception_rejection_reason = v_row.review_note,
    'and is stored on the decision as well');
  perform pg_temp.ok(v_row.advance_exception_decided_by = current_setting('test.approver')::uuid
                     and v_row.advance_exception_decided_at is not null,
    'with the decision actor and time recorded');
  perform pg_temp.ok(not pg_temp.ready(v_id),
    'a rejected exception is NOT advance-ready');

  -- THE PI ITSELF IS NOT REJECTED.
  perform pg_temp.ok(v_row.rejected_by is null and v_row.rejected_at is null,
    'refusing the advance does not reject the PI');

  -- ONE EVENT FOR ONE MANAGEMENT ACTION.
  select count(*) into v_n
  from public.order_submission_activity
  where submission_id = v_id and action = 'advance_exception_rejected';
  perform pg_temp.ok(v_n = 1, 'exactly one advance_exception_rejected event is written');

  select count(*) into v_n
  from public.order_submission_activity
  where submission_id = v_id and action = 'changes_requested';
  perform pg_temp.ok(v_n = 0,
    'and no duplicate changes_requested event beside it');

  select count(*) into v_n
  from public.order_submission_activity a
  where a.submission_id = v_id
    and a.action = 'advance_exception_rejected'
    and a.previous_status = 'submitted'
    and a.new_status = 'needs_changes';
  perform pg_temp.ok(v_n = 1,
    'and the single event states the whole outcome');

  -- A decision cannot be taken once the PI has left review.
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.approve_pi_advance_exception(%L)', v_id))
      like '%NOT_UNDER_REVIEW%',
    'no exception decision is possible while the PI is not submitted');
end $$;

-- ═══ F. Resubmission ════════════════════════════════════════════════════════

do $$
declare
  v_id  uuid;
  v_row public.order_submissions%rowtype;
  v_at  timestamptz;
  v_n   integer;
begin
  -- ── A rejected exception replaced by the standard requirement ──
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 20, 'trusted client');
  perform pg_temp.act_as('approver');
  perform public.reject_pi_advance_exception(v_id, 'not for a new client');

  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, 'switching to the standard advance',
                                                      'standard', null, null);
  select * into v_row from public.order_submissions where id = v_id;
  perform pg_temp.ok(v_row.advance_condition = 'standard', 'the standard replaces the rejected exception');
  perform pg_temp.ok(v_row.advance_exception_status is null
                     and v_row.advance_exception_percent is null
                     and v_row.advance_exception_reason is null
                     and v_row.advance_exception_requested_by is null
                     and v_row.advance_exception_requested_at is null
                     and v_row.advance_exception_decided_by is null
                     and v_row.advance_exception_decided_at is null
                     and v_row.advance_exception_rejection_reason is null,
    'and the whole actionable exception state is cleared from the row');
  perform pg_temp.ok(pg_temp.ready(v_id),
    'and the record is advance-ready again');

  -- HISTORY IS NOT REWRITTEN. What was asked for, and what was decided, remain.
  select count(*) into v_n
  from public.order_submission_activity
  where submission_id = v_id
    and action in ('advance_exception_requested', 'advance_exception_rejected');
  perform pg_temp.ok(v_n = 2, 'the request and the refusal are still in the trail');

  -- ── A revised exception becomes a FRESH pending request ──
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'correct the dispatch date');
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 30, 'revised proposal');
  select * into v_row from public.order_submissions where id = v_id;
  perform pg_temp.ok(v_row.advance_exception_status = 'pending', 'a revised exception is pending');
  perform pg_temp.ok(v_row.advance_exception_percent = 30, 'at the new percentage');
  perform pg_temp.ok(v_row.advance_exception_requested_by = current_setting('test.owner')::uuid
                     and v_row.advance_exception_requested_at is not null,
    'with fresh requester and time');
  perform pg_temp.ok(v_row.advance_exception_decided_by is null
                     and v_row.advance_exception_decided_at is null
                     and v_row.advance_exception_rejection_reason is null,
    'and cleared decision data');
  perform pg_temp.ok(not pg_temp.ready(v_id),
    'a fresh pending request is NOT advance-ready');
end $$;

-- An APPROVED exception survives a resubmission that does not change it, and
-- needs a fresh decision the moment it does.

do $$
declare
  v_id     uuid;
  v_row    public.order_submissions%rowtype;
  v_at     timestamptz;
  v_by     uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(500000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 15, 'long-standing account');
  perform pg_temp.act_as('approver');
  perform public.approve_pi_advance_exception(v_id);
  select advance_exception_decided_at, advance_exception_decided_by into v_at, v_by
  from public.order_submissions where id = v_id;

  -- Returned for an UNRELATED correction, resubmitted with the same choice.
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'the ship-to address is wrong');
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, 'address corrected',
                                                      'exception', 15, 'long-standing account');
  select * into v_row from public.order_submissions where id = v_id;
  perform pg_temp.ok(v_row.advance_exception_status = 'approved',
    'an unchanged approved exception is not sent back for a second decision');
  perform pg_temp.ok(v_row.advance_exception_decided_at = v_at and v_row.advance_exception_decided_by = v_by,
    'and its decision record is untouched');

  -- Numeric equality is by VALUE: 15.00 is the same proposal as 15.
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'one more correction');
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 15.00, 'long-standing account');
  perform pg_temp.ok(
    (select advance_exception_status from public.order_submissions where id = v_id) = 'approved',
    '15.00 and 15 are the same approved proposal');

  -- CHANGING THE PERCENTAGE NEEDS A FRESH DECISION.
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'and another');
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 10, 'long-standing account');
  select * into v_row from public.order_submissions where id = v_id;
  perform pg_temp.ok(v_row.advance_exception_status = 'pending',
    'changing an approved percentage requires a fresh decision');
  perform pg_temp.ok(v_row.advance_exception_decided_at is null,
    'and clears the earlier decision');
  perform pg_temp.ok(not pg_temp.ready(v_id),
    'so the record stops being advance-ready until it is decided again');
end $$;

-- Moving from standard to an exception is always a fresh request.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'fix the fabric');
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 5, 'client asked');
  perform pg_temp.ok(
    (select advance_exception_status from public.order_submissions where id = v_id) = 'pending',
    'standard → exception is a fresh pending request');
end $$;

-- The two Phase A doors are unchanged, and leave the declaration alone.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 8, 'agreed with the client');
  perform pg_temp.act_as('approver');
  perform public.approve_pi_advance_exception(v_id);
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'unrelated correction');

  perform pg_temp.act_as('owner');
  -- The original one-argument RPC, exactly as it always was.
  perform public.submit_order_submission(v_id);
  perform pg_temp.ok(
    (select advance_exception_status from public.order_submissions where id = v_id) = 'approved',
    'submit_order_submission(uuid) leaves the advance declaration exactly as it was');
  perform pg_temp.ok(
    (select status from public.order_submissions where id = v_id) = 'submitted',
    'and still submits the PI');

  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'and another');
  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_note(v_id, 'fixed it');
  perform pg_temp.ok(
    (select advance_exception_percent from public.order_submissions where id = v_id) = 8,
    'and neither does submit_order_submission_with_note(uuid, text)');
end $$;

-- ═══ G. The persisted model, against direct SQL ═════════════════════════════
--
-- Every check below is run as the OWNER of the database, which bypasses RLS
-- entirely — the position the service role is in. The refusals come from table
-- constraints and the guard trigger, so they hold for that caller too.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);

  -- Standard may not carry exception data.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_percent = 10 where id = %L', v_id))
      like '%advance_exception_fields_need_exception%',
    'the standard condition may not carry a percentage');

  -- A decided exception cannot be attached to a record that never requested one.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_status = ''pending'' where id = %L', v_id))
      like '%ADVANCE%',
    'a request cannot be back-fitted onto a record that is already under review');

  -- A decision may not be invented on a record with no pending request.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_status = ''approved'' where id = %L', v_id))
      like '%ADVANCE%',
    'a decision cannot be invented where no request is pending');
end $$;

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 10, 'agreed');

  -- Excessive precision is REFUSED, never rounded into something else.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_percent = 10.005 where id = %L', v_id))
      like '%advance_exception_percent_valid%',
    'three decimal places are refused rather than rounded');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_percent = ''NaN''::numeric where id = %L', v_id))
      like '%advance_exception_percent_valid%',
    'NaN is refused by the constraint too');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_percent = 40 where id = %L', v_id))
      like '%advance_exception_percent_valid%',
    'the standard itself is not an exception');

  -- A pending request may not carry a decision, and an approval may not carry
  -- a rejection reason.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_decided_at = now() where id = %L', v_id))
      like '%advance_decision_consistency%',
    'a pending request may not carry a decision time');

  -- An exception may not be half-written.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_reason = null where id = %L', v_id))
      like '%advance_exception_is_complete%',
    'an exception may not lose its reason');
end $$;

-- An unknown condition is not representable, on the ONE path the guard permits a
-- declaration to be written at all: a draft moving to 'submitted' in the same
-- statement. What refuses it there is the CHECK and nothing else.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''submitted'', advance_condition = ''maybe''
         where id = %L', v_id))
      like '%advance_condition_known%',
    'an unknown advance condition is not representable');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''submitted'', advance_condition = ''exception'',
         advance_exception_percent = 10, advance_exception_reason = ''x'',
         advance_exception_status = ''nearly'', advance_exception_requested_by = %L,
         advance_exception_requested_at = now() where id = %L',
      current_setting('test.owner'), v_id))
      similar to '%(advance_exception_status_known|advance_decision_consistency)%',
    'an unknown decision status is not representable');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''submitted'', advance_condition = ''exception'',
         advance_exception_percent = 10 where id = %L', v_id))
      like '%advance_exception_is_complete%',
    'an exception with no reason, requester or status is not representable');
end $$;

-- The guard refuses a decision on a PI that is not under review, and refuses a
-- rejection that does not return the PI.

do $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 10, 'agreed');
  perform pg_temp.act_as('reviewer');
  perform public.request_order_submission_changes(v_id, 'returned with the exception still pending');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_status = ''approved'','
      || ' advance_exception_decided_by = %L, advance_exception_decided_at = now() where id = %L',
      current_setting('test.admin'), v_id)) like '%ADVANCE_NOT_PENDING%',
    'an exception on a returned PI cannot be decided, even by direct SQL');

  perform pg_temp.act_as('owner');
  perform public.submit_order_submission_with_advance(v_id, null, 'exception', 10, 'agreed');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set advance_exception_status = ''rejected'','
      || ' advance_exception_decided_by = %L, advance_exception_decided_at = now(),'
      || ' advance_exception_rejection_reason = ''no'' where id = %L',
      current_setting('test.admin'), v_id)) like '%must return the PI for correction%',
    'a rejection that leaves the PI submitted is refused');
end $$;

-- ═══ H. What this phase still cannot do ═════════════════════════════════════

do $$
declare
  v_id uuid;
  v_n  integer;
begin
  perform pg_temp.act_as('owner');
  v_id := pg_temp.make_submission(100000);
  perform public.submit_order_submission_with_advance(v_id, null, 'standard', null, null);
  perform pg_temp.act_as('approver');

  -- APPROVAL REMAINS UNREACHABLE, for this caller and for direct SQL.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submissions set status = ''approved'' where id = %L', v_id))
      like '%TRANSITION_INVALID%',
    'an advance-ready PI still cannot be approved');

  perform pg_temp.ok(
    pg_temp.fails_with(
      'insert into public.order_submissions (submitted_by, created_by, status, advance_condition)'
      || format(' values (%L, %L, ''draft'', ''standard'')',
                current_setting('test.owner'), current_setting('test.owner')))
      like '%ADVANCE_INVALID%',
    'a submission cannot be created with a declaration already on it');

  -- No approval RPC exists to call.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('approve_order_submission', 'allocate_order_submission_number');
  perform pg_temp.ok(v_n = 0, 'no approval or numbering function exists');

  -- Nothing anywhere is approved or linked to an Order.
  select count(*) into v_n from public.order_submissions
  where status = 'approved' or order_id is not null;
  perform pg_temp.ok(v_n = 0, 'no submission is approved or linked to an Order');

  -- HISTORY IS APPEND-ONLY, still.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'update public.order_submission_activity set note = ''edited'' where submission_id = %L', v_id))
      is not null,
    'the activity trail is not editable through any client path');
end $$;

-- ═══ I. Privileges ══════════════════════════════════════════════════════════

do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- The implementation and the guard reach no role.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('submit_order_submission_advance_internal',
                      'submit_order_submission_internal',
                      'order_submissions_guard_advance_exception',
                      'log_order_submission_activity')
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  perform pg_temp.ok(v_bad is null,
    format('these internal functions are executable by a role: %s', coalesce(v_bad, '')));

  -- The three client doors are authenticated-only.
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('submit_order_submission_with_advance',
                         'approve_pi_advance_exception',
                         'reject_pi_advance_exception')
    and grantee in ('anon', 'PUBLIC');
  perform pg_temp.ok(v_n = 0, 'no advance RPC is executable by anon or PUBLIC');

  select count(distinct routine_name) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('submit_order_submission_with_advance',
                         'approve_pi_advance_exception',
                         'reject_pi_advance_exception')
    and grantee = 'authenticated';
  perform pg_temp.ok(v_n = 3, 'all three advance RPCs are executable by authenticated');

  -- Every one of them is SECURITY DEFINER with a pinned search_path.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('submit_order_submission_advance_internal',
                      'submit_order_submission_with_advance',
                      'approve_pi_advance_exception',
                      'reject_pi_advance_exception',
                      'order_submission_is_advance_ready',
                      'order_submissions_guard_advance_exception')
    and (not p.prosecdef
         or not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
                        where cfg like 'search_path=%'));
  perform pg_temp.ok(v_bad is null,
    format('not SECURITY DEFINER with a pinned search_path: %s', coalesce(v_bad, '')));

  -- No client role gained a table write.
  select string_agg(format('%s:%s', table_name, privilege_type), ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('order_submissions', 'order_submission_items',
                       'order_submission_activity', 'order_submission_item_images')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  perform pg_temp.ok(v_bad is null, format('client roles hold write privileges: %s', coalesce(v_bad, '')));

  -- The new permission is registered deny-by-default and held by no ROLE.
  perform pg_temp.ok(exists (
    select 1 from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'orders' and pa.action_key = 'approve_advance_exception'
      and mpa.default_allowed = false),
    'orders.approve_advance_exception is registered deny-by-default');

  select count(*) into v_n
  from public.role_permissions rp
  join public.permission_modules pm on pm.id = rp.module_id
  join public.permission_actions pa on pa.id = rp.action_id
  where pm.module_key = 'orders' and pa.action_key = 'approve_advance_exception' and rp.allowed;
  perform pg_temp.ok(v_n = 0, 'and is granted through no role at all');
end $$;

do $$
begin
  raise notice 'ALL ASSERTIONS PASSED';
end $$;

rollback;
