-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261204000000_boe_credits_decimal_credits.sql and
-- 20261205000000_customer_review_custom_submissions.sql, executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- decimalCredits.test.ts and customSubmissions.test.ts read the SQL text. This
-- runs it, on a bare PostgreSQL container carrying the credits chain, and proves
-- what the database itself guarantees — each refusal with its SQLSTATE and marker.
--
--   §0  applied               numeric columns; integer signatures gone; the 1A
--                             settings row still reads 100
--   §1  decimal ledger        a 1.5 row is stored as 1.5; whole rows still sum;
--                             balance, view and spendable are exact; 1.555 refused
--   §2  spendable, numeric    7.5 spendable cannot pay 8 (an integer balance read
--                             8 and would have admitted it); 7.5 pays 7.5
--   §3  attendance            a half day (8) redeemed from 9.5 leaves exactly 1.5;
--                             the reversal restores 9.5
--   §4  payroll               1.5 credits × ₹50 = ₹75.00 snapshotted; retry is a
--                             no-op; 1.555 refused; removal restores the balance
--   §5  settings + reward     a 1.5 image reward is active; a generated image
--                             review posts 1.5, not 2
--   §6  submit                an employee creates their own Pending Verification
--                             row; type, date, path and duplicate refused; a
--                             future date refused; no `use` refused; a browser
--                             cannot call the registration or write the table
--   §7  visibility            own rows; a verifier all; nobody else; the proof
--                             objects follow the same rule
--   §8  who may decide        self-approval and self-rejection refused; no
--                             `verify` refused; anon refused; a verifier cannot
--                             change the amount; bad amounts refused
--   §9  approve               one review_reward of 1.5 for the submitter, the
--                             reward record, the month counted, provisional
--   §10 exactly once          approving again — any amount, any verifier — posts
--                             nothing; a raw second reward is refused by the index
--   §11 admin amount          an administrator awards 2.5 on a text review
--   §12 reject                reason required; rejected with reason; no credit;
--                             idempotent; approve-after-reject and
--                             reject-after-approve refused; the submitter reads
--                             the reason
--   §13 immutability          a decided row cannot change; nothing is deleted;
--                             only the decision may move on a pending row
--   §14 the monthly rule      three approved custom reviews qualify the month
--                             and their credits become spendable
--   §15 reversal              an administrator reverses one custom reward; the
--                             month recounts and stays qualified
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK. Refuses to run if
-- public.users holds anybody.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through
--   run_custom_review_submissions_local.sh.

\set ON_ERROR_STOP on

begin;

-- ─── helpers (the Phase 1D suite's idiom) ───────────────────────────────────

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end $$;

create or replace function pg_temp.must_refuse(
  p_sql text, p_sqlstate text, p_marker text, p_label text
)
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

-- Registration as the upload route makes it: yesterday (IST), one screenshot.
create or replace function pg_temp.submit(p_id uuid, p_actor uuid, p_type text, p_sha text)
returns jsonb language sql as $$
  select public.create_customer_review_custom_submission(
    p_id, p_actor, p_type, (now() at time zone 'Asia/Kolkata')::date - 1, null,
    p_id::text || '/proof/shot.png', 'shot.png', 'image/png', 2048, repeat(p_sha, 64)
  )
$$;

-- ─── fixtures ────────────────────────────────────────────────────────────────
--   A  admin, use + verify        V  member, use + verify
--   E1 E2 members, use             E3 E4 E5 members, credits only
--   O  member, no grant

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',    'admin@example.test', 'admin',  'management', true, false, 'T-ADM'),
  ('b0000000-0000-4000-8000-00000000000b', 'Test Verifier', 'ver@example.test',   'member', 'reviews',    true, false, 'T-VER'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Test One',      'one@example.test',   'member', 'sales',      true, false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Two',      'two@example.test',   'member', 'sales',      true, false, 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Test Three',    'three@example.test', 'member', 'sales',      true, false, 'T-003'),
  ('e4000000-0000-4000-8000-0000000000e4', 'Test Four',     'four@example.test',  'member', 'sales',      true, false, 'T-004'),
  ('e5000000-0000-4000-8000-0000000000e5', 'Test Five',     'five@example.test',  'member', 'sales',      true, false, 'T-005'),
  ('c0000000-0000-4000-8000-00000000000c', 'Test Outsider', 'out@example.test',   'member', 'sales',      true, false, 'T-OUT');

insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'use'),
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'verify'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'use'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'verify'),
  ('e1000000-0000-4000-8000-0000000000e1', 'customer_review_requests', 'use'),
  ('e2000000-0000-4000-8000-0000000000e2', 'customer_review_requests', 'use');

