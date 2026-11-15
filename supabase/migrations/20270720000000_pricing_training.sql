-- Pricing > Training (owner request 2026-11-15): the manual side of the price system.
-- A person uploads a photo of a product, the app reads what it can see, the person lists every element of the
-- price (material, labour, overhead, margin, anything else) with a quantity, a rate, an amount and how they worked
-- it out, then sends the case to be checked: a person holding `approve` (Admin, or granted per person, such as
-- Nitish) approves it, sends it back with a note, or rejects it.
-- Nothing here changes a price anywhere: approved cases are the record the automatic price logic will be built from.
--
-- Adds: actions `create` (teach a case) and `approve` (check a case) on module `pricing`, both off by default;
-- three closed tables (RLS on, no policy, no grant); SECURITY DEFINER functions for every read and write;
-- a public bucket `pricing-training` for the photos (paths '{uploader}/{uuid}.jpg', JPEG, 4 MB).
-- Anyone holding `approve` may check any submitted case, their own included (owner, 2026-11-15: either the owner
-- or Nitish approves, so a case the owner teaches does not wait for Nitish).
--
-- Rollback: drop the functions pricing_training_*, drop policy pricing_training_images_insert / _delete on
-- storage.objects, delete the bucket's objects and the bucket, drop tables pricing_training_messages,
-- pricing_training_lines, pricing_training_cases; delete from employee_permission_overrides, role_permissions and
-- module_permission_actions where the module is 'pricing' and the action is 'create' or 'approve'.

begin;

-- ───────────────────────── permissions ─────────────────────────
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('create', 'approve')
where pm.module_key = 'pricing'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
join public.permission_actions pa on pa.id = mpa.action_id
where pm.module_key = 'pricing' and pa.action_key in ('create', 'approve')
on conflict (role, module_id, action_id) do nothing;

-- ───────────────────────── tables ─────────────────────────
create table public.pricing_training_cases (
  id uuid primary key default gen_random_uuid(),
  case_no bigint generated always as identity,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'sent_back', 'approved', 'rejected')),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  family text not null default 'wooden_chair' check (char_length(family) between 1 and 60),
  variant text check (variant is null or char_length(variant) <= 120),
  width_in numeric(7,2) check (width_in is null or (width_in > 0 and width_in < 1000)),
  depth_in numeric(7,2) check (depth_in is null or (depth_in > 0 and depth_in < 1000)),
  height_in numeric(7,2) check (height_in is null or (height_in > 0 and height_in < 1000)),
  image_path text check (image_path is null or char_length(image_path) <= 200),
  ai_reading jsonb,
  sold_price numeric(12,2) check (sold_price is null or (sold_price >= 0 and sold_price < 100000000)),
  notes text check (notes is null or char_length(notes) <= 2000),
  submitted_at timestamptz,
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000)
);
create index pricing_training_cases_status_idx on public.pricing_training_cases (status, updated_at desc);

create table public.pricing_training_lines (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.pricing_training_cases(id) on delete cascade,
  position int not null check (position between 1 and 60),
  element text not null check (char_length(btrim(element)) between 1 and 120),
  kind text not null default 'material' check (kind in ('material', 'labour', 'overhead', 'margin', 'other')),
  material text check (material is null or char_length(material) <= 160),
  quantity numeric(12,3) check (quantity is null or (quantity >= 0 and quantity < 1000000)),
  unit text check (unit is null or char_length(unit) <= 30),
  rate numeric(12,2) check (rate is null or (rate >= 0 and rate < 100000000)),
  amount numeric(12,2) not null check (amount >= 0 and amount < 100000000),
  reasoning text check (reasoning is null or char_length(reasoning) <= 1000),
  from_ai boolean not null default false,
  unique (case_id, position)
);

create table public.pricing_training_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.pricing_training_cases(id) on delete cascade,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  body text not null check (char_length(btrim(body)) between 1 and 2000)
);
create index pricing_training_messages_case_idx on public.pricing_training_messages (case_id, created_at);

alter table public.pricing_training_cases enable row level security;
alter table public.pricing_training_lines enable row level security;
alter table public.pricing_training_messages enable row level security;
revoke all on public.pricing_training_cases, public.pricing_training_lines, public.pricing_training_messages
  from public, anon, authenticated;

