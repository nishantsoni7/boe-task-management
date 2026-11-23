-- Pricing > Training: elements worked out by calculators, what a taught price is, and dated rates.
-- Price Brain v2, phase 1, part 1 (owner approved the plan on 23 Nov 2026 with the default decisions; metal weight as
-- the two calculators the owner uses work it out: galaluminium.in and maiak-m.bg).
--
-- Adds:
--   pricing_training_lines.calc      jsonb: how a row is worked out (a wood cut list, metal profiles, an area of the
--                                    product or a percentage). The row's amount stays the worked-out figure the person
--                                    saw and saved; calc keeps the quantities so a later rate change can re-price it.
--   kind 'metal' (Metal frame) on pricing_training_lines.
--   pricing_training_cases.price_level   cost | selling | mrp | last_negotiable (every existing case: selling)
--   pricing_training_cases.includes      fabric / packing / box_packing / delivery the price already includes
--   pricing_training_cases.per_set       null = the price is per piece; 2 to 50 = the price is for a set of that many
--   pricing_metals (closed)              each metal: density (kg/m³) and rate per kg; list / save / remove like the woods
--   pricing_rate_history (closed)        every wood or metal rate ever set, with who and when; written by triggers,
--                                        seeded with today's wood rates; never updated or deleted by any function
--   pricing_rate_history_list()          Pricing view
-- Re-creates pricing_training_save: the same as 20270724000000, plus the three case fields and calc.
-- pricing_training_get and pricing_training_library already return every column, so they are not touched.
-- Nothing here changes a price anywhere.
--
-- Rollback (take a backup first):
--   re-create pricing_training_save from 20270724000000_pricing_training_submit_counts.sql;
--   drop function public.pricing_rate_history_list(), public.pricing_metals_list(),
--     public.pricing_metal_save(text, numeric, numeric), public.pricing_metal_remove(text);
--   drop trigger pricing_woods_rate_history on public.pricing_woods;
--   drop table public.pricing_rate_history, public.pricing_metals; drop function public.pricing_rate_history_note();
--   alter table public.pricing_training_cases drop column price_level, drop column includes, drop column per_set;
--   update public.pricing_training_lines set kind = 'other' where kind = 'metal';
--   alter table public.pricing_training_lines drop column calc; restore the kind check of 20270723000000.

begin;

-- ── rows and cases ──────────────────────────────────────────────────────────
alter table public.pricing_training_lines drop constraint pricing_training_lines_kind_check;
alter table public.pricing_training_lines add constraint pricing_training_lines_kind_check
  check (kind in ('structure', 'metal', 'material', 'labour', 'overhead', 'margin', 'other'));
alter table public.pricing_training_lines add column calc jsonb
  constraint pricing_training_lines_calc_check check (calc is null or (
    jsonb_typeof(calc) = 'object'
    and calc->>'type' in ('wood', 'metal', 'area', 'percent')
    and octet_length(calc::text) <= 24000
    and (jsonb_typeof(calc->'parts') is distinct from 'array' or jsonb_array_length(calc->'parts') <= 40)));

alter table public.pricing_training_cases
  add column price_level text not null default 'selling'
    constraint pricing_training_cases_price_level_check check (price_level in ('cost', 'selling', 'mrp', 'last_negotiable')),
  add column includes text[] not null default '{}'
    constraint pricing_training_cases_includes_check check (includes <@ array['fabric', 'packing', 'box_packing', 'delivery']::text[]),
  add column per_set smallint
    constraint pricing_training_cases_per_set_check check (per_set is null or per_set between 2 and 50);

-- ── metals ──────────────────────────────────────────────────────────────────
create table public.pricing_metals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  density numeric(8,1) not null default 7850 check (density between 500 and 25000),
  rate numeric(12,2) check (rate is null or (rate > 0 and rate < 10000000)),
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);
create unique index pricing_metals_name_key on public.pricing_metals (lower(btrim(name)));
alter table public.pricing_metals enable row level security;
revoke all on public.pricing_metals from public, anon, authenticated;
-- One rate per kind of profile (owner default D4, 23 Nov 2026); the rates are entered on the Rates page.
insert into public.pricing_metals (name, density) values ('MS tube and pipe', 7850), ('MS bar and flat', 7850), ('MS sheet', 7850);