-- The settings in force for this suite: text 1, IMAGE 1.5, ₹50 a credit.
insert into public.boe_credit_settings (
  review_reward_credits, image_review_reward_credits, credit_value,
  half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews, note, created_at
) values (1, 1.5, 50.00, 8, 15, 3, 'test-only: decimal image reward', clock_timestamp());

insert into public.payroll_periods (id, payroll_month, payroll_year, status) values
  ('91000000-0000-4000-8000-000000000091', 8, 2026, 'generated');

insert into public.payroll_results (payroll_period_id, employee_id, monthly_salary) values
  ('91000000-0000-4000-8000-000000000091', 'e3000000-0000-4000-8000-0000000000e3', 20000);

-- ═══ §0. Applied ═════════════════════════════════════════════════════════════

do $$
begin
  assert (select data_type from information_schema.columns
           where table_schema = 'public' and table_name = 'boe_credit_transactions' and column_name = 'credits') = 'numeric',
    '§0 the ledger column is numeric';
  assert to_regprocedure('public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)') is null,
    '§0 the integer posting signature is gone';
  assert to_regprocedure('public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)') is null,
    '§0 the integer payroll signature is gone';
  assert to_regclass('public.customer_review_custom_submissions') is not null, '§0 the submissions table exists';
  assert (select review_reward_credits from public.boe_credit_settings order by created_at asc limit 1) = 100,
    '§0 the Phase 1A settings row still reads 100 after the conversion';
  raise notice 'PASS  §0 both migrations applied; the 1A settings row converted exactly';
end $$;

-- ═══ §1. A decimal ledger ═══════════════════════════════════════════════════

do $$
declare
  v_tx uuid;
  v_c  numeric;
begin
  perform public.post_boe_credit_transaction('e3000000-0000-4000-8000-0000000000e3', 'admin_adjustment', 2, 'manual', null, 'Fixture: two whole credits', 'a0000000-0000-4000-8000-00000000000a');
  v_tx := public.post_boe_credit_transaction('e3000000-0000-4000-8000-0000000000e3', 'admin_adjustment', 1.5, 'manual', null, 'Fixture: one and a half', 'a0000000-0000-4000-8000-00000000000a');
  select credits into v_c from public.boe_credit_transactions where id = v_tx;
  assert v_c = 1.5, format('§1 the row holds 1.5, got %s', v_c);
  assert public.boe_credit_balance('e3000000-0000-4000-8000-0000000000e3') = 3.5, '§1 2 + 1.5 = 3.5 recorded';
  assert (select available_credits from public.boe_credit_balances where employee_id = 'e3000000-0000-4000-8000-0000000000e3') = 3.5, '§1 the view reads 3.5';
  assert (select spendable_credits from public.boe_credit_balances where employee_id = 'e3000000-0000-4000-8000-0000000000e3') = 3.5, '§1 the view reads 3.5 spendable';
  assert public.boe_credit_spendable_balance('e3000000-0000-4000-8000-0000000000e3') = 3.5, '§1 spendable 3.5';
  raise notice 'PASS  §1 a 1.5 row is stored as 1.5, a whole row beside it still sums, and every balance reads 3.5';
end $$;

select pg_temp.must_refuse(
  $q$select public.post_boe_credit_transaction('e3000000-0000-4000-8000-0000000000e3', 'admin_adjustment', 1.555, 'manual', null, 'three decimals', 'a0000000-0000-4000-8000-00000000000a')$q$,
  '22023', 'BOE_CREDITS_PRECISION', '§1 a third decimal place is refused, not rounded');

-- ═══ §2. The spendable check compares exactly ═══════════════════════════════

select public.post_boe_credit_transaction('e4000000-0000-4000-8000-0000000000e4', 'admin_adjustment', 7.5, 'manual', null, 'Fixture: seven and a half', 'a0000000-0000-4000-8000-00000000000a');

