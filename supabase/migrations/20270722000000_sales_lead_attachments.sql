-- Sales, Lead Board: files on an update (owner, 2026-11-15: "an option to add single or multiple attachments such as jpg, pdf,
-- png or other standard files ... drag and drop, copy and paste of files").
--
-- WHAT THIS ADDS (everything is new; no existing row, table or policy changes)
--   1. A PRIVATE storage bucket, sales-lead-files: 10 MB per file, a short list of safe types (PDF, JPG, PNG, WebP, HEIC,
--      Word, Excel, CSV, PowerPoint, plain text). No zip, no executables, no application/octet-stream.
--   2. sales_lead_attachments: one row per file on an update (activity). Closed table: RLS on, read-only for signed-in people
--      through the lead's own visibility rule, written only by add_sales_lead_comment below. Immutable (no update, no delete).
--   3. Storage policies on storage.objects for the bucket, all keyed to the LEAD in the first folder of the object's path
--      ("<lead id>/<random>-<file name>"): read = whoever can see the lead; upload = whoever can work the lead (the holder, an
--      Admin, or somebody who may allot); delete = only the uploader, and only while the file is not on an update yet.
--   4. add_sales_lead_comment gets a fifth argument, p_files jsonb default '[]': the files already uploaded for this update.
--      The old four-argument function is dropped in the same transaction (two overloads would make PostgREST's named-argument
--      call ambiguous). A caller that sends four arguments, such as the build that is live while this is applied, still works.
--   5. get_sales_lead returns each update's files ('files': id, name, type, size, path) beside its other fields.
--
-- HOW A FILE TRAVELS
--   The browser uploads the object first (the policy above decides), then calls add_sales_lead_comment with the paths. The
--   function checks every path (this lead's folder, the object exists, the caller uploaded it, no duplicates, at most 10) and
--   writes the update and its file rows in ONE transaction, taking the size and type from the stored object, not from the
--   client. A failed call leaves no update and no file rows.
--
-- ORPHANS (accepted, as for task attachments): an upload that is never posted stays in the bucket, invisible in the app. The
--   uploader can delete it while it is not on an update; nothing prunes the rest.
--
-- LEFT OUT ON PURPOSE: removing a file after the update is posted (updates are not editable either); a per-person quota.
--
-- DEPLOY ORDER: apply this BEFORE the code that sends files. The live code sends four arguments and reads no 'files', both
--   of which keep working. It is purely additive, so no backup is needed first (the owner's rule: only a change that alters
--   existing tables or data needs one); the nightly backup mirrors every bucket, this one included.
--
-- ROLLBACK (in this order): drop function public.add_sales_lead_comment(uuid, text, text, date, jsonb); recreate the
--   four-argument function from 20270703000100 (section 5 of that file) and grant it to authenticated; recreate
--   get_sales_lead from 20270526000100 (without 'files'); drop the three storage policies and the four helper functions;
--   drop table public.sales_lead_attachments; delete the bucket's objects through the Storage API, then the bucket.

-- ═══ 1. The bucket ══════════════════════════════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sales-lead-files', 'sales-lead-files', false, 10485760,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv', 'text/plain'
  ]
)
on conflict (id) do update set
  public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ═══ 2. The files of an update ══════════════════════════════════════════════════════════════════════════════════════════

create table public.sales_lead_attachments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads (id),
  activity_id uuid not null references public.sales_lead_activities (id),
  storage_path text not null unique check (storage_path like lead_id::text || '/%'),
  file_name text not null check (length(file_name) between 1 and 200),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid not null,
  created_at timestamptz not null default now()
);
create index sales_lead_attachments_activity_idx on public.sales_lead_attachments (activity_id);
create index sales_lead_attachments_lead_idx on public.sales_lead_attachments (lead_id);

alter table public.sales_lead_attachments enable row level security;
revoke all on table public.sales_lead_attachments from public, anon, authenticated;
grant select on table public.sales_lead_attachments to authenticated;
grant all on table public.sales_lead_attachments to service_role;

-- The same rule as the updates themselves: a file is visible where its lead is.
create policy sales_lead_attachments_read on public.sales_lead_attachments for select to authenticated
  using (exists (select 1 from public.sales_leads l where l.id = lead_id));