-- ── rate history ────────────────────────────────────────────────────────────
create table public.pricing_rate_history (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('wood', 'metal')),
  name text not null,
  rate numeric(12,2) not null,
  set_by uuid references public.users(id),
  set_at timestamptz not null default now()
);
create index pricing_rate_history_at_idx on public.pricing_rate_history (set_at desc);
alter table public.pricing_rate_history enable row level security;
revoke all on public.pricing_rate_history from public, anon, authenticated;
insert into public.pricing_rate_history (kind, name, rate, set_by, set_at)
  select 'wood', w.name, w.rate, w.updated_by, w.updated_at from public.pricing_woods w where w.rate is not null;

-- A rate written to the wood or metal list is also written here, whenever it is new or different.
create or replace function public.pricing_rate_history_note()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.rate is null or (tg_op = 'UPDATE' and new.rate is not distinct from old.rate) then
    return null;
  end if;
  insert into public.pricing_rate_history (kind, name, rate, set_by) values (tg_argv[0], new.name, new.rate, new.updated_by);
  return null;
end $$;
revoke all on function public.pricing_rate_history_note() from public, anon, authenticated;
create trigger pricing_woods_rate_history after insert or update of rate on public.pricing_woods
  for each row execute function public.pricing_rate_history_note('wood');
create trigger pricing_metals_rate_history after insert or update of rate on public.pricing_metals
  for each row execute function public.pricing_rate_history_note('metal');

create or replace function public.pricing_metals_list()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', m.name, 'density', m.density, 'rate', m.rate, 'updated_at', m.updated_at,
             'updated_by_name', (select u.full_name from public.users u where u.id = m.updated_by)) order by lower(m.name))
    from public.pricing_metals m), '[]'::jsonb);
end $$;
revoke all on function public.pricing_metals_list() from public, anon;
grant execute on function public.pricing_metals_list() to authenticated;