select pg_temp.must_refuse(
  $q$select public.post_boe_credit_transaction('e4000000-0000-4000-8000-0000000000e4', 'redemption', -8, 'attendance_redemption', gen_random_uuid(), 'eight', 'e4000000-0000-4000-8000-0000000000e4')$q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§2 7.5 spendable cannot pay 8');

do $$
begin
  perform public.post_boe_credit_transaction('e4000000-0000-4000-8000-0000000000e4', 'redemption', -7.5, 'attendance_redemption', gen_random_uuid(), 'all of it', 'e4000000-0000-4000-8000-0000000000e4');
  assert public.boe_credit_balance('e4000000-0000-4000-8000-0000000000e4') = 0, '§2 7.5 − 7.5 = 0';
  raise notice 'PASS  §2 7.5 pays exactly 7.5 and leaves 0';
end $$;

-- ═══ §3. Attendance redemption on a decimal balance ═════════════════════════

do $$
declare
  v jsonb;
  r jsonb;
begin
  perform public.post_boe_credit_transaction('e3000000-0000-4000-8000-0000000000e3', 'admin_adjustment', 6, 'manual', null, 'Fixture: six more', 'a0000000-0000-4000-8000-00000000000a');
  assert public.boe_credit_spendable_balance('e3000000-0000-4000-8000-0000000000e3') = 9.5, '§3 opening 9.5';

  v := public.redeem_boe_credits_for_attendance(
    'e3000000-0000-4000-8000-0000000000e3', '91000000-0000-4000-8000-000000000091', '2026-08-10', 'half_day', 'e3000000-0000-4000-8000-0000000000e3');
  assert (v ->> 'credits')::numeric = 8, '§3 a half day costs 8';
  assert (v ->> 'available_credits')::numeric = 1.5, format('§3 9.5 − 8 leaves 1.5, got %s', v ->> 'available_credits');

  r := public.reverse_boe_credit_attendance_redemption((v ->> 'redemption_id')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'test: day corrected');
  assert (r ->> 'available_credits')::numeric = 9.5, format('§3 the reversal restores 9.5, got %s', r ->> 'available_credits');
  raise notice 'PASS  §3 attendance: 9.5 − 8 = 1.5 exactly, and the reversal restores 9.5';
end $$;

-- ═══ §4. Payroll application in decimal credits ═════════════════════════════

do $$
declare
  v jsonb;
  w jsonb;
  x jsonb;
begin
  v := public.apply_boe_credits_to_payroll('e3000000-0000-4000-8000-0000000000e3', '91000000-0000-4000-8000-000000000091', 1.5, 'e3000000-0000-4000-8000-0000000000e3');
  assert (v ->> 'credits_used')::numeric = 1.5, '§4 1.5 credits applied';
  assert (v ->> 'credit_amount')::numeric = 75.00, format('§4 1.5 × ₹50 = ₹75.00, got %s', v ->> 'credit_amount');
  assert (v ->> 'spendable_credits')::numeric = 8, '§4 9.5 − 1.5 = 8 spendable';
  assert (select credit_amount_snapshot from public.boe_credit_payroll_applications where id = (v ->> 'application_id')::uuid) = 75.00, '§4 ₹75.00 snapshotted';

  w := public.apply_boe_credits_to_payroll('e3000000-0000-4000-8000-0000000000e3', '91000000-0000-4000-8000-000000000091', 1.5, 'e3000000-0000-4000-8000-0000000000e3');
  assert (w ->> 'unchanged')::boolean, '§4 the same 1.5 again is a no-op';

  x := public.remove_boe_credit_payroll_application('e3000000-0000-4000-8000-0000000000e3', '91000000-0000-4000-8000-000000000091', 'e3000000-0000-4000-8000-0000000000e3');
  assert (x ->> 'spendable_credits')::numeric = 9.5, '§4 removal restores 9.5';
  raise notice 'PASS  §4 payroll: 1.5 credits = ₹75.00, retry changes nothing, removal restores 9.5';
end $$;

select pg_temp.must_refuse(
  $q$select public.apply_boe_credits_to_payroll('e3000000-0000-4000-8000-0000000000e3', '91000000-0000-4000-8000-000000000091', 1.555, 'e3000000-0000-4000-8000-0000000000e3')$q$,
  '22023', 'BOE_CREDITS_PRECISION', '§4 a payroll application of 1.555 is refused');

-- ═══ §5. Settings and the generated-review reward ═══════════════════════════

do $$
declare
  v jsonb;
begin
  assert (select image_review_reward_credits from public.boe_credit_settings order by created_at desc limit 1) = 1.5,
    '§5 the active image reward is 1.5';
  v := public.post_boe_credit_review_reward('e5000000-0000-4000-8000-0000000000e5', gen_random_uuid(), 'RW-DECIMAL', 'image', now(), 'b0000000-0000-4000-8000-00000000000b');
  assert (v ->> 'credits')::numeric = 1.5, format('§5 a generated image review posts 1.5, got %s', v ->> 'credits');
  assert public.boe_credit_balance('e5000000-0000-4000-8000-0000000000e5') = 1.5, '§5 the ledger holds 1.5, not 2';
  assert (select earned_review_credits from public.boe_credit_review_months where employee_id = 'e5000000-0000-4000-8000-0000000000e5') = 1.5,
    '§5 the month counts 1.5 earned';
  raise notice 'PASS  §5 a 1.5 image reward is configured, and a verified generated image review posts exactly 1.5';
end $$;

-- ═══ §6. Submitting ══════════════════════════════════════════════════════════
--   S1 E1 image   S2 E1 text   S3 E2 image   S4 V image (self)   S5 E1 text   S6 E2 text

do $$
declare
  v jsonb;
begin
  perform pg_temp.act_as_service();
  v := public.create_customer_review_custom_submission(
    '51000000-0000-4000-8000-000000000051', 'e1000000-0000-4000-8000-0000000000e1', 'image',
    (now() at time zone 'Asia/Kolkata')::date - 2, '  Posted on Google  ',
    '51000000-0000-4000-8000-000000000051/proof/shot.png', 'shot.png', 'image/png', 2048, repeat('1', 64));
  assert v ->> 'status' = 'pending_verification', '§6 Pending Verification';
  assert v ->> 'submitted_by' = 'e1000000-0000-4000-8000-0000000000e1', '§6 the submitter is the actor';
  assert v ->> 'remark' = 'Posted on Google', '§6 the remark is trimmed';
  assert v ->> 'submission_ref' ~ '^CR-[0-9]{6}$', '§6 a CR- reference';
  assert v ->> 'credits_awarded' is null and v ->> 'approved_by' is null, '§6 no credit and no approver yet';

  perform pg_temp.submit('52000000-0000-4000-8000-000000000052', 'e1000000-0000-4000-8000-0000000000e1', 'text',  '2');
  perform pg_temp.submit('53000000-0000-4000-8000-000000000053', 'e2000000-0000-4000-8000-0000000000e2', 'image', '3');
  perform pg_temp.submit('54000000-0000-4000-8000-000000000054', 'b0000000-0000-4000-8000-00000000000b', 'image', '4');
  perform pg_temp.submit('55000000-0000-4000-8000-000000000055', 'e1000000-0000-4000-8000-0000000000e1', 'text',  '5');
  perform pg_temp.submit('56000000-0000-4000-8000-000000000056', 'e2000000-0000-4000-8000-0000000000e2', 'text',  '6');
  assert (select count(*) from public.customer_review_custom_submissions where status = 'pending_verification') = 6, '§6 six pending';
  assert (select count(*) from public.boe_credit_transactions where source_type = 'customer_review_custom_submission') = 0, '§6 submitting posts nothing';
  raise notice 'PASS  §6 an employee creates their own Pending Verification submission; six created, no credit posted';
end $$;

select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'image', (now() at time zone 'Asia/Kolkata')::date + 1, null, '57000000-0000-4000-8000-000000000057/proof/a.png', 'a.png', 'image/png', 10, repeat('7', 64))$q$,
  '22023', 'The published date cannot be in the future', '§6 a future published date is refused');
