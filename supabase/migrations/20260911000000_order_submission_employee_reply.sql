-- Order Management, Phase A follow-up: the employee's reply when they resubmit.
--
-- THE GAP THIS CLOSES
-- -------------------
-- Management can return a PI with a note saying what must change. The employee
-- corrects the workbook and submits again — and until now had no way to say what
-- they changed, or to answer a question the reviewer asked. The reviewer then
-- opens the resubmission and has to diff two spreadsheets to find out.
--
-- So submission gains an OPTIONAL note, carried into the append-only history on
-- the 'submitted' event, where the reviewer already reads everything else that
-- happened to the record.
--
-- WHAT THIS IS NOT
-- ----------------
-- Not a chat, not comments, not a message thread. One optional line attached to
-- one event, in the trail that already exists. And nothing here approves,
-- numbers, converts, generates a document or touches a payment: the status graph
-- is untouched, and 'approved' remains reachable from nothing.
--
-- WHY THERE IS AN INTERNAL FUNCTION AND TWO DOORS
-- ----------------------------------------------
-- submit_order_submission() performs about a hundred lines of validation before
-- it moves a status: the actor, the permission, the row lock, ownership and
-- state, blocking issues, the client name, the workbook's path/existence/type,
-- the item count, per-line completeness, exactly one representative image per
-- line, every image path, and every image object. Adding a note argument by
-- copying all of that into a second function would mean two copies of the
-- security-critical part, drifting apart at the first correction to either.
--
-- Instead the whole body moves ONCE into submit_order_submission_internal(uuid,
-- text), which no client role may execute, and the two public entry points
-- become one line each:
--
--   submit_order_submission(uuid)                 → internal(id, null)
--   submit_order_submission_with_note(uuid, text) → internal(id, note)
--
-- The existing one-argument RPC therefore keeps its exact name, signature,
-- argument name, return shape, privileges and behaviour — an old client, a
-- cached PostgREST schema and any existing caller are all unaffected — while
-- there is still only one implementation of the rules.
--
-- SEPARATE NAMES, NOT AN OVERLOAD. PostgREST resolves a function by the argument
-- names in the request body, so two functions sharing a name would be picked
-- apart only by which keys a caller happened to send; a client omitting the note
-- key would silently select a different function. A distinct name makes the
-- choice explicit at the call site and impossible to get wrong by accident.

-- ═══ 1. The note ════════════════════════════════════════════════════════════
--
-- 1000 characters, after trimming. Long enough for "changed the fabric on line
-- 3 and corrected the GST" and for a real answer to a reviewer's question; short
-- enough that the trail stays readable and nobody pastes a document into it.
--
-- Whitespace-only is not a note: it is trimmed to NULL by
-- log_order_submission_activity, so an employee who tabs through the field
-- leaves no empty entry behind.

-- ═══ 2. The one implementation ══════════════════════════════════════════════
--
-- Byte-for-byte the body of the applied submit_order_submission (20260909000000
-- §7), with exactly two additions: the note parameter is validated at the top,
-- and it is passed to the activity logger at the bottom. Every check, every
-- error message, every errcode and the status write itself are unchanged.
--
-- NOT CALLABLE BY ANY ROLE. EXECUTE is revoked from PUBLIC, anon, authenticated
-- and service_role; only the two SECURITY DEFINER wrappers below reach it, as
-- their definer. That is what stops the note limit or the validation being
-- bypassed by calling the inner function directly.

create or replace function public.submit_order_submission_internal(
  p_submission_id uuid,
  p_note          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_item_count integer;
  v_incomplete integer;
  v_bad        integer;
  v_bad_row    integer;
  -- Trimmed here so that "   " is indistinguishable from an omitted note, both
  -- for the length check below and for what reaches the trail.
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to submit an order submission'
      using errcode = '42501';
  end if;

  -- Checked BEFORE the row is locked and before any work is done: an
  -- over-long note is the caller's mistake, and refusing it early costs the
  -- database nothing and holds no lock.
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception
      'ORDER_SUBMISSION_NOTE_TOO_LONG: a reply may be at most 1000 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- draft and needs_changes only, owned by this actor, and still editable. The
  -- same helper the applied RPC used; the transition trigger refuses every other
  -- origin regardless of what any caller attempts.
  if not public.can_edit_order_submission(p_submission_id) then
    raise exception 'This order submission cannot be submitted by you in its current state'
      using errcode = '42501';
  end if;

  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) must be fixed in the workbook before this can be submitted',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  -- ── The workbook: shape, then existence, then type ──
  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: no file exists in order-files at the recorded workbook path'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX: the stored workbook is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_incomplete
      using errcode = 'P0001';
  end if;

  -- ── Exactly one representative image per product line ──
  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── Every recorded image: the key must name THIS submission, THIS item, its
  --    own role and its own position ──
  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  -- ── Every recorded image: a real object, of a real image type ──
  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- THE STATUS WRITE IS UNCHANGED, review_note included.
  --
  -- review_note is MANAGEMENT'S field — what they asked for when they returned
  -- the record — and clearing it on resubmission is the behaviour the applied
  -- migration established: the request has been answered, so it stops being the
  -- record's outstanding instruction. The employee's reply is NEVER written
  -- here. It belongs to the event, not to the record, and the trail keeps both
  -- the original request and the answer as separate entries that no client role
  -- can edit or erase.
  update public.order_submissions
     set status = 'submitted',
         review_note = null
   where id = p_submission_id;

  -- submitted_at is stamped by the status transition trigger (20260910000000)
  -- and by nothing here, so a resubmission's time is recorded the same way a
  -- first submission's is.

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
  );

  return jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count);
