-- Allow admin users to delete any finance payment request.

create policy "finance_payment_requests_admin_delete"
  on public.finance_payment_requests
  for delete to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );
