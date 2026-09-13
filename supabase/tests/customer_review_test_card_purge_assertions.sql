-- ═══════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261209000000, executed rather than read
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run by run_customer_review_test_card_purge_local.sh on a disposable local
-- Supabase stack carrying the real Review Workflow and BOE Credits chain.
-- ONE TRANSACTION, ROLLED BACK: the runner executes it twice and the second
-- pass must see exactly what the first did.
--
-- WHAT IT PROVES
--   1. WHO: only an active, non-deleted admin. An employee, a verifier without
--      admin, a deactivated admin and a soft-deleted admin are refused; a
--      browser session cannot call START or FINISH at all. An admin with
--      `use` AND `verify` revoked may read the purge record and purge, and
--      still cannot approve, verify or soft-delete anything.
--   2. WHICH: a rewarded card (ledger row, reward record, or verified with a
--      reward) is refused with the reward sentence; approved, assigned,
--      booked-and-shared and submitted cards are refused; a pending card with
--      external history or a test screenshot is refused; a verifier's
--      tombstone is refused; a custom submission id is not found. Nothing
--      about any of them changes.
--   3. ORDER: FINISH before START is refused; START freezes the card (no
--      approval, no attachment, no second soft deletion) and is repeatable;
--      FINISH refuses while ANY object under the card prefix remains —
--      including one with no metadata row — and deletes only afterwards.
--   4. NOTHING LEFT: no card, screenshot, event or object for the purged card;
--      a repeated FINISH reports it gone; a repeated START is not found.
--   5. RECHECK: a reward that appears between START and FINISH is refused.
--   6. BYSTANDERS: another card, a verifier's tombstone, a custom submission
--      and their files are untouched; the soft deletion still removes nothing.
--   7. THE PURGE PAGE'S READ (customer_review_test_card_purge_record): a record
--      for a purge admin only, for an eligible card only; NULL for a verifier
--      without admin, an employee, a released/rewarded/used card, a verifier's
--      tombstone and a custom submission. After START it still returns the card
--      to a purge admin, flagged purge_in_progress — the reload recovery — and
--      after FINISH it returns nothing. (Asserted inside sections 1 to 4.)
--
-- Storage objects are rows in storage.objects here. Their removal is simulated
-- the way a test may (the protect-delete guard's own switch); the Storage API
-- path is exercised separately against the stack's real storage service.

\set ON_ERROR_STOP on

begin;

-- ─── Helpers ────────────────────────────────────────────────────────────────

-- Run p_sql as p_role (authenticated carries p_user in its JWT claims) and
-- insist it is refused with p_sqlstate and a message containing p_marker.
create or replace function pg_temp.refuses(
  p_role text, p_user uuid, p_sql text, p_sqlstate text, p_marker text, p_label text
)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    if p_role = 'authenticated' then
      execute format('set local request.jwt.claims = %L',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text);
      set local role authenticated;
    elsif p_role = 'service_role' then
      set local role service_role;
    end if;
    execute p_sql;
    raise exception 'EXPECTED REFUSAL, GOT SUCCESS — %', p_label;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_msg like 'EXPECTED REFUSAL%' then raise; end if;
    if v_state <> p_sqlstate or position(p_marker in v_msg) = 0 then
      raise exception 'ASSERT % — expected % carrying "%", got %: %', p_label, p_sqlstate, p_marker, v_state, v_msg;
    end if;
  end;
end $$;

create or replace function pg_temp.can_purge_as(p_user uuid)
returns boolean language plpgsql as $$
declare v boolean;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  v := public.can_purge_customer_review_test_cards();
  reset role;
  return v;
end $$;

-- How many cards this user can read through RLS.
create or replace function pg_temp.cards_visible_to(p_user uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_test_cards;
  reset role;
  return n;
end $$;

-- The purge page's read, exactly as a browser session makes it.
create or replace function pg_temp.record_as(p_user uuid, p_card uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  v := public.customer_review_test_card_purge_record(p_card);
  reset role;
  return v;
end $$;

create or replace function pg_temp.purge_begin(p_card uuid, p_actor uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  set local role service_role;
  v := public.begin_customer_review_test_card_purge(p_card, p_actor);
  reset role;
  return v;
end $$;

create or replace function pg_temp.purge_finish(p_card uuid, p_actor uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  set local role service_role;
  v := public.finish_customer_review_test_card_purge(p_card, p_actor);
  reset role;
  return v;
end $$;

-- What the Storage API does for the route, done the way a test may.
create or replace function pg_temp.remove_object(p_bucket text, p_name text)
returns void language plpgsql as $$
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = p_bucket and name = p_name;
  perform set_config('storage.allow_delete_query', 'false', true);
end $$;

create or replace function pg_temp.id(p text)
returns uuid language sql immutable as $$
  select case p
    -- people
    when 'admin'          then 'b0000000-0000-4000-8000-00000000000a'
    when 'inactive_admin' then 'b0000000-0000-4000-8000-00000000000b'
    when 'deleted_admin'  then 'b0000000-0000-4000-8000-00000000000c'
    when 'verifier'       then 'b0000000-0000-4000-8000-00000000000d'
    when 'employee'       then 'b0000000-0000-4000-8000-00000000000e'
    when 'bare_admin'     then 'b0000000-0000-4000-8000-00000000000f'
    -- eligible internal drafts
    when 'd1' then 'c1000000-0000-4000-8000-0000000000d1'
    when 'd2' then 'c1000000-0000-4000-8000-0000000000d2'
    when 'd3' then 'c1000000-0000-4000-8000-0000000000d3'
    -- rewarded
    when 'rp' then 'c1000000-0000-4000-8000-0000000000a1'
    when 'rr' then 'c1000000-0000-4000-8000-0000000000a2'
    when 'rv' then 'c1000000-0000-4000-8000-0000000000a3'
    -- released or used
    when 'ap' then 'c1000000-0000-4000-8000-0000000000b1'
    when 'as' then 'c1000000-0000-4000-8000-0000000000b2'
    when 'bk' then 'c1000000-0000-4000-8000-0000000000b3'
    when 'sb' then 'c1000000-0000-4000-8000-0000000000b4'
    when 'ub' then 'c1000000-0000-4000-8000-0000000000b5'
    when 'ts' then 'c1000000-0000-4000-8000-0000000000b6'
    when 'sd' then 'c1000000-0000-4000-8000-0000000000b7'
    -- a custom submission
    when 'cs' then 'd1000000-0000-4000-8000-0000000000c5'
  end::uuid
$$;

-- ─── 0. The world ───────────────────────────────────────────────────────────

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, created_at, updated_at, employee_code) values
  (pg_temp.id('admin'),          'Purge Admin',          'purge-admin@example.test',    'admin',  'management', true,  false, now(), now(), 'P-ADM'),
  (pg_temp.id('inactive_admin'), 'Deactivated Admin',    'purge-inactive@example.test', 'admin',  'management', false, false, now(), now(), 'P-INA'),
  (pg_temp.id('deleted_admin'),  'Soft-deleted Admin',   'purge-deleted@example.test',  'admin',  'management', true,  true,  now(), now(), 'P-DEL'),
  (pg_temp.id('verifier'),       'Verifier, not admin',  'purge-verifier@example.test', 'member', 'sales',      true,  false, now(), now(), 'P-VER'),
  (pg_temp.id('employee'),       'Employee',             'purge-employee@example.test', 'member', 'sales',      true,  false, now(), now(), 'P-EMP'),
  (pg_temp.id('bare_admin'),     'Admin without Review', 'purge-bare@example.test',     'admin',  'management', true,  false, now(), now(), 'P-BAR');

-- An admin whose `use` and `verify` were both revoked in Control Center.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select pg_temp.id('bare_admin'), pm.id, pa.id, false, pg_temp.id('admin')
  from public.permission_modules pm
  join public.permission_actions pa on pa.action_key in ('use', 'verify')
 where pm.module_key = 'customer_review_requests';

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, pm.id, pa.id, true, pg_temp.id('admin')
  from public.permission_modules pm
  join public.permission_actions pa on pa.action_key in ('use', 'verify')
  join public.users u on u.id = pg_temp.id('verifier')
 where pm.module_key = 'customer_review_requests';

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select pg_temp.id('employee'), pm.id, pa.id, true, pg_temp.id('admin')
  from public.permission_modules pm
  join public.permission_actions pa on pa.action_key = 'use'
 where pm.module_key = 'customer_review_requests';

-- Pending drafts belong to a batch (customer_review_test_cards_pending_has_batch).
insert into public.customer_review_draft_batches (id, generated_by, guidance, model, card_count, expected_count)
values ('e1000000-0000-4000-8000-0000000000ba', pg_temp.id('verifier'), 'Purge fixture batch', 'fixture', 8, 8);

insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body, status, batch_id)
select pg_temp.id(k), ref, 'restaurant_test', 'Purge fixture ' || k,
       'Harness filler long enough to clear the minimum body length. It describes nothing and is attributed to nobody.',
       'pending_approval', 'e1000000-0000-4000-8000-0000000000ba'::uuid
  from (values ('d1', 'RW-009001'), ('d2', 'RW-009002'), ('d3', 'RW-009003'),
               ('rp', 'RW-009011'), ('rr', 'RW-009012'),
               ('ub', 'RW-009025'), ('ts', 'RW-009026'), ('sd', 'RW-009027')) v(k, ref);

-- Approved, unassigned.
insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body, status, approved_at, approved_by)
values (pg_temp.id('ap'), 'RW-009021', 'restaurant_test', 'Purge fixture ap',
        'Harness filler long enough to clear the minimum body length. Approved and never assigned.',
        'available', now() - interval '3 days', pg_temp.id('verifier'));

-- Approved and assigned.
insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body, status, approved_at, approved_by, assigned_to, assigned_at, assigned_by)
values (pg_temp.id('as'), 'RW-009022', 'restaurant_test', 'Purge fixture as',
        'Harness filler long enough to clear the minimum body length. Approved and assigned to an employee.',
        'available', now() - interval '3 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '2 days', pg_temp.id('verifier'));

-- Booked and shared: the WhatsApp hand-off was recorded.
insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body, status, approved_at, approved_by,
  assigned_to, assigned_at, assigned_by, booked_by, booked_at, whatsapp_opened_at, whatsapp_opened_count)
values (pg_temp.id('bk'), 'RW-009023', 'restaurant_test', 'Purge fixture bk',
        'Harness filler long enough to clear the minimum body length. Booked and shared with a recipient.',
        'booked', now() - interval '3 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '2 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '1 day', now() - interval '20 hours', 1);

-- Submitted.
insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body, status, approved_at, approved_by,
  assigned_to, assigned_at, assigned_by, booked_by, booked_at, whatsapp_opened_at, whatsapp_opened_count,
  sent_confirmed_by, sent_confirmed_at, submitted_by, submitted_at)
