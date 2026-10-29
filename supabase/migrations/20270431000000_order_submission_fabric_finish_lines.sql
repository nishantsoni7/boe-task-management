-- Orders: the Fabric & Finish cost sheet of a PI — per product line, what the
-- workbook's "Packing cost and Fabric Cost" and "Fabric and Finish" sheets
-- said, and what a person typed in the app where the workbook left blanks.
--
-- WHY (owner, 2026-10-29)
--   The PI's own "(A) Total Fabric Cost" and "(B) Total Packing Cost" lines are
--   formulas over the first sheet — ROUND(SUM, -1), "-" when nothing is quoted —
--   and the app stored only those two totals. Keeping the per-product inputs
--   lets the app show the costing per product, lets the salesperson type what
--   the sheet left blank, keeps the finish choices (fabric code, wood / metal /
--   marble finish, with a reference picture) beside the product, and lets a
--   revised quantity move the totals by itself: the totals are computed on
--   every read (src/lib/orders/fabricFinishCost.ts), never stored.
--
-- THE LINE'S IDENTITY is the PI line's item number (item_sequence), the same
-- key the Payment plan uses (20270428000000): a revision replaces the item rows
-- and their ids, the number stays. A line with no number is keyed by its row id.
--
-- TWO SETS OF VALUES PER LINE, KEPT APART
--   sheet_*   what the workbook said; REPLACED on every parse of a workbook
--   typed_*   what a person typed; KEPT across parses; a typed value wins and
--             the sheet's stays visible underneath (owner, 2026-10-29)
--
-- WHAT IT ADDS
--   1. public.order_submission_fabric_finish_lines          RLS on, no policies
--   2. can_view_order_submission_fabric_finish(uuid)       the PI's readers, or the Order's
--   3. can_edit_order_submission_fabric_finish(uuid)       PI salesperson / creator / submitter, admins, managers; on an Order the same people who record approvals
--   4. order_submission_fabric_finish_read(uuid)           one call, everything the sheet needs
--   5. order_submission_fabric_finish_save_sheet(...)      service role only, from the import route
--   6. order_submission_fabric_finish_save_typed(...)      authenticated, one line at a time
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * Writes nothing to order_submissions, order_submission_items or orders.
--     The PI's own Fabric cost / Packing cost lines move only through Edit PI
--     (a draft) or a PI revision an admin approves (an Order).
--   * Adds no permission action: seeing the sheet follows seeing the PI or the
--     Order (owner, 2026-10-29).
--   * Logs no activity and sends no notification, like the pendencies.
--
-- ROLLBACK
--   drop function public.order_submission_fabric_finish_save_typed(uuid, text, jsonb);
--   drop function public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb);
--   drop function public.order_submission_fabric_finish_read(uuid);
--   drop function public.can_edit_order_submission_fabric_finish(uuid);
--   drop function public.can_view_order_submission_fabric_finish(uuid);
--   drop function public.order_submission_fabric_finish_number(jsonb, integer);
--   drop function public.order_submission_fabric_finish_check_finish(uuid, jsonb);
--   drop table public.order_submission_fabric_finish_lines;

