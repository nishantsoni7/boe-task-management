-- 20270518000000_register_seo_module.sql
--
-- SEO: the owner's module for Google rankings, competitors, the 30/60-day board and the weekly strategy
-- review. This file only registers it; the tables are in the next file.
--
-- Same registration as Sales, Marketing and Pricing (20270515000000). `view` is the one action for now, because
-- the first version only reads; the Admin role holds it, and everybody else is off until an administrator
-- grants it per person in Control Center. Mirrors src/lib/permissions/modules.ts exactly (npm run permissions:check).
--
-- ROLLBACK (the rows are only registration; a person's grant is removed with them):
--   delete from public.employee_permission_overrides, role_permissions, module_permission_actions,
--   permission_modules and app_modules where the module key is 'seo'.

insert into public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
values
  ('seo', 'SEO', 'Google rankings, competitors, the plan and the weekly review.', '/seo', 'live', null, 150)
on conflict (module_key) do nothing;

insert into public.permission_modules (module_key, display_name, description) values
  ('seo', 'SEO', 'Google rankings, competitors, the plan and the weekly review.')
on conflict (module_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key = 'seo'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
where pm.module_key = 'seo'
on conflict (role, module_id, action_id) do nothing;

do $$
begin
  if (select count(*)
      from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'seo' and rp.role = 'admin' and rp.allowed) <> 1 then
    raise exception 'SEO_MODULE: the module needs its one Admin role row';
  end if;
end $$;