values (pg_temp.id('sb'), 'RW-009024', 'restaurant_test', 'Purge fixture sb',
        'Harness filler long enough to clear the minimum body length. Sent and submitted for verification.',
        'submitted', now() - interval '3 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '2 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '1 day', now() - interval '20 hours', 1,
        pg_temp.id('employee'), now() - interval '19 hours', pg_temp.id('employee'), now() - interval '18 hours');

-- Verified.
insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body, status, approved_at, approved_by,
  assigned_to, assigned_at, assigned_by, booked_by, booked_at, whatsapp_opened_at, whatsapp_opened_count,
  sent_confirmed_by, sent_confirmed_at, submitted_by, submitted_at, verified_by, verified_at)
values (pg_temp.id('rv'), 'RW-009013', 'restaurant_test', 'Purge fixture rv',
        'Harness filler long enough to clear the minimum body length. Verified and rewarded.',
        'verified', now() - interval '3 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '2 days', pg_temp.id('verifier'),
        pg_temp.id('employee'), now() - interval '1 day', now() - interval '20 hours', 1,
        pg_temp.id('employee'), now() - interval '19 hours', pg_temp.id('employee'), now() - interval '18 hours',
        pg_temp.id('verifier'), now() - interval '17 hours');

-- Trails.
insert into public.customer_review_test_card_events (card_id, event_type, previous_status, new_status, detail, actor_id)
select id, 'generated', null, 'pending_approval', 'Generated by the fixture.', pg_temp.id('verifier')
  from public.customer_review_test_cards where card_ref like 'RW-0090%';
