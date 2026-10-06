-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20270304000000_customer_review_admin_reject_and_delete.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Run by run_custom_review_edit_delete_local.sh on the bare container it builds,
-- after the earlier custom-review migrations and the one under test.
--
--   §1  authority        a verifier who is not an administrator, the employee who owns the review, a
--                        signed-out caller: all refused on BOTH functions, at the database; no client
--                        role can write the table; the ordinary Reject still refuses an approved review
--   §2  reject approved  status, reason, who and when stored; the row, screenshot and the original
--                        'approved' event kept; a 'rejected' event with previous/new status, the
--                        administrator, the reason and the approval taken back; credit reversed once
--   §3  reason           empty and over-long reasons refused, nothing changed
--   §4  repeats          a second rejection = already_decided: one reversal, one rejected event
--   §5  wrong state      pending → NOT_APPROVED; the administrator's own review → SELF; deleted → not found
--   §6  original month   a review submitted last month is recounted in LAST month, never this one
--   §7  qualified month  a month that qualified stays qualified; its approved count drops by one
--   §8  admin delete     pending / approved / rejected / edited-and-held: hidden from the owner, visible
--                        to a verifier, slot freed, credit reversed once, idempotent, frozen afterwards
--   §9  reports          rejected and deleted reviews are out of eligible, credits and the leaderboard
--   §10 lapsed month     an approved review whose month already lapsed is rejected without a second reversal
--   §11 the guard        approved → rejected is refused with no marker, with a marker for another row, and
--                        with the marker but a rejecting user who is not an administrator
--
-- ONE TRANSACTION, ROLLED BACK. Refuses to run if public.users holds anybody.
-- ⚠ NOT RUN AGAINST PRODUCTION.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'none', true);
end $$;

create or replace function pg_temp.must_refuse(p_sql text, p_sqlstate text, p_marker text, p_label text)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception '% — refused, but with SQLSTATE % not %: %', p_label, v_state, p_sqlstate, v_msg;
    end if;
    if position(p_marker in v_msg) = 0 then
      raise exception '% — refused, but not with %: %', p_label, p_marker, v_msg;
    end if;
    raise notice 'PASS  % (% %)', p_label, v_state, p_marker;
    return;
  end;
  raise exception '% — WAS ALLOWED, and must not be', p_label;
end $$;

create or replace function pg_temp.sub(p_actor uuid, p_type text, p_id uuid default gen_random_uuid())
returns uuid language plpgsql as $$
begin
  perform public.create_customer_review_custom_submission(
    p_id, p_actor, p_type, (now() at time zone 'Asia/Kolkata')::date, null,
    p_id::text || '/proof/shot.png', 'shot.png', 'image/png', 2048,
    md5(p_id::text) || md5(p_id::text || 'x')
  );
  return p_id;
end $$;

create or replace function pg_temp.approve_as(p_verifier uuid, p_id uuid)
returns jsonb language plpgsql as $$
declare
  v_type text;
  v_amount numeric;
  v jsonb;
begin
  select review_type into v_type from public.customer_review_custom_submissions where id = p_id;
  select case v_type when 'image' then image_review_reward_credits else review_reward_credits end
    into v_amount from public.boe_credit_settings order by created_at desc limit 1;
  perform pg_temp.act_as(p_verifier);
  v := public.approve_customer_review_custom_submission(p_id, v_amount);
  perform pg_temp.act_as_service();
  return v;
end $$;

create or replace function pg_temp.admin_reject(p_admin uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_admin);
  v := public.admin_reject_customer_review_custom_submission(p_id, p_reason);
  perform pg_temp.act_as_service();
  return v;
end $$;

create or replace function pg_temp.admin_delete(p_admin uuid, p_id uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_admin);
  v := public.admin_delete_customer_review_custom_submission(p_id);
  perform pg_temp.act_as_service();
  return v;
end $$;

