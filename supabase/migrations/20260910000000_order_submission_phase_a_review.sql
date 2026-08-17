-- Order Management, Phase A: submission time, and the one review decision that
-- ends a submission.
--
-- WHAT THIS ADDS, AND NOTHING ELSE
-- --------------------------------
--   1. order_submissions.submitted_at — when the record last became 'submitted'.
--   2. ONE new transition: submitted → rejected.
--   3. reject_order_submission(uuid, text) — the RPC that performs it.
--   4. 'rejected' in the closed activity action set.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
-- -----------------------------------
-- No approval. 'approved' stays reachable from NOTHING, for every caller
-- including the service role and direct SQL, exactly as 20260908000000 left it —
-- and the assertions at the foot of this file fail the migration if that ever
-- stops being true. There is no approve RPC, no advance rule, no exception
-- handling, no order-number allocation, no public.orders row, no workbook or PDF
-- generation and no payment. Those belong to the phase that creates Orders.
--
-- Nothing in either applied migration is edited. This file is purely additive:
-- two functions are restated with `create or replace` (the transition trigger
-- and the frozen-column guard), one CHECK constraint is widened by exactly one
-- value, and one column and one function are new.
--
-- WHY submitted_at IS A COLUMN AND NOT A QUERY
-- --------------------------------------------
-- "When was this submitted?" is answerable today only by reading the activity
-- trail and taking the newest 'submitted' row. That is a join and a sort on
-- every list row and every detail page, for a fact the record itself should
-- carry, and it makes a reviewer's queue order depend on a child table. So the
-- value is stored — and stored by the DATABASE, in the transition path, never by
-- the caller:
--
--   * a browser cannot write it. The client roles hold no UPDATE privilege on
--     order_submissions at all (20260908000000 §5), so the only writers are the
--     SECURITY DEFINER functions and the service role;
--   * even those cannot falsify it. The guard below refuses ANY change to
--     submitted_at that is not the status actually moving into 'submitted' from
--     one of the two employee-owned states;
--   * a resubmission replaces the earlier time, because the column answers "when
--     did this last reach a reviewer", which is the question the queue and the
--     detail page both ask.

-- ═══ 1. Submission time ═════════════════════════════════════════════════════

alter table public.order_submissions
  add column submitted_at timestamptz;

comment on column public.order_submissions.submitted_at is
  'When this submission last entered the submitted state, written by the status transition trigger and by nothing else. A resubmission replaces the earlier value. Null while a record has never been submitted.';

-- Newest submission first, which is the order the review queue reads in.
create index order_submissions_submitted_at_idx
  on public.order_submissions (submitted_at desc);

-- ── Backfill, from history rather than from a guess ──
--
-- RUN BEFORE THE GUARD BELOW IS REPLACED, deliberately. The guard's whole job is
-- to refuse a write to submitted_at that is not a submission, and this write is
-- not a submission — it is the recovery of one that already happened. Doing it
-- while the OLD guard (which does not know about the column) is still installed
-- is what lets the new rule be absolute afterwards, with no exception carved
-- into it for migrations.
--
-- The source is the append-only trail, which no client role can write, so the
-- recovered value is as trustworthy as the event it records. A record with no
-- 'submitted' activity gets NOTHING: an invented timestamp on a commercial
-- record is worse than an honest blank, and the screens already render an absent
-- time as "—".
update public.order_submissions s
   set submitted_at = latest.at
  from (
    select a.submission_id, max(a.created_at) as at
    from public.order_submission_activity a
    where a.action = 'submitted'
    group by a.submission_id
  ) as latest
 where latest.submission_id = s.id
   and s.submitted_at is null;