-- ───────────────────────── who is asking ─────────────────────────
create or replace function public.pricing_training_actor(
  out p_uid uuid, out p_admin boolean, out p_create boolean, out p_approve boolean)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  p_uid := auth.uid();
  if p_uid is not null then
    select (u.role = 'admin') into p_admin from public.users u
    where u.id = p_uid and u.is_active and not coalesce(u.is_deleted, false);
  end if;
  if p_uid is null or p_admin is null or not public.module_entry_open('pricing')
     or not (p_admin or public.resolve_permission(p_uid, 'pricing', 'view')) then
    raise exception 'PRICING_TRAINING_FORBIDDEN: Pricing is not open to you' using errcode = '42501';
  end if;
  p_create := p_admin or public.resolve_permission(p_uid, 'pricing', 'create');
  p_approve := p_admin or public.resolve_permission(p_uid, 'pricing', 'approve');
end $$;
revoke all on function public.pricing_training_actor() from public, anon, authenticated;

create or replace function public.pricing_training_access()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return jsonb_build_object('uid', a.p_uid, 'admin', a.p_admin, 'create', a.p_create, 'approve', a.p_approve);
end $$;
revoke all on function public.pricing_training_access() from public, anon;
grant execute on function public.pricing_training_access() to authenticated;

-- ───────────────────────── reads ─────────────────────────
-- Everyone who may open Pricing sees every case: it is a small team teaching one shared logic.
create or replace function public.pricing_training_list()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return coalesce((
    select jsonb_agg(x order by x.updated_at desc) from (
      select c.id, c.case_no, c.name, c.variant, c.status, c.image_path, c.created_by, c.created_at, c.updated_at,
             c.width_in, c.depth_in, c.height_in, c.sold_price,
             (select u.full_name from public.users u where u.id = c.created_by) as created_by_name,
             (select u.full_name from public.users u where u.id = c.decided_by) as decided_by_name,
             coalesce((select sum(l.amount) from public.pricing_training_lines l where l.case_id = c.id), 0) as total,
             (select count(*) from public.pricing_training_lines l where l.case_id = c.id) as line_count
      from public.pricing_training_cases c
      order by c.updated_at desc
      limit 500
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_training_list() from public, anon;
grant execute on function public.pricing_training_list() to authenticated;

create or replace function public.pricing_training_get(p_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record; c public.pricing_training_cases;
begin
  select * into a from public.pricing_training_actor();
  select * into c from public.pricing_training_cases where id = p_id;
  if not found then
    raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
  end if;
  return to_jsonb(c) || jsonb_build_object(
    'created_by_name', (select u.full_name from public.users u where u.id = c.created_by),
    'decided_by_name', (select u.full_name from public.users u where u.id = c.decided_by),
    'may_edit', (a.p_create and c.created_by = a.p_uid and c.status in ('draft', 'sent_back')),
    'may_decide', (a.p_approve and c.status = 'submitted'),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'case_id' order by l.position)
                       from public.pricing_training_lines l where l.case_id = c.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
                            'created_by', m.created_by,
                            'created_by_name', (select u.full_name from public.users u where u.id = m.created_by))
                          order by m.created_at)
                          from public.pricing_training_messages m where m.case_id = c.id), '[]'::jsonb));
end $$;
revoke all on function public.pricing_training_get(uuid) from public, anon;
grant execute on function public.pricing_training_get(uuid) to authenticated;

