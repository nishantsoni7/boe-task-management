-- ═══════════════════════════════════════════════════════════════════════════
-- 20270203000000  THE PI VERSION PDF READS ITS CONTENT THROUGH ITS OWN DOOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- order_pi_version_pdf_detail(uuid) is an exact copy of
-- order_pi_version_detail(uuid) (20270116000000): the same body, the same
-- result shape ({source, content}), the same security definer and search_path,
-- the same volatility, and the same EXECUTE grants. The PI version PDF route and
-- the PI versions panel move to it. Nothing else changes, and nothing is
-- refused: both functions answer every caller identically.
--
-- WHY A SECOND NAME. Every deployment built before this file (production
-- builds, branch previews) calls order_pi_version_detail() and then prints the
-- Order number by formatting display_number itself ("526"). A later migration
-- can then make order_pi_version_detail() refuse exactly the versions whose
-- stored PDF number differs from that formatting ("0526"), so those builds
-- answer 404 instead of printing a wrong number, while builds that call this
-- copy keep working. This file only adds the copy; it refuses nothing.
--
-- The assertions at the end compare the two functions in the catalog, so the
-- copy cannot silently drift from the original it replaces for these callers.

do $$
begin
  if to_regprocedure('public.order_pi_version_detail(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: order_pi_version_detail(uuid) (20270116000000) must exist before this migration';
  end if;
end $$;

create or replace function public.order_pi_version_pdf_detail(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   public.order_pi_versions%rowtype;
  v_c jsonb;
begin
  select * into v from public.order_pi_versions where id = p_version_id;
  if not found or not coalesce(public.can_view_order_as_actor(v.order_id), false) then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  if v.status = 'approved' then
    return jsonb_build_object('source', 'live', 'content', null);
  end if;
  select content into v_c from public.order_pi_version_contents where version_id = v.id;
  if v_c is not null then
    return jsonb_build_object('source', 'captured', 'content', v_c);
  end if;
  if v.source_kind = 'edit' then
    return jsonb_build_object('source', 'proposal', 'content', v.proposal);
  end if;
  if v.status = 'superseded' then
    select sp.superseded_snapshot into v_c from public.order_pi_revision_staged_parses sp
     where sp.version_id = v.superseded_by_version_id;
    return jsonb_build_object('source', case when v_c is null then 'none' else 'snapshot' end, 'content', v_c);
  end if;
  select sp.payload - 'processing_token' into v_c from public.order_pi_revision_staged_parses sp where sp.version_id = v.id;
  return jsonb_build_object('source', case when v_c is null then 'none' else 'staged' end,
                            'content', case when v_c is null then null else jsonb_build_object('payload', v_c) end);
end;
$$;
comment on function public.order_pi_version_pdf_detail(uuid) is
  'What one PI version contained, for the signed-in person if they may open its Order (can_view_order_as_actor): {source: live | captured | proposal | snapshot | staged | none, content}. Read-only. An exact copy of order_pi_version_detail(uuid), called by the PI version PDF route and the PI versions panel. 20270203000000.';
revoke execute on function public.order_pi_version_pdf_detail(uuid) from public, anon;
grant  execute on function public.order_pi_version_pdf_detail(uuid) to authenticated;


-- ═══ ASSERTIONS: the copy is the original, under a second name ═════════════

do $$
declare
  o pg_proc;
  c pg_proc;
begin
  select * into o from pg_proc where oid = 'public.order_pi_version_detail(uuid)'::regprocedure;
  select * into c from pg_proc where oid = 'public.order_pi_version_pdf_detail(uuid)'::regprocedure;
  -- Line endings depend on the checkout a migration was pushed from; compare without \r.
  if replace(c.prosrc, E'\r', '') is distinct from replace(o.prosrc, E'\r', '') then
    raise exception 'ASSERTION FAILED: order_pi_version_pdf_detail body differs from order_pi_version_detail';
  end if;
  if (c.prorettype, c.proretset, c.provolatile, c.prosecdef, c.prolang, c.proargtypes::text, c.proargnames::text, c.proconfig::text, c.proowner)
     is distinct from
     (o.prorettype, o.proretset, o.provolatile, o.prosecdef, o.prolang, o.proargtypes::text, o.proargnames::text, o.proconfig::text, o.proowner) then
    raise exception 'ASSERTION FAILED: order_pi_version_pdf_detail signature, volatility, security or settings differ';
  end if;
  if (select array_agg(a::text order by a::text) from unnest(c.proacl) a)
     is distinct from (select array_agg(a::text order by a::text) from unnest(o.proacl) a) then
    raise exception 'ASSERTION FAILED: order_pi_version_pdf_detail grants differ: % vs %', c.proacl, o.proacl;
  end if;
  if has_function_privilege('anon', c.oid, 'execute') or not has_function_privilege('authenticated', c.oid, 'execute') then
    raise exception 'ASSERTION FAILED: order_pi_version_pdf_detail must be executable by authenticated only';
  end if;
end $$;
