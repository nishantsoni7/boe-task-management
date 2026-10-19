-- ═══════════════════════════════════════════════════════════════════════════
-- 20270320000000  SAMPLE TYPE — "sampling needed" or "sample order only",
--                 chosen on the PI draft and changeable on the Confirmed Order
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (owner, 2026-10-19)
-- -----------------------
-- The Confirmed Orders list shows a sample symbol beside the Project code.
-- Until now it was derived only from the advance-exception reason "Sample
-- order", which exists only when a PI went below the standard advance. Sales
-- needs to say it directly, with two meanings:
--   sampling_needed  a sample must be made before production
--   sample_order     the order IS a sample (nothing more is produced)
--
-- WHAT THIS FILE DOES
-- -------------------
--   * order_submissions.sample_type — nullable, one of the two values. Chosen
--     on the PI while it is a draft or returned, through
--     set_order_submission_sample_type(): exactly can_edit_order_submission's
--     answer (the owner, or an active admin), with optimistic concurrency on
--     row_version — the same door as set_order_submission_highlight_remark
--     (20270210000000). Activity reuses 'internal_details_updated'.
--   * orders.sample_type / sample_type_set_by / sample_type_set_at — the
--     Order's own choice, once somebody makes one on the Confirmed Order.
--     sample_type_set_at IS THE MARKER: NULL means "never chosen here, use the
--     PI's"; NOT NULL means the Order's value stands (and a NULL value then
--     means "explicitly not a sample"). No copy is made at approval, so
--     approve_order_submission is untouched and nothing can drift.
--   * set_order_sample_type() — the one writer on the Order: the salesperson
--     in orders.assigned_to, an active admin or an active manager, i.e.
--     can_record_order_approval(), the rule the Fabric & Finish update uses.
--     Never on a cancelled Order. Logs 'sample_type_changed' to
--     order_activity_log (from, to) so the trail says who changed it.
--
-- NOT TOUCHED: orders_guard_amendable_columns guards named columns only; these
-- three are not among them and are written only through the definer below.
-- No policy, grant or existing function is replaced. Purely additive; the app
-- that reads these columns ships only after this file is applied.

