-- Orders: Payment plan for OLD orders that are not in the app ("BDPI").
--
-- WHY
--   More than 50 old orders were never uploaded as Orders. The owner wants the
--   same Payment plan for them (owner, 2026-10-29): upload the old PI's
--   workbook, keep it as BDPI-0001, BDPI-0002, ..., and manage its dispatch
--   lots and payments exactly as for a Confirmed Order. Nothing about the
--   calculation changes; only where the lines come from.
--
-- WHAT THIS DOES
--   1. bdpi_records  one per old order: own number BDPI-0001..., the OLD order
--                    number (normalised like Finance's old-order allocations,
--                    unique), client, the workbook's commercial footer, the
--                    stored workbook. bdpi_items: its product lines (+ picture
--                    path).
--   2. bdpi_payment_plans: the plan's inputs, as order_payment_plans.
--   3. order_dispatch_lots / order_dispatch_lot_events gain bdpi_id: a lot
--      belongs to exactly one Order OR one BDPI. Existing rows are Order rows.
--   4. Functions, all behind view_payment_plan / edit_payment_plan:
--      create_bdpi, bdpi_attach_files, bdpi_list, delete_bdpi (admin, nothing
--      dispatched), bdpi_payment_plan_read (same JSON shape as the Order read),
--      bdpi_payment_plan_save, bdpi_dispatch_lot_save,
--      bdpi_dispatch_lot_mark_dispatched; order_dispatch_lot_admin_change is
--      re-issued to accept a BDPI lot too.
--   4b. Complete PI details are kept (owner, 2026-10-29): who supplies the fabric,
--       the fabric / packing / transport words when the cell held words, the
--       terms note; per line size, material, customization, and the Fabric &
--       Finish sheet's figures and the fabric / finish chosen (finish_specs).
--   5. Payments: CONFIRMED allocations Finance made to the old order number
--      (finance_payment_allocations.legacy_order_no, 20270407000000), split into
--      account and cash with finance_payment_mode_is_account (20270430000000).
--
-- ACCESS MODEL
--   As 20270428000000: RLS on, no policies, nothing granted on the tables;
--   the functions are the only door. Pictures and the workbook live in the
--   private order-files bucket under bdpi/<id>/ and are written and signed only
--   by the app's server after the database has said yes.
--
-- ROLLBACK
--   drop function public.delete_bdpi(uuid, text);
--   drop function public.bdpi_dispatch_lot_mark_dispatched(uuid, date);
--   drop function public.bdpi_dispatch_lot_save(uuid, jsonb, date);
--   drop function public.bdpi_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text);
--   drop function public.bdpi_payment_plan_read(uuid);
--   drop function public.bdpi_list();
--   drop function public.bdpi_attach_files(uuid, text, text, jsonb);
--   drop function public.create_bdpi(jsonb);
--   drop function public.bdpi_check_lines(uuid, jsonb, uuid);
--   drop function public.bdpi_payment_plan_assert(uuid, boolean);
--   re-run §8 of 20270428000000 (order_dispatch_lot_admin_change);
--   delete from public.order_dispatch_lots where bdpi_id is not null;
--   delete from public.order_dispatch_lot_events where bdpi_id is not null;
--   alter table ... drop the bdpi_id columns and constraints, restore order_id not null;
--   drop table public.bdpi_payment_plans; drop table public.bdpi_items; drop table public.bdpi_records;
--   drop sequence public.bdpi_number_seq;
--   and remove order-files/bdpi/ by hand.

do $dep$
begin
  if to_regprocedure('public.order_payment_plan_assert(uuid, boolean)') is null
     or to_regprocedure('public.finance_payment_mode_is_account(text)') is null
     or to_regprocedure('public.normalize_legacy_order_no(text)') is null
     or to_regclass('public.order_dispatch_lots') is null then
    raise exception 'DEPENDENCY MISSING: 20270428000000, 20270430000000 and 20270407000000 must be applied first';
  end if;
end $dep$;


-- ═══ §1. Records and lines ══════════════════════════════════════════════════

create sequence public.bdpi_number_seq start 1;

