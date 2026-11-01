-- Orders: Dispatch records — what left, on which vehicle, with which papers.
--
-- WHY
--   When goods leave, the owner, Dhruv or Sales upload the papers (invoice,
--   e-way bill, LR / bilty) and the details are kept against the Order: date,
--   products, vehicle, invoice and e-way bill. The Dispatch tab on the product
--   list then says what is dispatched and what is pending for each product.
--
-- A DISPATCH IS A LOT
--   order_dispatch_lots (20270428000000) already holds what left and when, and
--   the Payment plan reads it. A second store of quantities would make the
--   two disagree, so a dispatch recorded here IS a dispatched lot: the planned
--   lot is taken over when there is one, otherwise a new lot is made. The
--   paperwork sits beside it in two new tables.
--
-- WHAT THIS DOES
--   1. Registers orders.record_dispatch (deny-by-default; admins hold it through
--      the admin branch). edit_payment_plan is NOT reused: it shows what each
--      client owes, and Sales need to record a dispatch without seeing that.
--   2. order_dispatch_details   one row per lot: transport, invoice, e-way bill.
--   3. order_dispatch_files     the papers. Stored in order-files under
--      orders/{order}/dispatch/{record_key}/{uuid}.{ext}, so the sweep behind
--      Order delete and Test Data Cleanup (orders/{order}/) already covers them.
--   4. Functions: order_dispatch_read, order_dispatch_record, order_dispatch_update.
--   5. Widens order_dispatch_lot_events with the new events, and keeps a copy of
--      the paperwork in that trail if an administrator deletes the lot.
--
-- ACCESS MODEL
--   RLS on, NO policies, nothing granted to anon/authenticated on the tables:
--   they are reached only through the functions above. Reading asks for the
--   UNSCOPED right to open the Order, because an invoice shows money and a
--   visibility scope reveals Order detail, never money.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * Moves no Order status. "Dispatched" on the Order stays the admin's own
--     step, and it is where the ₹1,000 payment rule (2026-09-18) would sit.
--   * Changing goods or the date after a dispatch stays
--     order_dispatch_lot_admin_change: admin only, with a reason.
--
-- ROLLBACK
--   drop policy "order_files_dispatch_insert" on storage.objects;
--   drop policy "order_files_dispatch_select" on storage.objects;
--   drop trigger order_dispatch_lots_keep_papers on public.order_dispatch_lots;
--   drop function public.order_dispatch_lots_keep_papers();
--   drop function public.order_dispatch_update(uuid, uuid, jsonb, jsonb);
--   drop function public.order_dispatch_record(uuid, uuid, date, jsonb, jsonb, jsonb);
--   drop function public.order_dispatch_read(uuid);
--   drop function public.order_dispatch_files_add(uuid, uuid, uuid, jsonb);
--   drop function public.order_dispatch_details_put(uuid, uuid, jsonb);
--   drop function public.order_dispatch_text(jsonb, text);
--   drop function public.can_read_order_dispatch_file(text);
--   drop function public.can_upload_order_dispatch_file(text);
--   drop function public.order_dispatch_file_key_parts(text);
--   drop function public.order_dispatch_assert(uuid, boolean);
--   drop table public.order_dispatch_files;
--   drop table public.order_dispatch_details;
--   delete from public.order_dispatch_lot_events where event in ('recorded', 'details_saved', 'papers_removed');
--   Restore the event check of 20270428000000. The permission rows may stay.
--   Lots recorded here stay as ordinary dispatched lots.

