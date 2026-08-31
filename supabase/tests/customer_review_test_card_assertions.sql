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
    'transition_customer_review_test_card(p_card_id uuid, p_next_status text, p_detail text DEFAULT NULL::text)',
    -- Added by 20261026000000. All three take their actor from auth.uid() and
    -- name no user, which is what qualifies a function for this list: there is
    -- nothing to ask for on somebody else's behalf. The two writers that DO
    -- take an actor id — the generator and the reviser — are service-role only
    -- and would fail 10a above if they ever appeared here.
    'approve_customer_review_drafts(p_card_ids uuid[])',
    'approve_customer_review_draft_batch(p_batch_id uuid)',
    'unbook_customer_review_test_card(p_card_id uuid)'
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

-- ─── 13. GENERATION: WHO MAY, AND WHAT LANDS ───────────────────────────────
--
-- Everything below is about create_customer_review_draft_batch, which is the
-- only way a generated card reaches the table. The route validates and the
-- screen hides the button, but neither of those is a rule — this is.
--
-- WHAT CHANGED IN 20261026000000, AND WHAT THIS SECTION NOW PROVES.
--
-- The old function refused unless the available pool was EMPTY, and produced
-- TWENTY cards straight into that pool. Both rules are gone, and the assertions
-- that pinned them are gone with them rather than being edited into something
-- weaker — a test that still said "refused while cards are available" would be
-- testing a rule the product no longer has.
--
-- What replaces them is stronger, and is the first claim below: a generated
-- draft does not enter the candidate pool at all. It lands in
-- `pending_approval`, where a candidate cannot read it by any route, and only a
-- verifier's approval moves it. Scarcity was never much of a safeguard;
-- a person reading the text is.
--
-- SEVEN CLAIMS:
--   a. a full pool does not block generation, and exactly eight land, pending
--   b. a candidate cannot see a pending draft — not the card, not its trail
--   c. repeating one request cannot produce a second batch; a deliberate
--      second request can
--   d. exactly eight, or nothing at all
--   e. the caller must resolve `verify`, and an administrator is no exception
--   f. nothing generated carries a warning, a link, an address or a number
--   g. the function is not reachable from a browser, and the retired 20-draft
--      version is gone rather than merely superseded
--
-- The claim that two verifiers racing produce ONE batch each needs two
-- connections and committed rows, which cannot happen inside this file. It is
-- proved by supabase/tests/run_customer_review_draft_batch_race.sh.

-- A payload builder, so eight valid drafts are not eight lines of literal.
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
-- rather than an abort. Each call mints its own request key unless one is
-- handed in, so an ordinary call is never mistaken for a repeat.
create or replace function pg_temp.try_batch(
  p_actor uuid, p_payload jsonb,
  p_guidance text default 'Hospitality furniture reviews.',
  p_key uuid default null)
returns text language plpgsql as $fn$
begin
  perform public.create_customer_review_draft_batch(
    p_guidance, 'claude-opus-5', p_payload, p_actor, coalesce(p_key, gen_random_uuid()));
  return 'OK';
exception when others then
  return sqlstate || ':' || left(sqlerrm, 90);
end $fn$;

create or replace function pg_temp.try_revise(
  p_batch uuid, p_actor uuid, p_payload jsonb,
  p_guidance text default 'Warmer, and shorter.',
  p_key uuid default null)
returns text language plpgsql as $fn$
declare v_n integer;
begin
  v_n := public.revise_customer_review_draft_batch(
    p_batch, p_guidance, 'claude-opus-5', p_payload, p_actor,
    coalesce(p_key, gen_random_uuid()));
  return 'OK:' || v_n;
exception when others then
  return sqlstate || ':' || left(sqlerrm, 90);
end $fn$;

-- Run one statement AS somebody and return its single value. The success twin
-- of refused_with(): the approval and unbook functions read auth.uid(), so
-- "a verifier approves" has to be executed by a verifier, not by the owner.
create or replace function pg_temp.as_user(p_user uuid, p_sql text)
returns text language plpgsql as $fn$
declare v text;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  execute p_sql into v;
  reset role;
  return v;
end $fn$;

-- The batch this section creates, kept where section 14 can find it.
create temporary table probe_batch (id uuid, kind text);

-- ── 13a. A FULL POOL DOES NOT BLOCK GENERATION, AND EIGHT LAND PENDING ─────
do $$
declare
  v_available integer; v_r text; v_batch uuid;
  v_cards integer; v_pending integer; v_count integer; v_expected integer;
  v_guidance text; v_model text; v_refs integer; v_events integer;
begin
  select count(*) into v_available
    from public.customer_review_test_cards where status = 'available';
  if v_available = 0 then
    raise exception '13a is only a test of the retired pool rule if cards ARE available; found none';
  end if;

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004',
                           pg_temp.batch_payload(8), 'First batch.');
  if v_r <> 'OK' then
    raise exception 'generation was refused while % card(s) were available: %', v_available, v_r;
  end if;
  raise notice 'PASS  13a1. % available card(s) did NOT block the batch — the pool rule is gone', v_available;

  select id, guidance, model, card_count, expected_count
    into v_batch, v_guidance, v_model, v_count, v_expected
    from public.customer_review_draft_batches;
  if v_batch is null then raise exception 'no batch row was written'; end if;
  if v_guidance <> 'First batch.' then raise exception 'the batch stored guidance %', v_guidance; end if;
  if v_model <> 'claude-opus-5' then raise exception 'the batch stored model %', v_model; end if;
  if v_count <> 8 or v_expected <> 8 then
    raise exception 'the batch claims % of an expected %', v_count, v_expected;
  end if;

  insert into probe_batch values (v_batch, 'first');

  select count(*), count(*) filter (where status = 'pending_approval'),
         count(distinct card_ref)
    into v_cards, v_pending, v_refs
    from public.customer_review_test_cards where batch_id = v_batch;

  if v_cards <> 8 then raise exception 'the batch inserted % cards, expected 8', v_cards; end if;
  if v_pending <> 8 then
    raise exception 'ONLY % OF 8 GENERATED CARDS ARE PENDING — the rest went straight to candidates', v_pending;
  end if;
  if v_refs <> 8 then raise exception 'the batch produced % distinct references', v_refs; end if;

  if exists (select 1 from public.customer_review_test_cards
              where batch_id = v_batch
                and (approved_at is not null or booked_by is not null
                     or card_ref !~ '^RW-[0-9]{6}$')) then
    raise exception 'a generated card landed approved, held, or with a bad reference';
  end if;

  -- Every draft is born with a line on the trail saying where it came from.
  select count(*) into v_events
    from public.customer_review_test_card_events e
    join public.customer_review_test_cards c on c.id = e.card_id
   where c.batch_id = v_batch and e.event_type = 'generated'
     and e.new_status = 'pending_approval' and e.previous_status is null;
  if v_events <> 8 then
    raise exception 'the batch wrote % generated event(s), expected 8', v_events;
  end if;

  raise notice 'PASS  13a2. exactly 8 pending drafts, 8 distinct RW references, 8 trail entries, one audited batch row (expected % / actual %)',
    v_expected, v_count;
