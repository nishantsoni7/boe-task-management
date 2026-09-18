-- ═══════════════════════════════════════════════════════════════════════════
-- 20261217000000 — The PI schedule editor speaks to the Order through the
--                  amendment door
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. Once a PI is approved and its Confirmed Order exists, changing
-- the PI's Order Confirmation Date or Due Date on the PI page calls
-- update_order_submission_schedule_terms() (20260929000000), which carries the
-- new dates onto the Order:
--
--   update public.orders set confirm_date = …, due_date = … where id = …
--
-- confirm_date and due_date are columns orders_guard_amendable_columns()
-- freezes outside in_order_amendment(), and this UPDATE runs outside it. The
-- guard therefore refuses with ORDER_AMENDMENT_REQUIRED and the save fails.
--
-- 20261120000000 fixed exactly this for the two sibling paths
-- (replace_order_submission_parse, update_order_submission_client_details) and
-- did not list this third one. Found in the Orders & Finance go-live readiness
-- review (2026-09-18): the live function body (pg_proc, compared line by line
-- with 20260929000000, identical apart from CRLF line endings) sets no
-- amendment context, and the orders_guard_amendable_columns trigger is enabled.
--
-- WHY IT HAS NOT BITTEN YET. The Order UPDATE runs only when the PI already has
-- an order_id. Production holds no Confirmed Orders today, so the path has never
-- been reached. The first date correction after go-live would have failed.
--
-- THE FIX. The function opens the EXISTING transaction-local amendment context
-- immediately before its one UPDATE of public.orders and closes it immediately
-- after — the same door amend_order() has used since 20260816000000 and
-- 20261120000000 uses for the other two paths. Nothing else in the body
-- changes: every other statement is byte-for-byte the 20260929000000 body.
--
-- WHAT IS NOT DONE HERE. The guard is not weakened, no column leaves its frozen
-- list, no permission, grant, table, policy or trigger changes, and no row is
-- rewritten. The window is exactly one statement wide.
--
-- ADDITIVE. One function body re-emitted.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260929000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_order_amendment()') is null then
    raise exception 'DEPENDENCY MISSING: 20260816000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.orders_guard_amendable_columns()') is null then
    raise exception 'DEPENDENCY MISSING: the Order column guard must exist before this migration';
  end if;
end $$;

