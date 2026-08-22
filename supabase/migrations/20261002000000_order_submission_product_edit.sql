-- ═══════════════════════════════════════════════════════════════════════════
-- EDITING A PI'S PRODUCT LINES — the descriptive fields, and their order
--
-- ── WHAT THIS DOES, AND THE LARGER THING IT DOES NOT ──────────────────────
--
-- Editable here: item_sequence, source_product_code, product_name, dimensions,
-- material, customization, and the order the lines appear in.
--
-- NOT editable here, and not anywhere yet: quantity, cost_per_piece,
-- total_amount, adding a line, removing a line. Every one of those moves money,
-- and this system cannot currently recompute what the money becomes. That is a
-- real blocker rather than a scoping preference, and the evidence is below so
-- nobody has to rediscover it.
--
-- ── WHY THE MONEY HALF IS BLOCKED ─────────────────────────────────────────
--
-- BOE does not compute a PI's totals. It TRANSCRIBES them. The parser
-- (src/lib/pi/masterSheetParser.ts) reads:
--
--     subtotal_after_discount   from cell I116
--     total_before_gst          from cell I120
--     gst_amount                from cell I121
--     grand_total               from cell I122
--
-- It derives exactly two figures, and only in order to CHECK the workbook:
-- gross_product_amount as the sum of the lines, and expectedSubtotal as gross
-- minus discount. When its arithmetic disagrees with the workbook's cell it
-- raises a warning and keeps the workbook's figure. The spreadsheet computes;
-- BOE records and flags.
--
-- So changing a quantity or a rate moves gross_product_amount and
-- subtotal_after_discount — both of which this system CAN recompute — and also
-- requires total_before_gst, gst_amount and grand_total to move, none of which
-- it can.
--
-- The obvious guess, total_before_gst = subtotal + fabric + packing +
-- transport, is WRONG and provably so:
--
--   * fabric_cost and packing_cost carry a MEANING. The parser's `wordedZero`
--     policy records "Inclusive"/"Included" as zero-because-already-charged —
--     the amount is already inside another figure. Adding it would double-count
--     precisely those rows.
--   * transportation is as often the words "as applicable" as it is a number;
--     the schema has transportation_text beside transportation_amount and a
--     constraint that only one may be set.
--
-- Leaving the three stale instead is worse, not better: the PI's own totals
-- would then contradict its own lines, and billing value (from
-- total_before_gst) and the verified-payment percentage (from grand_total)
-- would both silently be computed against a number that no longer describes the
-- order.
--
-- Either way the result is wrong money. So this migration does the part that
-- cannot be wrong, and the money half waits for a decision this repository
-- cannot supply on its own: either the template contract must expose the
-- formula behind I120, or an amendment that changes a line must re-import a
-- corrected workbook rather than patch the stored figures.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.resolve_order_submission_correction(uuid, text, text, uuid)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260930000000 must be applied before this migration';
  end if;

  -- AND the action set must already admit what this migration logs. 20260923000000
  -- broke exactly this rule and the failure was invisible for weeks, so it is
  -- checked here rather than trusted.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'order_submission_activity'
      and c.conname = 'order_submission_activity_action_check'
      and pg_get_constraintdef(c.oid) like '%product_details_updated%'
  ) then
    raise exception
      'DEPENDENCY MISSING: 20261001000000 must be applied first — it declares the actions this migration logs';
  end if;
end $$;


-- ── 1. Editing one line's descriptive fields ─────────────────────────────────