-- A review submitted ON a given day of last month (back-dated), exactly as the other suites do.
create or replace function pg_temp.old_sub(p_actor uuid, p_id uuid, p_day integer)
returns uuid language plpgsql as $$
declare v_last date := (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month')::date;
begin
  insert into public.customer_review_custom_submissions (
    id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type,
    proof_byte_size, proof_content_sha256, submitted_at
  ) values (
    p_id, p_actor, 'text', v_last + 5, p_id::text || '/proof/old.png', 'old.png', 'image/png', 100,
    md5(p_id::text) || md5(p_id::text || 'y'), (v_last + p_day)::timestamp at time zone 'Asia/Kolkata'
  );
  return p_id;
end $$;

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',     'admin@example.test', 'admin',  'management', true, false, 'T-ADM'),
  ('a1000000-0000-4000-8000-0000000000a1', 'Second Admin',   'admin2@example.test','admin',  'management', true, false, 'T-AD2'),
  ('b0000000-0000-4000-8000-00000000000b', 'Test Verifier',  'ver@example.test',   'member', 'reviews',    true, false, 'T-VER'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Ashok Choudhary','e1@example.test',    'member', 'sales',      true, false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Two',       'e2@example.test',    'member', 'sales',      true, false, 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Test Three',     'e3@example.test',    'member', 'sales',      true, false, 'T-003'),
  ('e4000000-0000-4000-8000-0000000000e4', 'Test Four',      'e4@example.test',    'member', 'sales',      true, false, 'T-004'),
  ('e5000000-0000-4000-8000-0000000000e5', 'Test Five',      'e5@example.test',    'member', 'sales',      true, false, 'T-005'),
  ('e6000000-0000-4000-8000-0000000000e6', 'Test Six',       'e6@example.test',    'member', 'sales',      true, false, 'T-006');

insert into public.test_permission_grants (user_id, module_key, action_key)
select id, 'customer_review_requests', 'use'
  from public.users where employee_code in ('T-ADM', 'T-AD2', 'T-VER', 'T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006');
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'verify'),
  ('a1000000-0000-4000-8000-0000000000a1', 'customer_review_requests', 'verify'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'verify');

-- ═══ §1. Authority ═══════════════════════════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e1    uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_id  uuid := 'f1000000-0000-4000-8000-0000000000f1';
begin
  perform pg_temp.sub(e1, 'text', v_id);
  perform pg_temp.approve_as(ver, v_id);

  -- A verifier who is not an administrator, calling the functions directly.
  perform pg_temp.act_as(ver);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'no longer valid')$q$, v_id),
    '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§1 a verifier who is not an administrator cannot reject an approved review');
  perform pg_temp.must_refuse(format($q$select public.admin_delete_customer_review_custom_submission(%L)$q$, v_id),
    '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§1 a verifier who is not an administrator cannot delete a review');

  -- The owner, on their own review.
  perform pg_temp.act_as(e1);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'mine')$q$, v_id),
    '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§1 the employee cannot use the administrator''s reject');
  perform pg_temp.must_refuse(format($q$select public.admin_delete_customer_review_custom_submission(%L)$q$, v_id),
    '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§1 the employee cannot use the administrator''s delete (their own delete keeps its own function)');

  -- No session at all.
  perform pg_temp.act_as_service();
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'x')$q$, v_id),
    '42501', 'Sign in', '§1 a signed-out caller is refused (reject)');
  perform pg_temp.must_refuse(format($q$select public.admin_delete_customer_review_custom_submission(%L)$q$, v_id),
    '42501', 'Sign in', '§1 a signed-out caller is refused (delete)');

  -- No client role writes the table, administrators included.
  perform pg_temp.act_as(admin);
  perform pg_temp.must_refuse(format($q$update public.customer_review_custom_submissions set status = 'rejected' where id = %L$q$, v_id),
    '42501', 'permission denied', '§1 an administrator cannot UPDATE the table directly');
  perform pg_temp.must_refuse(format($q$delete from public.customer_review_custom_submissions where id = %L$q$, v_id),
    '42501', 'permission denied', '§1 an administrator cannot DELETE from the table directly');

  -- The verifier's own Reject still refuses an approved review (it is the other function that takes approval back).
  perform pg_temp.act_as(ver);
  perform pg_temp.must_refuse(format($q$select public.reject_customer_review_custom_submission(%L, 'changed my mind')$q$, v_id),
    '55000', 'CUSTOMER_REVIEW_CUSTOM_DECIDED', '§1 the ordinary Reject still refuses an approved review');
  perform pg_temp.act_as_service();

  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'approved', '§1 nothing changed';
  assert public.boe_credit_balance(e1) = 1, '§1 the credit is untouched';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e1 and transaction_type = 'reversal') = 0, '§1 nothing reversed';
  raise notice 'PASS  §1 only an active administrator can take an approval back or delete another employee''s review';
