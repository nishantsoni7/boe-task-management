-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20270225000000_customer_review_reporting_and_leaderboard.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Run by run_custom_review_edit_delete_local.sh after the duplicate suite.
--
--   §1  fixtures        a month with ties, a zero-submission employee, a deleted review, an
--                       administrator-reversed credit, an edited (held) review, a pending duplicate
--   §2  who may call    a verifier the report; an employee and an outsider refused; everyone the leaderboard
--   §3  the summary     submitted, text + image = submitted, eligible < submitted, credits, points, duplicates
--   §4  reconciliation  employee rows, daily bars and monthly history sum to the cards; the leaderboard to eligible
--   §5  month boundaries the last IST second of a month is that month's, the first is the next; IST not UTC
--   §6  the employees   zero-submission employees listed; highest and lowest are derivable with ties
--   §7  filters         employee, type, status, month; an impossible month refused
--   §8  lists           paginated, focus-narrowed, no text or proof, limit clamped
--   §9  the leaderboard ranks share on ties (1, 1, 3), X = leader - mine + 1, leading / joint / not taking part
--   §10 a closed month  a lapsed month keeps its earned reviews; the credits show as EXPIRED, not rejected
--   §11 no writes       the report changed no row and posted no credit
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

create temporary table cal on commit drop as
select date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date                               as m,
       (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month')::date        as l,
       (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata') as m_start;

-- A review inserted with an explicit first-submission time (insert is not guarded).
create or replace function pg_temp.put(p_id uuid, p_actor uuid, p_type text, p_at timestamptz)
returns uuid language plpgsql as $$
begin
  insert into public.customer_review_custom_submissions (
    id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type,
    proof_byte_size, proof_content_sha256, submitted_at
  ) values (
    p_id, p_actor, p_type, (p_at at time zone 'Asia/Kolkata')::date,
    p_id::text || '/proof/x.png', 'x.png', 'image/png', 100, md5(p_id::text) || md5(p_id::text || 'x'), p_at
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

create or replace function pg_temp.report(p_as uuid, p_month date default null, p_employee uuid default null, p_type text default null, p_status text default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_as);
  v := public.customer_review_report(p_month, p_employee, p_type, p_status);
  perform pg_temp.act_as_service();
  return v;
end $$;

create or replace function pg_temp.board(p_as uuid, p_month date default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_as);
  v := public.customer_review_leaderboard(p_month);
  perform pg_temp.act_as_service();
  return v;
end $$;

create or replace function pg_temp.emp(p_report jsonb, p_id uuid)
returns jsonb language sql as $$
  select e from jsonb_array_elements(p_report -> 'employees') e where (e ->> 'employee_id')::uuid = p_id
$$;

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',    'admin@example.test', 'admin',  'management', true, false, 'T-ADM'),
  ('b0000000-0000-4000-8000-00000000000b', 'Test Verifier', 'ver@example.test',   'member', 'reviews',    true, false, 'T-VER'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Asha One',      'e1@example.test',    'member', 'sales',      true, false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Bina Two',      'e2@example.test',    'member', 'sales',      true, false, 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Chetan Three',  'e3@example.test',    'member', 'sales',      true, false, 'T-003'),
  ('e4000000-0000-4000-8000-0000000000e4', 'Dev Four',      'e4@example.test',    'member', 'sales',      true, false, 'T-004'),
  ('e5000000-0000-4000-8000-0000000000e5', 'Esha Five',     'e5@example.test',    'member', 'sales',      true, false, 'T-005'),
  ('e6000000-0000-4000-8000-0000000000e6', 'Farid Six',     'e6@example.test',    'member', 'sales',      true, false, 'T-006'),
  ('c0000000-0000-4000-8000-00000000000c', 'Outsider',      'out@example.test',   'member', 'sales',      true, false, 'T-OUT');

insert into public.test_permission_grants (user_id, module_key, action_key)
select id, 'customer_review_requests', 'use'
  from public.users where employee_code in ('T-ADM', 'T-VER', 'T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006');
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'verify'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'verify');

-- ═══ §1. Fixtures ════════════════════════════════════════════════════════════

do $$
declare
  V   uuid := 'b0000000-0000-4000-8000-00000000000b';
  A   uuid := 'a0000000-0000-4000-8000-00000000000a';
  E1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  E2  uuid := 'e2000000-0000-4000-8000-0000000000e2';
  E3  uuid := 'e3000000-0000-4000-8000-0000000000e3';
  E4  uuid := 'e4000000-0000-4000-8000-0000000000e4';
  E5  uuid := 'e5000000-0000-4000-8000-0000000000e5';
  t   timestamptz := now();
  m_start timestamptz := (select m_start from cal);
  sid uuid;
  tx  uuid;
  i   integer;
begin
  -- E1: 3 approved text, 1 approved image, 1 pending image
  for i in 1..3 loop
    perform pg_temp.approve_as(V, pg_temp.put(('11000000-0000-4000-8000-00000000000' || i)::uuid, E1, 'text', t));
  end loop;
  perform pg_temp.approve_as(V, pg_temp.put('11000000-0000-4000-8000-000000000004', E1, 'image', t));
  perform pg_temp.put('11000000-0000-4000-8000-000000000005', E1, 'image', t);

  -- E2: 4 approved text (one then edited: back to Pending Approval, credit on hold), 1 rejected text
  perform pg_temp.approve_as(V, pg_temp.put('22000000-0000-4000-8000-000000000005', E2, 'text', t));
  for i in 1..3 loop
    perform pg_temp.approve_as(V, pg_temp.put(('22000000-0000-4000-8000-00000000000' || i)::uuid, E2, 'text', t));
  end loop;
  perform pg_temp.put('22000000-0000-4000-8000-000000000004', E2, 'text', t);
  perform pg_temp.act_as(V);
  perform public.reject_customer_review_custom_submission('22000000-0000-4000-8000-000000000004', 'Not a review');
  perform pg_temp.act_as_service();
  perform public.edit_customer_review_custom_submission(
    '22000000-0000-4000-8000-000000000003', E2, 'text', (t at time zone 'Asia/Kolkata')::date, 'edited later', 0, null, null, null, null, null);

  -- E3: 3 approved text (ties E2 on 3)
  for i in 1..3 loop
    perform pg_temp.approve_as(V, pg_temp.put(('33000000-0000-4000-8000-00000000000' || i)::uuid, E3, 'text', t));
  end loop;

  -- E4: 2 approved text, one of them then DELETED; plus a pending review at the very first instant of the month
  perform pg_temp.approve_as(V, pg_temp.put('44000000-0000-4000-8000-000000000001', E4, 'text', t));
  perform pg_temp.approve_as(V, pg_temp.put('44000000-0000-4000-8000-000000000002', E4, 'text', t));
  perform public.delete_customer_review_custom_submission('44000000-0000-4000-8000-000000000002', E4);
  perform pg_temp.put('44000000-0000-4000-8000-000000000003', E4, 'text', m_start);
  -- … and one at the last second of LAST month
  perform pg_temp.put('44000000-0000-4000-8000-000000000004', E4, 'text', m_start - interval '1 second');

  -- E5: 1 approved text whose credit an administrator then reversed
  sid := pg_temp.put('55000000-0000-4000-8000-000000000001', E5, 'text', t);
  perform pg_temp.approve_as(V, sid);
  select s.credit_transaction_id into tx from public.customer_review_custom_submissions s where s.id = sid;
  perform public.post_boe_credit_transaction(E5, 'reversal', -1, 'boe_credit_transaction', tx, 'Fixture: admin reversal', A);

  -- E4: an approved review later CONFIRMED as a duplicate: rejected, credit reversed, still submitted
  perform pg_temp.approve_as(V, pg_temp.put('44000000-0000-4000-8000-000000000005', E4, 'text', t));
  insert into public.customer_review_custom_duplicate_checks (submission_id, content_fingerprint, status, employee_proceeded, trigger_event, match_count)
  values ('44000000-0000-4000-8000-000000000005', repeat('3', 64), 'flagged', true, 'submitted', 1);
  insert into public.customer_review_custom_duplicate_flags (submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength, employee_proceeded)
  select '44000000-0000-4000-8000-000000000005', '33000000-0000-4000-8000-000000000001', c.id, repeat('3', 64), array['image', 'review_text'], 'strong', true
    from public.customer_review_custom_duplicate_checks c where c.submission_id = '44000000-0000-4000-8000-000000000005';
  perform pg_temp.act_as(V);
  perform public.decide_customer_review_custom_duplicate(
    (select id from public.customer_review_custom_duplicate_flags where submission_id = '44000000-0000-4000-8000-000000000005'), 'duplicate', 'Fixture');
  perform pg_temp.act_as_service();

  -- a strong, undecided duplicate flag on E1's pending review; a weak one on E4's boundary review
  insert into public.customer_review_custom_duplicate_checks (submission_id, content_fingerprint, status, employee_proceeded, trigger_event, match_count)
  values ('11000000-0000-4000-8000-000000000005', repeat('1', 64), 'flagged', true, 'submitted', 1),
         ('44000000-0000-4000-8000-000000000003', repeat('2', 64), 'flagged', true, 'submitted', 1);
  insert into public.customer_review_custom_duplicate_flags (submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength, employee_proceeded)
  select '11000000-0000-4000-8000-000000000005', '33000000-0000-4000-8000-000000000001', c.id, repeat('1', 64), array['image'], 'strong', true
    from public.customer_review_custom_duplicate_checks c where c.submission_id = '11000000-0000-4000-8000-000000000005';
  insert into public.customer_review_custom_duplicate_flags (submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength, employee_proceeded)
  select '44000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000001', c.id, repeat('2', 64), array['reviewer_name'], 'weak', true
    from public.customer_review_custom_duplicate_checks c where c.submission_id = '44000000-0000-4000-8000-000000000003';

  raise notice 'PASS  §1 fixtures built';
end $$;

-- ═══ §2. Who may call ════════════════════════════════════════════════════════

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse($q$select public.customer_review_report(null, null, null, null)$q$,
  '42501', 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED', '§2 an employee cannot read the admin report');
select pg_temp.must_refuse($q$select public.customer_review_report_list(null, null, null, null, 'all', 25, 0)$q$,
  '42501', 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED', '§2 nor the review list');
select pg_temp.must_refuse($q$select * from public.customer_review_report_rows(current_date, current_date, null, null, null)$q$,
  '42501', 'permission denied', '§2 nor the internal row function');
select pg_temp.act_as('c0000000-0000-4000-8000-00000000000c');
select pg_temp.must_refuse($q$select public.customer_review_report(null, null, null, null)$q$,
  '42501', 'CUSTOMER_REVIEW_REPORT_UNAUTHORIZED', '§2 an outsider cannot');
select pg_temp.act_as_service();
do $$
begin
  assert (pg_temp.board('c0000000-0000-4000-8000-00000000000c') ->> 'state') = 'not_taking_part', '§2 an outsider may read the leaderboard';
  assert jsonb_array_length(pg_temp.board('e1000000-0000-4000-8000-0000000000e1') -> 'rows') >= 6, '§2 and so may an employee';
  raise notice 'PASS  §2 the report is a verifier''s; the leaderboard is every signed-in employee''s';
end $$;

-- ═══ §3. The summary ═════════════════════════════════════════════════════════

do $$
declare
  r jsonb := pg_temp.report('b0000000-0000-4000-8000-00000000000b');
  s jsonb := r -> 'summary';
begin
  assert (r ->> 'month')::date = (select m from cal), '§3 defaults to the current IST month';
  assert (s ->> 'submitted')::int = 17, format('§3 submitted 17, got %s', s ->> 'submitted');
  assert (s ->> 'text')::int = 15 and (s ->> 'image')::int = 2, format('§3 text 15 + image 2, got %s + %s', s ->> 'text', s ->> 'image');
  assert (s ->> 'text')::int + (s ->> 'image')::int = (s ->> 'submitted')::int, '§3 text + image = submitted';
  assert (s ->> 'pending')::int = 3 and (s ->> 'approved')::int = 12 and (s ->> 'rejected')::int = 2, '§3 by status: 3 pending, 12 approved, 2 rejected';
  assert (s ->> 'eligible')::int = 11, format('§3 eligible 11 (submitted 17: 2 rejected, 3 pending incl. 1 edited on hold, 1 approved-but-reversed), got %s', s ->> 'eligible');
  assert (s ->> 'eligible')::int < (s ->> 'submitted')::int, '§3 eligible and submitted differ and are both shown';
  assert (s ->> 'eligible_text')::int = 10 and (s ->> 'eligible_image')::int = 1, '§3 eligible by type';
  assert (s ->> 'credits')::numeric = 11.5, format('§3 credits 11.5, got %s', s ->> 'credits');
  assert (s ->> 'points')::numeric = 1.15 and (r ->> 'credits_per_point')::numeric = 10, '§3 points = credits / 10 (11.5 credits = 1.15 points)';
  assert (s ->> 'held')::int = 1 and (s ->> 'held_credits')::numeric = 1, '§3 one edited review is on hold with its 1 credit, and is NOT in eligible';
  assert (s ->> 'confirmed_duplicates')::int = 1, '§3 one confirmed duplicate: submitted, rejected, not eligible';
  assert (s ->> 'reversed')::int = 2, '§3 two credits were reversed (the administrator''s, and the confirmed duplicate''s)';
  assert (s ->> 'expired_credits')::numeric = 0, '§3 nothing expired in the current month';
  assert public.customer_review_credits_per_point() = 10, '§3 the conversion lives in one function';
  -- fractional credits: 1.5 credits is 0.15 points; 0.01 credit is 0.001 point, exactly
  assert round(1.5 / public.customer_review_credits_per_point(), 3) = 0.15 and round(0.01 / public.customer_review_credits_per_point(), 3) = 0.001,
    '§3 fractional conversion is exact to three decimals';
  assert (s ->> 'duplicates_open')::int = 1, format('§3 one possible duplicate awaits a decision (the weak name match is not queued), got %s', s ->> 'duplicates_open');
  raise notice 'PASS  §3 summary: 17 submitted = 15 text + 2 image; 11 eligible; 11.5 credits = 1.15 points; held, reversed, confirmed duplicates counted apart';
end $$;

-- ═══ §4. Reconciliation ══════════════════════════════════════════════════════

do $$
declare
  r  jsonb := pg_temp.report('b0000000-0000-4000-8000-00000000000b');
  s  jsonb := r -> 'summary';
  b  jsonb := pg_temp.board('b0000000-0000-4000-8000-00000000000b');
  sums record;
begin
  select coalesce(sum((e ->> 'submitted')::int), 0) as submitted, coalesce(sum((e ->> 'text')::int), 0) as t,
         coalesce(sum((e ->> 'image')::int), 0) as i, coalesce(sum((e ->> 'eligible')::int), 0) as eligible,
         coalesce(sum((e ->> 'credits')::numeric), 0) as credits, coalesce(sum((e ->> 'points')::numeric), 0) as points
    into sums from jsonb_array_elements(r -> 'employees') e;
  assert sums.submitted = (s ->> 'submitted')::int and sums.t = (s ->> 'text')::int and sums.i = (s ->> 'image')::int,
    '§4 the employee rows add up to the cards (submitted, text, image)';
  assert sums.eligible = (s ->> 'eligible')::int and sums.credits = (s ->> 'credits')::numeric and sums.points = (s ->> 'points')::numeric,
    '§4 … and eligible, credits and points';

  assert (select coalesce(sum((d ->> 'text')::int + (d ->> 'image')::int), 0) from jsonb_array_elements(r -> 'daily') d) = (s ->> 'submitted')::int,
    '§4 the daily bars add up to submitted';
  assert (select coalesce(sum((d ->> 'text')::int), 0) from jsonb_array_elements(r -> 'daily') d) = (s ->> 'text')::int
     and (select coalesce(sum((d ->> 'image')::int), 0) from jsonb_array_elements(r -> 'daily') d) = (s ->> 'image')::int,
    '§4 … with the same text / image split';
  assert jsonb_array_length(r -> 'daily') = (select extract(day from (m + interval '1 month' - interval '1 day'))::int from cal),
    '§4 one bar per calendar day of the month';

  assert (r -> 'history' -> 11 ->> 'month')::date = (select m from cal), '§4 the history ends at the selected month';
  assert jsonb_array_length(r -> 'history') = 12, '§4 twelve months';
  assert (r -> 'history' -> 11 ->> 'submitted')::int = (s ->> 'submitted')::int
     and (r -> 'history' -> 11 ->> 'eligible')::int = (s ->> 'eligible')::int
     and (r -> 'history' -> 11 ->> 'text')::int = (s ->> 'text')::int, '§4 the current month of the history equals the cards';

  assert (select coalesce(sum((c ->> 'submitted')::int), 0) from jsonb_array_elements(r -> 'categories') c) = (s ->> 'submitted')::int,
    '§4 the category breakdown adds up';
  assert (select coalesce(sum((row ->> 'reviews')::int), 0) from jsonb_array_elements(b -> 'rows') row) = (s ->> 'eligible')::int,
    '§4 the leaderboard''s review counts add up to eligible';
  assert (select coalesce(sum((row ->> 'credits')::numeric), 0) from jsonb_array_elements(b -> 'rows') row) = (s ->> 'credits')::numeric
     and (select coalesce(sum((row ->> 'points')::numeric), 0) from jsonb_array_elements(b -> 'rows') row) = (s ->> 'points')::numeric,
    '§4 … and its credits and points add up to the cards';
  raise notice 'PASS  §4 employee rows, daily bars, history, categories and the leaderboard all reconcile with the cards';
end $$;

-- ═══ §5. Month boundaries (Asia/Kolkata, not UTC) ════════════════════════════

do $$
declare
  cur  jsonb := pg_temp.report('b0000000-0000-4000-8000-00000000000b');
  prev jsonb := pg_temp.report('b0000000-0000-4000-8000-00000000000b', (select l from cal));
  d1   jsonb;
begin
  d1 := cur -> 'daily' -> 0;
  assert (d1 ->> 'day')::date = (select m from cal), '§5 the first bar is the first of the month';
  assert (d1 ->> 'text')::int + (d1 ->> 'image')::int >= 1, '§5 the review at 00:00:00 IST on the 1st is in the new month';
  assert (pg_temp.emp(prev, 'e4000000-0000-4000-8000-0000000000e4') ->> 'submitted')::int = 1, '§5 the review at 23:59:59 IST on the last day is LAST month''s';
  assert (prev -> 'daily' -> ((select extract(day from (l + interval '1 month' - interval '1 day'))::int from cal) - 1) ->> 'text')::int = 1,
    '§5 and it sits on last month''s final bar';
  assert (pg_temp.emp(cur, 'e4000000-0000-4000-8000-0000000000e4') ->> 'submitted')::int = 3, '§5 this month keeps only its own (E4: one approved + the first-instant review + the confirmed duplicate; the deleted one is out)';
  raise notice 'PASS  §5 IST boundaries: 23:59:59 stays in the old month, 00:00:00 starts the new one';
end $$;

-- ═══ §6. The employees, zero rows and ties ═══════════════════════════════════

do $$
declare
  r jsonb := pg_temp.report('b0000000-0000-4000-8000-00000000000b');
begin
  assert pg_temp.emp(r, 'e6000000-0000-4000-8000-0000000000e6') is not null, '§6 an employee with no submissions is listed';
  assert (pg_temp.emp(r, 'e6000000-0000-4000-8000-0000000000e6') ->> 'submitted')::int = 0
     and (pg_temp.emp(r, 'e6000000-0000-4000-8000-0000000000e6') ->> 'credits')::numeric = 0, '§6 with zeros, not blanks';
  assert pg_temp.emp(r, 'c0000000-0000-4000-8000-00000000000c') is null, '§6 someone who may not use the workflow and has no reviews is not';
  assert (pg_temp.emp(r, 'e1000000-0000-4000-8000-0000000000e1') ->> 'submitted')::int = 5
     and (pg_temp.emp(r, 'e1000000-0000-4000-8000-0000000000e1') ->> 'text')::int = 3
     and (pg_temp.emp(r, 'e1000000-0000-4000-8000-0000000000e1') ->> 'image')::int = 2
     and (pg_temp.emp(r, 'e1000000-0000-4000-8000-0000000000e1') ->> 'eligible')::int = 4
     and (pg_temp.emp(r, 'e1000000-0000-4000-8000-0000000000e1') ->> 'credits')::numeric = 4.5
     and (pg_temp.emp(r, 'e1000000-0000-4000-8000-0000000000e1') ->> 'points')::numeric = 0.45, '§6 E1: 5 submitted (3 text, 2 image), 4 eligible, 4.5 credits, 0.45 points';
  assert (pg_temp.emp(r, 'e2000000-0000-4000-8000-0000000000e2') ->> 'eligible')::int = 3, '§6 E2: 5 submitted, 3 eligible — the edited review is pending, so it is excluded until re-approved';
  assert (pg_temp.emp(r, 'e2000000-0000-4000-8000-0000000000e2') ->> 'submitted')::int = 5, '§6 E2 submitted 5';
  assert (pg_temp.emp(r, 'e5000000-0000-4000-8000-0000000000e5') ->> 'submitted')::int = 1
     and (pg_temp.emp(r, 'e5000000-0000-4000-8000-0000000000e5') ->> 'eligible')::int = 0, '§6 E5: submitted 1, eligible 0 (an administrator reversed the credit)';
  assert (pg_temp.emp(r, 'e4000000-0000-4000-8000-0000000000e4') ->> 'eligible')::int = 1 and (pg_temp.emp(r, 'e4000000-0000-4000-8000-0000000000e4') ->> 'submitted')::int = 3,
    '§6 E4: 3 submitted (deleted one excluded, the confirmed duplicate kept), 1 eligible';
  -- E2 and E3 tie on 3 eligible; the report says so by giving both the same figures
  assert (pg_temp.emp(r, 'e2000000-0000-4000-8000-0000000000e2') ->> 'eligible')::int = (pg_temp.emp(r, 'e3000000-0000-4000-8000-0000000000e3') ->> 'eligible')::int,
    '§6 ties are visible: E2 and E3 both have 3';
  raise notice 'PASS  §6 zero-submission employees are listed, the deleted / reversed / edited cases count as designed';
end $$;

-- ═══ §7. Filters ═════════════════════════════════════════════════════════════

do $$
declare
  V uuid := 'b0000000-0000-4000-8000-00000000000b';
  byemp   jsonb := pg_temp.report(V, null, 'e1000000-0000-4000-8000-0000000000e1');
  bytype  jsonb := pg_temp.report(V, null, null, 'image');
  bystat  jsonb := pg_temp.report(V, null, null, null, 'rejected');
begin
  assert (byemp -> 'summary' ->> 'submitted')::int = 5 and jsonb_array_length(byemp -> 'employees') = 1, '§7 the employee filter';
  assert (bytype -> 'summary' ->> 'submitted')::int = 2 and (bytype -> 'summary' ->> 'text')::int = 0, '§7 the type filter';
  assert (bystat -> 'summary' ->> 'submitted')::int = 2 and (bystat -> 'summary' ->> 'eligible')::int = 0, '§7 the status filter (2 rejected: one ordinary, one confirmed duplicate)';
  assert jsonb_array_length(bystat -> 'employees') >= 7, '§7 a filter keeps zero-row employees visible';
  assert (bytype -> 'summary' ->> 'submitted')::int = (select coalesce(sum((e ->> 'submitted')::int), 0) from jsonb_array_elements(bytype -> 'employees') e),
    '§7 filtered cards still reconcile with filtered rows';
  raise notice 'PASS  §7 employee, type and status filters narrow every section consistently';
end $$;
select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
select pg_temp.must_refuse($q$select public.customer_review_report((date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) + interval '1 month')::date, null, null, null)$q$,
  '22023', 'That month has not started', '§7 a future month');
select pg_temp.must_refuse($q$select public.customer_review_report(null, null, 'video', null)$q$,
  '22023', 'Choose Text or Image', '§7 an unknown type');
select pg_temp.must_refuse($q$select public.customer_review_report(null, null, null, 'deleted')$q$,
  '22023', 'Choose a review status', '§7 an unknown status');
select pg_temp.act_as_service();

-- ═══ §8. Lists ═══════════════════════════════════════════════════════════════

do $$
declare
  V uuid := 'b0000000-0000-4000-8000-00000000000b';
  l jsonb;
begin
  perform pg_temp.act_as(V);
  l := public.customer_review_report_list(null, null, null, null, 'all', 5, 0);
  assert (l ->> 'total')::int = 17 and jsonb_array_length(l -> 'rows') = 5, '§8 total 17, a page of 5';
  assert jsonb_array_length((public.customer_review_report_list(null, null, null, null, 'all', 5, 15)) -> 'rows') = 2, '§8 the last page has the last 2';
  assert jsonb_array_length((public.customer_review_report_list(null, null, null, null, 'all', 5, 17)) -> 'rows') = 0, '§8 nothing beyond';
  assert (public.customer_review_report_list(null, null, null, null, 'all', 500, 0) ->> 'limit')::int = 50, '§8 the page size is clamped to 50';
  assert (public.customer_review_report_list(null, null, null, null, 'eligible', 50, 0) ->> 'total')::int = 11, '§8 the Eligible card lists the 11';
  assert (public.customer_review_report_list(null, null, null, null, 'duplicates', 50, 0) ->> 'total')::int = 1, '§8 the Duplicates card lists the 1';
  assert (public.customer_review_report_list(null, null, null, null, 'confirmed_duplicates', 50, 0) ->> 'total')::int = 1, '§8 the Confirmed duplicates card lists the 1';
  assert (public.customer_review_report_list(null, null, null, null, 'held', 50, 0) ->> 'total')::int = 1, '§8 the On hold card lists the 1';
  assert (public.customer_review_report_list(null, null, null, null, 'image', 50, 0) ->> 'total')::int = 2, '§8 the Image card lists the 2';
  assert (public.customer_review_report_list(null, null, 'text', null, 'image', 50, 0) ->> 'total')::int = 0, '§8 contradictory filters list nothing';
  assert (public.customer_review_report_list(null, 'e1000000-0000-4000-8000-0000000000e1', null, null, 'all', 50, 0) ->> 'total')::int = 5, '§8 an employee row lists their 5';
  l := public.customer_review_report_list(null, null, null, null, 'all', 50, 0);
  assert not exists (
    select 1 from jsonb_array_elements(l -> 'rows') r, jsonb_object_keys(r) k
     where k in ('review_text', 'reviewer_name', 'proof_storage_path', 'remark')),
    '§8 a row carries no review text, name or proof path';
  assert not exists (select 1 from jsonb_array_elements(l -> 'rows') r where (r ->> 'id') = '44000000-0000-4000-8000-000000000002'),
    '§8 the deleted review is not listed';
  perform pg_temp.act_as_service();
  raise notice 'PASS  §8 lists are paginated, focus-narrowed, clamped, and carry no review content';
end $$;

-- ═══ §9. The leaderboard ═════════════════════════════════════════════════════

do $$
declare
  b   jsonb := pg_temp.board('e2000000-0000-4000-8000-0000000000e2');
  row jsonb;
begin
  assert (b ->> 'leader_reviews')::int = 4 and (b ->> 'leaders')::int = 1, '§9 the leader has 4, alone';
  assert (select (r ->> 'rank')::int from jsonb_array_elements(b -> 'rows') r where (r ->> 'employee_id') = 'e1000000-0000-4000-8000-0000000000e1') = 1, '§9 E1 is 1st';
  assert (select array_agg((r ->> 'rank')::int order by ord) from jsonb_array_elements(b -> 'rows') with ordinality as t(r, ord) where (r ->> 'reviews')::int > 0)
         = array[1, 2, 2, 4], format('§9 ranks share on a tie: 1, 2, 2, 4 — got %s', (select array_agg((r ->> 'rank')::int order by ord) from jsonb_array_elements(b -> 'rows') with ordinality as t(r, ord) where (r ->> 'reviews')::int > 0));
  assert (select bool_and((r ->> 'tied')::boolean) from jsonb_array_elements(b -> 'rows') r where (r ->> 'employee_id') in ('e2000000-0000-4000-8000-0000000000e2', 'e3000000-0000-4000-8000-0000000000e3')),
    '§9 the tie is flagged on both rows, whatever order they display in';
  assert (select count(*) from jsonb_array_elements(b -> 'rows') r where (r ->> 'reviews')::int = 0 and (r ->> 'rank')::int = 5) >= 4,
    '§9 zero-review employees share the last rank';
  assert (b -> 'me' ->> 'rank')::int = 2 and (b -> 'me' ->> 'reviews')::int = 3, '§9 my own rank and count come back even if I am not on top';
  assert b ->> 'state' = 'behind' and (b ->> 'need')::int = 2, format('§9 E2 needs leader 4 - 3 + 1 = 2, got %s', b ->> 'need');
  assert (select (r ->> 'is_me')::boolean from jsonb_array_elements(b -> 'rows') r where (r ->> 'employee_id') = 'e2000000-0000-4000-8000-0000000000e2'), '§9 my row is marked';
  assert (pg_temp.board('e4000000-0000-4000-8000-0000000000e4') ->> 'need')::int = 4, '§9 E4: 4 - 1 + 1 = 4';
  assert (pg_temp.board('e6000000-0000-4000-8000-0000000000e6') ->> 'need')::int = 5, '§9 a zero-review employee: 4 - 0 + 1 = 5';
  assert pg_temp.board('e1000000-0000-4000-8000-0000000000e1') ->> 'state' = 'leading' and (pg_temp.board('e1000000-0000-4000-8000-0000000000e1') -> 'need') = 'null'::jsonb,
    '§9 the sole leader is leading and needs nothing';

  -- E3 catches up to 4 → E1 and E3 are joint leaders.
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', pg_temp.put('33000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-0000000000e3', 'text', now()));
  assert pg_temp.board('e1000000-0000-4000-8000-0000000000e1') ->> 'state' = 'joint' and (pg_temp.board('e1000000-0000-4000-8000-0000000000e1') ->> 'leaders')::int = 2,
    '§9 two on the top count are joint leaders';
  assert (pg_temp.board('e1000000-0000-4000-8000-0000000000e1') ->> 'need')::int = 1 and (pg_temp.board('e3000000-0000-4000-8000-0000000000e3') ->> 'need')::int = 1,
    '§9 a joint leader needs 1 more eligible review to be the sole leader';
  assert pg_temp.board('e3000000-0000-4000-8000-0000000000e3') ->> 'state' = 'joint', '§9 both are told so';
  assert (pg_temp.board('e2000000-0000-4000-8000-0000000000e2') ->> 'need')::int = 2, '§9 a chaser''s target does not move with a tie at the top';
  -- ordering is stable and does not hide the tie
  assert (select r ->> 'name' from jsonb_array_elements(pg_temp.board('e2000000-0000-4000-8000-0000000000e2') -> 'rows') with ordinality t(r, o) where o = 1) = 'Asha One'
     and (select r ->> 'name' from jsonb_array_elements(pg_temp.board('e2000000-0000-4000-8000-0000000000e2') -> 'rows') with ordinality t(r, o) where o = 2) = 'Chetan Three'
     and (select (r ->> 'rank')::int from jsonb_array_elements(pg_temp.board('e2000000-0000-4000-8000-0000000000e2') -> 'rows') with ordinality t(r, o) where o = 2) = 1,
    '§9 the tie shows as rank 1 twice, in name order';

  -- The dashboard card carries the same facts.
  perform pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
  assert (public.customer_review_leader_card() ->> 'need')::int = 2 and (public.customer_review_leader_card() -> 'leader_names') = '["Asha One", "Chetan Three"]'::jsonb,
    '§9 the dashboard card: the joint leaders by name, and the same target';
  perform pg_temp.act_as_service();
  assert (pg_temp.board('c0000000-0000-4000-8000-00000000000c') -> 'me') = 'null'::jsonb, '§9 someone outside the workflow has no rank';
  raise notice 'PASS  §9 shared ranks, X = leader - mine + 1, leading / joint / behind, and the dashboard card agree';
end $$;

-- ═══ §10. A closed month ═════════════════════════════════════════════════════

do $$
declare
  E3  uuid := 'e3000000-0000-4000-8000-0000000000e3';
  l_at timestamptz := ((select l from cal) + 9)::timestamp at time zone 'Asia/Kolkata';
  v jsonb;
  r jsonb;
begin
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', pg_temp.put('33000000-0000-4000-8000-000000000009', E3, 'text', l_at));
  v := public.finalize_boe_credit_review_month(E3, (select l from cal), 'a0000000-0000-4000-8000-00000000000a');
  assert v ->> 'status' = 'lapsed', '§10 last month lapsed for E3 (1 of 3)';
  r := pg_temp.report('b0000000-0000-4000-8000-00000000000b', (select l from cal));
  assert (pg_temp.emp(r, E3) ->> 'submitted')::int = 1 and (pg_temp.emp(r, E3) ->> 'eligible')::int = 1
     and (pg_temp.emp(r, E3) ->> 'credits')::numeric = 1, '§10 the closed month keeps its earned result: 1 eligible review, 1 credit';
  assert (r -> 'summary' ->> 'expired_reviews')::int = 1 and (r -> 'summary' ->> 'expired_credits')::numeric = 1,
    '§10 …reported as EXPIRED (the ledger lapsed it), not rejected and not reversed';
  assert (r -> 'summary' ->> 'rejected')::int = 0 and (r -> 'summary' ->> 'reversed')::int = 0, '§10 expiry is neither a rejection nor a reversal';
  assert (select (row ->> 'reviews')::int from jsonb_array_elements(pg_temp.board('e1000000-0000-4000-8000-0000000000e1', (select l from cal)) -> 'rows') row
           where (row ->> 'employee_id') = 'e3000000-0000-4000-8000-0000000000e3') = 1, '§10 the closed month still ranks E3 on the review they earned';
  raise notice 'PASS  §10 a closed month expires credits but keeps the historical earned result';
end $$;

-- ═══ §11. Nothing was written by reading ═════════════════════════════════════

do $$
declare n_before bigint; n_after bigint; c_before numeric; c_after numeric;
begin
  select count(*), coalesce(sum(credits), 0) into n_before, c_before from public.boe_credit_transactions;
  perform pg_temp.report('b0000000-0000-4000-8000-00000000000b');
  perform pg_temp.board('e1000000-0000-4000-8000-0000000000e1');
  select count(*), coalesce(sum(credits), 0) into n_after, c_after from public.boe_credit_transactions;
  assert n_before = n_after and c_before = c_after, '§11 reading the report and the leaderboard posted nothing';
  raise notice 'PASS  §11 the report and leaderboard are read-only';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