create or replace function public.update_order_submission_item_details(
  p_item_id          uuid,
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
  v_item       public.order_submission_items%rowtype;
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

  -- DESCRIPTIVE ONLY. Nothing on this list feeds a total, which is the entire
  -- reason this function is safe and the money fields are not.
  c_fields constant text[] := array[
    'item_sequence', 'source_product_code', 'product_name',
    'dimensions', 'material', 'customization'
  ];

  -- The money fields, named so a caller aiming one here is told WHY rather than
  -- "unknown field". They are not merely out of scope; they are blocked.
  c_money constant text[] := array['quantity', 'cost_per_piece', 'total_amount'];
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  -- THE PI IS LOCKED, not the item. Authority, staleness and the row_version
  -- counter all belong to the submission, and two admins editing two different
  -- lines of the same PI are still two edits to one record.
  select i.* into v_item from public.order_submission_items i
   where i.id = p_item_id;
  if not found then
    raise exception 'ORDER_SUBMISSION_ITEM_NOT_FOUND: product line % not found', p_item_id
      using errcode = 'P0002';
  end if;

  select * into v_sub from public.order_submissions
   where id = v_item.submission_id for update;

  v_is_admin := public.can_admin_edit_order_submission(v_sub.id);
  v_is_owner := public.can_edit_order_submission(v_sub.id);
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

  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key = any (c_money) then
      raise exception
        'ORDER_SUBMISSION_MONEY_NOT_EDITABLE: % changes the PI''s totals, and this system reads total_before_gst from the workbook rather than computing it. Correct the workbook and re-import.', v_key
        using errcode = 'P0001';
    end if;
    if not (v_key = any (c_fields)) then
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable product field', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception 'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);
    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_new is not null and length(v_new) > 500 then
      raise exception 'ORDER_SUBMISSION_FIELD_TOO_LONG: % may be at most 500 characters', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_item;
    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
    end if;
  end loop;

  if v_changed = 0 then
    return jsonb_build_object('item_id', p_item_id, 'changed', false, 'fields', 0,
                              'row_version', v_sub.row_version, 'superseded_documents', 0);
  end if;

  update public.order_submission_items set
    item_sequence       = case when p_fields ? 'item_sequence'       then nullif(btrim(coalesce(p_fields ->> 'item_sequence', '')), '')       else item_sequence end,
    source_product_code = case when p_fields ? 'source_product_code' then nullif(btrim(coalesce(p_fields ->> 'source_product_code', '')), '') else source_product_code end,
    product_name        = case when p_fields ? 'product_name'        then nullif(btrim(coalesce(p_fields ->> 'product_name', '')), '')        else product_name end,
    dimensions          = case when p_fields ? 'dimensions'          then nullif(btrim(coalesce(p_fields ->> 'dimensions', '')), '')          else dimensions end,
    material            = case when p_fields ? 'material'            then nullif(btrim(coalesce(p_fields ->> 'material', '')), '')            else material end,
    customization       = case when p_fields ? 'customization'       then nullif(btrim(coalesce(p_fields ->> 'customization', '')), '')       else customization end
  where id = p_item_id;

  update public.order_submissions
     set row_version = row_version + 1, updated_at = now()
   where id = v_sub.id
  returning row_version into v_version;

  -- Product names and codes are printed on the confirmed documents, so a change
  -- makes a ready pair stale. Quantity and rate would too — they are simply not
  -- reachable from here.
  if v_sub.order_id is not null then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');

    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_sub.order_id, v_actor, 'order_products_amended',
            jsonb_build_object('item_id', p_item_id, 'fields', v_changed,
                               'changed', v_changes,
                               'by_admin', v_is_admin and not v_is_owner,
                               'reason', v_reason));
  end if;

  perform public.log_order_submission_activity(
    v_sub.id, v_actor,
    case when v_after_sub and not v_is_owner
         then 'product_details_amended_by_admin' else 'product_details_updated' end,
    v_sub.status, v_sub.status, v_reason,
    jsonb_build_object('item_id', p_item_id, 'fields', v_changed, 'changed', v_changes,
                       'stage', v_sub.status, 'after_submission', v_after_sub,
                       'superseded_documents', v_superseded)
  );

  return jsonb_build_object('item_id', p_item_id, 'changed', true, 'fields', v_changed,
                            'row_version', v_version, 'superseded_documents', v_superseded);
end;
$$;

comment on function public.update_order_submission_item_details(uuid, jsonb, integer, text) is
  'Edits one product line''s DESCRIPTIVE fields — sequence, code, name, dimensions, material, customization. Quantity, rate and line total are REFUSED by name: they move the PI''s totals, and this system reads total_before_gst from the workbook rather than computing it. Locks the PI, not the item.';