-- ───────────────────────── writes ─────────────────────────
-- Create (p_id null) or replace the maker's own draft / sent-back case. The whole document is sent; lines are replaced.
create or replace function public.pricing_training_save(p_id uuid, p_doc jsonb)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_id uuid := p_id; v_status text; v_owner uuid; l jsonb; n int := 0;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_TRAINING_FORBIDDEN: you may not teach cases' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_doc->'lines', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_doc->'lines', '[]'::jsonb)) > 60 then
    raise exception 'PRICING_TRAINING_INVALID: at most 60 elements' using errcode = '22023';
  end if;
  begin
    if v_id is null then
      insert into public.pricing_training_cases (created_by, name, variant, width_in, depth_in, height_in, image_path, ai_reading, sold_price, notes)
      values (a.p_uid, btrim(coalesce(p_doc->>'name', '')), nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
              nullif(p_doc->>'width_in', '')::numeric, nullif(p_doc->>'depth_in', '')::numeric, nullif(p_doc->>'height_in', '')::numeric,
              nullif(p_doc->>'image_path', ''), case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
              nullif(p_doc->>'sold_price', '')::numeric, nullif(btrim(coalesce(p_doc->>'notes', '')), ''))
      returning id into v_id;
    else
      select status, created_by into v_status, v_owner from public.pricing_training_cases where id = v_id for update;
      if not found then
        raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
      end if;
      if v_owner <> a.p_uid or v_status not in ('draft', 'sent_back') then
        raise exception 'PRICING_TRAINING_LOCKED: only its maker can change a case, and only before it is sent or after it is sent back' using errcode = '42501';
      end if;
      update public.pricing_training_cases set
        name = btrim(coalesce(p_doc->>'name', '')), variant = nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
        width_in = nullif(p_doc->>'width_in', '')::numeric, depth_in = nullif(p_doc->>'depth_in', '')::numeric, height_in = nullif(p_doc->>'height_in', '')::numeric,
        image_path = nullif(p_doc->>'image_path', ''),
        ai_reading = case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
        sold_price = nullif(p_doc->>'sold_price', '')::numeric, notes = nullif(btrim(coalesce(p_doc->>'notes', '')), ''),
        updated_at = now()
      where id = v_id;
      delete from public.pricing_training_lines where case_id = v_id;
    end if;
    for l in select * from jsonb_array_elements(coalesce(p_doc->'lines', '[]'::jsonb)) loop
      n := n + 1;
      insert into public.pricing_training_lines (case_id, position, element, kind, material, quantity, unit, rate, amount, reasoning, from_ai)
      values (v_id, n, btrim(coalesce(l->>'element', '')), coalesce(nullif(l->>'kind', ''), 'material'),
              nullif(btrim(coalesce(l->>'material', '')), ''), nullif(l->>'quantity', '')::numeric, nullif(btrim(coalesce(l->>'unit', '')), ''),
              nullif(l->>'rate', '')::numeric, coalesce(nullif(l->>'amount', '')::numeric, 0),
              nullif(btrim(coalesce(l->>'reasoning', '')), ''), coalesce((l->>'from_ai')::boolean, false));
    end loop;
  exception when check_violation or numeric_value_out_of_range or string_data_right_truncation or invalid_text_representation or not_null_violation then
    raise exception 'PRICING_TRAINING_INVALID: check the case (%)', sqlerrm using errcode = '22023';
  end;
  return v_id;
end $$;
revoke all on function public.pricing_training_save(uuid, jsonb) from public, anon;
grant execute on function public.pricing_training_save(uuid, jsonb) to authenticated;

-- The maker sends a draft or sent-back case for checking. It needs at least one element.
create or replace function public.pricing_training_submit(p_id uuid)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_status text; v_owner uuid;
begin
  select * into a from public.pricing_training_actor();
  select status, created_by into v_status, v_owner from public.pricing_training_cases where id = p_id for update;
  if not found then
    raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
  end if;
  if not a.p_create or v_owner <> a.p_uid or v_status not in ('draft', 'sent_back') then
    raise exception 'PRICING_TRAINING_LOCKED: only its maker can send a case, and only once' using errcode = '42501';
  end if;
  if not exists (select 1 from public.pricing_training_lines where case_id = p_id) then
    raise exception 'PRICING_TRAINING_INVALID: add at least one element before sending' using errcode = '22023';
  end if;
  update public.pricing_training_cases
  set status = 'submitted', submitted_at = now(), updated_at = now(), decided_by = null, decided_at = null
  where id = p_id;
end $$;
revoke all on function public.pricing_training_submit(uuid) from public, anon;
grant execute on function public.pricing_training_submit(uuid) to authenticated;