end $$;

-- ── 13b. A CANDIDATE CANNOT SEE A PENDING DRAFT, BY ANY ROUTE ──────────────
--
-- Not hidden by a query, and not hidden by a component. The SELECT policy
-- offers a card two ways in — the available pool, or a row this person holds —
-- and a pending draft is neither, so it is outside every statement a candidate
-- can issue. This asks the DATABASE, as each person, for the row by id.
do $$
declare v_card uuid; v_n integer; v_pool_before integer; v_pool_after integer;
begin
  select id into v_card from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
   order by card_ref limit 1;

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000002', v_card);
  if v_n <> 0 then raise exception 'A CANDIDATE HOLDING `use` CAN SEE A PENDING DRAFT'; end if;
  raise notice 'PASS  13b1. a candidate holding `use` cannot see a pending draft';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000003', v_card);
  if v_n <> 0 then raise exception 'a second candidate can see a pending draft'; end if;
  raise notice 'PASS  13b2. nor can another candidate';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000005', v_card);
  if v_n <> 0 then raise exception 'an employee with no grant can see a pending draft'; end if;
  raise notice 'PASS  13b3. nor can an employee with no grant';

  -- ...and neither can they read the trail entry that names it.
  v_n := pg_temp.events_visible_to('ffffffff-0000-4000-8000-000000000002', v_card);
  if v_n <> 0 then raise exception 'a candidate can read a pending draft''s audit trail'; end if;
  raise notice 'PASS  13b4. nor its audit trail';

  -- The verifier, who has to read it in order to approve it, CAN.
  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000004', v_card);
  if v_n <> 1 then raise exception 'the verifier cannot see a pending draft'; end if;
  raise notice 'PASS  13b5. a verifier can, which is what approval requires';

  v_n := pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000001', v_card);
  if v_n <> 1 then raise exception 'the administrator cannot see a pending draft'; end if;
  raise notice 'PASS  13b6. and so can an administrator, through the engine';

  -- And the available pool a candidate sees did not grow by eight.
  v_pool_before := pg_temp.available_count_for('ffffffff-0000-4000-8000-000000000002');
  select count(*) into v_pool_after
    from public.customer_review_test_cards
   where status = 'available' and batch_id is not null;
  if v_pool_after <> 0 then
    raise exception '% generated card(s) are sitting in the candidate pool unapproved', v_pool_after;
  end if;
  raise notice 'PASS  13b7. not one generated card is in the available pool (candidate still sees % harness card(s))',
    v_pool_before;
end $$;

-- ── 13c. ONE REQUEST, ONE BATCH ────────────────────────────────────────────
--
-- The repeated tap this replaces the pool rule with. Under the old design a
-- double submission was refused because the first batch had filled the pool —
-- an accident that happened to work. Now the request itself carries a key, and
-- repeating it returns the batch that already exists.
do $$
declare v_key uuid := gen_random_uuid(); v_r text; v_r2 text;
        v_batches integer; v_cards integer; v_second uuid;
begin
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004',
                           pg_temp.batch_payload(8), 'Keyed batch.', v_key);
  if v_r <> 'OK' then raise exception 'the keyed batch was refused: %', v_r; end if;

  select count(*) into v_batches from public.customer_review_draft_batches;
  select count(*) into v_cards from public.customer_review_test_cards where batch_id is not null;
  if v_batches <> 2 or v_cards <> 16 then
    raise exception 'after two batches there are % batch(es) and % card(s)', v_batches, v_cards;
  end if;

  -- The same key again, three times. A double-tapped button, a retried fetch,
  -- a second tab.
  for i in 1..3 loop
    v_r2 := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004',
                              pg_temp.batch_payload(8), 'Keyed batch.', v_key);
    if v_r2 <> 'OK' then raise exception 'a repeat of one request errored: %', v_r2; end if;
  end loop;

  if (select count(*) from public.customer_review_draft_batches) <> 2
  or (select count(*) from public.customer_review_test_cards where batch_id is not null) <> 16 then
    raise exception 'REPEATING ONE REQUEST CREATED MORE ROWS: % batch(es), % card(s)',
      (select count(*) from public.customer_review_draft_batches),
      (select count(*) from public.customer_review_test_cards where batch_id is not null);
  end if;
  raise notice 'PASS  13c1. one request key repeated four times produced ONE batch of 8';

  select id into v_second from public.customer_review_draft_batches where request_key = v_key;
  insert into probe_batch values (v_second, 'second');

  -- A DELIBERATE second generation is a different request and must go through.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004',
                           pg_temp.batch_payload(8), 'Third batch.');
  if v_r <> 'OK' then raise exception 'a deliberate second generation was refused: %', v_r; end if;
  if (select count(*) from public.customer_review_draft_batches) <> 3 then
    raise exception 'a new request key did not produce a new batch';
  end if;
  raise notice 'PASS  13c2. a new request key generates again — asking twice on purpose is allowed';

  -- Tidy the third away; 13a's and 13c's are what section 14 works on.
  delete from public.customer_review_test_card_events
   where card_id in (select id from public.customer_review_test_cards
                      where batch_id not in (select id from probe_batch));
  delete from public.customer_review_test_cards
   where batch_id not in (select id from probe_batch);
  delete from public.customer_review_draft_batches
   where id not in (select id from probe_batch);
end $$;