create table public.bdpi_records (
  id                      uuid primary key default gen_random_uuid(),
  bdpi_no                 text not null unique,
  old_order_no            text not null unique
                          check (old_order_no = public.normalize_legacy_order_no(old_order_no) and length(old_order_no) <= 60),
  client_name             text not null check (btrim(client_name) <> '' and length(client_name) <= 200),
  gross_product_amount    numeric(14,2),
  discount_amount         numeric(14,2),
  subtotal_after_discount numeric(14,2),
  fabric_cost             numeric(14,2),
  packing_cost            numeric(14,2),
  transportation_amount   numeric(14,2),
  total_before_gst        numeric(14,2) check (total_before_gst is null or total_before_gst >= 0),
  gst_amount              numeric(14,2),
  grand_total             numeric(14,2),
  fabric_responsibility   text check (fabric_responsibility is null or fabric_responsibility in ('boe', 'client', 'not_selected')),
  fabric_cost_text        text check (fabric_cost_text is null or length(fabric_cost_text) <= 300),
  packing_cost_text       text check (packing_cost_text is null or length(packing_cost_text) <= 300),
  transportation_text     text check (transportation_text is null or length(transportation_text) <= 300),
  commercial_terms_note   text check (commercial_terms_note is null or length(commercial_terms_note) <= 2000),
  workbook_name           text check (workbook_name is null or length(workbook_name) <= 300),
  workbook_path           text check (workbook_path is null or workbook_path like 'bdpi/%'),
  created_by              uuid references public.users(id) on delete set null,
  created_at              timestamptz not null default now()
);

create table public.bdpi_items (
  id            uuid primary key default gen_random_uuid(),
  bdpi_id       uuid not null references public.bdpi_records(id) on delete cascade,
  item_sequence text not null check (btrim(item_sequence) <> '' and char_length(item_sequence) <= 60),
  product_name  text,
  quantity      numeric(12,2) not null check (quantity > 0),
  rate          numeric(12,2) not null check (rate >= 0),
  line_total    numeric(14,2),
  dimensions    text check (dimensions is null or length(dimensions) <= 500),
  material      text check (material is null or length(material) <= 1000),
  customization text check (customization is null or length(customization) <= 2000),
  -- From the workbook's Fabric & Finish sheets (20270431000000 reads the same sheets for Orders).
  fabric_metres_per_piece numeric(12,3) check (fabric_metres_per_piece is null or fabric_metres_per_piece >= 0),
  fabric_price_per_metre  numeric(12,2) check (fabric_price_per_metre is null or fabric_price_per_metre >= 0),
  packing_cost_per_piece  numeric(12,2) check (packing_cost_per_piece is null or packing_cost_per_piece >= 0),
  packing_type            text check (packing_type is null or length(packing_type) <= 200),
  -- [{heading, value}] — which fabric / finish was chosen.
  finish_specs  jsonb not null default '[]'::jsonb check (jsonb_typeof(finish_specs) = 'array'),
  sort_order    integer not null,
  image_path    text check (image_path is null or image_path like 'bdpi/%'),
  constraint bdpi_items_sequence_unique unique (bdpi_id, item_sequence)
);

create table public.bdpi_payment_plans (
  bdpi_id                  uuid primary key references public.bdpi_records(id) on delete cascade,
  pending_percent          numeric(5,2) not null default 50 check (pending_percent between 0 and 100),
  billing_percent          numeric(5,2) check (billing_percent is null or billing_percent between 0 and 100),
  advance_account_override numeric(14,2) check (advance_account_override is null or advance_account_override >= 0),
  advance_cash_override    numeric(14,2) check (advance_cash_override is null or advance_cash_override >= 0),
  note                     text check (note is null or char_length(note) <= 1000),
  updated_by               uuid references public.users(id) on delete set null,
  updated_at               timestamptz not null default now()
);

alter table public.bdpi_records enable row level security;
alter table public.bdpi_items enable row level security;
alter table public.bdpi_payment_plans enable row level security;
revoke all on public.bdpi_records from anon, authenticated;
revoke all on public.bdpi_items from anon, authenticated;
revoke all on public.bdpi_payment_plans from anon, authenticated;
revoke all on sequence public.bdpi_number_seq from anon, authenticated;

comment on table public.bdpi_records is
  'Payment plan for an OLD order not in the app (owner: "BDPI"). Lines from the uploaded PI workbook. Reached only through the bdpi_* functions (20270502000000).';


-- ═══ §2. Lots and events belong to an Order OR a BDPI ═══════════════════════

alter table public.order_dispatch_lots
  alter column order_id drop not null,
  add column bdpi_id uuid references public.bdpi_records(id) on delete cascade,
  add constraint order_dispatch_lots_one_owner check (num_nonnulls(order_id, bdpi_id) = 1),
  add constraint order_dispatch_lots_bdpi_lot_no_unique unique (bdpi_id, lot_no);

create unique index order_dispatch_lots_one_planned_bdpi
  on public.order_dispatch_lots (bdpi_id) where status = 'planned' and bdpi_id is not null;

alter table public.order_dispatch_lot_events
  alter column order_id drop not null,
  add column bdpi_id uuid references public.bdpi_records(id) on delete cascade,
  add constraint order_dispatch_lot_events_one_owner check (num_nonnulls(order_id, bdpi_id) = 1);


-- ═══ §3. Gate and line check (internal) ═════════════════════════════════════

