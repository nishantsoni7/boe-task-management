-- Pricing: the watcher (owner, 2026-11-16: "Defaults are fine"). When a quotation line that picked a taught product is
-- priced more than 5% away from the taught price, the person is asked why. The answer goes to the feedback inbox of
-- Price learning, and the Price logic page shows how each taught product is really being quoted.
--
-- Changes:
--   1. pricing_feedback.kind accepts one more value, 'differs_taught'. Only the CHECK is replaced; no row changes.
--      The details (case, taught price, quoted price, reason) travel in the existing `suggestion` column.
--   2. pricing_taught_quotes(), read-only, for people who may open Pricing: the quotation lines whose internal note
--      carries a pick ("[Taught case #N ...]"), newest first, at most 500.
-- A table is altered (one CHECK): take a backup first.
--
-- Rollback (only while no row has kind 'differs_taught'; otherwise delete or re-kind those rows first):
--   drop function public.pricing_taught_quotes();
--   alter table public.pricing_feedback drop constraint pricing_feedback_kind_check;
--   alter table public.pricing_feedback add constraint pricing_feedback_kind_check
--     check (kind in ('too_high', 'too_low', 'wrong_type', 'misread', 'other', 'correction'));

begin;

alter table public.pricing_feedback drop constraint pricing_feedback_kind_check;
alter table public.pricing_feedback add constraint pricing_feedback_kind_check
  check (kind in ('too_high', 'too_low', 'wrong_type', 'misread', 'other', 'correction', 'differs_taught'));

create or replace function public.pricing_taught_quotes()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.pricing_training_actor();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.updated_at desc)
    from (
      select q.id as quotation_id, q.quote_no, q.status, q.updated_at,
             (select u.full_name from public.users u where u.id = q.owner_id) as owner_name,
             l.name, l.material, l.spec, l.finish, l.unit_price, l.internal_note
      from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
      where l.internal_note ~ '\[Taught case #[0-9]+' and l.unit_price > 0
      order by q.updated_at desc limit 500) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_taught_quotes() from public, anon;
grant execute on function public.pricing_taught_quotes() to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.pricing_taught_quotes()', 'execute') then
    raise exception 'pricing_taught_quotes: must not be open to anon';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pricing_feedback_kind_check'
                 and conrelid = 'public.pricing_feedback'::regclass and pg_get_constraintdef(oid) like '%differs_taught%') then
    raise exception 'pricing_feedback: the kind check does not accept differs_taught';
  end if;
end $$;

commit;
