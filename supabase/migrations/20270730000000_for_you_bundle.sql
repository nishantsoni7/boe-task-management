-- Page speed: the Modules For you column asks the database ONCE instead of up to six times (owner, 2026-11-17:
-- "Yes, build it"). The column's reads all start together when the launcher opens and again every minute:
-- the company's For you settings, the person's own choices, open cash handovers, cash on its way, PIs returned
-- to the person and PIs flagged by Operations. Each was its own request.
--
-- Changes:
--   1. for_you_bundle(p_parts, p_choices_user, p_handover_statuses), read-only. For each part asked it runs the
--      SAME read the browser ran (the same table select, or the same existing function with the same arguments)
--      and returns { part: { data } }. SECURITY INVOKER: every read runs as the person asking, so the tables'
--      row rules and each function's own checks answer exactly what they answer today. A part that raises is
--      LEFT OUT of the answer, and the browser asks for that part on its own, which reports its error as before.
-- No table or data changes: no backup needed. Nothing calls it until the browser code ships, and the browser
-- falls back to the separate reads when it is missing.
--
-- Rollback: drop function public.for_you_bundle(text[], uuid, text[]);

begin;

create or replace function public.for_you_bundle(
  p_parts             text[],
  p_choices_user      uuid   default null,
  p_handover_statuses text[] default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_out  jsonb := '{}'::jsonb;
  v_part text;
  v_data jsonb;
begin
  foreach v_part in array coalesce(p_parts, '{}'::text[]) loop
    -- One IF per part (not one CASE): a statement is planned when it first runs, so a missing function only
    -- fails its own part.
    begin
      if v_part = 'modes' then
        select coalesce(jsonb_agg(jsonb_build_object('item_key', s.item_key, 'mode', s.mode)), '[]'::jsonb)
          into v_data from public.for_you_item_settings s;
      elsif v_part = 'choices' then
        select jsonb_build_object('hidden_items', p.hidden_items)
          into v_data from public.user_for_you_preferences p where p.user_id = p_choices_user;
      elsif v_part = 'handovers' then
        v_data := public.finance_handover_list(p_handover_statuses, false, 100, 0, null);
      elsif v_part = 'unclosed' then
        v_data := public.finance_unclosed_funds();
      elsif v_part = 'returned' then
        v_data := public.my_returned_pis();
      elsif v_part = 'flagged' then
        v_data := public.my_flagged_pis();
      else
        continue;
      end if;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('data', v_data));
    exception when others then
      null; -- left out: the browser asks for this part on its own
    end;
  end loop;
  return v_out;
end $$;

revoke all on function public.for_you_bundle(text[], uuid, text[]) from public, anon;
grant execute on function public.for_you_bundle(text[], uuid, text[]) to authenticated;

comment on function public.for_you_bundle(text[], uuid, text[]) is
  'Modules For you column: its separate reads in one request, each run as the caller (security invoker); a part that fails is left out. 20270730000000.';

do $$
begin
  if has_function_privilege('anon', 'public.for_you_bundle(text[], uuid, text[])', 'execute') then
    raise exception 'for_you_bundle: must not be open to anon';
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = 'public.for_you_bundle(text[], uuid, text[])'::regprocedure) then
    raise exception 'for_you_bundle: must run as the caller (security invoker)';
  end if;
end $$;

commit;