do $dep$
begin
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
  if to_regprocedure('public.can_view_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.can_view_order_submission(uuid)';
  end if;
  if to_regprocedure('public.can_read_order_detail(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.can_read_order_detail(uuid)';
  end if;
  if to_regprocedure('public.can_record_order_approval(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.can_record_order_approval(uuid)';
  end if;
  if to_regclass('public.orders') is null
     or to_regclass('public.order_submissions') is null
     or to_regclass('public.order_submission_items') is null
     or to_regclass('public.users') is null then
    raise exception 'DEPENDENCY MISSING: orders / PI / users tables';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'order_submissions' and column_name = 'salesperson_id') then
    raise exception 'DEPENDENCY MISSING: order_submissions.salesperson_id (20270211000000)';
  end if;
end $dep$;


-- ═══ §1. Table ══════════════════════════════════════════════════════════════

create table public.order_submission_fabric_finish_lines (
  submission_id   uuid not null references public.order_submissions(id) on delete cascade,
  item_sequence   text not null check (btrim(item_sequence) <> '' and char_length(item_sequence) <= 60),

  -- From the workbook sheet. NULL = the sheet left it blank. Replaced on every parse.
  sheet_fabric_metres_per_piece numeric(12,3) check (sheet_fabric_metres_per_piece is null or sheet_fabric_metres_per_piece >= 0),
  sheet_fabric_price_per_metre  numeric(12,2) check (sheet_fabric_price_per_metre is null or sheet_fabric_price_per_metre >= 0),
  sheet_packing_cost_per_piece  numeric(12,2) check (sheet_packing_cost_per_piece is null or sheet_packing_cost_per_piece >= 0),
  sheet_packing_type            text check (sheet_packing_type is null or char_length(sheet_packing_type) <= 200),
  -- [{heading, value}] from the "Fabric and Finish" sheet, in column order.
  sheet_finish                  jsonb not null default '[]'::jsonb check (jsonb_typeof(sheet_finish) = 'array'),
  sheet_read_at                 timestamptz,
  sheet_workbook_sha256         text check (sheet_workbook_sha256 is null or sheet_workbook_sha256 ~ '^[0-9a-f]{64}$'),

  -- Typed in the app. NULL = nothing typed for that value. Kept across parses.
  typed_fabric_metres_per_piece numeric(12,3) check (typed_fabric_metres_per_piece is null or typed_fabric_metres_per_piece >= 0),
  typed_fabric_price_per_metre  numeric(12,2) check (typed_fabric_price_per_metre is null or typed_fabric_price_per_metre >= 0),
  typed_packing_cost_per_piece  numeric(12,2) check (typed_packing_cost_per_piece is null or typed_packing_cost_per_piece >= 0),
  typed_packing_type            text check (typed_packing_type is null or char_length(typed_packing_type) <= 200),
  -- [{heading, value, image_path, image_sha256}] typed in the app; wins over sheet_finish by heading.
  typed_finish                  jsonb not null default '[]'::jsonb check (jsonb_typeof(typed_finish) = 'array'),
  typed_by                      uuid references public.users(id) on delete set null,
  typed_at                      timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (submission_id, item_sequence)
);

alter table public.order_submission_fabric_finish_lines enable row level security;
revoke all on public.order_submission_fabric_finish_lines from anon, authenticated;

comment on table public.order_submission_fabric_finish_lines is
  'Fabric & Finish cost sheet of a PI, per product line (item_sequence): what the workbook sheets said (sheet_*, replaced on every parse) and what a person typed (typed_*, kept; wins). Totals are computed by src/lib/orders/fabricFinishCost.ts, never stored. Reached only through order_submission_fabric_finish_* functions (20270431000000).';


-- ═══ §2. Who may see, who may type ══════════════════════════════════════════

-- The PI's own readers, or — once it is an Order — anyone who may read that
-- Order (owner, 2026-10-29: "anyone on the Order"). Explicit rules only: a
-- security-invoker helper would run as this function's owner and see everything.
create or replace function public.can_view_order_submission_fabric_finish(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and public.module_entry_open('orders')
     and (
       public.can_view_order_submission(p_submission_id)
       or exists (
         select 1 from public.order_submissions s
          where s.id = p_submission_id
            and s.order_id is not null
            and public.can_read_order_detail(s.order_id)
       )
     );
$$;
revoke all on function public.can_view_order_submission_fabric_finish(uuid) from public, anon;
grant execute on function public.can_view_order_submission_fabric_finish(uuid) to authenticated, service_role;

-- The PI's salesperson, creator or submitter, active admins and managers; on an
-- Order also whoever may record its fabric / finish approvals (the assigned
-- salesperson, admins, managers). Never on a rejected PI or a cancelled Order.
create or replace function public.can_edit_order_submission_fabric_finish(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and public.module_entry_open('orders')
     and exists (
       select 1
         from public.order_submissions s
         join public.users u on u.id = auth.uid()
        where s.id = p_submission_id
          and u.is_active
          and coalesce(u.is_deleted, false) = false
          and s.status <> 'rejected'
          and not exists (select 1 from public.orders o where o.id = s.order_id and o.status = 'cancelled')
          and (
            u.role in ('admin', 'manager')
            or s.created_by = auth.uid()
            or s.submitted_by = auth.uid()
            or s.salesperson_id = auth.uid()
            or (s.order_id is not null and public.can_record_order_approval(s.order_id))
          )
     );
$$;
revoke all on function public.can_edit_order_submission_fabric_finish(uuid) from public, anon;
grant execute on function public.can_edit_order_submission_fabric_finish(uuid) to authenticated, service_role;


-- ═══ §3. Internal helpers (no client grant) ═════════════════════════════════

-- A JSON number (or nothing) as a non-negative numeric of the given scale.
create or replace function public.order_submission_fabric_finish_number(p_value jsonb, p_scale integer)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) <> 'number' then
    raise exception 'FABRIC_FINISH_VALUE_INVALID: a figure must be a number' using errcode = '22023';
  end if;
  v := (p_value #>> '{}')::numeric;
  if v < 0 then
    raise exception 'FABRIC_FINISH_VALUE_INVALID: a figure cannot be negative' using errcode = '22023';
  end if;
  if v <> round(v, p_scale) then
    raise exception 'FABRIC_FINISH_VALUE_INVALID: at most % decimals', p_scale using errcode = '22023';
  end if;
  if v >= 1000000000 then
    raise exception 'FABRIC_FINISH_VALUE_INVALID: figure too large' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public.order_submission_fabric_finish_number(jsonb, integer) from public, anon, authenticated;

-- A finish list as the table keeps it: [{heading, value, image_path, image_sha256}].
-- A picture may only be this PI's own fabric-finish object, named by its bytes.
create or replace function public.order_submission_fabric_finish_check_finish(p_submission_id uuid, p_finish jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_el jsonb;
  v_out jsonb := '[]'::jsonb;
  v_heading text;
  v_value text;
  v_path text;
  v_sha text;
  v_count integer := 0;
begin
  if p_finish is null or jsonb_typeof(p_finish) = 'null' then return v_out; end if;
  if jsonb_typeof(p_finish) <> 'array' then
    raise exception 'FABRIC_FINISH_FINISH_INVALID: finish must be a list' using errcode = '22023';
  end if;
  for v_el in select * from jsonb_array_elements(p_finish) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'FABRIC_FINISH_FINISH_INVALID: each finish is an object' using errcode = '22023';
    end if;
    v_heading := btrim(coalesce(v_el ->> 'heading', ''));
    v_value   := btrim(coalesce(v_el ->> 'value', ''));
    v_path    := nullif(btrim(coalesce(v_el ->> 'image_path', '')), '');
    v_sha     := nullif(btrim(coalesce(v_el ->> 'image_sha256', '')), '');
    if v_heading = '' or char_length(v_heading) > 120 then
      raise exception 'FABRIC_FINISH_FINISH_INVALID: a heading is required (at most 120 characters)' using errcode = '22023';
    end if;
    if char_length(v_value) > 500 then
      raise exception 'FABRIC_FINISH_FINISH_INVALID: a value may be at most 500 characters' using errcode = '22023';
    end if;
    if v_value = '' and v_path is null then
      continue;  -- nothing recorded under this heading
    end if;
    if v_path is not null then
      if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then
        raise exception 'FABRIC_FINISH_IMAGE_INVALID: a picture needs its sha256' using errcode = '22023';
      end if;
      if v_path !~ ('^submissions/' || p_submission_id::text || '/fabric-finish/[A-Za-z0-9._-]{1,60}/' || v_sha || '\.(png|jpg|webp)$') then
        raise exception 'FABRIC_FINISH_IMAGE_INVALID: the picture is not this PI''s own fabric-finish object' using errcode = '22023';
      end if;
    end if;
    v_count := v_count + 1;
    if v_count > 12 then
      raise exception 'FABRIC_FINISH_FINISH_INVALID: at most 12 finish choices per product' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'heading', v_heading, 'value', v_value, 'image_path', v_path, 'image_sha256', v_sha)));
  end loop;
  return v_out;
end;
$$;
revoke all on function public.order_submission_fabric_finish_check_finish(uuid, jsonb) from public, anon, authenticated;


-- ═══ §4. Read ═══════════════════════════════════════════════════════════════
--
-- One call returns the PI's lines in force (quantity, name, code), the stored
-- sheet and typed values per line, the PI's own Fabric cost / Packing cost
-- lines with their meaning, and whether the caller may type.

create or replace function public.order_submission_fabric_finish_read(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub   public.order_submissions%rowtype;
  v_order public.orders%rowtype;
  v_items jsonb;
  v_lines jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.can_view_order_submission_fabric_finish(p_submission_id) then
    raise exception 'FABRIC_FINISH_FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if v_sub.order_id is not null then
    select * into v_order from public.orders where id = v_sub.order_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_sequence', coalesce(nullif(btrim(i.item_sequence), ''), i.id::text),
           'item_id', i.id,
           'product_name', i.product_name,
           'source_product_code', i.source_product_code,
           'quantity', i.quantity,
           'sort_order', i.sort_order
         ) order by i.sort_order, i.source_row), '[]'::jsonb)
    into v_items
    from public.order_submission_items i
   where i.submission_id = p_submission_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_sequence', l.item_sequence,
           'sheet', case when l.sheet_read_at is null then null else jsonb_build_object(
             'fabric_metres_per_piece', l.sheet_fabric_metres_per_piece,
             'fabric_price_per_metre',  l.sheet_fabric_price_per_metre,
             'packing_cost_per_piece',  l.sheet_packing_cost_per_piece,
             'packing_type',            l.sheet_packing_type,
             'finish',                  l.sheet_finish) end,
           'typed', case when l.typed_at is null then null else jsonb_build_object(
             'fabric_metres_per_piece', l.typed_fabric_metres_per_piece,
             'fabric_price_per_metre',  l.typed_fabric_price_per_metre,
             'packing_cost_per_piece',  l.typed_packing_cost_per_piece,
             'packing_type',            l.typed_packing_type,
             'finish',                  l.typed_finish) end,
           'typed_by_name', (select u.full_name from public.users u where u.id = l.typed_by),
           'typed_at', l.typed_at,
           'sheet_read_at', l.sheet_read_at
         )), '[]'::jsonb)
    into v_lines
    from public.order_submission_fabric_finish_lines l
   where l.submission_id = p_submission_id;

  return jsonb_build_object(
    'found', true,
    'can_edit', public.can_edit_order_submission_fabric_finish(p_submission_id),
    'submission', jsonb_build_object(
      'id', v_sub.id,
      'status', v_sub.status,
      'order_id', v_sub.order_id,
      'order_status', v_order.status,
      'display_number', v_order.display_number,
      'client_name', v_sub.client_name,
      'source_workbook_name', v_sub.source_workbook_name,
      'fabric_cost', v_sub.fabric_cost,
      'fabric_cost_meaning', v_sub.fabric_cost_meaning,
      'fabric_cost_text', v_sub.fabric_cost_text,
      'packing_cost', v_sub.packing_cost,
      'packing_cost_meaning', v_sub.packing_cost_meaning,
      'packing_cost_text', v_sub.packing_cost_text,
      'sheet_read_at', (select max(l.sheet_read_at) from public.order_submission_fabric_finish_lines l
                         where l.submission_id = p_submission_id)),
    'items', v_items,
    'lines', v_lines);
