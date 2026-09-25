-- ANNOUNCEMENTS: ADMIN-WRITTEN NOTICES FOR NAMED PEOPLE, WITH A PER-PERSON
-- "I HAVE READ THIS".
--
-- WHAT THIS MIGRATION IS FOR
-- --------------------------
-- An administrator publishes a short notice — a title, a one-line summary, the
-- full text and optionally a PDF — to the people they choose, for a window of
-- dates. While it is active each of those people sees it on the Modules page
-- until they press "I have read this", and can reopen it from Announcements for
-- the rest of the window. Nobody else sees it at all.
--
-- THE AUDIENCE IS A LIST OF NAMED PEOPLE, never "everyone". An announcement with
-- no recipients is refused. Visibility is decided here, in the database, from
-- that list — the banner, the Announcements list, the full text and the PDF all
-- read through the same rule, so none of them can show a person something the
-- others would hide.
--
-- THE READ STATE IS ITS OWN TABLE, one row per person per announcement, written
-- only by that person through acknowledge_announcement(). It is deliberately
-- NOT a row in public.notifications: reading, marking read or deleting an
-- ordinary notification cannot touch it, and nothing is written merely because
-- a page loaded.
--
-- DATES ARE INDIA DATES, BOTH ENDS INCLUSIVE. An announcement starting on the
-- 1st and ending on the 15th is visible from 00:00 IST on the 1st until 23:59:59
-- IST on the 15th, whatever time zone the server or the browser is in. There is
-- no scheduled job: "active" is computed on every read, so expiry needs nothing
-- to run. An administrator may also end one early, which is recorded.
--
-- WHAT IT ADDS
--   1.  public.announcements                     content + window, RLS on
--   2.  public.announcement_recipients           who may see each one, RLS on
--   3.  public.announcement_reads                who has acknowledged, RLS on
--   4.  helpers                                  india date, active, visibility,
--                                                admin check
--   5.  write RPCs (admin only)                  create / update / end
--   6.  acknowledge_announcement(uuid)           the one write a user may make,
--                                                for themselves only
--   7.  my_announcements()                       the caller's active list
--   8.  storage bucket announcement-files        private, PDF only, 10 MiB
--   9.  storage policies                         write = admin, read = admin or
--                                                a current recipient
--
-- WHAT IT DOES NOT TOUCH. public.notifications, the notification_type enum,
-- every existing table, function and policy. It is purely additive.
--
-- IDEMPOTENT. Every object is created if-not-exists or replaced, every policy is
-- dropped before it is created, and the verification block at the end raises if
-- any of it did not take. Re-running is a no-op.

-- ═══ 0. What this migration assumes already exists ═══════════════════════════

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'public.users is missing';
  end if;
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception 'storage.objects / storage.buckets are missing';
  end if;
end;
$$;


-- ═══ 1. The announcements ════════════════════════════════════════════════════

create table if not exists public.announcements (
  id               uuid        primary key default gen_random_uuid(),
  title            text        not null,
  summary          text        not null,
  body             text        not null,
  -- The PDF, when there is one: its object key in announcement-files, the name
  -- it was uploaded under and its size. All three or none.
  attachment_path  text,
  attachment_name  text,
  attachment_size  integer,
  starts_on        date        not null,
  ends_on          date        not null,
  -- Set only by end_announcement(): the moment an administrator withdrew it
  -- before its end date. Null for an announcement that simply runs its course.
  ended_at         timestamptz,
  ended_by         uuid        references public.users(id),
  created_by       uuid        not null references public.users(id),
  created_at       timestamptz not null default now(),
  updated_by       uuid        references public.users(id),
  updated_at       timestamptz not null default now(),

  constraint announcements_title_len   check (char_length(btrim(title))   between 1 and 120),
  constraint announcements_summary_len check (char_length(btrim(summary)) between 1 and 280),
  constraint announcements_body_len    check (char_length(btrim(body))    between 1 and 20000),
  constraint announcements_window      check (ends_on >= starts_on),
  constraint announcements_attachment_all_or_none check (
    (attachment_path is null and attachment_name is null and attachment_size is null)
    or (attachment_path is not null and attachment_name is not null and attachment_size is not null)
  ),
  constraint announcements_attachment_under_own_id check (
    attachment_path is null or split_part(attachment_path, '/', 1) = id::text
  ),
  constraint announcements_ended_pair check ((ended_at is null) = (ended_by is null))
);

create index if not exists announcements_window_idx
  on public.announcements (ends_on, starts_on) where ended_at is null;


-- ═══ 2. Who each announcement is for ═════════════════════════════════════════

