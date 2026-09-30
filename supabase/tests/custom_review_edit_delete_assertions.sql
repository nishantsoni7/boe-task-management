-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20270223000000_customer_review_custom_edit_delete.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Run by run_custom_review_edit_delete_local.sh on the bare container it builds,
-- after the three earlier custom-review migrations and the one under test.
--
--   §1  edit pending         same row, same submitted_at, edit_count + 1, history row, no notification
--   §2  ownership            another employee, an administrator with verify, an outsider: all refused;
--                            no client role can write the table directly
--   §3  repeated requests    identical edit = unchanged; stale counter + different content = refused;
--                            second delete = already_deleted, one history row, one reversal
--   §4  edit approved        back to pending, credit HELD (ledger untouched), type locked, reviewers told;
--                            re-approval posts nothing; edited twice, still exactly one reward
--   §5  reject an edit       the held credit is reversed once; reapply refused; net balance 0
--   §6  delete approved      credit reversed once; hidden from the owner, visible to a verifier;
--                            slot freed; frozen afterwards; history says what happened
--   §7  delete pending /     nothing on the ledger
--       rejected
--   §8  closed month         edit refused; delete allowed and reverses nothing a second time
--   §9  one proof            a deleted review no longer blocks the same screenshot
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

create or replace function pg_temp.reject_as(p_verifier uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_verifier);
  v := public.reject_customer_review_custom_submission(p_id, p_reason);
  perform pg_temp.act_as_service();
  return v;
end $$;

-- An edit exactly as the PUT route makes it (no new screenshot).
create or replace function pg_temp.edit(p_actor uuid, p_id uuid, p_type text, p_remark text, p_expected integer)
returns jsonb language plpgsql as $$
declare v_published date;
begin
  select published_on into v_published from public.customer_review_custom_submissions where id = p_id;
  return public.edit_customer_review_custom_submission(
    p_id, p_actor, p_type, v_published, p_remark, p_expected, null, null, null, null, null);
end $$;

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',    'admin@example.test', 'admin',  'management', true, false, 'T-ADM'),
  ('b0000000-0000-4000-8000-00000000000b', 'Test Verifier', 'ver@example.test',   'member', 'reviews',    true, false, 'T-VER'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Ashok Choudhary','e1@example.test',   'member', 'sales',      true, false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Two',      'e2@example.test',    'member', 'sales',      true, false, 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Test Three',    'e3@example.test',    'member', 'sales',      true, false, 'T-003'),
  ('e4000000-0000-4000-8000-0000000000e4', 'Test Four',     'e4@example.test',    'member', 'sales',      true, false, 'T-004'),
  ('e5000000-0000-4000-8000-0000000000e5', 'Test Five',     'e5@example.test',    'member', 'sales',      true, false, 'T-005'),
  ('e6000000-0000-4000-8000-0000000000e6', 'Test Six',      'e6@example.test',    'member', 'sales',      true, false, 'T-006'),
  ('c0000000-0000-4000-8000-00000000000c', 'Test Outsider', 'out@example.test',   'member', 'sales',      true, false, 'T-OUT');

insert into public.test_permission_grants (user_id, module_key, action_key)
select id, 'customer_review_requests', 'use'
  from public.users where employee_code in ('T-ADM', 'T-VER', 'T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006');
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'verify'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'verify');

-- ═══ §1. Edit a pending review ═══════════════════════════════════════════════

do $$
declare
  v_id uuid := 'f1000000-0000-4000-8000-0000000000f1';
  before_row public.customer_review_custom_submissions%rowtype;
  after_row  public.customer_review_custom_submissions%rowtype;
  v jsonb;
  n_before integer;
begin
  perform pg_temp.sub('e1000000-0000-4000-8000-0000000000e1', 'text', v_id);
  select * into before_row from public.customer_review_custom_submissions where id = v_id;
  select count(*) into n_before from public.notifications;

  v := pg_temp.edit('e1000000-0000-4000-8000-0000000000e1', v_id, 'text', 'Posted on Google', 0);
  select * into after_row from public.customer_review_custom_submissions where id = v_id;

  assert (v ->> 'unchanged')::boolean = false and (v ->> 'sent_back_for_approval')::boolean = false, '§1 a real edit, not a send-back';
  assert after_row.remark = 'Posted on Google', '§1 the remark changed';
  assert after_row.submitted_at = before_row.submitted_at, '§1 the submission date did not move';
  assert after_row.submission_ref = before_row.submission_ref and after_row.id = before_row.id, '§1 same row, same reference';
  assert after_row.status = 'pending_verification', '§1 still pending';
  assert after_row.edit_count = 1 and after_row.last_edited_at is not null, '§1 edit_count 1';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'edited') = 1,
    '§1 one edited event';
  assert (select details -> 'previous' ->> 'remark' from public.customer_review_custom_submission_events
           where submission_id = v_id and event_type = 'edited') is null
     and (select details -> 'current' ->> 'remark' from public.customer_review_custom_submission_events
           where submission_id = v_id and event_type = 'edited') = 'Posted on Google',
    '§1 the event keeps before and after';
  assert (select count(*) from public.notifications) = n_before, '§1 editing a pending review notifies nobody';
  raise notice 'PASS  §1 a pending review is edited in place; date, slot and reference keep; the history records it';