end;
$$;
revoke all on function public.order_submission_fabric_finish_read(uuid) from public, anon;
grant execute on function public.order_submission_fabric_finish_read(uuid) to authenticated, service_role;


-- ═══ §5. The workbook's values, from the import route ═══════════════════════
--
-- SERVICE ROLE ONLY: the import route calls it right after the parse writer
-- (replace_order_submission_parse / approve_order_pi_revision) committed, with
-- the lines keyed by the item numbers that parse stored. Every sheet_* value of
-- every line of this PI is replaced by the payload's; a line the workbook no
-- longer carries loses its sheet values and keeps its typed ones; a line with
-- neither is removed.

create or replace function public.order_submission_fabric_finish_save_sheet(
  p_submission_id uuid,
  p_workbook_sha256 text,
  p_lines jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_el    jsonb;
  v_seq   text;
  v_seen  text[] := '{}';
  v_count integer := 0;
  v_now   timestamptz := now();
  v_sha   text := nullif(btrim(coalesce(p_workbook_sha256, '')), '');
begin
  if not exists (select 1 from public.order_submissions s where s.id = p_submission_id) then
    raise exception 'FABRIC_FINISH_NO_PI' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'FABRIC_FINISH_LINES_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'FABRIC_FINISH_LINES_TOO_MANY' using errcode = '22023';
  end if;
  if v_sha is not null and v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'FABRIC_FINISH_LINES_INVALID: workbook sha256' using errcode = '22023';
  end if;

  for v_el in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'FABRIC_FINISH_LINES_INVALID' using errcode = '22023';
    end if;
    v_seq := btrim(coalesce(v_el ->> 'item_sequence', ''));
    if v_seq = '' or char_length(v_seq) > 60 then
      raise exception 'FABRIC_FINISH_LINES_INVALID: item_sequence' using errcode = '22023';
    end if;
    if v_seq = any (v_seen) then
      raise exception 'FABRIC_FINISH_LINE_DUPLICATED: %', v_seq using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_seq);

    insert into public.order_submission_fabric_finish_lines as l (
      submission_id, item_sequence,
      sheet_fabric_metres_per_piece, sheet_fabric_price_per_metre, sheet_packing_cost_per_piece,
      sheet_packing_type, sheet_finish, sheet_read_at, sheet_workbook_sha256)
    values (
      p_submission_id, v_seq,
      public.order_submission_fabric_finish_number(v_el -> 'fabric_metres_per_piece', 3),
      public.order_submission_fabric_finish_number(v_el -> 'fabric_price_per_metre', 2),
      public.order_submission_fabric_finish_number(v_el -> 'packing_cost_per_piece', 2),
      nullif(left(btrim(coalesce(v_el ->> 'packing_type', '')), 200), ''),
      public.order_submission_fabric_finish_check_finish(p_submission_id, v_el -> 'finish'),
      v_now, v_sha)
    on conflict (submission_id, item_sequence) do update set
      sheet_fabric_metres_per_piece = excluded.sheet_fabric_metres_per_piece,
      sheet_fabric_price_per_metre  = excluded.sheet_fabric_price_per_metre,
      sheet_packing_cost_per_piece  = excluded.sheet_packing_cost_per_piece,
      sheet_packing_type            = excluded.sheet_packing_type,
      sheet_finish                  = excluded.sheet_finish,
      sheet_read_at                 = excluded.sheet_read_at,
      sheet_workbook_sha256         = excluded.sheet_workbook_sha256,
      updated_at                    = v_now;
    v_count := v_count + 1;
  end loop;

  -- Lines this workbook no longer carries: the sheet's values are gone.
  update public.order_submission_fabric_finish_lines l
     set sheet_fabric_metres_per_piece = null, sheet_fabric_price_per_metre = null,
         sheet_packing_cost_per_piece = null, sheet_packing_type = null, sheet_finish = '[]'::jsonb,
         sheet_read_at = null, sheet_workbook_sha256 = null, updated_at = v_now
   where l.submission_id = p_submission_id
     and l.sheet_read_at is not null
     and not (l.item_sequence = any (v_seen));

  -- Nothing from the sheet and nothing typed: no row.
  delete from public.order_submission_fabric_finish_lines l
   where l.submission_id = p_submission_id
     and l.sheet_read_at is null
     and l.typed_at is null;

  return v_count;