-- ── 13d. EIGHT, OR NOTHING ─────────────────────────────────────────────────
do $$
declare v_r text; v_batches integer; v_cards integer; v_payload jsonb;
begin
  select count(*) into v_batches from public.customer_review_draft_batches;
  select count(*) into v_cards   from public.customer_review_test_cards;

  foreach v_payload in array array[
    pg_temp.batch_payload(0), pg_temp.batch_payload(1),
    pg_temp.batch_payload(7), pg_temp.batch_payload(9),
    pg_temp.batch_payload(20)
  ] loop
    v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', v_payload);
    if v_r not like '23514:%' or v_r not like '%BAD_BATCH%' then
      raise exception 'a payload of % drafts was accepted: %', jsonb_array_length(v_payload), v_r;
    end if;
  end loop;
  raise notice 'PASS  13d1. 0, 1, 7, 9 and 20 drafts were each refused 23514 — twenty is no longer a batch';

  -- A partial batch: seven good and one the COLUMN refuses. The function does
  -- not stop this one — the CHECK does, part-way through the insert — and the
  -- whole transaction has to disappear with it.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004',
    jsonb_set(pg_temp.batch_payload(8), '{5,body}', '"short"'::jsonb));
  if v_r = 'OK' then raise exception 'a batch with an invalid body was accepted'; end if;
  raise notice 'PASS  13d2. a batch failing mid-insert was refused (%)', left(v_r, 40);

  if (select count(*) from public.customer_review_draft_batches) <> v_batches then
    raise exception 'a refused batch left a batch row behind';
  end if;
  if (select count(*) from public.customer_review_test_cards) <> v_cards then
    raise exception 'A REFUSED BATCH LEFT CARDS BEHIND: % now, % before',
      (select count(*) from public.customer_review_test_cards), v_cards;
  end if;
  raise notice 'PASS  13d3. NOT ONE ROW SURVIVED ANY REFUSED CALL (still % batch(es), % card(s))',
    v_batches, v_cards;
end $$;

-- ── 13e. WHO MAY ASK ───────────────────────────────────────────────────────
do $$
declare v_r text;
begin
  -- A candidate holds `use`, not `verify`.
  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000002', pg_temp.batch_payload(8));
  if v_r not like '42501:%' then raise exception 'a candidate generated a batch: %', v_r; end if;
  raise notice 'PASS  13e1. a candidate holding `use` but not `verify` is refused 42501';

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000005', pg_temp.batch_payload(8));
  if v_r not like '42501:%' then raise exception 'an unpermitted user generated a batch: %', v_r; end if;
  raise notice 'PASS  13e2. a user with no grant is refused 42501';

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000007', pg_temp.batch_payload(8));
  if v_r not like '42501:%' then raise exception 'an inactive verifier generated a batch: %', v_r; end if;
  raise notice 'PASS  13e3. an INACTIVE account holding verify is refused 42501';

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000006', pg_temp.batch_payload(8));
  if v_r not like '42501:%' then raise exception 'an inactive administrator generated a batch: %', v_r; end if;
  raise notice 'PASS  13e4. an INACTIVE administrator is refused 42501';

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-0000000000ff', pg_temp.batch_payload(8));
  if v_r not like '42501:%' then raise exception 'a non-existent actor generated a batch: %', v_r; end if;
  raise notice 'PASS  13e5. an unknown actor is refused 42501';
end $$;

-- ── 13f. AN ADMINISTRATOR GETS IN THROUGH THE ENGINE, OR NOT AT ALL ────────
do $$
declare v_r text; v_resolved boolean; v_module uuid; v_verify uuid; v_batches integer;
begin
  v_resolved := public.resolve_permission(
    'ffffffff-0000-4000-8000-000000000001', 'customer_review_requests', 'verify');

  select count(*) into v_batches from public.customer_review_draft_batches;

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000001',
                           pg_temp.batch_payload(8), 'Admin batch.');

  -- Whatever the seed says, the OUTCOME must match the RESOLVED permission
  -- exactly. If the administrator resolves verify they generate; if they do
  -- not, they are refused like anybody else. There is no third answer.
  if v_resolved and v_r <> 'OK' then
    raise exception 'an administrator who RESOLVES verify was refused: %', v_r;
  end if;
  if (not v_resolved) and v_r not like '42501:%' then
    raise exception 'an administrator who does NOT resolve verify got in anyway: %', v_r;
  end if;
  raise notice 'PASS  13f1. administrator resolve_permission = %, and the function agreed (%)',
    v_resolved, case when v_r = 'OK' then 'generated' else 'refused 42501' end;

  -- Tidy the administrator's batch away before the revocation half.
  delete from public.customer_review_test_card_events
   where card_id in (select id from public.customer_review_test_cards
                      where batch_id is not null
                        and batch_id not in (select id from probe_batch));
  delete from public.customer_review_test_cards
   where batch_id is not null and batch_id not in (select id from probe_batch);
  delete from public.customer_review_draft_batches
   where id not in (select id from probe_batch);

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

  v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000001', pg_temp.batch_payload(8));
  if v_r not like '42501:%' then
    raise exception 'A REVOKED ADMINISTRATOR STILL GENERATED A BATCH: %', v_r;
  end if;
  raise notice 'PASS  13f2. THE SAME ADMINISTRATOR, verify REVOKED, IS REFUSED 42501';

  delete from public.employee_permission_overrides
   where user_id = 'ffffffff-0000-4000-8000-000000000001';
end $$;

-- ── 13g. NOTHING GENERATED CARRIES A WARNING, A LINK OR A NUMBER ───────────
do $$
declare v_bad integer; v_seen integer;
begin
  select count(*) into v_seen from public.customer_review_test_cards where batch_id is not null;
  if v_seen = 0 then raise exception '13g has no generated cards to inspect'; end if;

  select count(*) into v_bad from public.customer_review_test_cards
   where batch_id is not null
     and (test_body ~* '(https?://|www\.|wa\.me)'
       or test_body ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
       or public.customer_review_contains_phone(test_body)
       or public.customer_review_contains_phone(test_title)
       or position(public.customer_review_internal_test_warning() in upper(test_body)) > 0
       or test_body ~* '(leave a review|post this|publish this|rate us)');
  if v_bad > 0 then
    raise exception '% of % generated card(s) carry a link, contact detail or posting instruction',
      v_bad, v_seen;
  end if;
  raise notice 'PASS  13g. none of % generated card(s) carries a warning, link, address, number or posting instruction',
    v_seen;
end $$;

-- ── 13h. THE FUNCTION IS NOT REACHABLE FROM A BROWSER ──────────────────────
do $$
begin
  if has_function_privilege('authenticated',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)', 'execute')
   or has_function_privilege('anon',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)', 'execute') then
    raise exception 'a browser role can execute the batch function';
  end if;
  if not has_function_privilege('service_role',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)', 'execute') then
    raise exception 'the server role cannot execute the batch function';
  end if;

  -- THE RETIRED VERSION IS GONE, not merely superseded. It still carried the
  -- twenty-draft rule and the empty-pool rule, and a superseded definer
  -- function a service-role caller can still reach is a second door with the
  -- old lock on it.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'create_customer_review_draft_batch'
       and p.pronargs = 4
  ) then
    raise exception 'THE 20-DRAFT, EMPTY-POOL GENERATOR IS STILL CALLABLE';
  end if;

  -- And no client role can write the batch table directly either.
  if has_table_privilege('authenticated', 'public.customer_review_draft_batches', 'insert')
   or has_table_privilege('authenticated', 'public.customer_review_draft_batches', 'update')
   or has_table_privilege('authenticated', 'public.customer_review_draft_batches', 'delete') then
    raise exception 'authenticated can write customer_review_draft_batches directly';
  end if;
  raise notice 'PASS  13h. service_role only, the 4-argument version is gone, and no direct client write';
