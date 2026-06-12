-- Allow admins to insert employee_assets rows on behalf of any employee.
-- Without this policy, admins were blocked by RLS from adding assets for other users.

create policy "employee_assets_admin_insert" on public.employee_assets
  for insert to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );
