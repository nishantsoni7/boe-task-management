-- Privilege assertions for 20261014000000, under PRODUCTION-SHAPED defaults.
--
-- Run through run_payment_custody_and_modes_privileges_suite.sh, which creates
-- anon / authenticated / service_role AND the `grant all on tables` default
-- privileges a Supabase project bootstraps with, BEFORE any table is created.
-- On a bare database every one of these passes trivially; the fixture is what
-- makes them mean something.
--
-- THE CLAIM: the two objects 20261014000000 creates are readable by a signed-in
-- user, writable by none, and invisible to anon — and they are that way because
-- the migration REVOKED BY NAME, not because a local database happened to grant
-- nothing.

\set ON_ERROR_STOP on

do $$
declare
  v_name text;
  v_n    int;
begin
  -- ── 1. The custody trail: read-only for authenticated ─────────────────────
  foreach v_name in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_custody_events', v_name) then
      raise exception
        'authenticated holds % on finance_payment_custody_events. A Supabase project grants ALL on every new table, so revoking from PUBLIC and anon alone leaves this behind — revoke it BY NAME.',
        v_name;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.finance_payment_custody_events', 'select') then
    raise exception 'authenticated must keep SELECT on the custody table — the RLS policy narrows it, not the missing privilege';
  end if;

  -- ── 2. Anon holds nothing at all, read included ───────────────────────────
  foreach v_name in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('anon', 'public.finance_payment_custody_events', v_name) then
      raise exception 'anon holds % on finance_payment_custody_events', v_name;
    end if;
    if has_table_privilege('anon', 'public.finance_payment_destinations', v_name) then
      raise exception 'anon holds % on finance_payment_destinations', v_name;
    end if;
  end loop;

  -- ── 3. service_role keeps its default ALL, as on every other Finance table ──
  --
  -- Singling this table out would break the tooling that reaches every other
  -- one. The immutability trigger binds service_role anyway, which is why the
  -- privilege costs nothing.
  if not has_table_privilege('service_role', 'public.finance_payment_custody_events', 'select') then
    raise exception 'service_role lost its access to the custody table';
  end if;

  -- ── 4. RLS is on, and there is no write policy for anybody ────────────────
  if not (select relrowsecurity from pg_class
           where oid = 'public.finance_payment_custody_events'::regclass) then
    raise exception 'RLS must be enabled on finance_payment_custody_events';
  end if;

  select count(*) into v_n from pg_policies
  where schemaname = 'public' and tablename = 'finance_payment_custody_events' and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'the custody table carries % write policy/policies', v_n;
  end if;

  -- ── 5. The destination projection is readable and not writable ────────────
  if not has_table_privilege('authenticated', 'public.finance_payment_destinations', 'select') then
    raise exception 'authenticated cannot read finance_payment_destinations';
  end if;
  foreach v_name in array array['insert', 'update', 'delete'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_destinations', v_name) then
      raise exception 'authenticated holds % on the destination projection', v_name;
    end if;
  end loop;

  -- ── 6. Functions: a project's `grant all on functions` default is revoked ──
  --
  -- The internal doors and the trigger functions must be callable by NO client
  -- role. On a project they arrive granted to everybody; the migration revokes
  -- them by name, and this is what proves it did.
  foreach v_name in array array[
    'public.append_payment_custody_events_internal(uuid, jsonb, uuid)',
    'public.finance_payment_requests_enforce_current_payment_mode()',
    'public.finance_payment_custody_events_immutable()',
    'public.apply_payment_allocation_intents(uuid)'
  ] loop
    if has_function_privilege('authenticated', v_name, 'execute')
       or has_function_privilege('anon', v_name, 'execute') then
      raise exception 'the internal function % is executable by a client role', v_name;
    end if;
  end loop;

  -- The four doors a signed-in user IS meant to reach, and anon never.
  foreach v_name in array array[
    'public.append_payment_custody_events(uuid, jsonb)',
    'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)',
    'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)',
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)'
  ] loop
    if not has_function_privilege('authenticated', v_name, 'execute') then
      raise exception 'authenticated cannot call %', v_name;
    end if;
    if has_function_privilege('anon', v_name, 'execute') then
      raise exception 'anon can call %', v_name;
    end if;
  end loop;

  -- ── 7. And 20261013000000's own privilege guarantee is still standing ─────
  foreach v_name in array array['insert', 'update', 'delete'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', v_name) then
      raise exception 'authenticated regained % on the intent table', v_name;
    end if;
  end loop;

  raise notice 'ALL PRIVILEGE ASSERTIONS PASSED';
end $$;
