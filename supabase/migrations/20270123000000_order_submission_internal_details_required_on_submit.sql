-- ═══════════════════════════════════════════════════════════════════════════
-- 20270123000000  PHASE 2 — a PI cannot be sent for review without confirmed
--                 internal details
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20270122000000 added the internal details (the app confirmation and due
-- dates, and the middleman commission answer), their editor, and the readiness
-- check order_submission_internal_details_problem() — called by nothing.
--
-- THIS FILE WIRES THAT CHECK IN, AND NOTHING ELSE. Apply it only after the
-- screen that collects the answers is live in production: applied earlier, it
-- refuses every PI submission for answers the deployed screen cannot give
-- (the release hazard 20261225000000 describes).
--
-- ONE TRIGGER, NOT FIVE EDITED DOORS. Every way of sending a PI for review —
-- submit_pi_for_review(), its _with_documents wrapper, and the older
-- submit_order_submission* doors — ends in the same status UPDATE, draft or
-- needs_changes → submitted. A BEFORE trigger on that transition refuses them
-- all with the same words, and a door added later cannot forget it. Because the
-- refusal aborts the submitting statement, nothing else that statement would
-- have done (a pending advance-exception request, the attached documents, the
-- activity entry) is written either.
--
-- PIs already under review, approved or rejected are untouched: the check runs
-- only on the transition INTO review.

do $$
begin
  if to_regprocedure('public.order_submission_internal_details_problem(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270122000000 must be applied before this migration';
  end if;
end $$;

create or replace function public.order_submissions_require_internal_details()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_problem text;
begin
  if new.status = 'submitted' and old.status in ('draft', 'needs_changes') then
    v_problem := public.order_submission_internal_details_problem(new.id);
    if v_problem is not null then
      raise exception 'ORDER_SUBMISSION_INCOMPLETE: % before sending this PI for review', v_problem
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.order_submissions_require_internal_details() from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_require_internal_details on public.order_submissions;
create trigger order_submissions_require_internal_details
  before update of status on public.order_submissions
  for each row execute function public.order_submissions_require_internal_details();

comment on function public.order_submissions_require_internal_details() is
  'Refuses draft/needs_changes → submitted unless order_submission_internal_details_problem() is null: confirmed app dates in order, and a complete middleman commission answer. Covers every submission door. 20270123000000.';

-- The check reads the row the submitting statement is about to change. It runs
-- BEFORE that UPDATE, so it sees the answers as saved — which is what Sales
-- confirmed.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.order_submissions'::regclass
      and tgname = 'order_submissions_require_internal_details'
      and not tgisinternal
  ) then
    raise exception 'ASSERTION FAILED: the internal-details submission check is not installed';
  end if;
end $$;