create or replace function public.bdpi_payment_plan_assert(p_bdpi_id uuid, p_edit boolean)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.module_entry_open('orders')
     or not public.actor_has_module_permission(
          'orders', case when p_edit then 'edit_payment_plan' else 'view_payment_plan' end) then
    raise exception 'PAYMENT_PLAN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_bdpi_id is not null and not exists (select 1 from public.bdpi_records where id = p_bdpi_id) then
    raise exception 'BDPI_NOT_FOUND' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.bdpi_payment_plan_assert(uuid, boolean) from public, anon, authenticated;

create or replace function public.bdpi_check_lines(p_bdpi_id uuid, p_lines jsonb, p_exclude_lot uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_el jsonb;
  v_seq text;
  v_qty numeric;
  v_ordered numeric;
  v_other numeric;
  v_seen text[] := '{}';
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'DISPATCH_LINES_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'DISPATCH_LINES_TOO_MANY' using errcode = '22023';
  end if;
  for v_el in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_el) <> 'object'
       or jsonb_typeof(v_el -> 'item_sequence') <> 'string'
       or jsonb_typeof(v_el -> 'quantity') <> 'number' then
      raise exception 'DISPATCH_LINES_INVALID' using errcode = '22023';
    end if;
    v_seq := btrim(v_el ->> 'item_sequence');
    v_qty := (v_el ->> 'quantity')::numeric;
    if v_qty <= 0 or v_qty <> round(v_qty, 2) then
      raise exception 'DISPATCH_QUANTITY_INVALID: % (needs a positive number, two decimals at most)', v_seq using errcode = '22023';
    end if;
    if v_seq = any (v_seen) then
      raise exception 'DISPATCH_LINE_DUPLICATED: %', v_seq using errcode = '22023';
    end if;
    v_seen := v_seen || v_seq;
    select i.quantity into v_ordered from public.bdpi_items i where i.bdpi_id = p_bdpi_id and i.item_sequence = v_seq;
    if v_ordered is null then
      raise exception 'DISPATCH_LINE_NOT_ON_PI: %', v_seq using errcode = '22023';
    end if;
    select coalesce(sum(l.quantity), 0) into v_other
      from public.order_dispatch_lot_lines l
      join public.order_dispatch_lots t on t.id = l.lot_id
     where t.bdpi_id = p_bdpi_id and l.item_sequence = v_seq
       and (p_exclude_lot is null or t.id <> p_exclude_lot);
    if v_other + v_qty > v_ordered then
      raise exception 'DISPATCH_QUANTITY_EXCEEDS_ORDER: line % ordered %, already in other lots %, asked %',
        v_seq, v_ordered, v_other, v_qty using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('item_sequence', v_seq, 'quantity', v_qty));
  end loop;
  return v_out;
end;
$$;
revoke all on function public.bdpi_check_lines(uuid, jsonb, uuid) from public, anon, authenticated;


-- ═══ §4. Create, attach files, list, delete ═════════════════════════════════
--
-- create_bdpi(payload): {old_order_no, client_name, workbook_name,
--   commercial: {gross_product_amount, discount_amount, subtotal_after_discount,
--   fabric_cost, packing_cost, transportation_amount, total_before_gst,
--   gst_amount, grand_total}, items: [{item_sequence, product_name, quantity,
--   rate, line_total}]}. Returns {id, bdpi_no}. The app parses the workbook on
--   its server; the database checks every figure it is given.

