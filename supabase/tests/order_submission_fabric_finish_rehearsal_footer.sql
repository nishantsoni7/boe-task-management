-- Rehearsal checks for the Fabric & Finish cost sheet (20270431000000).
--
-- HOW TO USE (everything is rolled back; nothing remains):
--   node scripts/dev/rehearse-migration.mjs supabase/migrations/20270431000000_order_submission_fabric_finish_lines.sql supabase/tests/order_submission_fabric_finish_rehearsal_footer.sql <out.sql>
--   then:  supabase db query --linked --file <out.sql>   (Windows path, MSYS_NO_PATHCONV=1)
-- The last row printed must be REHEARSAL OK.

create temp table zz_ctx (admin_id uuid, sub_id uuid, seq text);
grant select on zz_ctx to authenticated;
insert into zz_ctx
select (select u.id from public.users u where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false order by u.created_at limit 1),
       s.id, coalesce(nullif(btrim(i.item_sequence), ''), i.id::text)
  from public.order_submissions s
  join public.order_submission_items i on i.submission_id = s.id
 where s.status <> 'rejected'
 order by s.created_at desc, i.sort_order limit 1;

-- The import route's door, as the service role would call it (the superuser here).
do $$
declare
  c zz_ctx%rowtype;
  n integer;
begin
  select * into c from zz_ctx;
  if c.admin_id is null or c.sub_id is null then raise exception 'REHEARSAL: no admin or no PI line found'; end if;
  n := public.order_submission_fabric_finish_save_sheet(c.sub_id, repeat('a', 64), jsonb_build_array(jsonb_build_object(
         'item_sequence', c.seq, 'fabric_metres_per_piece', 0.5, 'fabric_price_per_metre', 600,
         'packing_cost_per_piece', 300, 'packing_type', 'BCF',
         'finish', jsonb_build_array(jsonb_build_object('heading', 'Fabric Approval', 'value', 'PENDING')))));
  if n <> 1 then raise exception 'REHEARSAL: save_sheet stored % lines', n; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select admin_id from zz_ctx), 'role', 'authenticated')::text, true);

do $$
declare
  c zz_ctx%rowtype;
  r jsonb;
  v_msg text;
begin
  select * into c from zz_ctx;

  r := public.order_submission_fabric_finish_read(c.sub_id);
  if (r ->> 'found')::boolean is not true then raise exception 'REHEARSAL: read did not find the PI'; end if;
  if (r ->> 'can_edit')::boolean is not true then raise exception 'REHEARSAL: the admin may not type'; end if;
  if jsonb_array_length(r -> 'items') < 1 then raise exception 'REHEARSAL: no items'; end if;
  if jsonb_array_length(r -> 'lines') <> 1 then raise exception 'REHEARSAL: expected 1 line, got %', jsonb_array_length(r -> 'lines'); end if;
  if (r -> 'lines' -> 0 -> 'sheet' ->> 'fabric_price_per_metre')::numeric <> 600 then raise exception 'REHEARSAL: the sheet value did not read back'; end if;
  if r -> 'submission' -> 'fabric_cost_meaning' is null then raise exception 'REHEARSAL: no PI cost meaning'; end if;

  perform public.order_submission_fabric_finish_save_typed(c.sub_id, c.seq,
    jsonb_build_object('fabric_price_per_metre', 650, 'packing_type', 'Carton',
      'finish', jsonb_build_array(jsonb_build_object('heading', 'Fabric Approval', 'value', 'Tony 115'))));
  r := public.order_submission_fabric_finish_read(c.sub_id);
  if (r -> 'lines' -> 0 -> 'typed' ->> 'fabric_price_per_metre')::numeric <> 650 then raise exception 'REHEARSAL: the typed value was not saved'; end if;
  if (r -> 'lines' -> 0 -> 'sheet' ->> 'fabric_price_per_metre')::numeric <> 600 then raise exception 'REHEARSAL: the sheet value was lost'; end if;
  if r -> 'lines' -> 0 ->> 'typed_by_name' is null then raise exception 'REHEARSAL: no typist name'; end if;

  begin
    perform public.order_submission_fabric_finish_save_typed(c.sub_id, 'ZZ-NOT-A-LINE', jsonb_build_object('packing_cost_per_piece', 1));
    raise exception 'REHEARSAL: a line not on the PI was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'FABRIC_FINISH_LINE_NOT_ON_PI%' then raise; end if;
  end;

  begin
    perform public.order_submission_fabric_finish_save_typed(c.sub_id, c.seq, jsonb_build_object('packing_cost_per_piece', -5));
    raise exception 'REHEARSAL: a negative figure was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'FABRIC_FINISH_VALUE_INVALID%' then raise; end if;
  end;

  begin
    perform public.order_submission_fabric_finish_save_sheet(c.sub_id, null, '[]'::jsonb);
    raise exception 'REHEARSAL: an authenticated session could call save_sheet';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select 'REHEARSAL OK' as result;