insert into public.customer_review_test_card_events (card_id, event_type, previous_status, new_status, detail, actor_id) values
  (pg_temp.id('d1'), 'draft_edited', null, null, 'Edited by a verifier.', pg_temp.id('verifier')),
  (pg_temp.id('d1'), 'image_group_set', null, null, 'Project images attached.', pg_temp.id('verifier')),
  -- A pending card whose trail says it reached WhatsApp. Its columns look
  -- untouched; the history is what refuses it.
  (pg_temp.id('ub'), 'whatsapp_opened', null, null, 'A link was opened.', pg_temp.id('employee'));

-- Attachments and their files.
insert into public.customer_review_test_card_screenshots
  (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
values
  (pg_temp.id('d1'), 'review_image', 0, pg_temp.id('d1') || '/review_image/a.jpg', 'a.jpg', 'image/jpeg', 100, repeat('a', 64), pg_temp.id('verifier')),
  (pg_temp.id('d2'), 'review_image', 0, pg_temp.id('d2') || '/review_image/b.jpg', 'b.jpg', 'image/jpeg', 100, repeat('b', 64), pg_temp.id('verifier')),
  (pg_temp.id('sd'), 'review_image', 0, pg_temp.id('sd') || '/review_image/c.jpg', 'c.jpg', 'image/jpeg', 100, repeat('c', 64), pg_temp.id('verifier')),
  (pg_temp.id('ts'), 'test_screenshot', null, pg_temp.id('ts') || '/test_screenshot/d.png', 'd.png', 'image/png', 100, repeat('d', 64), pg_temp.id('employee'));

insert into storage.objects (bucket_id, name) values
  ('customer-review-test-screenshots', pg_temp.id('d1') || '/review_image/a.jpg'),
  -- An object whose metadata row was never written. FINISH must still see it.
  ('customer-review-test-screenshots', pg_temp.id('d1') || '/review_image/orphan.jpg'),
  ('customer-review-test-screenshots', pg_temp.id('d2') || '/review_image/b.jpg'),
  ('customer-review-test-screenshots', pg_temp.id('sd') || '/review_image/c.jpg'),
  ('customer-review-test-screenshots', pg_temp.id('ts') || '/test_screenshot/d.png');

-- Credits.
insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id, description)
values
  (pg_temp.id('employee'), 'review_reward', 1, 'customer_review', pg_temp.id('rp'), 'Fixture reward naming a pending card'),
  (pg_temp.id('employee'), 'review_reward', 1, 'customer_review', pg_temp.id('rv'), 'Fixture reward for a verified card');