create or replace function public.create_bdpi(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old text := public.normalize_legacy_order_no(p_payload ->> 'old_order_no');
  v_client text := btrim(coalesce(p_payload ->> 'client_name', ''));
  v_c jsonb := coalesce(p_payload -> 'commercial', '{}'::jsonb);
  v_id uuid;
  v_no text;
  v_el jsonb;
  v_i integer := 0;
  v_seq text;
  v_qty numeric;
  v_rate numeric;
  v_amt numeric;
begin
  perform public.bdpi_payment_plan_assert(null, true);

  if v_old is null or length(v_old) > 60 then
    raise exception 'BDPI_OLD_ORDER_REQUIRED' using errcode = '22023';
  end if;
  if v_client = '' or length(v_client) > 200 then
    raise exception 'BDPI_CLIENT_REQUIRED' using errcode = '22023';
  end if;
  if exists (select 1 from public.bdpi_records where old_order_no = v_old) then
    raise exception 'BDPI_OLD_ORDER_EXISTS: %', v_old using errcode = '23505';
  end if;
  if jsonb_typeof(p_payload -> 'items') <> 'array' or jsonb_array_length(p_payload -> 'items') = 0
     or jsonb_array_length(p_payload -> 'items') > 200 then
    raise exception 'BDPI_ITEMS_REQUIRED' using errcode = '22023';
  end if;
  v_amt := nullif(v_c ->> 'total_before_gst', '')::numeric;
  if v_amt is null or v_amt <= 0 then
    raise exception 'BDPI_TOTAL_REQUIRED' using errcode = '22023';
  end if;

  -- Every line is checked BEFORE a number is taken, so a refused upload leaves no gap in BDPI-0001, 0002, …
  for v_el in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_i := v_i + 1;
    v_seq := btrim(coalesce(v_el ->> 'item_sequence', ''));
    v_qty := nullif(v_el ->> 'quantity', '')::numeric;
    v_rate := nullif(v_el ->> 'rate', '')::numeric;
    if v_seq = '' or v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 2)
       or v_rate is null or v_rate < 0 or v_rate <> round(v_rate, 2) then
      raise exception 'BDPI_ITEM_INVALID: line %', v_i using errcode = '22023';
    end if;
  end loop;
  v_i := 0;

  v_no := 'BDPI-' || lpad(nextval('public.bdpi_number_seq')::text, 4, '0');
  insert into public.bdpi_records (bdpi_no, old_order_no, client_name, gross_product_amount, discount_amount,
    subtotal_after_discount, fabric_cost, packing_cost, transportation_amount, total_before_gst, gst_amount,
    grand_total, fabric_responsibility, fabric_cost_text, packing_cost_text, transportation_text,
    commercial_terms_note, workbook_name, created_by)
  values (v_no, v_old, v_client,
    round(nullif(v_c ->> 'gross_product_amount', '')::numeric, 2),
    round(nullif(v_c ->> 'discount_amount', '')::numeric, 2),
    round(nullif(v_c ->> 'subtotal_after_discount', '')::numeric, 2),
    round(nullif(v_c ->> 'fabric_cost', '')::numeric, 2),
    round(nullif(v_c ->> 'packing_cost', '')::numeric, 2),
    round(nullif(v_c ->> 'transportation_amount', '')::numeric, 2),
    round(v_amt, 2),
    round(nullif(v_c ->> 'gst_amount', '')::numeric, 2),
    round(nullif(v_c ->> 'grand_total', '')::numeric, 2),
    case when p_payload ->> 'fabric_responsibility' in ('boe', 'client', 'not_selected') then p_payload ->> 'fabric_responsibility' end,
    left(nullif(btrim(coalesce(v_c ->> 'fabric_cost_text', '')), ''), 300),
    left(nullif(btrim(coalesce(v_c ->> 'packing_cost_text', '')), ''), 300),
    left(nullif(btrim(coalesce(v_c ->> 'transportation_text', '')), ''), 300),
    left(nullif(btrim(coalesce(p_payload ->> 'commercial_terms_note', '')), ''), 2000),
    left(nullif(btrim(coalesce(p_payload ->> 'workbook_name', '')), ''), 300),
    auth.uid())
  returning id into v_id;

  for v_el in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_i := v_i + 1;
    v_seq := btrim(coalesce(v_el ->> 'item_sequence', ''));
    v_qty := nullif(v_el ->> 'quantity', '')::numeric;
    v_rate := nullif(v_el ->> 'rate', '')::numeric;
    if v_seq = '' or v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 2)
       or v_rate is null or v_rate < 0 or v_rate <> round(v_rate, 2) then
      raise exception 'BDPI_ITEM_INVALID: line %', v_i using errcode = '22023';
    end if;
    insert into public.bdpi_items (bdpi_id, item_sequence, product_name, quantity, rate, line_total,
      dimensions, material, customization, fabric_metres_per_piece, fabric_price_per_metre,
      packing_cost_per_piece, packing_type, finish_specs, sort_order)
    values (v_id, v_seq, left(nullif(btrim(coalesce(v_el ->> 'product_name', '')), ''), 300), v_qty, v_rate,
            round(nullif(v_el ->> 'line_total', '')::numeric, 2),
            left(nullif(btrim(coalesce(v_el ->> 'dimensions', '')), ''), 500),
            left(nullif(btrim(coalesce(v_el ->> 'material', '')), ''), 1000),
            left(nullif(btrim(coalesce(v_el ->> 'customization', '')), ''), 2000),
            round(nullif(v_el ->> 'fabric_metres_per_piece', '')::numeric, 3),
            round(nullif(v_el ->> 'fabric_price_per_metre', '')::numeric, 2),
            round(nullif(v_el ->> 'packing_cost_per_piece', '')::numeric, 2),
            left(nullif(btrim(coalesce(v_el ->> 'packing_type', '')), ''), 200),
            case when jsonb_typeof(v_el -> 'finish_specs') = 'array' then v_el -> 'finish_specs' else '[]'::jsonb end,
            v_i);
  end loop;

  return jsonb_build_object('id', v_id, 'bdpi_no', v_no);
