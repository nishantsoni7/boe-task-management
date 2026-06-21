-- Add share_token to showroom_inquiries for public customer-facing share links.
-- Token is generated on row creation (backfill below covers existing rows).
-- shared_at records when the salesperson first copied the link (set server-side on first share API call).

alter table public.showroom_inquiries
  add column if not exists share_token uuid not null default gen_random_uuid(),
  add column if not exists shared_at   timestamptz;

-- Backfill any rows that pre-date this migration (share_token default fires only on INSERT)
update public.showroom_inquiries
  set share_token = gen_random_uuid()
  where share_token is null;

create unique index if not exists showroom_inquiries_share_token_idx
  on public.showroom_inquiries(share_token);

-- No new RLS policy needed: the public share API route uses the service role key,
-- which bypasses RLS. The route itself enforces share_token lookup — no additional
-- anon policy is required and adding one would expose all rows to anonymous clients.
