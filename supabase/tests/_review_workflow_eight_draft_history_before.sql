-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — the history 20261031000000 must not disturb
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHAT IT IS FOR
-- --------------
-- 20261031000000 raises a batch from eight drafts to twelve, and it does so with
-- CHECK constraints added NOT VALID precisely so that the batches already in the
-- database are left alone. That claim cannot be tested against an empty table:
-- there has to BE an eight-draft batch, made the way the old code made one,
-- before the new migration runs.
--
-- So this file is applied AFTER 20261030000000 and BEFORE 20261031000000, and it
-- builds exactly what production would hold on the morning of the change:
--
--   * a batch of eight drafts, created by the REAL
--     create_customer_review_draft_batch() as it stood at 20261026000000 — not
--     by hand-inserted rows, because a hand-inserted row proves nothing about
--     what the old generator produced;
--   * two of those drafts APPROVED through the REAL
--     approve_customer_review_drafts(), so the history includes a released
--     review as well as pending ones;
--   * the six that remain pending, so "an old batch is still readable and its
--     drafts still work" has something to be true of.
--
-- The actors it needs are created here too, and they are the same fixture
-- identities the assertions file uses, so the two agree about who is who.
--
-- IT IS NOT A RECORD OF PRODUCTION. It is the smallest thing shaped like the
-- history whose survival the migration promises.

-- ── The actors ──────────────────────────────────────────────────────────────
--
-- Cleared first so the file is re-runnable against a stack that has already
-- seen it. The ffffffff- prefix is the harness convention.
do $$
declare
  v_module uuid;
  v_use    uuid;
  v_verify uuid;
begin
  delete from public.employee_permission_overrides
   where user_id::text like 'ffffffff-0000-4000-8000-%';
  delete from public.users
   where id::text like 'ffffffff-0000-4000-8000-%';

  insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
  values
    ('ffffffff-0000-4000-8000-000000000001', 'Fixture Admin',       'fixture.admin@example.test',    'admin',  'management', true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000002', 'Fixture Tester',      'fixture.tester@example.test',   'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000004', 'Fixture Verifier',    'fixture.verifier@example.test', 'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000005', 'Fixture Nobody',      'fixture.nobody@example.test',   'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000007', 'Fixture Ex-Verifier', 'fixture.exverif@example.test',  'member', 'sales',      false, now(), now());

  select id into v_module from public.permission_modules where module_key = 'customer_review_requests';
  if v_module is null then
    raise exception 'the customer_review_requests permission module is missing; is 20261017000000 applied?';
  end if;
  select a.id into v_use    from public.permission_actions a where a.action_key = 'use';
  select a.id into v_verify from public.permission_actions a where a.action_key = 'verify';

  -- Granted the way the product grants them: per-employee overrides.
  --
  -- THE VERIFIER HOLDS `verify` AND NOT `use`, deliberately, and the tester the
  -- reverse. That separation is what makes "only verify may edit" a real
  -- assertion rather than a claim about an unused branch.
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values
    ('ffffffff-0000-4000-8000-000000000002', v_module, v_use,    true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000004', v_module, v_verify, true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000007', v_module, v_verify, true, 'ffffffff-0000-4000-8000-000000000001');
end $$;

-- ── The eight-draft batch, made by the generator that only knew eight ───────
do $$
declare
  v_batch  uuid;
  v_drafts jsonb := '[]'::jsonb;
  v_ids    uuid[];
begin
  for i in 1..8 loop
    v_drafts := v_drafts || jsonb_build_object(
      'title', format('Historical draft %s', i),
      'body',  format('This draft was generated before the twelve-draft change and exists so that the migration can be shown not to disturb it. Number %s of eight.', i),
      'category', 'restaurant_test');
  end loop;

  v_batch := public.create_customer_review_draft_batch(
    'Historical guidance: an eight-draft batch from before the change.',
    'claude-opus-5',
    v_drafts,
    'ffffffff-0000-4000-8000-000000000004',
    '88888888-0000-4000-8000-000000000008'::uuid);

  if v_batch is null then
    raise exception 'the historical batch was not created';
  end if;

  -- TWO OF THE EIGHT RELEASED, through the real approval path, so the history
  -- holds an approved review as well as pending ones. auth.uid() has to be the
  -- verifier for approve_customer_review_drafts(), which reads it rather than
  -- taking an actor argument.
  select array_agg(id order by card_ref) into v_ids
    from (select id, card_ref from public.customer_review_test_cards
           where batch_id = v_batch order by card_ref limit 2) t;

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000004',
                                   'role', 'authenticated')::text);
  perform public.approve_customer_review_drafts(v_ids, false);
  set local request.jwt.claims = '';

  raise notice 'HISTORY  batch % holds 8 drafts: 2 approved, 6 pending', v_batch;
end $$;

-- ── State the shape out loud, so the runner can check it ────────────────────
do $$
declare
  v_batches   integer;
  v_count     integer;
  v_cards     integer;
  v_approved  integer;
  v_pending   integer;
begin
  select count(*) into v_batches from public.customer_review_draft_batches;
  select card_count into v_count from public.customer_review_draft_batches limit 1;
  select count(*) into v_cards from public.customer_review_test_cards;
  select count(*) into v_approved from public.customer_review_test_cards where status = 'available';
  select count(*) into v_pending from public.customer_review_test_cards where status = 'pending_approval';

  if v_batches <> 1 or v_count <> 8 or v_cards <> 8 or v_approved <> 2 or v_pending <> 6 then
    raise exception 'the pre-migration history is %/%/%/%/%, expected 1 batch of 8, 8 cards, 2 available, 6 pending',
      v_batches, v_count, v_cards, v_approved, v_pending;
  end if;

  raise notice 'PASS  the pre-migration history is one eight-draft batch: 2 approved, 6 pending';
end $$;