end $$;

-- ═══ §2. Reject an approved review ═══════════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  e1    uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_id  uuid := 'f1000000-0000-4000-8000-0000000000f1';
  s     public.customer_review_custom_submissions%rowtype;
  v     jsonb;
  ev    public.customer_review_custom_submission_events%rowtype;
  v_approved_at timestamptz;
begin
  select approved_at into v_approved_at from public.customer_review_custom_submissions where id = v_id;
  v := pg_temp.admin_reject(admin, v_id, '  The review was taken down from Google  ');
  assert (v ->> 'already_decided')::boolean = false and (v ->> 'credit_reversed')::boolean = true, '§2 rejected and the credit reversed';

  select * into s from public.customer_review_custom_submissions where id = v_id;
  assert s.status = 'rejected', '§2 status is rejected';
  assert s.rejected_by = admin and s.rejected_at is not null, '§2 the administrator and the time are stored';
  assert s.rejection_reason = 'The review was taken down from Google', '§2 the (trimmed) reason is stored';
  assert s.deleted_at is null, '§2 not deleted';
  assert s.proof_storage_path = v_id::text || '/proof/shot.png', '§2 the screenshot is kept';
  assert s.submitted_by = e1 and s.submission_ref is not null, '§2 the submission is kept';
  assert s.credit_transaction_id is null and s.approved_by is null, '§2 the row no longer claims an approval';
  assert s.reward_reversal_transaction_id is not null, '§2 the reversal is recorded on the row';

  assert public.boe_credit_balance(e1) = 0, '§2 the balance is back to 0';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e1 and transaction_type = 'reversal') = 1, '§2 exactly one reversal';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e1 and transaction_type = 'review_reward') = 1, '§2 the original reward row is untouched';

  -- The history: the original approval survives; the new event says what happened.
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'approved') = 1,
    '§2 the original approval is still in the history';
  select * into ev from public.customer_review_custom_submission_events
   where submission_id = v_id and event_type = 'rejected';
  assert ev.actor_id = admin and ev.reason = 'The review was taken down from Google', '§2 the event names the administrator and the reason';
  assert ev.details ->> 'previous_status' = 'approved' and ev.details ->> 'new_status' = 'rejected', '§2 previous and new status';
  assert (ev.details ->> 'reversed_approval')::boolean, '§2 the event says an approval was taken back';
  assert (ev.details ->> 'previous_credits_awarded')::numeric = 1, '§2 …and how much it had paid';
  assert (ev.details ->> 'previous_approved_by')::uuid = 'b0000000-0000-4000-8000-00000000000b', '§2 …and who had approved it';
  assert (ev.details ->> 'previous_approved_at')::timestamptz = v_approved_at, '§2 …and when';
  assert (ev.details ->> 'credit_reversed')::boolean, '§2 …and that the credit was withdrawn';
  assert ev.created_at is not null, '§2 the timestamp is recorded';

  -- A reviewer cannot approve it again: the ledger pays a review once.
  perform pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
  perform pg_temp.must_refuse(format($q$select public.approve_customer_review_custom_submission(%L, 1)$q$, v_id),
    '55000', 'CUSTOMER_REVIEW_CUSTOM_DECIDED', '§2 a review whose credit was withdrawn cannot be approved again');
  perform pg_temp.act_as_service();
  raise notice 'PASS  §2 an approved review is rejected with reason and history; the credit is reversed once; the approval stays on record';
end $$;

-- ═══ §3. The reason is required ══════════════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e2    uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_id  uuid := 'f3000000-0000-4000-8000-0000000000f3';
begin
  perform pg_temp.sub(e2, 'text', v_id);
  perform pg_temp.approve_as(ver, v_id);
  perform pg_temp.act_as(admin);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, null)$q$, v_id),
    '22023', 'CUSTOMER_REVIEW_CUSTOM_INVALID', '§3 no reason');
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, '   ')$q$, v_id),
    '22023', 'CUSTOMER_REVIEW_CUSTOM_INVALID', '§3 a blank reason');
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, %L)$q$, v_id, repeat('x', 301)),
    '22023', 'under 300', '§3 a reason over 300 characters');
  perform pg_temp.act_as_service();
  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'approved', '§3 still approved';
  assert public.boe_credit_balance(e2) = 1, '§3 the credit is untouched';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'rejected') = 0,
    '§3 no history row for a refused request';