end $$;

-- ═══ §2. Ownership ═══════════════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$select pg_temp.edit('e2000000-0000-4000-8000-0000000000e2', 'f1000000-0000-4000-8000-0000000000f1', 'text', 'Hijack', 1)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER', '§2 another employee cannot edit it');
select pg_temp.must_refuse(
  $q$select pg_temp.edit('a0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-0000000000f1', 'text', 'Admin edit', 1)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER', '§2 an administrator with verify cannot edit it');
select pg_temp.must_refuse(
  $q$select pg_temp.edit('c0000000-0000-4000-8000-00000000000c', 'f1000000-0000-4000-8000-0000000000f1', 'text', 'Outsider', 1)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§2 someone without the use permission cannot edit it');
select pg_temp.must_refuse(
  $q$select public.delete_customer_review_custom_submission('f1000000-0000-4000-8000-0000000000f1', 'e2000000-0000-4000-8000-0000000000e2')$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER', '§2 another employee cannot delete it');
select pg_temp.must_refuse(
  $q$select public.delete_customer_review_custom_submission('f1000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-00000000000a')$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER', '§2 an administrator cannot delete it');

-- No client role can write the table or call the functions directly.
select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set remark = 'direct' where id = 'f1000000-0000-4000-8000-0000000000f1'$q$,
  '42501', 'permission denied', '§2 the owner cannot UPDATE the table directly');
select pg_temp.must_refuse(
  $q$delete from public.customer_review_custom_submissions where id = 'f1000000-0000-4000-8000-0000000000f1'$q$,
  '42501', 'permission denied', '§2 the owner cannot DELETE from the table directly');
select pg_temp.must_refuse(
  $q$select public.edit_customer_review_custom_submission('f1000000-0000-4000-8000-0000000000f1', 'e1000000-0000-4000-8000-0000000000e1', 'text', current_date, 'x', 1, null, null, null, null, null)$q$,
  '42501', 'permission denied', '§2 the browser cannot call the edit function');
select pg_temp.must_refuse(
  $q$select public.delete_customer_review_custom_submission('f1000000-0000-4000-8000-0000000000f1', 'e1000000-0000-4000-8000-0000000000e1')$q$,
  '42501', 'permission denied', '§2 the browser cannot call the delete function');
select pg_temp.act_as_service();

do $$
begin
  assert (select remark from public.customer_review_custom_submissions where id = 'f1000000-0000-4000-8000-0000000000f1') = 'Posted on Google',
    '§2 nothing above changed the review';
  raise notice 'PASS  §2 ownership is enforced by the database: nobody else, no direct writes';
end $$;

-- ═══ §3. Repeated requests ═══════════════════════════════════════════════════

do $$
declare
  v jsonb;
begin
  -- The same edit again (a double click; the browser still says edit_count 0).
  v := pg_temp.edit('e1000000-0000-4000-8000-0000000000e1', 'f1000000-0000-4000-8000-0000000000f1', 'text', 'Posted on Google', 0);
  assert (v ->> 'unchanged')::boolean = true, '§3 an identical repeat is answered as unchanged';
  assert (select edit_count from public.customer_review_custom_submissions where id = 'f1000000-0000-4000-8000-0000000000f1') = 1,
    '§3 and the counter did not move';
  assert (select count(*) from public.customer_review_custom_submission_events
           where submission_id = 'f1000000-0000-4000-8000-0000000000f1' and event_type = 'edited') = 1,
    '§3 and no second history row';
  raise notice 'PASS  §3 an identical repeat changes nothing';
end $$;
select pg_temp.must_refuse(
  $q$select pg_temp.edit('e1000000-0000-4000-8000-0000000000e1', 'f1000000-0000-4000-8000-0000000000f1', 'text', 'A different remark', 0)$q$,
  '40001', 'CUSTOMER_REVIEW_CUSTOM_STALE', '§3 a stale counter with different content is refused');

-- ═══ §4. Editing an approved review ══════════════════════════════════════════

do $$
declare
  v_id uuid := 'f4000000-0000-4000-8000-0000000000f4';
  e3   uuid := 'e3000000-0000-4000-8000-0000000000e3';
  v jsonb;
  n_before integer;
begin
  perform pg_temp.sub(e3, 'text', v_id);
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  assert public.boe_credit_balance(e3) = 1, '§4 approved: 1 credit';

  select count(*) into n_before from public.notifications;
  v := pg_temp.edit(e3, v_id, 'text', 'Edited after approval', 0);

  assert (v ->> 'sent_back_for_approval')::boolean, '§4 the edit reports it went back for approval';
  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'pending_verification', '§4 pending again';
  assert (select reward_held from public.customer_review_custom_submissions where id = v_id), '§4 the credit is held';
  assert (select credits_awarded from public.customer_review_custom_submissions where id = v_id) = 1, '§4 the held amount is kept';
  assert public.boe_credit_balance(e3) = 1, '§4 the ledger is untouched by the edit';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e3) = 1, '§4 no ledger row was written';
  assert (select count(*) from public.notifications) > n_before, '§4 reviewers are told an approved review was edited';
  assert exists (select 1 from public.notifications where entity_id = v_id and title like '%edited an approved custom Text Review%'),
    '§4 the sentence names the edit';
  assert (select (details ->> 'sent_back_for_approval')::boolean from public.customer_review_custom_submission_events
           where submission_id = v_id and event_type = 'edited'), '§4 the event says it was sent back';

  -- The type of an approved review cannot change.
  begin
    perform pg_temp.edit(e3, v_id, 'image', 'Now an image', 1);
    raise exception '§4 changing the type of an approved review was allowed';
  exception when sqlstate '22023' then
    raise notice 'PASS  §4 the type of an approved review is locked';
  end;

  -- Re-approval posts nothing.
  v := pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  assert (v ->> 'reaffirmed')::boolean, '§4 re-approval is reported as reaffirmed';
  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'approved', '§4 approved again';
  assert not (select reward_held from public.customer_review_custom_submissions where id = v_id), '§4 the hold is released';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e3 and transaction_type = 'review_reward') = 1,
    '§4 exactly ONE reward for the review';
  assert public.boe_credit_balance(e3) = 1, '§4 the balance is still 1';

  -- Edited twice more, approved twice more.
  perform pg_temp.edit(e3, v_id, 'text', 'Second edit', 1);
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  perform pg_temp.edit(e3, v_id, 'text', 'Third edit', 2);
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  assert public.boe_credit_balance(e3) = 1, '§4 three edits, three re-approvals: still 1 credit';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e3) = 1, '§4 still one ledger row';
  assert (select edit_count from public.customer_review_custom_submissions where id = v_id) = 3, '§4 edit_count 3';
  assert (select submitted_at from public.customer_review_custom_submissions where id = v_id)::date = (now())::date,
    '§4 submitted_at stayed the original moment';
  raise notice 'PASS  §4 an edited approved review holds its credit, is never paid twice, and keeps its date';
