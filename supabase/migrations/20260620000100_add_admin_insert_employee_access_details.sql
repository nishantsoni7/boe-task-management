-- Allow admins to insert employee_access_details rows on behalf of any employee.
-- Without this policy, admins are blocked by RLS from adding login details for other users.

create policy "employee_access_admin_insert" on public.employee_access_details
  for insert to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );
