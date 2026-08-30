-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow Test (Internal) — the whole workflow, proved against a
-- database
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS, AND WHY THE TEXT AUDIT IS NOT ENOUGH.
--
-- migration.test.ts and securityContract.test.ts read the migration as text.
-- They are worth having, and an earlier round of this module proved they are
-- not sufficient: a SELECT policy that delegated to a predicate which re-read
-- its own table passed every text audit and made the module's primary action
-- impossible, because Postgres applies the SELECT policy to the row a writing
-- statement is about to RETURN and a STABLE lookup cannot see it. No amount of
-- reading the SQL revealed that. Executing it did, at once.
--
-- So the assertions below EXECUTE. Every one of them either performs the
-- operation as a specific fictional person and checks what happened, or reads
-- pg_policies / pg_proc to describe the database that exists rather than the
-- file that built it.
--
-- WHAT IS PROVED HERE
--   1.  the policies and predicates have the shape the module depends on
--   2.  the available pool is visible to an authorized tester and to nobody else
--   3.  booking is refused a second time, with an exact SQLSTATE
--   4.  an inactive account is refused everywhere, admin or not
--   5.  a tester sees their own cards and not a colleague's
--   6.  a verifier sees submitted cards, and history keeps verified ones
--   7.  no client role can write a card, a screenshot row or a storage object
--   8.  opening WhatsApp moves no status
--   9.  submitting without evidence is refused, with an exact SQLSTATE
--   10. the definer predicates answer for the CALLER, never for a uuid handed in
--   11. all of it survives public.users being tightened
--
-- WHERE TO RUN IT
-- ---------------
-- A THROWAWAY database with the module's migration applied. It creates its own
-- fictional people and cards, exercises them, and deletes everything it made.
-- It is not for production and it is not idempotent against real data: the
-- fixed UUIDs below are reserved for it.
--
--   supabase/tests/run_customer_review_outreach_local.sh
--
-- Any failure raises, so a non-zero exit is the whole result.
--
-- EVERY FAULT INJECTION IS UNDONE IN AN EXCEPTION HANDLER AS WELL AS ON THE
-- SUCCESS PATH. Two sections below deliberately break a policy or a grant to
-- see what depends on it; an assertion failing in the middle must not leave the
-- database that way.

-- ─── 0A. THE REWRITE TOUCHED ONLY WHAT WAS STILL AVAILABLE ─────────────────
--
-- _review_workflow_drafts_before.sql put three cards down before
-- 20261023000000 ran: one available, one booked, one verified. The migration
-- was allowed to rewrite exactly one of them.
--
-- This runs first, because it is the only claim in this file that is about
-- something that has ALREADY happened, and because it clears its own rows out
-- of the pool before section 2 counts it.

do $$
declare
  v_probe   record;
  v_now     record;
  v_changed integer := 0;
begin
  if to_regclass('public.zz_review_workflow_rewrite_probe') is null then
    raise exception '0A has no probe table; _review_workflow_drafts_before.sql did not run';
  end if;

  for v_probe in select * from public.zz_review_workflow_rewrite_probe order by card_ref loop
    select * into v_now from public.customer_review_test_cards where id = v_probe.id;
    if v_now.id is null then
      raise exception 'the migration DELETED probe card %', v_probe.card_ref;
    end if;

    if v_probe.status = 'available' then
      -- The one it was allowed to touch. It must actually have been rewritten,
      -- or the migration silently did nothing and every other assertion here
      -- would pass vacuously.
      if v_now.test_body = v_probe.test_body then
        raise exception 'the AVAILABLE card % was not rewritten at all', v_probe.card_ref;
      end if;
      if v_now.card_ref !~ '^RW-[0-9]{6}$' then
        raise exception 'the rewritten card kept reference %', v_now.card_ref;
      end if;
      if v_now.status <> 'available' then
        raise exception 'the rewrite moved card % to status %', v_probe.card_ref, v_now.status;
      end if;
      if length(v_now.test_body) < 100 then
        raise exception 'the replacement body is % characters, which is not a review',
          length(v_now.test_body);
      end if;
      v_changed := v_changed + 1;
      raise notice 'PASS  0A1. the available card was rewritten: % → %, % characters',
        v_probe.card_ref, v_now.card_ref, length(v_now.test_body);
    else
      -- Everything else is somebody's record, and every field of it has to be
      -- exactly what it was.
      if v_now.card_ref  <> v_probe.card_ref
      or v_now.test_body <> v_probe.test_body
      or v_now.test_title<> v_probe.test_title
      or v_now.test_category <> v_probe.test_category
      or v_now.status    <> v_probe.status then
        raise exception 'THE MIGRATION REWROTE A % CARD (%): ref %→%, title %→%',
          v_probe.status, v_probe.card_ref, v_probe.card_ref, v_now.card_ref,
          v_probe.test_title, v_now.test_title;
      end if;
      raise notice 'PASS  0A2. the % card % was left exactly as it was', v_probe.status, v_probe.card_ref;
    end if;
  end loop;

  if v_changed <> 1 then
    raise exception '0A expected exactly one rewritten card, saw %', v_changed;
  end if;

  -- And no generated card can claim a reference the rewrite already used.
  if (select count(*) from public.customer_review_test_cards where card_ref = 'RW-000001') > 1 then
    raise exception 'RW-000001 is not unique';
  end if;
end $$;

-- Clear the probe out, so the pool section that follows counts only its own.
do $$
begin
  delete from public.customer_review_test_cards
   where id::text like 'eeeeeeee-0000-4000-8000-%';
  delete from public.users
   where id::text like 'eeeeeeee-0000-4000-8000-%';
  drop table if exists public.zz_review_workflow_rewrite_probe;
  raise notice 'PASS  0A3. probe rows removed; the pool is back to what this file owns';
end $$;

-- ─── 0. Fictional fixtures ─────────────────────────────────────────────────
--
-- Seven people, because the workflow has more edges than it looks. Two ordinary
-- `use` holders (so "can a colleague read my test" is a real question rather
-- than a hypothetical), a verifier, an admin, somebody with nothing, and
-- deactivated copies of the two identities that would otherwise have the most
-- reach.

-- Clean any residue from an interrupted previous run, in dependency order.
-- storage.objects carries a BEFORE DELETE guard (storage.protect_objects_delete)
-- that refuses direct deletion: in a real deployment the object FILE would be
-- orphaned by it. This harness only ever wrote the ROW — there is no file — so
-- the guard is suspended for the length of one transaction to clear up after
-- itself. SET LOCAL, so it is scoped to the transaction and reverts on commit;
-- no product code path does this, and nothing else in this file runs with it
-- off.
begin;
  set local session_replication_role = 'replica';
  delete from storage.objects
   where bucket_id = 'customer-review-test-screenshots'
     and split_part(name, '/', 1) in ('aaaaaaaa-0000-4000-8000-000000000001',
                                      'aaaaaaaa-0000-4000-8000-000000000002',
                                      'aaaaaaaa-0000-4000-8000-000000000003',
                                      'aaaaaaaa-0000-4000-8000-000000000004');
commit;

do $$
declare
  v_module uuid;
  v_use    uuid;
  v_verify uuid;
