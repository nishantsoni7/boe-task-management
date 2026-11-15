-- ════════════════════════════════════════════════════════════════════════════
-- 20270719000000 — Payment Requests: the four tab badges counted in ONE call
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE ASK (owner, 2026-11-15, page speed): "Fold the Finance counter reads" (option 1, a read-only database
-- function). The Payment Requests page counted its four tab badges (Pending, Clarification, Rejected, Archive)
-- with four separate head-only requests. This answers all four in one.
--
-- WHAT IS ADDED, and nothing wider:
--   finance_payment_request_tab_counts(timestamptz) — four counts over public.finance_payment_requests, the
--   SAME rules as the page's four queries (src/app/finance/paymentRequestsQuery.ts):
--     scope      status IN ('pending_approval','needs_clarification','rejected')   (REQUEST_STAGE_STATUSES)
--     pending    status = 'pending_approval'
--     clarif.    status = 'needs_clarification'
--     rejected   status = 'rejected' AND NOT archived
--     archive    status = 'rejected' AND coalesce(rejected_at, updated_at) <= p_cutoff
--   "archived" is exactly the page's archivedGroup(): coalesce(rejected_at, updated_at) <= cutoff; a row with
--   neither timestamp is never archived (updated_at is NOT NULL on this table, so that case cannot occur).
--
-- AUTHORITY. SECURITY INVOKER: it reads the table as the caller, so row-level security decides which rows are
-- counted, exactly as it does for the four requests it replaces. It grants nothing and is granted to
-- `authenticated` only. The page uses it only when no search is typed; a search keeps the four requests.
--
-- NOT TOUCHED: any table, row, policy or grant on finance_payment_requests. READ-ONLY.
--
-- ROLLBACK: drop function public.finance_payment_request_tab_counts(timestamptz); the page falls back to the
-- four requests by itself when the function is missing.
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.finance_payment_requests') is null then
    raise exception '20270719000000: public.finance_payment_requests is missing';
  end if;
end $$;

create or replace function public.finance_payment_request_tab_counts(p_cutoff timestamptz)
returns table (pending bigint, clarification bigint, rejected bigint, archive bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where r.status = 'pending_approval'),
    count(*) filter (where r.status = 'needs_clarification'),
    count(*) filter (where r.status = 'rejected'
                       and (coalesce(r.rejected_at, r.updated_at) is null
                            or coalesce(r.rejected_at, r.updated_at) > p_cutoff)),
    count(*) filter (where r.status = 'rejected'
                       and coalesce(r.rejected_at, r.updated_at) <= p_cutoff)
  from public.finance_payment_requests r
  where r.status in ('pending_approval', 'needs_clarification', 'rejected')
$$;

revoke all on function public.finance_payment_request_tab_counts(timestamptz) from public, anon;
grant execute on function public.finance_payment_request_tab_counts(timestamptz) to authenticated;

comment on function public.finance_payment_request_tab_counts(timestamptz) is
  'Payment Requests tab badges (pending, clarification, rejected, archive) in one call; SECURITY INVOKER, RLS decides the rows. 20270719000000.';

-- Self-check: the function exists, is an invoker function, and anon cannot run it.
do $$
declare v_definer boolean;
begin
  select p.prosecdef into v_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'finance_payment_request_tab_counts';
  if v_definer is null then raise exception '20270719000000: function was not created'; end if;
  if v_definer then raise exception '20270719000000: must be SECURITY INVOKER'; end if;
  if has_function_privilege('anon', 'public.finance_payment_request_tab_counts(timestamptz)', 'execute') then
    raise exception '20270719000000: anon must not execute it';
  end if;
end $$;