end;
$$;

revoke execute on function public.submit_order_submission_internal(uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_order_submission_internal(uuid, text) is
  'The single implementation of submitting a PI for review, with an optional employee reply. Executable by no role: reached only by submit_order_submission() and submit_order_submission_with_note(), as their definer.';

-- ═══ 3. The unchanged door ══════════════════════════════════════════════════
--
-- Same name, same argument name, same return shape, same privileges, same
-- behaviour — a submission with no note. Replaced rather than left alone so
-- that there is one implementation of the rules rather than two.

create or replace function public.submit_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_order_submission_internal(p_submission_id, null);
end;
$$;

revoke execute on function public.submit_order_submission(uuid) from public, anon;
grant  execute on function public.submit_order_submission(uuid) to authenticated;

-- ═══ 4. The new door ════════════════════════════════════════════════════════
--
-- Identical authority to the one above — it is the same function underneath —
-- differing only in carrying the employee's optional reply.

create or replace function public.submit_order_submission_with_note(
  p_submission_id uuid,
  p_note          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_order_submission_internal(p_submission_id, p_note);
end;
$$;

revoke execute on function public.submit_order_submission_with_note(uuid, text) from public, anon;
grant  execute on function public.submit_order_submission_with_note(uuid, text) to authenticated;

comment on function public.submit_order_submission_with_note(uuid, text) is
  'Submits a PI for review with an optional employee reply, recorded on the submitted event in the append-only trail. Same actor, ownership, state, permission and completeness checks as submit_order_submission(uuid); the reply is trimmed, capped at 1000 characters, and never written to the management review note.';

-- ═══ 5. Assertions ══════════════════════════════════════════════════════════

do $$
declare
  v_def text;
  v_n   integer;
  v_bad text;
begin
  -- ── The internal function is reachable by nobody ──
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_order_submission_internal'
      and (
        has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'submit_order_submission_internal is executable by a role; the note limit and the checks could be bypassed';
  end if;

  -- ── Both doors: SECURITY DEFINER, pinned search_path ──
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('submit_order_submission', 'submit_order_submission_with_note',
                      'submit_order_submission_internal')
    and (
      not p.prosecdef
      or not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
        where cfg like 'search_path=%'
      )
    );
  if v_bad is not null then
    raise exception 'These functions are not SECURITY DEFINER with a pinned search_path: %', v_bad;
  end if;

  -- ── Grants: authenticated only, never anon or PUBLIC ──
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('submit_order_submission', 'submit_order_submission_with_note')
    and grantee in ('anon', 'PUBLIC');
  if v_n > 0 then
    raise exception 'a submission RPC is executable by anon or PUBLIC';
  end if;

  select count(distinct routine_name) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('submit_order_submission', 'submit_order_submission_with_note')
    and grantee = 'authenticated';
  if v_n <> 2 then
    raise exception 'both submission RPCs must be executable by authenticated (found %)', v_n;
  end if;

  -- ── Every door has EXACTLY the signature the application calls ──
  --
  -- READ FROM STABLE CATALOG COLUMNS, NEVER FROM RENDERED TEXT.
  --
  -- An earlier version of this block compared
  -- pg_get_function_identity_arguments(p.oid) to 'uuid' and it failed on a real
  -- database, because that function returns the NAMED form:
  --
  --   pg_get_function_identity_arguments  →  p_submission_id uuid
  --   pg_get_function_arguments           →  p_submission_id uuid
  --
  -- Those are display helpers. What they render is a presentation decision that
  -- may differ between server versions, and an assertion that depends on it is
  -- asserting the formatting rather than the signature. The columns below are
  -- the signature itself:
  --
  --   pronargs      the number of INPUT arguments
  --   proargtypes   an oidvector of their types — INDEXED FROM 0
  --   proargnames   a text[] of their names    — INDEXED FROM 1
  --
  -- The two index bases genuinely differ, which is exactly the sort of thing a
  -- rushed correction gets wrong in the other direction. Verified against
  -- PostgreSQL 16: proargtypes[0] is the first type, proargnames[1] is the first
  -- name, and proargnames[0] is null.
  --
  -- array_length is asserted as well as pronargs, so an added OUT parameter —
  -- which lands in proargnames without changing pronargs — is caught rather than
  -- silently accepted. proargnames is NULL for a function whose arguments are
  -- unnamed, and NULL fails every comparison here, so that case fails closed too.
  --
  -- WHY THE ARGUMENT NAMES MATTER AT ALL: PostgREST calls a function by the
  -- argument names in the request body. A renamed argument is a broken RPC even
  -- though the types still match, so the names are part of the contract and are
  -- checked as strictly as the types.

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission'
      and p.prokind  = 'f'
      and p.pronargs = 1
      and p.proargtypes[0] = 'uuid'::regtype
      and array_length(p.proargnames, 1) = 1
      and p.proargnames[1] = 'p_submission_id'
  ) then
    raise exception 'submit_order_submission(p_submission_id uuid) is missing or its signature changed';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission_with_note'
      and p.prokind  = 'f'
      and p.pronargs = 2
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargtypes[1] = 'text'::regtype
      and array_length(p.proargnames, 1) = 2
      and p.proargnames[1] = 'p_submission_id'
      and p.proargnames[2] = 'p_note'
  ) then
    raise exception 'submit_order_submission_with_note(p_submission_id uuid, p_note text) is missing or its signature changed';
  end if;

  -- The implementation both doors delegate to, checked the same way: a wrapper
  -- calling a differently-shaped internal function would fail at runtime rather
  -- than here.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission_internal'
      and p.prokind  = 'f'
      and p.pronargs = 2
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargtypes[1] = 'text'::regtype
      and array_length(p.proargnames, 1) = 2
      and p.proargnames[1] = 'p_submission_id'
      and p.proargnames[2] = 'p_note'
  ) then
    raise exception 'submit_order_submission_internal(uuid, text) is missing or its signature changed';
  end if;

  -- ── No accidental overload: one function per name ──
  --
  -- Counted per name, because PostgREST resolves an overloaded name by which
  -- argument keys a caller happened to send — so a second variant of either
  -- name would silently change which function a client reaches.
  for v_bad in
    select unnest(array['submit_order_submission',
                        'submit_order_submission_with_note',
                        'submit_order_submission_internal'])
  loop
    select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_bad;
    if v_n <> 1 then
      raise exception '% is overloaded (% variants); PostgREST would resolve it by argument names', v_bad, v_n;
    end if;
  end loop;

  -- ── The implementation keeps the rules it inherited ──
  --
  -- prosrc, not pg_get_functiondef: the body is STORED verbatim, while
  -- pg_get_functiondef re-renders a CREATE statement around it. Every check
  -- below is about what the body DOES, so reading the stored body asks the
  -- question directly and depends on no rendering at all.
  select p.prosrc into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'submit_order_submission_internal';

  if v_def is null then
    raise exception 'submit_order_submission_internal has no stored body to check';
  end if;

  for v_bad in select unnest(array[
    'assert_order_submission_actor',
    'actor_has_module_permission',
    'can_edit_order_submission',
    'for update',
    'ORDER_SUBMISSION_BLOCKED',
    'log_order_submission_activity'
  ]) loop
    if v_def not like '%' || v_bad || '%' then
      raise exception 'the submission implementation no longer performs: %', v_bad;
    end if;
  end loop;

  -- The reply is capped and trimmed…
  if v_def not like '%ORDER_SUBMISSION_NOTE_TOO_LONG%'
     or v_def not like '%char_length(v_note) > 1000%'
     or v_def not like '%nullif(btrim(coalesce(p_note%' then
    raise exception 'the employee reply is not trimmed and capped';
  end if;

  -- …and never written to management's field.
  if v_def like '%review_note = v_note%' or v_def like '%review_note = p_note%' then
    raise exception 'the employee reply must never overwrite the management review note';
  end if;

  -- ── Nothing approves, numbers or creates an Order ──
  for v_bad in select unnest(array['approved', 'order_number', 'display_number', 'advance', 'payment']) loop
    if v_def like '%' || v_bad || '%' then
      raise exception 'the submission implementation references %, which belongs to a later phase', v_bad;
    end if;
  end loop;

  if exists (select 1 from public.order_submissions where status = 'approved') then
    raise exception 'a submission is approved; this migration cannot approve anything';
  end if;
  if exists (select 1 from public.order_submissions where order_id is not null) then
    raise exception 'a submission is linked to an Order; this migration creates none';
  end if;

  -- ── The activity action set is untouched, and still admits submitted ──
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'order_submission_activity'
    and c.conname = 'order_submission_activity_action_check';
  if v_def is null or v_def not like '%submitted%' then
    raise exception 'the activity action constraint no longer admits submitted';
  end if;

  -- ── No client role gained a table write ──
  select string_agg(format('%s:%s', table_name, privilege_type), ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('order_submissions', 'order_submission_items',
                       'order_submission_activity', 'order_submission_item_images')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception 'client roles hold write privileges: %', v_bad;
  end if;

  -- ── The triggers this phase depends on are all still armed ──
  select string_agg(format('%s(%s)', t.tgname, t.tgenabled), ', ') into v_bad
  from pg_trigger t
  join pg_class c     on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'order_submissions'
    and not t.tgisinternal
    and t.tgenabled <> 'O';
  if v_bad is not null then
    raise exception 'These triggers on order_submissions are not enabled: %', v_bad;
  end if;
end $$;