do $dep$
begin
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: public.actor_has_module_permission(text, text)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
  if to_regprocedure('public.can_view_order_unscoped(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.can_view_order_unscoped(uuid)';
  end if;
  if to_regprocedure('public.order_payment_plan_check_lines(uuid, jsonb, uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.order_payment_plan_check_lines(uuid, jsonb, uuid)';
  end if;
  if to_regclass('public.order_dispatch_lots') is null
     or to_regclass('public.order_dispatch_lot_lines') is null
     or to_regclass('public.order_dispatch_lot_events') is null
     or to_regclass('public.order_activity_log') is null
     or to_regclass('public.order_product_codes') is null then
    raise exception 'DEPENDENCY MISSING: Payment plan or Order tables';
  end if;
  if not exists (select 1 from public.permission_modules where module_key = 'orders') then
    raise exception 'DEPENDENCY MISSING: permission module orders';
  end if;
end $dep$;


-- ═══ §1. Permission ═════════════════════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('record_dispatch', 'Record dispatch', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'record_dispatch'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;


-- ═══ §2. Tables ═════════════════════════════════════════════════════════════

create table public.order_dispatch_details (
  lot_id            uuid primary key references public.order_dispatch_lots(id) on delete cascade,
  -- Chosen by the browser before the papers upload: their folder, and what
  -- makes a second press of Save a no-op.
  record_key        uuid not null unique,
  vehicle_number    text check (char_length(vehicle_number) <= 40),
  transporter       text check (char_length(transporter) <= 160),
  lr_number         text check (char_length(lr_number) <= 60),
  driver_phone      text check (char_length(driver_phone) <= 40),
  packages          integer check (packages >= 0),
  deliver_to        text check (char_length(deliver_to) <= 200),
  invoice_number    text check (char_length(invoice_number) <= 60),
  invoice_date      date,
  invoice_taxable   numeric(14,2) check (invoice_taxable >= 0),
  invoice_gst       numeric(14,2) check (invoice_gst >= 0),
  invoice_total     numeric(14,2) check (invoice_total >= 0),
  eway_bill_number  text check (char_length(eway_bill_number) <= 40),
  eway_generated_on date,
  eway_valid_until  date,
  note              text check (char_length(note) <= 1000),
  recorded_by       uuid references public.users(id) on delete set null,
  recorded_at       timestamptz not null default now(),
  updated_by        uuid references public.users(id) on delete set null,
  updated_at        timestamptz
);

create table public.order_dispatch_files (
  id           uuid primary key default gen_random_uuid(),
  lot_id       uuid not null references public.order_dispatch_lots(id) on delete cascade,
  kind         text not null check (kind in ('invoice', 'eway_bill', 'lr', 'packing_list', 'other')),
  storage_path text not null unique,
  file_name    text not null check (char_length(file_name) between 1 and 200),
  mime_type    text check (char_length(mime_type) <= 100),
  size_bytes   bigint check (size_bytes >= 0),
  uploaded_by  uuid references public.users(id) on delete set null,
  uploaded_at  timestamptz not null default now()
);

create index order_dispatch_files_lot_idx on public.order_dispatch_files (lot_id);

alter table public.order_dispatch_details enable row level security;
alter table public.order_dispatch_files enable row level security;

revoke all on public.order_dispatch_details from anon, authenticated;
revoke all on public.order_dispatch_files from anon, authenticated;

comment on table public.order_dispatch_details is
  'Transport, invoice and e-way bill for one dispatched lot. Reached only through order_dispatch_* functions (20270520000000).';
comment on table public.order_dispatch_files is
  'The papers of one dispatched lot, in order-files under orders/{order}/dispatch/{record_key}/ (20270520000000).';

alter table public.order_dispatch_lot_events drop constraint order_dispatch_lot_events_event_check;
alter table public.order_dispatch_lot_events add constraint order_dispatch_lot_events_event_check
  check (event in ('planned', 'dispatched', 'discarded', 'admin_changed', 'admin_deleted',
                   'recorded', 'details_saved', 'papers_removed'));


-- ═══ §3. Internal helpers (no client grant) ═════════════════════════════════

create or replace function public.order_dispatch_assert(p_order_id uuid, p_write boolean)
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
     or not public.can_view_order_unscoped(p_order_id)
     or (p_write and not public.actor_has_module_permission('orders', 'record_dispatch')) then
    raise exception 'ORDER_DISPATCH_FORBIDDEN' using errcode = '42501';
  end if;
  if p_write and exists (select 1 from public.orders o where o.id = p_order_id and o.status = 'cancelled') then
    raise exception 'ORDER_DISPATCH_ORDER_CANCELLED' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.order_dispatch_assert(uuid, boolean) from public, anon, authenticated;

create or replace function public.order_dispatch_text(p_details jsonb, p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(coalesce(p_details ->> p_key, '')), '');
$$;
revoke all on function public.order_dispatch_text(jsonb, text) from public, anon, authenticated;

-- Writes every detail: a blank clears, so the form is the whole truth of the row.
create or replace function public.order_dispatch_details_put(p_lot_id uuid, p_record_key uuid, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if jsonb_typeof(v) <> 'object' then
    raise exception 'ORDER_DISPATCH_DETAILS_INVALID' using errcode = '22023';
  end if;

  insert into public.order_dispatch_details as d (
    lot_id, record_key, vehicle_number, transporter, lr_number, driver_phone, packages, deliver_to,
    invoice_number, invoice_date, invoice_taxable, invoice_gst, invoice_total,
    eway_bill_number, eway_generated_on, eway_valid_until, note, recorded_by
  )
  values (
    p_lot_id, p_record_key,
    upper(public.order_dispatch_text(v, 'vehicle_number')),
    public.order_dispatch_text(v, 'transporter'),
    public.order_dispatch_text(v, 'lr_number'),
    public.order_dispatch_text(v, 'driver_phone'),
    public.order_dispatch_text(v, 'packages')::integer,
    public.order_dispatch_text(v, 'deliver_to'),
    public.order_dispatch_text(v, 'invoice_number'),
    public.order_dispatch_text(v, 'invoice_date')::date,
    public.order_dispatch_text(v, 'invoice_taxable')::numeric,
    public.order_dispatch_text(v, 'invoice_gst')::numeric,
    public.order_dispatch_text(v, 'invoice_total')::numeric,
    public.order_dispatch_text(v, 'eway_bill_number'),
    public.order_dispatch_text(v, 'eway_generated_on')::date,
    public.order_dispatch_text(v, 'eway_valid_until')::date,
    public.order_dispatch_text(v, 'note'),
    auth.uid()
  )
  on conflict (lot_id) do update
    set vehicle_number = excluded.vehicle_number,
        transporter = excluded.transporter,
        lr_number = excluded.lr_number,
        driver_phone = excluded.driver_phone,
        packages = excluded.packages,
        deliver_to = excluded.deliver_to,
        invoice_number = excluded.invoice_number,
        invoice_date = excluded.invoice_date,
        invoice_taxable = excluded.invoice_taxable,
        invoice_gst = excluded.invoice_gst,
        invoice_total = excluded.invoice_total,
        eway_bill_number = excluded.eway_bill_number,
        eway_generated_on = excluded.eway_generated_on,
        eway_valid_until = excluded.eway_valid_until,
        note = excluded.note,
        updated_by = auth.uid(),
        updated_at = now();
end;
$$;
revoke all on function public.order_dispatch_details_put(uuid, uuid, jsonb) from public, anon, authenticated;


-- ═══ §4. Storage: order-files/orders/{order}/dispatch/{record_key}/{uuid}.{ext} ═

create or replace function public.order_dispatch_file_key_parts(p_name text)
returns table (order_id uuid, record_key uuid)
language sql
immutable
set search_path = public, pg_temp
as $$
  select split_part(p_name, '/', 2)::uuid, split_part(p_name, '/', 4)::uuid
  where p_name ~ '^orders/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/dispatch/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp)$';
$$;
revoke all on function public.order_dispatch_file_key_parts(text) from public, anon;
grant execute on function public.order_dispatch_file_key_parts(text) to authenticated;

create or replace function public.can_upload_order_dispatch_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_dispatch_file_key_parts(p_name) k
    join public.orders o on o.id = k.order_id
    where o.status <> 'cancelled'
      and public.can_view_order_unscoped(k.order_id)
      and public.actor_has_module_permission('orders', 'record_dispatch')
  );
$$;
revoke all on function public.can_upload_order_dispatch_file(text) from public, anon;
grant execute on function public.can_upload_order_dispatch_file(text) to authenticated;

create or replace function public.can_read_order_dispatch_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_dispatch_file_key_parts(p_name) k
    where public.can_view_order_unscoped(k.order_id)
  );
$$;
revoke all on function public.can_read_order_dispatch_file(text) from public, anon;
grant execute on function public.can_read_order_dispatch_file(text) to authenticated;

drop policy if exists "order_files_dispatch_insert" on storage.objects;
create policy "order_files_dispatch_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_upload_order_dispatch_file(name)
  );

drop policy if exists "order_files_dispatch_select" on storage.objects;
create policy "order_files_dispatch_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_read_order_dispatch_file(name)
  );
