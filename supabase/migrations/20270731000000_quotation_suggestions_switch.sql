-- Quotations: who sees the suggested prices (owner, 2026-11-18: "As we have not fed sufficient data in the Quotation
-- training app, so price suggestions are quite vague. So want an option to disable it for all (except me so i can keep
-- on verifying and once it reaches a good accuracy level, i can make it live for everyone)").
--
-- Changes:
--   1. quotation_suggestion_settings, one row: shown_to NULL = everyone; otherwise only the people listed. A NEW table;
--      no existing table or row changes, so no backup is needed first. Starts as "everyone" (as today).
--   2. quotation_suggestions_get(): what the caller may see, read by the quotation builder and Control Center.
--   3. quotation_suggestions_set(p_everyone): administrators only; false keeps the suggestions for the administrator
--      who switches it ("except me"), true gives them back to everyone.
-- A display setting, not a security boundary: the history behind the suggestions stays readable as before.
--
-- Rollback:
--   drop function public.quotation_suggestions_set(boolean);
--   drop function public.quotation_suggestions_get();
--   drop table public.quotation_suggestion_settings;

begin;

create table public.quotation_suggestion_settings (
  id          boolean primary key default true check (id),
  shown_to    uuid[],
  updated_by  uuid references public.users(id),
  updated_at  timestamptz not null default now()
);
insert into public.quotation_suggestion_settings (id) values (true);
alter table public.quotation_suggestion_settings enable row level security;
-- No policies: read and written only through the two functions below.

create or replace function public.quotation_suggestions_get()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return (select jsonb_build_object(
      'everyone', s.shown_to is null,
      'for_me', s.shown_to is null or a.p_uid = any(s.shown_to),
      'shown_to', coalesce((select jsonb_agg(u.full_name order by u.full_name) from public.users u where u.id = any(s.shown_to)), '[]'::jsonb),
      'may_change', a.p_admin,
      'updated_at', s.updated_at)
    from public.quotation_suggestion_settings s where s.id);
end $$;
revoke all on function public.quotation_suggestions_get() from public, anon;
grant execute on function public.quotation_suggestions_get() to authenticated;

create or replace function public.quotation_suggestions_set(p_everyone boolean)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not a.p_admin then raise exception 'QUOTATIONS_FORBIDDEN: only an administrator decides who sees price suggestions' using errcode = '42501'; end if;
  update public.quotation_suggestion_settings
     set shown_to = case when coalesce(p_everyone, true) then null else array[a.p_uid] end,
         updated_by = a.p_uid, updated_at = now()
   where id;
  return public.quotation_suggestions_get();
end $$;
revoke all on function public.quotation_suggestions_set(boolean) from public, anon;
grant execute on function public.quotation_suggestions_set(boolean) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_suggestions_get()', 'execute') then raise exception 'quotation_suggestions_get open to anon'; end if;
  if has_function_privilege('anon', 'public.quotation_suggestions_set(boolean)', 'execute') then raise exception 'quotation_suggestions_set open to anon'; end if;
  if (select count(*) from public.quotation_suggestion_settings) <> 1 then raise exception 'quotation_suggestion_settings must hold one row'; end if;
  if (select shown_to from public.quotation_suggestion_settings) is not null then raise exception 'must start as everyone'; end if;
end $$;

commit;