with tx as (
  insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id, description)
  values (pg_temp.id('employee'), 'review_reward', 1, 'customer_review', gen_random_uuid(), 'Fixture reward recorded against rr')
  returning id
), m as (
  insert into public.boe_credit_review_months (employee_id, review_month, minimum_reviews_snapshot)
  values (pg_temp.id('employee'), date_trunc('month', now() at time zone 'Asia/Kolkata')::date, 3)
  returning id, review_month
)
insert into public.boe_credit_review_rewards (transaction_id, employee_id, card_id, card_ref, submitted_at, review_month, review_month_id)
select tx.id, pg_temp.id('employee'), pg_temp.id('rr'), 'RW-009012', now(), m.review_month, m.id from tx, m;

-- A custom submission and its proof.
insert into public.customer_review_custom_submissions
  (id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type, proof_byte_size, proof_content_sha256)
values
  (pg_temp.id('cs'), pg_temp.id('employee'), 'text', (now() at time zone 'Asia/Kolkata')::date,
   pg_temp.id('cs') || '/proof/p.jpg', 'p.jpg', 'image/jpeg', 100, repeat('e', 64));
insert into storage.objects (bucket_id, name) values ('customer-review-custom-proofs', pg_temp.id('cs') || '/proof/p.jpg');

-- A verifier's ordinary soft deletion, through the real function.
do $$
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', pg_temp.id('verifier'), 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.delete_customer_review_test_cards(array[pg_temp.id('sd')], 'single');
  reset role;
end $$;

create temp table purge_baseline as
select (select count(*) from public.boe_credit_transactions)         as ledger_rows,
       (select count(*) from public.boe_credit_review_rewards)       as reward_rows,
       (select count(*) from public.customer_review_custom_submissions) as custom_rows,
       (select count(*) from storage.objects)                        as objects;

do $$ begin raise notice 'PASS  0. fixture: 6 people, 14 cards, 4 attachments, 6 objects, 3 ledger rows, 1 custom submission'; end $$;

-- ─── 1. WHO ─────────────────────────────────────────────────────────────────

do $$
declare
  v_events integer := (select count(*) from public.customer_review_test_card_events where card_id = pg_temp.id('d1'));
