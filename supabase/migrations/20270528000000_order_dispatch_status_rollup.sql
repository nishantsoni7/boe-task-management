-- Orders: dispatch drives the Order's status.
--
-- WHY (owner, 2026-11-03)
--   What has left the factory decides where an Order sits. When every piece has
--   gone the Order is Dispatched and leaves the running list; while part has
--   gone and the rest is being made it stays Running; while part has gone and
--   the rest is fully ready it is Ready for Dispatch. Until now recording a
--   dispatch moved no status ("Dispatched" was an admin's button, reachable only
--   from Ready for Dispatch), so a finished Order kept counting as Running on
--   the list and on every dashboard.
--
-- WHAT THIS DOES
--   1. order_dispatch_pieces(order)  pieces ordered / dispatched, and whether
--      every line has left. ONE definition of "fully dispatched", used by the
--      roll-up and by the list's read below.
--   2. order_dispatch_sync_status(order)  closes the Order (-> dispatched) when
--      every piece has left, and undoes that close when an administrator later
--      removes or lowers a dispatch. It undoes only a close it made itself: a
--      Dispatched an admin set by hand (older Orders, no lots) is never touched.
--      The move writes the same status_changed Activity row the Order page
--      writes (payload.to = 'dispatched'), so the Operations dashboard's
--      "dispatches by date" counts it, plus source = 'dispatch'.
--   3. Two DEFERRED constraint triggers call it at commit: one on
--      order_dispatch_lots (every way a dispatch is recorded, marked, changed or
--      deleted) and one on order_pi_versions (a revised PI that lowers a
--      quantity to what already left closes the Order; one that raises it
--      reopens an automatic close). Deferred, so it reads the finished state,
--      not the lot row before its lines exist.
--   4. orders_enforce_status_transition() re-emitted from 20260819000000 with
--      three changes, and nothing else:
--        a. ready_for_dispatch -> running is legal ("more work appeared after
--           Ready"). 20260819 left it out on purpose until the UI offered it;
--           the Order page's TRANSITION_GRAPH gets the same entry in the same
--           change.
--        b. Inside the roll-up (and only there) running / on_hold /
--           ready_for_dispatch -> dispatched and dispatched -> back are legal
--           and the role gate is skipped: the person recording a dispatch is
--           often a salesperson, who may never change a status by hand.
--        c. Cancelling an Order with anything dispatched is refused
--           (ORDER_PART_DISPATCHED): invoices have already gone out. The way to
--           stop the rest is a revised PI down to what was sent, which closes
--           the Order as Dispatched.
--   5. orders_dispatch_progress()  one read for the Confirmed Orders list: for
--      each Order the caller may open that has a dispatch, pieces ordered and
--      dispatched and the last dispatch date. Pieces only, no money.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * Touches no existing Order. Orders that are already fully covered by
--     dispatched lots but still say Running stay as they are until the owner
--     decides: see BACKFILL at the foot of this file (read-only query first).
--   * Adds no payment gate (the 2026-09-18 ₹1,000 rule is still unbuilt).
--   * Sends no notification. The Activity row exists; wording a notification
--     for an automatic close is a separate step.
--
-- ROLLBACK
--   drop trigger order_pi_versions_dispatch_rollup on public.order_pi_versions;
--   drop trigger order_dispatch_lots_rollup on public.order_dispatch_lots;
--   drop function public.order_pi_versions_rollup_trg();
--   drop function public.order_dispatch_lots_rollup_trg();
--   drop function public.orders_dispatch_progress();
--   drop function public.order_dispatch_sync_status(uuid);
--   drop function public.order_dispatch_pieces(uuid);
--   Restore orders_enforce_status_transition() from 20260819000000 §4 (the
--   body is there, unchanged), then:
--   drop function public.in_order_dispatch_sync();
--   An Order this migration closed stays Dispatched (it is a real status);
--   an admin can reopen it by removing the dispatch before the rollback, or
--   leave it.

do $dep$
begin
  if to_regprocedure('public.in_order_cancellation()') is null then
    raise exception 'DEPENDENCY MISSING: public.in_order_cancellation()';
  end if;
  if to_regprocedure('public.can_view_order_as_actor(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.can_view_order_as_actor(uuid)';
  end if;
  if to_regclass('public.orders') is null
     or to_regclass('public.order_submission_items') is null
     or to_regclass('public.order_dispatch_lots') is null
     or to_regclass('public.order_dispatch_lot_lines') is null
     or to_regclass('public.order_pi_versions') is null
     or to_regclass('public.order_activity_log') is null then
    raise exception 'DEPENDENCY MISSING: Orders, PI, dispatch or Activity tables';
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.orders'::regclass
                    and t.tgname = 'orders_enforce_status_transition') then
    raise exception 'DEPENDENCY MISSING: trigger orders_enforce_status_transition on public.orders';
  end if;
end $dep$;


-- ═══ §1. The roll-up context ════════════════════════════════════════════════
--
-- Same idiom as in_order_cancellation(): transaction-local, set only inside the
-- SECURITY DEFINER roll-up below, not settable by any client function. It is
-- NOT an authorization check: the roll-up decides from stored facts, never
-- from anything the caller sent.

create or replace function public.in_order_dispatch_sync()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('boe.dispatch_sync_context', true), '') = 'on';
$$;
revoke execute on function public.in_order_dispatch_sync() from public, anon, authenticated;


