-- Finance: allow a creator to reapply their own rejected payment request.
--
-- finance_payment_requests_own_update (20260653) lets a creator UPDATE their
-- own row only while status IN ('pending_approval','needs_clarification'),
-- so a rejected row's UPDATE is silently filtered by RLS (0 rows affected).
--
-- Fix: add 'rejected' to the USING clause only. WITH CHECK is left exactly as
-- it was — still restricted to ('pending_approval','needs_clarification') —
-- so a creator update starting from a rejected row can only succeed if it
-- also moves status to pending_approval (or needs_clarification); it can
-- never leave the row sitting in 'rejected'. No RPC, no new status, and no
-- activity-log change are needed: the existing generic status_changed branch
-- in log_finance_payment_request_activity() already records the
-- rejected -> pending_approval transition faithfully.

drop policy if exists "finance_payment_requests_own_update" on public.finance_payment_requests;

create policy "finance_payment_requests_own_update"
  on public.finance_payment_requests
  for update to authenticated
  using (
    submitted_by = auth.uid()
    and status in ('pending_approval', 'needs_clarification', 'rejected')
  )
  with check (
    submitted_by = auth.uid()
    and status in ('pending_approval', 'needs_clarification')
  );
