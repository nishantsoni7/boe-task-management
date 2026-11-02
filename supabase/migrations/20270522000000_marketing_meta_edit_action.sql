-- 20270522000000_marketing_meta_edit_action.sql
--
-- Marketing: the first real work is Meta Ads (PR A reads the ad account, PR B shows it). This file registers the
-- second action the screens need and says what the module is for. Nothing here changes who can open Marketing.
--
-- `view` already exists (20270515000000) and opens the module. `edit` sets the monthly spending cap and the
-- target cost per enquiry (public.meta_set_targets, next file) and, from PR B, runs Sync now. The Admin role holds
-- both; everybody else is off until an administrator grants it per person in Control Center. Mirrors
-- src/lib/permissions/modules.ts exactly (npm run permissions:check).
--
-- ROLLBACK (the rows are only registration; a person's grant is removed with them):
--   delete from public.employee_permission_overrides, role_permissions and module_permission_actions
--   where the module is 'marketing' and the action is 'edit';
--   update public.app_modules and public.permission_modules set description = 'Marketing module. Coming soon.'
--   where module_key = 'marketing'.

update public.app_modules
set description = 'Marketing, starting with Meta Ads.'
where module_key = 'marketing';

update public.permission_modules
set description = 'Marketing, starting with Meta Ads.'
where module_key = 'marketing';

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'edit'
where pm.module_key = 'marketing'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
join public.permission_actions pa on pa.id = mpa.action_id
where pm.module_key = 'marketing' and pa.action_key = 'edit'
on conflict (role, module_id, action_id) do nothing;

do $$
begin
  if (select count(*)
      from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'marketing' and rp.role = 'admin' and rp.allowed) <> 2 then
    raise exception 'MARKETING_EDIT: the module needs its two Admin role rows (view and edit)';
  end if;
  if exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    where pm.module_key = 'marketing' and mpa.default_allowed
  ) then
    raise exception 'MARKETING_EDIT: no Marketing action may be on by default';
  end if;
end $$;