select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'video', (now() at time zone 'Asia/Kolkata')::date, null, '57000000-0000-4000-8000-000000000057/proof/a.png', 'a.png', 'image/png', 10, repeat('7', 64))$q$,
  '22023', 'CUSTOMER_REVIEW_CUSTOM_INVALID', '§6 an unknown review type is refused');
select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'text', null, null, '57000000-0000-4000-8000-000000000057/proof/a.png', 'a.png', 'image/png', 10, repeat('7', 64))$q$,
  '22023', 'Enter the date the review was published', '§6 a missing published date is refused');
select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'text', (now() at time zone 'Asia/Kolkata')::date, null, '51000000-0000-4000-8000-000000000051/proof/shot.png', 'a.png', 'image/png', 10, repeat('7', 64))$q$,
  '22023', 'A screenshot of the published review is required', '§6 a proof path belonging to another submission is refused');
select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'text', (now() at time zone 'Asia/Kolkata')::date, repeat('r', 301), '57000000-0000-4000-8000-000000000057/proof/a.png', 'a.png', 'image/png', 10, repeat('7', 64))$q$,
  '22023', 'Keep the remark under 300 characters', '§6 a long remark is refused');
select pg_temp.must_refuse(
  $q$select pg_temp.submit('57000000-0000-4000-8000-000000000057', 'c0000000-0000-4000-8000-00000000000c', 'text', '7')$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§6 an employee without `use` cannot submit');
select pg_temp.must_refuse(
  $q$select pg_temp.submit('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'text', '1')$q$,
  '23505', 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE', '§6 the same screenshot twice is refused');
select pg_temp.must_refuse(
  $q$insert into public.customer_review_custom_submissions (id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type, proof_byte_size, proof_content_sha256, submitted_at) values ('58000000-0000-4000-8000-000000000058', 'e1000000-0000-4000-8000-0000000000e1', 'text', '2026-09-20', '58000000-0000-4000-8000-000000000058/proof/a.png', 'a.png', 'image/png', 10, repeat('8', 64), '2026-09-19 12:00:00+05:30')$q$,
  '23514', 'custom_review_submission_published_not_after_submission', '§6 the table itself refuses a published date after the submission');

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse(
  $q$select pg_temp.submit('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'text', '7')$q$,
  '42501', 'permission denied', '§6 a browser session cannot call the registration function');
select pg_temp.must_refuse(
  $q$insert into public.customer_review_custom_submissions (id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type, proof_byte_size, proof_content_sha256) values ('57000000-0000-4000-8000-000000000057', 'e1000000-0000-4000-8000-0000000000e1', 'text', '2026-09-01', '57000000-0000-4000-8000-000000000057/proof/a.png', 'a.png', 'image/png', 10, repeat('7', 64))$q$,
  '42501', 'permission denied', '§6 a browser session cannot insert a submission');
select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set status = 'approved', credits_awarded = 100 where id = '51000000-0000-4000-8000-000000000051'$q$,
  '42501', 'permission denied', '§6 a browser session cannot approve by UPDATE');
select pg_temp.must_refuse(
  $q$select public.post_boe_credit_custom_review_reward('e1000000-0000-4000-8000-0000000000e1', '51000000-0000-4000-8000-000000000051', 'CR-X', 5, now(), 'e1000000-0000-4000-8000-0000000000e1')$q$,
  '42501', 'permission denied', '§6 a browser session cannot post a custom reward');
select pg_temp.act_as_service();

-- ═══ §7. Who can see a submission, and its proof ════════════════════════════

insert into storage.objects (bucket_id, name) values
  ('customer-review-custom-proofs', '51000000-0000-4000-8000-000000000051/proof/shot.png'),
  ('customer-review-custom-proofs', '53000000-0000-4000-8000-000000000053/proof/shot.png');

do $$
begin
  perform pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
  assert (select count(*) from public.customer_review_custom_submissions) = 3, '§7 E1 sees their three';
  assert (select count(*) from storage.objects where bucket_id = 'customer-review-custom-proofs') = 1, '§7 E1 reads their own proof only';
  perform pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
  assert (select count(*) from public.customer_review_custom_submissions) = 2, '§7 E2 sees their two';
  perform pg_temp.act_as('c0000000-0000-4000-8000-00000000000c');
  assert (select count(*) from public.customer_review_custom_submissions) = 0, '§7 an outsider sees none';
  assert (select count(*) from storage.objects where bucket_id = 'customer-review-custom-proofs') = 0, '§7 an outsider reads no proof';
  perform pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
  assert (select count(*) from public.customer_review_custom_submissions) = 6, '§7 a verifier sees all six';
  assert (select count(*) from storage.objects where bucket_id = 'customer-review-custom-proofs') = 2, '§7 a verifier reads every proof';
  perform pg_temp.act_as_service();
  raise notice 'PASS  §7 own rows and own proof; a verifier sees everything; nobody else sees anything';
end $$;

-- ═══ §8. Who may decide ══════════════════════════════════════════════════════

select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('54000000-0000-4000-8000-000000000054', 1.5)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_SELF', '§8 a verifier cannot approve their own submission');
select pg_temp.must_refuse(
  $q$select public.reject_customer_review_custom_submission('54000000-0000-4000-8000-000000000054', 'no')$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_SELF', '§8 a verifier cannot reject their own submission');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 2)$q$,
  '42501', 'Only a BOE Credits administrator can change the amount', '§8 a verifier cannot award more than the configured 1.5');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 0)$q$,
  '22023', 'CUSTOMER_REVIEW_CUSTOM_CREDITS', '§8 zero credits is refused');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 1.555)$q$,
  '22023', 'CUSTOMER_REVIEW_CUSTOM_CREDITS', '§8 a third decimal place is refused');

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('51000000-0000-4000-8000-000000000051', 1.5)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§8 an employee without `verify` cannot approve — not even their own');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 1.5)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§8 an employee without `verify` cannot approve a colleague''s');

