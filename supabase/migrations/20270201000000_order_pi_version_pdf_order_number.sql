-- ═══════════════════════════════════════════════════════════════════════════
-- 20270201000000  EACH PI VERSION KEEPS THE ORDER NUMBER ITS PDF PRINTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The PI version PDF (src/app/api/orders/[id]/pi-versions/[versionId]/pdf) is
-- not stored: it is rendered every time it is opened. Until now it printed the
-- Order number as order_operational_number(display_number) — "526" — in its
-- header, its title and its filename. Every other Orders surface now shows the
-- stored four-digit number, "0526". Switching the PDF over would silently
-- change PDFs already sent to clients, so the number becomes part of the
-- version instead:
--
--   order_pi_versions.pdf_order_number — the Order reference exactly as THAT
--   version's PDF prints it. Set once, never changed.
--
-- EXISTING VERSIONS (the backfill below) keep what their PDF prints today, for
-- every status — pending, rejected, approved and superseded can all be opened.
-- The value is the route's own expression, formatOrderOperationalNumber(trim)
-- ?? trim, mirrored in SQL:
--   coalesce(order_operational_number(btrim(display_number)), btrim(display_number))
-- A version whose Order has no number stops this migration before anything is
-- written: its PDF prints an empty number today, and inventing one is not this
-- file's decision.
--
-- NEW VERSIONS are numbered when the row is CREATED — V1 inside
-- approve_order_submission(), in the same transaction that gives the Order its
-- number, and a revision when it is proposed — so a revision's PDF reads the
-- same before and after the Admin's decision.
--
-- STAGED: THIS FILE STILL STAMPS THE OLD FORM ("526") ON NEW VERSIONS. It is
-- applied while the route that formats the Order's number is live, so every
-- version created from here on is stored as exactly what that route prints —
-- and what the new route (which prints the stored value) prints too, through
-- the deploy and any window where both are serving. The stored "0526" form is
-- a separate, deliberate step, 20270202000000, applied only once the new route
-- is the only one live; it changes what FUTURE versions are stamped with and
-- nothing already stored.
--
-- ONE TRIGGER, NOT EVERY DOOR. V1 and revisions are inserted by several
-- functions (approve_order_submission, propose_order_pi_revision,
-- propose_order_pi_edit_revision, and their earlier generations). A BEFORE
-- INSERT trigger numbers them all, ignores any value a caller passes, and a
-- door added later cannot forget it. The same trigger refuses any later change:
-- approving, rejecting, superseding and viewing a version leave it alone.
--
-- NO DATE CUTOFF: which format a version prints is decided by what is stored
-- on it, not by when it was created.

do $$
begin
  if to_regclass('public.order_pi_versions') is null then
    raise exception 'DEPENDENCY MISSING: order_pi_versions (20261119000000) must exist before this migration';
  end if;
  if to_regprocedure('public.order_operational_number(text)') is null then
    raise exception 'DEPENDENCY MISSING: order_operational_number(text) (20261124000000) must exist before this migration';
  end if;
end $$;

-- Refuse, clearly and before anything is written, when a version's Order has
-- a blank or missing number: its PDF prints an empty number today.
do $$
declare
  v_blank  int;
  v_sample text;
begin
  select count(*), string_agg(v.id::text || ' (V' || v.version_number || ', ' || v.status || ')', ', ' order by v.id)
    into v_blank, v_sample
    from public.order_pi_versions v
    join public.orders o on o.id = v.order_id
   where nullif(btrim(coalesce(o.display_number, '')), '') is null;
  if v_blank > 0 then
    raise exception 'PDF_ORDER_NUMBER_BACKFILL_BLOCKED: % PI version(s) belong to an Order with a blank or missing Order number: %',
      v_blank, v_sample;
  end if;
end $$;

alter table public.order_pi_versions add column if not exists pdf_order_number text;

comment on column public.order_pi_versions.pdf_order_number is
  'The Order reference exactly as this version''s PDF prints it (header, title, filename). Set once when the version is created and never changed. Versions created before 20270202000000 carry the form the PDF printed then, e.g. "526"; later versions carry the stored display_number, e.g. "0526".';


-- ═══ 1. BACKFILL: WHAT EACH EXISTING PDF PRINTS TODAY ══════════════════════

do $$
declare
  v_updated int;
begin
  update public.order_pi_versions v
     set pdf_order_number = coalesce(public.order_operational_number(btrim(o.display_number)), btrim(o.display_number))
    from public.orders o
   where o.id = v.order_id
     and v.pdf_order_number is null;
  get diagnostics v_updated = row_count;
  raise notice 'pdf_order_number backfilled on % existing PI version(s)', v_updated;
end $$;

alter table public.order_pi_versions alter column pdf_order_number set not null;
alter table public.order_pi_versions drop constraint if exists order_pi_versions_pdf_order_number_present;
alter table public.order_pi_versions add constraint order_pi_versions_pdf_order_number_present
  check (btrim(pdf_order_number) <> '');


-- ═══ 2. NUMBERED AT CREATION, NEVER CHANGED ════════════════════════════════

create or replace function public.order_pi_versions_pdf_order_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number text;
begin
  if tg_op = 'INSERT' then
    select nullif(btrim(coalesce(o.display_number, '')), '') into v_number
      from public.orders o where o.id = new.order_id;
    if v_number is null then
      raise exception 'ORDER_PI_VERSION_ORDER_NUMBER_MISSING: the Order of this PI version has no Order number'
        using errcode = 'P0001';
    end if;
    -- Whatever the caller passed, the version prints what the live route
    -- prints for this Order today (staged; 20270202000000 switches to v_number).
    new.pdf_order_number := coalesce(public.order_operational_number(v_number), v_number);
    return new;
  end if;

  if new.pdf_order_number is distinct from old.pdf_order_number then
    raise exception 'PI_PDF_ORDER_NUMBER_IMMUTABLE: the Order number printed on PI version % cannot be changed', old.id
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.order_pi_versions_pdf_order_number() from public, anon, authenticated, service_role;

comment on function public.order_pi_versions_pdf_order_number() is
  'BEFORE INSERT: sets pdf_order_number to what the live PDF route prints for the Order — order_operational_number(display_number), "526" (staged; 20270202000000 switches new versions to the stored "0526") — refusing an Order with no number. BEFORE UPDATE: refuses any change to it. Covers every door that creates or decides a PI version. 20270201000000.';

drop trigger if exists order_pi_versions_pdf_order_number on public.order_pi_versions;
create trigger order_pi_versions_pdf_order_number
  before insert or update on public.order_pi_versions
  for each row execute function public.order_pi_versions_pdf_order_number();


-- ═══ 3. ASSERTIONS ═════════════════════════════════════════════════════════

do $$
begin
  if exists (select 1 from public.order_pi_versions where pdf_order_number is null or btrim(pdf_order_number) = '') then
    raise exception 'ASSERTION FAILED: a PI version has no pdf_order_number';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.order_pi_versions'::regclass
       and tgname = 'order_pi_versions_pdf_order_number'
       and not tgisinternal
  ) then
    raise exception 'ASSERTION FAILED: the pdf_order_number trigger is not installed';
  end if;
  if (select attnotnull from pg_attribute
       where attrelid = 'public.order_pi_versions'::regclass and attname = 'pdf_order_number') is not true then
    raise exception 'ASSERTION FAILED: pdf_order_number is not NOT NULL';
  end if;
end $$;
