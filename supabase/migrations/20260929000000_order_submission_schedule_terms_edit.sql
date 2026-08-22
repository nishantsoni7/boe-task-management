-- ═══════════════════════════════════════════════════════════════════════════
-- EDITING A PI'S SCHEDULE AND TERMS
--
-- The second editable section, after client and party details (20260928000000).
-- Same shape deliberately: same authority pair, same row_version concurrency,
-- same allow-list discipline, same before/after trail. Two sections that behave
-- differently would be two sets of rules to keep in step.
--
-- ── THE FIVE FIELDS, AND WHY BILLING PERCENTAGE IS NOT ONE OF THEM ─────────
--
--   order_confirmation_date   date    -> mirrors to orders.confirm_date
--   due_date                  date    -> mirrors to orders.due_date
--   dispatch_commitment       text    prose, when no explicit date was given
--   payment_terms             text    the agreed COLLECTION arrangement
--   billing_terms             text    the agreed INVOICING arrangement
--
-- Billing percentage is edited by set_order_submission_billing_percentage
-- (20260927000000) and is NOT duplicated here. It carries rules this function
-- does not — a 35-100 range, a two-decimal precision refusal, its own Order
-- mirror and its own supersession — and a second implementation of those is a
-- second thing to keep in step. The editing UI shows it in this section and
-- routes it to its own RPC.
--
-- ── WHAT SUPERSEDES A DOCUMENT, AND WHAT DOES NOT ─────────────────────────
--
-- Read from the confirmed PDF's own field list rather than assumed. It prints
-- the confirm date and the due date; it does not print the dispatch commitment
-- or either terms string. So only the two DATES make a ready document stale.
-- Superseding for a terms correction would make people regenerate for nothing,
-- which is the same reasoning that kept phone numbers out of 20260928's
-- printed list.
--
-- ── WHAT IS DELIBERATELY NOT VALIDATED ─────────────────────────────────────
--
-- No rule that due_date must fall on or after order_confirmation_date. Such a
-- constraint does not exist in this schema today, and inventing one here would
-- refuse a correction that a workbook legitimately carried — which is the
-- opposite of what an editor is for. If that rule is wanted it belongs on the
-- table, applying to the parser and this function alike.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.update_order_submission_client_details(uuid, jsonb, integer, text)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260928000000 must be applied before this migration';
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
    update public.orders
       set confirm_date = case when v_changes ? 'order_confirmation_date'
             then (v_changes -> 'order_confirmation_date' ->> 'to')::date
             else confirm_date end,
           due_date = case when v_changes ? 'due_date'
             then (v_changes -> 'due_date' ->> 'to')::date
             else due_date end,
           updated_at = now()
     where id = v_sub.order_id;
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


do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'update_order_submission_schedule_terms';

  if v_def is null then
    raise exception 'update_order_submission_schedule_terms was not created';
  end if;
  if v_def !~ 'SET search_path TO ''?public''?, ''?pg_temp''?' then
    raise exception 'update_order_submission_schedule_terms has no fixed search_path';
  end if;

  -- It must not assign anything derived or system-owned, and it must not
  -- assign billing_percentage — which has its own function and its own rules.
  for v_def in
    select unnest(array[
      'total_before_gst', 'gst_amount', 'grand_total', 'subtotal_after_discount',
      'gross_product_amount', 'billing_percentage', 'status', 'order_id',
      'display_number', 'source_order_submission_id', 'claim_token'
    ])
  loop
    if (select pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'update_order_submission_schedule_terms')
       ~ ('\m' || v_def || '\M\s*=\s*case')
    then
      raise exception 'the schedule editor assigns %, which it must not', v_def;
    end if;
  end loop;

  raise notice '20260929000000 applied: PI schedule and terms are editable.';
end $$;