end $$;

-- ── 13k. THE TELEPHONE DETECTOR, ON THE SAME CORPUS AS THE TYPESCRIPT ───
--
-- customer_review_contains_phone is the SQL twin of containsTelephoneNumber in
-- src/lib/customerReviews/internalTest.ts. The route validates a batch with the
-- TypeScript one and the batch function refuses it again with this one, so the
-- two disagreeing means the route accepts what the database then rejects.
--
-- The corpus below is the same list the TypeScript tests use. The first four
-- rejections are the formats the previous matcher missed: it required a leading
-- '+', so only the first of them was ever caught.
do $$
declare
  v_text text;
  v_bad  integer := 0;
begin
  foreach v_text in array array[
    '+44 20 7946 0000',
    '202-555-0100',
    '(202) 555-0100',
    '9876543210',
    'Great chairs, call +44 20 7946 0000 to order the same.',
    'Great chairs — ring 202-555-0100 and ask for the workshop.',
    'Great chairs, the showroom is (202) 555-0100 on weekdays.',
    'Great chairs, my number is 9876543210 if you want the spec.',
    '+1 (202) 555-0100',
    '020 7946 0000',
    '+91 98765 43210',
    '555.123.4567'
  ] loop
    if not public.customer_review_contains_phone(v_text) then
      raise warning 'MISSED a telephone number: %', v_text;
      v_bad := v_bad + 1;
    end if;
  end loop;
  if v_bad > 0 then
    raise exception '% telephone number(s) passed the database check', v_bad;
  end if;
  raise notice 'PASS  13k1. all 12 telephone formats are refused, with or without a leading +';

  foreach v_text in array array[
    '120 chairs',
    '60 rooms',
    '18 months',
    'three weeks',
    'We ordered 120 chairs for a room that seats 60.',
    'Eighty covers delivered over 18 months, in three phases.',
    'A hundred and twenty covers, delivered in three phases.',
    'Two years of full service later the frames have not moved.',
    'We refitted 60 rooms in 2 lifts across 3 mornings.',
    'The 40 stools arrived first, then the 12 tables.',
    'Forty stacking chairs, six high on the pallet.'
  ] loop
    if public.customer_review_contains_phone(v_text) then
      raise warning 'FALSE POSITIVE on an ordinary quantity: %', v_text;
      v_bad := v_bad + 1;
    end if;
  end loop;
  if v_bad > 0 then
    raise exception '% ordinary quantity phrase(s) were treated as telephone numbers', v_bad;
  end if;
  raise notice 'PASS  13k2. quantities and durations are left alone (120 chairs, 60 rooms, 18 months, three weeks)';

  -- The boundary itself: six digits in a run is not a number, seven is.
  if public.customer_review_contains_phone('12 34 56')
  or not public.customer_review_contains_phone('12 34 567') then
    raise exception 'the seven-digit boundary is wrong';
  end if;
  raise notice 'PASS  13k3. the rule is a digit count, and the boundary is seven';
end $$;

-- ── 13l. AND THE BATCH FUNCTION REFUSES A DRAFT CARRYING ONE ───────────
--
-- Not just asserted at apply time: refused inside the transaction, so a route
-- that ever stopped validating still could not write a contact detail.
do $$
declare v_r text; v_batches integer; v_cards integer; v_payload jsonb; v_number text;
begin
  select count(*) into v_batches from public.customer_review_draft_batches;
  select count(*) into v_cards   from public.customer_review_test_cards;

  foreach v_number in array array[
    '+44 20 7946 0000', '202-555-0100', '(202) 555-0100', '9876543210'
  ] loop
    v_payload := jsonb_set(pg_temp.batch_payload(8), '{6,body}',
      to_jsonb('We were very happy with the seating and the delivery, and the number to call is '
               || v_number || ' on weekdays.'));
    v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', v_payload);
    if v_r not like '23514:%' or v_r not like '%telephone number%' then
      raise exception 'a batch carrying % was not refused by the database: %', v_number, v_r;
    end if;

    -- The same number in a TITLE, which is displayed on the card.
    v_payload := jsonb_set(pg_temp.batch_payload(8), '{4,title}', to_jsonb('Call ' || v_number));
    v_r := pg_temp.try_batch('ffffffff-0000-4000-8000-000000000004', v_payload);
    if v_r not like '23514:%' or v_r not like '%telephone number%' then
      raise exception 'a batch whose TITLE carried % was not refused: %', v_number, v_r;
    end if;
  end loop;
  raise notice 'PASS  13l1. all four formats are refused by the batch function, in a body and in a title';

  if (select count(*) from public.customer_review_draft_batches) <> v_batches
  or (select count(*) from public.customer_review_test_cards) <> v_cards then
    raise exception 'a refused batch left rows behind';
  end if;
  raise notice 'PASS  13l2. and not one row survived any of the eight refusals';
end $$;

-- ─── 14. APPROVAL, VIEW-BEFORE-BOOK, UNBOOKING AND REVISION ────────────────
--
-- Section 13 proved that generated drafts land where no candidate can reach
-- them. This proves the rest of the path: who may release one, what a release
-- does, what a candidate may then do with it, and what happens when they change
-- their mind.
--
-- IT WORKS ON THE TWO BATCHES 13a AND 13c LEFT BEHIND, sixteen pending drafts
-- in total, and cleans both up at 14z.

-- ── 14a. APPROVAL NEEDS `verify`, RESOLVED ─────────────────────────────────
do $$
declare v_ids uuid[]; v_one uuid;
begin
  select array_agg(id order by card_ref) into v_ids
    from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first');
  v_one := v_ids[1];

  -- A candidate holds `use`. Approval is not theirs.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_one),
    '42501', '14a1. a candidate holding `use` approving a draft');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000005',
    format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_one),
    '42501', '14a2. an employee with no grant approving a draft');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000007',
    format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_one),
    '42501', '14a3. an INACTIVE verifier approving a draft');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000006',
    format('select public.approve_customer_review_draft_batch(%L)',
           (select id from probe_batch where kind = 'first')),
    '42501', '14a4. an INACTIVE administrator approving a whole batch');

  -- Nothing moved.
  if exists (select 1 from public.customer_review_test_cards
              where batch_id is not null and status <> 'pending_approval') then
    raise exception 'a refused approval still released a draft';
  end if;
  raise notice 'PASS  14a5. after four refusals every draft is still pending';
