-- Allow creators to update their own payment requests while still actionable.
-- USING  : current row must belong to caller and be in an editable status.
-- WITH CHECK: new row must also belong to caller and stay in an editable status,
--             preventing status escalation to approved_* or rejected.

create policy "finance_payment_requests_own_update"
  on public.finance_payment_requests
  for update to authenticated
  using (
    submitted_by = auth.uid()
    and status in ('pending_approval', 'needs_clarification')
  )
  with check (
    submitted_by = auth.uid()
    and status in ('pending_approval', 'needs_clarification')
  );