end $$;

-- ═══ §4. A repeat changes nothing ════════════════════════════════════════════

do $$
declare
  admin  uuid := 'a0000000-0000-4000-8000-00000000000a';
  admin2 uuid := 'a1000000-0000-4000-8000-0000000000a1';
  e2     uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_id   uuid := 'f3000000-0000-4000-8000-0000000000f3';
  v jsonb;
begin
  v := pg_temp.admin_reject(admin, v_id, 'Removed by the platform');
  assert (v ->> 'already_decided')::boolean = false, '§4 first click rejects';
  v := pg_temp.admin_reject(admin, v_id, 'Removed by the platform');
  assert (v ->> 'already_decided')::boolean, '§4 a double click answers already_decided';
  v := pg_temp.admin_reject(admin2, v_id, 'Another reason from a second administrator');
  assert (v ->> 'already_decided')::boolean, '§4 a second administrator arriving late answers already_decided';
  assert (select rejection_reason from public.customer_review_custom_submissions where id = v_id) = 'Removed by the platform',
    '§4 the first reason stands';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e2 and transaction_type = 'reversal') = 1, '§4 one reversal';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'rejected') = 1,
    '§4 one rejected event';
  assert public.boe_credit_balance(e2) = 0, '§4 the balance is 0, not negative';
  raise notice 'PASS  §4 repeated and concurrent rejections reverse once and write one history row';
end $$;

-- ═══ §5. Wrong state ═════════════════════════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e3    uuid := 'e3000000-0000-4000-8000-0000000000e3';
  v_pending uuid := 'f5000000-0000-4000-8000-0000000000a1';
  v_own     uuid := 'f5000000-0000-4000-8000-0000000000a2';
  v_del     uuid := 'f5000000-0000-4000-8000-0000000000a3';
begin
  perform pg_temp.sub(e3, 'text', v_pending);
  perform pg_temp.act_as(admin);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'why')$q$, v_pending),
    '55000', 'CUSTOMER_REVIEW_CUSTOM_NOT_APPROVED', '§5 a pending review is not rejected here (the ordinary Reject decides it)');

  -- The administrator's own approved review: nobody decides their own.
  perform pg_temp.act_as_service();
  perform pg_temp.sub(admin, 'text', v_own);
  perform pg_temp.approve_as(ver, v_own);
  perform pg_temp.act_as(admin);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'why')$q$, v_own),
    '42501', 'CUSTOMER_REVIEW_CUSTOM_SELF', '§5 an administrator cannot reject their own review');

  -- A deleted review no longer exists for decisions.
  perform pg_temp.act_as_service();
  perform pg_temp.sub(e3, 'text', v_del);
  perform pg_temp.approve_as(ver, v_del);
  perform pg_temp.admin_delete(admin, v_del);
  perform pg_temp.act_as(admin);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'why')$q$, v_del),
    'P0002', 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND', '§5 a deleted review cannot be rejected');
  perform pg_temp.must_refuse($q$select public.admin_reject_customer_review_custom_submission('00000000-0000-4000-8000-000000000000', 'why')$q$,
    'P0002', 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND', '§5 an unknown review is not found');
  perform pg_temp.act_as_service();
  assert (select status from public.customer_review_custom_submissions where id = v_pending) = 'pending_verification', '§5 pending stays pending';
  assert (select status from public.customer_review_custom_submissions where id = v_own) = 'approved', '§5 the administrator''s own review stays approved';
  raise notice 'PASS  §5 only an approved, live review that is not the administrator''s own can be rejected here';
end $$;

-- ═══ §6. The ORIGINAL month is recounted ═════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e4    uuid := 'e4000000-0000-4000-8000-0000000000e4';
  v_id  uuid := 'f6000000-0000-4000-8000-0000000000a1';
  v_last date := (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month')::date;
  v_this date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v jsonb;
begin
  perform pg_temp.old_sub(e4, v_id, 10);
  perform pg_temp.approve_as(ver, v_id);
  assert (select qualifying_review_count from public.boe_credit_review_months where employee_id = e4 and review_month = v_last) = 1,
    '§6 last month counts the approved review';
  assert not exists (select 1 from public.boe_credit_review_months where employee_id = e4 and review_month = v_this),
    '§6 this month has no row for this employee';

  v := pg_temp.admin_reject(admin, v_id, 'Rejected in the next month');
  assert (v ->> 'review_month')::date = v_last, '§6 the answer names the original month';
  assert (select qualifying_review_count from public.boe_credit_review_months where employee_id = e4 and review_month = v_last) = 0,
    '§6 LAST month''s approved count dropped';
  assert (select earned_review_credits from public.boe_credit_review_months where employee_id = e4 and review_month = v_last) = 0,
    '§6 …and its earned credits';
  assert not exists (select 1 from public.boe_credit_review_months where employee_id = e4 and review_month = v_this),
    '§6 nothing was created for the month of the rejection';
  assert (select count(*) from public.boe_credit_review_rewards where employee_id = e4 and review_month = v_last) = 1,
    '§6 the reward record stays attributed to its month';
  raise notice 'PASS  §6 rejecting in October reverses the September review in September';
end $$;

-- ═══ §7. A qualified month stays qualified ═══════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e5    uuid := 'e5000000-0000-4000-8000-0000000000e5';
  ids   uuid[] := array['f7000000-0000-4000-8000-0000000000a1', 'f7000000-0000-4000-8000-0000000000a2', 'f7000000-0000-4000-8000-0000000000a3']::uuid[];
  v_this date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  i integer;
begin
  for i in 1..3 loop
    perform pg_temp.sub(e5, 'text', ids[i]);
    perform pg_temp.approve_as(ver, ids[i]);
  end loop;
  assert (select status from public.boe_credit_review_months where employee_id = e5 and review_month = v_this) = 'qualified', '§7 three approvals qualify the month';
  assert (select qualifying_review_count from public.boe_credit_review_months where employee_id = e5 and review_month = v_this) = 3, '§7 count 3';
  assert public.boe_credit_balance(e5) = 3, '§7 3 credits';

  perform pg_temp.admin_reject(admin, ids[1], 'One was removed');
  assert (select qualifying_review_count from public.boe_credit_review_months where employee_id = e5 and review_month = v_this) = 2, '§7 the approved count is 2';
  assert (select status from public.boe_credit_review_months where employee_id = e5 and review_month = v_this) = 'qualified',
    '§7 the month stays qualified (the existing rule: a status never moves back)';
  assert public.boe_credit_balance(e5) = 2, '§7 the balance is 2';
  raise notice 'PASS  §7 the approved count drops by one; a qualified month stays qualified';
end $$;

-- ═══ §8. Admin deletion, in every status ═════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  admin2 uuid := 'a1000000-0000-4000-8000-0000000000a1';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e6    uuid := 'e6000000-0000-4000-8000-0000000000e6';
  v_pen uuid := 'f8000000-0000-4000-8000-0000000000a1';
  v_app uuid := 'f8000000-0000-4000-8000-0000000000a2';
  v_rej uuid := 'f8000000-0000-4000-8000-0000000000a3';
  v_held uuid := 'f8000000-0000-4000-8000-0000000000a4';
  v_this date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v jsonb;
  v_n integer;
  v_published date;
begin
  perform pg_temp.sub(e6, 'text', v_pen);
  perform pg_temp.sub(e6, 'text', v_app);
  perform pg_temp.sub(e6, 'text', v_rej);
  perform pg_temp.sub(e6, 'text', v_held);
  perform pg_temp.approve_as(ver, v_app);
  -- rejected by the verifier
  perform pg_temp.act_as(ver);
  perform public.reject_customer_review_custom_submission(v_rej, 'blurry');
  perform pg_temp.act_as_service();
  -- approved, then edited by its owner: pending, credit HELD
  perform pg_temp.approve_as(ver, v_held);
  select published_on into v_published from public.customer_review_custom_submissions where id = v_held;
  perform public.edit_customer_review_custom_submission(v_held, e6, 'text', v_published, 'edited', 0, null, null, null, null, null);
  assert (select reward_held from public.customer_review_custom_submissions where id = v_held), '§8 setup: the edited review holds its credit';
  assert public.boe_credit_balance(e6) = 2, '§8 setup: two credits in the balance (approved + held)';
  select submitted into v_n from public.customer_review_custom_month_usage(e6, v_this, null);
  assert v_n = 4, '§8 setup: four slots used';

  -- pending: nothing on the ledger
  v := pg_temp.admin_delete(admin, v_pen);
  assert (v ->> 'already_deleted')::boolean = false and (v ->> 'credit_reversed')::boolean = false, '§8 pending: deleted, nothing reversed';
  -- rejected: nothing on the ledger
  v := pg_temp.admin_delete(admin, v_rej);
  assert (v ->> 'credit_reversed')::boolean = false, '§8 rejected: nothing reversed';
  assert public.boe_credit_balance(e6) = 2, '§8 the balance has not moved yet';
  -- approved: reversed once
  v := pg_temp.admin_delete(admin, v_app);
  assert (v ->> 'credit_reversed')::boolean, '§8 approved: the credit is reversed';
  assert public.boe_credit_balance(e6) = 1, '§8 the balance dropped by 1';
  -- edited and held: reversed once
  v := pg_temp.admin_delete(admin, v_held);
  assert (v ->> 'credit_reversed')::boolean, '§8 held: the credit is reversed';
  assert public.boe_credit_balance(e6) = 0, '§8 the balance is 0';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e6 and transaction_type = 'reversal') = 2, '§8 two reversals in total';

  -- Idempotent, also from a second administrator.
  v := pg_temp.admin_delete(admin2, v_app);
  assert (v ->> 'already_deleted')::boolean and (v ->> 'credit_reversed')::boolean = false, '§8 a repeat answers already_deleted';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e6 and transaction_type = 'reversal') = 2, '§8 still two reversals';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_app and event_type = 'deleted') = 1, '§8 one deleted event';
  assert (select (details ->> 'by_owner')::boolean from public.customer_review_custom_submission_events where submission_id = v_app and event_type = 'deleted') = false,
    '§8 the event says it was not the owner';
  assert (select actor_id from public.customer_review_custom_submission_events where submission_id = v_app and event_type = 'deleted') = admin,
    '§8 the event names the administrator';
  assert (select deleted_by from public.customer_review_custom_submissions where id = v_app) = admin, '§8 deleted_by is the administrator';

  -- Slots freed, the month recounted.
  select submitted into v_n from public.customer_review_custom_month_usage(e6, v_this, null);
  assert v_n = 0, '§8 every slot is free again';
  assert (select qualifying_review_count from public.boe_credit_review_months where employee_id = e6 and review_month = v_this) = 0, '§8 the month''s approved count is 0';

  -- Hidden from the owner, kept for a verifier.
  perform pg_temp.act_as(e6);
  assert (select count(*) from public.customer_review_custom_submissions where id in (v_pen, v_app, v_rej, v_held)) = 0, '§8 the owner no longer sees them';
  perform pg_temp.act_as(ver);
  assert (select count(*) from public.customer_review_custom_submissions where id in (v_pen, v_app, v_rej, v_held) and deleted_at is not null) = 4,
    '§8 a verifier still reads all four, with their history';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_app) >= 3, '§8 the history survived';
  perform pg_temp.act_as_service();

  -- Frozen.
  perform pg_temp.act_as(admin);
  perform pg_temp.must_refuse(format($q$select public.admin_reject_customer_review_custom_submission(%L, 'x')$q$, v_app),
    'P0002', 'NOT_FOUND', '§8 a deleted review cannot be rejected');
  perform pg_temp.act_as_service();
  raise notice 'PASS  §8 an administrator deletes pending, approved, rejected and held reviews; credits reversed once; history kept';