-- ═══ §2. The status graph, in the database ══════════════════════════════════
--
-- 20260819000000 §4's body, with the three changes named at the top and marked
-- "20270528" below. Everything else is that migration's, word for word.

create or replace function public.orders_enforce_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_role    text;
  v_team    text;
  v_allowed text[];
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- 20270528 (b): the dispatch roll-up. Its own small graph, no role gate.
  if public.in_order_dispatch_sync() then
    v_allowed := case old.status
      when 'dispatched' then array['running', 'on_hold', 'ready_for_dispatch']
      when 'cancelled'  then array[]::text[]
      else array['dispatched']
    end;
    if not (new.status = any (v_allowed)) then
      raise exception
        'ORDER_STATUS_TRANSITION_INVALID: Order % cannot move from % to %',
        old.display_number, old.status, new.status
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_allowed := case old.status
    when 'running'            then array['on_hold', 'ready_for_dispatch', 'cancelled']
    when 'on_hold'            then array['running', 'cancelled']
    -- 20270528 (a): 'running' added.
    when 'ready_for_dispatch' then array['running', 'dispatched', 'cancelled']
    else array[]::text[]      -- dispatched and cancelled are terminal
  end;

  if not (new.status = any (v_allowed)) then
    raise exception
      'ORDER_STATUS_TRANSITION_INVALID: Order % cannot move from % to %',
      old.display_number, old.status, new.status
      using errcode = '42501';
  end if;

  -- 20270528 (c): something has already left, so the Order is not cancelled.
  if new.status = 'cancelled' and exists (
       select 1
         from public.order_dispatch_lots t
         join public.order_dispatch_lot_lines l on l.lot_id = t.id
        where t.order_id = old.id and t.status = 'dispatched'
     ) then
    raise exception
      'ORDER_PART_DISPATCHED: Part of Order % has already been dispatched, so it can no longer be cancelled',
      old.display_number
      using errcode = '42501';
  end if;

  if new.status = 'cancelled' and not public.in_order_cancellation() then
    raise exception
      'ORDER_CANCEL_PATH_REQUIRED: Order % can only be cancelled through cancel_order(), which records a reason and the money received against it',
      old.display_number
      using errcode = '42501';
  end if;

  if v_uid is not null then
    select u.role::text, u.team into v_role, v_team
      from public.users u where u.id = v_uid;

    if v_role is distinct from 'admin' then
      if v_team = 'operations' then
        if not (new.status = any (array['running', 'on_hold', 'ready_for_dispatch'])) then
          raise exception
            'ORDER_STATUS_FORBIDDEN: Operations cannot move Order % to %',
            old.display_number, new.status
            using errcode = '42501';
        end if;
      else
        raise exception
          'ORDER_STATUS_FORBIDDEN: You cannot change the status of Order %',
          old.display_number
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function public.orders_enforce_status_transition() from public, anon, authenticated;