select pg_temp.act_as_anon();
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 1.5)$q$,
  '42501', 'permission denied', '§8 anon cannot call the approval');
select pg_temp.act_as_service();

-- ═══ §9. Approve ═════════════════════════════════════════════════════════════

select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
do $$
declare
  v jsonb;
begin
  v := public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 1.5);
  assert not (v ->> 'already_decided')::boolean, '§9 a first decision';
  assert v -> 'submission' ->> 'status' = 'approved', '§9 Approved';
  assert (v -> 'submission' ->> 'credits_awarded')::numeric = 1.5, '§9 1.5 awarded';
  assert v -> 'submission' ->> 'approved_by' = 'b0000000-0000-4000-8000-00000000000b', '§9 approved_by is the verifier';
  assert v -> 'submission' ->> 'approved_at' is not null, '§9 approved_at is set';
  assert (v -> 'reward' ->> 'credits')::numeric = 1.5, '§9 the reward reports 1.5';
  assert v -> 'reward' ->> 'month_status' = 'open', '§9 the month is still below its minimum';
end $$;
select pg_temp.act_as_service();

do $$
declare
  t public.boe_credit_transactions%rowtype;
  s public.customer_review_custom_submissions%rowtype;
  m public.boe_credit_review_months%rowtype;
begin
  assert (select count(*) from public.boe_credit_transactions
           where source_type = 'customer_review_custom_submission' and source_id = '53000000-0000-4000-8000-000000000053') = 1,
    '§9 exactly one ledger row';
  select * into t from public.boe_credit_transactions
   where source_type = 'customer_review_custom_submission' and source_id = '53000000-0000-4000-8000-000000000053';
  select * into s from public.customer_review_custom_submissions where id = '53000000-0000-4000-8000-000000000053';
  assert t.transaction_type = 'review_reward', '§9 a standard review_reward';
  assert t.credits = 1.5, '§9 of exactly 1.5';
  assert t.employee_id = 'e2000000-0000-4000-8000-0000000000e2', '§9 to the submitter';
  assert t.created_by = 'b0000000-0000-4000-8000-00000000000b', '§9 posted by the verifier';
  assert s.credit_transaction_id = t.id, '§9 the submission names its ledger row';
  assert exists (
    select 1 from public.boe_credit_review_rewards r
     where r.transaction_id = t.id and r.card_id = s.id and r.card_ref = s.submission_ref
  ), '§9 the reward is recorded for its review month';
  select * into m from public.boe_credit_review_months
   where employee_id = 'e2000000-0000-4000-8000-0000000000e2'
     and review_month = date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  assert m.qualifying_review_count = 1 and m.earned_review_credits = 1.5 and m.status = 'open', '§9 the month counts it: 1 review, 1.5 earned, open';
  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 1.5, '§9 recorded 1.5';
  assert public.boe_credit_provisional_credits('e2000000-0000-4000-8000-0000000000e2') = 1.5, '§9 provisional 1.5 — the monthly rule applies';
  assert public.boe_credit_spendable_balance('e2000000-0000-4000-8000-0000000000e2') = 0, '§9 not spendable until the month qualifies';
  raise notice 'PASS  §9 approval posts ONE review_reward of 1.5 to the submitter, recorded for its month, provisional';