end $$;

-- ═══ §9. Reports, targets and the leaderboard ════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  e1    uuid := 'e1000000-0000-4000-8000-0000000000e1';
  e5    uuid := 'e5000000-0000-4000-8000-0000000000e5';
  e6    uuid := 'e6000000-0000-4000-8000-0000000000e6';
  s jsonb;
  b jsonb;
begin
  perform pg_temp.act_as(admin);
  -- e1: one review, approved then rejected: submitted 1, eligible 0, 0 credits.
  s := (public.customer_review_report(null, e1, null, null)) -> 'summary';
  assert (s ->> 'submitted')::int = 1 and (s ->> 'rejected')::int = 1 and (s ->> 'approved')::int = 0, '§9 rejected after approval: submitted, rejected, not approved';
  assert (s ->> 'eligible')::int = 0 and (s ->> 'credits')::numeric = 0, '§9 …not eligible, no credits';
  -- e5: three approved, one rejected: eligible 2.
  s := (public.customer_review_report(null, e5, null, null)) -> 'summary';
  assert (s ->> 'submitted')::int = 3 and (s ->> 'eligible')::int = 2 and (s ->> 'credits')::numeric = 2, '§9 two of three still eligible, 2 credits';
  -- e6: everything deleted: out of every total.
  s := (public.customer_review_report(null, e6, null, null)) -> 'summary';
  assert (s ->> 'submitted')::int = 0 and (s ->> 'eligible')::int = 0 and (s ->> 'credits')::numeric = 0, '§9 deleted reviews are in no total';

  -- The leaderboard ranks by eligible reviews.
  b := public.customer_review_leaderboard(null);
  assert not exists (select 1 from jsonb_array_elements(b -> 'rows') r where (r ->> 'employee_id')::uuid in (e1, e6) and (r ->> 'reviews')::int > 0),
    '§9 the rejected and the fully deleted employees have no eligible reviews on the leaderboard';
  assert (select (r ->> 'reviews')::int from jsonb_array_elements(b -> 'rows') r where (r ->> 'employee_id')::uuid = e5) = 2,
    '§9 the employee with one rejected review is on 2';
  perform pg_temp.act_as_service();
  raise notice 'PASS  §9 rejected and deleted reviews are out of eligible counts, credits, reports and the leaderboard';
