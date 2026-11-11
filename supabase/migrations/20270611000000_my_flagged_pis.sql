-- ════════════════════════════════════════════════════════════════════════════
-- 20270611000000  PIs FLAGGED BY OPERATIONS, WAITING FOR THE PERSON WHO MUST ANSWER
-- ════════════════════════════════════════════════════════════════════════════
--
-- Owner, 2026-11-11: Operations flagged PI V1 of Order 546 ("cannot accept").
-- It reached the owner only as one notification and a small link at the foot
-- of the Orders dashboard, and the salesperson was told nothing. A thing that
-- waits on a named person must be on that person's own screen until they have
-- answered it.
--
-- This is the ONE definition of "a flagged PI that waits on ME". Three screens
-- read it and never decide it themselves:
--   * the approver's "Needs your decision" on the Orders dashboard,
--   * the salesperson's Orders dashboard,
--   * the Modules launcher's For you column.
--
-- WHO MUST ANSWER is exactly who the answer door lets answer:
-- respond_order_handoff_clarification() (20270422000000) asks
-- can_propose_order_pi_edit(order_id) — an active admin, or the PI's creator /
-- submitter holding orders.create. This function asks the same helper, so a
-- person is never shown a flag they would be refused on. It adds the door's own
-- state checks (the flag is live, about the version still in force, on an Order
-- that is not cancelled) and the Order-visibility rule the rest of Orders uses,
-- so a card never names an Order the reader may not open.
--
-- WHAT CLEARS IT is nothing this function does: it reads live state, so the
-- row is gone the moment the PI is answered and resubmitted (the handoff goes
-- back to awaiting), Operations accepts it after all, a revised PI is approved
-- (the handoff is superseded) or the Order is cancelled.
--
-- my_flagged_pis() NEVER RAISES for an ordinary signed-in person: the launcher
-- must not break because of Orders. Without the Orders module it returns [].
-- It reads only what the CALLER may answer (auth.uid()); nobody can ask for
-- someone else's. Read-only: nothing is written, nothing is notified, no
-- permission, policy, trigger or existing function is touched.
--
-- Operations' reason is returned whole (at most 1000 characters, the table's
-- own limit); the screens show the first lines and the Order page shows it all.
--
-- Roll-back: drop function public.my_flagged_pis();   -- nothing depends on it.

create or replace function public.my_flagged_pis()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_now   timestamptz := now();
begin
  if v_actor is null then
    return '[]'::jsonb;
  end if;
  -- The launcher must never break: without the Orders module there is simply nothing to show.
  if not public.module_entry_open('orders') then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'handoff_id',      h.id,
             'order_id',        h.order_id,
             'order_number',    o.display_number,
             'client_name',     o.client_name,
             'version_number',  h.version_number,
             'reason',          h.clarification_reason,
             'by_name',         u.full_name,
             'since',           h.clarification_at,
             'waiting_seconds', greatest(extract(epoch from (v_now - coalesce(h.clarification_at, v_now))), 0))
           order by h.clarification_at asc nulls last, h.id)
      from public.order_operations_handoffs h
      join public.orders o on o.id = h.order_id
      left join public.users u on u.id = h.clarification_by
     where h.status = 'clarification_needed'
       and h.superseded_at is null
       and o.status <> 'cancelled'
       -- Still the approved version of the Order: otherwise the answer door refuses it as stale.
       and exists (select 1 from public.order_pi_versions v
                    where v.id = h.pi_version_id and v.status = 'approved')
       and not exists (select 1 from public.order_pi_versions v2
                        where v2.order_id = h.order_id and v2.status = 'approved' and v2.id <> h.pi_version_id)
       and public.can_view_order(h.order_id)
       and public.can_propose_order_pi_edit(h.order_id)), '[]'::jsonb);
end;
$$;

revoke all     on function public.my_flagged_pis() from public, anon;
grant  execute on function public.my_flagged_pis() to authenticated;
comment on function public.my_flagged_pis() is
  'The PIs Operations flagged ("cannot accept") that the CALLER must answer, oldest first, for the Orders dashboards and the Modules launcher: order, client, PI version, Operations'' reason, who flagged and when. The caller is whoever respond_order_handoff_clarification() would let answer (can_propose_order_pi_edit) on an Order they can view; the flag must be live, about the approved version, on an Order that is not cancelled. [] without the Orders module. Read-only. 20270611000000.';


-- ═══ Assertions ═════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.my_flagged_pis()') is null then
    raise exception 'VERIFY: my_flagged_pis() was not created';
  end if;
  if has_function_privilege('anon', 'public.my_flagged_pis()', 'execute') then
    raise exception 'VERIFY: my_flagged_pis() must not be callable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.my_flagged_pis()', 'execute') then
    raise exception 'VERIFY: my_flagged_pis() must be callable by a signed-in person';
  end if;
  if pg_get_functiondef('public.my_flagged_pis()'::regprocedure) !~ 'can_propose_order_pi_edit' then
    raise exception 'VERIFY: my_flagged_pis() does not ask the answer door''s own rule';
  end if;
end $$;