end;
$$;
revoke all on function public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb) to service_role;


-- ═══ §6. What a person types, one line at a time ════════════════════════════
--
-- p_values: {fabric_metres_per_piece, fabric_price_per_metre, packing_cost_per_piece,
--            packing_type, finish: [{heading, value, image_path, image_sha256}]}
-- A null (or absent) figure CLEARS the typed value, so the sheet's shows again.
-- The line must be a line of the PI in force, by the same key the read uses.

create or replace function public.order_submission_fabric_finish_save_typed(
  p_submission_id uuid,
  p_item_sequence text,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq    text := btrim(coalesce(p_item_sequence, ''));
  v_now    timestamptz := now();
  v_metres numeric;
  v_price  numeric;
  v_pack   numeric;
  v_type   text;
  v_finish jsonb;
  v_empty  boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.can_edit_order_submission_fabric_finish(p_submission_id) then
    raise exception 'FABRIC_FINISH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_seq = '' or char_length(v_seq) > 60 then
    raise exception 'FABRIC_FINISH_LINE_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.order_submission_items i
     where i.submission_id = p_submission_id
       and coalesce(nullif(btrim(i.item_sequence), ''), i.id::text) = v_seq
  ) then
    raise exception 'FABRIC_FINISH_LINE_NOT_ON_PI: %', v_seq using errcode = '22023';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'FABRIC_FINISH_VALUES_INVALID' using errcode = '22023';
  end if;

  v_metres := public.order_submission_fabric_finish_number(p_values -> 'fabric_metres_per_piece', 3);
  v_price  := public.order_submission_fabric_finish_number(p_values -> 'fabric_price_per_metre', 2);
  v_pack   := public.order_submission_fabric_finish_number(p_values -> 'packing_cost_per_piece', 2);
  v_type   := nullif(left(btrim(coalesce(p_values ->> 'packing_type', '')), 200), '');
  v_finish := public.order_submission_fabric_finish_check_finish(p_submission_id, p_values -> 'finish');
  v_empty  := v_metres is null and v_price is null and v_pack is null and v_type is null
              and jsonb_array_length(v_finish) = 0;

  insert into public.order_submission_fabric_finish_lines as l (
    submission_id, item_sequence,
    typed_fabric_metres_per_piece, typed_fabric_price_per_metre, typed_packing_cost_per_piece,
    typed_packing_type, typed_finish, typed_by, typed_at)
  values (
    p_submission_id, v_seq, v_metres, v_price, v_pack, v_type, v_finish,
    case when v_empty then null else auth.uid() end,
    case when v_empty then null else v_now end)
  on conflict (submission_id, item_sequence) do update set
    typed_fabric_metres_per_piece = excluded.typed_fabric_metres_per_piece,
    typed_fabric_price_per_metre  = excluded.typed_fabric_price_per_metre,
    typed_packing_cost_per_piece  = excluded.typed_packing_cost_per_piece,
    typed_packing_type            = excluded.typed_packing_type,
    typed_finish                  = excluded.typed_finish,
    typed_by                      = excluded.typed_by,
    typed_at                      = excluded.typed_at,
    updated_at                    = v_now;

  -- Nothing typed and nothing from the sheet: no row.
  delete from public.order_submission_fabric_finish_lines l
   where l.submission_id = p_submission_id
     and l.item_sequence = v_seq
     and l.sheet_read_at is null
     and l.typed_at is null;

  return jsonb_build_object('ok', true, 'item_sequence', v_seq, 'typed_at', case when v_empty then null else v_now end);