begin
  assert pg_temp.can_purge_as(pg_temp.id('admin')) = true,           'ASSERT the active admin may purge';
  assert pg_temp.can_purge_as(pg_temp.id('verifier')) = false,       'ASSERT a verifier without admin may not purge';
  assert pg_temp.can_purge_as(pg_temp.id('employee')) = false,       'ASSERT an employee may not purge';
  assert pg_temp.can_purge_as(pg_temp.id('inactive_admin')) = false, 'ASSERT a deactivated admin may not purge';
  assert pg_temp.can_purge_as(pg_temp.id('deleted_admin')) = false,  'ASSERT a soft-deleted admin may not purge';

  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('employee')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'an employee cannot start a purge');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'a verifier without admin cannot start a purge');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('inactive_admin')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'a deactivated admin cannot start a purge');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('deleted_admin')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'a soft-deleted admin cannot start a purge');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, null)', pg_temp.id('d1')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'no actor cannot start a purge');
  perform pg_temp.refuses('service_role', null,
    format('select public.finish_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'a verifier without admin cannot finish a purge');

  -- A browser session cannot reach either function, not even as the admin.
  perform pg_temp.refuses('authenticated', pg_temp.id('admin'),
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('admin')),
    '42501', 'permission denied', 'an authenticated session cannot call START');
  perform pg_temp.refuses('authenticated', pg_temp.id('admin'),
    format('select public.finish_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('admin')),
    '42501', 'permission denied', 'an authenticated session cannot call FINISH');
  perform pg_temp.refuses('authenticated', pg_temp.id('admin'),
    format('select public.customer_review_test_card_purge_authorized(%L)', pg_temp.id('admin')),
    '42501', 'permission denied', 'an authenticated session cannot call the authority helper');

  assert (select deleted_at from public.customer_review_test_cards where id = pg_temp.id('d1')) is null,
    'ASSERT a refused purge tombstoned the card';
  assert (select count(*) from public.customer_review_test_card_events where card_id = pg_temp.id('d1')) = v_events,
    'ASSERT a refused purge wrote history';

  -- ── The admin without any Review permission ──
  assert public.resolve_permission(pg_temp.id('bare_admin'), 'customer_review_requests', 'use') = false
     and public.resolve_permission(pg_temp.id('bare_admin'), 'customer_review_requests', 'verify') = false,
    'ASSERT precondition: bare_admin holds neither use nor verify';
  assert pg_temp.can_purge_as(pg_temp.id('bare_admin')) = true,
    'ASSERT an active admin without verify may purge';

  -- The purge page's read: the record for a purge admin, nothing for anybody else.
  assert pg_temp.record_as(pg_temp.id('admin'), pg_temp.id('d1')) is not null, 'ASSERT the admin gets the record';
  assert (pg_temp.record_as(pg_temp.id('bare_admin'), pg_temp.id('d1'))->>'purge_in_progress')::boolean = false,
    'ASSERT the admin without verify gets the record, not in progress';
  assert jsonb_array_length(pg_temp.record_as(pg_temp.id('bare_admin'), pg_temp.id('d1'))->'attachments') = 1,
    'ASSERT the record lists the attachment';
  assert pg_temp.record_as(pg_temp.id('verifier'), pg_temp.id('d1')) is null,       'ASSERT a verifier without admin gets the record';
  assert pg_temp.record_as(pg_temp.id('employee'), pg_temp.id('d1')) is null,       'ASSERT an employee gets the record';
  assert pg_temp.record_as(pg_temp.id('inactive_admin'), pg_temp.id('d1')) is null, 'ASSERT a deactivated admin gets the record';
  assert pg_temp.record_as(pg_temp.id('deleted_admin'), pg_temp.id('d1')) is null,  'ASSERT a soft-deleted admin gets the record';

  -- ...and being an admin lends them no review action.
  perform pg_temp.refuses('authenticated', pg_temp.id('bare_admin'),
    format('select public.approve_customer_review_drafts(array[%L]::uuid[], false)', pg_temp.id('d2')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'an admin without verify cannot approve');
  perform pg_temp.refuses('authenticated', pg_temp.id('bare_admin'),
    format('select public.transition_customer_review_test_card(%L, %L, null)', pg_temp.id('sb'), 'verified'),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'an admin without verify cannot verify');
  perform pg_temp.refuses('authenticated', pg_temp.id('bare_admin'),
    format('select public.delete_customer_review_test_cards(array[%L]::uuid[], %L)', pg_temp.id('d2'), 'single'),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'an admin without verify cannot soft-delete');
  assert (select count(*) from (
            select 1 from public.customer_review_test_cards
          ) x) > 0 and pg_temp.cards_visible_to(pg_temp.id('bare_admin')) = 0,
    'ASSERT an admin without verify reads cards through RLS';

  raise notice 'PASS  1. only an active, non-deleted admin; never a browser session; an admin without verify gets the record and the purge, and no review action';
end $$;

-- ─── 2. WHICH ───────────────────────────────────────────────────────────────

do $$
declare
  k text;
begin
  foreach k in array array['rp', 'rr', 'rv'] loop
    perform pg_temp.refuses('service_role', null,
      format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id(k), pg_temp.id('admin')),
      '23514', 'CUSTOMER_REVIEW_TEST_PURGE_REWARD_ATTACHED', 'a rewarded card (' || k || ') is refused');
  end loop;
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('rv'), pg_temp.id('admin')),
    '23514', 'The reward must be handled separately', 'the reward refusal says what to do');

  foreach k in array array['ap', 'as', 'bk', 'sb'] loop
    perform pg_temp.refuses('service_role', null,
      format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id(k), pg_temp.id('admin')),
      '23514', 'approved, assigned, booked, shared or submitted', 'a released card (' || k || ') is refused');
  end loop;

  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('ub'), pg_temp.id('admin')),
    '23514', 'activity shows it was used beyond an internal draft', 'a pending card with external history is refused');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('ts'), pg_temp.id('admin')),
    '23514', 'carries a test screenshot', 'a pending card with a test screenshot is refused');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('sd'), pg_temp.id('admin')),
    '23514', 'already deleted this review', 'a verifier tombstone is refused');
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('cs'), pg_temp.id('admin')),
    'P0002', 'CUSTOMER_REVIEW_TEST_NOT_FOUND', 'a custom submission id is not a test record');

  -- FINISH cannot skip START.
  foreach k in array array['rp', 'ap', 'bk', 'd1'] loop
    perform pg_temp.refuses('service_role', null,
      format('select public.finish_customer_review_test_card_purge(%L, %L)', pg_temp.id(k), pg_temp.id('admin')),
      '23514', 'CUSTOMER_REVIEW_TEST_PURGE_NOT_STARTED', 'FINISH before START (' || k || ') is refused');
  end loop;

  -- Nothing changed on any of them.
  assert (select count(*) from public.customer_review_test_cards
           where id = any(array[pg_temp.id('rp'), pg_temp.id('rr'), pg_temp.id('rv'), pg_temp.id('ap'), pg_temp.id('as'),
                                pg_temp.id('bk'), pg_temp.id('sb'), pg_temp.id('ub'), pg_temp.id('ts'), pg_temp.id('d1')])
             and deleted_at is null) = 10,
    'ASSERT a refused card was tombstoned';
  assert (select deleted_source from public.customer_review_test_cards where id = pg_temp.id('sd')) = 'single',
    'ASSERT the verifier tombstone changed';
  assert exists (select 1 from storage.objects where bucket_id = 'customer-review-test-screenshots' and name = pg_temp.id('ts') || '/test_screenshot/d.png'),
    'ASSERT a refused card lost its file';

  -- The purge page's read returns none of them, even to the admin: an ordinary
  -- soft-deleted card stays hidden, and a custom submission is not a card.
  foreach k in array array['rp', 'rr', 'rv', 'ap', 'as', 'bk', 'sb', 'ub', 'ts', 'sd', 'cs'] loop
    assert pg_temp.record_as(pg_temp.id('admin'), pg_temp.id(k)) is null,
      'ASSERT the purge record was returned for an ineligible record: ' || k;
  end loop;

  raise notice 'PASS  2. rewarded, released, used, tombstoned and custom records are all refused, unchanged';
