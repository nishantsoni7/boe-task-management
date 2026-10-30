-- Rehearsal checks for 20270507000000 + 20270508000000 + 20270509000000 (the
-- sales team's Orders dashboard and the short returned-PI notice).
--
-- HOW TO USE (everything is rolled back; nothing remains):
--   1. Put the three migrations in one file, in order:
--        cat supabase/migrations/20270507000000_returned_pis_for_sales.sql supabase/migrations/20270508000000_salesperson_dashboard_last_month.sql supabase/migrations/20270509000000_pi_review_notice_short.sql > <combined.sql>
--   2. node scripts/dev/rehearse-migration.mjs <combined.sql> supabase/tests/sales_dashboard_rehearsal_footer.sql <out.sql>
--   3. supabase db query --linked --file <out.sql>   (Windows path, MSYS_NO_PATHCONV=1)
-- The last row printed must be REHEARSAL OK.
--
-- The rules themselves (month split, shortfall, ready since, who a PI is
-- returned to, the notice words) are proven on synthetic rows by
-- supabase/tests/sales_dashboard_returned_pis_pglite.mjs. This proves the new
-- functions run on the REAL rows, as real salespeople, without an error.

do $$
begin
  if not has_function_privilege('authenticated', 'public.salesperson_orders_dashboard()', 'execute') then
    raise exception 'REHEARSAL: authenticated lost execute on salesperson_orders_dashboard';
  end if;
  if not has_function_privilege('authenticated', 'public.my_returned_pis()', 'execute') then
    raise exception 'REHEARSAL: authenticated cannot call my_returned_pis';
  end if;
  if has_function_privilege('anon', 'public.my_returned_pis()', 'execute') then
    raise exception 'REHEARSAL: anon can call my_returned_pis';
  end if;
  if has_function_privilege('authenticated', 'public.order_submissions_returned_to(uuid)', 'execute') then
    raise exception 'REHEARSAL: a client can call order_submissions_returned_to';
  end if;
end $$;

-- Every active salesperson (at most 40), plus everyone with a PI returned to them.
create temp table zz_people (user_id uuid primary key);
grant select on zz_people to authenticated;
insert into zz_people
select u.id from public.users u
 where u.team = 'sales' and u.is_active and coalesce(u.is_deleted, false) = false
 order by u.id limit 40
on conflict do nothing;
insert into zz_people
select distinct p.uid
  from public.order_submissions s
 cross join lateral (values (s.salesperson_id), (s.submitted_by), (s.created_by)) p(uid)
  join public.users u on u.id = p.uid and u.is_active and coalesce(u.is_deleted, false) = false
 where s.status = 'needs_changes' and s.deletion_claim_token is null
on conflict do nothing;

create temp table zz_seen (user_id uuid, applicable boolean, returned int, card int, advance int, ready int);
grant insert, select on zz_seen to authenticated;

set local role authenticated;

do $$
declare
  v_uid  uuid;
  d      jsonb;
  card   jsonb;
  r      jsonb;
  v_prev date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date;
begin
  for v_uid in select user_id from zz_people loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

    card := public.my_returned_pis();
    if jsonb_typeof(card) <> 'array' then
      raise exception 'REHEARSAL: my_returned_pis for % is not a list', v_uid;
    end if;
    for r in select * from jsonb_array_elements(card) loop
      if r ? 'note' or r ? 'review_note' then
        raise exception 'REHEARSAL: the Modules card carries the note for %', v_uid;
      end if;
      if (r ->> 'submission_id') is null or (r ->> 'waiting_seconds')::numeric < 0 then
        raise exception 'REHEARSAL: a malformed card row for %: %', v_uid, r;
      end if;
    end loop;

    begin
      d := public.salesperson_orders_dashboard();
    exception when insufficient_privilege then
      -- Orders not open to this person: the dashboard refuses as before; the card said [].
      if jsonb_array_length(card) <> 0 then
        raise exception 'REHEARSAL: % has no Orders yet the card listed PIs', v_uid;
      end if;
      insert into zz_seen values (v_uid, null, null, 0, null, null);
      continue;
    end;

    if (d ->> 'applicable')::boolean then
      if (d -> 'revenue_last_month' ->> 'month_from')::date <> v_prev then
        raise exception 'REHEARSAL: last month for % starts %, expected %', v_uid, d -> 'revenue_last_month' ->> 'month_from', v_prev;
      end if;
      if (d -> 'revenue_last_month' ->> 'amount')::numeric < 0 then
        raise exception 'REHEARSAL: negative last-month sales for %', v_uid;
      end if;
      for r in select * from jsonb_array_elements(d -> 'advance') loop
        if coalesce((r ->> 'shortfall')::numeric, 0) <= 0 then
          raise exception 'REHEARSAL: order % is listed below 40%% with no shortfall', r ->> 'display_number';
        end if;
      end loop;
      for r in select * from jsonb_array_elements(d -> 'ready_for_dispatch') loop
        if not (r ? 'ready_since') or coalesce((r ->> 'ready_days')::int, 0) < 0 then
          raise exception 'REHEARSAL: ready order % has a bad ready date', r ->> 'display_number';
        end if;
      end loop;
      -- The dashboard and the Modules card read one definition: the same PIs, in the same order.
      if (select coalesce(jsonb_agg(x -> 'submission_id'), '[]') from jsonb_array_elements(d -> 'returned') x)
         is distinct from
         (select coalesce(jsonb_agg(x -> 'submission_id'), '[]') from jsonb_array_elements(card) x) then
        raise exception 'REHEARSAL: dashboard and Modules card disagree for %', v_uid;
      end if;
      insert into zz_seen values (v_uid, true, jsonb_array_length(d -> 'returned'), jsonb_array_length(card),
        jsonb_array_length(d -> 'advance'), jsonb_array_length(d -> 'ready_for_dispatch'));
    else
      insert into zz_seen values (v_uid, false, null, jsonb_array_length(card), null, null);
    end if;
  end loop;

  if not exists (select 1 from zz_seen where applicable) then
    raise exception 'REHEARSAL: no salesperson dashboard was exercised';
  end if;
end $$;

reset role;

-- What was exercised (counts only, no names).
select count(*) filter (where applicable)           as dashboards_read,
       count(*) filter (where applicable is false)  as not_salespeople,
       count(*) filter (where applicable is null)   as orders_closed,
       coalesce(sum(card), 0)                       as returned_pi_cards,
       coalesce(sum(advance), 0)                    as below_40_rows,
       coalesce(sum(ready), 0)                      as ready_rows
  from zz_seen;

select 'REHEARSAL OK' as result;
