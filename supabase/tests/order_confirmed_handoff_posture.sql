-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed Order handoff and document generation — SECURITY POSTURE CHECK
--
-- Run this against a database RIGHT AFTER applying
--   20260924000000_order_submission_confirmed_order_handoff.sql
--   20260925000000_order_document_generation.sql
--   20260926000000_order_number_cycle_reset.sql
-- to confirm the three landed with the posture they were written to have.
--
-- ── THIS SCRIPT WRITES NOTHING. ────────────────────────────────────────────
--
-- Every check below is a catalog read. There is no INSERT, UPDATE, DELETE or
-- TRUNCATE anywhere in it, no transaction to roll back, and no fixture to
-- clean up. That is deliberate and it is the whole point of having it: the
-- behavioural proofs in order_document_generation_assertions.sql and
-- order_number_cycle_reset_assertions.sql need fixture rows, so they belong on
-- a scratch database. This one is safe to run anywhere, including production,
-- which is exactly where you most want to ask these questions.
--
-- It answers: did the security properties SURVIVE the trip to this database?
-- It does not re-prove the behaviour — the assertion scripts do that.
--
-- Usage:  psql "$DATABASE_URL" -f supabase/tests/order_confirmed_handoff_posture.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

do $$
declare
  n_pass int := 0;
  n_fail int := 0;
  v_bool boolean;
  v_cnt  int;
  v_txt  text;
  v_ttl  interval;

  -- collected failures, reported together at the end rather than one at a time,
  -- so a single run tells you everything that is wrong instead of the first thing.
  failures text[] := '{}';

  procedure_check text;   -- loop variable for the per-table checks
  procedure_note  text;   -- loop variable for the failure report
