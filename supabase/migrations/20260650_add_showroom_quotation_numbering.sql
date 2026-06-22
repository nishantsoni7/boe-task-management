-- Showroom QR Phase 3 — Quotation numbering.
-- Format: BOE-QTN-YYYY-NNNN (e.g. BOE-QTN-2026-0001).
-- Generated only when the quotation PDF is first produced — NOT on row insert.
-- Existing rows stay null until PDF is generated.
-- Race-condition safety: get_or_create_quotation_no() uses a per-year counter
-- row locked atomically via INSERT ... ON CONFLICT DO UPDATE.

-- ─── 1. Clean up old trigger-based approach (if applied previously) ───────────

drop trigger if exists showroom_inquiries_assign_quotation_no
  on public.showroom_inquiries;

drop function if exists public.assign_showroom_quotation_no();

-- ─── 2. Per-year sequence counter table ──────────────────────────────────────

create table if not exists public.showroom_quotation_seq (
  year     integer primary key,
  last_seq integer not null default 0
);

alter table public.showroom_quotation_seq enable row level security;
-- Only service role (bypasses RLS) accesses this table.

-- ─── 3. Uniqueness constraint on quotation_no ────────────────────────────────
-- Partial: only enforces uniqueness where quotation_no is not null,
-- so historical null rows don't conflict.

create unique index if not exists showroom_inquiries_quotation_no_uidx
  on public.showroom_inquiries (quotation_no)
  where quotation_no is not null;

-- ─── 4. Function: get or create quotation_no ─────────────────────────────────
-- Called from the API when a PDF is first generated.
-- Idempotent: returns existing quotation_no without incrementing the counter.

create or replace function public.get_or_create_quotation_no(p_inquiry_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing text;
  v_year     integer;
  v_seq      integer;
  v_no       text;
begin
  -- 1. Return existing number without touching the sequence.
  select quotation_no into v_existing
    from public.showroom_inquiries
    where id = p_inquiry_id;

  if v_existing is not null then
    return v_existing;
  end if;

  -- 2. Generate next number using atomic upsert on the sequence table.
  v_year := extract(year from now())::integer;

  insert into public.showroom_quotation_seq (year, last_seq)
  values (v_year, 1)
  on conflict (year) do update
    set last_seq = showroom_quotation_seq.last_seq + 1
  returning last_seq into v_seq;

  v_no := 'BOE-QTN-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  -- 3. Write it back — unique index catches any rare concurrent duplicate.
  update public.showroom_inquiries
    set quotation_no = v_no
    where id = p_inquiry_id
      and quotation_no is null;

  return v_no;
end;
$$;