-- The checker's decision, by anyone holding `approve`, their own case included. Sending back or rejecting needs a note.
create or replace function public.pricing_training_decide(p_id uuid, p_decision text, p_note text)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_status text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into a from public.pricing_training_actor();
  if p_decision not in ('approved', 'sent_back', 'rejected') then
    raise exception 'PRICING_TRAINING_INVALID: unknown decision' using errcode = '22023';
  end if;
  select status into v_status from public.pricing_training_cases where id = p_id for update;
  if not found then
    raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
  end if;
  if not a.p_approve then
    raise exception 'PRICING_TRAINING_FORBIDDEN: you may not check cases' using errcode = '42501';
  end if;
  if v_status <> 'submitted' then
    raise exception 'PRICING_TRAINING_LOCKED: this case is not waiting for a check' using errcode = '42501';
  end if;
  if p_decision <> 'approved' and v_note is null then
    raise exception 'PRICING_TRAINING_INVALID: say what should change' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then
    raise exception 'PRICING_TRAINING_INVALID: the note is too long' using errcode = '22023';
  end if;
  update public.pricing_training_cases
  set status = p_decision, decided_by = a.p_uid, decided_at = now(), decision_note = v_note, updated_at = now()
  where id = p_id;
end $$;
revoke all on function public.pricing_training_decide(uuid, text, text) from public, anon;
grant execute on function public.pricing_training_decide(uuid, text, text) to authenticated;

-- A question or an answer on a case, from anyone who may teach or check.
create or replace function public.pricing_training_message(p_id uuid, p_body text)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_id uuid;
begin
  select * into a from public.pricing_training_actor();
  if not (a.p_create or a.p_approve) then
    raise exception 'PRICING_TRAINING_FORBIDDEN: you may not write on cases' using errcode = '42501';
  end if;
  if not exists (select 1 from public.pricing_training_cases where id = p_id) then
    raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'PRICING_TRAINING_INVALID: write a message of up to 2,000 characters' using errcode = '22023';
  end if;
  insert into public.pricing_training_messages (case_id, created_by, body) values (p_id, a.p_uid, btrim(p_body)) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.pricing_training_message(uuid, text) from public, anon;
grant execute on function public.pricing_training_message(uuid, text) to authenticated;

-- ───────────────────────── photos ─────────────────────────
create or replace function public.pricing_training_can_upload(p_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); a record;
begin
  if v_uid is null
     or p_name !~ ('^' || v_uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') then
    return false;
  end if;
  select * into a from public.pricing_training_actor();
  return a.p_create;
exception when sqlstate '42501' then
  return false;
end $$;
revoke all on function public.pricing_training_can_upload(text) from public, anon;
grant execute on function public.pricing_training_can_upload(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pricing-training', 'pricing-training', true, 4194304, array['image/jpeg'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pricing_training_images_insert on storage.objects;
create policy pricing_training_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'pricing-training' and public.pricing_training_can_upload(name));
drop policy if exists pricing_training_images_delete on storage.objects;
create policy pricing_training_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'pricing-training' and owner_id = auth.uid()::text
    and not exists (select 1 from public.pricing_training_cases c where c.image_path = name));

-- ───────────────────────── self-check ─────────────────────────
do $$
declare t text; f text;
begin
  if (select count(*) from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'pricing' and rp.role = 'admin' and rp.allowed) <> 3 then
    raise exception 'pricing_training: Admin must hold view, create and approve on pricing';
  end if;
  if exists (select 1 from public.module_permission_actions mpa
             join public.permission_modules pm on pm.id = mpa.module_id
             where pm.module_key = 'pricing' and mpa.default_allowed) then
    raise exception 'pricing_training: no pricing action may be on by default';
  end if;
  foreach t in array array['pricing_training_cases', 'pricing_training_lines', 'pricing_training_messages'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception 'pricing_training: table % must be closed', t;
    end if;
  end loop;
  foreach f in array array['pricing_training_access()', 'pricing_training_list()', 'pricing_training_get(uuid)',
      'pricing_training_save(uuid, jsonb)', 'pricing_training_submit(uuid)', 'pricing_training_decide(uuid, text, text)',
      'pricing_training_message(uuid, text)', 'pricing_training_can_upload(text)', 'pricing_training_actor()'] loop
    if has_function_privilege('anon', 'public.' || f, 'execute') then
      raise exception 'pricing_training: function % must not be open to anon', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.pricing_training_actor()', 'execute') then
    raise exception 'pricing_training: pricing_training_actor is internal';
  end if;
end $$;

commit;
