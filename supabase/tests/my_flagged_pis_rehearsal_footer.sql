-- Rehearsal checks for 20270611000000 (my_flagged_pis: the PIs Operations flagged that the caller must answer).
--
-- HOW TO USE (everything is rolled back; nothing remains):
--   1. node scripts/dev/rehearse-migration.mjs supabase/migrations/20270611000000_my_flagged_pis.sql supabase/tests/my_flagged_pis_rehearsal_footer.sql <out.sql>
--   2. supabase db query --linked --file <out.sql>   (Windows path, MSYS_NO_PATHCONV=1)
-- The last row printed must be REHEARSAL OK. It is read-only against your data: the function is created inside the
-- transaction, called as real people, and the transaction is rolled back.
--
-- The rules themselves (who is shown what, and when a flag leaves) are proven on synthetic rows by
-- supabase/tests/my_flagged_pis_pglite.mjs. This proves the function runs on the REAL rows and the REAL
-- can_propose_order_pi_edit(), as every active admin and everyone who owns a PI that is flagged right now,
-- without an error, and that nobody is shown a flag the answer door would refuse. Counts only, no names.

do $$
begin
  if not has_function_privilege('authenticated', 'public.my_flagged_pis()', 'execute') then
    raise exception 'REHEARSAL: authenticated cannot call my_flagged_pis';
  end if;
  if has_function_privilege('anon', 'public.my_flagged_pis()', 'execute') then
    raise exception 'REHEARSAL: anon can call my_flagged_pis';
  end if;
end $$;

-- Every active admin, plus the creator / submitter of every PI that is flagged right now.
create temp table zz_people (user_id uuid primary key);
grant select on zz_people to authenticated;
insert into zz_people
select u.id from public.users u
 where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false
on conflict do nothing;
insert into zz_people
select distinct p.uid
  from public.order_operations_handoffs h
  join public.order_submissions s on s.id = h.submission_id
 cross join lateral (values (s.created_by), (s.submitted_by)) p(uid)
  join public.users u on u.id = p.uid and u.is_active and coalesce(u.is_deleted, false) = false
 where h.status = 'clarification_needed' and h.superseded_at is null and p.uid is not null
on conflict do nothing;

create temp table zz_seen (user_id uuid, listed int);
grant insert, select on zz_seen to authenticated;
create temp table zz_listed (user_id uuid, handoff_id uuid, order_id uuid);
grant insert, select on zz_listed to authenticated;

set local role authenticated;

do $$
declare
  v_uid uuid;
  a     jsonb;
  r     jsonb;
begin
  for v_uid in select user_id from zz_people loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

    a := public.my_flagged_pis();
    if jsonb_typeof(a) <> 'array' then
      raise exception 'REHEARSAL: my_flagged_pis for % is not a list', v_uid;
    end if;
    for r in select * from jsonb_array_elements(a) loop
      if (r ->> 'handoff_id') is null or (r ->> 'order_id') is null
         or (r ->> 'version_number') is null or (r ->> 'waiting_seconds')::numeric < 0 then
        raise exception 'REHEARSAL: a malformed row for %: %', v_uid, r;
      end if;
      if not public.can_propose_order_pi_edit((r ->> 'order_id')::uuid) then
        raise exception 'REHEARSAL: % is shown a flag on order % that the answer door would refuse', v_uid, r ->> 'order_number';
      end if;
      if not exists (select 1 from public.order_operations_handoffs h
                      where h.id = (r ->> 'handoff_id')::uuid and h.status = 'clarification_needed' and h.superseded_at is null) then
        raise exception 'REHEARSAL: % is shown a flag that is not live (order %)', v_uid, r ->> 'order_number';
      end if;
      insert into zz_listed values (v_uid, (r ->> 'handoff_id')::uuid, (r ->> 'order_id')::uuid);
    end loop;
    insert into zz_seen values (v_uid, jsonb_array_length(a));
  end loop;

  if not exists (select 1 from zz_seen) then
    raise exception 'REHEARSAL: nobody was exercised';
  end if;
end $$;

reset role;

-- What was exercised (counts only, no names).
select count(*)                 as people_exercised,
       coalesce(sum(listed), 0) as rows_listed
  from zz_seen;

-- Each Order flagged right now, and how many of those people would be asked to answer it.
select o.display_number as order_number, count(distinct l.user_id) as people_asked_to_answer
  from zz_listed l join public.orders o on o.id = l.order_id
 group by o.display_number order by 1;

select count(*) as live_flags_in_total
  from public.order_operations_handoffs
 where status = 'clarification_needed' and superseded_at is null;

select 'REHEARSAL OK' as result;
