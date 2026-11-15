-- Pricing: the wood list, with what each wood costs (owner, 2026-11-16; step 1 of "the estimator uses submitted
-- training cases"). Owner rule: for another wood, the wood share of a wooden structure changes and the rest stays.
-- To work that out the app needs to know each wood and its rate. Only the ratio between two woods is used.
--
-- Adds: closed table pricing_woods (name, rate per cubic foot, may be empty until someone enters it) and three
-- SECURITY DEFINER functions. Reading needs Pricing view; adding, changing or removing needs Pricing create.
-- Nothing here changes a price anywhere.
--
-- Rollback: drop function pricing_woods_list(), pricing_wood_save(text, numeric), pricing_wood_remove(text);
--           drop table public.pricing_woods.

begin;

create table public.pricing_woods (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 40),
  rate numeric(12,2) check (rate is null or (rate > 0 and rate < 10000000)),
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);
create unique index pricing_woods_name_key on public.pricing_woods (lower(btrim(name)));
alter table public.pricing_woods enable row level security;
revoke all on public.pricing_woods from public, anon, authenticated;

create or replace function public.pricing_woods_list()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', w.name, 'rate', w.rate, 'updated_at', w.updated_at,
             'updated_by_name', (select u.full_name from public.users u where u.id = w.updated_by)) order by lower(w.name))
    from public.pricing_woods w), '[]'::jsonb);
end $$;
revoke all on function public.pricing_woods_list() from public, anon;
grant execute on function public.pricing_woods_list() to authenticated;

-- Add a wood, or change its rate. p_rate null adds the name only (or leaves an existing rate as it is).
create or replace function public.pricing_wood_save(p_name text, p_rate numeric)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_name text := btrim(coalesce(p_name, ''));
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_WOODS_FORBIDDEN: you may not change the wood list' using errcode = '42501';
  end if;
  begin
    insert into public.pricing_woods (name, rate, updated_by) values (v_name, p_rate, a.p_uid)
    on conflict (lower(btrim(name))) do update
      set rate = coalesce(excluded.rate, public.pricing_woods.rate), updated_by = a.p_uid, updated_at = now()
      where excluded.rate is not null;
  exception when check_violation or numeric_value_out_of_range then
    raise exception 'PRICING_WOODS_INVALID: give a wood name of 2 to 40 letters and a rate above zero' using errcode = '22023';
  end;
end $$;
revoke all on function public.pricing_wood_save(text, numeric) from public, anon;
grant execute on function public.pricing_wood_save(text, numeric) to authenticated;

create or replace function public.pricing_wood_remove(p_name text)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_WOODS_FORBIDDEN: you may not change the wood list' using errcode = '42501';
  end if;
  delete from public.pricing_woods where lower(btrim(name)) = lower(btrim(coalesce(p_name, '')));
end $$;
revoke all on function public.pricing_wood_remove(text) from public, anon;
grant execute on function public.pricing_wood_remove(text) to authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.pricing_woods', 'select') or has_table_privilege('anon', 'public.pricing_woods', 'select') then
    raise exception 'pricing_woods: the table must be closed';
  end if;
  if has_function_privilege('anon', 'public.pricing_woods_list()', 'execute')
     or has_function_privilege('anon', 'public.pricing_wood_save(text, numeric)', 'execute')
     or has_function_privilege('anon', 'public.pricing_wood_remove(text)', 'execute') then
    raise exception 'pricing_woods: no function may be open to anon';
  end if;
end $$;

commit;
