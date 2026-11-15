-- Pricing > Training: submitting is what counts, and a case can always be edited (owner, 2026-11-15, after the
-- first real case). The owner chose "Submit is enough" and "You and Nitish may edit any case at any time".
--
-- Before: draft -> submitted -> approved / sent_back / rejected, only the maker edits, and only before sending.
-- Now:    draft <-> submitted. Anyone holding Create on Pricing may edit ANY case at ANY time. Saving a change to
--         a submitted case puts it back to "saved, not resubmitted" until someone submits it again. Each save and
--         each submission is written to a history with who and when.
--
-- Changes: pricing_training_cases gains submit_count, submitted_by, updated_by; statuses are only draft and
-- submitted (approved becomes submitted; sent_back and rejected become draft); new closed table
-- pricing_training_events; pricing_training_save / _submit / _get / _list / _access re-created;
-- pricing_training_decide dropped; the action `approve` is removed from module `pricing` (nothing checks it now).
-- The columns decided_by / decided_at / decision_note stay, unused, so no past decision is lost.
--
-- Rollback: re-create the functions from 20270720000000 and 20270723000000, restore the five-status check,
-- drop table pricing_training_events and the three new columns, and re-add the approve action as in 20270720000000.

begin;

-- ───────────────────────── columns, statuses, history ─────────────────────────
alter table public.pricing_training_cases
  add column submit_count int not null default 0 check (submit_count >= 0),
  add column submitted_by uuid references public.users(id),
  add column updated_by uuid references public.users(id);

update public.pricing_training_cases
set submit_count = case when submitted_at is not null then 1 else 0 end,
    submitted_by = case when submitted_at is not null then created_by end,
    updated_by = created_by,
    status = case when status in ('submitted', 'approved') then 'submitted' else 'draft' end;

alter table public.pricing_training_cases drop constraint pricing_training_cases_status_check;
alter table public.pricing_training_cases add constraint pricing_training_cases_status_check
  check (status in ('draft', 'submitted'));

create table public.pricing_training_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.pricing_training_cases(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.users(id),
  what text not null check (what in ('saved', 'submitted')),
  total numeric(12,2) not null default 0
);
create index pricing_training_events_case_idx on public.pricing_training_events (case_id, created_at desc);
alter table public.pricing_training_events enable row level security;
revoke all on public.pricing_training_events from public, anon, authenticated;

-- ───────────────────────── the approve action goes ─────────────────────────
drop function public.pricing_training_decide(uuid, text, text);

delete from public.employee_permission_overrides o
using public.permission_modules pm, public.permission_actions pa
where o.module_id = pm.id and o.action_id = pa.id and pm.module_key = 'pricing' and pa.action_key = 'approve';
delete from public.role_permissions rp
using public.permission_modules pm, public.permission_actions pa
where rp.module_id = pm.id and rp.action_id = pa.id and pm.module_key = 'pricing' and pa.action_key = 'approve';
delete from public.module_permission_actions mpa
using public.permission_modules pm, public.permission_actions pa
where mpa.module_id = pm.id and mpa.action_id = pa.id and pm.module_key = 'pricing' and pa.action_key = 'approve';

create or replace function public.pricing_training_access()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return jsonb_build_object('uid', a.p_uid, 'admin', a.p_admin, 'create', a.p_create);
end $$;
revoke all on function public.pricing_training_access() from public, anon;
grant execute on function public.pricing_training_access() to authenticated;

-- ───────────────────────── reads ─────────────────────────
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
             c.width_in, c.depth_in, c.height_in, c.sold_price, c.submit_count, c.submitted_at,
             (select u.full_name from public.users u where u.id = c.created_by) as created_by_name,
             (select u.full_name from public.users u where u.id = c.submitted_by) as submitted_by_name,
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
    'submitted_by_name', (select u.full_name from public.users u where u.id = c.submitted_by),
    'updated_by_name', (select u.full_name from public.users u where u.id = c.updated_by),
    'may_edit', a.p_create,
    'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'case_id' order by l.position)
                       from public.pricing_training_lines l where l.case_id = c.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
                            'created_by', m.created_by,
                            'created_by_name', (select u.full_name from public.users u where u.id = m.created_by))
                          order by m.created_at)
                          from public.pricing_training_messages m where m.case_id = c.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.created_at desc) from (
                          select ev.what, ev.created_at, ev.created_by, ev.total,
                                 (select u.full_name from public.users u where u.id = ev.created_by) as created_by_name
                          from public.pricing_training_events ev where ev.case_id = c.id
                          order by ev.created_at desc limit 30) e), '[]'::jsonb));
end $$;
revoke all on function public.pricing_training_get(uuid) from public, anon;
grant execute on function public.pricing_training_get(uuid) to authenticated;

