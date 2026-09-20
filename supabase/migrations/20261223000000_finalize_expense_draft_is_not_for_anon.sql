-- ═══════════════════════════════════════════════════════════════════════════
-- 20261223000000 — finalize_expense_draft is not for anon
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ONE STATEMENT OF SUBSTANCE, and it closes a gap that the previous migration
-- intended to close and did not.
--
-- ── WHAT WENT WRONG ────────────────────────────────────────────────────────
--
-- 20261222000000 §3 ended with what looks like the right pair:
--
--     revoke all on function public.finalize_expense_draft(...) from public;
--     grant execute on function public.finalize_expense_draft(...) to authenticated;
--
-- `from public` removes the grant held by the PSEUDO-ROLE public. It does NOT
-- remove the SEPARATE, EXPLICIT grants that Supabase's project bootstrap hands
-- to anon, authenticated and service_role through
-- `alter default privileges in schema public grant all on functions to ...`,
-- which fire the moment the function is created. So the function shipped with
-- EXECUTE granted to anon, and the post-deployment schema dump showed it:
--
--     GRANT ALL ON FUNCTION "public"."finalize_expense_draft"(...) TO "anon";
--
-- Every comparable Finance RPC — record_payment_with_allocations,
-- submit_payment_request, allocate_payment_to_target, reverse_payment_allocation
-- — is granted to authenticated and service_role only. This one was the
-- exception, and it was the exception by accident.
--
-- ── WHAT WAS NEVER AT RISK ─────────────────────────────────────────────────
--
-- Nothing. This is a tightening, not a fix for an exploit, and the distinction
-- is worth stating precisely rather than overstating in either direction:
--
--   * The FIRST executable statement of the function is
--     `if v_actor is null then raise ... using errcode = '42501'`. An anon
--     caller has no auth.uid(), so it is refused before a single row is read
--     or locked.
--   * The second is `module_entry_open('finance')`, which an anon caller also
--     fails.
--   * The third is finance.create through actor_has_module_permission, which
--     an anon caller also fails.
--   * public.expenses and public.expense_drafts are both under a RESTRICTIVE
--     module-entry policy declared `TO authenticated`. An anon caller is
--     covered by no permissive policy on either table, so RLS default-denies
--     every command independently of this function.
--
-- Four independent refusals stood in front of a grant that should not have
-- existed. The grant is removed anyway, because "it is unreachable" is a
-- property of today's function body and "the role cannot execute it" is a
-- property of the database — and 20261222000000 itself argued exactly that
-- distinction when it revoked DELETE from the client roles rather than
-- continuing to rely on the absence of a policy. The same reasoning applies to
-- its own door.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- The function BODY is not redefined — this file contains no CREATE FUNCTION,
-- so the bytes production is running are the bytes it keeps running. No table,
-- no column, no policy, no trigger, no index and no row is altered, and there
-- is NO DML of any kind. service_role and authenticated keep exactly what they
-- have.
--
-- THE TABLE GRANTS ARE DELIBERATELY LEFT ALONE. anon also holds
-- SELECT/INSERT/UPDATE on public.expenses, public.expense_categories and
-- public.expense_drafts from the same bootstrap — as it has on public.expenses
-- since 20261220000000 shipped, and as it does on most tables in this schema.
-- RLS denies anon every row on all three (no permissive policy names it, and
-- the restrictive gate is TO authenticated), and narrowing them is a
-- schema-wide question about this project's bootstrap rather than something
-- this feature should decide unilaterally. What this file corrects is the one
-- place where the expense feature is out of step with its OWN module's
-- convention.
--
-- DEPENDENCIES: 20261222000000 (finalize_expense_draft).
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20261222000000 (finalize_expense_draft) must be applied first';
  end if;
end $$;

-- `from public, anon, authenticated` — the shape every other revoke in this
-- repository uses (20261018000000, and the pattern the four payment doors
-- follow), and the shape that actually reaches the bootstrap's explicit grants.
revoke all on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)
  to authenticated;


-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful.

do $$
declare
  v_fn oid := to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)')::oid;
begin
  if has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'expense finalize grant: anon can still execute finalize_expense_draft';
  end if;
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'expense finalize grant: authenticated LOST execute — the door is now closed to the app';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'expense finalize grant: service_role lost execute';
  end if;

  -- AND THE BODY IS UNCHANGED. If a later edit to this file adds a
  -- CREATE FUNCTION, this stops being true and somebody has to say why.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_expense_draft'
      and p.prosecdef
      and p.prosrc like '%for update%'
      and p.prosrc like '%''created'', false%'
  ) then
    raise exception 'expense finalize grant: the function body is not the one 20261222000000 deployed';
  end if;

  -- Nothing else moved: still no DELETE policy anywhere on the expense tables.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('expense_categories', 'expenses', 'expense_drafts')
      and cmd in ('DELETE', 'ALL')
      and permissive = 'PERMISSIVE'
  ) then
    raise exception 'expense finalize grant: a permissive DELETE/ALL policy appeared on an expense table';
  end if;
end $$;
