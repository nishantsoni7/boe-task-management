-- ═════════════════════════════════════════════════════════════════════════════
-- REMOTE READINESS — Review Workflow Test (Internal)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- READ-ONLY. Every statement below is a SELECT. There is no INSERT, UPDATE,
-- DELETE, TRUNCATE, CREATE, ALTER, DROP, GRANT or REVOKE anywhere in this file,
-- and a source-contract test asserts their absence rather than trusting this
-- paragraph. It is safe to run against production, which is the entire point:
-- the checks that matter most are the ones nobody hesitates to run.
--
-- WHAT IT IS FOR
-- --------------
-- Confirming, from outside, that a database carries the module the way the
-- repository says it should — before the schema migration, after it, and after
-- the seed. It answers "is this deployment in the state I think it is" without
-- changing the answer by asking.
--
--   HOW TO RUN
--     psql "$CONNECTION_STRING" -v ON_ERROR_STOP=1 -v expected_cards=0 \
--       -f supabase/tests/customer_review_remote_readiness.sql
--
--   expected_cards is REQUIRED and is the one thing that changes between runs:
--     0   before the seed migration has been applied
--     16  after it
--
--   There is no default on purpose. A default would let somebody run this
--   without deciding which state they expect, and "it passed" would then mean
--   nothing.
--
-- WHAT A FAILURE LOOKS LIKE
-- -------------------------
-- A raised exception naming the check. With ON_ERROR_STOP=1 psql exits
-- non-zero, so this drops straight into a deployment script. Nothing is
-- written either way.

-- REQUIRED, and enforced by RAISING rather than by \quit.
--
-- \quit accepts no exit code — it ignores one and exits 0 — so a guard written
-- with it prints a warning and then reports success. Raising from SQL is what
-- ON_ERROR_STOP=1 turns into a non-zero exit, which is the only kind of failure
-- a deployment script can see.
\if :{?expected_cards}
\else
  do $missing$ begin
    raise exception 'expected_cards is required: pass -v expected_cards=0 (before the seed) or 16 (after). Nothing was checked.';
  end $missing$;
\endif

do $$
declare
  v_n        integer;
  v_txt      text;
  v_bad      text;