create table if not exists public.announcement_recipients (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  primary key (announcement_id, user_id)
);

create index if not exists announcement_recipients_user_idx
  on public.announcement_recipients (user_id);


-- ═══ 3. Who has acknowledged it ══════════════════════════════════════════════

create table if not exists public.announcement_reads (
  announcement_id uuid        not null references public.announcements(id) on delete cascade,
  user_id         uuid        not null references public.users(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create index if not exists announcement_reads_user_idx
  on public.announcement_reads (user_id);


-- ═══ 4. Helpers ══════════════════════════════════════════════════════════════

-- Today, in India. Takes the instant as a parameter so the midnight boundary can
-- be tested with fixed timestamps rather than the wall clock.
create or replace function public.announcement_india_date(p_at timestamptz default now())
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (p_at at time zone 'Asia/Kolkata')::date;
$$;

comment on function public.announcement_india_date(timestamptz) is
  'The calendar date in Asia/Kolkata at the given instant (default now()). Announcement windows are India dates, inclusive at both ends.';

-- Whether a window is live on a given India date. Pure, so the rule is stated
-- once and every caller (RLS, RPCs, tests) uses the same one.
create or replace function public.announcement_is_live(
  p_starts_on date, p_ends_on date, p_ended_at timestamptz, p_on date
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_ended_at is null and p_starts_on <= p_on and p_on <= p_ends_on;
$$;

comment on function public.announcement_is_live(date, date, timestamptz, date) is
  'True when an announcement window includes the given India date and it has not been ended early. Both ends inclusive.';

-- The caller is an active, non-deleted administrator. SECURITY DEFINER because
-- public.users' RLS does not show every row to every caller.
create or replace function public.announcement_caller_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
  );
$$;

comment on function public.announcement_caller_is_admin() is
  'True when the signed-in caller is an active, non-deleted admin. The one write authority for announcements.';

-- The caller may see this announcement as an employee: they are active, they are
-- a named recipient, and it is live today in India.
create or replace function public.announcement_visible_to_caller(p_announcement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.announcements a
    join public.announcement_recipients r
      on r.announcement_id = a.id and r.user_id = auth.uid()
    join public.users u
      on u.id = r.user_id and u.is_active and coalesce(u.is_deleted, false) = false
    where a.id = p_announcement_id
      and public.announcement_is_live(a.starts_on, a.ends_on, a.ended_at,
                                      public.announcement_india_date())
  );
$$;

comment on function public.announcement_visible_to_caller(uuid) is
  'True when the signed-in caller is an active named recipient of the announcement and it is live today (India date, inclusive).';

-- The announcement id an announcement-files object key belongs to, or null when
-- the key is not {uuid}/{file}.pdf. Never raises, so policies fail closed.
create or replace function public.announcement_file_announcement_id(p_name text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_name is null then null
    when p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.pdf$' then null
    else split_part(p_name, '/', 1)::uuid
  end;
$$;

comment on function public.announcement_file_announcement_id(text) is
  'The announcement id encoded in an announcement-files object key ({uuid}/{name}.pdf), or null for any other key.';

revoke execute on function public.announcement_india_date(timestamptz)                   from public, anon;
revoke execute on function public.announcement_is_live(date, date, timestamptz, date)     from public, anon;
revoke execute on function public.announcement_caller_is_admin()                          from public, anon;
revoke execute on function public.announcement_visible_to_caller(uuid)                    from public, anon;
revoke execute on function public.announcement_file_announcement_id(text)                 from public, anon;
grant  execute on function public.announcement_india_date(timestamptz)                   to authenticated;
grant  execute on function public.announcement_is_live(date, date, timestamptz, date)     to authenticated;
grant  execute on function public.announcement_caller_is_admin()                          to authenticated;
grant  execute on function public.announcement_visible_to_caller(uuid)                    to authenticated;
grant  execute on function public.announcement_file_announcement_id(text)                 to authenticated;


-- ═══ 1–3 (cont.). Row security ═══════════════════════════════════════════════
--
-- READS ONLY. No client role holds INSERT, UPDATE or DELETE on any of the three
-- tables: every write goes through a function below, which checks the caller
-- itself. RLS here decides what a SELECT returns.
--
--   announcements            admin: all. Anyone else: those visible to them.
--   announcement_recipients  admin: all. Anyone else: their own rows.
--   announcement_reads       admin: all. Anyone else: their own rows.

alter table public.announcements           enable row level security;
alter table public.announcements           force  row level security;
alter table public.announcement_recipients enable row level security;
alter table public.announcement_recipients force  row level security;
alter table public.announcement_reads      enable row level security;
alter table public.announcement_reads      force  row level security;

revoke all on table public.announcements           from public, anon, authenticated;
revoke all on table public.announcement_recipients from public, anon, authenticated;
revoke all on table public.announcement_reads      from public, anon, authenticated;
grant select on table public.announcements           to authenticated;
grant select on table public.announcement_recipients to authenticated;
grant select on table public.announcement_reads      to authenticated;

drop policy if exists "announcements_select" on public.announcements;
create policy "announcements_select" on public.announcements
  for select to authenticated
  using (public.announcement_caller_is_admin() or public.announcement_visible_to_caller(id));

drop policy if exists "announcement_recipients_select" on public.announcement_recipients;
create policy "announcement_recipients_select" on public.announcement_recipients
  for select to authenticated
  using (user_id = auth.uid() or public.announcement_caller_is_admin());

drop policy if exists "announcement_reads_select" on public.announcement_reads;
create policy "announcement_reads_select" on public.announcement_reads
  for select to authenticated
  using (user_id = auth.uid() or public.announcement_caller_is_admin());


-- ═══ 5. Admin writes ═════════════════════════════════════════════════════════
--
-- One validator for create and update, so the two cannot disagree about what a
-- valid announcement is. Errors are ANNOUNCEMENT_<CODE>: message, which the
-- screen shows as-is.

create or replace function public.announcement_validate_recipients(p_recipient_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids   uuid[];
  v_valid int;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids
  from unnest(coalesce(p_recipient_ids, '{}')) as x
  where x is not null;

  if cardinality(v_ids) = 0 then
    raise exception 'ANNOUNCEMENT_NO_RECIPIENTS: choose at least one person to show this announcement to'
      using errcode = 'P0001';
  end if;

  select count(*) into v_valid
  from public.users u
  where u.id = any(v_ids) and u.is_active and coalesce(u.is_deleted, false) = false;

  if v_valid <> cardinality(v_ids) then
    raise exception 'ANNOUNCEMENT_RECIPIENT_INACTIVE: every recipient must be an active employee'
      using errcode = 'P0001';
  end if;

  return v_ids;
end;
$$;

revoke execute on function public.announcement_validate_recipients(uuid[]) from public, anon, authenticated;

-- A PDF is attached by naming an object that ALREADY exists in the bucket under
-- this announcement's own id. The browser uploads first (storage policy: admin
-- only), then calls create/update; a path naming nothing is refused, so a row
-- can never point at a file that is not there.
create or replace function public.announcement_check_attachment(
  p_announcement_id uuid, p_path text, p_name text, p_size integer
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_path is null and p_name is null and p_size is null then
    return;
  end if;
  if p_path is null or p_name is null or p_size is null then
    raise exception 'ANNOUNCEMENT_ATTACHMENT_INCOMPLETE: the PDF path, name and size go together'
      using errcode = 'P0001';
  end if;
  if public.announcement_file_announcement_id(p_path) is distinct from p_announcement_id then
    raise exception 'ANNOUNCEMENT_ATTACHMENT_PATH: the PDF must be stored under this announcement'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'announcement-files' and o.name = p_path
  ) then
    raise exception 'ANNOUNCEMENT_ATTACHMENT_MISSING: the PDF was not found in storage; upload it again'
      using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.announcement_check_attachment(uuid, text, text, integer) from public, anon, authenticated;

create or replace function public.create_announcement(
  p_id              uuid,
  p_title           text,
  p_summary         text,
  p_body            text,
  p_starts_on       date,
  p_ends_on         date,
  p_recipient_ids   uuid[],
  p_attachment_path text    default null,
  p_attachment_name text    default null,
  p_attachment_size integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if not public.announcement_caller_is_admin() then
    raise exception 'ANNOUNCEMENT_FORBIDDEN: only an administrator can publish announcements'
      using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'ANNOUNCEMENT_ID_REQUIRED: an id is required' using errcode = 'P0001';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'ANNOUNCEMENT_DATES: the end date must be on or after the start date'
      using errcode = 'P0001';
  end if;
  if p_ends_on < public.announcement_india_date() then
    raise exception 'ANNOUNCEMENT_DATES: the end date has already passed'
      using errcode = 'P0001';
  end if;

  v_ids := public.announcement_validate_recipients(p_recipient_ids);
  perform public.announcement_check_attachment(p_id, p_attachment_path, p_attachment_name, p_attachment_size);

  insert into public.announcements (
    id, title, summary, body, starts_on, ends_on,
    attachment_path, attachment_name, attachment_size,
    created_by, updated_by
  ) values (
    p_id, btrim(p_title), btrim(p_summary), btrim(p_body), p_starts_on, p_ends_on,
    p_attachment_path, p_attachment_name, p_attachment_size,
    auth.uid(), auth.uid()
  );

  insert into public.announcement_recipients (announcement_id, user_id)
  select p_id, x from unnest(v_ids) as x;

  return p_id;
end;
$$;

comment on function public.create_announcement(uuid, text, text, text, date, date, uuid[], text, text, integer) is
  'Admin only. Publishes an announcement to the named active recipients for an India-date window (inclusive). A PDF, if any, must already be uploaded under {id}/.';

-- Edits keep everybody's acknowledgement: correcting a typo is not a new notice.
-- Recipients removed from the list lose sight of it at once; their read row is
-- kept as history.
create or replace function public.update_announcement(
  p_id              uuid,
  p_title           text,
  p_summary         text,
  p_body            text,
  p_starts_on       date,
  p_ends_on         date,
  p_recipient_ids   uuid[],
  p_attachment_path text    default null,
  p_attachment_name text    default null,
  p_attachment_size integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if not public.announcement_caller_is_admin() then
    raise exception 'ANNOUNCEMENT_FORBIDDEN: only an administrator can edit announcements'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.announcements where id = p_id) then
    raise exception 'ANNOUNCEMENT_NOT_FOUND: that announcement does not exist' using errcode = 'P0002';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'ANNOUNCEMENT_DATES: the end date must be on or after the start date'
      using errcode = 'P0001';
  end if;

  v_ids := public.announcement_validate_recipients(p_recipient_ids);
  perform public.announcement_check_attachment(p_id, p_attachment_path, p_attachment_name, p_attachment_size);

  update public.announcements set
    title           = btrim(p_title),
    summary         = btrim(p_summary),
    body            = btrim(p_body),
    starts_on       = p_starts_on,
    ends_on         = p_ends_on,
    attachment_path = p_attachment_path,
    attachment_name = p_attachment_name,
    attachment_size = p_attachment_size,
    updated_by      = auth.uid(),
    updated_at      = now()
  where id = p_id;

  delete from public.announcement_recipients
  where announcement_id = p_id and user_id <> all(v_ids);

  insert into public.announcement_recipients (announcement_id, user_id)
  select p_id, x from unnest(v_ids) as x
  on conflict do nothing;

  return p_id;
end;
$$;

comment on function public.update_announcement(uuid, text, text, text, date, date, uuid[], text, text, integer) is
  'Admin only. Replaces an announcement''s content, window, recipients and PDF. Existing acknowledgements are kept.';

create or replace function public.end_announcement(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.announcement_caller_is_admin() then
    raise exception 'ANNOUNCEMENT_FORBIDDEN: only an administrator can end announcements'
      using errcode = '42501';
  end if;
  update public.announcements
  set ended_at = now(), ended_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
  where id = p_id and ended_at is null;
  if not found and not exists (select 1 from public.announcements where id = p_id) then
    raise exception 'ANNOUNCEMENT_NOT_FOUND: that announcement does not exist' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.end_announcement(uuid) is
  'Admin only. Withdraws an announcement before its end date; it disappears for every recipient at once. Idempotent.';


-- ═══ 6. The one write an employee makes ══════════════════════════════════════
--
-- There is no user parameter: the row is always the caller's own. It is refused
-- for an announcement the caller cannot currently see, and is idempotent — a
-- second press keeps the first read_at.

create or replace function public.acknowledge_announcement(p_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'ANNOUNCEMENT_FORBIDDEN: sign in first' using errcode = '42501';
  end if;
  if not public.announcement_visible_to_caller(p_id) then
    raise exception 'ANNOUNCEMENT_NOT_VISIBLE: this announcement is not active for you'
      using errcode = '42501';
  end if;

  insert into public.announcement_reads (announcement_id, user_id)
  values (p_id, auth.uid())
  on conflict (announcement_id, user_id) do nothing;

  select read_at into v_at from public.announcement_reads
  where announcement_id = p_id and user_id = auth.uid();
  return v_at;
end;
$$;

comment on function public.acknowledge_announcement(uuid) is
  'Records that the signed-in caller has read an announcement active for them. Own row only; idempotent; returns the read time.';


-- ═══ 7. The caller's own active list ═════════════════════════════════════════
--
-- What the banner, the header panel and the Announcements page read: every
-- announcement live today for which the caller is a named recipient, newest
-- first, each with the caller's own read time (null = not yet acknowledged).

create or replace function public.my_announcements()
returns table (
  id               uuid,
  title            text,
  summary          text,
  body             text,
  starts_on        date,
  ends_on          date,
  attachment_path  text,
  attachment_name  text,
  attachment_size  integer,
  created_at       timestamptz,
  read_at          timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.title, a.summary, a.body, a.starts_on, a.ends_on,
         a.attachment_path, a.attachment_name, a.attachment_size, a.created_at,
         rd.read_at
  from public.announcements a
  join public.announcement_recipients r
    on r.announcement_id = a.id and r.user_id = auth.uid()
  join public.users u
    on u.id = r.user_id and u.is_active and coalesce(u.is_deleted, false) = false
  left join public.announcement_reads rd
    on rd.announcement_id = a.id and rd.user_id = auth.uid()
  where public.announcement_is_live(a.starts_on, a.ends_on, a.ended_at,
                                    public.announcement_india_date())
  order by a.starts_on desc, a.created_at desc;
$$;

comment on function public.my_announcements() is
  'The signed-in caller''s active announcements (named recipient, live today in India), newest first, with their own read_at.';

revoke execute on function public.create_announcement(uuid, text, text, text, date, date, uuid[], text, text, integer) from public, anon;
revoke execute on function public.update_announcement(uuid, text, text, text, date, date, uuid[], text, text, integer) from public, anon;
revoke execute on function public.end_announcement(uuid)          from public, anon;
revoke execute on function public.acknowledge_announcement(uuid)  from public, anon;
revoke execute on function public.my_announcements()              from public, anon;
grant  execute on function public.create_announcement(uuid, text, text, text, date, date, uuid[], text, text, integer) to authenticated;
grant  execute on function public.update_announcement(uuid, text, text, text, date, date, uuid[], text, text, integer) to authenticated;
grant  execute on function public.end_announcement(uuid)          to authenticated;
grant  execute on function public.acknowledge_announcement(uuid)  to authenticated;
grant  execute on function public.my_announcements()              to authenticated;


-- ═══ 8. The private PDF bucket ═══════════════════════════════════════════════
--
-- PRIVATE and PDF only. 10 MiB matches the app's other document buckets.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('announcement-files', 'announcement-files', false, 10485760, array['application/pdf'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;


-- ═══ 9. Storage policies ═════════════════════════════════════════════════════
--
--   SELECT  admin, or a recipient for whom the announcement is live AND whose
--           row names exactly this object. A replaced PDF or an ended
--           announcement cannot be opened by employees.
--   INSERT  admin only, and only under a {uuid}/{name}.pdf key.
--   DELETE  admin only, and only an object no announcement currently names —
--           the orphan left by a failed save or a replaced PDF.
--   UPDATE  none: an uploaded file's bytes are never swapped in place.

drop policy if exists "announcement_files_select" on storage.objects;
create policy "announcement_files_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'announcement-files'
    and (
      public.announcement_caller_is_admin()
      or exists (
        select 1 from public.announcements a
        where a.id = public.announcement_file_announcement_id(storage.objects.name)
          and a.attachment_path = storage.objects.name
          and public.announcement_visible_to_caller(a.id)
      )
    )
  );

drop policy if exists "announcement_files_insert" on storage.objects;
create policy "announcement_files_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'announcement-files'
    and public.announcement_caller_is_admin()
    and public.announcement_file_announcement_id(name) is not null
  );

drop policy if exists "announcement_files_delete" on storage.objects;
create policy "announcement_files_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'announcement-files'
    and public.announcement_caller_is_admin()
    and not exists (
      select 1 from public.announcements a
      where a.attachment_path = storage.objects.name
    )
  );


-- ═══ 10. Did all of that take? ═══════════════════════════════════════════════

do $$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('announcements', 'announcement_recipients', 'announcement_reads')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'announcements: RLS is not forced on %', v_bad;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('announcements', 'announcement_recipients', 'announcement_reads')
      and grantee in ('anon', 'authenticated')
      and privilege_type <> 'SELECT'
  ) or exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('announcements', 'announcement_recipients', 'announcement_reads')
      and grantee = 'anon'
  ) then
    raise exception 'announcements: a client role holds a write grant, or anon holds any grant';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'announcement-files' and public = false
      and file_size_limit = 10485760 and allowed_mime_types = array['application/pdf']
  ) then
    raise exception 'announcements: bucket announcement-files is not private / PDF-only / 10 MiB';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'announcement_files_%') <> 3 then
    raise exception 'announcements: expected exactly three announcement_files storage policies';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'announcement_files_%' and cmd = 'UPDATE'
  ) then
    raise exception 'announcements: an UPDATE policy exists on announcement-files';
  end if;
end;
$$;