-- ═══ 2. The transition graph, with one move added ═══════════════════════════
--
-- The graph after this migration:
--
--   draft         → submitted
--   needs_changes → submitted
--   submitted     → needs_changes
--   submitted     → rejected      ← NEW
--
-- 'approved' remains reachable from nothing. It is present in the column's CHECK
-- so the approval phase stays additive, and every attempt to reach it — from a
-- browser, from the service role, from psql — still raises.
--
-- Rejection is FINAL in this phase: there is no rejected → anything. A rejected
-- PI is corrected by uploading a new one, which is a new submission; reopening
-- somebody's rejected record and quietly resubmitting it would make the trail
-- lie about what management refused.
--
-- The trigger also stamps submitted_at, because this is the one place every
-- submission and every resubmission necessarily passes through. Setting it in
-- submit_order_submission() instead would leave the column writable by anything
-- else that could reach an UPDATE, and would have to be repeated by every future
-- path into 'submitted'.

create or replace function public.order_submissions_enforce_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception
        'ORDER_SUBMISSION_TRANSITION_INVALID: a submission must be created as draft, not %', new.status
        using errcode = '42501';
    end if;
    -- A submission is created as a draft, so it has no submission time. Stated
    -- rather than assumed, so an INSERT carrying one cannot pre-date itself.
    new.submitted_at := null;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'draft'         and new.status = 'submitted')
    or (old.status = 'needs_changes' and new.status = 'submitted')
    or (old.status = 'submitted'     and new.status = 'needs_changes')
    or (old.status = 'submitted'     and new.status = 'rejected')
  ) then
    raise exception
      'ORDER_SUBMISSION_TRANSITION_INVALID: % cannot move from % to %',
      old.id, old.status, new.status
      using errcode = '42501';
  end if;

  -- THE ONLY WRITER OF submitted_at. now() is the transaction's own clock, so
  -- the value cannot be supplied, shifted or back-dated by the caller.
  if new.status = 'submitted' then
    new.submitted_at := now();
  else
    -- Returning a record for changes or rejecting it does not change WHEN it was
    -- submitted, and must not silently erase it either.
    new.submitted_at := old.submitted_at;
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_enforce_status_transition()
  from public, anon, authenticated;

-- ═══ 3. submitted_at cannot be edited outside a submission ══════════════════
--
-- The existing guard already freezes the creation record. It now also freezes
-- the submission time against every path except the transition above — which
-- runs FIRST (triggers of the same timing fire in name order, and
-- ..._enforce_status_transition sorts before ..._guard_frozen_columns), so by
-- the time this sees the row the legitimate stamp is already on it and is
-- recognised by the status move that justifies it.
--
-- Everything else the guard did is unchanged.

create or replace function public.order_submissions_guard_frozen_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.created_by is distinct from old.created_by
     or new.submitted_by is distinct from old.submitted_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'ORDER_SUBMISSION_FIELD_FROZEN: the creation record of submission % cannot be changed', old.id
      using errcode = '42501';
  end if;

  -- submitted_at may change ONLY as part of the record actually becoming
  -- submitted. Any other write to it — a service-role UPDATE, a future RPC that
  -- "helpfully" sets a nicer time, a data fix — is refused.
  if new.submitted_at is distinct from old.submitted_at
     and not (new.status = 'submitted' and old.status in ('draft', 'needs_changes')) then
    raise exception
      'ORDER_SUBMISSION_FIELD_FROZEN: the submission time of % is set only by submitting it', old.id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_frozen_columns()
  from public, anon, authenticated;

-- ═══ 4. The activity action set, widened by exactly one value ═══════════════
--
-- The set is CLOSED on purpose: a phase that produces a new kind of event
-- extends it in its own migration, which is a visible change rather than a
-- silent new event type. 'rejected' is what this phase produces. Nothing about
-- approval, numbering, advances or payments is added.
--
-- The constraint is located by its definition rather than by an assumed name, so
-- this works whether the original was auto-named or not.

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t      on t.oid = c.conrelid
  join pg_namespace n  on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_submission_activity'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%changes_requested%';

  if v_name is null then
    raise exception 'the order_submission_activity action constraint was not found';
  end if;

  execute format('alter table public.order_submission_activity drop constraint %I', v_name);
end $$;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    'submission_created',
    'parse_replaced',
    'submitted',
    'changes_requested',
    'rejected'
  ));

