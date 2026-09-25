-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20270110000000_announcements.sql, executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- src/lib/announcementsMigration.test.ts reads the migration's
-- TEXT. This runs the real objects as real signed-in accounts and proves what
-- they do.
--
-- WHAT IT PROVES, IN ORDER
-- ------------------------
--   §1  india dates             the boundary is Asia/Kolkata midnight, not UTC,
--                               and both ends of a window are inclusive
--   §2  admin-only writes       a member cannot create, edit or end; an
--                               inactive admin cannot either; no client role
--                               can write any of the three tables directly
--   §3  named audience          a recipient sees it, a non-recipient sees
--                               NOTHING (not an error), an empty list and an
--                               inactive recipient are refused
--   §4  active window           scheduled / expired / ended announcements are
--                               invisible to recipients and still visible to
--                               the admin
--   §5  own read state only     acknowledge records the caller's own row,
--                               is idempotent, is refused for an invisible
--                               announcement, and nobody reads another's reads
--   §6  read state survives     an edit keeps the acknowledgement; the
--                               notifications table plays no part
--   §7  the PDF                 upload is admin-only and key-shaped; a
--                               recipient can read exactly the attached object
--                               while live; a non-recipient, an expired window
--                               and a replaced object cannot; a claimed object
--                               cannot be deleted; a missing object cannot be
--                               attached
--   §8  anon gets nothing
--
-- Runs inside ONE transaction that ends in ROLLBACK. It refuses to run if
-- auth.users already holds anybody.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through run_announcements_local.sh.

\set ON_ERROR_STOP on

begin;

-- ─── helpers ─────────────────────────────────────────────────────────────────

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end $$;

create or replace function pg_temp.must_refuse(p_sql text, p_sqlstate text, p_label text)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception '% — refused, but with SQLSTATE % not %: %', p_label, v_state, p_sqlstate, v_msg;
    end if;
    raise notice 'PASS  % (%)', p_label, v_state;
    return;
  end;
  raise exception '% — WAS ALLOWED, and must not be', p_label;
end $$;

grant execute on function pg_temp.must_refuse(text, text, text) to authenticated, anon;

-- ─── fixtures ────────────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from auth.users) <> 0 then
    raise exception 'REFUSING TO RUN: auth.users is not empty — this is not a disposable database';
  end if;
end $$;

