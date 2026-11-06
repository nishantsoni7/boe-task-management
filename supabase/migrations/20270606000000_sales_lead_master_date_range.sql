-- 20270606000000_sales_lead_master_date_range.sql
--
-- Sales, Lead Master: filter the list by day or by a range of days (owner, 2026-11-06: "Yesterday, Last 7 days,
-- Last 1 month, Custom date").
--
-- What changes: ONE function, sales_leads_page. It gains two optional arguments, p_from and p_to (India dates, either
-- may be left out), and a Yesterday period. Nothing else moves: the same rows, the same visibility rule (a person
-- sees their own leads, a manager sees all), the same search that looks through every day, the same counts per
-- person. The person counts follow the chosen days, so "who got how many on 1 to 5 Nov" reads straight off the list.
--
--   * A given p_from / p_to wins over p_period. A pair typed the wrong way round is read as the range between them;
--     one bound alone is open-ended (from that day on, or up to that day).
--   * periods gains 'yesterday', so the Yesterday card can show its count beside the other four.
--   * The new arguments have defaults, so the screen that is live now (it sends the first six arguments only) keeps
--     working unchanged against this function, whichever of the migration and the deploy lands first.
--
-- Postgres cannot change an argument list with "create or replace", so the six-argument function is dropped in the
-- same transaction and the new one is granted again exactly as 20270524000000 granted the old one.
--
-- WRITE: none. Read only.
--
-- ROLLBACK: drop function public.sales_leads_page(text, text, text, text, integer, integer, date, date); then run the
--   20270530000000 definition of public.sales_leads_page and its grant (authenticated only). The screen then loses
--   Yesterday and Custom dates (it asks for them by name and the database refuses the unknown arguments).

drop function if exists public.sales_leads_page(text, text, text, text, integer, integer);

create or replace function public.sales_leads_page(
  p_period text default 'today',
  p_holder text default 'all',
  p_source text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_all boolean;
  v_juniors uuid[];
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date;
  v_to date;
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g');
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- A number typed in any of its forms ("098765 43210", "+91 98765 43210") finds the one stored number.
  v_norm text := public.normalize_lead_phone(btrim(coalesce(p_q, '')));
  v_holder uuid := case when p_holder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_holder::uuid end;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_periods jsonb;
  v_everyone integer;
  v_unallotted integer;
  v_holders jsonb;
  v_total integer;
  v_rows jsonb;
begin
  v_uid := public.sales_leads_require(null);
  v_all := public.sales_lead_sees_all(v_uid);
  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;

  if p_from is not null or p_to is not null then
    -- Chosen days. Both given: the earlier is the start, whichever box it was typed in.
    v_from := case when p_from is not null and p_to is not null then least(p_from, p_to) else p_from end;
    v_to   := case when p_from is not null and p_to is not null then greatest(p_from, p_to) else p_to end;
  else
    v_from := case p_period when 'today' then v_today when 'yesterday' then v_today - 1 when 'week' then v_today - 6 when 'month' then v_today - 29 else null end;
    v_to   := case p_period when 'yesterday' then v_today - 1 else null end;
  end if;

  with mine as (
    select l.* from public.sales_leads l
    where v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors) or (l.assigned_to is null and l.created_by = v_uid)
  ),
  periods as (
    select jsonb_build_object(
      'today',     count(*) filter (where received_on = v_today),
      'yesterday', count(*) filter (where received_on = v_today - 1),
      'week',      count(*) filter (where received_on >= v_today - 6),
      'month',     count(*) filter (where received_on >= v_today - 29),
      'all',       count(*)
    ) as j from mine
  ),
  base as (
    select l.id, l.lead_no, l.received_on, l.assigned_to, (l.stage in ('converted', 'dead') or l.is_history) as closed
    from mine l
    where (v_from is null or l.received_on >= v_from)
      and (v_to is null or l.received_on <= v_to)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or (v_norm is not null and l.phone_e164 = v_norm)
        or l.name ilike v_like or l.email ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
  ),
  held as (
    select assigned_to, count(*)::integer as n from base where assigned_to is not null group by assigned_to
  ),
  shown as (
    select b.id, b.lead_no, b.received_on
    from base b
    where coalesce(p_holder, 'all') in ('all', '')
       or (p_holder = 'none' and b.assigned_to is null and not b.closed)
       or (v_holder is not null and b.assigned_to = v_holder)
  )
  select
    (select j from periods),
    (select count(*) from base),
    (select count(*) from base where assigned_to is null and not closed),
    (select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
       from held h join public.users u on u.id = h.assigned_to),
    (select count(*) from shown),
    (select coalesce(jsonb_agg(public.sales_lead_row(s) order by s.received_on desc, s.lead_no desc), '[]'::jsonb)
       from public.sales_leads s
       where s.id in (select x.id from shown x order by x.received_on desc, x.lead_no desc limit v_lim offset v_off))
  into v_periods, v_everyone, v_unallotted, v_holders, v_total, v_rows;

  return jsonb_build_object(
    'periods', v_periods,
    'everyone', v_everyone,
    'unallotted', v_unallotted,
    'holders', v_holders,
    'total', v_total,
    'rows', v_rows
  );
end;
$$;

-- ═══ Who may call it ═════════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_leads_page(text, text, text, text, integer, integer, date, date) from public, anon;
grant execute on function public.sales_leads_page(text, text, text, text, integer, integer, date, date) to authenticated;

-- ═══ Self-checks (run when the migration is applied) ═════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.sales_leads_page(text, text, text, text, integer, integer)') is not null then
    raise exception 'SALES_RANGE: the six-argument sales_leads_page is still there (two functions would be ambiguous)';
  end if;
  if has_function_privilege('anon', 'public.sales_leads_page(text, text, text, text, integer, integer, date, date)', 'EXECUTE') then
    raise exception 'SALES_RANGE: sales_leads_page is open to anon';
  end if;
  if not has_function_privilege('authenticated', 'public.sales_leads_page(text, text, text, text, integer, integer, date, date)', 'EXECUTE') then
    raise exception 'SALES_RANGE: sales_leads_page lost its grant';
  end if;
end $$;