end $$;

-- ═══ §4b. A type change cannot leave the wrong reward amount ═════════════════
do $$
declare
  e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
  t  uuid := 'fb000000-0000-4000-8000-0000000000b1';
  res jsonb;
  bal numeric := public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1');
begin
  -- A PENDING review may change type: the reward is decided at approval, from the type it has THEN
  perform pg_temp.sub(e1, 'text', t);
  perform pg_temp.edit(e1, t, 'image', 'changed to an image review', 0);
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', t);
  assert public.boe_credit_balance(e1) = bal + 1.5, '§4b a pending text review edited to an image review is paid the IMAGE reward (1.5), once';

  -- An APPROVED review cannot change type (its posted amount is fixed and the ledger cannot re-price it)
  begin
    perform pg_temp.edit(e1, t, 'text', 'try to become text', 1);
    raise exception '§4b the type of an approved review changed';
  exception when sqlstate '22023' then null;
  end;
  -- and the same after it is edited and waiting (held)
  perform pg_temp.edit(e1, t, 'image', 'still an image review', 1);
  assert (select reward_held from public.customer_review_custom_submissions where id = t), '§4b held';
  begin
    perform pg_temp.edit(e1, t, 'text', 'try to become text while held', 2);
    raise exception '§4b the type of a held review changed';
  exception when sqlstate '22023' then null;
  end;
  assert public.boe_credit_balance(e1) = bal + 1.5, '§4b the posted 1.5 stands, unchanged, while held';
  raise notice 'PASS  §4b a type change cannot leave the wrong amount: pending re-prices at approval; approved and held are locked';