-- NO UPDATE AND NO DELETE POLICY: a paper can be added, never swapped or removed.

create or replace function public.order_dispatch_files_add(
  p_order_id uuid, p_lot_id uuid, p_record_key uuid, p_files jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_el jsonb;
  v_path text;
  v_parts record;
  v_added integer := 0;
begin
  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'ORDER_DISPATCH_FILES_INVALID' using errcode = '22023';
  end if;

  for v_el in select * from jsonb_array_elements(p_files) loop
    v_path := v_el ->> 'path';
    select * into v_parts from public.order_dispatch_file_key_parts(v_path);
    if v_parts.order_id is distinct from p_order_id or v_parts.record_key is distinct from p_record_key then
      raise exception 'ORDER_DISPATCH_FILE_PATH_INVALID: %', coalesce(v_path, '(none)') using errcode = '22023';
    end if;
    insert into public.order_dispatch_files (lot_id, kind, storage_path, file_name, mime_type, size_bytes, uploaded_by)
    values (p_lot_id, v_el ->> 'kind', v_path, btrim(coalesce(v_el ->> 'file_name', '')),
            v_el ->> 'mime_type', (v_el ->> 'size_bytes')::bigint, auth.uid())
    on conflict (storage_path) do nothing;
    if found then v_added := v_added + 1; end if;
  end loop;

  if (select count(*) from public.order_dispatch_files f where f.lot_id = p_lot_id) > 25 then
    raise exception 'ORDER_DISPATCH_TOO_MANY_FILES' using errcode = '22023';
  end if;
  return v_added;
end;
$$;
revoke all on function public.order_dispatch_files_add(uuid, uuid, uuid, jsonb) from public, anon, authenticated;


-- ═══ §5. Read ═══════════════════════════════════════════════════════════════
--
-- One call returns the product lines and every lot with its paperwork. The
-- planned lot comes back too: the record screen starts from it.

create or replace function public.order_dispatch_read(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_items jsonb;
  v_lots jsonb;
begin
  perform public.order_dispatch_assert(p_order_id, false);

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', i.id,
           'item_sequence', coalesce(nullif(btrim(i.item_sequence), ''), i.id::text),
           'product_name', i.product_name,
           'quantity', i.quantity,
           'boe_sequence', c.boe_sequence
         ) order by i.sort_order), '[]'::jsonb)
    into v_items
    from public.order_submission_items i
    left join public.order_product_codes c on c.submission_item_id = i.id and c.order_id = p_order_id
   where i.submission_id = v_order.source_order_submission_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'lot_no', t.lot_no,
           'status', t.status,
           'planned_on', t.planned_on,
           'dispatched_on', t.dispatched_on,
           'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                         'item_sequence', l.item_sequence, 'quantity', l.quantity)
                         order by l.item_sequence), '[]'::jsonb)
                       from public.order_dispatch_lot_lines l where l.lot_id = t.id),
           'details', (select to_jsonb(d) - 'lot_id' from public.order_dispatch_details d where d.lot_id = t.id),
           'recorded_by_name', (select u.full_name
                                  from public.order_dispatch_details d
                                  join public.users u on u.id = d.recorded_by
                                 where d.lot_id = t.id),
           'files', (select coalesce(jsonb_agg(jsonb_build_object(
                         'id', f.id, 'kind', f.kind, 'storage_path', f.storage_path, 'file_name', f.file_name,
                         'mime_type', f.mime_type, 'size_bytes', f.size_bytes)
                         order by f.uploaded_at, f.id), '[]'::jsonb)
                       from public.order_dispatch_files f where f.lot_id = t.id)
         ) order by t.lot_no), '[]'::jsonb)
    into v_lots
    from public.order_dispatch_lots t
   where t.order_id = p_order_id;

  return jsonb_build_object(
    'found', true,
    'can_record', public.actor_has_module_permission('orders', 'record_dispatch') and v_order.status <> 'cancelled',
    'order', jsonb_build_object('id', v_order.id, 'display_number', v_order.display_number, 'status', v_order.status),
    'items', v_items,
    'lots', v_lots
  );