create or replace function public.update_order_submission_schedule_terms(
  p_submission_id    uuid,
  p_fields           jsonb,
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_sub        public.order_submissions%rowtype;
  v_is_admin   boolean;
  v_is_owner   boolean;
  v_after_sub  boolean;
  v_reason     text;
  v_key        text;
  v_new        text;
  v_old        text;
  v_changes    jsonb := '{}'::jsonb;
  v_changed    integer := 0;
  v_superseded integer := 0;
  v_version    integer;

  c_fields constant text[] := array[
    'order_confirmation_date', 'due_date',
    'dispatch_commitment', 'payment_terms', 'billing_terms'
  ];
  c_dates constant text[] := array['order_confirmation_date', 'due_date'];
  -- The two the confirmed documents actually print. See the header.
  c_printed constant text[] := array['order_confirmation_date', 'due_date'];
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);
  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;
  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception 'ORDER_SUBMISSION_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- ── Every key must be one this function owns ──
  for v_key in select jsonb_object_keys(p_fields) loop
    if not (v_key = any (c_fields)) then
      -- Named explicitly, because a caller aiming a billing percentage here has
      -- made an understandable mistake and deserves to be pointed at the right
      -- door rather than told "unknown field".
      if v_key = 'billing_percentage' then
        raise exception
          'ORDER_SUBMISSION_WRONG_EDITOR: billing_percentage is set through set_order_submission_billing_percentage'
          using errcode = 'P0001';
      end if;
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable schedule or terms field', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception 'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── Compute the change set ──
  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);

    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_key = any (c_dates) and v_new is not null then
      -- A DATE IS PARSED, NOT TRUSTED — and the SHAPE is checked before the
      -- cast, which is not belt and braces.
      --
      -- PostgreSQL's date input accepts a great deal more than a calendar
      -- date: 'yesterday', 'today', 'tomorrow', 'now', 'epoch', 'infinity' and
      -- '-infinity' all cast without error. A cast-only check therefore passed
      -- 'yesterday' straight through and silently stored a RELATIVE date — the
      -- assertions in this migration's test file caught exactly that. A PI's
      -- confirm date is a fact about an agreement, not an expression evaluated
      -- whenever it happens to be written.
      --
      -- So the ISO shape is required first, which is what the error message
      -- below has always claimed. Without this the message was a lie.
      if v_new !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception
          'ORDER_SUBMISSION_BAD_DATE: % must be a calendar date in YYYY-MM-DD form', v_key
          using errcode = 'P0001';
      end if;
      begin
        perform v_new::date;
      exception when others then
        -- Correct shape, impossible day — 2026-02-30, 2026-13-01.
        raise exception
          'ORDER_SUBMISSION_BAD_DATE: % must be a calendar date in YYYY-MM-DD form', v_key
          using errcode = 'P0001';
      end;
      -- Re-spelled through the type so a stored value and a submitted one are
      -- compared in one spelling and an identical date cannot read as a change.
      v_new := (v_new::date)::text;
    end if;

    if v_key <> all (c_dates) and v_new is not null and length(v_new) > 500 then
      -- Matches order_submissions_payment_terms_valid and its billing twin, so
      -- the caller is told what is wrong instead of meeting a constraint name.
      raise exception 'ORDER_SUBMISSION_FIELD_TOO_LONG: % may be at most 500 characters', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_sub;

    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
    end if;
  end loop;

  if v_changed = 0 then
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'changed',       false,
      'fields',        0,
      'row_version',   v_sub.row_version,
      'superseded_documents', 0
    );
  end if;

  update public.order_submissions set
    order_confirmation_date = case when p_fields ? 'order_confirmation_date'
      then nullif(btrim(coalesce(p_fields ->> 'order_confirmation_date', '')), '')::date
      else order_confirmation_date end,
    due_date = case when p_fields ? 'due_date'
      then nullif(btrim(coalesce(p_fields ->> 'due_date', '')), '')::date
      else due_date end,
    dispatch_commitment = case when p_fields ? 'dispatch_commitment'
      then nullif(btrim(coalesce(p_fields ->> 'dispatch_commitment', '')), '')
      else dispatch_commitment end,
    payment_terms = case when p_fields ? 'payment_terms'
      then nullif(btrim(coalesce(p_fields ->> 'payment_terms', '')), '')
      else payment_terms end,
    billing_terms = case when p_fields ? 'billing_terms'
      then nullif(btrim(coalesce(p_fields ->> 'billing_terms', '')), '')
      else billing_terms end,
    row_version = row_version + 1,
    updated_at  = now()
  where id = p_submission_id
  returning row_version into v_version;

  -- ── The linked Order carries the same two dates ──
  --
  -- orders.confirm_date and orders.due_date are written at approval from these
  -- columns. Leaving them behind would make the Order state a schedule its own
  -- PI no longer says. NOTHING ELSE on the Order is touched.
  if v_sub.order_id is not null
     and (v_changes ? 'order_confirmation_date' or v_changes ? 'due_date') then
    -- 20261217000000: the dates are guarded Order columns; write them through
    -- the amendment door, exactly one statement wide.
    perform set_config('boe.amendment_context', 'order_amendment', true);

    update public.orders
       set confirm_date = case when v_changes ? 'order_confirmation_date'
             then (v_changes -> 'order_confirmation_date' ->> 'to')::date
             else confirm_date end,
           due_date = case when v_changes ? 'due_date'
             then (v_changes -> 'due_date' ->> 'to')::date
             else due_date end,
           updated_at = now()
     where id = v_sub.order_id;

    perform set_config('boe.amendment_context', '', true);
  end if;

  if v_sub.order_id is not null
     and exists (select 1 from unnest(c_printed) k where v_changes ? k) then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');
  end if;

  if v_sub.order_id is not null then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_schedule_terms_amended',
      jsonb_build_object(
        'fields', v_changed, 'changed', v_changes,
        'by_admin', v_is_admin and not v_is_owner, 'reason', v_reason)
    );
  end if;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor,
    case when v_after_sub and not v_is_owner
         then 'schedule_terms_amended_by_admin'
         else 'schedule_terms_updated' end,
    v_sub.status, v_sub.status, v_reason,
    jsonb_build_object(
      'fields', v_changed, 'changed', v_changes,
      'stage', v_sub.status, 'after_submission', v_after_sub,
      'superseded_documents', v_superseded)
  );

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'changed',              true,
    'fields',               v_changed,
    'row_version',          v_version,
    'superseded_documents', v_superseded
  );