end;
$$;
revoke all on function public.create_bdpi(jsonb) from public, anon;
grant execute on function public.create_bdpi(jsonb) to authenticated;

-- The workbook and picture paths, once the app's server has stored them.
-- p_images: [{item_sequence, path}]. Paths must sit under bdpi/<this id>/.
create or replace function public.bdpi_attach_files(p_bdpi_id uuid, p_workbook_path text, p_workbook_name text, p_images jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text := 'bdpi/' || p_bdpi_id::text || '/';
  v_el jsonb;
begin
  perform public.bdpi_payment_plan_assert(p_bdpi_id, true);
  if p_workbook_path is not null then
    if p_workbook_path not like v_prefix || '%' then
      raise exception 'BDPI_PATH_INVALID' using errcode = '22023';
    end if;
    update public.bdpi_records
       set workbook_path = p_workbook_path,
           workbook_name = coalesce(left(nullif(btrim(coalesce(p_workbook_name, '')), ''), 300), workbook_name)
     where id = p_bdpi_id;
  end if;
  if p_images is not null and jsonb_typeof(p_images) = 'array' then
    for v_el in select * from jsonb_array_elements(p_images) loop
      if (v_el ->> 'path') not like v_prefix || '%' then
        raise exception 'BDPI_PATH_INVALID' using errcode = '22023';
      end if;
      update public.bdpi_items set image_path = v_el ->> 'path'
       where bdpi_id = p_bdpi_id and item_sequence = v_el ->> 'item_sequence';
    end loop;
  end if;
end;
$$;
revoke all on function public.bdpi_attach_files(uuid, text, text, jsonb) from public, anon;
grant execute on function public.bdpi_attach_files(uuid, text, text, jsonb) to authenticated;

-- The list: every BDPI with what has been sent and what is left, newest first.
create or replace function public.bdpi_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.bdpi_payment_plan_assert(null, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'bdpi_no', r.bdpi_no,
      'old_order_no', r.old_order_no,
      'client_name', r.client_name,
      'grand_total', r.grand_total,
      'total_before_gst', r.total_before_gst,
      'created_at', r.created_at,
      'ordered_qty', (select coalesce(sum(i.quantity), 0) from public.bdpi_items i where i.bdpi_id = r.id),
      'dispatched_qty', (select coalesce(sum(l.quantity), 0) from public.order_dispatch_lot_lines l
                           join public.order_dispatch_lots t on t.id = l.lot_id
                          where t.bdpi_id = r.id and t.status = 'dispatched'),
      'lots_dispatched', (select count(*) from public.order_dispatch_lots t where t.bdpi_id = r.id and t.status = 'dispatched'),
      'has_planned', exists (select 1 from public.order_dispatch_lots t where t.bdpi_id = r.id and t.status = 'planned')
    ) order by r.created_at desc)
    from public.bdpi_records r), '[]'::jsonb);
end;
$$;
revoke all on function public.bdpi_list() from public, anon;
grant execute on function public.bdpi_list() to authenticated;

-- A BDPI uploaded by mistake: active administrator, a reason, and nothing dispatched.
-- Returns the storage paths for the app's server to remove.
create or replace function public.delete_bdpi(p_bdpi_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paths jsonb;
begin
  perform public.assert_order_amender();
  perform public.bdpi_payment_plan_assert(p_bdpi_id, true);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'DISPATCH_REASON_REQUIRED' using errcode = '22023';
  end if;
  if exists (select 1 from public.order_dispatch_lots where bdpi_id = p_bdpi_id and status = 'dispatched') then
    raise exception 'BDPI_HAS_DISPATCHES' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(p), '[]'::jsonb) into v_paths from (
    select workbook_path as p from public.bdpi_records where id = p_bdpi_id and workbook_path is not null
    union all
    select image_path from public.bdpi_items where bdpi_id = p_bdpi_id and image_path is not null) x;
  delete from public.bdpi_records where id = p_bdpi_id;
  return v_paths;
end;
$$;
revoke all on function public.delete_bdpi(uuid, text) from public, anon;
grant execute on function public.delete_bdpi(uuid, text) to authenticated;


-- ═══ §5. Read: the same shape as order_payment_plan_read ════════════════════