-- A admin, M member recipient, N member non-recipient, X inactive admin,
-- Z inactive member.
insert into auth.users (id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a'),
  ('11111111-0000-4000-8000-000000000001'),
  ('22222222-0000-4000-8000-000000000002'),
  ('33333333-0000-4000-8000-000000000003'),
  ('44444444-0000-4000-8000-000000000004');

insert into public.users (id, full_name, role, is_active, is_deleted) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Admin',          'admin',  true,  false),
  ('11111111-0000-4000-8000-000000000001', 'Member M',       'member', true,  false),
  ('22222222-0000-4000-8000-000000000002', 'Member N',       'member', true,  false),
  ('33333333-0000-4000-8000-000000000003', 'Inactive admin', 'admin',  false, false),
  ('44444444-0000-4000-8000-000000000004', 'Inactive Z',     'member', false, false);

-- ─── §1 india dates ──────────────────────────────────────────────────────────

do $$
begin
  -- 18:29:59 UTC is 23:59:59 IST; 18:30 UTC is already the next India day.
  assert public.announcement_india_date('2026-10-09 18:29:59+00') = date '2026-10-09', '§1 before IST midnight';
  assert public.announcement_india_date('2026-10-09 18:30:00+00') = date '2026-10-10', '§1 at IST midnight';
  -- Inclusive both ends; ended early is never live.
  assert public.announcement_is_live('2026-10-01', '2026-10-15', null, '2026-10-01'), '§1 start day is live';
  assert public.announcement_is_live('2026-10-01', '2026-10-15', null, '2026-10-15'), '§1 end day is live';
  assert not public.announcement_is_live('2026-10-01', '2026-10-15', null, '2026-10-16'), '§1 day after end is not live';
  assert not public.announcement_is_live('2026-10-01', '2026-10-15', null, '2026-09-30'), '§1 day before start is not live';
  assert not public.announcement_is_live('2026-10-01', '2026-10-15', now(), '2026-10-05'), '§1 ended early is not live';
  raise notice 'PASS §1 India dates, inclusive window';
end $$;

-- ─── §2 admin-only writes ────────────────────────────────────────────────────

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');

-- The live one: 15 days from today in India, for M only.
select public.create_announcement(
  'c0000000-0000-4000-8000-000000000001', '  Exhibition staff guidelines  ', 'Summary', 'Full text',
  public.announcement_india_date(), public.announcement_india_date() + 14,
  array['11111111-0000-4000-8000-000000000001']::uuid[]);

do $$
begin
  assert (select title from public.announcements where id = 'c0000000-0000-4000-8000-000000000001')
         = 'Exhibition staff guidelines', '§2 title is trimmed';
  assert (select created_by from public.announcements where id = 'c0000000-0000-4000-8000-000000000001')
         = 'aaaaaaaa-0000-4000-8000-00000000000a', '§2 created_by is the caller';
  raise notice 'PASS §2 admin creates';
end $$;

select pg_temp.act_as('11111111-0000-4000-8000-000000000001');
select pg_temp.must_refuse(
  $q$select public.create_announcement('c0000000-0000-4000-8000-0000000000ff', 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date(),
       array['11111111-0000-4000-8000-000000000001']::uuid[])$q$,
  '42501', '§2 a member cannot create');
select pg_temp.must_refuse(
  $q$select public.update_announcement('c0000000-0000-4000-8000-000000000001', 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date(),
       array['11111111-0000-4000-8000-000000000001']::uuid[])$q$,
  '42501', '§2 a member cannot edit');
select pg_temp.must_refuse(
  $q$select public.end_announcement('c0000000-0000-4000-8000-000000000001')$q$,
  '42501', '§2 a member cannot end');
select pg_temp.must_refuse(
  $q$insert into public.announcements (id, title, summary, body, starts_on, ends_on, created_by)
     values (gen_random_uuid(), 't', 's', 'b', current_date, current_date, auth.uid())$q$,
  '42501', '§2 a member cannot insert into announcements directly');
select pg_temp.must_refuse(
  $q$insert into public.announcement_recipients values ('c0000000-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002')$q$,
  '42501', '§2 a member cannot add a recipient directly');
select pg_temp.must_refuse(
  $q$update public.announcements set title = 'hijacked'$q$,
  '42501', '§2 a member cannot update announcements directly');

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');
select pg_temp.must_refuse(
  $q$insert into public.announcement_reads values ('c0000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', now())$q$,
  '42501', '§2 not even an admin writes reads directly');
select pg_temp.must_refuse(
  $q$delete from public.announcements$q$,
  '42501', '§2 not even an admin deletes directly');

select pg_temp.act_as('33333333-0000-4000-8000-000000000003');
select pg_temp.must_refuse(
  $q$select public.create_announcement('c0000000-0000-4000-8000-0000000000fe', 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date(),
       array['11111111-0000-4000-8000-000000000001']::uuid[])$q$,
  '42501', '§2 an inactive admin cannot create');

-- ─── §3 named audience ───────────────────────────────────────────────────────

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');
select pg_temp.must_refuse(
  $q$select public.create_announcement(gen_random_uuid(), 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date(), array[]::uuid[])$q$,
  'P0001', '§3 no recipients is refused');
select pg_temp.must_refuse(
  $q$select public.create_announcement(gen_random_uuid(), 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date(),
       array['44444444-0000-4000-8000-000000000004']::uuid[])$q$,
  'P0001', '§3 an inactive recipient is refused');
select pg_temp.must_refuse(
  $q$select public.create_announcement(gen_random_uuid(), 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date() - 1,
       array['11111111-0000-4000-8000-000000000001']::uuid[])$q$,
  'P0001', '§3 end before start is refused');
select pg_temp.must_refuse(
  $q$select public.create_announcement(gen_random_uuid(), 't', 's', 'b',
       public.announcement_india_date() - 5, public.announcement_india_date() - 1,
       array['11111111-0000-4000-8000-000000000001']::uuid[])$q$,
  'P0001', '§3 a window that already ended is refused');

select pg_temp.act_as('11111111-0000-4000-8000-000000000001');
do $$
begin
  assert (select count(*) from public.my_announcements()) = 1, '§3 recipient M sees one';
  assert (select read_at from public.my_announcements()) is null, '§3 it starts unread';
  assert (select count(*) from public.announcements) = 1, '§3 M can select it through RLS';
  raise notice 'PASS §3 recipient sees it, unread';
end $$;

select pg_temp.act_as('22222222-0000-4000-8000-000000000002');
do $$
begin
  assert (select count(*) from public.my_announcements()) = 0, '§3 non-recipient N sees nothing via RPC';
  assert (select count(*) from public.announcements) = 0, '§3 non-recipient N selects nothing';
  assert (select count(*) from public.announcement_recipients) = 0, '§3 N cannot read the audience';
  raise notice 'PASS §3 non-recipient sees nothing';
end $$;

-- ─── §4 active window ────────────────────────────────────────────────────────

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');
-- Scheduled: starts tomorrow.
select public.create_announcement('c0000000-0000-4000-8000-000000000002', 'Scheduled', 's', 'b',
  public.announcement_india_date() + 1, public.announcement_india_date() + 3,
  array['11111111-0000-4000-8000-000000000001']::uuid[]);
-- Ended early.
select public.create_announcement('c0000000-0000-4000-8000-000000000003', 'Ended', 's', 'b',
  public.announcement_india_date(), public.announcement_india_date() + 3,
  array['11111111-0000-4000-8000-000000000001']::uuid[]);
select public.end_announcement('c0000000-0000-4000-8000-000000000003');
select public.end_announcement('c0000000-0000-4000-8000-000000000003'); -- idempotent
-- Ends today (still live), and one moved into the past (expired) by an edit.
select public.create_announcement('c0000000-0000-4000-8000-000000000004', 'Ends today', 's', 'b',
  public.announcement_india_date(), public.announcement_india_date(),
  array['11111111-0000-4000-8000-000000000001']::uuid[]);
select public.create_announcement('c0000000-0000-4000-8000-000000000005', 'Expired', 's', 'b',
  public.announcement_india_date(), public.announcement_india_date(),
  array['11111111-0000-4000-8000-000000000001']::uuid[]);
select public.update_announcement('c0000000-0000-4000-8000-000000000005', 'Expired', 's', 'b',
  public.announcement_india_date() - 10, public.announcement_india_date() - 1,
  array['11111111-0000-4000-8000-000000000001']::uuid[]);

do $$
begin
  assert (select count(*) from public.announcements) = 5, '§4 admin still sees all five';
  assert (select ended_by from public.announcements where id = 'c0000000-0000-4000-8000-000000000003')
         = 'aaaaaaaa-0000-4000-8000-00000000000a', '§4 ended_by recorded';
end $$;

select pg_temp.act_as('11111111-0000-4000-8000-000000000001');
do $$
declare v text[];
begin
  select array_agg(title order by title) into v from public.my_announcements();
  assert v = array['Ends today', 'Exhibition staff guidelines'],
    format('§4 M sees exactly the live two, got %s', v);
  assert (select count(*) from public.announcements) = 2, '§4 RLS agrees with the RPC';
  raise notice 'PASS §4 scheduled, ended and expired are hidden; end day is inclusive';
end $$;

-- ─── §5 own read state only ──────────────────────────────────────────────────

select pg_temp.act_as('11111111-0000-4000-8000-000000000001');
select public.acknowledge_announcement('c0000000-0000-4000-8000-000000000001');

do $$
declare v1 timestamptz; v2 timestamptz;
begin
  select read_at into v1 from public.announcement_reads where announcement_id = 'c0000000-0000-4000-8000-000000000001';
  perform pg_sleep(0.01);
  v2 := public.acknowledge_announcement('c0000000-0000-4000-8000-000000000001');
  assert v1 is not null and v1 = v2, '§5 a second press keeps the first read_at';
  assert (select count(*) from public.announcement_reads) = 1, '§5 one row, M''s own';
  assert (select user_id from public.announcement_reads) = '11111111-0000-4000-8000-000000000001', '§5 the row is the caller''s';
  assert (select read_at from public.my_announcements() where id = 'c0000000-0000-4000-8000-000000000001') is not null,
    '§5 my_announcements reports it read';
  raise notice 'PASS §5 acknowledge is own-row and idempotent';
end $$;

select pg_temp.must_refuse(
  $q$select public.acknowledge_announcement('c0000000-0000-4000-8000-000000000002')$q$,
  '42501', '§5 cannot acknowledge a scheduled announcement');
select pg_temp.must_refuse(
  $q$select public.acknowledge_announcement('c0000000-0000-4000-8000-000000000005')$q$,
  '42501', '§5 cannot acknowledge an expired announcement');

select pg_temp.act_as('22222222-0000-4000-8000-000000000002');
select pg_temp.must_refuse(
  $q$select public.acknowledge_announcement('c0000000-0000-4000-8000-000000000001')$q$,
  '42501', '§5 a non-recipient cannot acknowledge');
do $$
begin
  assert (select count(*) from public.announcement_reads) = 0, '§5 N cannot see M''s read';
  raise notice 'PASS §5 nobody reads another''s read state';
end $$;

-- ─── §6 read state survives an edit ──────────────────────────────────────────

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');
select public.update_announcement('c0000000-0000-4000-8000-000000000001', 'Exhibition staff guidelines (corrected)',
  'Summary', 'Full text', public.announcement_india_date(), public.announcement_india_date() + 14,
  array['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002']::uuid[]);

select pg_temp.act_as('11111111-0000-4000-8000-000000000001');
do $$
begin
  assert (select read_at from public.my_announcements() where id = 'c0000000-0000-4000-8000-000000000001') is not null,
    '§6 M stays acknowledged after an edit';
end $$;
select pg_temp.act_as('22222222-0000-4000-8000-000000000002');
do $$
begin
  assert (select count(*) from public.my_announcements() where read_at is null) = 1, '§6 N, now added, has it unread';
  raise notice 'PASS §6 edits keep acknowledgements; added recipients start unread';
end $$;

do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'create_announcement', 'update_announcement', 'end_announcement',
      'acknowledge_announcement', 'my_announcements', 'announcement_visible_to_caller')
      and p.prosrc ilike '%notifications%'
  ), '§6 no announcement function reads or writes public.notifications';
  raise notice 'PASS §6 independent of notifications';