end $$;

-- ── 14b. A REVOKED ADMINISTRATOR IS REFUSED, TOO ───────────────────────────
do $$
declare v_module uuid; v_verify uuid; v_one uuid;
begin
  select id into v_one from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
   order by card_ref limit 1;

  select id into v_module from public.permission_modules where module_key = 'customer_review_requests';
  select id into v_verify from public.permission_actions where action_key = 'verify';

  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values ('ffffffff-0000-4000-8000-000000000001', v_module, v_verify, false,
          'ffffffff-0000-4000-8000-000000000001');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000001',
    format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_one),
    '42501', '14b. an ADMINISTRATOR with `verify` revoked approving a draft');

  delete from public.employee_permission_overrides
   where user_id = 'ffffffff-0000-4000-8000-000000000001';
end $$;

-- ── 14c. ONE DRAFT, APPROVED ───────────────────────────────────────────────
do $$
declare v_one uuid; v_r text; v_status text; v_at timestamptz; v_by uuid; v_n integer;
begin
  select id into v_one from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
   order by card_ref limit 1;

  -- Before: the candidate cannot see it.
  if pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000002', v_one) <> 0 then
    raise exception '14c starts from a draft the candidate can already see';
  end if;

  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000004',
           format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_one));
  if v_r <> '1' then raise exception 'approving one draft returned %', v_r; end if;

  select status, approved_at, approved_by into v_status, v_at, v_by
    from public.customer_review_test_cards where id = v_one;
  if v_status <> 'available' then raise exception 'the approved draft is %', v_status; end if;
  if v_at is null or v_by <> 'ffffffff-0000-4000-8000-000000000004' then
    raise exception 'the approval was not attributed: at=%, by=%', v_at, v_by;
  end if;

  -- ...and NOW the candidate can see it.
  if pg_temp.cards_visible_to('ffffffff-0000-4000-8000-000000000002', v_one) <> 1 then
    raise exception 'AN APPROVED REVIEW IS STILL INVISIBLE TO THE CANDIDATE';
  end if;

  select count(*) into v_n from public.customer_review_test_card_events
   where card_id = v_one and event_type = 'approved'
     and previous_status = 'pending_approval' and new_status = 'available'
     and actor_id = 'ffffffff-0000-4000-8000-000000000004';
  if v_n <> 1 then raise exception 'the approval wrote % trail entries', v_n; end if;

  raise notice 'PASS  14c. one draft approved: available, attributed, on the trail, and now visible to a candidate';
end $$;

-- ── 14d. THE SAME DRAFT AGAIN — REFUSED, AND NOTHING MOVES ─────────────────
do $$
declare v_one uuid; v_before timestamptz;
begin
  select id, approved_at into v_one, v_before from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
     and status = 'available' limit 1;

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_one),
    '23514', '14d1. approving an already-approved review');

  if (select approved_at from public.customer_review_test_cards where id = v_one) <> v_before then
    raise exception 'the refused re-approval moved approved_at';
  end if;
  raise notice 'PASS  14d2. the first approval''s timestamp is untouched';
end $$;

-- ── 14e. A SELECTED GROUP, ALL OR NOTHING ──────────────────────────────────
do $$
declare v_ids uuid[]; v_mixed uuid[]; v_r text; v_approved uuid;
begin
  select array_agg(id order by card_ref) into v_ids
    from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
     and status = 'pending_approval';

  select id into v_approved from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
     and status = 'available' limit 1;

  -- A STALE BROWSER: two still-pending drafts and one somebody approved a
  -- moment ago. The whole call has to be refused, and — the part that matters —
  -- the two pending ones must NOT have been approved on the way past.
  v_mixed := array[v_ids[1], v_approved, v_ids[2]];
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    format('select public.approve_customer_review_drafts(%L::uuid[])', v_mixed),
    '23514', '14e1. a selection containing one already-approved review');

  if (select count(*) from public.customer_review_test_cards
       where id in (v_ids[1], v_ids[2]) and status <> 'pending_approval') > 0 then
    raise exception 'A PARTIAL APPROVAL HAPPENED: the pending members of a refused selection moved';
  end if;
  raise notice 'PASS  14e2. neither pending member of the refused selection was approved';

  -- A selection naming a review that no longer exists.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    format('select public.approve_customer_review_drafts(array[%L, %L]::uuid[])',
           v_ids[1], '00000000-0000-4000-8000-0000000000ff'),
    'P0002', '14e3. a selection naming a review that does not exist');

  -- An empty selection is a mistake, not a no-op.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    'select public.approve_customer_review_drafts(array[]::uuid[])',
    '23514', '14e4. an empty selection');

  -- Now the real thing: three at once.
  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000004',
           format('select public.approve_customer_review_drafts(array[%L, %L, %L]::uuid[])',
                  v_ids[1], v_ids[2], v_ids[3]));
  if v_r <> '3' then raise exception 'approving three returned %', v_r; end if;
  if (select count(*) from public.customer_review_test_cards
       where id in (v_ids[1], v_ids[2], v_ids[3]) and status = 'available'
         and approved_by = 'ffffffff-0000-4000-8000-000000000004') <> 3 then
    raise exception 'the group approval did not release all three';
  end if;
  raise notice 'PASS  14e5. three selected drafts approved together, all attributed';
end $$;

-- ── 14f. APPROVE EVERYTHING STILL PENDING IN ONE BATCH ─────────────────────
do $$
declare v_batch uuid; v_r text; v_left integer; v_other integer;
begin
  select id into v_batch from probe_batch where kind = 'first';

  select count(*) into v_other from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'second')
     and status = 'pending_approval';
  if v_other <> 8 then raise exception '14f needs the second batch untouched, found % pending', v_other; end if;

  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000004',
           format('select public.approve_customer_review_draft_batch(%L)', v_batch));
  if v_r <> '4' then raise exception 'approve-all released % of the 4 remaining', v_r; end if;

  select count(*) into v_left from public.customer_review_test_cards
   where batch_id = v_batch and status <> 'available';
  if v_left <> 0 then raise exception '% draft(s) in the batch are still not available', v_left; end if;

  -- IT IS SCOPED TO ONE BATCH. The other batch is untouched.
  select count(*) into v_other from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'second')
     and status = 'pending_approval';
  if v_other <> 8 then
    raise exception 'approve-all reached another batch: % of 8 still pending there', v_other;
  end if;
  raise notice 'PASS  14f1. the batch is fully approved, and the other batch''s 8 drafts are untouched';

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    format('select public.approve_customer_review_draft_batch(%L)', v_batch),
    '23514', '14f2. approve-all on a batch with nothing left pending');