begin
  raise notice '── Review Workflow Test — remote readiness ──────────────────────';
  raise notice 'database: %', current_database();

  -- ── 1. SCHEMA ────────────────────────────────────────────────────────────
  for v_txt in select unnest(array[
        'customer_review_test_cards',
        'customer_review_test_card_screenshots',
        'customer_review_test_card_events'])
  loop
    if to_regclass('public.' || v_txt) is null then
      raise exception 'MISSING TABLE: public.%', v_txt;
    end if;
  end loop;
  raise notice 'PASS  1a. all three tables exist';

  -- The recipient column holds four digits, and the fingerprint column that
  -- once sat beside it is gone.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customer_review_test_cards'
      and column_name = 'whatsapp_target_last_four') then
    raise exception 'MISSING COLUMN: whatsapp_target_last_four';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customer_review_test_cards'
      and column_name = 'whatsapp_target_fingerprint') then
    raise exception 'THE FINGERPRINT COLUMN IS BACK: whatsapp_target_fingerprint';
  end if;

  -- NO COLUMN ANYWHERE IN THE MODULE LOOKS LIKE CONTACT DATA.
  select string_agg(c.relname || '.' || a.attname, ', ') into v_bad
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'customer_review%'
    and a.attnum > 0 and not a.attisdropped
    and a.attname <> 'whatsapp_target_last_four'
    and (a.attname ~* '(customer_name|customer_phone|whatsapp_number|contact_|review_url|google)');
  if v_bad is not null then
    raise exception 'CONTACT-LOOKING COLUMNS: %', v_bad;
  end if;
  raise notice 'PASS  1b. four digits kept, no fingerprint column, no contact column';

  -- ── 2. PERMISSION ROWS ───────────────────────────────────────────────────
  if not exists (select 1 from public.permission_modules
                 where module_key = 'customer_review_requests') then
    raise exception 'THE PERMISSION MODULE IS NOT REGISTERED';
  end if;

  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions pa  on pa.id = mpa.action_id
  where pm.module_key = 'customer_review_requests'
    and pa.action_key in ('use', 'verify');
  if v_n <> 2 then
    raise exception 'the module registers % of its 2 actions', v_n;
  end if;

  -- Both deny by default: the engine grants, the registration does not.
  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  where pm.module_key = 'customer_review_requests' and mpa.default_allowed;
  if v_n <> 0 then
    raise exception '% action(s) are allowed by default; both must deny', v_n;
  end if;
  raise notice 'PASS  2a. module registered, both actions present, both deny by default';

  -- ── 3. THE ROLE SEED — what gives an administrator access ────────────────
  select count(*) into v_n
  from public.role_permissions rp
  join public.permission_modules pm on pm.id = rp.module_id
  join public.permission_actions pa on pa.id = rp.action_id
  where pm.module_key = 'customer_review_requests'
    and rp.role = 'admin' and rp.allowed
    and pa.action_key in ('use', 'verify');
  if v_n <> 2 then
    raise exception 'the admin role seed grants % of 2 actions; ordinary administrators would lose access', v_n;
  end if;

  -- …and no other role is seeded. Who tests and who verifies is a per-person
  -- decision made in Control Center, not something a role name confers.
  select string_agg(distinct rp.role::text, ', ') into v_bad
  from public.role_permissions rp
  join public.permission_modules pm on pm.id = rp.module_id
  where pm.module_key = 'customer_review_requests' and rp.role <> 'admin';
  if v_bad is not null then
    raise exception 'unexpected role seed(s): %', v_bad;
  end if;
  raise notice 'PASS  3a. admin holds both from the seed; no other role is seeded';

  -- ── 4. RLS AND POLICIES ──────────────────────────────────────────────────
  for v_txt in select unnest(array[
        'customer_review_test_cards',
        'customer_review_test_card_screenshots',
        'customer_review_test_card_events'])
  loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = v_txt and c.relrowsecurity) then
      raise exception 'RLS IS NOT ENABLED on public.%', v_txt;
    end if;
  end loop;

  -- NO CLIENT WRITE POLICY ANYWHERE. Every mutation goes through a definer
  -- function; a policy admitting INSERT, UPDATE or DELETE would be a second
  -- door.
  select string_agg(tablename || '.' || policyname || ' (' || cmd || ')', ', ') into v_bad
  from pg_policies
  where schemaname = 'public' and tablename like 'customer_review%'
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_bad is not null then
    raise exception 'CLIENT WRITE POLICIES EXIST: %', v_bad;
  end if;
  raise notice 'PASS  4a. RLS on all three tables, and every policy is SELECT-only';

  -- ── 5. THE DEFINER FUNCTIONS ─────────────────────────────────────────────
  for v_txt in select unnest(array[
        'can_use_customer_review_test_cards',
        'can_view_customer_review_test_card_row',
        'can_view_customer_review_test_card',
        'book_customer_review_test_card',
        'transition_customer_review_test_card',
        'confirm_customer_review_test_card_sent',
        'begin_customer_review_test_screenshot_removal',
        'finish_customer_review_test_screenshot_removal',
        'record_customer_review_test_card_whatsapp_opened',
        'customer_review_internal_test_warning'])
  loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = v_txt) then
      raise exception 'MISSING FUNCTION: public.%', v_txt;
    end if;
  end loop;
  raise notice 'PASS  5a. all ten functions exist';

  -- TWO SEPARATE PROPERTIES, checked separately because they are not the same
  -- requirement and one function legitimately has only the first.
  --
  -- (a) EVERY function is path-pinned. An unpinned search_path is how a
  --     definer function gets tricked into resolving a name somewhere else.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%customer_review%'
    and p.prokind = 'f'
    and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%';
  if v_bad is not null then
    raise exception 'NOT PATH-PINNED: %', v_bad;
  end if;

  -- (b) Every function that TOUCHES A TABLE is definer-rights.
  --
  --     customer_review_internal_test_warning() is deliberately NOT, and that
  --     is correct rather than an oversight: it is an immutable one-line
  --     constant returning the mandatory label. It reads nothing, so definer
  --     rights would hand it privilege it has no use for. Naming the exception
  --     here keeps the rule exact instead of loosening it to fit.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%customer_review%'
    and p.prokind = 'f'
    and p.proname <> 'customer_review_internal_test_warning'
    and not p.prosecdef;
  if v_bad is not null then
    raise exception 'NOT DEFINER-RIGHTS: %', v_bad;
  end if;

  -- …and the exception really is the constant it claims to be.
  if (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'customer_review_internal_test_warning') then
    raise exception 'the label constant became SECURITY DEFINER; it needs no privilege';
  end if;
  raise notice 'PASS  5b. all path-pinned; all table-touching ones are SECURITY DEFINER';

  -- ── 6. NO ADMINISTRATOR-ROLE BYPASS ──────────────────────────────────────
  --
  -- The property the whole authorization correction turns on: the permission
  -- engine is the only source of authority, so no function may read a role.
  -- COMMENTS ARE STRIPPED FIRST, and that is not a detail.
  --
  -- pg_get_functiondef returns the whole source, comments included, and these
  -- functions EXPLAIN the branch that was removed — "u.role = 'admin' or used
  -- to lead this disjunction". Scanning the raw text therefore reports a bypass
  -- in exactly the three functions that had one taken out, which is the
  -- opposite of the truth. A check that fails on its own explanation would
  -- teach people to delete the explanation.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%customer_review%'
    and regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
        ~* '(u\.role|users\.role|''admin'')';
  if v_bad is not null then
    raise exception 'ADMINISTRATOR-ROLE BYPASS PRESENT IN EXECUTABLE SQL: %', v_bad;
  end if;

  -- …and each still ASKS the engine, so this cannot pass by having deleted the
  -- authorization instead of the bypass.
  select string_agg(t.fname, ', ') into v_bad from (
    select unnest(array[
      'can_use_customer_review_test_cards',
      'can_view_customer_review_test_card_row',
      'can_view_customer_review_test_card',
      'book_customer_review_test_card',
      'transition_customer_review_test_card',
      'confirm_customer_review_test_card_sent',
      'begin_customer_review_test_screenshot_removal',
      'record_customer_review_test_card_whatsapp_opened']) as fname
  ) t
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = t.fname
      and pg_get_functiondef(p.oid) like '%resolve_permission%');
  if v_bad is not null then
    raise exception 'THESE ASK THE ENGINE NOTHING: %', v_bad;
  end if;
  raise notice 'PASS  6a. no function reads a role, and every one resolves a permission';

  -- ── 7. THE PARTIAL UNIQUE INDEXES ────────────────────────────────────────
  for v_txt in select unnest(array[
        'customer_review_screenshot_one_live_per_card',
        'customer_review_screenshot_unique_live_content'])
  loop
    select indexdef into v_bad from pg_indexes where indexname = v_txt;
    if v_bad is null then
      raise exception 'MISSING INDEX: %', v_txt;
    end if;
    if v_bad !~ 'UNIQUE' then
      raise exception 'INDEX % IS NOT UNIQUE: %', v_txt, v_bad;
    end if;
    if v_bad !~ 'removal_started_at IS NULL' then
      raise exception 'INDEX % IS NOT PARTIAL: %', v_txt, v_bad;
    end if;
  end loop;
  raise notice 'PASS  7a. both uniqueness rules exist, unique and partial';

  -- ── 8. GRANTS ────────────────────────────────────────────────────────────
  -- The recorder takes an actor id, so a browser must not be able to call it.
  if has_function_privilege('authenticated',
       'public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)', 'EXECUTE') then
    raise exception 'A BROWSER ROLE CAN CALL THE WHATSAPP RECORDER';
  end if;
  if not has_function_privilege('service_role',
       'public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)', 'EXECUTE') then
    raise exception 'service_role cannot call the recorder; the trusted route would break';
  end if;

  -- No browser-callable function accepts an acting-user id.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%customer_review%'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and pg_get_function_arguments(p.oid) ~* '(p_user_id|p_actor_id|p_acting)';
  if v_n <> 0 then
    raise exception '% browser-callable function(s) accept an acting-user id', v_n;
  end if;
  raise notice 'PASS  8a. the recorder is service_role-only; no browser function takes an actor';

  -- ── 9. THE PRIVATE BUCKET ────────────────────────────────────────────────
  if not exists (select 1 from storage.buckets
                 where id = 'customer-review-test-screenshots' and public = false) then
    raise exception 'THE SCREENSHOT BUCKET IS MISSING OR PUBLIC';
  end if;

  select string_agg(policyname || ' (' || cmd || ')', ', ') into v_bad
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'customer_review_test%' and cmd <> 'SELECT';
  if v_bad is not null then
    raise exception 'THE BUCKET HAS NON-SELECT CLIENT POLICIES: %', v_bad;
  end if;
  raise notice 'PASS  9a. the bucket is private and SELECT-only for clients';

  -- ── 10. THE CARDS, as an invariant rather than a count ───────────────────
  --
  -- The TOTAL is checked at psql level below, because it is the one thing that
  -- differs between a pre-seed and a post-seed run. What is checked here needs
  -- no parameter and is the more useful property: a deployment that has any
  -- cards at all must have all sixteen, and every one of them must be clean.
  -- Partial seeding is the failure this catches.
  select count(*) into v_n from public.customer_review_test_cards;
  if v_n > 0 then
    select count(*) into v_n from public.customer_review_test_cards
     where card_ref ~ '^TEST-0(0[1-9]|1[0-6])$';
    if v_n <> 16 then
      raise exception 'the deployment is PARTIALLY seeded: % of the 16 refs are present', v_n;
    end if;

    -- None carries the mandatory label in its body: that belongs to the message
    -- builder, where nobody can edit it out.
    select count(*) into v_n from public.customer_review_test_cards
     where position(public.customer_review_internal_test_warning() in upper(test_body)) <> 0;
    if v_n <> 0 then
      raise exception '% card(s) carry the label in the body', v_n;
    end if;

    -- And no card body looks like contact data or a link.
    select string_agg(card_ref, ', ') into v_bad
    from public.customer_review_test_cards
    where test_body ~* '(https?://|www\.|@[a-z0-9.-]+\.[a-z]{2,}|\+[0-9]{8,})';
    if v_bad is not null then
      raise exception 'card(s) contain a link, address or number: %', v_bad;
    end if;
    raise notice 'PASS  10a. all 16 refs present, none labelled in-body, none carrying contact data';
  else
    raise notice 'PASS  10a. no cards present (the module ships empty until the seed is applied)';
  end if;

  raise notice '── SCHEMA CHECKS PASSED. Nothing was written. ───────────────────';
end $$;

-- ── 11. THE EXPECTED COUNT ──────────────────────────────────────────────────
--
-- Compared here rather than inside the block above because psql substitutes
-- :vars in ordinary statements but NOT inside a dollar-quoted body. Doing it at
-- this level also keeps the file genuinely read-only: there is no temp table to
-- carry the value in, and nothing is created to hold it.
select
  count(*)                        as actual_cards,
  count(*) = :expected_cards      as count_matches
from public.customer_review_test_cards \gset

\if :count_matches
  \echo 'PASS  11a. card count matches the expected value'
  \echo ''
  \echo '── ALL READINESS CHECKS PASSED. Nothing was written. ────────────'
\else
  -- The NUMBERS are echoed by psql, which substitutes :vars in \echo but not
  -- inside a dollar-quoted body; the RAISE that follows is what produces the
  -- non-zero exit. Two steps, because each does the half the other cannot.
  \echo ''
  \echo 'FATAL: the card count does not match what was expected.'
  \echo '       actual:' :actual_cards '  expected:' :expected_cards
  do $mismatch$ begin
    raise exception 'card count does not match the expected value (see above). Nothing was written.';
  end $mismatch$;
\endif
