-- ═══════════════════════════════════════════════════════════════════════════
-- THE OWNER'S CORRECTION REQUEST
--
-- An owner may edit their PI while it is a draft. Once it goes to management it
-- stops being theirs to change — that rule is right and is not being relaxed.
-- But "you cannot change this" is only half an answer: the person who wrote the
-- PI is usually the one who notices the error in it, and until now they had
-- nowhere to say so.
--
-- So: a request. It changes NO PI DATA. It records what the owner believes is
-- wrong, in which section, and why; it reaches the people who can act on it;
-- and an admin resolves it — normally while making the correction, so the trail
-- links the ask to the edit that answered it.
--
-- ── THIS IS NOT A WORKFLOW ENGINE ──────────────────────────────────────────
--
-- No generic state machine, no configurable transitions, no rules table. Three
-- states, two verbs, one subject. A request is open, or it was resolved, or it
-- was rejected; an owner raises one and an admin closes it. Anything more
-- general would be a framework nobody asked for, carrying states this module
-- has no use for.
--
-- Rejected and resolved requests are NEVER deleted. What somebody asked for and
-- what was decided is the history; a tidy table that forgets refused requests
-- is a table that cannot answer "did anyone raise this before".
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260929000000 must be applied before this migration';
  end if;
end $$;


-- ── 1. The record ────────────────────────────────────────────────────────────

create table if not exists public.order_submission_correction_requests (
  id uuid primary key default gen_random_uuid(),

  submission_id uuid not null references public.order_submissions(id),

  -- WHICH PART, from a fixed set that matches the editor's own sections, so a
  -- request can open the right section rather than being prose an admin has to
  -- interpret. 'other' exists because a real reader will find something these
  -- four do not cover, and forcing them into the wrong one loses information.
  section text not null
    check (section in ('client', 'schedule', 'products', 'commercial', 'other')),

  -- WHAT THEY WANT CHANGED, and WHY. Both mandatory and both bounded. The
  -- reason is not ceremony: this record has been reviewed and may carry money,
  -- and "please change the address" without a why is not something an admin can
  -- act on confidently.
  requested_change text not null
    check (btrim(requested_change) <> '' and char_length(requested_change) <= 1000),
  reason text not null
    check (btrim(reason) <> '' and char_length(reason) <= 1000),

  status text not null default 'open'
    check (status in ('open', 'resolved', 'rejected')),

  requested_by uuid not null references public.users(id),
  requested_at timestamptz not null default now(),

  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  resolution_note text
    check (resolution_note is null or char_length(resolution_note) <= 1000),

  -- THE EDIT THAT ANSWERED IT. An activity row on the PI, so "resolved" can be
  -- read together with what actually changed rather than being an admin's word
  -- for it. Nullable: a request can be resolved because it was already correct,
  -- and it can be rejected, and neither has an edit behind it.
  resolved_edit_activity_id uuid references public.order_submission_activity(id),

  -- A closed request must say who closed it and when; an open one must not
  -- pretend to. One constraint rather than three, so the states cannot drift.
  constraint order_submission_correction_requests_closure check (
    (status = 'open'
      and resolved_by is null and resolved_at is null
      and resolved_edit_activity_id is null)
    or (status <> 'open'
      and resolved_by is not null and resolved_at is not null)
  )
);

comment on table public.order_submission_correction_requests is
  'What a PI''s owner asked to have corrected after it left their hands, and what was decided. Changes no PI data. Never deleted: a refused request is history, not clutter.';

create index if not exists order_submission_correction_requests_submission_idx
  on public.order_submission_correction_requests (submission_id, requested_at desc);
create index if not exists order_submission_correction_requests_open_idx
  on public.order_submission_correction_requests (status, requested_at)
  where status = 'open';


-- ── 2. Who may see and write ─────────────────────────────────────────────────

alter table public.order_submission_correction_requests enable row level security;
revoke all on table public.order_submission_correction_requests from public, anon, authenticated;

-- READ ONLY from a client. Every write goes through the two RPCs below, which
-- is what keeps the state machine in one place.
grant select on table public.order_submission_correction_requests to authenticated;

-- A request is visible to anyone who can already see the PI it belongs to. That
-- is deliberately the EXISTING visibility rule rather than a new one: a
-- correction request contains nothing the PI does not, so inventing a second
-- audience for it would be inventing a second thing to keep in step.
create policy "order_submission_correction_requests_select"
  on public.order_submission_correction_requests
  for select to authenticated
  using (public.can_view_order_submission(submission_id));