end $$;

-- ── 14g. A PENDING DRAFT CANNOT BE BOOKED ──────────────────────────────────
--
-- The candidate cannot see it, so this is belt and braces — but a card id can
-- reach book_customer_review_test_card() without ever having been read.
do $$
declare v_pending uuid;
begin
  select id into v_pending from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'second')
     and status = 'pending_approval'
   order by card_ref limit 1;

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    format('select public.book_customer_review_test_card(%L)', v_pending),
    '23514', '14g. booking a pending draft by id');

  if (select status from public.customer_review_test_cards where id = v_pending)
     <> 'pending_approval' then
    raise exception 'the refused booking moved a pending draft';
  end if;
end $$;

-- ── 14h. BOOK AN APPROVED REVIEW, THEN RELEASE IT ──────────────────────────
do $$
declare v_card uuid; v_r text; c public.customer_review_test_cards%rowtype;
        v_approved_at timestamptz; v_events_before integer; v_events_after integer;
begin
  select id, approved_at into v_card, v_approved_at
    from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
     and status = 'available'
   order by card_ref limit 1;

  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
           format('select (public.book_customer_review_test_card(%L)).status', v_card));
  if v_r <> 'booked' then raise exception 'booking an approved review returned %', v_r; end if;

  -- Give it the marks a real booking would leave, so the release has something
  -- to clear. Written as the owner because no client role may write this table.
  update public.customer_review_test_cards
     set whatsapp_opened_at = now(), whatsapp_opened_count = 2,
         whatsapp_target_last_four = '4321'
   where id = v_card;

  select count(*) into v_events_before
    from public.customer_review_test_card_events where card_id = v_card;

  -- ONLY THE HOLDER. A colleague, a verifier and an administrator are all
  -- refused — there is no role bypass on a candidate action.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000003',
    format('select public.unbook_customer_review_test_card(%L)', v_card),
    '42501', '14h1. another candidate releasing somebody else''s booking');
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000004',
    format('select public.unbook_customer_review_test_card(%L)', v_card),
    '42501', '14h2. a VERIFIER releasing a candidate''s booking');
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000001',
    format('select public.unbook_customer_review_test_card(%L)', v_card),
    '42501', '14h3. an ADMINISTRATOR releasing a booking that is not theirs');

  -- A LIVE SCREENSHOT BLOCKS IT. Releasing a card with somebody's WhatsApp
  -- screen attached would show that image to the whole pool.
  insert into public.customer_review_test_card_screenshots
    (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_card, 'test_screenshot', v_card || '/test_screenshot/unbook.png', 'unbook.png',
          'image/png', 2048, repeat('d', 64), 'ffffffff-0000-4000-8000-000000000002');

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    format('select public.unbook_customer_review_test_card(%L)', v_card),
    '23514', '14h4. the holder releasing a booking with a screenshot still attached');

  delete from public.customer_review_test_card_screenshots where card_id = v_card;

  -- Now the holder releases it.
  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
           format('select (public.unbook_customer_review_test_card(%L)).status', v_card));
  if v_r <> 'available' then raise exception 'releasing returned %', v_r; end if;

  select * into c from public.customer_review_test_cards where id = v_card;
  if c.booked_by is not null or c.booked_at is not null
  or c.whatsapp_opened_at is not null or c.whatsapp_opened_count <> 0
  or c.whatsapp_target_last_four is not null then
    raise exception 'THE RELEASE LEFT BOOKING DATA BEHIND: by=%, opened=%, count=%, lastfour=%',
      c.booked_by, c.whatsapp_opened_at, c.whatsapp_opened_count, c.whatsapp_target_last_four;
  end if;

  -- THE APPROVAL SURVIVED. A released review is still an approved review.
  if c.approved_at is null or c.approved_at <> v_approved_at then
    raise exception 'the release changed the approval record';
  end if;

  -- AND THE TRAIL GREW RATHER THAN SHRANK.
  select count(*) into v_events_after
    from public.customer_review_test_card_events where card_id = v_card;
  if v_events_after <= v_events_before then
    raise exception 'the release removed audit history: % entries before, % after',
      v_events_before, v_events_after;
  end if;
  if not exists (select 1 from public.customer_review_test_card_events
                  where card_id = v_card and event_type = 'unbooked'
                    and previous_status = 'booked' and new_status = 'available'
                    and actor_id = 'ffffffff-0000-4000-8000-000000000002') then
    raise exception 'no unbooked entry was written';
  end if;

  -- ...and it can be booked again, by somebody else.
  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000003',
           format('select (public.book_customer_review_test_card(%L)).booked_by', v_card));
  if v_r <> 'ffffffff-0000-4000-8000-000000000003' then
    raise exception 'the released review could not be booked by another candidate: %', v_r;
  end if;

  raise notice 'PASS  14h5. released by its holder: booking data cleared, approval kept, trail grew by an unbooked entry, and another candidate booked it';
end $$;

-- ── 14i. AFTER A CONFIRMED SEND, RELEASING IS REFUSED FOR GOOD ─────────────
do $$
declare v_card uuid; v_r text;
begin
  select id into v_card from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
     and status = 'available'
   order by card_ref limit 1;

  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.book_customer_review_test_card(%L)).status', v_card));

  -- Opening WhatsApp is the ordering prerequisite for confirming a send.
  update public.customer_review_test_cards
     set whatsapp_opened_at = now(), whatsapp_opened_count = 1,
         whatsapp_target_last_four = '9999'
   where id = v_card;

  -- Before the confirmation, releasing works — proved by it being refused only
  -- AFTER, which would be vacuous if it were refused before too.
  v_r := pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
           format('select (public.unbook_customer_review_test_card(%L)).status', v_card));
  if v_r <> 'available' then raise exception 'releasing before a send failed: %', v_r; end if;

  -- Book it again, open, and this time CONFIRM.
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.book_customer_review_test_card(%L)).status', v_card));
  update public.customer_review_test_cards
     set whatsapp_opened_at = now(), whatsapp_opened_count = 1
   where id = v_card;
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.confirm_customer_review_test_card_sent(%L)).sent_confirmed_at::text', v_card));

  if (select sent_confirmed_at from public.customer_review_test_cards where id = v_card) is null then
    raise exception '14i could not set up a confirmed send';
  end if;

  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    format('select public.unbook_customer_review_test_card(%L)', v_card),
    '23514', '14i1. the holder releasing a review they have confirmed sending');

  if (select status from public.customer_review_test_cards where id = v_card) <> 'booked' then
    raise exception 'the refused release moved the card anyway';
  end if;
  raise notice 'PASS  14i2. the review is still booked, and still confirmed sent';