end;
$$;
revoke all on function public.order_submission_fabric_finish_save_typed(uuid, text, jsonb) from public, anon;
grant execute on function public.order_submission_fabric_finish_save_typed(uuid, text, jsonb) to authenticated, service_role;


-- ═══ §7. Self-check ═════════════════════════════════════════════════════════

do $check$
begin
  if to_regclass('public.order_submission_fabric_finish_lines') is null then
    raise exception 'SELF-CHECK: table missing';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'order_submission_fabric_finish_lines' and c.relrowsecurity) then
    raise exception 'SELF-CHECK: RLS is not enabled';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_submission_fabric_finish_lines') then
    raise exception 'SELF-CHECK: the table must have no policies';
  end if;
  if to_regprocedure('public.order_submission_fabric_finish_read(uuid)') is null
     or to_regprocedure('public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb)') is null
     or to_regprocedure('public.order_submission_fabric_finish_save_typed(uuid, text, jsonb)') is null
     or to_regprocedure('public.can_view_order_submission_fabric_finish(uuid)') is null
     or to_regprocedure('public.can_edit_order_submission_fabric_finish(uuid)') is null then
    raise exception 'SELF-CHECK: a function is missing';
  end if;
  if has_function_privilege('authenticated', 'public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb)', 'execute') then
    raise exception 'SELF-CHECK: save_sheet must not be callable by authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.order_submission_fabric_finish_save_typed(uuid, text, jsonb)', 'execute') then
    raise exception 'SELF-CHECK: save_typed must be callable by authenticated';
  end if;
  -- The number helper refuses what the table would refuse.
  if public.order_submission_fabric_finish_number('1.5'::jsonb, 2) <> 1.5 then
    raise exception 'SELF-CHECK: number helper';
  end if;
  begin
    perform public.order_submission_fabric_finish_number('-1'::jsonb, 2);
    raise exception 'SELF-CHECK: a negative figure was accepted';
  exception when sqlstate '22023' then null;
  end;
end $check$;
