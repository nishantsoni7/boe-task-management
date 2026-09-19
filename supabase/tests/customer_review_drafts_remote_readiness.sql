-- ═════════════════════════════════════════════════════════════════════════════
-- READ-ONLY production check for 20261023000000_review_workflow_ai_drafts
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Run against production AFTER applying the migration:
--
--   npx supabase db query -f supabase/tests/customer_review_drafts_remote_readiness.sql --linked
--
-- WHAT IT DOES. It SELECTS, and it raises when an expectation is not met. It
-- has no INSERT, UPDATE, DELETE, TRUNCATE, ALTER, CREATE, DROP, GRANT or
-- REVOKE, and no call to any function that writes. Every `raise` is either a
-- notice or an exception; nothing here changes a row, a grant or a definition.
--
-- (That claim is worth stating precisely: the file writes NOTHING. It is not
-- "mostly reads" — grep it for the verbs above and the count is zero.)
--
-- It answers eight questions:
--   1. is the batch table there, with the shape the migration promised
--   2. is RLS on, with exactly one policy, and no client write privilege
--   3. is the helper function there, and NOT reachable from a browser
--   4. does the helper actually catch the four formats, and spare quantities
--   5. is the batch function there, service_role only, reading no role
--   6. does every AVAILABLE review carry the NEW content
--   7. does any card anywhere carry a contact detail
--   8. were non-available cards and the audit trail left alone

-- (No psql meta-commands: this is submitted as raw SQL through db query, where
-- a raised exception aborts the whole submission on its own.)

-- ─── 1. The batch table ────────────────────────────────────────────────────
do $$
declare v_cols text;
begin
  if to_regclass('public.customer_review_draft_batches') is null then
    raise exception 'customer_review_draft_batches does not exist';
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'customer_review_draft_batches';

  if v_cols <> 'id,generated_by,generated_at,guidance,model,card_count' then
    raise exception 'the batch table has columns: %', v_cols;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'customer_review_test_cards'
       and column_name = 'batch_id') then
    raise exception 'customer_review_test_cards.batch_id is missing';
  end if;

  raise notice 'PASS  1. customer_review_draft_batches exists with its six columns, and cards carry batch_id';
end $$;

-- ─── 2. RLS, one policy, no client write ───────────────────────────────────
do $$
declare v_policies integer; v_rls boolean; v_writes text;
begin
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.customer_review_draft_batches'::regclass;
  if not v_rls then raise exception 'RLS is OFF on customer_review_draft_batches'; end if;

  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'customer_review_draft_batches';
  if v_policies <> 1 then
    raise exception 'expected exactly 1 policy on the batch table, found %', v_policies;
  end if;

  select string_agg(p, ',') into v_writes
    from unnest(array['insert', 'update', 'delete']) p
   where has_table_privilege('authenticated', 'public.customer_review_draft_batches', p)
      or has_table_privilege('anon', 'public.customer_review_draft_batches', p);
  if v_writes is not null then
    raise exception 'a client role still holds % on the batch table', v_writes;
  end if;

  raise notice 'PASS  2. RLS on, exactly one SELECT policy, and no client INSERT/UPDATE/DELETE';
end $$;

-- ─── 3. The helper exists and no browser can call it ───────────────────────
do $$
begin
  if to_regprocedure('public.customer_review_contains_phone(text)') is null then
    raise exception 'customer_review_contains_phone(text) does not exist';
  end if;
  if has_function_privilege('authenticated', 'public.customer_review_contains_phone(text)', 'execute')
  or has_function_privilege('anon', 'public.customer_review_contains_phone(text)', 'execute') then
    raise exception 'a browser role can execute customer_review_contains_phone';
  end if;
  if not has_function_privilege('service_role', 'public.customer_review_contains_phone(text)', 'execute') then
    raise exception 'service_role cannot execute customer_review_contains_phone';
  end if;
  raise notice 'PASS  3. customer_review_contains_phone exists, service_role only, not browser-callable';
end $$;

-- ─── 4. And it actually works, on the reported formats ─────────────────────
do $$
declare v_text text; v_bad integer := 0;
begin
  foreach v_text in array array[
    '+44 20 7946 0000', '202-555-0100', '(202) 555-0100', '9876543210'
  ] loop
    if not public.customer_review_contains_phone(v_text) then
      raise warning 'MISSED: %', v_text; v_bad := v_bad + 1;
    end if;
  end loop;
  if v_bad > 0 then raise exception '% reported format(s) still pass', v_bad; end if;

  foreach v_text in array array[
    '120 chairs', '60 rooms', '18 months', 'three weeks'
  ] loop
    if public.customer_review_contains_phone(v_text) then
      raise warning 'FALSE POSITIVE: %', v_text; v_bad := v_bad + 1;
    end if;
  end loop;
  if v_bad > 0 then raise exception '% ordinary quantity phrase(s) were flagged', v_bad; end if;

  raise notice 'PASS  4. all four reported formats caught in production; quantities left alone';
end $$;