end;
$$;
revoke all on function public.order_dispatch_read(uuid) from public, anon;
grant execute on function public.order_dispatch_read(uuid) to authenticated;


-- ═══ §6. Record a dispatch ══════════════════════════════════════════════════

create or replace function public.order_dispatch_record(
  p_record_key uuid, p_order_id uuid, p_dispatched_on date, p_lines jsonb, p_details jsonb, p_files jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
  v_existing uuid;
  v_lines jsonb;
  v_el jsonb;
  v_pieces numeric;
begin
  perform public.order_dispatch_assert(p_order_id, true);
  -- One writer at a time per Order, so two saves cannot both pass the totals check.
  perform 1 from public.orders where id = p_order_id for update;

  if p_record_key is null then
    raise exception 'ORDER_DISPATCH_KEY_REQUIRED' using errcode = '22023';
  end if;
  select d.lot_id into v_existing
    from public.order_dispatch_details d
    join public.order_dispatch_lots t on t.id = d.lot_id
   where d.record_key = p_record_key and t.order_id = p_order_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if p_dispatched_on is null then
    raise exception 'DISPATCH_DATE_REQUIRED' using errcode = '22023';
  end if;
  if p_dispatched_on > current_date + 1 then
    raise exception 'DISPATCH_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  -- The planned lot is the plan for this very dispatch: left out of the totals check, then taken over.
  select * into v_lot from public.order_dispatch_lots where order_id = p_order_id and status = 'planned';
  v_lines := public.order_payment_plan_check_lines(p_order_id, p_lines, v_lot.id);
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'ORDER_DISPATCH_GOODS_REQUIRED' using errcode = '22023';
  end if;

  if v_lot.id is null then
    insert into public.order_dispatch_lots (order_id, lot_no, status, dispatched_on, created_by)
    values (p_order_id,
            coalesce((select max(t.lot_no) from public.order_dispatch_lots t where t.order_id = p_order_id), 0) + 1,
            'dispatched', p_dispatched_on, auth.uid())
    returning * into v_lot;
  else
    update public.order_dispatch_lots
       set status = 'dispatched', dispatched_on = p_dispatched_on, updated_at = now()
     where id = v_lot.id;
    delete from public.order_dispatch_lot_lines where lot_id = v_lot.id;
  end if;

  for v_el in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_dispatch_lot_lines (lot_id, item_sequence, quantity)
    values (v_lot.id, v_el ->> 'item_sequence', (v_el ->> 'quantity')::numeric);
  end loop;

  perform public.order_dispatch_details_put(v_lot.id, p_record_key, p_details);
  perform public.order_dispatch_files_add(p_order_id, v_lot.id, p_record_key, coalesce(p_files, '[]'::jsonb));

  insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, detail, actor)
  values (p_order_id, v_lot.id, v_lot.lot_no, 'recorded',
          jsonb_build_object('dispatched_on', p_dispatched_on, 'lines', v_lines), auth.uid());

  select sum((e ->> 'quantity')::numeric) into v_pieces from jsonb_array_elements(v_lines) e;
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, auth.uid(), 'order_dispatch_recorded',
          jsonb_build_object('lot_no', v_lot.lot_no, 'pieces', v_pieces, 'dispatched_on', p_dispatched_on,
                             'vehicle_number', upper(public.order_dispatch_text(coalesce(p_details, '{}'::jsonb), 'vehicle_number'))));

  return v_lot.id;