-- ═══ §3. What has left ══════════════════════════════════════════════════════
--
-- Ordered = the PI's quantities (the same source order_payment_plan_check_lines
-- uses). A line counts as sent when its dispatched lots add up to its quantity;
-- a quantity lowered below what already left is clamped, so 80 of 74 can never
-- print. Lines with no quantity have nothing to send and are ignored; an Order
-- with no sendable line is never "all sent".

create or replace function public.order_dispatch_pieces(p_order_id uuid)
returns table (ordered numeric, dispatched numeric, all_sent boolean, last_dispatched_on date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with items as (
    select coalesce(nullif(btrim(i.item_sequence), ''), i.id::text) as k, i.quantity as qty
      from public.orders o
      join public.order_submission_items i on i.submission_id = o.source_order_submission_id
     where o.id = p_order_id and i.quantity > 0
  ),
  sent as (
    select l.item_sequence as k, sum(l.quantity) as q
      from public.order_dispatch_lots t
      join public.order_dispatch_lot_lines l on l.lot_id = t.id
     where t.order_id = p_order_id and t.status = 'dispatched'
     group by l.item_sequence
  ),
  per as (
    select i.qty, least(coalesce(s.q, 0), i.qty) as got
      from items i left join sent s on s.k = i.k
  )
  select coalesce(sum(per.qty), 0),
         coalesce(sum(per.got), 0),
         coalesce(count(*) > 0 and bool_and(per.got >= per.qty), false),
         (select max(t.dispatched_on) from public.order_dispatch_lots t
           where t.order_id = p_order_id and t.status = 'dispatched')
    from per;
$$;
revoke execute on function public.order_dispatch_pieces(uuid) from public, anon, authenticated;


-- ═══ §4. The roll-up ════════════════════════════════════════════════════════

create or replace function public.order_dispatch_sync_status(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_p     record;
  v_last  jsonb;
  v_back  text;
begin
  if p_order_id is null then
    return;
  end if;
  -- One writer per Order. The dispatch functions already hold this lock; an
  -- Order that was deleted in the same transaction is simply gone.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.status = 'cancelled' then
    return;
  end if;

  select * into v_p from public.order_dispatch_pieces(p_order_id);

  if v_p.all_sent and v_order.status in ('running', 'on_hold', 'ready_for_dispatch') then
    perform set_config('boe.dispatch_sync_context', 'on', true);
    update public.orders set status = 'dispatched' where id = p_order_id;
    perform set_config('boe.dispatch_sync_context', '', true);

    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (p_order_id, auth.uid(), 'status_changed',
            jsonb_build_object('from', v_order.status, 'to', 'dispatched', 'source', 'dispatch',
                               'dispatched_on', v_p.last_dispatched_on));

  elsif not v_p.all_sent and v_order.status = 'dispatched' then
    -- Undo only a close this roll-up made: the Order's latest status change is
    -- its own. A Dispatched set by hand has no source, so it stays.
    select a.payload into v_last
      from public.order_activity_log a
     where a.order_id = p_order_id and a.event_type = 'status_changed'
     order by a.created_at desc, a.id desc
     limit 1;
    if v_last is not null
       and v_last ->> 'source' = 'dispatch'
       and v_last ->> 'to' = 'dispatched' then
      v_back := case when v_last ->> 'from' in ('running', 'on_hold', 'ready_for_dispatch')
                     then v_last ->> 'from' else 'running' end;
      perform set_config('boe.dispatch_sync_context', 'on', true);
      update public.orders set status = v_back where id = p_order_id;
      perform set_config('boe.dispatch_sync_context', '', true);

      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (p_order_id, auth.uid(), 'status_changed',
              jsonb_build_object('from', 'dispatched', 'to', v_back, 'source', 'dispatch',
                                 'reason', 'A dispatch was removed or lowered, so pieces are pending again'));
    end if;
  end if;
end;
$$;
revoke execute on function public.order_dispatch_sync_status(uuid) from public, anon, authenticated;


-- ═══ §5. When it runs: at commit, after every change that can move the answer ═

create or replace function public.order_dispatch_lots_rollup_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.order_dispatch_sync_status(case when tg_op = 'DELETE' then old.order_id else new.order_id end);
  return null;
end;
$$;
revoke execute on function public.order_dispatch_lots_rollup_trg() from public, anon, authenticated;

drop trigger if exists order_dispatch_lots_rollup on public.order_dispatch_lots;
create constraint trigger order_dispatch_lots_rollup
  after insert or update or delete on public.order_dispatch_lots
  deferrable initially deferred
  for each row execute function public.order_dispatch_lots_rollup_trg();

create or replace function public.order_pi_versions_rollup_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.order_dispatch_sync_status(new.order_id);
  return null;
end;
$$;
revoke execute on function public.order_pi_versions_rollup_trg() from public, anon, authenticated;

drop trigger if exists order_pi_versions_dispatch_rollup on public.order_pi_versions;
create constraint trigger order_pi_versions_dispatch_rollup
  after update of status on public.order_pi_versions
  deferrable initially deferred
  for each row
  when (new.status = 'approved' and old.status is distinct from new.status)
  execute function public.order_pi_versions_rollup_trg();


-- ═══ §6. One read for the Confirmed Orders list ═════════════════════════════

create or replace function public.orders_dispatch_progress()
returns table (order_id uuid, ordered numeric, dispatched numeric, last_dispatched_on date)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  return query
  select o.id, p.ordered, p.dispatched, p.last_dispatched_on
    from public.orders o
    cross join lateral public.order_dispatch_pieces(o.id) p
   where exists (select 1 from public.order_dispatch_lots t
                  where t.order_id = o.id and t.status = 'dispatched')
     and public.can_view_order_as_actor(o.id);
end;
$$;
comment on function public.orders_dispatch_progress() is
  'Pieces ordered and dispatched, and the last dispatch date, for each Order the caller may open that has a dispatch. Pieces only, no money. An Order with no dispatch returns no row. 20270528000000.';
revoke execute on function public.orders_dispatch_progress() from public, anon;
grant  execute on function public.orders_dispatch_progress() to authenticated;


-- ═══ §7. Self-assertions (executed) ═════════════════════════════════════════

do $assert$
begin
  if has_function_privilege('authenticated', 'public.order_dispatch_sync_status(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.order_dispatch_pieces(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.in_order_dispatch_sync()', 'execute')
     or has_function_privilege('authenticated', 'public.order_dispatch_lots_rollup_trg()', 'execute')
     or has_function_privilege('authenticated', 'public.order_pi_versions_rollup_trg()', 'execute') then
    raise exception 'ASSERT: the roll-up helpers must not be callable by client roles';
  end if;
  if not has_function_privilege('authenticated', 'public.orders_dispatch_progress()', 'execute')
     or has_function_privilege('anon', 'public.orders_dispatch_progress()', 'execute') then
    raise exception 'ASSERT: orders_dispatch_progress must be callable by authenticated only';
  end if;
  if (select count(*) from pg_trigger t
       where t.tgname in ('order_dispatch_lots_rollup', 'order_pi_versions_dispatch_rollup')
         and t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred) <> 2 then
    raise exception 'ASSERT: both roll-up triggers must be deferred constraint triggers';
  end if;
  if pg_get_functiondef('public.orders_enforce_status_transition()'::regprocedure) not like '%ORDER_PART_DISPATCHED%'
     or pg_get_functiondef('public.orders_enforce_status_transition()'::regprocedure) not like '%array[''running'', ''dispatched'', ''cancelled'']%' then
    raise exception 'ASSERT: the status graph must carry the roll-up changes';
  end if;
end $assert$;


-- ═══ BACKFILL (NOT RUN HERE: the owner decides, after reading the list) ══════
--
-- Orders already fully covered by dispatched lots but still not Dispatched:
--
--   select o.display_number, o.status, p.ordered, p.dispatched, p.last_dispatched_on
--     from public.orders o
--     cross join lateral public.order_dispatch_pieces(o.id) p
--    where p.all_sent and o.status in ('running', 'on_hold', 'ready_for_dispatch')
--    order by o.display_number;
--
-- To close exactly those (each writes its own status_changed row, source
-- 'dispatch', and is undone the same way if a dispatch is later removed):
--
--   select public.order_dispatch_sync_status(o.id)
--     from public.orders o
--     cross join lateral public.order_dispatch_pieces(o.id) p
--    where p.all_sent and o.status in ('running', 'on_hold', 'ready_for_dispatch');