revoke all    on function public.update_order_submission_item_details(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_item_details(uuid, jsonb, integer, text) to authenticated;


-- ── 2. Reordering the lines ──────────────────────────────────────────────────
--
-- sort_order IS authoritative: order_submission_items_sort_order_key makes it
-- unique per submission, and the detail screen reads by it. So reordering is a
-- real operation rather than a display preference — and it moves no money,
-- which is why it belongs here and adding a line does not.

create or replace function public.reorder_order_submission_items(
  p_submission_id    uuid,
  p_item_ids         uuid[],
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_is_admin  boolean;
  v_is_owner  boolean;
  v_after_sub boolean;
  v_reason    text;
  v_count     integer;
  v_version   integer;
  v_changed   boolean := false;
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

  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);
  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception 'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;
  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- THE LIST MUST BE THE WHOLE SET, EXACTLY ONCE EACH. A partial list would
  -- leave the unnamed lines with collided sort orders; a repeated id would too.
  -- Refusing is the only honest answer to either.
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception 'ORDER_SUBMISSION_BAD_ORDER: the new order must list every product line'
      using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.order_submission_items
   where submission_id = p_submission_id;

  if v_count <> array_length(p_item_ids, 1)
     or v_count <> (select count(distinct x) from unnest(p_item_ids) x)
     or exists (
       select 1 from unnest(p_item_ids) x
        where not exists (select 1 from public.order_submission_items i
                           where i.id = x and i.submission_id = p_submission_id)
     ) then
    raise exception
      'ORDER_SUBMISSION_BAD_ORDER: the new order must list every product line of this PI exactly once'
      using errcode = 'P0001';
  end if;

  -- Did anything actually move? An unchanged order writes nothing.
  select exists (
    select 1 from unnest(p_item_ids) with ordinality as t(id, pos)
    join public.order_submission_items i on i.id = t.id
    where i.sort_order is distinct from (t.pos - 1)::integer
  ) into v_changed;

  if not v_changed then
    return jsonb_build_object('submission_id', p_submission_id, 'changed', false,
                              'row_version', v_sub.row_version, 'superseded_documents', 0);
  end if;

  -- TWO PASSES, because sort_order is UNIQUE per submission and a single pass
  -- would collide the moment two lines swap. The offset is large enough that no
  -- intermediate value can equal a real one.
  update public.order_submission_items
     set sort_order = sort_order + 1000000
   where submission_id = p_submission_id;

  update public.order_submission_items i
     set sort_order = (t.pos - 1)::integer
    from unnest(p_item_ids) with ordinality as t(id, pos)
   where i.id = t.id;

  update public.order_submissions
     set row_version = row_version + 1, updated_at = now()
   where id = p_submission_id
  returning row_version into v_version;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor,
    case when v_after_sub and not v_is_owner
         then 'product_details_amended_by_admin' else 'product_details_updated' end,
    v_sub.status, v_sub.status, v_reason,
    jsonb_build_object('reordered', true, 'lines', v_count,
                       'stage', v_sub.status, 'after_submission', v_after_sub)
  );

  return jsonb_build_object('submission_id', p_submission_id, 'changed', true,
                            'row_version', v_version, 'superseded_documents', 0);
end;
$$;

comment on function public.reorder_order_submission_items(uuid, uuid[], integer, text) is
  'Reorders a PI''s product lines. sort_order is authoritative (unique per submission), so this is a real operation and not a display preference. The list must name every line of this PI exactly once. Moves no money.';

revoke all    on function public.reorder_order_submission_items(uuid, uuid[], integer, text) from public, anon;
grant  execute on function public.reorder_order_submission_items(uuid, uuid[], integer, text) to authenticated;


-- ── 3. What this migration promises ──────────────────────────────────────────
do $$
declare v_def text; v_fn text;
begin
  foreach v_fn in array array['update_order_submission_item_details',
                              'reorder_order_submission_items'] loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_def is null then raise exception '% was not created', v_fn; end if;
    if v_def !~ 'SET search_path TO ''?public''?, ''?pg_temp''?' then
      raise exception '% has no fixed search_path', v_fn;
    end if;

    -- NO MONEY COLUMN IS EVER ASSIGNED. The whole safety argument.
    if v_def ~* '\mquantity\M\s*=' or v_def ~* '\mcost_per_piece\M\s*='
       or v_def ~* '\mtotal_amount\M\s*=' then
      raise exception '% assigns a money column; it must not', v_fn;
    end if;
    if v_def ~* '\mgross_product_amount\M\s*=' or v_def ~* '\mtotal_before_gst\M\s*='
       or v_def ~* '\mgrand_total\M\s*=' or v_def ~* '\msubtotal_after_discount\M\s*=' then
      raise exception '% assigns a commercial total; it must not', v_fn;
    end if;
  end loop;

  raise notice '20261002000000 applied: PI product descriptive fields and ordering.';
end $$;