end $$;

-- ─── §7 the PDF ──────────────────────────────────────────────────────────────

select pg_temp.act_as_owner();
-- Objects as the storage API would leave them after an upload.
insert into storage.objects (bucket_id, name, owner) values
  ('announcement-files', 'c0000000-0000-4000-8000-000000000001/one.pdf', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('announcement-files', 'c0000000-0000-4000-8000-000000000001/two.pdf', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('announcement-files', 'c0000000-0000-4000-8000-000000000005/old.pdf', 'aaaaaaaa-0000-4000-8000-00000000000a');

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');
select pg_temp.must_refuse(
  $q$select public.update_announcement('c0000000-0000-4000-8000-000000000001', 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date() + 14,
       array['11111111-0000-4000-8000-000000000001']::uuid[],
       'c0000000-0000-4000-8000-000000000001/missing.pdf', 'missing.pdf', 10)$q$,
  'P0001', '§7 a PDF that is not in storage cannot be attached');
select pg_temp.must_refuse(
  $q$select public.update_announcement('c0000000-0000-4000-8000-000000000001', 't', 's', 'b',
       public.announcement_india_date(), public.announcement_india_date() + 14,
       array['11111111-0000-4000-8000-000000000001']::uuid[],
       'c0000000-0000-4000-8000-000000000005/old.pdf', 'old.pdf', 10)$q$,
  'P0001', '§7 another announcement''s PDF cannot be attached');

select public.update_announcement('c0000000-0000-4000-8000-000000000001', 'Exhibition staff guidelines',
  'Summary', 'Full text', public.announcement_india_date(), public.announcement_india_date() + 14,
  array['11111111-0000-4000-8000-000000000001']::uuid[],
  'c0000000-0000-4000-8000-000000000001/two.pdf', 'Guidelines.pdf', 2048);
select public.update_announcement('c0000000-0000-4000-8000-000000000005', 'Expired', 's', 'b',
  public.announcement_india_date() - 10, public.announcement_india_date() - 1,
  array['11111111-0000-4000-8000-000000000001']::uuid[],
  'c0000000-0000-4000-8000-000000000005/old.pdf', 'old.pdf', 10);

-- Insert policy, exercised as the storage API does (INSERT as the caller).
select pg_temp.must_refuse(
  $q$insert into storage.objects (bucket_id, name) values ('announcement-files', 'not-a-uuid/x.pdf')$q$,
  '42501', '§7 even an admin cannot upload under a malformed key');

select pg_temp.act_as('11111111-0000-4000-8000-000000000001');
select pg_temp.must_refuse(
  $q$insert into storage.objects (bucket_id, name) values ('announcement-files', 'c0000000-0000-4000-8000-000000000001/evil.pdf')$q$,
  '42501', '§7 a member cannot upload');
do $$
declare v text[];
begin
  select array_agg(name order by name) into v from storage.objects where bucket_id = 'announcement-files';
  assert v = array['c0000000-0000-4000-8000-000000000001/two.pdf'],
    format('§7 M reads exactly the attached object of the live announcement, got %s', v);
  raise notice 'PASS §7 recipient reads the current PDF only; the replaced one and the expired one are hidden';
end $$;

select pg_temp.act_as('22222222-0000-4000-8000-000000000002');
do $$
begin
  -- N was removed from the audience by the last update.
  assert (select count(*) from storage.objects where bucket_id = 'announcement-files') = 0,
    '§7 a non-recipient reads no PDF';
  raise notice 'PASS §7 non-recipient reads nothing';
end $$;

select pg_temp.act_as('aaaaaaaa-0000-4000-8000-00000000000a');
do $$
declare n int;
begin
  assert (select count(*) from storage.objects where bucket_id = 'announcement-files') = 3, '§7 admin reads all three';
  -- The claimed object survives a delete; the orphan does not. The Storage API
  -- sets this flag before its own DELETE; set it here so RLS is what decides.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'announcement-files'
    and name in ('c0000000-0000-4000-8000-000000000001/two.pdf', 'c0000000-0000-4000-8000-000000000001/one.pdf');
  get diagnostics n = row_count;
  assert n = 1, format('§7 exactly the orphan is deletable, deleted %s', n);
  assert exists (select 1 from storage.objects where name = 'c0000000-0000-4000-8000-000000000001/two.pdf'),
    '§7 the attached PDF is still there';
  raise notice 'PASS §7 admin deletes only an unclaimed object';
end $$;

-- ─── §8 anon gets nothing ────────────────────────────────────────────────────

select pg_temp.act_as_anon();
select pg_temp.must_refuse($q$select count(*) from public.announcements$q$, '42501', '§8 anon cannot read announcements');
select pg_temp.must_refuse($q$select count(*) from public.announcement_reads$q$, '42501', '§8 anon cannot read reads');
select pg_temp.must_refuse($q$select * from public.my_announcements()$q$, '42501', '§8 anon cannot call my_announcements');
select pg_temp.must_refuse($q$select public.acknowledge_announcement('c0000000-0000-4000-8000-000000000001')$q$,
  '42501', '§8 anon cannot acknowledge');

select pg_temp.act_as_owner();
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
