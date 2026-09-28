-- ═══════════════════════════════════════════════════════════════════════════
-- 20270210000000  PI ORDER HIGHLIGHT REMARK — one optional internal note Sales
--                 writes on a PI draft, shown on the Confirmed Order it becomes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- Sales has things Operations must read first on an Order ("client visits the
-- factory on the 12th", "rush — exhibition stock") and nowhere to write them
-- before the PI goes for approval. The PI's only note column,
-- commercial_terms_note, is PRINTED on the client PI and PDF, so it cannot
-- carry an internal remark. orders.notes exists only once the Order does.
--
-- WHAT THIS FILE DOES
-- -------------------
--   * order_submissions.order_highlight_remark — nullable text, 1..1000 chars.
--     On the PI row, so it survives approval unchanged: the Confirmed Order
--     keeps pointing at this row (orders.source_order_submission_id) and reads
--     it from there. No copy, so nothing can drift.
--   * set_order_submission_highlight_remark() — the one writer the app uses.
--     Owner (or an active admin) while the PI is a draft or returned, and never
--     once it is an Order: exactly can_edit_order_submission's answer, the same
--     door the internal details editor uses. Optimistic concurrency on
--     row_version. The activity entry reuses 'internal_details_updated' (no
--     change to the action constraint) and records only THAT the remark
--     changed.
--
-- WHO READS IT. Everyone who can read the PI row: its reviewers, and on the
-- Confirmed Order every viewer of that Order (order_submissions_confirmed_
-- order_select). That is the intended audience — BOE staff working the Order.
--
-- WHAT A CLIENT DOCUMENT PRINTS. Nothing from this column. The generated PDFs
-- (src/lib/orders/confirmedPdf.ts), the confirmed Excel and the PI preview read
-- named columns, and this one is in none of their lists; a test pins that.
--
-- PURELY ADDITIVE. No backfill, no existing function or policy is replaced.
-- The deployed app reads the column in a separate, failure-tolerant query, so
-- it keeps working whether this file is applied before or after it ships.

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


-- ═══ 1. The column ══════════════════════════════════════════════════════════

alter table public.order_submissions
  add column if not exists order_highlight_remark text;

alter table public.order_submissions
  drop constraint if exists order_submissions_highlight_remark_len,
  add  constraint order_submissions_highlight_remark_len
    check (order_highlight_remark is null or char_length(order_highlight_remark) between 1 and 1000);

comment on column public.order_submissions.order_highlight_remark is
  'INTERNAL — never on a client document. An optional remark Sales writes on the PI draft for whoever works the Order; shown prominently on the Confirmed Order as an internal highlight. Written by set_order_submission_highlight_remark() while the PI is a draft or returned. 20270210000000.';


-- ═══ 2. The writer ══════════════════════════════════════════════════════════

create or replace function public.set_order_submission_highlight_remark(
  p_submission_id    uuid,
  p_remark           text,
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
  v_remark  text := nullif(btrim(coalesce(p_remark, '')), '');
  v_version integer;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if v_remark is not null and char_length(v_remark) > 1000 then
    raise exception 'ORDER_SUBMISSION_REMARK_TOO_LONG: the highlight remark can be at most 1000 characters'
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- Owner (or an active admin) while the PI is a draft or returned, and never
  -- once it has an Order.
  if not public.can_edit_order_submission(p_submission_id) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: the highlight remark can be changed only while the PI is a draft or returned for changes'
      using errcode = '42501';
  end if;

  if p_expected_version is not null and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  if v_remark is not distinct from v_sub.order_highlight_remark then
    return jsonb_build_object('submission_id', p_submission_id, 'changed', false,
      'row_version', v_sub.row_version);
  end if;

  update public.order_submissions set
    order_highlight_remark = v_remark,
    row_version            = row_version + 1,
    updated_at             = now()
  where id = p_submission_id
  returning row_version into v_version;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'internal_details_updated', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'changed', '{}'::jsonb,
      'fields', 1,
      'commission_changed', false,
      'highlight_remark_changed', true,
      'confirmed', false, 'stage', v_sub.status)
  );

  return jsonb_build_object('submission_id', p_submission_id, 'changed', true, 'row_version', v_version);
end;
$$;

revoke all    on function public.set_order_submission_highlight_remark(uuid, text, integer) from public, anon;
grant  execute on function public.set_order_submission_highlight_remark(uuid, text, integer) to authenticated;

comment on function public.set_order_submission_highlight_remark(uuid, text, integer) is
  'Sets (or clears, with blank) a PI''s internal order highlight remark while it is a draft or returned, by its owner or an active admin — can_edit_order_submission. Trimmed; 1000 characters at most. Bumps row_version; logs internal_details_updated with highlight_remark_changed, never the text. 20270210000000.';


-- ═══ 3. Proof ═══════════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions'
      and column_name = 'order_highlight_remark' and is_nullable = 'YES'
  ) then
    raise exception 'PROOF FAILED: order_submissions.order_highlight_remark is missing or not nullable';
  end if;
  if has_function_privilege('anon', 'public.set_order_submission_highlight_remark(uuid, text, integer)', 'execute') then
    raise exception 'PROOF FAILED: anon may execute set_order_submission_highlight_remark';
  end if;
  if not has_function_privilege('authenticated', 'public.set_order_submission_highlight_remark(uuid, text, integer)', 'execute') then
    raise exception 'PROOF FAILED: authenticated may not execute set_order_submission_highlight_remark';
  end if;
end $$;