-- ───────────────────────── writes ─────────────────────────
-- Create (p_id null) or replace ANY case. The whole document is sent; lines are replaced. A saved change always
-- leaves the case "saved, not submitted", whatever it was, so the estimator never reads a half-changed price.
create or replace function public.pricing_training_save(p_id uuid, p_doc jsonb)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_id uuid := p_id; l jsonb; n int := 0;
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
      insert into public.pricing_training_cases (created_by, updated_by, name, variant, width_in, depth_in, height_in, image_path, ai_reading, sold_price, notes)
      values (a.p_uid, a.p_uid, btrim(coalesce(p_doc->>'name', '')), nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
              nullif(p_doc->>'width_in', '')::numeric, nullif(p_doc->>'depth_in', '')::numeric, nullif(p_doc->>'height_in', '')::numeric,
              nullif(p_doc->>'image_path', ''), case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
              nullif(p_doc->>'sold_price', '')::numeric, nullif(btrim(coalesce(p_doc->>'notes', '')), ''))
      returning id into v_id;
    else
      perform 1 from public.pricing_training_cases where id = v_id for update;
      if not found then
        raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
      end if;
      update public.pricing_training_cases set
        name = btrim(coalesce(p_doc->>'name', '')), variant = nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
        width_in = nullif(p_doc->>'width_in', '')::numeric, depth_in = nullif(p_doc->>'depth_in', '')::numeric, height_in = nullif(p_doc->>'height_in', '')::numeric,
        image_path = nullif(p_doc->>'image_path', ''),
        ai_reading = case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
        sold_price = nullif(p_doc->>'sold_price', '')::numeric, notes = nullif(btrim(coalesce(p_doc->>'notes', '')), ''),
        status = 'draft', updated_at = now(), updated_by = a.p_uid
      where id = v_id;
      delete from public.pricing_training_lines where case_id = v_id;
    end if;
    for l in select * from jsonb_array_elements(coalesce(p_doc->'lines', '[]'::jsonb)) loop
      n := n + 1;
      insert into public.pricing_training_lines (case_id, position, element, kind, material, quantity, unit, rate, amount, reasoning, from_ai, wood_amount)
      values (v_id, n, btrim(coalesce(l->>'element', '')), coalesce(nullif(l->>'kind', ''), 'material'),
              nullif(btrim(coalesce(l->>'material', '')), ''), nullif(l->>'quantity', '')::numeric, nullif(btrim(coalesce(l->>'unit', '')), ''),
              nullif(l->>'rate', '')::numeric, coalesce(nullif(l->>'amount', '')::numeric, 0),
              nullif(btrim(coalesce(l->>'reasoning', '')), ''), coalesce((l->>'from_ai')::boolean, false), nullif(l->>'wood_amount', '')::numeric);
    end loop;
  exception when check_violation or numeric_value_out_of_range or string_data_right_truncation or invalid_text_representation or not_null_violation then
    raise exception 'PRICING_TRAINING_INVALID: check the case (%)', sqlerrm using errcode = '22023';
  end;
  insert into public.pricing_training_events (case_id, created_by, what, total)
  values (v_id, a.p_uid, 'saved', coalesce((select sum(amount) from public.pricing_training_lines where case_id = v_id), 0));
  return v_id;
end $$;
revoke all on function public.pricing_training_save(uuid, jsonb) from public, anon;
grant execute on function public.pricing_training_save(uuid, jsonb) to authenticated;

-- Submit, or resubmit after a change. This is what makes a case count. It needs at least one element.
create or replace function public.pricing_training_submit(p_id uuid)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_status text;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_TRAINING_FORBIDDEN: you may not submit cases' using errcode = '42501';
  end if;
  select status into v_status from public.pricing_training_cases where id = p_id for update;
  if not found then
    raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
  end if;
  if v_status = 'submitted' then
    raise exception 'PRICING_TRAINING_LOCKED: nothing has changed since this case was submitted' using errcode = '42501';
  end if;
  if not exists (select 1 from public.pricing_training_lines where case_id = p_id) then
    raise exception 'PRICING_TRAINING_INVALID: add at least one element before submitting' using errcode = '22023';
  end if;
  update public.pricing_training_cases
  set status = 'submitted', submitted_at = now(), submitted_by = a.p_uid, submit_count = submit_count + 1, updated_at = now()
  where id = p_id;
  insert into public.pricing_training_events (case_id, created_by, what, total)
  values (p_id, a.p_uid, 'submitted', coalesce((select sum(amount) from public.pricing_training_lines where case_id = p_id), 0));
end $$;
revoke all on function public.pricing_training_submit(uuid) from public, anon;
grant execute on function public.pricing_training_submit(uuid) to authenticated;

-- Questions and answers: anyone who may teach.
create or replace function public.pricing_training_message(p_id uuid, p_body text)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_id uuid;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
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

-- ───────────────────────── self-check ─────────────────────────
do $$
begin
  if exists (select 1 from public.pricing_training_cases where status not in ('draft', 'submitted')) then
    raise exception 'pricing_training_submit_counts: an old status is left';
  end if;
  if exists (select 1 from public.module_permission_actions mpa
             join public.permission_modules pm on pm.id = mpa.module_id
             join public.permission_actions pa on pa.id = mpa.action_id
             where pm.module_key = 'pricing' and pa.action_key = 'approve') then
    raise exception 'pricing_training_submit_counts: approve is still registered on pricing';
  end if;
  if (select count(*) from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'pricing' and rp.role = 'admin' and rp.allowed) <> 2 then
    raise exception 'pricing_training_submit_counts: Admin must hold view and create on pricing';
  end if;
  if has_table_privilege('authenticated', 'public.pricing_training_events', 'select') or has_table_privilege('anon', 'public.pricing_training_events', 'select') then
    raise exception 'pricing_training_submit_counts: the history table must be closed';
  end if;
  if has_function_privilege('anon', 'public.pricing_training_save(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.pricing_training_submit(uuid)', 'execute')
     or has_function_privilege('anon', 'public.pricing_training_get(uuid)', 'execute') then
    raise exception 'pricing_training_submit_counts: no function may be open to anon';
  end if;
end $$;

commit;
