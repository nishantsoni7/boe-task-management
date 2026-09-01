-- ═══════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — a builder for the legacy dataset, in every shape the guard in
-- 20261025000000 has to judge
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT A MIGRATION, and it is applied only by
-- supabase/tests/run_customer_review_outreach_local.sh, against a database that
-- has already declared itself disposable.
--
-- WHY IT EXISTS. 20261025000000 permanently deletes sixteen production rows,
-- and the only thing standing between it and a mistake is its guard. The runner
-- already proves the guard refuses a screenshot and accepts the 15/1 state that
-- was read on 2026-08-31. That is one accept and one refuse; this file gives
-- the runner a way to try every other shape.
--
-- THE POINT IS THE PAIR. The guard has to accept the shapes that ARE the legacy
-- dataset — including the 13/3 split production had drifted to by 2026-09-01,
-- and including a card whose holder merely opened WhatsApp — and refuse
-- everything else. A guard that only ever refuses is as useless as one that
-- only ever accepts; it just fails in the other direction.
--
-- Every card it writes is a `bbbbbbbb-…` id, so build_legacy() can clear its
-- own work without a predicate that could ever match somebody's data.

create or replace function public.zz_build_legacy(p_case text)
returns void
language plpgsql
as $$
declare
  v_holder uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  v_booked uuid := 'bbbbbbbb-0000-4000-8000-100000000002';  -- TEST-002
  v_first  uuid := 'bbbbbbbb-0000-4000-8000-100000000001';  -- RW-000001
  v_third  uuid := 'bbbbbbbb-0000-4000-8000-100000000003';  -- RW-000003