end $$;

-- ── 14i2. A REVIEW A VERIFIER RETURNED CANNOT BE UNBOOKED ──────────────────
--
-- A return is submitted -> booked, so the candidate holds a `booked` card
-- again — the same status an untouched booking has. It must NOT behave like
-- one: it has already been sent to a real recipient, and putting it back in the
-- pool would let somebody else send it again.
--
-- THE REFUSAL IS STRUCTURAL RATHER THAN A SPECIAL CASE. Submitting requires
-- sent_confirmed_at, a return comes from submitted, and nothing clears that
-- column while a card is held — so a returned card always carries it and the
-- ALREADY_SENT check catches it. This proves the chain end to end rather than
-- asserting the conclusion.
do $$
declare v_card uuid; v_ret record;
begin
  select id into v_card from public.customer_review_test_cards
   where batch_id = (select id from probe_batch where kind = 'first')
     and status = 'available'
   order by card_ref limit 1;

  -- Book it, open WhatsApp, confirm, attach evidence, submit.
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.book_customer_review_test_card(%L)).status', v_card));
  update public.customer_review_test_cards
     set whatsapp_opened_at = now(), whatsapp_opened_count = 1, whatsapp_target_last_four = '7788'
   where id = v_card;
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.confirm_customer_review_test_card_sent(%L)).sent_confirmed_at::text', v_card));
  insert into public.customer_review_test_card_screenshots
    (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_card, 'test_screenshot', v_card || '/test_screenshot/returned.png', 'returned.png',
          'image/png', 2048, repeat('e', 64), 'ffffffff-0000-4000-8000-000000000002');
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.transition_customer_review_test_card(%L, %L, null)).status', v_card, 'submitted'));

  -- A verifier hands it back, with a reason.
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000004',
    format('select (public.transition_customer_review_test_card(%L, %L, %L)).status',
           v_card, 'booked', 'The screenshot does not show the recipient.'));

  select status, sent_confirmed_at, returned_at, return_reason into v_ret
    from public.customer_review_test_cards where id = v_card;
  if v_ret.status <> 'booked' or v_ret.returned_at is null then
    raise exception '14i2 could not set up a returned review (status %, returned %)',
      v_ret.status, v_ret.returned_at;
  end if;

  -- THE INVARIANT THE REFUSAL RESTS ON.
  if v_ret.sent_confirmed_at is null then
    raise exception 'A RETURNED REVIEW CARRIES NO SEND CONFIRMATION — the unbook refusal has nothing to catch it with';
  end if;
  raise notice 'PASS  14i2-a. a returned review is booked again AND still carries its send confirmation';

  -- The holder holds it, and still cannot put it back in the pool.
  perform pg_temp.refused_with(
    'ffffffff-0000-4000-8000-000000000002',
    format('select public.unbook_customer_review_test_card(%L)', v_card),
    '23514', '14i2-b. the holder unbooking a review a verifier returned to them');

  if (select status from public.customer_review_test_cards where id = v_card) <> 'booked'
  or (select return_reason from public.customer_review_test_cards where id = v_card) is null then
    raise exception 'the refused unbooking disturbed the returned review';
  end if;
  raise notice 'PASS  14i2-c. it is still booked, still returned, and still carries its reason';

  -- ...and it is still the holder's to finish: submitting again is offered.
  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000002',
    format('select (public.transition_customer_review_test_card(%L, %L, null)).status', v_card, 'submitted'));
  if (select status from public.customer_review_test_cards where id = v_card) <> 'submitted' then
    raise exception 'a returned review could not be re-submitted by its holder';
  end if;
  raise notice 'PASS  14i2-d. the holder re-submits it, which is the path a return exists to offer';
end $$;

-- ── 14j. REVISION TOUCHES PENDING DRAFTS AND NOTHING ELSE ──────────────────
--
-- The second batch is entirely pending. One member is approved first, so the
-- revision has a mixed batch to be careful in.
do $$
declare
  v_batch uuid; v_ids uuid[]; v_kept uuid; v_r text;
  v_kept_title text; v_kept_body text;
  v_before jsonb; v_after jsonb; v_n integer;
