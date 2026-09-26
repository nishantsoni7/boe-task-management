-- ═══════════════════════════════════════════════════════════════════════════
-- 20270126000000 — the permission resolvers are not for anon
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SIX REVOKES AND SIX RESTATED GRANTS. A signed-out caller can no longer ask
-- the database who may do what.
--
-- ── WHAT IS OPEN IN PRODUCTION ─────────────────────────────────────────────
--
-- These six SECURITY DEFINER functions carry EXECUTE for PUBLIC, and so for
-- `anon` (read 2026-09-25, SELECT-only; ACL `=X/postgres … anon=X/postgres`):
--
--   has_permission(uuid, text)
--   module_entry_open(text)
--   resolve_effective_permissions(uuid, text)
--   resolve_effective_permissions_for_user(uuid)
--   resolve_permission(uuid, text, text)
--   sample_tracking_module_open()
--
-- Given any user's uuid, a caller holding only the public key could read that
-- user's permission map through resolve_effective_permissions_for_user(), or
-- probe it through resolve_permission() and has_permission(). That is who can
-- approve payments, who administers Orders and so on. It is not a write, but
-- it is exactly the reconnaissance a targeted attack starts with, and nothing
-- that runs signed out needs it. (Found by the 20270125000000 audit, #212.)
--
-- ── WHY REVOKING IT BREAKS NOTHING ─────────────────────────────────────────
--
-- Read from production on 2026-09-25 (SELECT-only):
--
--   * RLS. All 92 policies that call any of the six are TO authenticated.
--     A policy for another role is never evaluated for anon, so no anon read
--     reaches these functions through RLS.
--   * Other functions. All 84 functions that call one of the six are SECURITY
--     DEFINER, so they call it as postgres, whatever role called THEM. That
--     includes actor_has_module_permission(text, text) and
--     actor_has_permission(text, text), which anon can still execute. They
--     answer false for anon (no auth.uid()) and are unchanged here.
--   * No view, CHECK constraint, column default or pg_cron job names any of
--     the six.
--   * The app. Every call site in src/ runs with a signed-in session or with
--     the service-role client; see the PR for the per-call-site table.
--
-- authenticated and service_role keep the grants they hold now. Those grants
-- are restated so that this file does not depend on how the PUBLIC grant and
-- the explicit ones were layered.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- No body, no search_path (20270125000000 does that), no policy, no table and
-- no DML. Only these six ACLs change.
--
-- ORDERING. Numbered after 20270125000000 (#212). Both sort after
-- 20270122000000, the newest migration applied to production on 2026-09-26,
-- and after #236 (20270123000000) and #214 (20270124000000). This file was
-- first 20270107000000, then 20270119000000, then 20270123000000.
-- 20270125000000's apply-time assertion requires `authenticated` to keep
-- EXECUTE on all six, and this file keeps it.
--
-- DEPENDENCIES: 20260634 (has_permission), 20260660 / 20260661 / 20260662
-- (resolve_permission, resolve_effective_permissions[_for_user]), 20260904000000
-- (sample_tracking_module_open), 20260905000000 (module_entry_open).
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.has_permission(uuid, text)',
    'public.module_entry_open(text)',
    'public.resolve_effective_permissions(uuid, text)',
    'public.resolve_effective_permissions_for_user(uuid)',
    'public.resolve_permission(uuid, text, text)',
    'public.sample_tracking_module_open()'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'DEPENDENCY MISSING: % does not exist', v_fn;
    end if;
  end loop;
end $$;


-- ═══ 1. Not for anon ════════════════════════════════════════════════════════
--
-- `from public, anon`: PUBLIC is where anon's access actually comes from, and
-- the explicit anon grant from Supabase's default privileges is removed too.

revoke execute on function public.has_permission(uuid, text)                   from public, anon;
revoke execute on function public.module_entry_open(text)                      from public, anon;
revoke execute on function public.resolve_effective_permissions(uuid, text)    from public, anon;
revoke execute on function public.resolve_effective_permissions_for_user(uuid) from public, anon;
revoke execute on function public.resolve_permission(uuid, text, text)         from public, anon;
revoke execute on function public.sample_tracking_module_open()                from public, anon;


-- ═══ 2. Still for the signed-in user and the server ═════════════════════════

grant execute on function public.has_permission(uuid, text)                   to authenticated, service_role;
grant execute on function public.module_entry_open(text)                      to authenticated, service_role;
grant execute on function public.resolve_effective_permissions(uuid, text)    to authenticated, service_role;
grant execute on function public.resolve_effective_permissions_for_user(uuid) to authenticated, service_role;
grant execute on function public.resolve_permission(uuid, text, text)         to authenticated, service_role;
grant execute on function public.sample_tracking_module_open()                to authenticated, service_role;


-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful.

do $$
declare
  v_fn  text;
  v_oid oid;
  v_bad text;
begin
  foreach v_fn in array array[
    'public.has_permission(uuid, text)',
    'public.module_entry_open(text)',
    'public.resolve_effective_permissions(uuid, text)',
    'public.resolve_effective_permissions_for_user(uuid)',
    'public.resolve_permission(uuid, text, text)',
    'public.sample_tracking_module_open()'
  ] loop
    v_oid := to_regprocedure(v_fn)::oid;
    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception 'resolvers not for anon: anon can still execute %', v_fn;
    end if;
    if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'resolvers not for anon: PUBLIC still holds EXECUTE on %', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'resolvers not for anon: authenticated LOST %; every module gate would refuse everyone', v_fn;
    end if;
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'resolvers not for anon: service_role LOST %; server routes would fail', v_fn;
    end if;
  end loop;

  -- NOTHING anon CAN REACH STILL NEEDS THEM. A policy for anon or PUBLIC that
  -- calls one would now raise "permission denied" on an anon read instead of
  -- filtering it. Checked across every schema, so a policy added by a
  -- migration this file does not know about is caught here.
  select string_agg(pol.schemaname || '.' || pol.tablename || ':' || pol.policyname, ', ')
    into v_bad
    from pg_policies pol
   where (pol.roles && array['public', 'anon']::name[])
     and coalesce(pol.qual, '') || coalesce(pol.with_check, '')
         ~ '(has_permission|module_entry_open|resolve_effective_permissions|resolve_effective_permissions_for_user|resolve_permission|sample_tracking_module_open)\(';
  if v_bad is not null then
    raise exception 'resolvers not for anon: policies for anon/public call a resolver: %', v_bad;
  end if;

  -- AND NO INVOKER FUNCTION anon MAY CALL WOULD NOW HIT THE REVOKE ON ITS WAY
  -- THROUGH. The same shape as the defect 20270117000000 fixed.
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.prosrc ~ '(has_permission|module_entry_open|resolve_effective_permissions|resolve_effective_permissions_for_user|resolve_permission|sample_tracking_module_open)\(';
  if v_bad is not null then
    raise exception 'resolvers not for anon: invoker functions anon can call reach a resolver: %', v_bad;
  end if;
end $$;
