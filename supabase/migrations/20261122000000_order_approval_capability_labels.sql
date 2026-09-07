-- Order approval capability labels — clearer Control Center wording.
--
-- WHAT THIS IS, AND WHAT IT ISN'T
-- --------------------------------
-- orders.approve_order, orders.approve_advance_exception and
-- orders.align_production already exist, are already independent PROTECTED
-- actions (src/lib/permissions/levels.ts), are already enforced server-side
-- inside the RPCs that perform each action via
-- actor_has_module_permission('orders', <action>) — active-admin bypass OR an
-- explicit per-employee grant, same as finance.approve — and are already
-- surfaced generically in Control Center's per-employee Custom permission
-- editor. Nothing about capability, enforcement or independence changes here.
--
-- This migration renames three permission_actions.display_name values only,
-- to the operational wording an administrator reads while granting them:
--
--   approve_order              'Approve Order Submissions' -> 'Approve PI / Confirm Order'
--   approve_advance_exception  'Approve Advance Exceptions' -> 'Approve Advance Exception'
--   align_production           'Align Production'           -> 'Align Order for Production'
--
-- WHY A MIGRATION AND NOT `npm run permissions:sync`
-- ---------------------------------------------------
-- sync upserts EVERY registered module and action in one pass, and
-- permission_actions.display_name is GLOBAL per action_key — see
-- 20261111000000's header for the `view_all` example of what that clobbers.
-- These three action_keys are each registered by exactly one module (orders;
-- verified against src/lib/permissions/modules.ts and confirmed in the
-- self-assertion below), so there is no shared-label collision to avoid here
-- either way — but a migration naming the exact rows it changes is still the
-- narrower, safer tool, and keeps this change reviewable on its own.
--
-- WHAT THIS CANNOT BREAK
-- -----------------------
-- The permission engine resolves on action_key, never display_name — no
-- resolver, policy, RPC or grant is touched. src/lib/permissions/modules.ts
-- carries the matching displayName text in the same commit, so the registry
-- and the database agree (though note npm run permissions:check does not
-- itself compare per-action display_name — see scripts/sync-permissions.ts —
-- so this is a manual keep-in-sync, same as any other action label edit).
--
-- Idempotent: re-running sets the same three rows to the same values.
--
-- ROLLBACK
-- --------
--   update public.permission_actions set display_name = 'Approve Order Submissions'  where action_key = 'approve_order';
--   update public.permission_actions set display_name = 'Approve Advance Exceptions' where action_key = 'approve_advance_exception';
--   update public.permission_actions set display_name = 'Align Production'           where action_key = 'align_production';

update public.permission_actions set display_name = 'Approve PI / Confirm Order'
 where action_key = 'approve_order';

update public.permission_actions set display_name = 'Approve Advance Exception'
 where action_key = 'approve_advance_exception';

update public.permission_actions set display_name = 'Align Order for Production'
 where action_key = 'align_production';

-- ═══ Assertions ═══════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  if (select display_name from public.permission_actions where action_key = 'approve_order')
       <> 'Approve PI / Confirm Order' then
    raise exception 'approve_order display_name did not update as expected';
  end if;
  if (select display_name from public.permission_actions where action_key = 'approve_advance_exception')
       <> 'Approve Advance Exception' then
    raise exception 'approve_advance_exception display_name did not update as expected';
  end if;
  if (select display_name from public.permission_actions where action_key = 'align_production')
       <> 'Align Order for Production' then
    raise exception 'align_production display_name did not update as expected';
  end if;

  -- Each of the three is registered under exactly one module (orders) — the
  -- premise this migration relies on to say there is no shared-label
  -- collision. Zero rows (key missing) or more than one (shared elsewhere)
  -- means that premise is false and this migration must not silently proceed.
  select string_agg(k.action_key || ' (' || coalesce(c.n, 0) || ')', ', ') into v_bad
  from (values ('approve_order'), ('approve_advance_exception'), ('align_production')) as k(action_key)
  left join (
    select pa.action_key, count(*) as n
    from public.permission_actions pa
    join public.module_permission_actions mpa on mpa.action_id = pa.id
    where pa.action_key in ('approve_order', 'approve_advance_exception', 'align_production')
    group by pa.action_key
  ) c on c.action_key = k.action_key
  where coalesce(c.n, 0) <> 1;
  if v_bad is not null then
    raise exception 'expected exactly one module_permission_actions row (module_key, count) for: %', v_bad;
  end if;
end $$;
