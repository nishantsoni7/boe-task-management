-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — the 20261023000000 rewrite guard, checked where it still can be
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS USED TO BE SECTION 0A OF customer_review_test_card_assertions.sql, and
-- it moved for a scheduling reason rather than a substantive one.
--
-- 20261025000000 removes the legacy dataset, and it refuses to run unless the
-- card table matches the legacy fingerprint EXACTLY. The three probe cards
-- _review_workflow_drafts_before.sql leaves behind are not part of that
-- fingerprint, so they have to be checked and cleared BEFORE that migration is
-- applied — which is earlier than the assertion file runs.
--
-- Nothing about what is proved has changed. The block below is the one that was
-- there, unedited: the AVAILABLE probe card must have been rewritten, the
-- BOOKED and VERIFIED ones must be byte-for-byte what they were, and the probe
-- rows clear themselves out afterwards.
--
-- Applied only by run_customer_review_outreach_local.sh, immediately after
-- 20261023000000, into a database that has already been proved disposable.

-- ─── 0A. THE REWRITE TOUCHED ONLY WHAT WAS STILL AVAILABLE ─────────────────
--
-- _review_workflow_drafts_before.sql put three cards down before
-- 20261023000000 ran: one available, one booked, one verified. The migration
-- was allowed to rewrite exactly one of them.
--
-- This runs first, because it is the only claim in this file that is about
-- something that has ALREADY happened, and because it clears its own rows out
-- of the pool before section 2 counts it.

do $$
declare
  v_probe   record;
  v_now     record;
  v_changed integer := 0;
begin
  if to_regclass('public.zz_review_workflow_rewrite_probe') is null then
    raise exception '0A has no probe table; _review_workflow_drafts_before.sql did not run';
  end if;

  for v_probe in select * from public.zz_review_workflow_rewrite_probe order by card_ref loop
    select * into v_now from public.customer_review_test_cards where id = v_probe.id;
    if v_now.id is null then
      raise exception 'the migration DELETED probe card %', v_probe.card_ref;
    end if;

    if v_probe.status = 'available' then
      -- The one it was allowed to touch. It must actually have been rewritten,
      -- or the migration silently did nothing and every other assertion here
      -- would pass vacuously.
      if v_now.test_body = v_probe.test_body then
        raise exception 'the AVAILABLE card % was not rewritten at all', v_probe.card_ref;
      end if;
      if v_now.card_ref !~ '^RW-[0-9]{6}$' then
        raise exception 'the rewritten card kept reference %', v_now.card_ref;
      end if;
      if v_now.status <> 'available' then
        raise exception 'the rewrite moved card % to status %', v_probe.card_ref, v_now.status;
      end if;
      if length(v_now.test_body) < 100 then
        raise exception 'the replacement body is % characters, which is not a review',
          length(v_now.test_body);
      end if;
      v_changed := v_changed + 1;
      raise notice 'PASS  0A1. the available card was rewritten: % → %, % characters',
        v_probe.card_ref, v_now.card_ref, length(v_now.test_body);
    else
      -- Everything else is somebody's record, and every field of it has to be
      -- exactly what it was.
      if v_now.card_ref  <> v_probe.card_ref
      or v_now.test_body <> v_probe.test_body
      or v_now.test_title<> v_probe.test_title
      or v_now.test_category <> v_probe.test_category
      or v_now.status    <> v_probe.status then
        raise exception 'THE MIGRATION REWROTE A % CARD (%): ref %→%, title %→%',
          v_probe.status, v_probe.card_ref, v_probe.card_ref, v_now.card_ref,
          v_probe.test_title, v_now.test_title;
      end if;
      raise notice 'PASS  0A2. the % card % was left exactly as it was', v_probe.status, v_probe.card_ref;
    end if;
  end loop;

  if v_changed <> 1 then
    raise exception '0A expected exactly one rewritten card, saw %', v_changed;
  end if;

  -- And no generated card can claim a reference the rewrite already used.
  if (select count(*) from public.customer_review_test_cards where card_ref = 'RW-000001') > 1 then
    raise exception 'RW-000001 is not unique';
  end if;
end $$;

-- Clear the probe out, so the pool section that follows counts only its own.
do $$
begin
  delete from public.customer_review_test_cards
   where id::text like 'eeeeeeee-0000-4000-8000-%';
  delete from public.users
   where id::text like 'eeeeeeee-0000-4000-8000-%';
  drop table if exists public.zz_review_workflow_rewrite_probe;
  raise notice 'PASS  0A3. probe rows removed; the pool is back to what this file owns';
end $$;