begin
  -- ── Start from nothing every time ────────────────────────────────────────
  delete from public.customer_review_test_card_screenshots
   where card_id::text like 'bbbbbbbb-0000-4000-8000-%';
  delete from public.customer_review_test_card_events
   where card_id::text like 'bbbbbbbb-0000-4000-8000-%';
  delete from public.customer_review_test_cards
   where id::text like 'bbbbbbbb-0000-4000-8000-%';
  -- storage.protect_delete refuses a direct DELETE, which is the whole reason
  -- the deletion migration must never strand an object. The guard is suspended
  -- for the length of this statement only; this harness wrote the ROW and there
  -- is no file behind it, so nothing is being orphaned.
  set local session_replication_role = 'replica';
  delete from storage.objects
   where bucket_id = 'customer-review-test-screenshots'
     and name like 'bbbbbbbb-0000-4000-8000-%';
  set local session_replication_role = 'origin';

  insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
  values (v_holder, 'Legacy Holder', 'legacy.holder@example.test', 'member', 'sales', true, now(), now())
  on conflict (id) do nothing;

  -- ── The sixteen, as 20261023000000 left them ─────────────────────────────
  --
  -- TEST-002 kept its seed reference because it was booked when that migration
  -- renamed the available cards; every other seed became RW-00000n with the
  -- same n. Hence no RW-000002 — which is the single most load-bearing fact in
  -- the whole fingerprint.
  insert into public.customer_review_test_cards
    (id, card_ref, status, test_category, test_title, test_body)
  select
    ('bbbbbbbb-0000-4000-8000-1' || lpad(n::text, 11, '0'))::uuid,
    'RW-' || lpad(n::text, 6, '0'),
    'available', 'restaurant_test',
    'Legacy sample draft ' || n,
    'Legacy filler body number ' || n || '. It describes nothing and is attributed to nobody, and exists only so the deletion migration has a row of the right shape to judge.'
    from generate_series(1, 16) n
   where n <> 2;

  insert into public.customer_review_test_cards
    (id, card_ref, status, test_category, test_title, test_body, booked_by, booked_at)
  values (v_booked, 'TEST-002', 'booked', 'cafe_test', 'Legacy booked card',
          'Legacy filler body for the one card somebody had taken. It describes nothing and is attributed to nobody.',
          v_holder, now());

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values (v_booked, 'booked', 'available', 'booked', 'Legacy trail row.', v_holder);

  -- That is the 15/1 shape. Everything below is one deviation from it.

  if p_case = 'split_15_1' then
    return;

  -- ── THE SHAPE PRODUCTION ACTUALLY HAD ON 2026-09-01 ──────────────────────
  --
  -- Two colleagues booked reviews after the fingerprint was captured. Nothing
  -- is wrong with that, and the guard must accept it: booking is reversible and
  -- carries no claim about a real person.
  elsif p_case in ('split_13_3', 'whatsapp_only') then
    update public.customer_review_test_cards
       set status = 'booked', booked_by = v_holder, booked_at = now()
     where id in (v_first, v_third);
    insert into public.customer_review_test_card_events
      (card_id, event_type, previous_status, new_status, detail, actor_id)
    select id, 'booked', 'available', 'booked', 'Legacy trail row.', v_holder
      from public.customer_review_test_cards where id in (v_first, v_third);

    -- AND ONE OF THEM OPENED WHATSAPP, which production had too. Opening a link
    -- builds text and hands it to WhatsApp; the module has never read it as
    -- evidence that anything was sent, and the guard must not either.
    if p_case = 'whatsapp_only' then
      update public.customer_review_test_cards
         set whatsapp_opened_at = now(), whatsapp_opened_count = 1,
             whatsapp_target_last_four = '4321'
       where id = v_first;
      insert into public.customer_review_test_card_events
        (card_id, event_type, detail, actor_id)
      values (v_first, 'whatsapp_opened', 'Legacy trail row.', v_holder);
    end if;
    return;

  -- ── The deviations that must REFUSE ──────────────────────────────────────

  -- A person stated by hand that a message left their phone and reached a real
  -- recipient. That is the one fact that makes a review undeletable here.
  elsif p_case = 'sent_confirmed' then
    update public.customer_review_test_cards
       set sent_confirmed_at = now(), sent_confirmed_by = v_holder,
           whatsapp_opened_at = now(), whatsapp_opened_count = 1,
           whatsapp_target_last_four = '4321'
     where id = v_booked;
    return;

  elsif p_case = 'submitted' then
    update public.customer_review_test_cards
       set status = 'submitted', submitted_at = now(), submitted_by = v_holder,
           sent_confirmed_at = now(), sent_confirmed_by = v_holder,
           whatsapp_opened_at = now(), whatsapp_opened_count = 1,
           whatsapp_target_last_four = '4321'
     where id = v_booked;
    return;

  -- A returned review is booked again, but it has been through submission — so
  -- it necessarily carries a send confirmation.
  elsif p_case = 'returned' then
    update public.customer_review_test_cards
       set returned_at = now(), returned_by = v_holder,
           return_reason = 'Legacy return reason.',
           submitted_at = now(), submitted_by = v_holder,
           sent_confirmed_at = now(), sent_confirmed_by = v_holder,
           whatsapp_opened_at = now(), whatsapp_opened_count = 1,
           whatsapp_target_last_four = '4321'
     where id = v_booked;
    return;

  elsif p_case = 'verified' then
    update public.customer_review_test_cards
       set status = 'verified', verified_at = now(), verified_by = v_holder,
           submitted_at = now(), submitted_by = v_holder,
           sent_confirmed_at = now(), sent_confirmed_by = v_holder,
           whatsapp_opened_at = now(), whatsapp_opened_count = 1,
           whatsapp_target_last_four = '4321'
     where id = v_booked;
    return;

  -- A screenshot ROW. SQL cannot remove the object it names, so deleting the
  -- card would strand the image.
  elsif p_case = 'screenshot' then
    insert into public.customer_review_test_card_screenshots
      (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
    values (v_booked, 'test_screenshot',
            'bbbbbbbb-0000-4000-8000-100000000002/test_screenshot/legacy.png', 'legacy.png',
            'image/png', 1024, repeat('c', 64), v_holder);
    return;

  -- An OBJECT with no row pointing at it — the orphan the row check cannot see,
  -- and the reason the bucket is counted separately.
  elsif p_case = 'storage_object' then
    insert into storage.objects (bucket_id, name, owner)
    values ('customer-review-test-screenshots',
            'bbbbbbbb-0000-4000-8000-100000000002/test_screenshot/orphan.png', null);
    return;

  -- Seventeen cards: something new arrived.
  elsif p_case = 'extra_card' then
    insert into public.customer_review_test_cards
      (id, card_ref, status, test_category, test_title, test_body)
    values ('bbbbbbbb-0000-4000-8000-100000000099', 'RW-000099', 'available',
            'hotel_test', 'A card that is not part of the legacy dataset',
            'Legacy filler body for a card that arrived after the fingerprint was taken. It describes nothing.');
    return;

  -- Fifteen cards: one of the legacy sixteen is missing.
  elsif p_case = 'missing_card' then
    delete from public.customer_review_test_card_events where card_id = v_third;
    delete from public.customer_review_test_cards where id = v_third;
    return;

  -- STILL SIXTEEN, BUT NOT THE SIXTEEN. This is the case a pattern match would
  -- have accepted and a set comparison refuses: RW-000002 cannot exist, because
  -- the card that would carry it is TEST-002.
  elsif p_case = 'wrong_ref' then
    update public.customer_review_test_cards
       set card_ref = 'RW-000002' where id = v_third;
    return;

  -- A generated batch means the module has moved on and these are no longer the
  -- whole story.
  elsif p_case = 'with_batch' then
    -- CARD_COUNT IS 20 HERE, NOT 8, AND THAT IS NOT A TYPO. These cases run at
    -- the point in the chain where 20261025000000 is applied — 20261026000000
    -- has not run yet, so the batch table is still the one 20261023000000
    -- created, whose CHECK is `card_count = 20` and which has no
    -- expected_count column at all. Writing the newer shape here fails to
    -- build, which is how this comment came to be written.
    insert into public.customer_review_draft_batches
      (id, generated_by, guidance, model, card_count)
    values ('bbbbbbbb-0000-4000-8000-200000000001', v_holder,
            'A batch that exists.', 'claude-opus-5', 20);
    return;

  else
    raise exception 'zz_build_legacy: unknown case %', p_case;
  end if;
end;
$$;

-- Clearing up after the cases, including the batch row, which nothing else
-- reaches.
create or replace function public.zz_clear_legacy()
returns void
language plpgsql
as $$
begin
  delete from public.customer_review_test_card_screenshots
   where card_id::text like 'bbbbbbbb-0000-4000-8000-%';
  delete from public.customer_review_test_card_events
   where card_id::text like 'bbbbbbbb-0000-4000-8000-%';
  delete from public.customer_review_test_cards
   where id::text like 'bbbbbbbb-0000-4000-8000-%';
  delete from public.customer_review_draft_batches
   where id::text like 'bbbbbbbb-0000-4000-8000-%';
  -- storage.objects refuses a direct delete; the guard is suspended for the
  -- length of one statement, exactly as the assertions file does at its own
  -- clean-up. This harness only ever wrote the ROW — there is no file.
  set local session_replication_role = 'replica';
  delete from storage.objects
   where bucket_id = 'customer-review-test-screenshots'
     and name like 'bbbbbbbb-0000-4000-8000-%';
  set local session_replication_role = 'origin';
end;
$$;