end $$;

-- ═══ §5. Rejecting an edit withdraws the held credit ═════════════════════════

do $$
declare
  v_id uuid := 'f5000000-0000-4000-8000-0000000000f5';
  e4   uuid := 'e4000000-0000-4000-8000-0000000000e4';
  v jsonb;
begin
  perform pg_temp.sub(e4, 'image', v_id);
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  assert public.boe_credit_balance(e4) = 1.5, '§5 approved: 1.5 credits';
  perform pg_temp.edit(e4, v_id, 'image', 'Swapped the proof', 0);

  v := pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', v_id, 'The edit is not a real review');
  assert (v ->> 'credit_reversed')::boolean, '§5 the rejection reports the reversal';
  assert public.boe_credit_balance(e4) = 0, '§5 the credit is withdrawn: net 0';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e4 and transaction_type = 'reversal') = 1, '§5 one reversal';
  assert (select status from public.customer_review_custom_submissions where id = v_id) = 'rejected', '§5 rejected';
  assert (select reward_reversal_transaction_id from public.customer_review_custom_submissions where id = v_id) is not null, '§5 the reversal is linked';

  -- A second rejection is a no-op and reverses nothing more.
  v := pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', v_id, 'again');
  assert (v ->> 'already_decided')::boolean, '§5 a repeat is already_decided';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e4 and transaction_type = 'reversal') = 1, '§5 still one reversal';

  begin
    perform public.reapply_customer_review_custom_submission(v_id, e4, 'image', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null);
    raise exception '§5 a review whose credit was withdrawn was reapplied';
  exception when sqlstate '55000' then
    raise notice 'PASS  §5 a withdrawn credit cannot be earned again by reapplying (submit a new review)';
  end;
  raise notice 'PASS  §5 rejecting an edit reverses the held credit once';
end $$;

-- ═══ §6. Deleting an approved review ═════════════════════════════════════════

do $$
declare
  v_id uuid := 'f6000000-0000-4000-8000-0000000000f6';
  e5   uuid := 'e5000000-0000-4000-8000-0000000000e5';
  v jsonb;
  v_slots integer;
begin
  perform pg_temp.sub(e5, 'text', v_id);
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  select submitted into v_slots from public.customer_review_custom_month_usage(
    e5, date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date, null);
  assert v_slots = 1, '§6 one slot used';

  v := public.delete_customer_review_custom_submission(v_id, e5);
  assert (v ->> 'already_deleted')::boolean = false and (v ->> 'credits_reversed')::numeric = 1, '§6 deleted; 1 credit reversed';
  assert public.boe_credit_balance(e5) = 0, '§6 the balance is back to 0';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e5 and transaction_type = 'reversal') = 1, '§6 one reversal';

  -- Idempotent.
  v := public.delete_customer_review_custom_submission(v_id, e5);
  assert (v ->> 'already_deleted')::boolean, '§6 the second delete is already_deleted';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e5 and transaction_type = 'reversal') = 1, '§6 still one reversal';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'deleted') = 1,
    '§6 one deleted event';
  assert (select (details ->> 'credits_reversed')::boolean from public.customer_review_custom_submission_events
           where submission_id = v_id and event_type = 'deleted'), '§6 the event says the credit was reversed';

  -- The slot is free again.
  select submitted into v_slots from public.customer_review_custom_month_usage(
    e5, date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date, null);
  assert v_slots = 0, '§6 the monthly slot is free again';

  -- Frozen: nobody edits, reapplies, approves or rejects it.
  begin
    perform pg_temp.edit(e5, v_id, 'text', 'zombie', 0);
    raise exception '§6 a deleted review was edited';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
    raise exception '§6 a deleted review was approved';
  exception when sqlstate 'P0002' then null;
  end;
  raise notice 'PASS  §6 delete reverses once, is idempotent, frees the slot and freezes the row';
end $$;

-- Visibility: hidden from the owner, kept for a verifier.
select pg_temp.act_as('e5000000-0000-4000-8000-0000000000e5');
do $$
begin
  assert (select count(*) from public.customer_review_custom_submissions where id = 'f6000000-0000-4000-8000-0000000000f6') = 0,
    '§6 the owner no longer sees a deleted review';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = 'f6000000-0000-4000-8000-0000000000f6') = 0,
    '§6 nor its history';
