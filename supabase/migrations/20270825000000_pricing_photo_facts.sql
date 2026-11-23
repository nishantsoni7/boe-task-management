-- Pricing: photo facts (Price Brain v2, phase 3B; owner approved 23 Nov 2026, answer P2: read the existing product photos
-- once, and each new one when it first appears). Every product photo BOE One holds is read ONCE into facts from a fixed
-- list (kind of product, arms, back, seat, base, top, visible metal, carving), which phase 3C's engine will use to tell
-- one "Chair" from another. Anyone who may teach in Pricing can correct a reading; a correction is kept as corrected.
-- Nothing here sets or changes a price.
--
-- A photo is named by where it is stored: "<bucket>/<path>", from three places:
--   quotation-images/<path>   quotation_lines.image_path           (public bucket)
--   order-files/<path>        order_submission_items.image_storage_path of approved PIs (private bucket)
--   pricing-training/<path>   pricing_training_cases.image_path      (public bucket)
--
-- Adds: closed table pricing_photo_facts; functions (Pricing view to read, Pricing create to write):
--   pricing_photo_queue(p_limit)        how many photos there are and are read, and the next ones to read
--   pricing_photo_facts_list()          the readings, newest first (at most 500)
--   pricing_photo_fact_save(key, label, facts, model)   keep one reading (the server route calls it as the person)
--   pricing_photo_fact_correct(key, facts)               a person's correction
--
-- Rollback (take a backup first): drop the four functions; drop table public.pricing_photo_facts.

begin;

create table public.pricing_photo_facts (
  image_key text primary key
    check (image_key ~ '^(quotation-images|order-files|pricing-training)/[A-Za-z0-9/._-]+$' and char_length(image_key) <= 400),
  label text check (label is null or char_length(label) <= 160),
  facts jsonb not null check (jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 4000),
  model text check (model is null or char_length(model) <= 80),
  read_at timestamptz not null default now(),
  read_by uuid references public.users(id),
  corrected boolean not null default false,
  corrected_at timestamptz,
  corrected_by uuid references public.users(id)
);
alter table public.pricing_photo_facts enable row level security;
revoke all on public.pricing_photo_facts from public, anon, authenticated;

-- Every product photo BOE One holds, named "<bucket>/<path>", with the product's name. Internal.
create or replace function public.pricing_photo_sources()
returns table (image_key text, source text, label text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct on (k.image_key) k.image_key, k.source, k.label from (
    select 'quotation-images/' || l.image_path as image_key, 'quotation' as source, l.name as label
    from public.quotation_lines l where l.image_path is not null
    union all
    select 'order-files/' || i.image_storage_path, 'pi', i.product_name
    from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
    where s.status = 'approved' and i.image_storage_path is not null
    union all
    select 'pricing-training/' || c.image_path, 'training', c.name
    from public.pricing_training_cases c where c.image_path is not null
  ) k order by k.image_key, k.source
$$;
revoke all on function public.pricing_photo_sources() from public, anon, authenticated;

create or replace function public.pricing_photo_queue(p_limit int default 10)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return jsonb_build_object(
    'total', (select count(*) from public.pricing_photo_sources()),
    'read', (select count(*) from public.pricing_photo_sources() s join public.pricing_photo_facts f on f.image_key = s.image_key),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('key', s.image_key, 'source', s.source, 'label', s.label) order by s.source, s.image_key)
      from (select s.* from public.pricing_photo_sources() s
            where not exists (select 1 from public.pricing_photo_facts f where f.image_key = s.image_key)
            order by s.source, s.image_key limit greatest(1, least(coalesce(p_limit, 10), 50))) s), '[]'::jsonb));
end $$;
revoke all on function public.pricing_photo_queue(int) from public, anon;
grant execute on function public.pricing_photo_queue(int) to authenticated;

create or replace function public.pricing_photo_facts_list()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return coalesce((select jsonb_agg(x order by x.read_at desc) from (
    select f.image_key as key, f.label, f.facts, f.corrected, f.read_at, f.model,
           (select u.full_name from public.users u where u.id = coalesce(f.corrected_by, f.read_by)) as by_name
    from public.pricing_photo_facts f order by f.read_at desc limit 500) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_photo_facts_list() from public, anon;
grant execute on function public.pricing_photo_facts_list() to authenticated;

-- One reading. Only a photo BOE One holds may be kept, and a corrected reading is never overwritten by a new one.
create or replace function public.pricing_photo_fact_save(p_key text, p_label text, p_facts jsonb, p_model text)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_PHOTO_FORBIDDEN: you may not read photos in Pricing' using errcode = '42501';
  end if;
  if not exists (select 1 from public.pricing_photo_sources() s where s.image_key = p_key) then
    raise exception 'PRICING_PHOTO_INVALID: this is not a product photo BOE One holds' using errcode = '22023';
  end if;
  begin
    insert into public.pricing_photo_facts (image_key, label, facts, model, read_by)
    values (p_key, left(nullif(btrim(coalesce(p_label, '')), ''), 160), p_facts, left(p_model, 80), a.p_uid)
    on conflict (image_key) do update set label = excluded.label, facts = excluded.facts, model = excluded.model,
      read_at = now(), read_by = a.p_uid
    where not public.pricing_photo_facts.corrected;
  exception when check_violation or not_null_violation then
    raise exception 'PRICING_PHOTO_INVALID: check the reading (%)', sqlerrm using errcode = '22023';
  end;
end $$;
revoke all on function public.pricing_photo_fact_save(text, text, jsonb, text) from public, anon;
grant execute on function public.pricing_photo_fact_save(text, text, jsonb, text) to authenticated;

create or replace function public.pricing_photo_fact_correct(p_key text, p_facts jsonb)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_PHOTO_FORBIDDEN: you may not correct photo facts in Pricing' using errcode = '42501';
  end if;
  begin
    update public.pricing_photo_facts set facts = p_facts, corrected = true, corrected_at = now(), corrected_by = a.p_uid
    where image_key = p_key;
  exception when check_violation or not_null_violation then
    raise exception 'PRICING_PHOTO_INVALID: check the facts (%)', sqlerrm using errcode = '22023';
  end;
  if not found then
    raise exception 'PRICING_PHOTO_NOT_FOUND: this photo has not been read yet' using errcode = 'P0002';
  end if;
end $$;
revoke all on function public.pricing_photo_fact_correct(text, jsonb) from public, anon;
grant execute on function public.pricing_photo_fact_correct(text, jsonb) to authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.pricing_photo_facts', 'select') or has_table_privilege('anon', 'public.pricing_photo_facts', 'select') then
    raise exception 'pricing_photo_facts: the table must be closed';
  end if;
  if has_function_privilege('anon', 'public.pricing_photo_queue(int)', 'execute')
     or has_function_privilege('anon', 'public.pricing_photo_facts_list()', 'execute')
     or has_function_privilege('anon', 'public.pricing_photo_fact_save(text, text, jsonb, text)', 'execute')
     or has_function_privilege('anon', 'public.pricing_photo_fact_correct(text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_photo_sources()', 'execute') then
    raise exception 'pricing photo facts: a function is open to a role it must not be open to';
  end if;
end $$;

commit;