end $$;

-- ═══ §10. A lapsed month is not reversed twice ═══════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e2    uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_id  uuid := 'fa000000-0000-4000-8000-0000000000a1';
  v_last date := (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month')::date;
  v jsonb;
  v_before numeric;
begin
  perform pg_temp.old_sub(e2, v_id, 12);
  perform pg_temp.approve_as(ver, v_id);
  v := public.finalize_boe_credit_review_month(e2, v_last, admin);
  assert v ->> 'status' = 'lapsed', '§10 the month lapsed (1 of 3)';
  v_before := public.boe_credit_balance(e2);

  v := pg_temp.admin_reject(admin, v_id, 'Removed after the month closed');
  assert (v ->> 'credit_reversed')::boolean = false and (v ->> 'credit_expired')::boolean, '§10 nothing reversed a second time; reported as expired';
  assert public.boe_credit_balance(e2) = v_before, '§10 the balance did not move';
  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'rejected', '§10 but the review is rejected';
  assert (select status from public.boe_credit_review_months where employee_id = e2 and review_month = v_last) = 'lapsed', '§10 the month stays lapsed';
  raise notice 'PASS  §10 a lapsed month''s credit, already removed by the lapse, is not taken twice';
end $$;

-- ═══ §11. The guard ══════════════════════════════════════════════════════════

do $$
declare
  admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  ver   uuid := 'b0000000-0000-4000-8000-00000000000b';
  e1    uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_id  uuid := 'fb000000-0000-4000-8000-0000000000a1';
  v_other uuid := 'fb000000-0000-4000-8000-0000000000a2';
  v_sql text;
begin
  -- Fixtures: two approved reviews (the guard test runs as the table owner — no role switch — so only the guard stands in the way).
  perform pg_temp.sub(e1, 'image', v_id);
  perform pg_temp.approve_as(ver, v_id);
  v_sql := format($q$update public.customer_review_custom_submissions
       set status = 'rejected', rejected_by = %L, rejected_at = now(), rejection_reason = 'x',
           approved_by = null, approved_at = null, credits_awarded = null, credit_transaction_id = null
     where id = %L$q$, admin, v_id);

  -- No marker at all: current_setting(..., true) is NULL and NULL must not pass.
  perform set_config('boe.custom_review_admin_reject', '', true);
  perform pg_temp.must_refuse(v_sql, '42501', 'a decided custom review submission is final', '§11 approved → rejected without the marker is refused');

  -- A marker for ANOTHER review.
  perform set_config('boe.custom_review_admin_reject', v_other::text, true);
  perform pg_temp.must_refuse(v_sql, '42501', 'a decided custom review submission is final', '§11 a marker for another review does not open this one');

  -- The marker for this review, but the rejecting user is not an administrator.
  perform set_config('boe.custom_review_admin_reject', v_id::text, true);
  perform pg_temp.must_refuse(replace(v_sql, quote_literal(admin::text), quote_literal(ver::text)), '42501',
    'a decided custom review submission is final', '§11 the marker alone is not enough: the rejecting user must be an administrator');
  perform set_config('boe.custom_review_admin_reject', '', true);

  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'approved', '§11 nothing changed';
  raise notice 'PASS  §11 the guard opens only for the administrator function''s own transaction';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