create or replace function public.bdpi_payment_plan_read(p_bdpi_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.bdpi_records%rowtype;
  v_items jsonb;
  v_plan jsonb;
  v_lots jsonb;
  v_fin jsonb;
begin
  perform public.bdpi_payment_plan_assert(p_bdpi_id, false);
  select * into v from public.bdpi_records where id = p_bdpi_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_sequence', i.item_sequence, 'product_name', i.product_name,
           'quantity', i.quantity, 'rate', i.rate, 'line_total', i.line_total,
           'has_image', i.image_path is not null,
           'dimensions', i.dimensions, 'material', i.material, 'customization', i.customization,
           'fabric_metres_per_piece', i.fabric_metres_per_piece, 'fabric_price_per_metre', i.fabric_price_per_metre,
           'packing_cost_per_piece', i.packing_cost_per_piece, 'packing_type', i.packing_type,
           'finish_specs', i.finish_specs
         ) order by i.sort_order), '[]'::jsonb)
    into v_items from public.bdpi_items i where i.bdpi_id = p_bdpi_id;

  select jsonb_build_object(
           'pending_percent', p.pending_percent, 'billing_percent', p.billing_percent,
           'advance_account_override', p.advance_account_override, 'advance_cash_override', p.advance_cash_override,
           'note', p.note, 'updated_at', p.updated_at)
    into v_plan from public.bdpi_payment_plans p where p.bdpi_id = p_bdpi_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'lot_no', t.lot_no, 'status', t.status,
           'planned_on', t.planned_on, 'dispatched_on', t.dispatched_on,
           'lines', (select coalesce(jsonb_agg(jsonb_build_object('item_sequence', l.item_sequence, 'quantity', l.quantity)
                         order by l.item_sequence), '[]'::jsonb)
                       from public.order_dispatch_lot_lines l where l.lot_id = t.id)
         ) order by t.lot_no), '[]'::jsonb)
    into v_lots from public.order_dispatch_lots t where t.bdpi_id = p_bdpi_id;

  select jsonb_build_object(
           'verified', coalesce(sum(a.allocated_amount) filter (where public.finance_payment_status_is_verified(r.status)), 0),
           'awaiting', coalesce(sum(a.allocated_amount) filter (where r.status in ('pending_approval', 'needs_clarification')), 0),
           'payment_count', count(*) filter (where r.status <> 'rejected'),
           'account_verified', coalesce(sum(a.allocated_amount) filter (
              where public.finance_payment_status_is_verified(r.status) and public.finance_payment_mode_is_account(r.payment_mode)), 0),
           'account_awaiting', coalesce(sum(a.allocated_amount) filter (
              where r.status in ('pending_approval', 'needs_clarification') and public.finance_payment_mode_is_account(r.payment_mode)), 0),
           'cash_verified', coalesce(sum(a.allocated_amount) filter (
              where public.finance_payment_status_is_verified(r.status) and not public.finance_payment_mode_is_account(r.payment_mode)), 0),
           'cash_awaiting', coalesce(sum(a.allocated_amount) filter (
              where r.status in ('pending_approval', 'needs_clarification') and not public.finance_payment_mode_is_account(r.payment_mode)), 0))
    into v_fin
    from public.finance_payment_allocations a
    join public.finance_payment_requests r on r.id = a.payment_request_id
   where a.legacy_order_no = v.old_order_no
     and a.status = 'active'
     and r.deleted_at is null;

  return jsonb_build_object(
    'found', true,
    'has_pi', true,
    'kind', 'bdpi',
    'order', jsonb_build_object(
      'id', v.id, 'display_number', v.bdpi_no, 'status', null,
      'total_value', v.grand_total, 'client_name', v.client_name,
      'old_order_no', v.old_order_no, 'workbook_name', v.workbook_name,
      'fabric_responsibility', v.fabric_responsibility, 'commercial_terms_note', v.commercial_terms_note),
    'pi', jsonb_build_object(
      'gross_product_amount', v.gross_product_amount, 'discount_amount', v.discount_amount,
      'subtotal_after_discount', v.subtotal_after_discount, 'fabric_cost', v.fabric_cost,
      'packing_cost', v.packing_cost, 'transportation_amount', v.transportation_amount,
      'transportation_text', v.transportation_text, 'fabric_cost_text', v.fabric_cost_text,
      'packing_cost_text', v.packing_cost_text, 'total_before_gst', v.total_before_gst,
      'gst_amount', v.gst_amount, 'grand_total', v.grand_total, 'billing_percentage', null),
    'items', v_items,
    'plan', v_plan,
    'lots', v_lots,
    'finance', v_fin);
end;
$$;
revoke all on function public.bdpi_payment_plan_read(uuid) from public, anon;
grant execute on function public.bdpi_payment_plan_read(uuid) to authenticated;


-- ═══ §6. Save inputs, plan a lot, mark it dispatched ════════════════════════