-- Add a metal, or change its density or rate. A null leaves that value as it is (a new metal gets mild steel's density).
create or replace function public.pricing_metal_save(p_name text, p_density numeric, p_rate numeric)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_name text := btrim(coalesce(p_name, ''));
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_METALS_FORBIDDEN: you may not change the metal list' using errcode = '42501';
  end if;
  begin
    insert into public.pricing_metals (name, density, rate, updated_by) values (v_name, coalesce(p_density, 7850), p_rate, a.p_uid)
    on conflict (lower(btrim(name))) do update
      set density = coalesce(p_density, public.pricing_metals.density), rate = coalesce(p_rate, public.pricing_metals.rate),
          updated_by = a.p_uid, updated_at = now()
      where p_density is not null or p_rate is not null;
  exception when check_violation or numeric_value_out_of_range then
    raise exception 'PRICING_METALS_INVALID: give a name of 2 to 60 letters, a density between 500 and 25,000 kg/m³ and a rate above zero' using errcode = '22023';
  end;
end $$;
revoke all on function public.pricing_metal_save(text, numeric, numeric) from public, anon;
grant execute on function public.pricing_metal_save(text, numeric, numeric) to authenticated;

create or replace function public.pricing_metal_remove(p_name text)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_METALS_FORBIDDEN: you may not change the metal list' using errcode = '42501';
  end if;
  delete from public.pricing_metals where lower(btrim(name)) = lower(btrim(coalesce(p_name, '')));
end $$;
revoke all on function public.pricing_metal_remove(text) from public, anon;
grant execute on function public.pricing_metal_remove(text) to authenticated;

create or replace function public.pricing_rate_history_list()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return coalesce((
    select jsonb_agg(x order by x.set_at desc, x.id desc) from (
      select h.id, h.kind, h.name, h.rate, h.set_at, (select u.full_name from public.users u where u.id = h.set_by) as set_by_name
      from public.pricing_rate_history h order by h.set_at desc, h.id desc limit 300) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_rate_history_list() from public, anon;
grant execute on function public.pricing_rate_history_list() to authenticated;

-- ── save: the same as 20270724000000, plus price_level, includes, per_set and calc ──
create or replace function public.pricing_training_save(p_id uuid, p_doc jsonb)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_id uuid := p_id; l jsonb; n int := 0; v_level text; v_includes text[]; v_set smallint;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_TRAINING_FORBIDDEN: you may not teach cases' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_doc->'lines', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_doc->'lines', '[]'::jsonb)) > 60 then
    raise exception 'PRICING_TRAINING_INVALID: at most 60 elements' using errcode = '22023';
  end if;
  begin
    v_level := coalesce(nullif(p_doc->>'price_level', ''), 'selling');
    v_includes := coalesce((select array_agg(distinct x order by x) from jsonb_array_elements_text(
                    case when jsonb_typeof(p_doc->'includes') = 'array' then p_doc->'includes' else '[]'::jsonb end) x), '{}');
    v_set := nullif(p_doc->>'per_set', '')::smallint;
    if v_id is null then
      insert into public.pricing_training_cases (created_by, updated_by, name, variant, width_in, depth_in, height_in, image_path, ai_reading, sold_price, notes, price_level, includes, per_set)
      values (a.p_uid, a.p_uid, btrim(coalesce(p_doc->>'name', '')), nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
              nullif(p_doc->>'width_in', '')::numeric, nullif(p_doc->>'depth_in', '')::numeric, nullif(p_doc->>'height_in', '')::numeric,
              nullif(p_doc->>'image_path', ''), case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
              nullif(p_doc->>'sold_price', '')::numeric, nullif(btrim(coalesce(p_doc->>'notes', '')), ''), v_level, v_includes, v_set)
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
        price_level = v_level, includes = v_includes, per_set = v_set,
        status = 'draft', updated_at = now(), updated_by = a.p_uid
      where id = v_id;
      delete from public.pricing_training_lines where case_id = v_id;
    end if;
    for l in select * from jsonb_array_elements(coalesce(p_doc->'lines', '[]'::jsonb)) loop
      n := n + 1;
      insert into public.pricing_training_lines (case_id, position, element, kind, material, quantity, unit, rate, amount, reasoning, from_ai, wood_amount, calc)
      values (v_id, n, btrim(coalesce(l->>'element', '')), coalesce(nullif(l->>'kind', ''), 'material'),
              nullif(btrim(coalesce(l->>'material', '')), ''), nullif(l->>'quantity', '')::numeric, nullif(btrim(coalesce(l->>'unit', '')), ''),
              nullif(l->>'rate', '')::numeric, coalesce(nullif(l->>'amount', '')::numeric, 0),
              nullif(btrim(coalesce(l->>'reasoning', '')), ''), coalesce((l->>'from_ai')::boolean, false), nullif(l->>'wood_amount', '')::numeric,
              case when jsonb_typeof(l->'calc') = 'object' then l->'calc' end);
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

do $$
begin
  if has_table_privilege('authenticated', 'public.pricing_metals', 'select') or has_table_privilege('anon', 'public.pricing_metals', 'select')
     or has_table_privilege('authenticated', 'public.pricing_rate_history', 'select') or has_table_privilege('anon', 'public.pricing_rate_history', 'select') then
    raise exception 'pricing_metals / pricing_rate_history: the tables must be closed';
  end if;
  if has_function_privilege('anon', 'public.pricing_metals_list()', 'execute')
     or has_function_privilege('anon', 'public.pricing_metal_save(text, numeric, numeric)', 'execute')
     or has_function_privilege('anon', 'public.pricing_metal_remove(text)', 'execute')
     or has_function_privilege('anon', 'public.pricing_rate_history_list()', 'execute')
     or has_function_privilege('anon', 'public.pricing_training_save(uuid, jsonb)', 'execute') then
    raise exception 'pricing calculators: no function may be open to anon';
  end if;
  if (select count(*) from public.pricing_rate_history where kind = 'wood') <> (select count(*) from public.pricing_woods where rate is not null) then
    raise exception 'pricing_rate_history: every wood rate of today must be its first entry';
  end if;
  if exists (select 1 from public.pricing_training_cases where price_level <> 'selling' or per_set is not null or includes <> '{}') then
    raise exception 'pricing_training_cases: every existing case must read as a selling price per piece';
  end if;
end $$;

commit;
