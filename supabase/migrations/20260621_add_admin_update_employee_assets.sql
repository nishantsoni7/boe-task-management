-- Allow admins to update employee_assets rows for any employee.
-- Without this policy, the own_update policy blocks admins from editing
-- assets they did not create under their own user_id.

create policy "employee_assets_admin_update" on public.employee_assets
  for update to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );
