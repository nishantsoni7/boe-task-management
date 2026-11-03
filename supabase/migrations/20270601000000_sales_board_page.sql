-- 20270601000000_sales_board_page.sql
--
-- Sales, Lead Board: "load more" for one column (owner's decision 2026-11-03: the board is the Pipeline layout, each
-- status scrolls on its own and keeps loading as you scroll).
--
-- Why a new function: sales_board hands back the first 60 leads of each stage and says nothing about the rest, so a
-- column of 1,070 leads ended at "Showing the 60 most urgent of 1076". This returns the leads of ONE stage, a page at a time.
--   * Same people, same filters, same order as sales_board: its first page of 60 is exactly the 60 sales_board shows
--     (the PGlite suite checks it for every role, so the two cannot drift apart).
--   * It also says how many leads the column holds and how many of them are overdue or due today (a parked lead is
--     never either), which the column header shows. sales_board only has those totals for the whole board.
--   * Reads only. Nothing existing is replaced: sales_board and every other function stay as they are.
--   * Answers { n, overdue, due_today, rows }.
--
-- ROLLBACK: drop function public.sales_board_page(text, integer, integer, text, text, text, text, text, text);

create function public.sales_board_page(
  p_stage text,
  p_offset integer default 0,
  p_limit integer default 40,
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
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_result jsonb;
begin
  if p_stage is null or p_stage not in ('new', 'under_process', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead') then
    raise exception 'SALES_INVALID: Choose a stage of the board.';
  end if;

  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;

  with ranked as (
    select l.id, l.stage, l.next_due_on, row_number() over (
      order by
        case when l.stage in ('converted', 'dead') then 0 else 1 end,
        l.closed_at desc nulls last,
        case when l.stage = 'follow_up_later' then 3 when l.next_due_on < v_today then 0 when l.next_due_on = v_today then 1 else 2 end,
        case l.temperature when 'hot' then 0 when 'warm' then 1 else 2 end,
        l.expected_value_paise desc nulls last,
        l.next_due_on, l.lead_no
    ) as rn
    from public.sales_leads l
    where l.stage = p_stage
      and l.assigned_to is not null and (v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors))
      and (v_holder is null or l.assigned_to = v_holder)
      and (coalesce(p_market, '') = '' or l.market = p_market)
      and (coalesce(p_segment, '') = '' or l.segment = p_segment)
      and (coalesce(p_temperature, '') = '' or l.temperature = p_temperature)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or l.name ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
      and (l.stage not in ('converted', 'dead') or l.closed_at >= now() - interval '30 days')
  )
  select jsonb_build_object(
    'n', (select count(*) from ranked),
    'overdue', (select count(*) from ranked r where r.stage not in ('follow_up_later', 'converted', 'dead') and r.next_due_on < v_today),
    'due_today', (select count(*) from ranked r where r.stage not in ('follow_up_later', 'converted', 'dead') and r.next_due_on = v_today),
    'rows', (
      select coalesce(jsonb_agg(public.sales_lead_row(x) order by r.rn), '[]'::jsonb)
      from ranked r
      join public.sales_leads x on x.id = r.id
      where r.rn > v_offset and r.rn <= v_offset + v_limit
    )
  ) into v_result;

  return v_result;
end;
$$;

-- ═══ Who may call it ═══════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_board_page(text, integer, integer, text, text, text, text, text, text) from public, anon;
grant execute on function public.sales_board_page(text, integer, integer, text, text, text, text, text, text) to authenticated;

-- ═══ Self-checks ═══════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare v_fn text := 'public.sales_board_page(text, integer, integer, text, text, text, text, text, text)';
begin
  if has_function_privilege('anon', v_fn, 'EXECUTE') then raise exception 'SALES_BOARD_PAGE: % is open to anon', v_fn; end if;
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then raise exception 'SALES_BOARD_PAGE: % lost its grant', v_fn; end if;
end $$;