begin
  delete from public.customer_review_test_card_screenshots
   where card_id::text like 'aaaaaaaa-0000-4000-8000-%';
  delete from public.customer_review_test_card_events
   where card_id::text like 'aaaaaaaa-0000-4000-8000-%';
  delete from public.customer_review_test_cards
   where id::text like 'aaaaaaaa-0000-4000-8000-%';
  delete from public.employee_permission_overrides
   where user_id::text like 'ffffffff-0000-4000-8000-%';
  delete from public.users
   where id::text like 'ffffffff-0000-4000-8000-%';

  insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
  values
    ('ffffffff-0000-4000-8000-000000000001', 'Fixture Admin',      'fixture.admin@example.test',    'admin',  'management', true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000002', 'Fixture Tester',     'fixture.tester@example.test',   'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000003', 'Fixture Colleague',  'fixture.colleague@example.test','member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000004', 'Fixture Verifier',   'fixture.verifier@example.test', 'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000005', 'Fixture Nobody',     'fixture.nobody@example.test',   'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000006', 'Fixture Ex-Admin',   'fixture.exadmin@example.test',  'admin',  'management', false, now(), now()),
    ('ffffffff-0000-4000-8000-000000000007', 'Fixture Ex-Verifier','fixture.exverif@example.test',  'member', 'sales',      false, now(), now());

  select id into v_module from public.permission_modules where module_key = 'customer_review_requests';
  if v_module is null then
    raise exception 'the customer_review_requests permission module is missing; is the migration applied?';
  end if;
  select a.id into v_use    from public.permission_actions a where a.action_key = 'use';
  select a.id into v_verify from public.permission_actions a where a.action_key = 'verify';

  -- Granted the way the product grants them: per-employee overrides, level 4.
  --
  -- FIXTURE VERIFIER HOLDS `verify` AND NOT `use`, deliberately. That is the
  -- separation the workflow exists to exercise — a verifier checks other
  -- people's tests and does not run their own — and it makes "a verifier cannot
  -- book" a real assertion rather than a claim about an unused branch.
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values
    ('ffffffff-0000-4000-8000-000000000002', v_module, v_use,    true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000003', v_module, v_use,    true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000004', v_module, v_verify, true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000007', v_module, v_verify, true, 'ffffffff-0000-4000-8000-000000000001');

  -- Four cards, loaded the way the fixture does — as the owner, because no
  -- client role can create one. TEST-9xx refs are reserved for this harness so
  -- they cannot collide with the real fixture's TEST-0xx.
  insert into public.customer_review_test_cards (id, card_ref, test_category, test_title, test_body)
  values
    ('aaaaaaaa-0000-4000-8000-000000000001', 'TEST-901', 'restaurant_test', 'Harness card one',
     'Harness filler for the assertions file. It describes nothing and is not attributed to anybody.'),
    ('aaaaaaaa-0000-4000-8000-000000000002', 'TEST-902', 'cafe_test', 'Harness card two',
     'Harness filler for the assertions file. It describes nothing and is not attributed to anybody.'),
    ('aaaaaaaa-0000-4000-8000-000000000003', 'TEST-903', 'hotel_test', 'Harness card three',
     'Harness filler for the assertions file. It describes nothing and is not attributed to anybody.'),
    ('aaaaaaaa-0000-4000-8000-000000000004', 'TEST-904', 'delivery_test', 'Harness card four',
     'Harness filler for the assertions file. It describes nothing and is not attributed to anybody.');
end $$;

-- ─── Helpers: acting as somebody, through their own RLS ─────────────────────

-- Run a read AS somebody, the way PostgREST would.
create or replace function pg_temp.cards_visible_to(p_user uuid, p_card uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_test_cards where id = p_card;
  reset role;
  return n;
end $$;

create or replace function pg_temp.screenshots_visible_to(p_user uuid, p_card uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_test_card_screenshots where card_id = p_card;
  reset role;
  return n;
end $$;

create or replace function pg_temp.events_visible_to(p_user uuid, p_card uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_test_card_events where card_id = p_card;
  reset role;
  return n;
end $$;

create or replace function pg_temp.objects_visible_to(p_user uuid, p_card uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'customer-review-test-screenshots'
     and split_part(name, '/', 1) = p_card::text;
  reset role;
  return n;
end $$;

-- How many AVAILABLE cards this person can see. The Available screen's query,
-- asked of the database rather than of the component.
create or replace function pg_temp.available_count_for(p_user uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n
    from public.customer_review_test_cards
   where status = 'available'
     and id::text like 'aaaaaaaa-0000-4000-8000-%';
  reset role;
  return n;
end $$;

-- Run a statement AS somebody and REQUIRE it to fail with an exact SQLSTATE.
--
-- The SQLSTATE is asserted, not merely the failure. "It errored" is compatible
-- with a typo in the test; "it raised 42501" is the database refusing for the
-- reason the module says it refuses.
create or replace function pg_temp.refused_with(
  p_user uuid, p_sql text, p_sqlstate text, p_label text
)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    execute format('set local request.jwt.claims = %L',
                   json_build_object('sub', p_user, 'role', 'authenticated')::text);
    set local role authenticated;
    execute p_sql;
    reset role;
    raise exception 'EXPECTED REFUSAL, GOT SUCCESS — %', p_label;
  exception
    when sqlstate 'P0001' then
      -- Our own "expected refusal, got success" raise. Re-raise it unchanged.
      begin reset role; exception when others then null; end;
      raise;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      begin reset role; exception when others then null; end;
      if v_state <> p_sqlstate then
        raise exception 'WRONG SQLSTATE for % — expected %, got % (%)', p_label, p_sqlstate, v_state, v_msg;
      end if;
      raise notice 'PASS      % — refused %', p_label, v_state;
  end;
end $$;

-- The same, for an RPC that raises its own coded exception.
create or replace function pg_temp.rpc_refused_with(
  p_user uuid, p_sql text, p_sqlstate text, p_label text
)
returns void language plpgsql as $$
begin
  perform pg_temp.refused_with(p_user, p_sql, p_sqlstate, p_label);
end $$;

-- ─── 1. How the card policy is allowed to decide ───────────────────────────
--
-- Read from pg_policies and pg_proc, so this describes the database that
-- exists rather than the file that built it.
--
-- Three distinct mistakes are guarded against:
--
--   A. Resolving the card by SELECTing it. The card-id helper is STABLE and
--      re-reads this very table, so a row a writing statement is about to
--      return is invisible to it: policy false, statement refused 42501.
--
--   B. Reading public.users inline in the policy body. A policy runs as the
--      CALLER, so that binds this module's visibility to another table's grants
--      and row security. Neither is this module's to rely on.
--
--   C. Showing the available pool without an authorization check. The status
--      branch reads off the candidate row, which is safe on its own — but
--      unguarded it would show every unbooked card to anybody signed in.

do $$
declare v_qual text; v_src text; v_n integer;
begin
  -- Filtered by policyname: a second SELECT policy added later would otherwise
  -- make SELECT INTO assert against whichever row it happened to get.
  select coalesce(qual, '') into v_qual
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_test_cards'
    and cmd        = 'SELECT'
    and policyname = 'customer_review_test_cards_select';

  if v_qual is null or v_qual = '' then
    raise exception 'customer_review_test_cards_select is missing';
  end if;

  -- (A) matched on the exact call shape, so the _row variant does not count.
  if v_qual ~ 'can_view_customer_review_test_card\(' then
    raise exception 'the card SELECT policy re-queries its own table';
  end if;

  -- (B)
  if v_qual ~* '\mfrom\M\s+(public\.)?users\M' then
    raise exception 'the card SELECT policy reads public.users as the caller';
  end if;

  -- (C)
  if v_qual not like '%can_use_customer_review_test_cards%' then
    raise exception 'the available branch of the card SELECT policy is not gated on an authorization check';
  end if;
  if v_qual not like '%can_view_customer_review_test_card_row%' then
    raise exception 'the card SELECT policy does not use the row predicate';
  end if;

  raise notice 'PASS  1a. the card policy neither re-reads its table nor reads users as the caller, and gates the pool';

  -- THE CARD TABLE HAS NO WRITE POLICY AT ALL, and no client write privilege.
  -- This is the module's central structural claim: cards are fixture-loaded and
  -- move only through the definer functions.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_test_cards'
    and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'customer_review_test_cards has % write polic(ies)', v_n;
  end if;

  if has_table_privilege('authenticated', 'public.customer_review_test_cards', 'INSERT')
     or has_table_privilege('authenticated', 'public.customer_review_test_cards', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_test_cards', 'DELETE') then
    raise exception 'authenticated still holds a write privilege on customer_review_test_cards';
  end if;
  raise notice 'PASS  1b. no client role can create, edit or delete a test card by any route';

  -- The predicates are definer-rights, path-pinned, and not anon-callable.
  for v_src in
    select unnest(array[
      'can_use_customer_review_test_cards',
      'can_view_customer_review_test_card',
      'can_view_customer_review_test_card_row'
    ])
  loop
    if not exists (
      select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
      where n.nspname = 'public' and f.proname = v_src
        and f.prosecdef
        and array_to_string(coalesce(f.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
    ) then
      raise exception '% is not SECURITY DEFINER with a pinned search_path', v_src;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.can_view_customer_review_test_card_row(uuid)', 'EXECUTE') then
    raise exception 'anon can execute the row predicate';
  end if;
  raise notice 'PASS  1c. the predicates are definer-rights, path-pinned and not anon-callable';

  -- The row predicate must not go back to the card table.
  select coalesce(prosrc, '') into v_src
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public' and f.proname = 'can_view_customer_review_test_card_row';
  if v_src ~* '(from|join)\s+(public\.)?customer_review_test_cards\M' then
    raise exception 'the row predicate queries customer_review_test_cards';
  end if;
  if v_src not like '%is_active%' then
    raise exception 'the row predicate no longer requires an active user';
  end if;
  raise notice 'PASS  1d. the row predicate decides from its argument and still requires an active user';

  -- The child tables share the card-id predicate.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename in ('customer_review_test_card_screenshots', 'customer_review_test_card_events')
    and cmd = 'SELECT'
    and coalesce(qual, '') like '%can_view_customer_review_test_card(%';
  if v_n <> 2 then
    raise exception 'the child tables do not both use the card-id predicate (got %)', v_n;
  end if;
  raise notice 'PASS  1e. both child tables share the card-id predicate';
end $$;

-- ─── 2. The available pool ─────────────────────────────────────────────────
--
-- Only 'available' cards, and only to people who may use the module.

do $$
declare v_n integer;
begin
  v_n := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000002');
  if v_n <> 4 then
    raise exception 'an authorized tester sees % available card(s), expected 4', v_n;
  end if;
  raise notice 'PASS  2a. an authorized tester sees the whole available pool';

  v_n := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000005');
  if v_n <> 0 then
    raise exception 'an employee with no permission sees % available card(s), expected 0', v_n;
  end if;
  raise notice 'PASS  2b. an employee with nothing sees no available cards';

  v_n := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000006');
  if v_n <> 0 then
    raise exception 'a DEACTIVATED ADMIN sees % available card(s), expected 0', v_n;
  end if;
  raise notice 'PASS  2c. a deactivated admin sees nothing, admin role notwithstanding';

  v_n := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000007');
  if v_n <> 0 then
    raise exception 'a DEACTIVATED VERIFIER sees % available card(s), expected 0', v_n;
  end if;
  raise notice 'PASS  2d. a deactivated verifier sees nothing either';
end $$;

-- ─── 3. Booking ────────────────────────────────────────────────────────────
--
-- ON ATOMICITY, STATED HONESTLY. This file runs in ONE psql session, so it
-- cannot execute two genuinely concurrent bookings. What it proves instead is
-- the property the race safety RESTS on, in two halves:
--
--   * STRUCTURALLY, that the claim is a single conditional UPDATE carrying
--     `status = 'available'` in its WHERE clause — not a SELECT followed by an
--     UPDATE, which is the shape that loses a race.
--   * BEHAVIOURALLY, that a second booking of the same card is refused with an
--     exact SQLSTATE.
--
-- Under READ COMMITTED those two together are what makes the race safe: a
-- concurrent transaction blocks on the row lock, re-evaluates the WHERE against
-- the committed new version, matches nothing, and takes the refusal branch —
-- the same branch the second booking below takes.

do $$
declare v_src text; v_status text; v_holder uuid; v_events integer;
begin
  select coalesce(prosrc, '') into v_src
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public' and f.proname = 'book_customer_review_test_card';

  if v_src = '' then raise exception 'book_customer_review_test_card is missing'; end if;

  -- The conditional UPDATE, and no read-then-write.
  if v_src !~ 'update\s+public\.customer_review_test_cards' then
    raise exception 'booking does not claim the row with an UPDATE';
  end if;
  if v_src !~ 'status\s*=\s*''available''' then
    raise exception 'the booking UPDATE does not carry status = ''available'' in its predicate';
  end if;
  if v_src ~* 'select\s+\*\s+into.*for\s+update' then
    raise exception 'booking reads the row with FOR UPDATE before claiming it; that is the shape that loses a race';
  end if;
  -- ...and the actor is not a parameter.
  if v_src !~ 'auth\.uid\(\)' then
    raise exception 'booking does not derive its actor from auth.uid()';
  end if;
  if pg_get_function_arguments(
       (select f.oid from pg_proc f join pg_namespace n on n.oid = f.pronamespace
        where n.nspname = 'public' and f.proname = 'book_customer_review_test_card')
     ) <> 'p_card_id uuid' then
    raise exception 'booking takes something other than a card id';
  end if;
  raise notice 'PASS  3a. booking is one conditional UPDATE, and its actor is auth.uid()';
end $$;

-- The tester books TEST-901.
do $$
declare v_status text; v_holder uuid;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001');
  reset role;

  select status, booked_by into v_status, v_holder
  from public.customer_review_test_cards where id = 'aaaaaaaa-0000-4000-8000-000000000001';

  if v_status <> 'booked' then
    raise exception 'after booking the card is %, expected booked', v_status;
  end if;
  if v_holder <> 'ffffffff-0000-4000-8000-000000000002' then
    raise exception 'the card was booked to the wrong person';
  end if;
  raise notice 'PASS  3b. an authorized tester books an available card, and it is assigned to THEM';
end $$;

do $$
begin
  -- THE SECOND BOOKING. The colleague also holds `use` and is refused because
  -- the card is no longer available, not because of who they are.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000003',
    $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001')$q$,
    '23514',
    '3c. a second booking of the same card');

  -- An employee with no permission at all.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000005',
    $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000002')$q$,
    '42501',
    '3d. booking by an employee with no permission');

  -- A VERIFIER WITHOUT `use` CANNOT BOOK. The separation the workflow exists to
  -- exercise: the person who checks a test does not run it.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000002')$q$,
    '42501',
    '3e. booking by a verifier who does not hold use');

  -- A DEACTIVATED ADMIN. Role is not a substitute for being an active employee.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000006',
    $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000002')$q$,
    '42501',
    '3f. booking by a deactivated admin');

  -- A card that does not exist answers P0002, distinctly from a taken one.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-0000000000ff')$q$,
    'P0002',
    '3g. booking a card that does not exist');
end $$;

-- ─── 4. Who can see a booked card ──────────────────────────────────────────

do $$
declare v_n integer;
begin
  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 1 then raise exception 'the tester cannot see their own booked card (saw %)', v_n; end if;
  raise notice 'PASS  4a. the tester sees the card they hold';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 0 then raise exception 'a colleague with `use` can see somebody else''s booked card (saw %)', v_n; end if;
  raise notice 'PASS  4b. another `use` holder cannot see it';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 0 then raise exception 'an employee with nothing can see a booked card (saw %)', v_n; end if;
  raise notice 'PASS  4c. an employee with nothing sees no row';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 1 then raise exception 'a verifier cannot see a booked card (saw %)', v_n; end if;
  raise notice 'PASS  4d. a verifier can see it';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 1 then raise exception 'an admin cannot see a booked card (saw %)', v_n; end if;
  raise notice 'PASS  4e. an admin can see it';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 0 then raise exception 'a DEACTIVATED admin can see a booked card (saw %)', v_n; end if;
  raise notice 'PASS  4f. a deactivated admin sees nothing';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 0 then raise exception 'a DEACTIVATED verifier can see a booked card (saw %)', v_n; end if;
  raise notice 'PASS  4g. a deactivated verifier sees nothing';

  -- A caller with no identity at all.
  set local request.jwt.claims = '';
  set local role authenticated;
  select count(*) into v_n from public.customer_review_test_cards;
  reset role;
  if v_n <> 0 then raise exception 'an unidentified caller saw % card(s)', v_n; end if;
  raise notice 'PASS  4h. a caller with no identity sees nothing at all';
end $$;

-- ─── 5. Opening WhatsApp changes no status ─────────────────────────────────
--
-- The single most important negative in the module. The recording function is
-- granted to service_role alone (the route establishes the actor, validates the
-- number and REDUCES it before calling), so it is called here as the owner —
-- and what is checked is that the STATUS did not move.
--
-- NOTE WHAT THIS BLOCK CANNOT DO, BECAUSE IT IS THE POINT: it has no phone
-- number to pass. The function takes FOUR DIGITS and nothing else, so there is
-- nowhere in the signature a number could go. SQL never sees one.
--
-- THE FINGERPRINT PARAMETER IS GONE. It used to sit between the card and the
-- four digits — an HMAC of the E.164 form, so that two tests sent to one number
-- could be correlated. Nothing in this workflow correlates recipients, and the
-- key it borrowed was SUPABASE_SERVICE_ROLE_KEY, which is not a key for that.
-- Every assertion below is the same assertion with one less thing stored.

do $$
declare
  v_before text; v_after text; v_count integer;
  v_last_four text;
begin
  select status into v_before from public.customer_review_test_cards
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';

  perform public.record_customer_review_test_card_whatsapp_opened(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '0001',
    'ffffffff-0000-4000-8000-000000000002');

  select status, whatsapp_opened_count, whatsapp_target_last_four
    into v_after, v_count, v_last_four
  from public.customer_review_test_cards where id = 'aaaaaaaa-0000-4000-8000-000000000001';

  if v_after <> v_before then
    raise exception 'opening WhatsApp moved the status from % to %', v_before, v_after;
  end if;
  if v_count <> 1 then
    raise exception 'the open counter is %, expected 1', v_count;
  end if;
  if v_last_four <> '0001' then
    raise exception 'the recorded last-four is %, expected the four the route supplied', v_last_four;
  end if;
  raise notice 'PASS  5a. opening WhatsApp records preparation and moves no status';

  -- ...and the function is not reachable by a browser at all.
  if has_function_privilege('authenticated',
       'public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)', 'EXECUTE') then
    raise exception 'a browser role can call the WhatsApp recorder, which takes an actor id';
  end if;
  raise notice 'PASS  5b. the WhatsApp recorder is reachable by service_role alone';

  -- THE OLD SIGNATURE IS NOT MERELY UNUSED, IT IS ABSENT. A leftover
  -- four-argument overload would still accept a fingerprint from any caller
  -- that remembered it, and the revoke/grant pair naming the NEW signature
  -- would not have touched it — a grant against a signature that does not
  -- exist is an error, but an old definition nobody names is simply left
  -- behind with whatever privileges it had.
  if exists (
    select 1 from pg_proc pr
    join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public'
      and pr.proname = 'record_customer_review_test_card_whatsapp_opened'
      and array_to_string(pr.proargtypes::oid[]::regtype[], ', ') <> 'uuid, text, uuid'
  ) then
    raise exception 'an old overload of the WhatsApp recorder still exists';
  end if;
  raise notice 'PASS  5c. exactly one recorder overload exists, and it takes three arguments';

  -- ANYTHING THAT IS NOT A REDUCED FORM IS REFUSED, and a phone number is the
  -- case worth naming: a caller that tried to store one — because it had one,
  -- which the route never does — is refused by the shape guard rather than
  -- quietly writing it.
  begin
    perform public.record_customer_review_test_card_whatsapp_opened(
      'aaaaaaaa-0000-4000-8000-000000000001', '00012',
      'ffffffff-0000-4000-8000-000000000002');
    raise exception 'a malformed last-four was accepted';
  exception when sqlstate '23514' then
    raise notice 'PASS  5d. a last-four that is not four digits is refused 23514';
  end;

  begin
    perform public.record_customer_review_test_card_whatsapp_opened(
      'aaaaaaaa-0000-4000-8000-000000000001', '+919999900001',
      'ffffffff-0000-4000-8000-000000000002');
    raise exception 'a phone number was accepted as the last four';
  exception when sqlstate '23514' then
    raise notice 'PASS  5e. a phone number offered as the last four is refused 23514';
  end;

  -- THE COLUMN CANNOT HOLD A NUMBER EITHER. Attempted directly, past the
  -- function, as the owner: the CHECK constraint refuses it.
  begin
    update public.customer_review_test_cards
       set whatsapp_target_last_four = '+919999900001'
     where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    raise exception 'a phone number was accepted into the last-four column';
  exception when sqlstate '23514' then
    raise notice 'PASS  5f. the last-four column refuses a phone number outright';
  end;

  -- AND THERE IS NO FINGERPRINT COLUMN TO WRITE ONE INTO.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'customer_review_test_cards'
      and column_name = 'whatsapp_target_fingerprint'
  ) then
    raise exception 'the fingerprint column still exists';
  end if;
  raise notice 'PASS  5g. the recipient fingerprint column is gone';
end $$;

-- ─── 5A. A TESTER ACTION BELONGS TO THE TESTER HOLDING THE CARD ────────────
--
-- Item 1 of the review, asserted against the running database rather than
-- against the source. Card ...0001 is held by Fixture Tester (...0002).
--
-- The four cases the correction names, in the order they are worth reading:
--
--   a. the holder, who holds `use`               → SUCCEEDS
--   b. Fixture Colleague, who ALSO holds `use`    → 42501
--   c. Fixture Admin, who holds the card not at all → 42501
--   d. Fixture Verifier, who can read every card  → 42501
--
-- WHAT IS DELIBERATELY NOT REFUSED: a verifier or an admin READING the card,
-- and a verifier verifying or returning it. That is their whole authority, and
-- sections 4 and 8 check it still works.
--
-- Note the shape of (b) and (c): they differ from (a) in the ACTOR and in
-- nothing else — same card, same call, same permission in (b)'s case. If the
-- ownership check were ever softened, (a) would still pass, so (a) alone would
-- prove nothing.

do $$
declare v_role_leak boolean;
begin
  -- 5A-a. THE HOLDER SUCCEEDS. Stated first, because a rule that refuses
  -- everybody is not the rule under test.
  perform public.record_customer_review_test_card_whatsapp_opened(
    'aaaaaaaa-0000-4000-8000-000000000001', '0001',
    'ffffffff-0000-4000-8000-000000000002');
  raise notice 'PASS  5A-a. the holder may generate and record a link';

  -- 5A-b. ANOTHER PERSON WHO ALSO HOLDS `use`. The grant is asserted first, so
  -- a refusal here cannot be explained away as a missing permission.
  if not public.resolve_permission(
       'ffffffff-0000-4000-8000-000000000003', 'customer_review_requests', 'use') then
    raise exception 'Fixture Colleague does not actually hold use; this case proves nothing';
  end if;
  begin
    perform public.record_customer_review_test_card_whatsapp_opened(
      'aaaaaaaa-0000-4000-8000-000000000001', '0002',
      'ffffffff-0000-4000-8000-000000000003');
    raise exception 'ANOTHER use-HOLDER RECORDED A LINK ON A CARD THEY DO NOT HOLD';
  exception when sqlstate '42501' then
    raise notice 'PASS  5A-b. another `use` holder is refused 42501';
  end;

  -- 5A-c. AN ADMIN WHO DOES NOT HOLD THE CARD. The bypass this review removed.
  begin
    perform public.record_customer_review_test_card_whatsapp_opened(
      'aaaaaaaa-0000-4000-8000-000000000001', '0003',
      'ffffffff-0000-4000-8000-000000000001');
    raise exception 'AN ADMIN PERFORMED A TESTER ACTION ON SOMEBODY ELSE''S CARD';
  exception when sqlstate '42501' then
    raise notice 'PASS  5A-c. a non-holding ADMIN is refused 42501';
  end;

  -- 5A-d. A VERIFIER. Reading every card does not make one a tester on any.
  begin
    perform public.record_customer_review_test_card_whatsapp_opened(
      'aaaaaaaa-0000-4000-8000-000000000001', '0004',
      'ffffffff-0000-4000-8000-000000000004');
    raise exception 'A VERIFIER PERFORMED A TESTER ACTION';
  exception when sqlstate '42501' then
    raise notice 'PASS  5A-d. a verifier is refused 42501';
  end;

  -- 5A-e. NO ROLE IS READ ANYWHERE. The structural half, because a rule that
  -- happens to refuse an admin today could still be re-softened by a branch
  -- nobody notices; a function that cannot see a role cannot branch on one.
  select bool_or(pg_get_functiondef(pr.oid) ~* '''admin''|v_admin|u\.role')
    into v_role_leak
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public'
    and pr.proname in (
      'record_customer_review_test_card_whatsapp_opened',
      'confirm_customer_review_test_card_sent',
      'begin_customer_review_test_screenshot_removal',
      'transition_customer_review_test_card',
      'book_customer_review_test_card');
  if v_role_leak then
    raise exception 'a tester-action function still consults a role';
  end if;
  raise notice 'PASS  5A-e. no tester-action function reads a role at all';
end $$;

-- The confirmation half of the same rule, run through each person's own RLS
-- because confirm_...() reads auth.uid() rather than taking an actor.
--
-- SEPARATE FROM THE BLOCK ABOVE ON PURPOSE: it is a separate function with its
-- own copy of the ownership check, and a correction applied to one and
-- forgotten in the other is exactly the defect worth catching. Every case here
-- is a REFUSAL, so section 6 still gets to prove that the holder's own
-- confirmation is what unblocks submission.

do $$
begin
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000001',
    $q$select public.confirm_customer_review_test_card_sent('aaaaaaaa-0000-4000-8000-000000000001')$q$,
    '42501',
    '5A-f. an ADMIN confirming a send they did not make');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    $q$select public.confirm_customer_review_test_card_sent('aaaaaaaa-0000-4000-8000-000000000001')$q$,
    '42501',
    '5A-g. a VERIFIER confirming somebody else''s send');

  -- ...and the same two on the submission itself. An admin cannot hand over a
  -- test they did not run, whatever else is true of the card.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000001',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted')$q$,
    '42501',
    '5A-h. an ADMIN submitting a card they do not hold');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted')$q$,
    '42501',
    '5A-i. a VERIFIER submitting somebody else''s card');
end $$;

-- ─── 6. Confirming, and submitting ─────────────────────────────────────────

do $$
declare v_confirmed timestamptz; v_status text;
begin
  -- SUBMITTING BEFORE CONFIRMING IS REFUSED. The tester has not yet said they
  -- sent anything, and opening WhatsApp did not say it for them.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted')$q$,
    '23514',
    '6a. submitting before the tester confirmed they sent it');

  -- A COLLEAGUE CANNOT CONFIRM SOMEBODY ELSE'S TEST.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000003',
    $q$select public.confirm_customer_review_test_card_sent('aaaaaaaa-0000-4000-8000-000000000001')$q$,
    '42501',
    '6b. confirming a card somebody else holds');

  -- The holder confirms. A SEPARATE, DELIBERATE ACT.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.confirm_customer_review_test_card_sent('aaaaaaaa-0000-4000-8000-000000000001');
  reset role;

  select sent_confirmed_at, status into v_confirmed, v_status
  from public.customer_review_test_cards where id = 'aaaaaaaa-0000-4000-8000-000000000001';

  if v_confirmed is null then raise exception 'the confirmation was not recorded'; end if;
  if v_status <> 'booked' then
    raise exception 'confirming moved the status to %, and it must move nothing', v_status;
  end if;
  raise notice 'PASS  6c. the holder''s confirmation is recorded, and it moves no status either';

  -- STILL NOT SUBMITTABLE: there is no screenshot.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted')$q$,
    '23514',
    '6d. submitting with no screenshot attached');
end $$;

-- ─── 7. The screenshot: only the server may register one ───────────────────

do $$
declare v_n integer;
begin
  -- No INSERT policy and no INSERT privilege, on either side of the pair.
  select count(*) into v_n from pg_policies
  where schemaname = 'public' and tablename = 'customer_review_test_card_screenshots' and cmd = 'INSERT';
  if v_n <> 0 then raise exception 'the screenshot table has an INSERT policy'; end if;

  select count(*) into v_n from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'customer_review_test%' and cmd in ('INSERT', 'DELETE');
  if v_n <> 0 then raise exception 'the bucket has a client INSERT or DELETE policy'; end if;

  select count(*) into v_n from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname like 'customer_review_test%';
  if v_n <> 1 then raise exception 'the bucket has % client polic(ies); expected exactly one, for SELECT', v_n; end if;

  if not exists (select 1 from storage.buckets
                 where id = 'customer-review-test-screenshots' and public = false) then
    raise exception 'the screenshot bucket is missing or public';
  end if;
  raise notice 'PASS  7a. the bucket is private, SELECT-only, and no client can register an image';

  -- A browser attempting the insert directly.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_test_card_screenshots
         (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
       values ('aaaaaaaa-0000-4000-8000-000000000001', 'test_screenshot',
               'aaaaaaaa-0000-4000-8000-000000000001/test_screenshot/x.png', 'x.png',
               'image/png', 10,
               '0000000000000000000000000000000000000000000000000000000000000000',
               'ffffffff-0000-4000-8000-000000000002')$q$,
    '42501',
    '7b. a browser registering its own screenshot row');
end $$;

-- The server registers one, the way the route does.
do $$
declare v_n integer;
begin
  insert into public.customer_review_test_card_screenshots
    (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'test_screenshot',
          'aaaaaaaa-0000-4000-8000-000000000001/test_screenshot/proof.png', 'proof.png',
          'image/png', 2048,
          '1111111111111111111111111111111111111111111111111111111111111111',
          'ffffffff-0000-4000-8000-000000000002');

  -- The object row too, so the storage policy has something to decide about.
  insert into storage.objects (bucket_id, name, owner)
  values ('customer-review-test-screenshots',
          'aaaaaaaa-0000-4000-8000-000000000001/test_screenshot/proof.png', null);

  v_n := pg_temp.screenshots_visible_to('ffffffff-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 1 then raise exception 'the tester cannot see their own screenshot (saw %)', v_n; end if;

  v_n := pg_temp.screenshots_visible_to('ffffffff-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 0 then raise exception 'a colleague can see somebody else''s screenshot (saw %)', v_n; end if;

  v_n := pg_temp.screenshots_visible_to('ffffffff-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 1 then raise exception 'a verifier cannot see the screenshot they must check (saw %)', v_n; end if;

  v_n := pg_temp.objects_visible_to('ffffffff-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 0 then raise exception 'a colleague can see the private object (saw %)', v_n; end if;

  v_n := pg_temp.objects_visible_to('ffffffff-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001');
  if v_n <> 1 then raise exception 'a verifier cannot see the private object (saw %)', v_n; end if;

  raise notice 'PASS  7c. screenshot metadata and the private object follow exactly who may read the card';
end $$;

-- ─── 7A. ONE LIVE SCREENSHOT PER CARD, ENFORCED BY THE DATABASE ────────────
--
-- Item 2 of the review. MAX_TEST_SCREENSHOTS = 1 was a count read in the route
-- and then an insert — two concurrent uploads with different content both read
-- zero and both succeeded. A source-code check could not have caught that,
-- because the route's source was correct for each request taken alone.
--
-- Section 7 already registered ONE live screenshot on card ...0001. Everything
-- below is about what happens to the second.
--
-- THE TRULY CONCURRENT CASE — two sessions inserting at the same instant — is
-- not expressible in one psql session, so it is run as two parallel processes
-- by run_customer_review_outreach_local.sh. What this block proves is the
-- invariant that makes the concurrent case safe: the index exists, it is
-- partial in the specific way that matters, and it refuses the second row.

do $$
declare v_n integer; v_pred text;
begin
  -- 7A-a. THE INDEXES EXIST AND ARE PARTIAL. Read from the catalogue rather
  -- than from the migration text, so this says what the database actually has.
  select count(*) into v_n
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'customer_review_test_card_screenshots'
    and indexname = 'customer_review_screenshot_one_live_per_card';
  if v_n <> 1 then raise exception 'the one-live-per-card index does not exist'; end if;

  select indexdef into v_pred from pg_indexes
  where indexname = 'customer_review_screenshot_one_live_per_card';
  if v_pred !~ 'UNIQUE' then
    raise exception 'the one-live-per-card index is not unique: %', v_pred;
  end if;
  if v_pred !~ 'removal_started_at IS NULL' then
    raise exception 'the one-live-per-card index is not partial: %', v_pred;
  end if;
  raise notice 'PASS  7A-a. one live screenshot per card is a unique PARTIAL index';

  select indexdef into v_pred from pg_indexes
  where indexname = 'customer_review_screenshot_unique_live_content';
  if v_pred is null then raise exception 'the unique-live-content index does not exist'; end if;
  if v_pred !~ 'removal_started_at IS NULL' then
    raise exception 'the unique-live-content index is not partial: %', v_pred;
  end if;
  raise notice 'PASS  7A-b. live content uniqueness is a partial index too';

  -- 7A-c. THE OLD TOTAL CONSTRAINT IS GONE. It counted rows already marked for
  -- removal, which is what made a failed object deletion permanent.
  if exists (
    select 1 from pg_constraint
    where conname = 'customer_review_screenshot_unique_content_per_card'
  ) then
    raise exception 'the non-partial content constraint is still there';
  end if;
  raise notice 'PASS  7A-c. the non-partial uniqueness constraint is gone';

  -- 7A-d. NO UNQUALIFIED UNIQUENESS ANYWHERE ON THIS TABLE except the storage
  -- path, which is unique across ALL rows on purpose: an object key is a fact
  -- about the bucket and stays taken until the object is actually deleted.
  for v_pred in
    select indexdef from pg_indexes
    where schemaname = 'public'
      and tablename = 'customer_review_test_card_screenshots'
      and indexdef ~ 'UNIQUE'
      and indexdef !~ 'removal_started_at IS NULL'
  loop
    if v_pred !~ 'storage_path' and v_pred !~ '\(id\)' then
      raise exception 'a non-partial unique index can block a retry: %', v_pred;
    end if;
  end loop;
  raise notice 'PASS  7A-d. every uniqueness rule but the object key excludes rows being removed';
end $$;

-- A SECOND LIVE SCREENSHOT IS REFUSED — with DIFFERENT content, which is the
-- case the route's count could not stop.
do $$
begin
  begin
    insert into public.customer_review_test_card_screenshots
      (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
    values ('aaaaaaaa-0000-4000-8000-000000000001', 'test_screenshot',
            'aaaaaaaa-0000-4000-8000-000000000001/test_screenshot/second.png', 'second.png',
            'image/png', 2048,
            '2222222222222222222222222222222222222222222222222222222222222222',
            'ffffffff-0000-4000-8000-000000000002');
    raise exception 'A SECOND LIVE SCREENSHOT WAS ACCEPTED — the route count is the only guard';
  exception when sqlstate '23505' then
    raise notice 'PASS  7A-e. a second live screenshot with DIFFERENT content is refused 23505';
  end;

  -- And the same bytes twice, which the route also refuses but for its own
  -- reasons; both paths end in the database.
  begin
    insert into public.customer_review_test_card_screenshots
      (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
    values ('aaaaaaaa-0000-4000-8000-000000000001', 'test_screenshot',
            'aaaaaaaa-0000-4000-8000-000000000001/test_screenshot/again.png', 'again.png',
            'image/png', 2048,
            '1111111111111111111111111111111111111111111111111111111111111111',
            'ffffffff-0000-4000-8000-000000000002');
    raise exception 'the same bytes were registered twice on one card';
  exception when sqlstate '23505' then
    raise notice 'PASS  7A-f. the same content twice on one card is refused 23505';
  end;
end $$;

-- REMOVAL AND RE-UPLOAD ARE CONSISTENT — the half of item 2 that is about not
-- painting a card into a corner.
--
-- The sequence below is the exact failure the old constraint produced: mark for
-- removal, then have the object deletion fail (so `finish` never runs and the
-- row stays), then retry with THE SAME FILE. Under `unique (card_id,
-- content_sha256)` the retry was refused forever. Under the partial index the
-- marked row is out of the way and the retry succeeds.
do $$
declare v_id uuid; v_live integer;
begin
  select id into v_id from public.customer_review_test_card_screenshots
   where card_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     and removal_started_at is null;
  if v_id is null then raise exception 'no live screenshot to remove'; end if;

  -- The tester withdraws it. Only the marking half runs — exactly the state a
  -- failed object deletion leaves behind.
  perform public.begin_customer_review_test_screenshot_removal(
    v_id, 'ffffffff-0000-4000-8000-000000000002');

  select count(*) into v_live from public.customer_review_test_card_screenshots
   where card_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     and removal_started_at is null;
  if v_live <> 0 then raise exception 'the marked row still counts as live'; end if;
  raise notice 'PASS  7A-g. a row marked for removal is no longer live, even before it is deleted';

  -- THE SAME FILE AGAIN. This is the assertion the old constraint failed.
  insert into public.customer_review_test_card_screenshots
    (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'test_screenshot',
          'aaaaaaaa-0000-4000-8000-000000000001/test_screenshot/retry.png', 'retry.png',
          'image/png', 2048,
          '1111111111111111111111111111111111111111111111111111111111111111',
          'ffffffff-0000-4000-8000-000000000002');
  raise notice 'PASS  7A-h. the SAME file can be re-uploaded after a removal that never finished';

  -- ...and the card is back to exactly one live screenshot, so the slot was
  -- released rather than duplicated.
  select count(*) into v_live from public.customer_review_test_card_screenshots
   where card_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     and removal_started_at is null;
  if v_live <> 1 then raise exception 'the card now has % live screenshots, expected 1', v_live; end if;
  raise notice 'PASS  7A-i. the card holds exactly one live screenshot again';
end $$;

-- ─── 8. Submitting, verifying, returning ───────────────────────────────────

do $$
-- v_reason is TEXT and separate from v_by. Reusing the uuid variable for
-- return_reason is exactly the kind of mistake this file exists to catch in the
-- module, so it should not survive in the file itself.
declare v_status text; v_by uuid; v_reason text;
begin
  -- A COLLEAGUE CANNOT SUBMIT SOMEBODY ELSE'S CARD.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000003',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted')$q$,
    '42501',
    '8a. submitting a card somebody else holds');

  -- The holder submits.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted');
  reset role;

  select status, submitted_by into v_status, v_by
  from public.customer_review_test_cards where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  if v_status <> 'submitted' then raise exception 'the card is %, expected submitted', v_status; end if;
  if v_by <> 'ffffffff-0000-4000-8000-000000000002' then raise exception 'submitted_by is wrong'; end if;
  raise notice 'PASS  8b. the holder submits, with both prerequisites met';

  -- A TESTER CANNOT VERIFY THEIR OWN TEST.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'verified')$q$,
    '42501',
    '8c. the tester verifying their own test');

  -- Nor can a colleague who merely holds `use`.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000003',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'verified')$q$,
    '42501',
    '8d. a `use` holder verifying somebody else''s test');

  -- A RETURN WITH NO REASON IS REFUSED, even from a verifier.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'booked')$q$,
    '23514',
    '8e. returning a test with no reason');

  -- The verifier returns it, with a reason.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000004', 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.transition_customer_review_test_card(
    'aaaaaaaa-0000-4000-8000-000000000001', 'booked', 'The screenshot is unreadable.');
  reset role;

  select status, return_reason into v_status, v_reason
  from public.customer_review_test_cards where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  if v_status <> 'booked' then raise exception 'a returned card is %, expected booked', v_status; end if;
  if v_reason is null then raise exception 'a returned card carries no reason for the tester to act on'; end if;
  raise notice 'PASS  8f. a verifier returns a test to its tester, with a reason, and no fifth status exists';

  -- The tester re-submits, and this time it is verified.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'submitted');
  reset role;

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000004', 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.transition_customer_review_test_card(
    'aaaaaaaa-0000-4000-8000-000000000001', 'verified', 'Workflow exercised correctly.');
  reset role;

  select status, verified_by into v_status, v_by
  from public.customer_review_test_cards where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  if v_status <> 'verified' then raise exception 'the card is %, expected verified', v_status; end if;
  if v_by <> 'ffffffff-0000-4000-8000-000000000004' then raise exception 'verified_by is wrong'; end if;
  raise notice 'PASS  8g. a verifier verifies it, and is recorded as having done so';

  -- VERIFIED IS TERMINAL.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    $q$select public.transition_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000001', 'booked', 'again')$q$,
    '23514',
    '8h. moving a verified card');
end $$;

-- ─── 9. A verified card leaves EVERY list, and the record stays ────────────
--
-- The requirement changed: a verified card used to be shown in a verifier-only
-- History tab, and the product owner's final rule is that it appears in no
-- frontend list at all. The History tab is gone.
--
-- WHAT THAT CHANGED HERE, AND WHAT IT DID NOT.
--
-- It did not change the DATABASE. No policy was narrowed, no row is deleted,
-- and a verifier can still SELECT a verified card — 9c below reads one on
-- purpose, to prove the record and its trail survive. The removal is in the
-- frontend: no tab's status list contains 'verified', so no query the module
-- issues asks for one, and the detail screen declines to render one.
--
-- So the three counts below are asked with the queries the screens actually
-- issue, and the verified card is expected to be outside all of them while
-- still being READABLE to a direct query. Those are different questions and
-- this section now asks both.

do $$
declare v_active integer; v_queue integer; v_history integer; v_pool integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  -- "My booked tests": the tester's own booked and submitted cards.
  select count(*) into v_active
  from public.customer_review_test_cards
  where booked_by = 'ffffffff-0000-4000-8000-000000000002'
    and status in ('booked', 'submitted');
  -- "Available": the unbooked pool.
  select count(*) into v_pool
  from public.customer_review_test_cards
  where status = 'available' and id::text like 'aaaaaaaa-0000-4000-8000-%';
  reset role;

  if v_active <> 0 then
    raise exception 'the verified card is still in the tester''s active list (% row(s))', v_active;
  end if;
  if v_pool <> 3 then
    raise exception 'the available pool holds % card(s), expected the 3 that were never booked', v_pool;
  end if;
  raise notice 'PASS  9a. a verified card is gone from My tests and does not return to Available';

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000004', 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into v_queue
  from public.customer_review_test_cards
  where status = 'submitted' and id::text like 'aaaaaaaa-0000-4000-8000-%';
  select count(*) into v_history
  from public.customer_review_test_cards
  where status = 'verified' and id::text like 'aaaaaaaa-0000-4000-8000-%';
  reset role;

  if v_queue <> 0 then
    raise exception 'the verification queue still holds % card(s)', v_queue;
  end if;

  -- THE RECORD IS STILL THERE, and this is the assertion that says "retained in
  -- the database" is a fact rather than an intention. v_history is a direct
  -- query for status = 'verified' as the VERIFIER, so it proves both that the
  -- row survived verification and that RLS still lets a verifier read it.
  --
  -- No screen issues this query any more. That is the point: the frontend
  -- stopped asking, the database did not stop answering.
  if v_history <> 1 then
    raise exception 'the verified record is gone from the database (% row(s), expected 1)', v_history;
  end if;
  raise notice 'PASS  9b. the queue is empty, and the verified record is still in the database';

  -- AND THE CARD ITSELF IS OUTSIDE EVERY QUERY THE FRONTEND CAN ISSUE. Asked
  -- by ID against the union of the three tabs' status sets, so this is about
  -- the row that was actually verified rather than about the word 'verified'.
  select count(*) into v_history
  from public.customer_review_test_cards
  where id = 'aaaaaaaa-0000-4000-8000-000000000001'
    and status in ('available', 'booked', 'submitted');
  if v_history <> 0 then
    raise exception 'the verified card is still reachable through a frontend status set';
  end if;
  raise notice 'PASS  9b2. the verified card matches none of the three tab status sets';

  -- The trail survived every move, and the tester can still read it.
  if pg_temp.events_visible_to('ffffffff-0000-4000-8000-000000000002',
                               'aaaaaaaa-0000-4000-8000-000000000001') < 6 then
    raise exception 'the append-only trail is shorter than the number of things that happened';
  end if;
  raise notice 'PASS  9c. the append-only trail records every step and is readable by both parties';
end $$;

-- ─── 9A. A REVOKED ADMINISTRATOR IS GENUINELY REVOKED ──────────────────────
--
-- Every visibility predicate used to carry `u.role = 'admin'` as a disjunct,
-- and in two of the three it came FIRST — so it short-circuited and an
-- administrator was admitted before the engine was asked anything at all. An
-- explicit revocation in Control Center was therefore not merely cosmetic; it
-- was unenforced at the database.
--
-- These assertions are run through each person's OWN RLS, because the claim is
-- about what a browser session can actually read. Fixture Admin (...0001) is a
-- real `role = 'admin'` row throughout; what changes between blocks is only
-- their employee_permission_overrides.
--
-- THE ORDINARY ADMINISTRATOR IS CHECKED FIRST. Every other case here takes
-- something away, and if the first one ever fails the correction has overshot.

do $$
declare v_module uuid; v_use uuid; v_verify uuid; v_n integer;
begin
  select id into v_module from public.permission_modules where module_key = 'customer_review_requests';
  select a.id into v_use    from public.permission_actions a where a.action_key = 'use';
  select a.id into v_verify from public.permission_actions a where a.action_key = 'verify';

  -- ── 9A-a. THE SEED IS WHAT GIVES AN ADMIN ACCESS, and it still does. ──────
  -- The whole argument for deleting the shortcuts rests on this being true.
  if not public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                                   'customer_review_requests', 'use') then
    raise exception 'the role seed no longer grants an administrator use';
  end if;
  if not public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                                   'customer_review_requests', 'verify') then
    raise exception 'the role seed no longer grants an administrator verify';
  end if;
  raise notice 'PASS  9A-a. an ordinary administrator still resolves both actions from the seed';

  -- ── 9A-b. AND THEY STILL SEE WHAT THEY SHOULD. ───────────────────────────
  -- Section 4e already proved an admin can read a booked card; this is the
  -- entry predicate, which is the one the module gate calls.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000001', 'role', 'authenticated')::text);
  set local role authenticated;
  if not public.can_use_customer_review_test_cards() then
    raise exception 'an ordinary administrator can no longer enter the module';
  end if;
  reset role;
  raise notice 'PASS  9A-b. an ordinary administrator still passes the entry predicate';

  -- ── 9A-c. REVOKE `use` ONLY. ─────────────────────────────────────────────
  -- An employee override is the highest level in the engine, so this is how a
  -- single administrator is revoked in Control Center.
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values ('ffffffff-0000-4000-8000-000000000001', v_module, v_use, false,
          'ffffffff-0000-4000-8000-000000000001');

  if public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                               'customer_review_requests', 'use') then
    raise exception 'the override did not revoke use; the rest of this block proves nothing';
  end if;

  -- They keep `verify`, so they still enter and still read everything a
  -- verifier reads. One authority was revoked, not the module.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000001', 'role', 'authenticated')::text);
  set local role authenticated;
  if not public.can_use_customer_review_test_cards() then
    raise exception 'revoking use also closed the module to a verifier';
  end if;
  if not public.can_view_customer_review_test_card_row('ffffffff-0000-4000-8000-000000000002') then
    raise exception 'a verifier can no longer read a tester''s row';
  end if;
  reset role;
  raise notice 'PASS  9A-c. revoking `use` leaves verifier reading intact';

  -- ...and the TESTER ACTIONS are refused, by the definer functions that
  -- resolve `use` — the same refusal any non-holder gets.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000001',
    $q$select public.book_customer_review_test_card(
      (select id from public.customer_review_test_cards
        where status = 'available' and id::text like 'aaaaaaaa-0000-4000-8000-%' limit 1))$q$,
    '42501',
    '9A-d. an admin with `use` revoked booking a card');

  -- ── 9A-e. REVOKE `verify` AS WELL. ──────────────────────────────────────
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values ('ffffffff-0000-4000-8000-000000000001', v_module, v_verify, false,
          'ffffffff-0000-4000-8000-000000000001');

  if public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                               'customer_review_requests', 'verify') then
    raise exception 'the override did not revoke verify';
  end if;

  -- NOW THE MODULE IS CLOSED. This is the assertion the old `u.role = 'admin'`
  -- disjunct made impossible: with both permissions revoked there is no branch
  -- left to match, in any of the three predicates.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000001', 'role', 'authenticated')::text);
  set local role authenticated;

  if public.can_use_customer_review_test_cards() then
    raise exception 'AN ADMIN WITH BOTH PERMISSIONS REVOKED STILL ENTERS THE MODULE';
  end if;

  if public.can_view_customer_review_test_card_row('ffffffff-0000-4000-8000-000000000002') then
    raise exception 'A FULLY REVOKED ADMIN STILL READS SOMEBODY ELSE''S ROW';
  end if;

  -- And no rows come back through RLS, which is what the predicates are for.
  select count(*) into v_n from public.customer_review_test_cards
   where id::text like 'aaaaaaaa-0000-4000-8000-%';
  reset role;
  if v_n <> 0 then
    raise exception 'a fully revoked admin reads % card(s) through RLS', v_n;
  end if;
  raise notice 'PASS  9A-e. an admin with BOTH revoked enters nothing and reads nothing';

  -- ── 9A-f. AND THE VERIFIER MOVES ARE REFUSED TOO. ───────────────────────
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000001',
    $q$select public.transition_customer_review_test_card(
      'aaaaaaaa-0000-4000-8000-000000000002', 'verified', 'x')$q$,
    '42501',
    '9A-f. a fully revoked admin verifying a card');

  -- ── RESTORE. Later sections and the fixture step assume an ordinary admin,
  -- and a harness that leaves a revoked one behind would fail them for a
  -- reason that has nothing to do with what they test.
  delete from public.employee_permission_overrides
   where user_id = 'ffffffff-0000-4000-8000-000000000001'
     and module_id = v_module
     and action_id in (v_use, v_verify);

  if not public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                                   'customer_review_requests', 'use')
     or not public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                                      'customer_review_requests', 'verify') then
    raise exception 'the harness failed to restore the administrator';
  end if;
  raise notice 'PASS  9A-g. the administrator is restored to the seed defaults';
end $$;

-- ─── 10. A browser cannot ask a permission question ON SOMEBODY ELSE ───────
--
-- Every predicate here is granted to authenticated, so its arguments are chosen
-- by a browser. While one took an acting-user id, a signed-in employee could
-- pass a colleague's uuid and read back who is active, who is an admin and who
-- holds verify — one call at a time, from the browser console. The parameter is
-- gone; these check that it stayed gone, structurally and behaviourally.

do $$
declare v_n integer; v_bad text;
begin
  select count(*) into v_n
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public'
    and f.proname like '%customer_review%'
    and has_function_privilege('authenticated', f.oid, 'EXECUTE')
    and pg_get_function_arguments(f.oid) ~* '(p_user_id|p_actor_id|p_acting)';
  if v_n <> 0 then
    raise exception '% browser-callable function(s) still accept an acting-user id', v_n;
  end if;
  raise notice 'PASS  10a. no authenticated-callable function takes an acting-user id';

  -- THE EXACT ALLOW-LIST, asked of the database. The name heuristic above is a
  -- message; this is the control.
  select string_agg(sig, ', ' order by sig) into v_bad
  from (
    select f.proname || '(' || pg_get_function_arguments(f.oid) || ')' as sig
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public'
      and f.proname like '%customer_review%'
      and has_function_privilege('authenticated', f.oid, 'EXECUTE')
  ) t
  where sig not in (
    'customer_review_internal_test_warning()',
    'can_use_customer_review_test_cards()',
    'can_view_customer_review_test_card(p_card_id uuid)',
    'can_view_customer_review_test_card_row(p_booked_by uuid)',
    'book_customer_review_test_card(p_card_id uuid)',
    'confirm_customer_review_test_card_sent(p_card_id uuid)',
    'transition_customer_review_test_card(p_card_id uuid, p_next_status text, p_detail text DEFAULT NULL::text)'
  );
  if v_bad is not null then
    raise exception 'off the approved browser-callable list: %', v_bad;
  end if;
  raise notice 'PASS  10b. exactly the approved signatures are executable by authenticated';
end $$;

-- ...and behaviourally: the colleague probe does not work.
do $$
declare v_holder_sees boolean; v_probe boolean;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000003', 'role', 'authenticated')::text);
  set local role authenticated;

  -- Fixture Colleague holds `use` and holds no card. Asking about a card held
  -- by the tester must answer for the COLLEAGUE, not the tester.
  v_probe := public.can_view_customer_review_test_card_row('ffffffff-0000-4000-8000-000000000002');
  reset role;

  if v_probe then
    raise exception 'a colleague evaluated the tester''s visibility as true — the predicate answered for the wrong person';
  end if;
  raise notice 'PASS  10c. passing another employee''s uuid answers for the CALLER, not for them';

  -- And the same call, made by the tester, is true — so the false above is a
  -- real refusal rather than the function being broken.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  v_holder_sees := public.can_view_customer_review_test_card_row('ffffffff-0000-4000-8000-000000000002');
  reset role;
  if not v_holder_sees then
    raise exception 'the tester cannot see their own rows through the predicate';
  end if;
  raise notice 'PASS  10d. the tester still evaluates true for their own rows';
end $$;

-- ─── 11. It all survives public.users being tightened ──────────────────────
--
-- THE POINT OF THE WHOLE DEFINER ARRANGEMENT, demonstrated rather than argued.
--
-- The baseline gives public.users the row security and column grants it has in
-- production. Those happen to be compatible with reading users as the caller,
-- which is why an inline policy passed every earlier test. This asks the
-- question that matters instead: what happens when they are NOT compatible?
--
-- EVERYTHING IS UNDONE IN THE EXCEPTION HANDLER AS WELL AS ON SUCCESS. This
-- block deliberately breaks a policy and a grant to see what depends on them;
-- an assertion failing in the middle must not leave the database that way.

do $$
declare v_card uuid := 'aaaaaaaa-0000-4000-8000-000000000002'; v_seen integer; v_err text;
begin
  begin
    drop policy "Users can read all active users" on public.users;
    revoke select on public.users from authenticated;

    -- The shipped policy delegates to SECURITY DEFINER predicates, so it reads
    -- users with the definer's rights and is unaffected.
    v_seen := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000002');
    if v_seen <> 3 then
      raise exception 'with users locked down, the tester lost sight of the available pool (saw %)', v_seen;
    end if;
    raise notice 'PASS  11a. users fully locked down, and the pool is still visible';

    -- ...and booking still works, and is still refused for the right people.
    execute format('set local request.jwt.claims = %L',
                   json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
    set local role authenticated;
    perform public.book_customer_review_test_card(v_card);
    reset role;

    if (select status from public.customer_review_test_cards where id = v_card) <> 'booked' then
      raise exception 'booking failed with users unreadable';
    end if;
    raise notice 'PASS  11b. an authorized booking succeeds with users unreadable';

    perform pg_temp.refused_with(
      'ffffffff-0000-4000-8000-000000000005',
      $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000003')$q$,
      '42501',
      '11c. an unauthorized booking, users unreadable');

    perform pg_temp.refused_with(
      'ffffffff-0000-4000-8000-000000000006',
      $q$select public.book_customer_review_test_card('aaaaaaaa-0000-4000-8000-000000000003')$q$,
      '42501',
      '11d. a deactivated admin booking, users unreadable');

  exception when others then
    v_err := sqlerrm;
    begin reset role; exception when others then null; end;
    -- Put everything back before re-raising, whatever went wrong above.
    execute $r$grant select (id, full_name, email, phone, role, team, position, is_active,
                  created_at, updated_at, employee_code, joining_date, office_timing,
                  fingerprint_employee_code, payroll_active, employment_type,
                  is_deleted, deleted_at, deleted_by, deletion_scheduled_at)
      on public.users to authenticated$r$;
    execute $r$drop policy if exists "Users can read all active users" on public.users$r$;
    execute $r$create policy "Users can read all active users" on public.users
              for select to authenticated using (is_active = true)$r$;
    raise exception 'while users were locked down: %', v_err;
  end;

  -- Restore on the success path too.
  grant select (id, full_name, email, phone, role, team, position, is_active,
                created_at, updated_at, employee_code, joining_date, office_timing,
                fingerprint_employee_code, payroll_active, employment_type,
                is_deleted, deleted_at, deleted_by, deletion_scheduled_at)
    on public.users to authenticated;
  create policy "Users can read all active users" on public.users
    for select to authenticated using (is_active = true);

  v_seen := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000002');
  if v_seen <> 2 then
    raise exception 'restoring users did not restore the pool (saw %, expected 2)', v_seen;
  end if;
  raise notice 'PASS  11e. users restored, and everything reads as it did before';
end $$;

-- ─── 13. GENERATION: WHO MAY, WHEN, AND WHAT LANDS ─────────────────────────
--
-- Everything below is about create_customer_review_draft_batch, which is the
-- only way a generated card reaches the table. The route validates and the
-- screen hides the button, but neither of those is a rule — this is.
--
-- FIVE CLAIMS:
--   a. it is refused while ANY card is still available
--   b. a booked or submitted card does not block it
--   c. exactly twenty, or nothing at all
--   d. repeating the same call cannot produce a second batch
--   e. the caller must resolve `verify`, and an administrator is no exception
--
-- The sixth claim — that two verifiers racing produce ONE batch — needs two
-- connections and committed rows, which cannot happen inside this file. It is
-- proved by supabase/tests/run_customer_review_draft_batch_race.sh.
--
-- THE POOL IS GLOBAL, so this section has to own it for the length of the
-- section: it parks every card that is currently available, does its work, and
-- puts them back at 13j. Nothing here touches a booked, submitted or verified
-- card, and 13j asserts the parked set came back whole.

-- A payload builder, so twenty valid drafts are not twenty lines of literal.
create or replace function pg_temp.batch_payload(p_n integer, p_tag text default 'probe')
returns jsonb language sql as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'title',    'Draft ' || i || ' ' || p_tag,
    'category', 'restaurant_test',
    'body',     'We ordered seating for a small dining room and the fit was right '
                || 'first time. This is draft ' || i || ' of the ' || p_tag || ' batch, '
                || 'written long enough to clear the minimum body length.'
  )), '[]'::jsonb)
  from generate_series(1, greatest(p_n, 0)) i;
$fn$;

-- Calling it and reporting only the SQLSTATE, so a refusal is an assertion
-- rather than an abort.
create or replace function pg_temp.try_batch(
  p_actor uuid, p_payload jsonb, p_guidance text default 'Hospitality furniture reviews.')
returns text language plpgsql as $fn$
begin
  perform public.create_customer_review_draft_batch(
    p_guidance, 'claude-opus-5', p_payload, p_actor);
  return 'OK';
exception when others then
  return sqlstate || ':' || left(sqlerrm, 70);
end $fn$;

-- ── 13a. The pool is not empty, so nobody may generate — not even a verifier
do $$
declare v_available integer; v_r text; v_batches integer;
begin
  select count(*) into v_available
    from public.customer_review_test_cards where status = 'available';
  if v_available = 0 then
    raise exception '13a needs at least one available card to be a test; found none';
  end if;

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', pg_temp.batch_payload(20));
  if v_r not like '23514:%' or v_r not like '%POOL_NOT_EMPTY%' then
    raise exception 'a verifier generated while % card(s) were available: %', v_available, v_r;
  end if;

  select count(*) into v_batches from public.customer_review_draft_batches;
  if v_batches <> 0 then
    raise exception 'a refused call still wrote % batch row(s)', v_batches;
  end if;
  raise notice 'PASS  13a. refused while % card(s) were still available, and wrote nothing', v_available;
end $$;

-- ── Park the pool, so the remaining claims can be tested at all ────────────
create temporary table parked_cards as
  select id from public.customer_review_test_cards where status = 'available';

do $$
declare v_n integer;
begin
  update public.customer_review_test_cards
     set status = 'booked',
         booked_by = 'ffffffff-0000-4000-8000-000000000002',
         booked_at = now()
   where id in (select id from parked_cards);
  get diagnostics v_n = row_count;
  raise notice '      (parked % available card(s) as booked; restored at 13j)', v_n;
end $$;

-- ── 13b. A BOOKED CARD DOES NOT BLOCK THE NEXT BATCH ───────────────────────
do $$
declare v_r text; v_busy integer;
begin
  select count(*) into v_busy
    from public.customer_review_test_cards where status <> 'available';
  if v_busy = 0 then
    raise exception '13b needs at least one non-available card';
  end if;

  -- The pool is empty and everything else is somebody's work in progress. That
  -- is precisely the state in which the next batch is allowed.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', pg_temp.batch_payload(20), 'First batch.');
  if v_r <> 'OK' then
    raise exception '% non-available card(s) blocked generation: %', v_busy, v_r;
  end if;
  raise notice 'PASS  13b. % booked/submitted/verified card(s) did NOT block the batch', v_busy;
end $$;

-- ── 13c. Exactly twenty landed, all available, all in one batch ────────────
do $$
declare v_cards integer; v_batches integer; v_bad integer;
        v_guidance text; v_model text; v_count integer; v_refs integer;
begin
  select count(*) into v_batches from public.customer_review_draft_batches;
  if v_batches <> 1 then raise exception 'expected 1 batch row, found %', v_batches; end if;

  select guidance, model, card_count into v_guidance, v_model, v_count
    from public.customer_review_draft_batches;
  if v_guidance <> 'First batch.' then raise exception 'the batch stored guidance %', v_guidance; end if;
  if v_model <> 'claude-opus-5' then raise exception 'the batch stored model %', v_model; end if;
  if v_count <> 20 then raise exception 'the batch claims % cards', v_count; end if;

  select count(*) into v_cards from public.customer_review_test_cards
   where batch_id = (select id from public.customer_review_draft_batches);
  if v_cards <> 20 then raise exception 'the batch inserted % cards, expected 20', v_cards; end if;

  select count(*) into v_bad from public.customer_review_test_cards
   where batch_id is not null
     and (status <> 'available' or booked_by is not null or card_ref !~ '^RW-[0-9]{6}$');
  if v_bad > 0 then raise exception '% generated card(s) did not land clean', v_bad; end if;

  select count(distinct card_ref) into v_refs
    from public.customer_review_test_cards where batch_id is not null;
  if v_refs <> 20 then raise exception 'the batch produced % distinct references', v_refs; end if;

  raise notice 'PASS  13c. exactly 20 available cards, 20 distinct RW references, one audited batch row';
end $$;

-- ── 13d. REPEATING CANNOT DUPLICATE ────────────────────────────────────────
do $$
declare v_r text; v_batches integer; v_cards integer;
begin
  -- Same caller, same guidance, same payload, straight away. The pool is now
  -- full of the batch that just landed, so the pool rule refuses it — which is
  -- also what stops a double-submitted request creating forty cards.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', pg_temp.batch_payload(20), 'First batch.');
  if v_r not like '23514:%' or v_r not like '%POOL_NOT_EMPTY%' then
    raise exception 'the same call ran twice: %', v_r;
  end if;

  select count(*) into v_batches from public.customer_review_draft_batches;
  select count(*) into v_cards from public.customer_review_test_cards where batch_id is not null;
  if v_batches <> 1 or v_cards <> 20 then
    raise exception 'the repeat left % batch(es) and % card(s)', v_batches, v_cards;
  end if;
  raise notice 'PASS  13d. the repeat was refused; still 1 batch and 20 cards';
end $$;

-- ── 13e. WHO MAY ASK ───────────────────────────────────────────────────────
do $$
declare v_r text;
begin
  update public.customer_review_test_cards
     set status = 'booked', booked_by = 'ffffffff-0000-4000-8000-000000000002', booked_at = now()
   where status = 'available';

  -- A tester holds `use`, not `verify`.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000002', pg_temp.batch_payload(20));
  if v_r not like '42501:%' then raise exception 'a tester generated a batch: %', v_r; end if;
  raise notice 'PASS  13e1. a candidate holding `use` but not `verify` is refused 42501';

  -- Nobody holds anything.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000005', pg_temp.batch_payload(20));
  if v_r not like '42501:%' then raise exception 'an unpermitted user generated a batch: %', v_r; end if;
  raise notice 'PASS  13e2. a user with no grant is refused 42501';

  -- An inactive account, even holding `verify` by override.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000007', pg_temp.batch_payload(20));
  if v_r not like '42501:%' then raise exception 'an inactive verifier generated a batch: %', v_r; end if;
  raise notice 'PASS  13e3. an INACTIVE account holding verify is refused 42501';

  -- An inactive ADMINISTRATOR. Being an administrator is not a way in.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000006', pg_temp.batch_payload(20));
  if v_r not like '42501:%' then raise exception 'an inactive administrator generated a batch: %', v_r; end if;
  raise notice 'PASS  13e4. an INACTIVE administrator is refused 42501';

  -- A user id that does not exist at all.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-0000000000ff', pg_temp.batch_payload(20));
  if v_r not like '42501:%' then raise exception 'a non-existent actor generated a batch: %', v_r; end if;
  raise notice 'PASS  13e5. an unknown actor is refused 42501';
end $$;

-- ── 13f. AN ADMINISTRATOR GETS IN THROUGH THE ENGINE, OR NOT AT ALL ────────
do $$
declare v_r text; v_resolved boolean; v_module uuid; v_verify uuid;
begin
  v_resolved := public.resolve_permission(
    'ffffffff-0000-4000-8000-000000000001', 'customer_review_requests', 'verify');

  update public.customer_review_test_cards
     set status = 'booked', booked_by = 'ffffffff-0000-4000-8000-000000000002', booked_at = now()
   where status = 'available';

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000001', pg_temp.batch_payload(20), 'Admin batch.');

  -- Whatever the seed says, the OUTCOME must match the RESOLVED permission
  -- exactly. If the administrator resolves verify they generate; if they do
  -- not, they are refused like anybody else. There is no third answer, and
  -- that is the whole claim.
  if v_resolved and v_r <> 'OK' then
    raise exception 'an administrator who RESOLVES verify was refused: %', v_r;
  end if;
  if (not v_resolved) and v_r not like '42501:%' then
    raise exception 'an administrator who does NOT resolve verify got in anyway: %', v_r;
  end if;
  raise notice 'PASS  13f1. administrator resolve_permission = %, and the function agreed (%)',
    v_resolved, case when v_r = 'OK' then 'generated' else 'refused 42501' end;

  -- Now REVOKE it, and prove the door closes for the same administrator.
  select id into v_module from public.permission_modules
   where module_key = 'customer_review_requests';
  select id into v_verify from public.permission_actions where action_key = 'verify';

  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values ('ffffffff-0000-4000-8000-000000000001', v_module, v_verify, false,
          'ffffffff-0000-4000-8000-000000000001');

  if public.resolve_permission('ffffffff-0000-4000-8000-000000000001',
                               'customer_review_requests', 'verify') then
    raise exception 'the revocation did not take';
  end if;

  update public.customer_review_test_cards
     set status = 'booked', booked_by = 'ffffffff-0000-4000-8000-000000000002', booked_at = now()
   where status = 'available';

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000001', pg_temp.batch_payload(20));
  if v_r not like '42501:%' then
    raise exception 'A REVOKED ADMINISTRATOR STILL GENERATED A BATCH: %', v_r;
  end if;
  raise notice 'PASS  13f2. THE SAME ADMINISTRATOR, verify REVOKED, IS REFUSED 42501';

  delete from public.employee_permission_overrides
   where user_id = 'ffffffff-0000-4000-8000-000000000001';
end $$;

-- ── 13g. TWENTY, OR NOTHING ────────────────────────────────────────────────
do $$
declare v_r text; v_batches integer; v_cards integer; v_payload jsonb;
begin
  update public.customer_review_test_cards
     set status = 'booked', booked_by = 'ffffffff-0000-4000-8000-000000000002', booked_at = now()
   where status = 'available';

  select count(*) into v_batches from public.customer_review_draft_batches;
  select count(*) into v_cards   from public.customer_review_test_cards;

  foreach v_payload in array array[
    pg_temp.batch_payload(0), pg_temp.batch_payload(1),
    pg_temp.batch_payload(19), pg_temp.batch_payload(21)
  ] loop
    v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', v_payload);
    if v_r not like '23514:%' or v_r not like '%BAD_BATCH%' then
      raise exception 'a payload of % drafts was accepted: %', jsonb_array_length(v_payload), v_r;
    end if;
  end loop;
  raise notice 'PASS  13g1. 0, 1, 19 and 21 drafts were each refused 23514';

  -- A partial batch: nineteen good and one the COLUMN refuses. The function
  -- does not stop this one — the CHECK does, part-way through the insert — and
  -- the whole transaction has to disappear with it.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004',
    jsonb_set(pg_temp.batch_payload(20), '{7,body}', '"short"'::jsonb));
  if v_r = 'OK' then raise exception 'a batch with an invalid body was accepted'; end if;
  raise notice 'PASS  13g2. a batch failing mid-insert was refused (%)', left(v_r, 40);

  if (select count(*) from public.customer_review_draft_batches) <> v_batches then
    raise exception 'a refused batch left a batch row behind';
  end if;
  if (select count(*) from public.customer_review_test_cards) <> v_cards then
    raise exception 'A REFUSED BATCH LEFT CARDS BEHIND: % now, % before',
      (select count(*) from public.customer_review_test_cards), v_cards;
  end if;
  raise notice 'PASS  13g3. NOT ONE ROW SURVIVED ANY REFUSED CALL (still % batch(es), % card(s))',
    v_batches, v_cards;
end $$;

-- ── 13h. NOTHING GENERATED CARRIES A WARNING, A LINK OR A NUMBER ───────────
do $$
declare v_bad integer; v_seen integer;
begin
  select count(*) into v_seen from public.customer_review_test_cards where batch_id is not null;
  if v_seen = 0 then raise exception '13h has no generated cards to inspect'; end if;

  select count(*) into v_bad from public.customer_review_test_cards
   where batch_id is not null
     and (test_body ~* '(https?://|www\.|wa\.me)'
       or test_body ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
       or test_body ~ '\+[0-9][0-9 ()-]{7,}'
       or position(public.customer_review_internal_test_warning() in upper(test_body)) > 0
       or test_body ~* '(leave a review|post this|publish this|rate us)');
  if v_bad > 0 then
    raise exception '% of % generated card(s) carry a link, contact detail or posting instruction',
      v_bad, v_seen;
  end if;
  raise notice 'PASS  13h. none of % generated card(s) carries a warning, link, address, number or posting instruction',
    v_seen;
end $$;

-- ── 13i. THE FUNCTION IS NOT REACHABLE FROM A BROWSER ──────────────────────
do $$
begin
  if has_function_privilege('authenticated',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid)', 'execute')
   or has_function_privilege('anon',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid)', 'execute') then
    raise exception 'a browser role can execute the batch function';
  end if;
  if not has_function_privilege('service_role',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid)', 'execute') then
    raise exception 'the server role cannot execute the batch function';
  end if;

  -- And no client role can write the batch table directly either.
  if has_table_privilege('authenticated', 'public.customer_review_draft_batches', 'insert')
   or has_table_privilege('authenticated', 'public.customer_review_draft_batches', 'update')
   or has_table_privilege('authenticated', 'public.customer_review_draft_batches', 'delete') then
    raise exception 'authenticated can write customer_review_draft_batches directly';
  end if;
  raise notice 'PASS  13i. service_role only, and no direct client write to the batch table';
end $$;

-- ── 13j. Put the parked cards back, and prove the parked set came back whole
do $$
declare v_generated integer; v_restored integer; v_expected integer;
begin
  select count(*) into v_generated
    from public.customer_review_test_cards where batch_id is not null;
  delete from public.customer_review_test_cards where batch_id is not null;
  delete from public.customer_review_draft_batches;

  update public.customer_review_test_cards
     set status = 'available', booked_by = null, booked_at = null
   where id in (select id from parked_cards);
  get diagnostics v_restored = row_count;

  select count(*) into v_expected from parked_cards;
  if v_restored <> v_expected then
    raise exception 'restored % of % parked cards', v_restored, v_expected;
  end if;
  if (select count(*) from public.customer_review_test_cards where status = 'available')
     <> v_expected then
    raise exception 'the available pool is % after restoring, expected %',
      (select count(*) from public.customer_review_test_cards where status = 'available'), v_expected;
  end if;
  raise notice 'PASS  13j. % generated card(s) removed, % parked card(s) restored to available',
    v_generated, v_restored;
end $$;

drop table parked_cards;

-- ─── 12. Clean up ──────────────────────────────────────────────────────────

-- storage.objects carries a BEFORE DELETE guard (storage.protect_objects_delete)
-- that refuses direct deletion: in a real deployment the object FILE would be
-- orphaned by it. This harness only ever wrote the ROW — there is no file — so
-- the guard is suspended for the length of one transaction to clear up after
-- itself. SET LOCAL, so it is scoped to the transaction and reverts on commit;
-- no product code path does this, and nothing else in this file runs with it
-- off.
begin;
  set local session_replication_role = 'replica';
  delete from storage.objects
   where bucket_id = 'customer-review-test-screenshots'
     and split_part(name, '/', 1) like 'aaaaaaaa-0000-4000-8000-%';
commit;

do $$
begin
  delete from public.customer_review_test_card_screenshots
   where card_id::text like 'aaaaaaaa-0000-4000-8000-%';
  delete from public.customer_review_test_card_events
   where card_id::text like 'aaaaaaaa-0000-4000-8000-%';
  delete from public.customer_review_test_cards
   where id::text like 'aaaaaaaa-0000-4000-8000-%';
  delete from public.employee_permission_overrides
   where user_id::text like 'ffffffff-0000-4000-8000-%';
  delete from public.users
   where id::text like 'ffffffff-0000-4000-8000-%';

  raise notice 'PASS  12. every fixture removed';
end $$;

do $$ begin raise notice '';
            raise notice 'customer_review_test_card_assertions: ALL ASSERTIONS PASSED';
end $$;