-- ═══ 5. Reject a submission ═════════════════════════════════════════════════
--
-- The mirror of request_order_submission_changes, and written the same way for
-- the same reasons: an active actor, the authoritative permission helper, a
-- mandatory reason, a row lock taken before the state is judged, one atomic
-- write, one append-only activity row, and a small fixed JSON result.
--
-- WHY THE REASON IS MANDATORY. A rejection ends this record. "Rejected", with no
-- reason, tells the employee nothing they can act on and tells the next person
-- reading the trail nothing about why the business refused it.
--
-- WHY THE LOCK COMES BEFORE THE STATE CHECK. Two reviewers acting at the same
-- moment must not both succeed, and a request-changes racing a rejection must
-- resolve to exactly one outcome. The `for update` serializes them, so the
-- status this function judges is the status it writes against.
--
-- WHAT THIS FUNCTION CANNOT DO. It cannot approve, cannot set order_id, cannot
-- touch a number, and cannot reject anything that is not currently 'submitted'.
-- The last of those is enforced twice: here with a readable business error, and
-- by the transition trigger regardless of what any caller attempts.

create or replace function public.reject_order_submission(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_status text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.actor_has_module_permission('orders', 'approve_order') then
    raise exception 'You do not have permission to review order submissions'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: say why this is being rejected'
      using errcode = 'P0001';
  end if;

  select s.status into v_status
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted record can be rejected (this one is %)', v_status
      using errcode = 'P0001';
  end if;

  -- One statement: the status, the reviewer, the time and the reason land
  -- together or not at all, and the rejection consistency constraint from
  -- 20260908000000 refuses any half of it.
  update public.order_submissions
     set status      = 'rejected',
         rejected_by = v_actor,
         rejected_at = now(),
         review_note = v_reason
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'rejected', 'submitted', 'rejected', v_reason, '{}'::jsonb
  );

  -- The established shape: an id and a state. No commercial figure, no client
  -- name, no path — nothing a caller could not already read.
  return jsonb_build_object('id', p_submission_id, 'status', 'rejected');
end;
$$;

revoke execute on function public.reject_order_submission(uuid, text) from public, anon;
grant  execute on function public.reject_order_submission(uuid, text) to authenticated;

comment on function public.reject_order_submission(uuid, text) is
  'Rejects a submitted PI submission, for a caller holding orders.approve_order. The reason is mandatory and is recorded on the submission and in its append-only history. Final in this phase: a rejected record has no transition out.';

-- ═══ 6. Assertions ══════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_bad text;
  v_n   integer;
  v_def text;
