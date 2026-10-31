-- 20270515000000_register_sales_marketing_pricing_modules.sql
--
-- Sales, Marketing and Pricing: three modules the owner has named for future work. For now each one opens
-- a Coming soon page and nothing else, so this file only registers them: no table, no function, no
-- notification type, no change to any existing row.
--
-- Same registration as Vendors (20270426000000) and Inventory (20270313000000). `view` is the one action;
-- the Admin role holds it, and everybody else is off until an administrator grants it per person in
-- Control Center. Mirrors src/lib/permissions/modules.ts exactly (npm run permissions:check).
--
-- ROLLBACK (the rows are only registration; a person's grant is removed with them):
--   delete from public.employee_permission_overrides, role_permissions, module_permission_actions,
--   permission_modules and app_modules where the module key is 'sales', 'marketing' or 'pricing'.

insert into public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
values
  ('sales', 'Sales', 'Sales module. Coming soon.', '/sales', 'live', null, 120),
  ('marketing', 'Marketing', 'Marketing module. Coming soon.', '/marketing', 'live', null, 130),
  ('pricing', 'Pricing', 'Pricing module. Coming soon.', '/pricing', 'live', null, 140)
on conflict (module_key) do nothing;

insert into public.permission_modules (module_key, display_name, description) values
  ('sales', 'Sales', 'Sales module. Coming soon.'),
  ('marketing', 'Marketing', 'Marketing module. Coming soon.'),
  ('pricing', 'Pricing', 'Pricing module. Coming soon.')
on conflict (module_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key in ('sales', 'marketing', 'pricing')
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
where pm.module_key in ('sales', 'marketing', 'pricing')
on conflict (role, module_id, action_id) do nothing;

do $$
begin
  if (select count(*)
      from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key in ('sales', 'marketing', 'pricing')
        and rp.role = 'admin' and rp.allowed) <> 3 then
    raise exception 'COMING_SOON_MODULES: each of the three modules needs its one Admin role row';
  end if;
end $$;
