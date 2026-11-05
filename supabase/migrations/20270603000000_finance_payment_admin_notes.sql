-- 20270603000000_finance_payment_admin_notes.sql
--
-- Finance: a private note on a payment request that only an ADMIN can see (owner request 2026-11-05, approved "Yes, build it").
--
-- WHY A TABLE OF ITS OWN. finance_payment_requests.admin_note already exists, but it is the Finance DECISION note (the
-- rejection reason, the clarification question, the verification note) and the person who sent the payment reads it. A
-- column on the payment row cannot be hidden from the person who may read the row, so the private note lives in its own
-- table: nobody who reads a payment through a list, the view finance_received_payments, an export or the activity history
-- can ever receive it by accident.
--
-- THE RULE. Only an ACTIVE user whose role is 'admin' may read or write it. Not the salesperson, not a Finance approver,
-- not a manager, not a holder of finance.view_all or finance.manage. The table has RLS on, no policy and no grant for any
-- client role; the only doors are the two functions below, and each one checks the admin role first.
--
-- WHAT IT IS NOT. Not written to the payment's activity history (which the salesperson reads), not a notification, and it
-- changes no payment, allocation, status or amount. One note per payment, 1 to 2,000 characters, last write wins.
-- Saving an empty note removes it. Deleting a payment (admin deletion by claim, or Test Data Cleanup) deletes its note.
--
-- ORDERING. After 20270602000000. Apply this BEFORE the code is deployed: without it the admin's note icon cannot read
-- or save, and says so (nothing else on the page is affected).
-- ROLLBACK: drop function public.set_payment_admin_note(uuid, text); drop function public.get_payment_admin_notes(uuid[]);
--   drop function public.finance_admin_note_caller_is_admin(); drop table public.finance_payment_admin_notes.

do $dep$
begin
  if to_regclass('public.finance_payment_requests') is null or to_regclass('public.users') is null then
    raise exception 'DEPENDENCY MISSING: finance_payment_requests and users must exist';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'finance_payment_requests' and column_name = 'deleted_at') then
    raise exception 'DEPENDENCY MISSING: finance_payment_requests.deleted_at (20270226000000)';
  end if;
end $dep$;

-- ═══ 1. The table ═══════════════════════════════════════════════════════════════════════════════════════════════

create table public.finance_payment_admin_notes (
  payment_id uuid primary key references public.finance_payment_requests (id) on delete cascade,
  note       text not null,
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint finance_payment_admin_notes_note_ok
    check (btrim(note, E' \t\r\n') <> '' and char_length(note) <= 2000)
);

comment on table public.finance_payment_admin_notes is
  'A private note on a payment, readable and writable only by an active role admin through get_payment_admin_notes / set_payment_admin_note. Not the Finance decision note (finance_payment_requests.admin_note, which the submitter reads). 20270603000000.';

alter table public.finance_payment_admin_notes enable row level security;
-- No policy: with RLS on, no client role can read or write a row. The grants go too, so the refusal is not only RLS.
revoke all on table public.finance_payment_admin_notes from public, anon, authenticated;

-- ═══ 2. The one definition of "an admin who may see these" ═════════════════════════════════════════════════════════

create or replace function public.finance_admin_note_caller_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role = 'admin'
       and u.is_active
       and coalesce(u.is_deleted, false) = false
  );
$fn$;

revoke execute on function public.finance_admin_note_caller_is_admin() from public, anon, authenticated;

-- ═══ 3. Read: the notes of the payments on screen ══════════════════════════════════════════════════════════════════

create or replace function public.get_payment_admin_notes(p_payment_ids uuid[])
returns table (payment_id uuid, note text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if auth.uid() is null or not public.finance_admin_note_caller_is_admin() then
    raise exception 'ADMIN_NOTE_ADMIN_ONLY: only an administrator can read payment notes' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_payment_ids), 0) > 500 then
    raise exception 'ADMIN_NOTE_TOO_MANY: ask for at most 500 payments at a time' using errcode = '22023';
  end if;
  return query
    select n.payment_id, n.note, n.updated_at
      from public.finance_payment_admin_notes n
     where n.payment_id = any (coalesce(p_payment_ids, '{}'::uuid[]));
end;
$fn$;

revoke execute on function public.get_payment_admin_notes(uuid[]) from public, anon;
grant  execute on function public.get_payment_admin_notes(uuid[]) to authenticated;

-- ═══ 4. Write: set, change or (with an empty note) remove ═════════════════════════════════════════════════════════

-- Returns when the note was saved, or null when it was removed.
create or replace function public.set_payment_admin_note(p_payment_id uuid, p_note text)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_note text := btrim(coalesce(p_note, ''), E' \t\r\n');
  v_saved timestamptz;
begin
  if auth.uid() is null or not public.finance_admin_note_caller_is_admin() then
    raise exception 'ADMIN_NOTE_ADMIN_ONLY: only an administrator can write payment notes' using errcode = '42501';
  end if;
  if char_length(v_note) > 2000 then
    raise exception 'ADMIN_NOTE_TOO_LONG: a note can be at most 2,000 characters' using errcode = '22001';
  end if;
  -- A deleted (soft or hard) payment takes no note. Read as the owner of this function, so RLS does not hide it.
  if not exists (select 1 from public.finance_payment_requests p where p.id = p_payment_id and p.deleted_at is null) then
    raise exception 'ADMIN_NOTE_PAYMENT_NOT_FOUND: that payment does not exist' using errcode = 'P0002';
  end if;

  if v_note = '' then
    delete from public.finance_payment_admin_notes where payment_id = p_payment_id;
    return null;
  end if;

  insert into public.finance_payment_admin_notes as n (payment_id, note, updated_by, updated_at)
  values (p_payment_id, v_note, auth.uid(), now())
  on conflict (payment_id) do update
     set note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning n.updated_at into v_saved;
  return v_saved;
end;
$fn$;

revoke execute on function public.set_payment_admin_note(uuid, text) from public, anon;
grant  execute on function public.set_payment_admin_note(uuid, text) to authenticated;

-- ═══ 5. Self-check (runs when the migration is applied) ═══════════════════════════════════════════════════════════

do $assert$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.finance_payment_admin_notes'::regclass) then
    raise exception 'finance_payment_admin_notes must have row level security on';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_payment_admin_notes') then
    raise exception 'finance_payment_admin_notes must have no policy: the functions are the only door';
  end if;
  if has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'select')
     or has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'insert')
     or has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'update')
     or has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'delete')
     or has_table_privilege('anon', 'public.finance_payment_admin_notes', 'select') then
    raise exception 'no client role may touch finance_payment_admin_notes directly';
  end if;
  if has_function_privilege('anon', 'public.get_payment_admin_notes(uuid[])', 'execute')
     or has_function_privilege('anon', 'public.set_payment_admin_note(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.finance_admin_note_caller_is_admin()', 'execute') then
    raise exception 'anon must not run the note functions and the admin check is internal';
  end if;
end $assert$;