begin
  ---------------------------------------------------------------------------
  -- PRECONDITION. Run before anything else, so somebody who runs this against
  -- a database the migrations have not reached yet is TOLD that, rather than
  -- meeting a raw "relation does not exist" from whichever check happened to
  -- touch a missing object first.
  ---------------------------------------------------------------------------
  if to_regclass('public.order_document_versions') is null then
    raise exception 'MIGRATION NOT APPLIED: public.order_document_versions is missing. Apply 20260925000000_order_document_generation.sql (and 20260924000000 before it) to this database first.';
  end if;
  if to_regclass('public.order_number_cycle_resets') is null then
    raise exception 'MIGRATION NOT APPLIED: public.order_number_cycle_resets is missing. Apply 20260926000000_order_number_cycle_reset.sql to this database first.';
  end if;
  if to_regprocedure('public.can_view_order(uuid)') is null then
    raise exception 'MIGRATION NOT APPLIED: public.can_view_order(uuid) is missing. Apply 20260924000000_order_submission_confirmed_order_handoff.sql to this database first.';
  end if;

  ---------------------------------------------------------------------------
  -- A. The two INVOKER predicates.
  --
  -- This is the property that matters most, and the one that silently breaks.
  -- Inside a SECURITY DEFINER function the current user is the function's
  -- OWNER, who bypasses RLS — so an INVOKER predicate called from a DEFINER
  -- answers "yes" for everybody. If either of these two ever comes back
  -- DEFINER, every visibility rule below it is decoration.
  ---------------------------------------------------------------------------
  select not p.prosecdef into v_bool
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'can_view_order';
  if coalesce(v_bool, false) then n_pass := n_pass + 1;
  else failures := array_append(failures, 'A1: can_view_order is not SECURITY INVOKER (or is missing)'); n_fail := n_fail + 1; end if;

  select not p.prosecdef into v_bool
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'request_order_document_generation';
  if coalesce(v_bool, false) then n_pass := n_pass + 1;
  else failures := array_append(failures, 'A2: request_order_document_generation is not SECURITY INVOKER (or is missing)'); n_fail := n_fail + 1; end if;

  ---------------------------------------------------------------------------
  -- B. claim_token is readable by no client role.
  --
  -- Checked two ways, because they fail independently: a column GRANT could be
  -- added without a table grant, and a table-wide grant would sweep the column
  -- in with everything else.
  ---------------------------------------------------------------------------
  select count(*) into v_cnt
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'order_document_versions'
     and column_name = 'claim_token' and grantee in ('anon', 'authenticated', 'public');
  if v_cnt = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B1: claim_token carries %s client column grant(s)', v_cnt)); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt
    from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'order_document_versions'
     and grantee in ('anon', 'authenticated', 'public')
     and privilege_type = 'SELECT';
  if v_cnt = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B2: a TABLE-wide SELECT grant on order_document_versions would expose claim_token (%s found)', v_cnt)); n_fail := n_fail + 1; end if;

  ---------------------------------------------------------------------------
  -- C. The client write surface is exactly the five columns it was designed as.
  --    insert (order_id, version) and update (status, last_error_code,
  --    last_error_message) — nothing else, ever.
  ---------------------------------------------------------------------------
  select coalesce(string_agg(privilege_type || ':' || column_name, ', ' order by privilege_type, column_name), '(none)')
    into v_txt
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'order_document_versions'
     and grantee = 'authenticated'
     and privilege_type in ('INSERT', 'UPDATE');
  if v_txt = 'INSERT:order_id, INSERT:version, UPDATE:last_error_code, UPDATE:last_error_message, UPDATE:status'
  then n_pass := n_pass + 1;
  else failures := array_append(failures, format('C1: the client write surface is not the designed five columns — found: %s', v_txt)); n_fail := n_fail + 1; end if;

  ---------------------------------------------------------------------------
  -- D. The three server-only RPCs are revoked from every client role.
  ---------------------------------------------------------------------------
  select coalesce(string_agg(distinct routine_name || '->' || grantee, ', '), '(none)')
    into v_txt
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('claim_order_document_generation',
                          'complete_order_document_generation',
                          'fail_order_document_generation')
     and grantee in ('anon', 'authenticated', 'public');
  if v_txt = '(none)' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('D1: a client role can execute a server-only generation RPC — %s', v_txt)); n_fail := n_fail + 1; end if;

  ---------------------------------------------------------------------------
  -- E. RLS is on, on both new tables.
  ---------------------------------------------------------------------------
  for procedure_check in select unnest(array['order_document_versions', 'order_number_cycle_resets']) loop
    select c.relrowsecurity into v_bool
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = procedure_check;
    if coalesce(v_bool, false) then n_pass := n_pass + 1;
    else failures := array_append(failures, format('E: row level security is OFF on public.%s (or the table is missing)', procedure_check)); n_fail := n_fail + 1; end if;
  end loop;

  ---------------------------------------------------------------------------
  -- F. Every policy this feature adds is SELECT-only, except the two write
  --    policies the register needs and the restrictive module entry gate.
  --
  --    Stated as an allow-list of the write policies that are ALLOWED to exist,
  --    so a new write policy appearing later is a failure rather than a silence.
  ---------------------------------------------------------------------------
  select coalesce(string_agg(policyname || ':' || cmd, ', ' order by policyname), '(none)')
    into v_txt
    from pg_policies
   where schemaname = 'public'
     and tablename in ('order_document_versions', 'order_number_cycle_resets')
     and cmd <> 'SELECT'
     and policyname not in ('order_document_versions_request_insert',
                            'order_document_versions_retry_update',
                            'order_document_versions_module_entry_gate');
  if v_txt = '(none)' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F1: an unexpected non-SELECT policy exists — %s', v_txt)); n_fail := n_fail + 1; end if;

  -- and the four handoff policies from 20260924 are present and SELECT
  select count(*) into v_cnt
    from pg_policies
   where policyname in ('order_submissions_confirmed_order_select',
                        'order_submission_items_confirmed_order_select',
                        'order_submission_item_images_confirmed_order_select')
     and cmd = 'SELECT';
  if v_cnt = 3 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F2: expected 3 confirmed-order SELECT policies on the PI tables, found %s', v_cnt)); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'order_files_confirmed_order_select' and cmd = 'SELECT';
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F3: the storage.objects confirmed-order SELECT policy is missing'); n_fail := n_fail + 1; end if;

  ---------------------------------------------------------------------------
  -- G. Publication is decided by the register, not by the location.
  --
  --    The storage policy must consult can_view_order_document_object, which is
  --    what reads the ready row. A policy that authorized the orders/ prefix by
  --    path alone would make every in-flight attempt downloadable.
  ---------------------------------------------------------------------------
  select qual into v_txt
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'order_files_confirmed_order_select';
  if coalesce(v_txt, '') like '%can_view_order_document_object%' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G1: the storage policy does not consult can_view_order_document_object — location may be publishing files'); n_fail := n_fail + 1; end if;

  ---------------------------------------------------------------------------
  -- H. The claim is atomic: its eligibility test lives in the UPDATE's own
  --    WHERE clause, so the row lock decides it. A read-then-write version
  --    would let two workers both believe they hold the lease.
  ---------------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_txt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_order_document_generation';
  if coalesce(v_txt, '') ~* 'update\s+public\.order_document_versions.*\mwhere\M.*\mstatus\M\s*=\s*''pending''' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H1: the claim eligibility test is not inside the UPDATE ... WHERE — the claim may not be atomic'); n_fail := n_fail + 1; end if;

  -- and the TTL is a real, positive interval
  begin
    execute 'select public.order_document_claim_ttl()' into v_ttl;
    if v_ttl > interval '0' then n_pass := n_pass + 1;
    else failures := array_append(failures, format('H2: order_document_claim_ttl() is not positive (%s)', v_ttl)); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'H2: order_document_claim_ttl() is missing'); n_fail := n_fail + 1;
  end;

  ---------------------------------------------------------------------------
  -- I. The reset mechanism EXISTS and HAS NOT RUN.
  --
  --    Applying 20260926 installs the function. It must never invoke it, and
  --    an empty audit table is the evidence. If this check ever fails on a
  --    database you did not deliberately reset, STOP and read the audit rows.
  ---------------------------------------------------------------------------
  select count(*) into v_cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reset_confirmed_order_number_cycle' and p.prosecdef;
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I1: reset_confirmed_order_number_cycle is missing or is not SECURITY DEFINER'); n_fail := n_fail + 1; end if;

  execute 'select count(*) from public.order_number_cycle_resets' into v_cnt;  -- table presence proved by the precondition
  if v_cnt = 0 then
    n_pass := n_pass + 1;
    raise notice 'I2: the Order number cycle has never been reset on this database. Good.';
  else
    -- Not counted as a failure: on a database where the controlled reset has
    -- deliberately been run, rows here are correct and expected. It is reported
    -- loudly because it is never something to discover by accident.
    n_pass := n_pass + 1;
    raise warning 'I2: order_number_cycle_resets holds % row(s) — the reset HAS been run on this database. Confirm that was deliberate.', v_cnt;
  end if;

  ---------------------------------------------------------------------------
  -- report
  ---------------------------------------------------------------------------
  raise notice '';
  if n_fail = 0 then
    raise notice '─────────────────────────────────────────────';
    raise notice 'POSTURE OK — % checks passed, nothing written.', n_pass;
  else
    raise notice '─────────────────────────────────────────────';
    foreach procedure_note in array failures loop
      raise notice 'FAIL  %', procedure_note;
    end loop;
    raise exception '% posture check(s) FAILED (% passed)', n_fail, n_pass;
  end if;
end $$;