end $$;
select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
do $$
begin
  assert (select count(*) from public.customer_review_custom_submissions where id = 'f6000000-0000-4000-8000-0000000000f6' and deleted_at is not null) = 1,
    '§6 a verifier still sees the deleted review';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = 'f6000000-0000-4000-8000-0000000000f6') >= 3,
    '§6 and its whole history (submitted, approved, deleted)';
end $$;
select pg_temp.act_as_service();
do $$ begin raise notice 'PASS  §6 the owner cannot see a deleted review; a verifier can, with its history'; end $$;

-- ═══ §7. Deleting a pending or a rejected review ═════════════════════════════

do $$
declare
  e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
  p  uuid := 'f7000000-0000-4000-8000-0000000000f7';
  r  uuid := 'f7000000-0000-4000-8000-0000000000f8';
begin
  perform pg_temp.sub(e2, 'text', p);
  perform pg_temp.sub(e2, 'text', r);
  perform pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', r, 'Not a review');
  perform public.delete_customer_review_custom_submission(p, e2);
  perform public.delete_customer_review_custom_submission(r, e2);
  assert (select count(*) from public.boe_credit_transactions where employee_id = e2) = 0, '§7 nothing was on the ledger, nothing is';
  assert (select count(*) from public.customer_review_custom_submissions where submitted_by = e2 and deleted_at is not null) = 2, '§7 both kept, deleted';
  raise notice 'PASS  §7 deleting a pending or rejected review touches no ledger row';
end $$;

-- ═══ §8. A closed month ══════════════════════════════════════════════════════

create temporary table last_month on commit drop as
select (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month')::date as m;

insert into public.customer_review_custom_submissions (
  id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type,
  proof_byte_size, proof_content_sha256, submitted_at
)
select v.id, 'e6000000-0000-4000-8000-0000000000e6', 'text', (select m from last_month) + 5,
       v.id::text || '/proof/old.png', 'old.png', 'image/png', 100, md5(v.id::text) || md5(v.id::text || 'y'),
       ((select m from last_month) + interval '10 days')::timestamp at time zone 'Asia/Kolkata'
  from (values ('f8000000-0000-4000-8000-0000000000a1'::uuid)) as v(id);

do $$
declare
  e6 uuid := 'e6000000-0000-4000-8000-0000000000e6';
  v_id uuid := 'f8000000-0000-4000-8000-0000000000a1';
  v jsonb;
begin
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  v := public.finalize_boe_credit_review_month(e6, (select m from last_month), 'a0000000-0000-4000-8000-00000000000a');
  assert v ->> 'status' = 'lapsed', '§8 the month lapsed (1 of 3)';
  assert public.boe_credit_balance(e6) = 0, '§8 the lapse removed the provisional credit';

  begin
    perform pg_temp.edit(e6, v_id, 'text', 'late edit', 0);
    raise exception '§8 a lapsed month was edited';
  exception when sqlstate '55000' then
    raise notice 'PASS  §8 a review in a closed month cannot be edited';
  end;

  v := public.delete_customer_review_custom_submission(v_id, e6);
  assert (v ->> 'already_deleted')::boolean = false and (v ->> 'credits_reversed')::numeric = 0, '§8 deleted, nothing reversed a second time';
  assert public.boe_credit_balance(e6) = 0, '§8 the balance did not go negative';
  assert (select count(*) from public.boe_credit_transactions where employee_id = e6 and transaction_type = 'reversal') = 0, '§8 no reversal posted';
  raise notice 'PASS  §8 deleting a review from a closed month takes nothing twice';
end $$;

-- ═══ §9. A deleted review does not block the same proof ══════════════════════

do $$
declare
  e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
  old_id uuid := 'f9000000-0000-4000-8000-0000000000a1';
  new_id uuid := 'f9000000-0000-4000-8000-0000000000a2';
begin
  perform pg_temp.sub(e1, 'image', old_id);
  perform public.delete_customer_review_custom_submission(old_id, e1);
  -- The same screenshot bytes (same digest) for a new submission.
  perform public.create_customer_review_custom_submission(
    new_id, e1, 'image', (now() at time zone 'Asia/Kolkata')::date, null,
    new_id::text || '/proof/shot.png', 'shot.png', 'image/png', 2048,
    md5(old_id::text) || md5(old_id::text || 'x'));
  assert exists (select 1 from public.customer_review_custom_submissions where id = new_id), '§9 the same proof can be submitted again';
  assert exists (select 1 from public.customer_review_custom_submissions where id = old_id and deleted_at is not null),
    '§9 and the deleted one is still there as evidence';
  raise notice 'PASS  §9 a deleted review no longer blocks the same screenshot, and stays as evidence';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
