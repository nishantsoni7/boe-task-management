-- Finance module: Payment Confirmation Requests
-- Salespeople submit payment details for admin confirmation.
-- A request may be created before an order number exists;
-- approved_unlinked → approved_linked once an order number is attached.
--
-- status values:
--   pending_approval | approved_unlinked | approved_linked
--   | needs_clarification | rejected
--
-- payment_mode values: bank_transfer | cash | upi | cheque | other
-- received_in values:  company_account | cash_in_hand | savings_account | other

create table if not exists public.finance_payment_requests (
  id             uuid        primary key default gen_random_uuid(),

  -- Submission fields
  client_name    text        not null,
  amount         numeric     not null,
  payment_date   date        not null,
  payment_mode   text        not null
                   check (payment_mode in ('bank_transfer','cash','upi','cheque','other')),
  received_in    text        not null
                   check (received_in in ('company_account','cash_in_hand','savings_account','other')),
  proof_note     text        not null,
  order_number   text        null,
  sales_note     text        null,

  -- Workflow
  status         text        not null default 'pending_approval'
                   check (status in (
                     'pending_approval',
                     'approved_unlinked',
                     'approved_linked',
                     'needs_clarification',
                     'rejected'
                   )),

  -- Ownership and approval
  submitted_by   uuid        not null references public.users(id),
  approved_by    uuid        null     references public.users(id),
  approved_at    timestamptz null,
  admin_note     text        null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

create index if not exists finance_payment_requests_submitted_by_idx
  on public.finance_payment_requests(submitted_by);

create index if not exists finance_payment_requests_status_idx
  on public.finance_payment_requests(status);

create index if not exists finance_payment_requests_payment_date_idx
  on public.finance_payment_requests(payment_date desc);

create index if not exists finance_payment_requests_created_at_idx
  on public.finance_payment_requests(created_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.finance_payment_requests enable row level security;

-- Sales: select their own submissions
create policy "finance_payment_requests_own_select"
  on public.finance_payment_requests
  for select to authenticated
  using (submitted_by = auth.uid());

-- Sales: insert only if they are the submitter
create policy "finance_payment_requests_own_insert"
  on public.finance_payment_requests
  for insert to authenticated
  with check (submitted_by = auth.uid());

-- Admin: select all requests
create policy "finance_payment_requests_admin_select"
  on public.finance_payment_requests
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );

-- Admin: update all requests (for approve / reject / clarification)
create policy "finance_payment_requests_admin_update"
  on public.finance_payment_requests
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

-- ── updated_at trigger ────────────────────────────────────────────────────────
-- set_updated_at() was defined in 20260609_create_attendance_records.sql

drop trigger if exists finance_payment_requests_set_updated_at
  on public.finance_payment_requests;

create trigger finance_payment_requests_set_updated_at
  before update on public.finance_payment_requests
  for each row execute function public.set_updated_at();