end $$;

-- ═══ §10. Exactly once ═══════════════════════════════════════════════════════

select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
do $$
declare
  v jsonb;
begin
  v := public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 1.5);
  assert (v ->> 'already_decided')::boolean, '§10 a second approval is recognised';
  assert v ->> 'reward' is null, '§10 and posts no reward';
  v := public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 2);
  assert (v ->> 'already_decided')::boolean, '§10 a different amount changes nothing either';
end $$;
select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
do $$
declare
  v jsonb;
begin
  v := public.approve_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 3);
  assert (v ->> 'already_decided')::boolean, '§10 nor does another verifier';
  assert (v -> 'submission' ->> 'credits_awarded')::numeric = 1.5, '§10 the recorded amount stays 1.5';
end $$;
select pg_temp.act_as_service();

select pg_temp.must_refuse(
  $q$select public.post_boe_credit_custom_review_reward('e2000000-0000-4000-8000-0000000000e2', '53000000-0000-4000-8000-000000000053', 'CR-AGAIN', 1.5, now(), 'b0000000-0000-4000-8000-00000000000b')$q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§10 even a raw second reward for the same submission is refused');

do $$
begin
  assert (select count(*) from public.boe_credit_transactions
           where source_type = 'customer_review_custom_submission' and source_id = '53000000-0000-4000-8000-000000000053') = 1,
    '§10 still exactly one ledger row';
  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 1.5, '§10 still 1.5';
  raise notice 'PASS  §10 approving again — same amount, another amount, another verifier — posts nothing';
end $$;

-- ═══ §11. An administrator may award a different amount ═════════════════════

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
do $$
declare
  v jsonb;
begin
  v := public.approve_customer_review_custom_submission('55000000-0000-4000-8000-000000000055', 2.5);
  assert (v -> 'submission' ->> 'credits_awarded')::numeric = 2.5, '§11 an admin awards 2.5 on a text review (configured 1)';
end $$;
select pg_temp.act_as_service();

do $$
begin
  assert (select credits from public.boe_credit_transactions
           where source_type = 'customer_review_custom_submission' and source_id = '55000000-0000-4000-8000-000000000055') = 2.5,
    '§11 the ledger row is 2.5';
  raise notice 'PASS  §11 a BOE Credits administrator can set the amount (2.5)';
end $$;

-- ═══ §12. Reject ═════════════════════════════════════════════════════════════

select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
select pg_temp.must_refuse(
  $q$select public.reject_customer_review_custom_submission('56000000-0000-4000-8000-000000000056', '   ')$q$,
  '22023', 'CUSTOMER_REVIEW_CUSTOM_REASON', '§12 a rejection needs a reason');
do $$
declare
  v jsonb;
begin
  v := public.reject_customer_review_custom_submission('56000000-0000-4000-8000-000000000056', ' The screenshot does not show a published review ');
  assert v -> 'submission' ->> 'status' = 'rejected', '§12 Rejected';
  assert v -> 'submission' ->> 'rejection_reason' = 'The screenshot does not show a published review', '§12 the reason is kept, trimmed';
  assert v -> 'submission' ->> 'rejected_by' = 'b0000000-0000-4000-8000-00000000000b', '§12 rejected_by';
  assert v -> 'submission' ->> 'rejected_at' is not null, '§12 rejected_at';
  assert v -> 'submission' ->> 'credits_awarded' is null, '§12 no credit';
  v := public.reject_customer_review_custom_submission('56000000-0000-4000-8000-000000000056', 'again');
  assert (v ->> 'already_decided')::boolean, '§12 rejecting again changes nothing';
  assert v -> 'submission' ->> 'rejection_reason' = 'The screenshot does not show a published review', '§12 the first reason stands';
end $$;
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('56000000-0000-4000-8000-000000000056', 1)$q$,
  '55000', 'CUSTOMER_REVIEW_CUSTOM_DECIDED', '§12 a rejected submission cannot then be approved');