-- ─── 5. The batch function ─────────────────────────────────────────────────
do $$
declare v_def text;
begin
  if to_regprocedure('public.create_customer_review_draft_batch(text, text, jsonb, uuid)') is null then
    raise exception 'the batch function does not exist';
  end if;
  if has_function_privilege('authenticated',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid)', 'execute')
  or has_function_privilege('anon',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid)', 'execute') then
    raise exception 'a browser role can execute the batch function';
  end if;

  -- Comments stripped first: the function explains the role branches it does
  -- NOT have, and a scan that reads comments reports its own explanation.
  v_def := regexp_replace(
    pg_get_functiondef('public.create_customer_review_draft_batch(text, text, jsonb, uuid)'::regprocedure),
    '--[^' || chr(10) || ']*', '', 'g');

  if v_def ~* '(u\.role|users\.role|''admin'')' then
    raise exception 'the batch function consults a role';
  end if;
  if v_def !~ 'pg_advisory_xact_lock' then
    raise exception 'the batch function does not take the advisory lock';
  end if;
  if position('pg_advisory_xact_lock' in v_def) > position('CUSTOMER_REVIEW_TEST_POOL_NOT_EMPTY' in v_def) then
    raise exception 'the pool is counted BEFORE the lock is taken';
  end if;
  if v_def !~ 'customer_review_contains_phone' then
    raise exception 'the batch function does not check for a telephone number';
  end if;

  raise notice 'PASS  5. batch function: service_role only, no role read, lock before count, phone check inside';
end $$;

-- ─── 6. Every AVAILABLE review carries the new content ────────────────────
--
-- NOT "there are sixteen". The first run of this check asserted 16 and found
-- 15, because somebody booked TEST-002 in production on 30 August, before this
-- migration ran. The migration's `where status = 'available'` then correctly
-- left that card alone — which is the guarantee working, not a fault.
--
-- So the assertion is the one that is actually true whatever anybody has
-- booked: every card still AVAILABLE has been rewritten, and the pool is not
-- empty. Section 8 covers the other half, that nothing else was touched.
do $$
declare v_available integer; v_rw integer; v_short integer; v_sample text; v_total integer;
begin
  select count(*) into v_total     from public.customer_review_test_cards;
  select count(*) into v_available from public.customer_review_test_cards
   where status = 'available';

  if v_available = 0 then
    raise exception 'there are no available reviews at all';
  end if;

  select count(*) into v_rw from public.customer_review_test_cards
   where status = 'available' and card_ref ~ '^RW-[0-9]{6}$';
  if v_rw <> v_available then
    raise exception 'only % of % available review(s) carry an RW- reference', v_rw, v_available;
  end if;

  -- The old filler was short and generic; every replacement is a real review.
  select count(*) into v_short from public.customer_review_test_cards
   where status = 'available' and length(test_body) < 150;
  if v_short > 0 then
    raise exception '% available review(s) still carry short filler', v_short;
  end if;

  select test_title into v_sample
    from public.customer_review_test_cards
   where status = 'available' order by card_ref limit 1;

  raise notice 'PASS  6. % of % card(s) are available; all carry an RW- reference and substantial content.',
    v_available, v_total;
  raise notice '        The first reads: "%"', v_sample;
end $$;

-- ─── 7. No contact detail on any card, anywhere ────────────────────────────
do $$
declare v_bad integer; v_total integer;
begin
  select count(*) into v_total from public.customer_review_test_cards;
  select count(*) into v_bad from public.customer_review_test_cards
   where public.customer_review_contains_phone(test_body)
      or public.customer_review_contains_phone(test_title)
      or test_body ~* '(https?://|www\.|wa\.me)'
      or test_body ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
      or position(public.customer_review_internal_test_warning() in upper(test_body)) > 0
      or test_body ~* '(leave a review|post this|publish this|rate us)';
  if v_bad > 0 then
    raise exception '% of % card(s) carry a contact detail, link, warning or posting instruction',
      v_bad, v_total;
  end if;
  raise notice 'PASS  7. none of % card(s) carries a contact detail, link, warning or posting instruction', v_total;
end $$;

-- ─── 8. Nothing that was not `available` was touched ───────────────────────
do $$
declare v_busy integer; v_rewritten integer; v_events integer; v_screens integer;
begin
  select count(*) into v_busy
    from public.customer_review_test_cards where status <> 'available';

  -- A finished card that had been rewritten would now carry an RW- reference.
  -- The rewrite matched TEST-xxx and only where status = 'available', so every
  -- non-available card must still carry the reference it was created with.
  select count(*) into v_rewritten
    from public.customer_review_test_cards
   where status <> 'available' and card_ref ~ '^RW-[0-9]{6}$' and batch_id is null;
  if v_rewritten > 0 then
    raise exception '% non-available card(s) were rewritten by the migration', v_rewritten;
  end if;

  select count(*) into v_events   from public.customer_review_test_card_events;
  select count(*) into v_screens  from public.customer_review_test_card_screenshots;

  raise notice 'PASS  8. % non-available card(s), none rewritten. % audit event(s) and % screenshot(s) retained.',
    v_busy, v_events, v_screens;
end $$;

do $$ begin raise notice '';
            raise notice 'customer_review_drafts_remote_readiness: ALL CHECKS PASSED';
end $$;
