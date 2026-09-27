-- ═══════════════════════════════════════════════════════════════════════════
-- 20270202000000  NEW PI VERSIONS PRINT THE STORED ORDER NUMBER ("0526")
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The deliberate second step after 20270201000000. That migration gave every
-- PI version its own pdf_order_number and, while the old PDF route (which
-- formats the Order's number, "526") could still be live, stamped new versions
-- with that same old form — so no version's PDF could print one thing and later
-- another.
--
-- APPLY ONLY WHEN the PDF route that prints the STORED value
-- (piVersionPdfOrderNumber(version.pdf_order_number), PR #243) is the only
-- deployment serving: promoted, and no earlier deployment still answering. From
-- here on a new version is stamped with the Order's stored display_number,
-- "0526", which that route prints.
--
-- WHAT IT CHANGES: one line of order_pi_versions_pdf_order_number() — the value
-- a NEW version is stamped with. Nothing stored changes: every existing version
-- keeps its value (the same function refuses any change to it), including
-- versions created between the two migrations, which keep "526" because that is
-- what their PDF printed. The refusal of an Order with no number, the
-- immutability, the grants and the trigger itself are unchanged.
--
-- AFTER THIS, the earlier route must not come back: it would print "526" for a
-- version stored as "0526". A rollback of the app past #243 needs this
-- migration's down first, and versions created in between then print
-- differently on the earlier route — fix forward instead.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'order_pi_versions' and column_name = 'pdf_order_number')
     or to_regprocedure('public.order_pi_versions_pdf_order_number()') is null then
    raise exception 'DEPENDENCY MISSING: 20270201000000 must be applied before this migration';
  end if;
end $$;

create or replace function public.order_pi_versions_pdf_order_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number text;
begin
  if tg_op = 'INSERT' then
    select nullif(btrim(coalesce(o.display_number, '')), '') into v_number
      from public.orders o where o.id = new.order_id;
    if v_number is null then
      raise exception 'ORDER_PI_VERSION_ORDER_NUMBER_MISSING: the Order of this PI version has no Order number'
        using errcode = 'P0001';
    end if;
    -- Whatever the caller passed, the version prints the Order's stored number.
    new.pdf_order_number := v_number;
    return new;
  end if;

  if new.pdf_order_number is distinct from old.pdf_order_number then
    raise exception 'PI_PDF_ORDER_NUMBER_IMMUTABLE: the Order number printed on PI version % cannot be changed', old.id
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.order_pi_versions_pdf_order_number() from public, anon, authenticated, service_role;

comment on function public.order_pi_versions_pdf_order_number() is
  'BEFORE INSERT: sets pdf_order_number to the Order''s stored display_number ("0526"), refusing an Order with none. BEFORE UPDATE: refuses any change to it. Covers every door that creates or decides a PI version. 20270201000000; stored form since 20270202000000.';

do $$
declare
  v_src text := (select prosrc from pg_proc where oid = 'public.order_pi_versions_pdf_order_number()'::regprocedure);
begin
  if v_src like '%order_operational_number%' or v_src not like '%new.pdf_order_number := v_number;%' then
    raise exception 'ASSERTION FAILED: new PI versions are not stamped with the stored Order number';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.order_pi_versions'::regclass
                    and tgname = 'order_pi_versions_pdf_order_number' and not tgisinternal) then
    raise exception 'ASSERTION FAILED: the pdf_order_number trigger is not installed';
  end if;
end $$;