end;
$$;
revoke all on function public.order_dispatch_record(uuid, uuid, date, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.order_dispatch_record(uuid, uuid, date, jsonb, jsonb, jsonb) to authenticated;


-- ═══ §7. Papers or details added afterwards ═════════════════════════════════
--
-- Also the way paperwork reaches a lot that was marked dispatched in the Payment
-- plan: it has no details yet, so the browser's key becomes its record_key.

create or replace function public.order_dispatch_update(
  p_lot_id uuid, p_record_key uuid, p_details jsonb, p_files jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
  v_was public.order_dispatch_details%rowtype;
  v_key uuid;
  v_added integer;
begin
  select * into v_lot from public.order_dispatch_lots where id = p_lot_id;
  if not found or v_lot.status <> 'dispatched' or v_lot.order_id is null then
    raise exception 'DISPATCH_LOT_NOT_FOUND' using errcode = '22023';
  end if;
  perform public.order_dispatch_assert(v_lot.order_id, true);
  perform 1 from public.orders where id = v_lot.order_id for update;

  select * into v_was from public.order_dispatch_details where lot_id = p_lot_id;
  v_key := coalesce(v_was.record_key, p_record_key);
  if v_key is null then
    raise exception 'ORDER_DISPATCH_KEY_REQUIRED' using errcode = '22023';
  end if;

  perform public.order_dispatch_details_put(p_lot_id, v_key, p_details);
  v_added := public.order_dispatch_files_add(v_lot.order_id, p_lot_id, v_key, coalesce(p_files, '[]'::jsonb));

  insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, detail, actor)
  values (v_lot.order_id, p_lot_id, v_lot.lot_no, 'details_saved',
          jsonb_build_object('was', to_jsonb(v_was), 'details', p_details, 'papers_added', v_added), auth.uid());
end;
$$;
revoke all on function public.order_dispatch_update(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.order_dispatch_update(uuid, uuid, jsonb, jsonb) to authenticated;


-- ═══ §8. An administrator deleting the lot keeps a copy in the trail ════════
--
-- order_dispatch_lot_admin_change deletes a lot with a reason, and the paperwork
-- cascades away with it. A whole Order being deleted is not this case: its row
-- is already gone when the cascade reaches here, and the trail goes with it.

create or replace function public.order_dispatch_lots_keep_papers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_details jsonb;
  v_files jsonb;
begin
  if old.order_id is null or not exists (select 1 from public.orders o where o.id = old.order_id) then
    return old;
  end if;
  select to_jsonb(d) into v_details from public.order_dispatch_details d where d.lot_id = old.id;
  select jsonb_agg(to_jsonb(f)) into v_files from public.order_dispatch_files f where f.lot_id = old.id;
  if v_details is not null or v_files is not null then
    insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, detail, actor)
    values (old.order_id, old.id, old.lot_no, 'papers_removed',
            jsonb_build_object('details', v_details, 'files', v_files), auth.uid());
  end if;
  return old;
end;
$$;
revoke all on function public.order_dispatch_lots_keep_papers() from public, anon, authenticated;

create trigger order_dispatch_lots_keep_papers
  before delete on public.order_dispatch_lots
  for each row execute function public.order_dispatch_lots_keep_papers();


-- ═══ §9. Self-assertions (executed) ═════════════════════════════════════════

do $assert$
begin
  if (select count(*) from public.module_permission_actions mpa
        join public.permission_actions pa on pa.id = mpa.action_id
        join public.permission_modules pm on pm.id = mpa.module_id
       where pm.module_key = 'orders' and pa.action_key = 'record_dispatch' and mpa.default_allowed = false) <> 1 then
    raise exception 'ASSERT: record_dispatch must exist, denied by default';
  end if;
  if has_table_privilege('authenticated', 'public.order_dispatch_details', 'select')
     or has_table_privilege('authenticated', 'public.order_dispatch_files', 'select')
     or has_table_privilege('anon', 'public.order_dispatch_files', 'select') then
    raise exception 'ASSERT: dispatch tables must not be readable by client roles';
  end if;
  if has_function_privilege('authenticated', 'public.order_dispatch_assert(uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.order_dispatch_details_put(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.order_dispatch_files_add(uuid, uuid, uuid, jsonb)', 'execute') then
    raise exception 'ASSERT: internal dispatch helpers must not be callable by clients';
  end if;
  if not has_function_privilege('authenticated', 'public.order_dispatch_read(uuid)', 'execute')
     or has_function_privilege('anon', 'public.order_dispatch_read(uuid)', 'execute')
     or has_function_privilege('anon', 'public.order_dispatch_record(uuid, uuid, date, jsonb, jsonb, jsonb)', 'execute') then
    raise exception 'ASSERT: order_dispatch_* must be callable by authenticated only';
  end if;
end $assert$;
