-- Client choices with any name (owner, 2026-11-25, quotation page version 2, step 3). A product's client choices were four fixed kinds
-- (fabric, finish, stone, rope_weave). The sales person can now add any other choice (leather, marble top, cushion piping...):
--   * the four fixed keys stay as they are;
--   * any other choice is stored under a key 'x_' + 2 to 24 lower-case letters or digits (the page uses 'x_' + the time in base 36, so the
--     cards keep the order they were added in) and MUST carry its name in a new field 'label' (up to 40 characters);
--   * a product holds at most 12 choices.
-- Only quotation_line_choices_ok's body changes (same signature, same grants). The CHECK on quotation_lines.client_choices calls it, so
-- every stored row still passes (the old rule is a strict subset of the new one). No table, column or row changes: no backup is needed
-- under the owner's rule. quotation_client_doc already copies every key of client_choices minus 'note' (20270820000000), so the client's
-- copy carries a custom choice and its label with no change; quotation_costing_view reads only 'fabric'.
-- Rollback (by hand): once no row holds an 'x_' key or a 'label', re-create quotation_line_choices_ok from 20270819000000.

begin;

create or replace function public.quotation_line_choices_ok(p jsonb)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and (select count(*) from jsonb_object_keys(p)) <= 12
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('fabric', 'finish', 'stone', 'rope_weave') and k !~ '^x_[a-z0-9]{2,24}$')
    and not exists (
      select 1 from jsonb_each(p) e(k, v)
      where jsonb_typeof(e.v) <> 'object'
         or coalesce(e.v->>'source', '') not in ('catalog', 'client', 'code')
         or coalesce(e.v->>'status', '') not in ('to_confirm', 'confirmed')
         or exists (select 1 from jsonb_object_keys(e.v) kk where kk not in ('source', 'label', 'name', 'code', 'supplier', 'used_for', 'note', 'photo', 'status', 'confirmed_on'))
         or exists (select 1 from jsonb_each(e.v) f(fk, fv) where jsonb_typeof(f.fv) not in ('string', 'null'))
         or (e.k like 'x\_%' and btrim(coalesce(e.v->>'label', '')) = '')
         or char_length(coalesce(e.v->>'label', '')) > 40
         or char_length(coalesce(e.v->>'name', '')) > 200
         or char_length(coalesce(e.v->>'code', '')) > 80
         or char_length(coalesce(e.v->>'supplier', '')) > 120
         or char_length(coalesce(e.v->>'used_for', '')) > 160
         or char_length(coalesce(e.v->>'note', '')) > 400
         or (coalesce(e.v->>'photo', '') <> '' and e.v->>'photo' !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$')
         or (coalesce(e.v->>'confirmed_on', '') <> '' and (e.v->>'confirmed_on' !~ '^\d{4}-\d{2}-\d{2}$' or e.v->>'status' <> 'confirmed'))))
$$;
revoke all on function public.quotation_line_choices_ok(jsonb) from public, anon, authenticated;

-- Self-check: refuse to commit if the rule is not what the page relies on.
do $$
declare
  twelve jsonb := (select jsonb_object_agg('x_k' || lpad(i::text, 2, '0'), '{"source":"client","status":"to_confirm","label":"Leather"}'::jsonb) from generate_series(1, 12) i);
  thirteen jsonb := twelve || '{"fabric":{"source":"client","status":"to_confirm"}}'::jsonb;
begin
  if has_function_privilege('anon', 'public.quotation_line_choices_ok(jsonb)', 'execute') then
    raise exception 'QUOTATION_CHOICES_ANY_NAME: the checker must not be open to anon';
  end if;
  if not public.quotation_line_choices_ok('{"x_mf0a1b2c":{"source":"client","status":"to_confirm","label":"Leather","name":"Tan nubuck"}}'::jsonb)
     or not public.quotation_line_choices_ok('{"fabric":{"source":"code","status":"to_confirm","code":"F-2210"},"stone":{"source":"catalog","status":"confirmed","confirmed_on":"2026-11-25"}}'::jsonb)
     or not public.quotation_line_choices_ok(twelve)
     or not public.quotation_line_choices_ok('{}'::jsonb)
     or public.quotation_line_choices_ok(thirteen)
     or public.quotation_line_choices_ok('{"x_mf0a1b2c":{"source":"client","status":"to_confirm"}}'::jsonb)
     or public.quotation_line_choices_ok('{"x_mf0a1b2c":{"source":"client","status":"to_confirm","label":"  "}}'::jsonb)
     or public.quotation_line_choices_ok('{"leather":{"source":"client","status":"to_confirm","label":"Leather"}}'::jsonb)
     or public.quotation_line_choices_ok('{"x_MF0A":{"source":"client","status":"to_confirm","label":"Leather"}}'::jsonb)
     or public.quotation_line_choices_ok('{"x_a":{"source":"client","status":"to_confirm","label":"Leather"}}'::jsonb)
     or public.quotation_line_choices_ok(jsonb_build_object('x_mf0a1b2c', jsonb_build_object('source', 'client', 'status', 'to_confirm', 'label', repeat('a', 41))))
     or public.quotation_line_choices_ok('{"x_mf0a1b2c":{"source":"x","status":"to_confirm","label":"Leather"}}'::jsonb)
     or public.quotation_line_choices_ok('{"fabric":{"source":"client","status":"to_confirm","colour":"red"}}'::jsonb) then
    raise exception 'QUOTATION_CHOICES_ANY_NAME: the choices checker is wrong';
  end if;
end $$;

commit;