end $$;

-- ─── 3. ORDER: START freezes, FINISH waits for the files ────────────────────

do $$
declare
  v_start  jsonb;
  v_again  jsonb;
begin
  v_start := pg_temp.purge_begin(pg_temp.id('d1'), pg_temp.id('admin'));
  assert v_start->'storage_paths' = jsonb_build_array(pg_temp.id('d1') || '/review_image/a.jpg'),
    'ASSERT START returns the recorded path: ' || v_start::text;
  assert (select deleted_source from public.customer_review_test_cards where id = pg_temp.id('d1')) = 'purge',
    'ASSERT START did not freeze the card';
  assert (select count(*) from public.customer_review_test_card_events where card_id = pg_temp.id('d1') and event_type = 'deleted') = 1,
    'ASSERT START did not record itself once';

  v_again := pg_temp.purge_begin(pg_temp.id('d1'), pg_temp.id('admin'));
  assert v_again = v_start, 'ASSERT a repeated START answered differently';
  assert (select count(*) from public.customer_review_test_card_events where card_id = pg_temp.id('d1') and event_type = 'deleted') = 1,
    'ASSERT a repeated START wrote a second event';

  -- Frozen: nothing can approve it, attach to it, or soft-delete it now.
  perform pg_temp.refuses('authenticated', pg_temp.id('verifier'),
    format('select public.approve_customer_review_drafts(array[%L]::uuid[], false)', pg_temp.id('d1')),
    '23514', 'no longer awaiting approval', 'a purge in progress cannot be approved');
  perform pg_temp.refuses(null, null,
    format($q$insert into public.customer_review_test_card_screenshots
             (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
           values (%L, 'review_image', 1, %L, 'z.jpg', 'image/jpeg', 100, repeat('f', 64), %L)$q$,
           pg_temp.id('d1'), pg_temp.id('d1') || '/review_image/z.jpg', pg_temp.id('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_DELETED', 'a purge in progress cannot take an attachment');
  perform pg_temp.refuses('authenticated', pg_temp.id('verifier'),
    format('select public.delete_customer_review_test_cards(array[%L]::uuid[], %L)', pg_temp.id('d1'), 'single'),
    '23514', 'CUSTOMER_REVIEW_TEST_ALREADY_DELETED', 'a purge in progress cannot be soft-deleted over');

  -- Both files still stored: refused, and the record is still there.
  perform pg_temp.refuses('service_role', null,
    format('select public.finish_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('admin')),
    '23514', '2 file(s) of this record are still stored', 'FINISH refuses while both files remain');

  perform pg_temp.remove_object('customer-review-test-screenshots', pg_temp.id('d1') || '/review_image/a.jpg');
  perform pg_temp.refuses('service_role', null,
    format('select public.finish_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('admin')),
    '23514', '1 file(s) of this record are still stored', 'FINISH refuses while the unrecorded file remains');
  assert exists (select 1 from public.customer_review_test_cards where id = pg_temp.id('d1')),
    'ASSERT the record was deleted while a file remained';

  -- ── The reload: an interrupted purge is still reachable, by a purge admin only ──
  assert (pg_temp.record_as(pg_temp.id('admin'), pg_temp.id('d1'))->>'purge_in_progress')::boolean = true,
    'ASSERT the admin cannot reopen the interrupted purge';
  assert (pg_temp.record_as(pg_temp.id('bare_admin'), pg_temp.id('d1'))->>'purge_in_progress')::boolean = true,
    'ASSERT the admin without verify cannot reopen the interrupted purge';
  assert pg_temp.record_as(pg_temp.id('verifier'), pg_temp.id('d1')) is null,
    'ASSERT a verifier without admin can reach the interrupted purge';
  assert pg_temp.record_as(pg_temp.id('employee'), pg_temp.id('d1')) is null,
    'ASSERT an employee can reach the interrupted purge';
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', 'a verifier without admin cannot continue the purge');
  -- Continuing, by an admin who holds no Review permission, is the same START.
  assert pg_temp.purge_begin(pg_temp.id('d1'), pg_temp.id('bare_admin')) = v_start,
    'ASSERT continuing as another admin answered differently';

  raise notice 'PASS  3. START freezes and repeats; FINISH refuses until every file under the prefix is gone';
end $$;

-- ─── 4. NOTHING LEFT ────────────────────────────────────────────────────────

do $$
declare
  v_done jsonb;
  v_again jsonb;
begin
  perform pg_temp.remove_object('customer-review-test-screenshots', pg_temp.id('d1') || '/review_image/orphan.jpg');
  -- Finished by the admin who holds no Review permission.
  v_done := pg_temp.purge_finish(pg_temp.id('d1'), pg_temp.id('bare_admin'));

  assert (v_done->>'purged')::boolean = true, 'ASSERT FINISH did not purge: ' || v_done::text;
  assert (v_done->>'screenshots')::integer = 1, 'ASSERT FINISH counted the wrong attachments: ' || v_done::text;
  assert (v_done->>'events')::integer = 4, 'ASSERT FINISH counted the wrong history: ' || v_done::text;

  assert not exists (select 1 from public.customer_review_test_cards where id = pg_temp.id('d1')), 'ASSERT the card survived';
  assert not exists (select 1 from public.customer_review_test_card_screenshots where card_id = pg_temp.id('d1')), 'ASSERT an attachment row survived';
  assert not exists (select 1 from public.customer_review_test_card_events where card_id = pg_temp.id('d1')), 'ASSERT a history row survived';
  assert not exists (select 1 from storage.objects where split_part(name, '/', 1) = pg_temp.id('d1')::text), 'ASSERT a file survived';
  assert pg_temp.record_as(pg_temp.id('admin'), pg_temp.id('d1')) is null, 'ASSERT the purge page still finds the purged card';

  v_again := pg_temp.purge_finish(pg_temp.id('d1'), pg_temp.id('admin'));
  assert (v_again->>'already_gone')::boolean = true and (v_again->>'purged')::boolean = false,
    'ASSERT a repeated FINISH did not report the record gone: ' || v_again::text;
  perform pg_temp.refuses('service_role', null,
    format('select public.begin_customer_review_test_card_purge(%L, %L)', pg_temp.id('d1'), pg_temp.id('admin')),
    'P0002', 'CUSTOMER_REVIEW_TEST_NOT_FOUND', 'a repeated START finds nothing');

  raise notice 'PASS  4. no card, attachment, history or file remains; repeats are safe';
end $$;

-- ─── 5. RECHECK: a reward that appears mid-purge ─────────────────────────────

do $$
begin
  perform pg_temp.purge_begin(pg_temp.id('d3'), pg_temp.id('admin'));
  insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id, description)
  values (pg_temp.id('employee'), 'review_reward', 1, 'customer_review', pg_temp.id('d3'), 'Fixture reward appearing mid-purge');

  perform pg_temp.refuses('service_role', null,
    format('select public.finish_customer_review_test_card_purge(%L, %L)', pg_temp.id('d3'), pg_temp.id('admin')),
    '23514', 'CUSTOMER_REVIEW_TEST_PURGE_REWARD_ATTACHED', 'FINISH re-checks the reward');
  assert exists (select 1 from public.customer_review_test_cards where id = pg_temp.id('d3')),
    'ASSERT a rewarded card was deleted at FINISH';

  raise notice 'PASS  5. FINISH re-checks eligibility under the lock';
end $$;

-- ─── 6. BYSTANDERS AND THE SOFT DELETION ────────────────────────────────────

do $$
declare
  b record;
begin
  select * into b from purge_baseline;

  -- Another draft, whole.
  assert exists (select 1 from public.customer_review_test_cards where id = pg_temp.id('d2') and deleted_at is null), 'ASSERT d2 changed';
  assert (select count(*) from public.customer_review_test_card_screenshots where card_id = pg_temp.id('d2')) = 1, 'ASSERT d2 lost an attachment';
  assert (select count(*) from public.customer_review_test_card_events where card_id = pg_temp.id('d2')) = 1, 'ASSERT d2 lost history';
  assert exists (select 1 from storage.objects where name = pg_temp.id('d2') || '/review_image/b.jpg'), 'ASSERT d2 lost its file';

  -- The verifier's soft deletion kept everything, as it always has.
  assert (select deleted_source from public.customer_review_test_cards where id = pg_temp.id('sd')) = 'single', 'ASSERT sd changed';
  assert (select count(*) from public.customer_review_test_card_screenshots where card_id = pg_temp.id('sd')) = 1, 'ASSERT the soft deletion removed an attachment';
  assert exists (select 1 from storage.objects where name = pg_temp.id('sd') || '/review_image/c.jpg'), 'ASSERT the soft deletion removed a file';

  -- The custom submission and its proof.
  assert (select count(*) from public.customer_review_custom_submissions) = b.custom_rows, 'ASSERT a custom submission changed';
  assert exists (select 1 from public.customer_review_custom_submissions where id = pg_temp.id('cs') and status = 'pending_verification'), 'ASSERT the custom submission changed';
  assert exists (select 1 from storage.objects where bucket_id = 'customer-review-custom-proofs' and name = pg_temp.id('cs') || '/proof/p.jpg'), 'ASSERT the custom proof was removed';

  -- Credits: nothing reversed, nothing removed; only the one row section 5 added.
  assert (select count(*) from public.boe_credit_transactions) = b.ledger_rows + 1, 'ASSERT the ledger changed';
  assert (select count(*) from public.boe_credit_review_rewards) = b.reward_rows, 'ASSERT a reward record changed';
  assert not exists (select 1 from public.boe_credit_transactions where transaction_type = 'reversal'), 'ASSERT a reward was reversed';

  -- Exactly the two d1 files are gone from storage.
  assert (select count(*) from storage.objects) = b.objects - 2, 'ASSERT storage lost more than the purged card''s files';

  raise notice 'PASS  6. another card, a tombstone, a custom submission, the ledger and their files are untouched';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