begin
  -- ── The transition trigger still refuses approval, and now admits rejection ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'order_submissions_enforce_status_transition';

  if v_def is null then
    raise exception 'the status transition trigger function is missing';
  end if;
  if v_def like '%''approved''%' then
    raise exception 'the transition trigger names approved; this phase must not make it reachable';
  end if;
  if v_def not like '%new.status = ''rejected''%' then
    raise exception 'the transition trigger does not admit submitted → rejected';
  end if;

  -- The trigger is still attached, for INSERT as well as UPDATE.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'order_submissions'
      and t.tgname = 'order_submissions_enforce_status_transition'
      and not t.tgisinternal
  ) then
    raise exception 'the status transition trigger is not attached to order_submissions';
  end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'order_submissions'
      and t.tgname = 'order_submissions_guard_frozen_columns'
      and not t.tgisinternal
  ) then
    raise exception 'the frozen-column guard is not attached to order_submissions';
  end if;

  -- ── No submission has been approved or linked to an Order by this file ──
  if exists (select 1 from public.order_submissions where status = 'approved') then
    raise exception 'a submission is approved; this phase cannot approve anything';
  end if;
  if exists (select 1 from public.order_submissions where order_id is not null) then
    raise exception 'a submission is linked to an Order; this phase creates none';
  end if;

  -- ── There is no approval RPC ──
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_submission', 'allocate_order_submission_number')
  ) then
    raise exception 'an approval or numbering function exists; that belongs to a later phase';
  end if;

  -- ── The rejection RPC: pinned search path ──
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'reject_order_submission'
      and p.prosecdef
      and exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
        where cfg like 'search_path=%'
      )
  ) then
    raise exception 'reject_order_submission must be SECURITY DEFINER with a pinned search_path';
  end if;

  -- ── The rejection RPC: exactly the right execute grants ──
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name = 'reject_order_submission'
    and grantee in ('anon', 'PUBLIC');
  if v_n > 0 then
    raise exception 'reject_order_submission must not be executable by anon or PUBLIC';
  end if;

  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'reject_order_submission'
      and grantee = 'authenticated'
  ) then
    raise exception 'reject_order_submission must be executable by authenticated';
  end if;

  -- It must require the review permission, not merely ownership.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reject_order_submission';
  if v_def not like '%actor_has_module_permission(''orders'', ''approve_order'')%' then
    raise exception 'reject_order_submission does not require orders.approve_order';
  end if;
  if v_def not like '%for update%' then
    raise exception 'reject_order_submission does not lock the submission row before judging it';
  end if;

  -- ── The activity action set ──
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'order_submission_activity'
    and c.conname = 'order_submission_activity_action_check';
  if v_def is null then
    raise exception 'the activity action constraint is missing';
  end if;
  if v_def not like '%rejected%' then
    raise exception 'the activity action constraint does not admit rejected';
  end if;
  for v_bad in select unnest(array['approved', 'order_number_allocated', 'advance_recorded', 'payment_recorded'])
  loop
    if v_def like '%' || v_bad || '%' then
      raise exception 'the activity action constraint admits %, which belongs to a later phase', v_bad;
    end if;
  end loop;

  -- ── Nothing was re-opened for direct client writes ──
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

  -- ── History is still append-only: no UPDATE or DELETE policy, for anybody ──
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'order_submission_activity'
    and p.polcmd in ('a', 'w', 'd');
  if v_bad is not null then
    raise exception 'order_submission_activity has write policies: %', v_bad;
  end if;

  -- The only writer of history is still the internal logger, executable by no
  -- role at all.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'log_order_submission_activity'
      and (
        has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'log_order_submission_activity is executable by a role; history would be forgeable';
  end if;

  -- ── RLS and the module gates are untouched ──
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('order_submissions', 'order_submission_items',
                      'order_submission_activity', 'order_submission_item_images')
    and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'RLS is not enabled on: %', v_bad;
  end if;

  select count(*) into v_n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polname = c.relname || '_module_entry_gate'
    and c.relname in ('order_submissions', 'order_submission_items',
                      'order_submission_activity', 'order_submission_item_images')
    and not p.polpermissive;
  if v_n <> 4 then
    raise exception 'expected 4 restrictive module entry gates, found %', v_n;
  end if;

  -- ── The parse writer is still unreachable from a browser ──
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name = 'replace_order_submission_parse'
    and grantee in ('authenticated', 'anon', 'PUBLIC');
  if v_n > 0 then
    raise exception 'replace_order_submission_parse must not be executable by a client role';
  end if;

  -- ── submitted_at exists, is nullable, and is a timestamptz ──
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions'
      and column_name = 'submitted_at'
      and data_type = 'timestamp with time zone'
      and is_nullable = 'YES'
  ) then
    raise exception 'order_submissions.submitted_at is missing or has the wrong shape';
  end if;

  -- Nothing was invented: every stamped record has a submitted history entry.
  select count(*) into v_n
  from public.order_submissions s
  where s.submitted_at is not null
    and not exists (
      select 1 from public.order_submission_activity a
      where a.submission_id = s.id and a.action = 'submitted'
    );
  if v_n > 0 then
    raise exception '% submission(s) carry a submitted time with no submission in their history', v_n;
  end if;

  -- ── The permission this phase reviews under is still deny-by-default ──
  if not exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'orders'
      and pa.action_key = 'approve_order'
      and mpa.default_allowed = false
  ) then
    raise exception 'orders.approve_order is not registered as deny-by-default';
  end if;
end $$;