select pg_temp.must_refuse(
  $q$select public.reject_customer_review_custom_submission('53000000-0000-4000-8000-000000000053', 'too late')$q$,
  '55000', 'CUSTOMER_REVIEW_CUSTOM_DECIDED', '§12 an approved submission cannot then be rejected');

select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
do $$
begin
  assert (select rejection_reason from public.customer_review_custom_submissions where id = '56000000-0000-4000-8000-000000000056')
         = 'The screenshot does not show a published review', '§12 the submitter reads the reason';
end $$;
select pg_temp.act_as_service();

do $$
begin
  assert (select count(*) from public.boe_credit_transactions
           where source_type = 'customer_review_custom_submission' and source_id = '56000000-0000-4000-8000-000000000056') = 0,
    '§12 a rejected review has no ledger row';
  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 1.5, '§12 E2 still holds only the approved 1.5';
  raise notice 'PASS  §12 rejection needs a reason, keeps it for the submitter, awards nothing, and is final';
end $$;

-- ═══ §13. Immutability ═══════════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set remark = 'edited' where id = '56000000-0000-4000-8000-000000000056'$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§13 a decided submission cannot be edited, by any role');
select pg_temp.must_refuse(
  $q$delete from public.customer_review_custom_submissions where id = '53000000-0000-4000-8000-000000000053'$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§13 a submission is never deleted');
select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set published_on = published_on - 1 where id = '51000000-0000-4000-8000-000000000051'$q$,
  '42501', 'only the decision', '§13 on a pending submission only the decision may move');
