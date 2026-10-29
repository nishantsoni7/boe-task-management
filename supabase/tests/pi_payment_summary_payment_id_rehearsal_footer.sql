-- Rehearsal checks for 20270505000000: pi_submission_payment_summary() sends
-- each payment's Payment ID.
--
-- HOW TO USE (everything is rolled back; nothing remains):
--   node scripts/dev/rehearse-migration.mjs supabase/migrations/20270505000000_pi_payment_summary_payment_id.sql supabase/tests/pi_payment_summary_payment_id_rehearsal_footer.sql <out.sql>
--   then:  supabase db query --linked --file <out.sql>   (Windows path, MSYS_NO_PATHCONV=1)
-- The last row printed must be REHEARSAL OK.
--
-- That nothing else in the function changed is held by the text test in
-- src/components/orders/piPaymentDetails.render.test.tsx (the 20270227000000
-- body, verbatim, plus one line). This proves the new line runs on real rows.

do $$
begin
  if not has_function_privilege('authenticated', 'public.pi_submission_payment_summary(uuid)', 'execute') then
    raise exception 'REHEARSAL: authenticated lost execute on pi_submission_payment_summary';
  end if;
end $$;

create temp table zz_ctx (admin_id uuid, submission_id uuid);
grant select on zz_ctx to authenticated;
create temp table zz_seen (payment_id uuid, human_payment_id text);
grant insert, select on zz_seen to authenticated;
insert into zz_ctx
select (select u.id from public.users u where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false order by u.created_at limit 1),
       s.order_submission_id
  from (select distinct a.order_submission_id
          from public.finance_payment_allocations a
         where a.order_submission_id is not null
         order by a.order_submission_id
         limit 25) s;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select admin_id from zz_ctx limit 1), 'role', 'authenticated')::text, true);

do $$
declare
  c zz_ctx%rowtype;
  r jsonb;
  p jsonb;
  v_subs int := 0;
  v_rows int := 0;
  v_id text;
begin
  for c in select * from zz_ctx loop
    if c.admin_id is null then raise exception 'REHEARSAL: no active admin found'; end if;
    r := public.pi_submission_payment_summary(c.submission_id);
    for p in select * from jsonb_array_elements(r -> 'payments') loop
      if not (p ? 'human_payment_id') then
        raise exception 'REHEARSAL: a payment row on % has no human_payment_id key', c.submission_id;
      end if;
      if coalesce(p ->> 'human_payment_id', '') !~ '^P-[A-Z]{2}-[0-9]{4}$' then
        raise exception 'REHEARSAL: malformed Payment ID % on %', p ->> 'human_payment_id', c.submission_id;
      end if;
      insert into zz_seen values ((p ->> 'payment_id')::uuid, p ->> 'human_payment_id');
      v_rows := v_rows + 1;
    end loop;
    v_subs := v_subs + 1;
  end loop;
  if v_subs = 0 or v_rows = 0 then raise exception 'REHEARSAL: no PI with payments was exercised'; end if;
  raise notice 'REHEARSAL: % PIs, % payment rows checked', v_subs, v_rows;
end $$;

reset role;

-- every Payment ID sent is that payment's own (read back as the table owner)
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from zz_seen s
    left join public.finance_payment_requests f on f.id = s.payment_id
   where f.human_payment_id is distinct from s.human_payment_id;
  if v_bad > 0 then raise exception 'REHEARSAL: % rows carry another payment''s Payment ID', v_bad; end if;
end $$;

select 'REHEARSAL OK' as result;
