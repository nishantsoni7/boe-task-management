-- 20270716000000_sales_board_summary.sql
--
-- Sales, Lead Board: the board's totals, without the leads (owner, 2026-11-14: "the Lead Board is too slow in loading").
--
-- Measured on the live board on 2026-11-14 (a signed-in browser, a cold load): sales_board took 1.19 s, the slowest call
-- of the page, while a column page (sales_board_page) takes 0.3 to 0.6 s. The screen reads four things from sales_board
-- (the totals, the count and value of each stage, who holds leads, and how many wait to be allotted) and has not read its
-- `rows` since the columns became pages (20270601000000), yet sales_board still builds them: the 60 most urgent leads of
-- every stage (up to 480 full lead rows, each with its holder's name, its Premium reading and its stuck check) and sends
-- them all, and it works out "stuck" for every lead of every stage, closed ones included.
--
-- This adds public.sales_board_summary(...), the same four answers for the same people and filters, and nothing else:
--   * no `rows`;
--   * "stuck" is worked out for open leads only (a closed lead is never stuck: sales_lead_stuck answers false for it);
--   * the lead rows are not rebuilt, so the answer is a few hundred bytes instead of several hundred kilobytes.
-- Same visibility as sales_board (the person's own leads, their juniors', or every lead for somebody who sees all), the
-- same filters, the same 30-day window on Converted and Dead. The PGlite suite supabase/tests/sales_full_flow_pglite.mjs
-- checks that its answer equals sales_board's, key by key, for every role and several filters.
--
-- NOTHING EXISTING IS REPLACED. sales_board stays exactly as it is (My day does not use it; the Lead Board falls back to it
-- until this function is in the database, so the code and this migration can go out in either order).
--
-- WRITE: none. A new read-only function; no table, column, constraint or data changes: a same-day verified backup is enough.
--
-- ROLLBACK: drop function public.sales_board_summary(text, text, text, text, text, text);

create function public.sales_board_summary(
  p_holder text default 'all',
  p_market text default null,
  p_segment text default null,
  p_temperature text default null,
  p_source text default null,
  p_q text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_all boolean := public.sales_lead_sees_all(v_uid);
  v_juniors uuid[];
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g');
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_holder uuid := case when p_holder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_holder::uuid end;
  v_result jsonb;
begin
  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;

  with f as (
    select l.stage, l.next_due_on, l.expected_value_paise, l.closed_at,
           -- A case, so the check is made for an open lead only.
           case when l.stage in ('converted', 'dead') then false else public.sales_lead_stuck(l) end as is_stuck
    from public.sales_leads l
    where l.assigned_to is not null and (v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors))
      and (v_holder is null or l.assigned_to = v_holder)
      and (coalesce(p_market, '') = '' or l.market = p_market)
      and (coalesce(p_segment, '') = '' or l.segment = p_segment)
      and (coalesce(p_temperature, '') = '' or l.temperature = p_temperature)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or l.name ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
  )
  select jsonb_build_object(
    'stats', (
      select jsonb_build_object(
        'open', count(*),
        'value_paise', coalesce(sum(f.expected_value_paise), 0),
        'overdue', count(*) filter (where f.stage <> 'follow_up_later' and f.next_due_on < v_today),
        'due_today', count(*) filter (where f.stage <> 'follow_up_later' and f.next_due_on = v_today),
        'stuck', count(*) filter (where f.is_stuck)
      ) from f where f.stage not in ('converted', 'dead')
    ),
    'stages', (
      select coalesce(jsonb_object_agg(g.stage, jsonb_build_object('n', g.n, 'value_paise', g.v)), '{}'::jsonb)
      from (
        select f.stage, count(*) as n, coalesce(sum(f.expected_value_paise), 0) as v
        from f
        where f.stage not in ('converted', 'dead') or f.closed_at >= now() - interval '30 days'
        group by f.stage
      ) g
    ),
    -- Who holds leads: everyone this person may see, whatever the filters (as in sales_board).
    'holders', (
      select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
      from (
        select m.assigned_to, count(*)::integer as n
        from public.sales_leads m
        where m.assigned_to is not null and (v_all or m.assigned_to = v_uid or m.assigned_to = any (v_juniors))
          and m.stage not in ('converted', 'dead')
        group by m.assigned_to
      ) h
      join public.users u on u.id = h.assigned_to
    ),
    -- Only somebody who can do something about the queue is told its size.
    'waiting_allotment', case when v_all then (
      select count(*) from public.sales_leads l where l.assigned_to is null and l.stage not in ('converted', 'dead') and not l.is_history
    ) end
  ) into v_result;

  return v_result;
end;
$$;

-- ═══ Who may call it ═══════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_board_summary(text, text, text, text, text, text) from public, anon;
grant execute on function public.sales_board_summary(text, text, text, text, text, text) to authenticated;

-- ═══ Self-checks ═══════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare v_fn text := 'public.sales_board_summary(text, text, text, text, text, text)';
begin
  if has_function_privilege('anon', v_fn, 'EXECUTE') then raise exception 'SALES_BOARD_SUMMARY: % is open to anon', v_fn; end if;
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then raise exception 'SALES_BOARD_SUMMARY: % lost its grant', v_fn; end if;
end $$;