create or replace function public.bdpi_payment_plan_save(
  p_bdpi_id uuid, p_pending_percent numeric, p_billing_percent numeric,
  p_advance_account numeric, p_advance_cash numeric, p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.bdpi_payment_plan_assert(p_bdpi_id, true);
  if p_pending_percent is null or p_pending_percent < 0 or p_pending_percent > 100
     or p_pending_percent <> round(p_pending_percent, 2) then
    raise exception 'PAYMENT_PLAN_PERCENT_INVALID: pending' using errcode = '22023';
  end if;
  if p_billing_percent is not null
     and (p_billing_percent < 0 or p_billing_percent > 100 or p_billing_percent <> round(p_billing_percent, 2)) then
    raise exception 'PAYMENT_PLAN_PERCENT_INVALID: billing' using errcode = '22023';
  end if;
  if (p_advance_account is not null and (p_advance_account < 0 or p_advance_account <> round(p_advance_account, 2)))
     or (p_advance_cash is not null and (p_advance_cash < 0 or p_advance_cash <> round(p_advance_cash, 2))) then
    raise exception 'PAYMENT_PLAN_ADVANCE_INVALID' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'PAYMENT_PLAN_NOTE_TOO_LONG' using errcode = '22023';
  end if;
  insert into public.bdpi_payment_plans as p
    (bdpi_id, pending_percent, billing_percent, advance_account_override, advance_cash_override, note, updated_by, updated_at)
  values (p_bdpi_id, p_pending_percent, p_billing_percent, p_advance_account, p_advance_cash, v_note, auth.uid(), now())
  on conflict (bdpi_id) do update
    set pending_percent = excluded.pending_percent, billing_percent = excluded.billing_percent,
        advance_account_override = excluded.advance_account_override,
        advance_cash_override = excluded.advance_cash_override,
        note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.bdpi_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.bdpi_payment_plan_save(uuid, numeric, numeric, numeric, numeric, text) to authenticated;

create or replace function public.bdpi_dispatch_lot_save(p_bdpi_id uuid, p_lines jsonb, p_planned_on date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
  v_lines jsonb;
  v_el jsonb;
begin
  perform public.bdpi_payment_plan_assert(p_bdpi_id, true);
  perform 1 from public.bdpi_records where id = p_bdpi_id for update;

  select * into v_lot from public.order_dispatch_lots where bdpi_id = p_bdpi_id and status = 'planned';
  v_lines := public.bdpi_check_lines(p_bdpi_id, p_lines, v_lot.id);

  if jsonb_array_length(v_lines) = 0 then
    if v_lot.id is null then
      return null;
    end if;
    delete from public.order_dispatch_lots where id = v_lot.id;
    insert into public.order_dispatch_lot_events (bdpi_id, lot_id, lot_no, event, actor)
    values (p_bdpi_id, v_lot.id, v_lot.lot_no, 'discarded', auth.uid());
    return null;
  end if;

  if v_lot.id is null then
    insert into public.order_dispatch_lots (bdpi_id, lot_no, planned_on, created_by)
    values (p_bdpi_id,
            coalesce((select max(t.lot_no) from public.order_dispatch_lots t where t.bdpi_id = p_bdpi_id), 0) + 1,
            p_planned_on, auth.uid())
    returning * into v_lot;
  else
    update public.order_dispatch_lots set planned_on = p_planned_on, updated_at = now() where id = v_lot.id;
    delete from public.order_dispatch_lot_lines where lot_id = v_lot.id;
  end if;

  for v_el in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_dispatch_lot_lines (lot_id, item_sequence, quantity)
    values (v_lot.id, v_el ->> 'item_sequence', (v_el ->> 'quantity')::numeric);
  end loop;

  insert into public.order_dispatch_lot_events (bdpi_id, lot_id, lot_no, event, detail, actor)
  values (p_bdpi_id, v_lot.id, v_lot.lot_no, 'planned', jsonb_build_object('lines', v_lines), auth.uid());
  return v_lot.id;
end;
$$;
revoke all on function public.bdpi_dispatch_lot_save(uuid, jsonb, date) from public, anon;
grant execute on function public.bdpi_dispatch_lot_save(uuid, jsonb, date) to authenticated;

create or replace function public.bdpi_dispatch_lot_mark_dispatched(p_bdpi_id uuid, p_dispatched_on date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
begin
  perform public.bdpi_payment_plan_assert(p_bdpi_id, true);
  perform 1 from public.bdpi_records where id = p_bdpi_id for update;
  if p_dispatched_on is null then
    raise exception 'DISPATCH_DATE_REQUIRED' using errcode = '22023';
  end if;
  if p_dispatched_on > current_date + 1 then
    raise exception 'DISPATCH_DATE_IN_FUTURE' using errcode = '22023';
  end if;
  select * into v_lot from public.order_dispatch_lots where bdpi_id = p_bdpi_id and status = 'planned';
  if not found or not exists (select 1 from public.order_dispatch_lot_lines where lot_id = v_lot.id) then
    raise exception 'DISPATCH_NO_PLANNED_LOT' using errcode = '22023';
  end if;
  update public.order_dispatch_lots set status = 'dispatched', dispatched_on = p_dispatched_on, updated_at = now()
   where id = v_lot.id;
  insert into public.order_dispatch_lot_events (bdpi_id, lot_id, lot_no, event, detail, actor)
  values (p_bdpi_id, v_lot.id, v_lot.lot_no, 'dispatched', jsonb_build_object('dispatched_on', p_dispatched_on), auth.uid());
end;
$$;
revoke all on function public.bdpi_dispatch_lot_mark_dispatched(uuid, date) from public, anon;
grant execute on function public.bdpi_dispatch_lot_mark_dispatched(uuid, date) to authenticated;


-- ═══ §7. Admin change to a dispatched lot: an Order's or a BDPI's ═══════════

create or replace function public.order_dispatch_lot_admin_change(
  p_lot_id uuid, p_reason text, p_lines jsonb, p_dispatched_on date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_lines jsonb;
  v_old jsonb;
  v_el jsonb;
begin
  perform public.assert_order_amender();

  select * into v_lot from public.order_dispatch_lots where id = p_lot_id for update;
  if not found or v_lot.status <> 'dispatched' then
    raise exception 'DISPATCH_LOT_NOT_FOUND' using errcode = '22023';
  end if;
  if v_lot.bdpi_id is not null then
    perform public.bdpi_payment_plan_assert(v_lot.bdpi_id, true);
    perform 1 from public.bdpi_records where id = v_lot.bdpi_id for update;
  else
    perform public.order_payment_plan_assert(v_lot.order_id, true);
    perform 1 from public.orders where id = v_lot.order_id for update;
  end if;

  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'DISPATCH_REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_dispatched_on is not null and p_dispatched_on > current_date + 1 then
    raise exception 'DISPATCH_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('item_sequence', l.item_sequence, 'quantity', l.quantity)), '[]'::jsonb)
    into v_old from public.order_dispatch_lot_lines l where l.lot_id = v_lot.id;

  v_lines := case when v_lot.bdpi_id is not null
                  then public.bdpi_check_lines(v_lot.bdpi_id, p_lines, v_lot.id)
                  else public.order_payment_plan_check_lines(v_lot.order_id, p_lines, v_lot.id) end;

  if jsonb_array_length(v_lines) = 0 then
    delete from public.order_dispatch_lots where id = v_lot.id;
    insert into public.order_dispatch_lot_events (order_id, bdpi_id, lot_id, lot_no, event, reason, detail, actor)
    values (v_lot.order_id, v_lot.bdpi_id, v_lot.id, v_lot.lot_no, 'admin_deleted', v_reason,
            jsonb_build_object('was', v_old, 'dispatched_on', v_lot.dispatched_on), auth.uid());
    return;
  end if;

  delete from public.order_dispatch_lot_lines where lot_id = v_lot.id;
  for v_el in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_dispatch_lot_lines (lot_id, item_sequence, quantity)
    values (v_lot.id, v_el ->> 'item_sequence', (v_el ->> 'quantity')::numeric);
  end loop;
  update public.order_dispatch_lots
     set dispatched_on = coalesce(p_dispatched_on, dispatched_on), updated_at = now()
   where id = v_lot.id;

  insert into public.order_dispatch_lot_events (order_id, bdpi_id, lot_id, lot_no, event, reason, detail, actor)
  values (v_lot.order_id, v_lot.bdpi_id, v_lot.id, v_lot.lot_no, 'admin_changed', v_reason,
          jsonb_build_object('was', v_old, 'now', v_lines,
                             'dispatched_on_was', v_lot.dispatched_on,
                             'dispatched_on_now', coalesce(p_dispatched_on, v_lot.dispatched_on)),
          auth.uid());
end;
$$;
revoke all on function public.order_dispatch_lot_admin_change(uuid, text, jsonb, date) from public, anon;
grant execute on function public.order_dispatch_lot_admin_change(uuid, text, jsonb, date) to authenticated;


-- ═══ §8. Self-assertions (executed) ═════════════════════════════════════════

do $assert$
begin
  if has_table_privilege('authenticated', 'public.bdpi_records', 'select')
     or has_table_privilege('authenticated', 'public.bdpi_items', 'select')
     or has_table_privilege('authenticated', 'public.bdpi_payment_plans', 'select') then
    raise exception 'ASSERT: BDPI tables must not be readable by client roles';
  end if;
  if has_function_privilege('authenticated', 'public.bdpi_check_lines(uuid, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.bdpi_payment_plan_assert(uuid, boolean)', 'execute') then
    raise exception 'ASSERT: internal BDPI helpers must not be callable by clients';
  end if;
  if exists (select 1 from public.order_dispatch_lots where num_nonnulls(order_id, bdpi_id) <> 1) then
    raise exception 'ASSERT: every existing lot must belong to exactly one Order or BDPI';
  end if;
end $assert$;
