-- Reference data and "existing account" fixtures the live-database suites expect to find.
-- Idempotent. NO production data: every value is the repository's own seed, or a fake account.

insert into public.departments (department_key, department_name, sort_order) values
  ('sales','Sales',10),('operations','Operations',20),('design','Design',30),
  ('purchase','Purchase',40),('bdm','BDM',50),('management','Management',60)
on conflict do nothing;

insert into public.permission_actions (action_key, display_name, is_system) values
  ('view','View',true),('create','Create',true),('edit','Edit',true),('delete','Delete',true),
  ('approve','Approve',true),('export','Export',true),('manage','Manage',true),('admin','Admin',true)
on conflict (action_key) do nothing;

insert into public.permission_modules (module_key, display_name, description)
select 'payroll', 'Payroll', 'Payroll runs, payslips and settlement.'
where not exists (select 1 from public.permission_modules where module_key = 'payroll');

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view','create','edit','delete','approve','export','manage','admin')
where pm.module_key = 'payroll'
on conflict (module_id, action_id) do nothing;

insert into public.app_modules (module_key, module_name, description, route_path, visibility_type, sort_order)
select 'payroll', 'Payroll', 'Payroll module', '/payroll', 'live', 100
where not exists (select 1 from public.app_modules where module_key = 'payroll');

-- Accounts the payroll route suites REFERENCE (they create their own fixtures too).
insert into public.users (full_name, team, role, is_active, email, phone)
select v.full_name, v.team, v.role::public.user_role, true, v.email, v.phone
from (values
  ('Live-DB Test Admin',    'management', 'admin',  'live-db-admin@example.invalid', '9000000001'),
  ('Live-DB Test Member A', 'sales',      'member', 'live-db-member-a@example.invalid', '9000000002'),
  ('Live-DB Test Member B', 'operations', 'member', 'live-db-member-b@example.invalid', '9000000003')
) as v(full_name, team, role, email, phone)
where not exists (select 1 from public.users u where u.email = v.email);