end;
$$;

comment on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) is
  'Edits a PI''s confirm date, due date, dispatch commitment, payment terms and billing terms — those five and nothing else. Billing percentage has its own RPC and is refused here by name. Owner in draft/needs_changes; active admin at any stage with a reason after submission. row_version concurrency. The two DATES mirror onto the linked Order and supersede its ready documents; the three text fields are not printed and do not.';

revoke all    on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) to authenticated;


-- ─── Assertions ─────────────────────────────────────────────────────────────

do $$
declare
  v_c     text := pg_get_functiondef('public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)'::regprocedure);
  v_guard text := pg_get_functiondef('public.orders_guard_amendable_columns()'::regprocedure);
  v_n     integer;
  v_cfg   text[];
begin
  -- The function opens and closes the context exactly once.
  if (select count(*) from regexp_matches(v_c, 'set_config\(''boe\.amendment_context''', 'g')) <> 2 then
    raise exception 'ASSERTION FAILED: update_order_submission_schedule_terms must open and close the amendment context exactly once';
  end if;

  -- The context must BRACKET the Order UPDATE, not merely appear.
  if position('set_config(''boe.amendment_context'', ''order_amendment'', true)' in v_c)
     > position('update public.orders' in v_c) then
    raise exception 'ASSERTION FAILED: the context is opened after the statement it must cover';
  end if;
  if position('set_config(''boe.amendment_context'', '''', true)' in v_c)
     < position('update public.orders' in v_c) then
    raise exception 'ASSERTION FAILED: the context is closed before the statement it must cover';
  end if;

  -- It still writes public.orders exactly once.
  if (select count(*) from regexp_matches(v_c, 'update public\.orders', 'g')) <> 1 then
    raise exception 'ASSERTION FAILED: update_order_submission_schedule_terms writes public.orders more than once';
  end if;

  -- THE GUARD IS UNTOUCHED.
  select count(*) into v_n from regexp_matches(v_guard, 'new\.[a-z_]+\s+is distinct from', 'g');
  if v_n < 12 then
    raise exception 'ASSERTION FAILED: the Order column guard refuses only % column(s)', v_n;
  end if;
  if v_guard not like '%ORDER_AMENDMENT_REQUIRED%'
     or v_guard not like '%in_order_amendment()%' then
    raise exception 'ASSERTION FAILED: the Order column guard lost a rule it had';
  end if;

  -- Authorization and actor derivation are unchanged.
  if v_c not like '%can_admin_edit_order_submission%'
     or v_c not like '%can_edit_order_submission%'
     or v_c not like '%auth.uid()%' then
    raise exception 'ASSERTION FAILED: update_order_submission_schedule_terms lost an authorization check';
  end if;

  -- Still SECURITY DEFINER with a pinned search_path, callable by authenticated
  -- and not by anon.
  if not (select prosecdef from pg_proc
           where oid = 'public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)'::regprocedure) then
    raise exception 'ASSERTION FAILED: update_order_submission_schedule_terms must stay SECURITY DEFINER';
  end if;
  select coalesce(proconfig, '{}') into v_cfg from pg_proc
   where oid = 'public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)'::regprocedure;
  if not ('search_path=public, pg_temp' = any (v_cfg)) then
    raise exception 'ASSERTION FAILED: update_order_submission_schedule_terms must pin search_path';
  end if;
  if not has_function_privilege('authenticated', 'public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot call update_order_submission_schedule_terms';
  end if;
  if has_function_privilege('anon', 'public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can call update_order_submission_schedule_terms';
  end if;

  raise notice '20261217000000: update_order_submission_schedule_terms opens the amendment context around its one Order UPDATE; guard and grants unchanged';
end $$;