comment on policy "order_submission_correction_requests_select"
  on public.order_submission_correction_requests is
  'Visible to whoever may see the PI. No separate audience: the request says nothing the PI does not.';


-- ── 3. Raising one ───────────────────────────────────────────────────────────

create or replace function public.request_order_submission_correction(
  p_submission_id    uuid,
  p_section          text,
  p_requested_change text,
  p_reason           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_sub    public.order_submissions%rowtype;
  v_change text;
  v_reason text;
  v_id     uuid;
  v_open   integer;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- WHO. The OWNER, and only the owner. This is the owner's channel for a
  -- record that has left their hands; an admin does not need it, because an
  -- admin can simply make the correction.
  if v_sub.created_by is distinct from v_actor
     and v_sub.submitted_by is distinct from v_actor then
    raise exception
      'ORDER_SUBMISSION_NOT_OWNER: only this PI''s owner can request a correction'
      using errcode = '42501';
  end if;

  -- WHEN. Only once it has left the owner's hands. While it is a draft or has
  -- been returned for changes they can simply edit it, and offering a request
  -- form there would be offering the slower of two doors.
  if v_sub.status in ('draft', 'needs_changes') and v_sub.order_id is null then
    raise exception
      'ORDER_SUBMISSION_STILL_EDITABLE: you can edit this PI directly; no request is needed'
      using errcode = 'P0001';
  end if;

  if p_section is null or p_section not in ('client', 'schedule', 'products', 'commercial', 'other') then
    raise exception 'ORDER_SUBMISSION_BAD_SECTION: % is not a section of this PI', coalesce(p_section, 'null')
      using errcode = 'P0001';
  end if;

  v_change := nullif(btrim(coalesce(p_requested_change, '')), '');
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if v_change is null then
    raise exception 'ORDER_SUBMISSION_NO_CHANGE_REQUESTED: say what should be corrected'
      using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'ORDER_SUBMISSION_NO_REASON: a reason is required'
      using errcode = 'P0001';
  end if;
  if char_length(v_change) > 1000 or char_length(v_reason) > 1000 then
    raise exception 'ORDER_SUBMISSION_TEXT_TOO_LONG: each field may be at most 1000 characters'
      using errcode = 'P0001';
  end if;

  -- ONE OPEN REQUEST PER SECTION. Not a limit for its own sake: five identical
  -- open requests against the same section are five copies of one ask, and an
  -- admin resolving one would leave four that look unanswered.
  select count(*) into v_open
  from public.order_submission_correction_requests
  where submission_id = p_submission_id and section = p_section and status = 'open';

  if v_open > 0 then
    raise exception
      'ORDER_SUBMISSION_REQUEST_ALREADY_OPEN: there is already an open request for that section'
      using errcode = 'P0001';
  end if;

  insert into public.order_submission_correction_requests
    (submission_id, section, requested_change, reason, requested_by)
  values (p_submission_id, p_section, v_change, v_reason, v_actor)
  returning id into v_id;

  -- NOT ONE PI COLUMN IS TOUCHED. The request is a record ABOUT the PI, and a
  -- test asserts this function writes to no other table.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'correction_requested',
    v_sub.status, v_sub.status, v_reason,
    jsonb_build_object('request_id', v_id, 'section', p_section,
                       'requested_change', v_change)
  );

  return jsonb_build_object(
    'request_id', v_id, 'section', p_section, 'status', 'open');
end;
$$;

comment on function public.request_order_submission_correction(uuid, text, text, text) is
  'The PI owner asks for a correction to a record that has left their hands. Changes NO PI data. Owner only, and only once the PI has been submitted — while it is still editable the owner is told to edit it instead. One open request per section.';

revoke all    on function public.request_order_submission_correction(uuid, text, text, text) from public, anon;
grant  execute on function public.request_order_submission_correction(uuid, text, text, text) to authenticated;


-- ── 4. Closing one ───────────────────────────────────────────────────────────

