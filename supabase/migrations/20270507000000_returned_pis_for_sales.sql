-- ═══════════════════════════════════════════════════════════════════════════
-- 20270507000000  PIs RETURNED TO A SALESPERSON — ONE DEFINITION, AND THE MODULES CARD'S READ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner, 2026-10-30: a PI sent back to Sales ("Return to Sales", status
-- needs_changes) must be hard to miss. It shows as one short line on the sales
-- Orders dashboard AND as a "PI returned to you" card in the Modules launcher's
-- For you panel, until the PI is submitted again or deleted.
--
-- Two places must never disagree about which PIs those are, so the rule is
-- stated ONCE here, in order_submissions_returned_to(user), and both read it:
--
--   * salesperson_orders_dashboard() (restated by 20270508000000) for its
--     `returned` list — the same rows as 20270328000200's own CTE;
--   * my_returned_pis() below, a small read for the Modules card.
--
-- WHO A PI IS "RETURNED TO" (unchanged from 20270328000200): its chosen
-- salesperson, or whoever created or submitted it — the creator is the one who
-- must edit it. Status needs_changes only, and not reserved for deletion. No
-- age limit: it is waiting on them until they resubmit or delete it. The person
-- who returned it, and when, come from the newest needs_changes activity row.
--
-- my_returned_pis() NEVER RAISES for an ordinary signed-in person: the launcher
-- must not break because of Orders. Without the Orders module it returns [].
-- It reads only the CALLER's own PIs (auth.uid()); nobody can ask for someone
-- else's. `can_open` says whether the existing PI rules would let the caller
-- open the PI, so the card never offers a link that would refuse.
--
-- Roll-back: drop function public.my_returned_pis(); then (only after
-- 20270508000000 is rolled back, because it calls it) drop function
-- public.order_submissions_returned_to(uuid). Nothing else depends on them.

-- ═══ 1. The one definition ══════════════════════════════════════════════════

create or replace function public.order_submissions_returned_to(p_user uuid)
returns table (
  submission_id uuid,
  reference     text,
  client_name   text,
  review_note   text,
  returned_at   timestamptz,
  returned_by   uuid
)
language sql
stable
set search_path = public, pg_temp
as $$
  select s.id, s.draft_reference::text, s.client_name::text, s.review_note::text, a.created_at, a.actor_id
    from public.order_submissions s
    left join lateral (
      select x.created_at, x.actor_id
        from public.order_submission_activity x
       where x.submission_id = s.id and x.new_status = 'needs_changes'
       order by x.created_at desc limit 1) a on true
   where p_user is not null
     and (s.salesperson_id = p_user or s.submitted_by = p_user or s.created_by = p_user)
     and s.status = 'needs_changes'
     and s.deletion_claim_token is null
$$;
-- Internal: called only from SECURITY DEFINER functions, never by a client.
revoke all on function public.order_submissions_returned_to(uuid) from public, anon, authenticated;
comment on function public.order_submissions_returned_to(uuid) is
  'PIs returned to Sales (needs_changes, not reserved for deletion) where the user is the salesperson, creator or submitter, with who returned each and when. The one definition used by salesperson_orders_dashboard() and my_returned_pis(). Internal. 20270507000000.';


-- ═══ 2. The Modules card's read ═════════════════════════════════════════════

create or replace function public.my_returned_pis()
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
             'submission_id',   r.submission_id,
             'reference',       r.reference,
             'client_name',     r.client_name,
             'by_name',         u.full_name,
             'since',           r.returned_at,
             'waiting_seconds', greatest(extract(epoch from (v_now - coalesce(r.returned_at, v_now))), 0),
             'can_open',        public.can_view_order_submission(r.submission_id))
           order by r.returned_at asc nulls last, r.submission_id)
      from public.order_submissions_returned_to(v_actor) r
      left join public.users u on u.id = r.returned_by), '[]'::jsonb);
end;
$$;

revoke all     on function public.my_returned_pis() from public, anon;
grant  execute on function public.my_returned_pis() to authenticated;
comment on function public.my_returned_pis() is
  'The caller''s own PIs returned to Sales, oldest first, for the Modules launcher''s For you card: reference, client, who returned it, since when, and whether the caller may open it. [] without the Orders module. Read-only. 20270507000000.';


-- ═══ 3. Assertions ══════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.order_submissions_returned_to(uuid)') is null then
    raise exception 'VERIFY: order_submissions_returned_to(uuid) was not created';
  end if;
  if to_regprocedure('public.my_returned_pis()') is null then
    raise exception 'VERIFY: my_returned_pis() was not created';
  end if;
  if has_function_privilege('authenticated', 'public.order_submissions_returned_to(uuid)', 'execute') then
    raise exception 'VERIFY: order_submissions_returned_to(uuid) must not be callable by a client';
  end if;
  if has_function_privilege('anon', 'public.my_returned_pis()', 'execute') then
    raise exception 'VERIFY: my_returned_pis() must not be callable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.my_returned_pis()', 'execute') then
    raise exception 'VERIFY: my_returned_pis() must be callable by a signed-in person';
  end if;
  if pg_get_functiondef('public.my_returned_pis()'::regprocedure) !~ 'order_submissions_returned_to' then
    raise exception 'VERIFY: my_returned_pis() does not read the one definition';
  end if;
end $$;
