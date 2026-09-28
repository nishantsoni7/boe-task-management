-- ═══════════════════════════════════════════════════════════════════════════
-- 20270211000000  PI SALES ORDER DETAILS — the salesperson and the lead source,
--                 entered by Sales on the PI draft instead of at approval
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- approve_order_submission() (20261201000000) needs four things to create an
-- Order: a salesperson id, a confirm date, a due date and a lead source. The
-- two dates already live on the PI (order_confirmation_date, due_date, confirmed
-- by Sales before submission since 20270123000000). The other two did not: a PI
-- stores NO salesperson id — only the NAME its workbook printed
-- (source_created_by), matched exactly against the user list in the approval
-- dialog, which leaves the selector empty whenever the names differ — and NO
-- lead source at all. So management typed both at approval, after Sales had
-- already known them for weeks.
--
-- WHAT THIS FILE DOES
-- -------------------
--   * order_submissions.salesperson_id  uuid → users(id), nullable.
--   * order_submissions.lead_source     text, nullable, one of the five values
--                                       orders.lead_source has always allowed.
--   * set_order_submission_sales_details() — the one writer. Owner or active
--     admin while the PI is a draft or returned (can_edit_order_submission),
--     row lock, row_version check. Full state: both values every call.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
--   * NEITHER IS REQUIRED TO SUBMIT. Both stay optional on the PI; the approval
--     RPC still requires them explicitly (p_assigned_to, p_lead_source) and is
--     NOT changed. The approval dialog now OFFERS the persisted values as the
--     answer, and management keeps the authority to change them.
--   * NO BACKFILL. A PI saved before this has null for both; the approval dialog
--     keeps its selection path for it and never guesses an identity.
--   * NOT order_submissions.assigned_to — that column is the PI's assigned
--     REVIEWER (read by RLS and by can_read_order_submission_commission), not its
--     salesperson.
--   * Never printed. Neither column is in any client document's column list.
--
-- PURELY ADDITIVE; the deployed app reads the two columns in a separate,
-- failure-tolerant query, so it keeps working whichever lands first.

do $$
begin
  if to_regprocedure('public.can_edit_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: can_edit_order_submission must exist before this migration';
  end if;
  if to_regprocedure('public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: 20260908000000 must be applied before this migration';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions' and column_name = 'row_version'
  ) then
    raise exception 'DEPENDENCY MISSING: 20260928000000 (row_version) must be applied before this migration';
  end if;
end $$;


-- ═══ 1. The columns ═════════════════════════════════════════════════════════

alter table public.order_submissions
  add column if not exists salesperson_id uuid references public.users(id) on delete set null,
  add column if not exists lead_source    text;

alter table public.order_submissions
  drop constraint if exists order_submissions_lead_source_known,
  add  constraint order_submissions_lead_source_known
    check (lead_source is null or lead_source in ('reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'));

comment on column public.order_submissions.salesperson_id is
  'INTERNAL. The BOE salesperson responsible for this PI, chosen by Sales on the draft. Offered to the approval dialog as the Order''s salesperson (orders.assigned_to); management may change it. NOT assigned_to, which is the PI''s reviewer. Written by set_order_submission_sales_details(). 20270211000000.';
comment on column public.order_submissions.lead_source is
  'INTERNAL. Where the order came from, one of orders.lead_source''s five values, entered by Sales on the draft and offered to the approval dialog. Written by set_order_submission_sales_details(). 20270211000000.';


-- ═══ 2. The writer ══════════════════════════════════════════════════════════

create or replace function public.set_order_submission_sales_details(
  p_submission_id    uuid,
  p_salesperson_id   uuid,
  p_lead_source      text,
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
  v_lead    text := nullif(btrim(coalesce(p_lead_source, '')), '');
  v_version integer;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if v_lead is not null and v_lead not in ('reference', 'repeat_customer', 'whatsapp', 'instagram', 'website') then
    raise exception 'ORDER_CONFIRMATION_LEAD_SOURCE_INVALID: that lead source is not one BOE records'
      using errcode = 'P0001';
  end if;

  if p_salesperson_id is not null and not exists (select 1 from public.users where id = p_salesperson_id) then
    raise exception 'ORDER_CONFIRMATION_SALESPERSON_UNKNOWN: that salesperson is not a BOE user'
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  if not public.can_edit_order_submission(p_submission_id) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: the salesperson and lead source can be changed here only while the PI is a draft or returned for changes'
      using errcode = '42501';
  end if;

  if p_expected_version is not null and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  if p_salesperson_id is not distinct from v_sub.salesperson_id and v_lead is not distinct from v_sub.lead_source then
    return jsonb_build_object('submission_id', p_submission_id, 'changed', false, 'row_version', v_sub.row_version);
  end if;

  update public.order_submissions set
    salesperson_id = p_salesperson_id,
    lead_source    = v_lead,
    row_version    = row_version + 1,
    updated_at     = now()
  where id = p_submission_id
  returning row_version into v_version;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'internal_details_updated', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'changed', '{}'::jsonb,
      'fields', (case when p_salesperson_id is distinct from v_sub.salesperson_id then 1 else 0 end)
              + (case when v_lead is distinct from v_sub.lead_source then 1 else 0 end),
      'commission_changed', false,
      'sales_details_changed', true,
      'confirmed', false, 'stage', v_sub.status)
  );

  return jsonb_build_object('submission_id', p_submission_id, 'changed', true, 'row_version', v_version);
end;
$$;

revoke all    on function public.set_order_submission_sales_details(uuid, uuid, text, integer) from public, anon;
grant  execute on function public.set_order_submission_sales_details(uuid, uuid, text, integer) to authenticated;

comment on function public.set_order_submission_sales_details(uuid, uuid, text, integer) is
  'Sets a PI''s salesperson (users.id) and lead source while it is a draft or returned, by its owner or an active admin — can_edit_order_submission. Full state; null clears. Validates the user exists and the lead source is one of the five. Bumps row_version; logs internal_details_updated with sales_details_changed. 20270211000000.';


-- ═══ 3. Proof ═══════════════════════════════════════════════════════════════

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'order_submissions'
        and column_name in ('salesperson_id', 'lead_source') and is_nullable = 'YES') <> 2 then
    raise exception 'PROOF FAILED: salesperson_id / lead_source missing or not nullable';
  end if;
  if has_function_privilege('anon', 'public.set_order_submission_sales_details(uuid, uuid, text, integer)', 'execute') then
    raise exception 'PROOF FAILED: anon may execute set_order_submission_sales_details';
  end if;
  if not has_function_privilege('authenticated', 'public.set_order_submission_sales_details(uuid, uuid, text, integer)', 'execute') then
    raise exception 'PROOF FAILED: authenticated may not execute set_order_submission_sales_details';
  end if;
end $$;