do $$
begin
  if to_regprocedure('public.can_edit_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: can_edit_order_submission must exist before this migration';
  end if;
  if to_regprocedure('public.can_record_order_approval(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20261227000000 (can_record_order_approval) must be applied before this migration';
  end if;
  if to_regprocedure('public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: 20260908000000 must be applied before this migration';
  end if;
end $$;


-- ═══ 1. The columns ═════════════════════════════════════════════════════════

alter table public.order_submissions
  add column if not exists sample_type text;

alter table public.order_submissions
  drop constraint if exists order_submissions_sample_type_check,
  add  constraint order_submissions_sample_type_check
    check (sample_type is null or sample_type in ('sampling_needed', 'sample_order'));

comment on column public.order_submissions.sample_type is
  'INTERNAL. sampling_needed (a sample is made before production) or sample_order (the order is a sample), or NULL. Chosen on the PI draft through set_order_submission_sample_type(). The Order uses it until orders.sample_type_set_at says the Order made its own choice. 20270320000000.';

alter table public.orders
  add column if not exists sample_type        text,
  add column if not exists sample_type_set_by uuid references public.users(id),
  add column if not exists sample_type_set_at timestamptz;

alter table public.orders
  drop constraint if exists orders_sample_type_check,
  add  constraint orders_sample_type_check
    check (sample_type is null or sample_type in ('sampling_needed', 'sample_order'));

comment on column public.orders.sample_type is
  'INTERNAL. The Order''s own sample choice (sampling_needed / sample_order / NULL = not a sample) — meaningful only when sample_type_set_at is not NULL; otherwise the source PI''s sample_type applies. Written only by set_order_sample_type(). 20270320000000.';
comment on column public.orders.sample_type_set_at is
  'When the Order''s own sample choice was last made. NULL: never chosen on the Order; the source PI''s sample_type applies. 20270320000000.';


-- ═══ 2. The PI writer ═══════════════════════════════════════════════════════

create or replace function public.set_order_submission_sample_type(
  p_submission_id    uuid,
  p_sample_type      text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_sub     public.order_submissions%rowtype;
  v_type    text := nullif(btrim(coalesce(p_sample_type, '')), '');
  v_version integer;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if v_type is not null and v_type not in ('sampling_needed', 'sample_order') then
    raise exception 'ORDER_SUBMISSION_SAMPLE_TYPE_INVALID: choose sampling needed, sample order, or none'
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- Owner (or an active admin) while the PI is a draft or returned, and never
  -- once it has an Order — the Order has its own writer below.
  if not public.can_edit_order_submission(p_submission_id) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: the sample choice can be changed here only while the PI is a draft or returned for changes'
      using errcode = '42501';
  end if;

  if p_expected_version is not null and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  if v_type is not distinct from v_sub.sample_type then
    return jsonb_build_object('submission_id', p_submission_id, 'changed', false,
      'row_version', v_sub.row_version);
  end if;

  update public.order_submissions set
    sample_type = v_type,
    row_version = row_version + 1,
    updated_at  = now()
  where id = p_submission_id
  returning row_version into v_version;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'internal_details_updated', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'changed', jsonb_build_object('sample_type', jsonb_build_object('from', v_sub.sample_type, 'to', v_type)),
      'fields', 1,
      'commission_changed', false,
      'sample_type_changed', true,
      'confirmed', false, 'stage', v_sub.status)
  );

  return jsonb_build_object('submission_id', p_submission_id, 'changed', true, 'row_version', v_version);
end;
$$;

revoke all    on function public.set_order_submission_sample_type(uuid, text, integer) from public, anon;
grant  execute on function public.set_order_submission_sample_type(uuid, text, integer) to authenticated;

comment on function public.set_order_submission_sample_type(uuid, text, integer) is
  'Sets (or clears, with blank) a PI''s sample choice while it is a draft or returned, by its owner or an active admin — can_edit_order_submission. Bumps row_version; logs internal_details_updated with sample_type_changed. 20270320000000.';


-- ═══ 3. The Order writer ════════════════════════════════════════════════════

create or replace function public.set_order_sample_type(
  p_order_id    uuid,
  p_sample_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_order    public.orders%rowtype;
  v_type     text := nullif(btrim(coalesce(p_sample_type, '')), '');
  v_pi_type  text;
  v_from     text;
begin
  if v_actor is null then
    raise exception 'ORDER_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if v_type is not null and v_type not in ('sampling_needed', 'sample_order') then
    raise exception 'ORDER_SAMPLE_TYPE_INVALID: choose sampling needed, sample order, or none'
      using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: order % not found', p_order_id
      using errcode = 'P0002';
  end if;

  -- The Fabric & Finish rule: the assigned salesperson (by id), an active
  -- admin or an active manager.
  if not public.can_record_order_approval(p_order_id) then
    raise exception
      'ORDER_SAMPLE_TYPE_NOT_ALLOWED: only the salesperson on this Order, an administrator or a manager can change its sample choice'
      using errcode = '42501';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'ORDER_CANCELLED: a cancelled Order cannot be changed'
      using errcode = 'P0001';
  end if;

  -- What the reader saw before this change: the Order's own choice once made,
  -- else the source PI's.
  if v_order.sample_type_set_at is not null then
    v_from := v_order.sample_type;
  else
    select s.sample_type into v_pi_type
      from public.order_submissions s where s.id = v_order.source_order_submission_id;
    v_from := v_pi_type;
  end if;

  if v_order.sample_type_set_at is not null and v_type is not distinct from v_order.sample_type then
    return jsonb_build_object('order_id', p_order_id, 'changed', false, 'sample_type', v_type);
  end if;

  update public.orders set
    sample_type        = v_type,
    sample_type_set_by = v_actor,
    sample_type_set_at = now()
  where id = p_order_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, v_actor, 'sample_type_changed',
          jsonb_build_object('from', v_from, 'to', v_type));

  return jsonb_build_object('order_id', p_order_id, 'changed', v_from is distinct from v_type, 'sample_type', v_type);
end;
$$;

revoke all    on function public.set_order_sample_type(uuid, text) from public, anon;
grant  execute on function public.set_order_sample_type(uuid, text) to authenticated;

comment on function public.set_order_sample_type(uuid, text) is
  'Sets the Confirmed Order''s own sample choice (sampling_needed / sample_order / blank = not a sample), by the assigned salesperson, an active admin or an active manager — can_record_order_approval. Never on a cancelled Order. Stamps sample_type_set_by/at and logs sample_type_changed (from, to). 20270320000000.';


-- ═══ 4. Proof ═══════════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions'
      and column_name = 'sample_type' and is_nullable = 'YES'
  ) then
    raise exception 'PROOF FAILED: order_submissions.sample_type is missing or not nullable';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'orders'
         and column_name in ('sample_type', 'sample_type_set_by', 'sample_type_set_at')) <> 3 then
    raise exception 'PROOF FAILED: the three orders.sample_type columns are not all present';
  end if;
  if has_function_privilege('anon', 'public.set_order_submission_sample_type(uuid, text, integer)', 'execute')
     or has_function_privilege('anon', 'public.set_order_sample_type(uuid, text)', 'execute') then
    raise exception 'PROOF FAILED: anon may execute a sample-type writer';
  end if;
  if not has_function_privilege('authenticated', 'public.set_order_submission_sample_type(uuid, text, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.set_order_sample_type(uuid, text)', 'execute') then
    raise exception 'PROOF FAILED: authenticated may not execute a sample-type writer';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.set_order_sample_type(uuid, text)'::regprocedure) is not true then
    raise exception 'PROOF FAILED: set_order_sample_type must be SECURITY DEFINER';
  end if;
end $$;
