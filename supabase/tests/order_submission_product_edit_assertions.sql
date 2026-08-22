-- ═══════════════════════════════════════════════════════════════════════════
-- PI PRODUCT EDITING — behavioural assertions for 20261002000000
-- One transaction, ending in ROLLBACK. Scratch database only.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

do $$
declare
  n_pass int := 0; n_fail int := 0;
  failures text[] := '{}'; v_report text;
  u_owner constant uuid := '11111111-1111-1111-1111-111111111111';
  u_other constant uuid := '22222222-2222-2222-2222-222222222222';
  u_admin constant uuid := '66666666-6666-6666-6666-666666666666';
  k_draft constant uuid := 'd3000000-0000-0000-0000-00000000000d';
  i1 constant uuid := 'e1000000-0000-0000-0000-000000000001';
  i2 constant uuid := 'e2000000-0000-0000-0000-000000000002';
  i3 constant uuid := 'e3000000-0000-0000-0000-000000000003';
  v_res jsonb; v_txt text; v_num numeric; v_ver int; v_before numeric;
begin
  insert into public.order_submissions (id, status, client_name, created_by, submitted_by,
                                        total_before_gst, grand_total)
  values (k_draft, 'draft', 'Draft Co', u_owner, u_owner, 250000, 295000);
  insert into public.order_submission_items
    (id, submission_id, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (i1, k_draft, 'Oak sideboard', 2, 50000, 100000, 0),
         (i2, k_draft, 'Teak bed',      1, 90000,  90000, 1),
         (i3, k_draft, 'Cane chair',    4, 15000,  60000, 2);

  -- ═══ A. DESCRIPTIVE EDITS WORK ══════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.update_order_submission_item_details(
      i1, jsonb_build_object('product_name', 'Oak sideboard, 6ft',
                             'material', 'Solid oak',
                             'dimensions', '1830 x 450 x 800'), null, null);
    if (v_res->>'fields')::int = 3 then n_pass := n_pass + 1;
    else failures := array_append(failures, format('A1: %s fields', v_res->>'fields')); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'A1: refused -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  reset role;

  select product_name into v_txt from public.order_submission_items where id = i1;
  if v_txt = 'Oak sideboard, 6ft' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'A2: the name did not land'); n_fail := n_fail + 1; end if;

  -- ═══ B. NO MONEY MOVED ══════════════════════════════════════════════════
  select quantity into v_num from public.order_submission_items where id = i1;
  if v_num = 2 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B1: the quantity changed'); n_fail := n_fail + 1; end if;
  select total_amount into v_num from public.order_submission_items where id = i1;
  if v_num = 100000 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B2: the line total changed'); n_fail := n_fail + 1; end if;
  select total_before_gst into v_num from public.order_submissions where id = k_draft;
  if v_num = 250000 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B3: total_before_gst changed'); n_fail := n_fail + 1; end if;
  select grand_total into v_num from public.order_submissions where id = k_draft;
  if v_num = 295000 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B4: grand_total changed'); n_fail := n_fail + 1; end if;

  -- ═══ C. MONEY FIELDS ARE REFUSED BY NAME, WITH THE REASON ═══════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  for v_report in select unnest(array['quantity', 'cost_per_piece', 'total_amount']) loop
    begin
      v_res := public.update_order_submission_item_details(
        i1, jsonb_build_object(v_report, '5'), null, null);
      failures := array_append(failures, format('C1: %s was accepted', v_report)); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%MONEY_NOT_EDITABLE%' and sqlerrm like '%re-import%' then n_pass := n_pass + 1;
      else failures := array_append(failures, format('C1: %s -> %s', v_report, sqlerrm)); n_fail := n_fail + 1; end if;
    end;
  end loop;

  for v_report in select unnest(array['submission_id', 'id', 'image_storage_path', 'sort_order']) loop
    begin
      v_res := public.update_order_submission_item_details(
        i1, jsonb_build_object(v_report, 'x'), null, null);
      failures := array_append(failures, format('C2: %s was accepted', v_report)); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%UNKNOWN_FIELD%' then n_pass := n_pass + 1;
      else failures := array_append(failures, format('C2: %s -> %s', v_report, sqlerrm)); n_fail := n_fail + 1; end if;
    end;
  end loop;
  reset role;

  -- ═══ D. REORDERING ══════════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  v_res := public.reorder_order_submission_items(k_draft, array[i3, i1, i2], null, null);
  if (v_res->>'changed')::boolean then n_pass := n_pass + 1;
  else failures := array_append(failures, 'D1: the reorder reported no change'); n_fail := n_fail + 1; end if;
  reset role;

  select string_agg(product_name, ' | ' order by sort_order) into v_txt
    from public.order_submission_items where submission_id = k_draft;
  if v_txt like 'Cane chair%' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('D2: order is %s', v_txt)); n_fail := n_fail + 1; end if;

  -- SWAPPING TWO LINES must not collide on the unique sort_order index
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.reorder_order_submission_items(k_draft, array[i1, i3, i2], null, null);
    n_pass := n_pass + 1;
  exception when others then
    failures := array_append(failures, 'D3: a swap collided -> ' || sqlerrm); n_fail := n_fail + 1;
  end;

  -- an unchanged order writes nothing
  v_res := public.reorder_order_submission_items(k_draft, array[i1, i3, i2], null, null);
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'D4: an unchanged order reported a change'); n_fail := n_fail + 1; end if;

  -- a PARTIAL list is refused
  begin
    v_res := public.reorder_order_submission_items(k_draft, array[i1, i2], null, null);
    failures := array_append(failures, 'D5: a partial list was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%BAD_ORDER%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D5: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- a REPEATED id is refused
  begin
    v_res := public.reorder_order_submission_items(k_draft, array[i1, i1, i2], null, null);
    failures := array_append(failures, 'D6: a repeated id was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%BAD_ORDER%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D6: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- a FOREIGN id is refused
  begin
    v_res := public.reorder_order_submission_items(k_draft, array[i1, i2, gen_random_uuid()], null, null);
    failures := array_append(failures, 'D7: a foreign id was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%BAD_ORDER%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D7: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ E. AUTHORITY AND CONCURRENCY ═══════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_other::text, true);
  begin
    v_res := public.update_order_submission_item_details(i1, jsonb_build_object('material', 'x'), null, null);
    failures := array_append(failures, 'E1: a stranger edited a line'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'E1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  select row_version into v_ver from public.order_submissions where id = k_draft;
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  v_res := public.update_order_submission_item_details(i2, jsonb_build_object('material', 'Teak'), v_ver, null);
  begin
    v_res := public.update_order_submission_item_details(i2, jsonb_build_object('material', 'Overwrite'), v_ver, null);
    failures := array_append(failures, 'E2: a STALE edit overwrote a newer one'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%STALE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'E2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  -- READ AS POSTGRES. Verifying a write while still wearing `authenticated`
  -- reads through RLS, and an invisible row is indistinguishable from a write
  -- that did not happen — which is exactly how this assertion first "failed".
  reset role;
  select material into v_txt from public.order_submission_items where id = i2;
  if v_txt = 'Teak' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('E3: surviving value is %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- an unchanged save writes nothing and does not bump the version
  select row_version into v_ver from public.order_submissions where id = k_draft;
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  v_res := public.update_order_submission_item_details(i2, jsonb_build_object('material', 'Teak'), v_ver, null);
  reset role;
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E4: an unchanged save reported a change'); n_fail := n_fail + 1; end if;
  select row_version into v_report from public.order_submissions where id = k_draft;
  if v_report::int = v_ver then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E5: an unchanged save bumped the version'); n_fail := n_fail + 1; end if;

  -- ═══ F. THE TRAIL ═══════════════════════════════════════════════════════
  select count(*) into v_ver from public.order_submission_activity
   where submission_id = k_draft and action = 'product_details_updated';
  if v_ver >= 2 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F1: %s activity rows', v_ver)); n_fail := n_fail + 1; end if;

  select metadata -> 'changed' -> 'product_name' ->> 'from' into v_txt
    from public.order_submission_activity
   where submission_id = k_draft and action = 'product_details_updated'
   order by created_at limit 1;
  if v_txt = 'Oak sideboard' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F2: previous value recorded as %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- NO IMAGE BYTES AND NO SIGNED URL in the metadata, ever
  select count(*) into v_ver from public.order_submission_activity
   where submission_id = k_draft
     and (metadata::text like '%data:image%' or metadata::text like '%token=%'
          or metadata::text like '%image_storage_path%');
  if v_ver = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F3: image data or a signed URL reached Activity'); n_fail := n_fail + 1; end if;

  if n_fail = 0 then
    raise notice 'ALL ASSERTIONS PASSED (% checks)', n_pass;
  else
    foreach v_report in array failures loop raise notice 'FAIL  %', v_report; end loop;
    raise exception '% passed, % FAILED', n_pass, n_fail;
  end if;
end $$;

rollback;