-- ═══ 3. Who may touch the objects ═══════════════════════════════════════════════════════════════════════════════════════
-- The helpers take the first folder of the path as TEXT and compare it with the lead's id as text, so a path that is not a
-- uuid (any other bucket's objects) never raises a cast error inside a policy.

create function public.sales_lead_files_can_read(p_lead text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and public.module_entry_open('sales')
     and exists (
       select 1 from public.sales_leads l
       where l.id::text = p_lead and public.sales_lead_visible(l.assigned_to, l.created_by)
     );
$$;

-- The rule of sales_lead_for_work (the holder, an Admin, or somebody who may allot), for an open lead somebody holds.
create function public.sales_lead_files_can_write(p_lead text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and public.module_entry_open('sales')
     and exists (
       select 1 from public.sales_leads l
       where l.id::text = p_lead
         and l.assigned_to is not null
         and l.stage not in ('converted', 'dead')
         and public.sales_lead_visible(l.assigned_to, l.created_by)
         and (
           l.assigned_to = auth.uid()
           or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
           or public.resolve_permission(auth.uid(), 'sales', 'assign')
         )
     );
$$;

-- Read through the definer so a person who can no longer see the lead cannot use the policy's own row filter to delete a file
-- that is on an update.
create function public.sales_lead_file_is_attached(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.sales_lead_attachments a where a.storage_path = p_path);
$$;

create policy "sales_lead_files_select" on storage.objects for select to authenticated
  using (bucket_id = 'sales-lead-files' and public.sales_lead_files_can_read(split_part(storage.objects.name, '/', 1)));

create policy "sales_lead_files_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'sales-lead-files' and public.sales_lead_files_can_write(split_part(storage.objects.name, '/', 1)));

-- No update policy: an object is never overwritten. Delete: the uploader's own file, while it is not on an update.
create policy "sales_lead_files_delete_pending" on storage.objects for delete to authenticated
  using (
    bucket_id = 'sales-lead-files'
    and storage.objects.owner_id = auth.uid()::text
    and not public.sales_lead_file_is_attached(storage.objects.name)
  );

revoke all on function public.sales_lead_files_can_read(text) from public, anon;
revoke all on function public.sales_lead_files_can_write(text) from public, anon;
revoke all on function public.sales_lead_file_is_attached(text) from public, anon;
grant execute on function public.sales_lead_files_can_read(text) to authenticated;
grant execute on function public.sales_lead_files_can_write(text) to authenticated;
grant execute on function public.sales_lead_file_is_attached(text) to authenticated;

-- ═══ 4. An update with files ════════════════════════════════════════════════════════════════════════════════════════════
-- The body of 20270703000100's add_sales_lead_comment, with the files checked before the update is written and stored with it.
-- p_files is an array of {"path": "<lead id>/<object name>", "name": "<file name shown>"}.

create function public.add_sales_lead_comment(
  p_id uuid, p_note text, p_tag text default null, p_next_due date default null, p_files jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_note text := nullif(btrim(p_note), '');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_due date;
  v_not_responding boolean := coalesce(p_tag = 'not_responding', false);
  v_files jsonb := coalesce(p_files, '[]'::jsonb);
  v_activity uuid;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: Reopen this lead before adding an update.'; end if;
  if v_note is null then raise exception 'SALES_INVALID: Write what happened.'; end if;
  if length(v_note) > 4000 then raise exception 'SALES_INVALID: Keep the update under 4,000 characters.'; end if;
  if p_tag is not null and p_tag not in ('not_responding', 'quotation') then raise exception 'SALES_INVALID: Unknown quick note.'; end if;
  v_due := coalesce(p_next_due, public.sales_next_working_day(v_today));
  if v_due < v_today then raise exception 'SALES_INVALID: The follow-up cannot be in the past.'; end if;

  if jsonb_typeof(v_files) <> 'array' then raise exception 'SALES_INVALID: Check the files and try again.'; end if;
  if jsonb_array_length(v_files) > 10 then raise exception 'SALES_INVALID: Attach up to 10 files to one update.'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_files) f
    where jsonb_typeof(f) <> 'object'
       or coalesce(f->>'path', '') not like p_id::text || '/%'
       or length(coalesce(f->>'name', '')) not between 1 and 200
  ) then raise exception 'SALES_INVALID: Check the files and try again.'; end if;
  if (select count(distinct f->>'path') from jsonb_array_elements(v_files) f) <> jsonb_array_length(v_files) then
    raise exception 'SALES_INVALID: The same file is attached twice.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_files) f
    where not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'sales-lead-files' and o.name = f->>'path' and o.owner_id = auth.uid()::text
    )
  ) then raise exception 'SALES_INVALID: A file has not finished uploading. Try again.'; end if;

  v_activity := public.sales_lead_record(
    v_row,
    case when p_tag = 'quotation' then 'quotation' else 'note' end,
    case when v_not_responding then 'no_answer' when p_tag = 'quotation' then 'sent' else 'note' end,
    v_note,
    case when p_tag = 'quotation' then 'Follow up on the quotation' else 'Follow up' end,
    v_due,
    not v_not_responding,
    case when v_not_responding then v_row.no_answer_streak + 1 else 0 end
  );

  -- The size and the type come from the stored object, never from the browser.
  insert into public.sales_lead_attachments (lead_id, activity_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  select p_id, v_activity, o.name, f->>'name',
         coalesce(nullif(o.metadata->>'mimetype', ''), 'application/octet-stream'), (o.metadata->>'size')::bigint, auth.uid()
  from jsonb_array_elements(v_files) f
  join storage.objects o on o.bucket_id = 'sales-lead-files' and o.name = f->>'path';

  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'streak', v_row.no_answer_streak, 'lead', public.sales_lead_row(v_row));