create or replace function public.resolve_order_submission_correction(
  p_request_id  uuid,
  p_outcome     text,
  p_note        text default null,
  p_edit_activity_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_req   public.order_submission_correction_requests%rowtype;
  v_note  text;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  select * into v_req
  from public.order_submission_correction_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_REQUEST_NOT_FOUND: request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  -- An ACTIVE ADMIN closes a request, and nobody else. Deciding what happens to
  -- a reviewed record is the same authority as amending one, so it uses the
  -- same predicate rather than a second rule that could drift from it.
  if not public.can_admin_edit_order_submission(v_req.submission_id) then
    raise exception
      'ORDER_SUBMISSION_NOT_ADMIN: only an active admin can close a correction request'
      using errcode = '42501';
  end if;

  -- ALREADY CLOSED STAYS CLOSED. Re-closing would overwrite who decided and
  -- when, which is the part of the record worth keeping.
  if v_req.status <> 'open' then
    raise exception
      'ORDER_SUBMISSION_REQUEST_CLOSED: this request was already %', v_req.status
      using errcode = 'P0001';
  end if;

  if p_outcome not in ('resolved', 'rejected') then
    raise exception 'ORDER_SUBMISSION_BAD_OUTCOME: outcome must be resolved or rejected'
      using errcode = 'P0001';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- A REJECTION MUST SAY WHY. Refusing somebody's request without a word is the
  -- one outcome that needs an explanation; resolving it is explained by the
  -- edit itself.
  if p_outcome = 'rejected' and v_note is null then
    raise exception 'ORDER_SUBMISSION_NO_REJECTION_NOTE: say why the request is refused'
      using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ORDER_SUBMISSION_TEXT_TOO_LONG: the note may be at most 1000 characters'
      using errcode = 'P0001';
  end if;

  -- The linked edit must belong to THIS PI. A request cannot be closed by
  -- pointing at an unrelated record's activity.
  if p_edit_activity_id is not null then
    if not exists (
      select 1 from public.order_submission_activity a
      where a.id = p_edit_activity_id and a.submission_id = v_req.submission_id
    ) then
      raise exception
        'ORDER_SUBMISSION_BAD_EDIT_LINK: that activity entry does not belong to this PI'
        using errcode = 'P0001';
    end if;
  end if;

  update public.order_submission_correction_requests
     set status = p_outcome,
         resolved_by = v_actor,
         resolved_at = now(),
         resolution_note = v_note,
         resolved_edit_activity_id = p_edit_activity_id
   where id = p_request_id;

  perform public.log_order_submission_activity(
    v_req.submission_id, v_actor,
    case when p_outcome = 'resolved' then 'correction_resolved' else 'correction_rejected' end,
    null, null, v_note,
    jsonb_build_object('request_id', p_request_id, 'section', v_req.section,
                       'linked_edit', p_edit_activity_id)
  );

  return jsonb_build_object(
    'request_id', p_request_id, 'status', p_outcome,
    'submission_id', v_req.submission_id);
end;
$$;

comment on function public.resolve_order_submission_correction(uuid, text, text, uuid) is
  'An active admin closes a correction request as resolved or rejected. A rejection must say why. May link the PI activity entry for the edit that answered it. A closed request stays closed — re-closing would overwrite who decided and when.';

revoke all    on function public.resolve_order_submission_correction(uuid, text, text, uuid) from public, anon;
grant  execute on function public.resolve_order_submission_correction(uuid, text, text, uuid) to authenticated;


-- ── 5. What this migration promises ──────────────────────────────────────────
do $$
declare v_def text;
begin
  for v_def in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('request_order_submission_correction',
                        'resolve_order_submission_correction')
  loop
    if (select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = v_def)
       !~ 'SET search_path TO ''?public''?, ''?pg_temp''?' then
      raise exception '% has no fixed search_path', v_def;
    end if;
  end loop;

  -- RAISING A REQUEST MUST NOT TOUCH THE PI. The whole promise of this feature.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'request_order_submission_correction';
  if v_def ~* '\mupdate\s+public\.order_submissions\M'
     or v_def ~* '\mupdate\s+public\.orders\M'
     or v_def ~* '\mdelete\s+from\M' then
    raise exception 'request_order_submission_correction writes PI or Order data; it must not';
  end if;

  -- NOTHING DELETES A REQUEST. History is the point.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_order_submission_correction';
  if v_def ~* '\mdelete\s+from\M' then
    raise exception 'resolve_order_submission_correction deletes; a refused request is history';
  end if;

  -- No client role may write the table directly.
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'order_submission_correction_requests'
      and grantee in ('anon', 'authenticated', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    raise exception 'the correction request table is directly writable by a client role';
  end if;

  raise notice '20260930000000 applied: PI correction requests.';
end $$;