begin
  select id into v_batch from probe_batch where kind = 'second';

  select array_agg(id order by card_ref) into v_ids
    from public.customer_review_test_cards
   where batch_id = v_batch and status = 'pending_approval';
  v_kept := v_ids[1];

  perform pg_temp.as_user('ffffffff-0000-4000-8000-000000000004',
    format('select public.approve_customer_review_drafts(array[%L]::uuid[])', v_kept));

  select test_title, test_body into v_kept_title, v_kept_body
    from public.customer_review_test_cards where id = v_kept;

  -- What the seven still-pending members say now.
  select jsonb_agg(jsonb_build_array(card_ref, test_title, test_body) order by card_ref)
    into v_before
    from public.customer_review_test_cards
   where batch_id = v_batch and status = 'pending_approval';

  -- A COUNT THAT NO LONGER MATCHES IS REFUSED WHOLE. Eight replacements for
  -- seven pending drafts is the exact shape of "somebody approved one while the
  -- model was writing".
  v_r := pg_temp.try_revise(v_batch, 'ffffffff-0000-4000-8000-000000000004',
                            pg_temp.batch_payload(8, 'revised'));
  if v_r not like '23514:%' or v_r not like '%REVISION_CHANGED%' then
    raise exception 'a mismatched revision was accepted: %', v_r;
  end if;
  raise notice 'PASS  14j1. eight replacements for seven pending drafts — refused REVISION_CHANGED';

  -- ...and an invalid member rolls the whole revision back.
  v_r := pg_temp.try_revise(v_batch, 'ffffffff-0000-4000-8000-000000000004',
    jsonb_set(pg_temp.batch_payload(7, 'revised'), '{3,body}',
      to_jsonb('Lovely chairs. Ring 202-555-0100 for the same spec.'::text)));
  if v_r not like '23514:%' or v_r not like '%telephone number%' then
    raise exception 'a revision carrying a telephone number was accepted: %', v_r;
  end if;

  select jsonb_agg(jsonb_build_array(card_ref, test_title, test_body) order by card_ref)
    into v_after
    from public.customer_review_test_cards
   where batch_id = v_batch and status = 'pending_approval';
  if v_after <> v_before then
    raise exception 'A FAILED REVISION CHANGED TEXT ANYWAY';
  end if;
  raise notice 'PASS  14j2. a revision with one bad member left all seven titles and bodies byte-for-byte unchanged';

  -- Who may revise.
  v_r := pg_temp.try_revise(v_batch, 'ffffffff-0000-4000-8000-000000000002',
                            pg_temp.batch_payload(7, 'revised'));
  if v_r not like '42501:%' then raise exception 'a candidate revised a batch: %', v_r; end if;
  v_r := pg_temp.try_revise(v_batch, 'ffffffff-0000-4000-8000-000000000007',
                            pg_temp.batch_payload(7, 'revised'));
  if v_r not like '42501:%' then raise exception 'an inactive verifier revised a batch: %', v_r; end if;
  raise notice 'PASS  14j3. a candidate and an inactive verifier are each refused 42501';

  -- The real thing: seven replacements for seven pending drafts.
  v_r := pg_temp.try_revise(v_batch, 'ffffffff-0000-4000-8000-000000000004',
                            pg_temp.batch_payload(7, 'revised'), 'Warmer, and shorter.');
  if v_r <> 'OK:7' then raise exception 'the revision returned %', v_r; end if;

  -- BOTH the title and the body changed on every pending member.
  select count(*) into v_n
    from public.customer_review_test_cards
   where batch_id = v_batch and status = 'pending_approval'
     and test_title like '%revised%' and test_body like '%revised batch%';
  if v_n <> 7 then raise exception 'only % of 7 pending drafts were rewritten', v_n; end if;

  -- AND THE APPROVED ONE IS BYTE-FOR-BYTE WHAT IT WAS.
  if (select test_title from public.customer_review_test_cards where id = v_kept) <> v_kept_title
  or (select test_body  from public.customer_review_test_cards where id = v_kept) <> v_kept_body then
    raise exception 'THE REVISION REWROTE AN APPROVED REVIEW';
  end if;
  raise notice 'PASS  14j4. seven pending drafts rewritten, title and body; the approved one is untouched';

  -- Identity and batch association survive a revision.
  if (select count(*) from public.customer_review_test_cards
       where batch_id = v_batch) <> 8 then
    raise exception 'the revision changed which cards belong to the batch';
  end if;
  if (select count(distinct card_ref) from public.customer_review_test_cards
       where batch_id = v_batch) <> 8 then
    raise exception 'the revision disturbed the references';
  end if;

  -- The append-only record of it.
  select count(*) into v_n from public.customer_review_draft_batch_revisions
   where batch_id = v_batch and revised_by = 'ffffffff-0000-4000-8000-000000000004'
     and guidance = 'Warmer, and shorter.' and model = 'claude-opus-5' and revised_count = 7;
  if v_n <> 1 then raise exception 'the revision wrote % audit row(s)', v_n; end if;

  select count(*) into v_n
    from public.customer_review_test_card_events e
    join public.customer_review_test_cards c on c.id = e.card_id
   where c.batch_id = v_batch and e.event_type = 'revised';
  if v_n <> 7 then raise exception 'the revision wrote % card event(s), expected 7', v_n; end if;
  raise notice 'PASS  14j5. one revision row (actor, time, model, guidance, count) and 7 card events';
end $$;

-- ── 14k. A BATCH WITH NOTHING PENDING CANNOT BE REVISED ────────────────────
do $$
declare v_batch uuid; v_r text;
begin
  select id into v_batch from probe_batch where kind = 'first';   -- fully approved at 14f
  v_r := pg_temp.try_revise(v_batch, 'ffffffff-0000-4000-8000-000000000004',
                            pg_temp.batch_payload(1, 'revised'));
  if v_r not like '23514:%' or v_r not like '%NOTHING_PENDING%' then
    raise exception 'a fully approved batch was revised: %', v_r;
  end if;
  raise notice 'PASS  14k. a batch with nothing pending is refused NOTHING_PENDING';
end $$;

-- ── 14l. THE REVISION TRAIL IS APPEND-ONLY AND VERIFIER-READ-ONLY ──────────
do $$
declare v_n integer;
begin
  if has_function_privilege('authenticated',
       'public.revise_customer_review_draft_batch(uuid, text, text, jsonb, uuid, uuid)', 'execute')
   or has_function_privilege('anon',
       'public.revise_customer_review_draft_batch(uuid, text, text, jsonb, uuid, uuid)', 'execute') then
    raise exception 'a browser role can execute the revision function';
  end if;

  if has_table_privilege('authenticated', 'public.customer_review_draft_batch_revisions', 'insert')
   or has_table_privilege('authenticated', 'public.customer_review_draft_batch_revisions', 'update')
   or has_table_privilege('authenticated', 'public.customer_review_draft_batch_revisions', 'delete') then
    raise exception 'authenticated can write the revision trail';
  end if;

  -- A candidate cannot even read it; a verifier can.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002',
                                   'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into v_n from public.customer_review_draft_batch_revisions;
  reset role;
  if v_n <> 0 then raise exception 'a candidate can read the revision trail'; end if;

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000004',
                                   'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into v_n from public.customer_review_draft_batch_revisions;
  reset role;
  if v_n < 1 then raise exception 'a verifier cannot read the revision trail'; end if;

  raise notice 'PASS  14l. service_role only, no client write, and only a verifier reads it';
end $$;

-- ── 14z. Clean up everything sections 13 and 14 generated ──────────────────
do $$
declare v_cards integer; v_batches integer;
begin
  delete from public.customer_review_test_card_screenshots
   where card_id in (select id from public.customer_review_test_cards where batch_id is not null);
  delete from public.customer_review_test_card_events
   where card_id in (select id from public.customer_review_test_cards where batch_id is not null);
  delete from public.customer_review_test_cards where batch_id is not null;
  get diagnostics v_cards = row_count;
  delete from public.customer_review_draft_batch_revisions;
  delete from public.customer_review_draft_batches;
  get diagnostics v_batches = row_count;

  if exists (select 1 from public.customer_review_test_cards where status = 'pending_approval') then
    raise exception 'a pending draft survived the cleanup';
  end if;
  raise notice 'PASS  14z. % generated card(s) and % batch(es) removed; only the harness cards remain',
    v_cards, v_batches;
end $$;

drop table probe_batch;

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