exception
  when check_violation or not_null_violation or unique_violation then raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

drop function public.add_sales_lead_comment(uuid, text, text, date);

revoke all on function public.add_sales_lead_comment(uuid, text, text, date, jsonb) from public, anon;
grant execute on function public.add_sales_lead_comment(uuid, text, text, date, jsonb) to authenticated;

-- ═══ 5. The lead with its files ═════════════════════════════════════════════════════════════════════════════════════════
-- get_sales_lead as in 20270526000100, with one more field on each update.

create or replace function public.get_sales_lead(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_row public.sales_leads;
begin
  select * into v_row from public.sales_leads where id = p_id;
  if v_row.id is null or not public.sales_lead_visible(v_row.assigned_to, v_row.created_by) then
    raise exception 'SALES_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'lead', public.sales_lead_row(v_row),
    'can_work', v_row.assigned_to is not null and (
      v_row.assigned_to = v_uid
      or exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin')
      or public.resolve_permission(v_uid, 'sales', 'assign')
    ),
    'quotation_sent', exists (
      select 1 from public.sales_lead_activities a where a.lead_id = p_id and a.kind = 'quotation' and a.undone_at is null
    ),
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'from_name', f.full_name, 'to_name', t.full_name,
        'detail', e.detail, 'actor_name', a.full_name, 'at', e.at
      ) order by e.at desc, e.id), '[]'::jsonb)
      from public.sales_lead_events e
      left join public.users f on f.id = e.from_user
      left join public.users t on t.id = e.to_user
      left join public.users a on a.id = e.actor
      where e.lead_id = p_id
    ),
    'activities', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'kind', x.kind, 'outcome', x.outcome, 'note', x.note, 'next_step', x.next_step,
        'next_due_on', x.next_due_on, 'actor_name', a.full_name, 'at', x.at,
        'files', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', f.id, 'name', f.file_name, 'type', f.mime_type, 'size', f.size_bytes, 'path', f.storage_path
          ) order by f.created_at, f.id)
          from public.sales_lead_attachments f where f.activity_id = x.id
        ), '[]'::jsonb)
      ) order by x.at desc, x.id), '[]'::jsonb)
      from public.sales_lead_activities x
      left join public.users a on a.id = x.actor
      where x.lead_id = p_id and x.undone_at is null
    ),
    'clickup', (
      select coalesce(jsonb_agg(i.raw order by i.imported_at), '[]'::jsonb)
      from public.sales_lead_imports i where i.lead_id = p_id
    )
  );
end;
$$;

-- ═══ 6. Self-checks (they run when the migration is applied) ════════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'sales-lead-files' and public = false and file_size_limit = 10485760 and array_length(allowed_mime_types, 1) = 14
  ) then raise exception 'SALES_FILES: the bucket must be private, 10 MB, with fourteen types'; end if;
  if exists (select 1 from storage.buckets where id = 'sales-lead-files' and 'application/octet-stream' = any (allowed_mime_types))
     or exists (select 1 from storage.buckets where id = 'sales-lead-files' and 'application/zip' = any (allowed_mime_types)) then
    raise exception 'SALES_FILES: no octet-stream and no zip';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.sales_lead_attachments'::regclass) then
    raise exception 'SALES_FILES: row level security must be on';
  end if;
  if has_table_privilege('authenticated', 'public.sales_lead_attachments', 'insert')
     or has_table_privilege('authenticated', 'public.sales_lead_attachments', 'update')
     or has_table_privilege('authenticated', 'public.sales_lead_attachments', 'delete')
     or has_table_privilege('anon', 'public.sales_lead_attachments', 'select')
     or not has_table_privilege('authenticated', 'public.sales_lead_attachments', 'select') then
    raise exception 'SALES_FILES: the table is read-only for signed-in people and closed to anon';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname in ('sales_lead_files_select', 'sales_lead_files_insert', 'sales_lead_files_delete_pending')) <> 3 then
    raise exception 'SALES_FILES: the three storage policies';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
               and policyname like 'sales_lead_files_%' and cmd = 'UPDATE') then
    raise exception 'SALES_FILES: an object is never overwritten';
  end if;
  if to_regprocedure('public.add_sales_lead_comment(uuid, text, text, date)') is not null
     or to_regprocedure('public.add_sales_lead_comment(uuid, text, text, date, jsonb)') is null then
    raise exception 'SALES_FILES: exactly one add_sales_lead_comment, with files';
  end if;
  if has_function_privilege('anon', 'public.add_sales_lead_comment(uuid, text, text, date, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.sales_lead_files_can_read(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.sales_lead_files_can_write(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.sales_lead_file_is_attached(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.add_sales_lead_comment(uuid, text, text, date, jsonb)', 'EXECUTE') then
    raise exception 'SALES_FILES: signed-in people only';
  end if;
end $$;
