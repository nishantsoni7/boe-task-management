-- Showroom QR Phase 3 — Step 2: auto-generate quotation_no on insert.
-- Format: BOE-Q-YYYY-NNNN (e.g. BOE-Q-2026-0001), permanent, never overwritten.
-- Race-condition safety: per-year counter row locked atomically via
-- INSERT ... ON CONFLICT DO UPDATE, which is serialized by Postgres.

-- ─── 1. Per-year sequence counter table ──────────────────────────────────────

create table if not exists public.showroom_quotation_seq (
  year     integer primary key,
  last_seq integer not null default 0
);

-- Only admins/service role should touch this table — no public access needed.
alter table public.showroom_quotation_seq enable row level security;

-- No select/insert/update policy: only service role (bypasses RLS) uses this.

-- ─── 2. Function: assign quotation_no before insert ──────────────────────────

create or replace function public.assign_showroom_quotation_no()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer;
  v_seq  integer;
begin
  -- Idempotent: never overwrite an existing quotation_no
  if NEW.quotation_no is not null then
    return NEW;
  end if;

  -- Column defaults (including created_at = now()) are applied before
  -- BEFORE triggers fire, so NEW.created_at is already populated.
  v_year := extract(year from coalesce(NEW.created_at, now()))::integer;

  -- Atomic upsert: increment counter for this year, return new value.
  -- ON CONFLICT DO UPDATE is serialized per-row in Postgres, so concurrent
  -- inserts for the same year are safely sequenced without an explicit lock.
  insert into public.showroom_quotation_seq (year, last_seq)
  values (v_year, 1)
  on conflict (year) do update
    set last_seq = showroom_quotation_seq.last_seq + 1
  returning last_seq into v_seq;

  NEW.quotation_no := 'BOE-Q-' || v_year || '-' || lpad(v_seq::text, 4, '0');
  return NEW;
end;
$$;

-- ─── 3. Trigger: fire before every insert ────────────────────────────────────

drop trigger if exists showroom_inquiries_assign_quotation_no
  on public.showroom_inquiries;

create trigger showroom_inquiries_assign_quotation_no
  before insert on public.showroom_inquiries
  for each row execute function public.assign_showroom_quotation_no();

-- ─── 4. Uniqueness constraint on quotation_no ────────────────────────────────
-- Partial: only enforces uniqueness where quotation_no is not null,
-- so historical null rows (before backfill completes) don't conflict.

create unique index if not exists showroom_inquiries_quotation_no_uidx
  on public.showroom_inquiries (quotation_no)
  where quotation_no is not null;

-- ─── 5. Backfill existing rows ───────────────────────────────────────────────
-- Assigns quotation_no to every row that lacks one, ordered by created_at
-- (oldest first) so numbering reflects the original submission order.
-- Runs entirely within a single transaction to stay consistent.

do $$
declare
  rec     record;
  v_year  integer;
  v_seq   integer;
begin
  for rec in
    select id, created_at
    from   public.showroom_inquiries
    where  quotation_no is null
    order  by created_at asc
  loop
    v_year := extract(year from rec.created_at)::integer;

    insert into public.showroom_quotation_seq (year, last_seq)
    values (v_year, 1)
    on conflict (year) do update
      set last_seq = showroom_quotation_seq.last_seq + 1
    returning last_seq into v_seq;

    update public.showroom_inquiries
      set quotation_no = 'BOE-Q-' || v_year || '-' || lpad(v_seq::text, 4, '0')
      where id = rec.id;
  end loop;
end;
$$;