select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set status = 'approved' where id = '51000000-0000-4000-8000-000000000051'$q$,
  '23514', 'custom_review_submission_decision_consistent', '§13 an approval without its approver, amount and ledger row is refused');

-- ═══ §14. The monthly rule — custom reviews count like verified reviews ════

select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
do $$
begin
  perform public.approve_customer_review_custom_submission('51000000-0000-4000-8000-000000000051', 1.5);
  perform public.approve_customer_review_custom_submission('52000000-0000-4000-8000-000000000052', 1);
end $$;
select pg_temp.act_as_service();

do $$
declare
  m public.boe_credit_review_months%rowtype;
begin
  select * into m from public.boe_credit_review_months
   where employee_id = 'e1000000-0000-4000-8000-0000000000e1'
     and review_month = date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  assert m.qualifying_review_count = 3, format('§14 three approved custom reviews, got %s', m.qualifying_review_count);
  assert m.earned_review_credits = 5, format('§14 2.5 + 1.5 + 1 = 5 earned, got %s', m.earned_review_credits);
  assert m.status = 'qualified', '§14 the month qualifies at the minimum of 3';
  assert public.boe_credit_provisional_credits('e1000000-0000-4000-8000-0000000000e1') = 0, '§14 nothing provisional';
  assert public.boe_credit_spendable_balance('e1000000-0000-4000-8000-0000000000e1') = 5, '§14 all 5 spendable';
  raise notice 'PASS  §14 three approved custom reviews qualify the month; 5 credits become spendable';
end $$;

-- ═══ §15. A custom reward is reversed like any other ════════════════════════

do $$
declare
  v_tx uuid;
  m    public.boe_credit_review_months%rowtype;
begin
  select id into v_tx from public.boe_credit_transactions
   where source_type = 'customer_review_custom_submission' and source_id = '55000000-0000-4000-8000-000000000055';
  perform public.reverse_boe_credit_transaction(v_tx, 'a0000000-0000-4000-8000-00000000000a', 'test: that review was not genuine');
  select * into m from public.boe_credit_review_months
   where employee_id = 'e1000000-0000-4000-8000-0000000000e1'
     and review_month = date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  assert m.qualifying_review_count = 2 and m.earned_review_credits = 2.5, '§15 the month recounts: 2 reviews, 2.5 earned';
  assert m.status = 'qualified', '§15 a qualified month is not reopened';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 2.5, '§15 5 − 2.5 = 2.5 recorded';
  assert (select status from public.customer_review_custom_submissions where id = '55000000-0000-4000-8000-000000000055') = 'approved',
    '§15 the submission''s audit record is untouched';
  raise notice 'PASS  §15 an administrator reverses one custom reward; the month recounts to 2.5 and stays qualified';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
