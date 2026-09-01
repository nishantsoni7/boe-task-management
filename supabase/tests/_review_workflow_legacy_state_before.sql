-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — the exact legacy dataset 20261025000000 is written against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20261025000000 deletes the sixteen rehearsal cards and refuses to run unless
-- the database still holds exactly them. That refusal is the whole value of the
-- file, and it can only be tested against a database that actually holds the
-- shape it expects — which no test database does by accident.
--
-- So this reproduces production as it was read on 2026-08-31:
--
--   * fifteen AVAILABLE cards carrying RW-000001 and RW-000003..RW-000016, the
--     references 20261023000000 produced by renaming the seed;
--   * one BOOKED card still carrying TEST-002, because 20261023000000 was not
--     allowed to rewrite a card somebody was holding;
--   * an audit trail on the booked one, and a screenshot on it, so the cascade
--     has something to cascade;
--   * no batches.
--
-- Applied only by run_customer_review_outreach_local.sh, into a database that
-- has already been proved disposable, immediately before 20261025000000. The
-- migration deletes every row below, which is what the runner then checks.
--
-- THE BODIES ARE FILLER. They describe nothing, name nobody, and are about to
-- be deleted; they exist to satisfy the column CHECKs.

-- The candidate who was holding TEST-002. A distinct id prefix from the probe
-- (eeeeeeee-) and from the assertion fixtures (ffffffff-), so no cleanup can
-- reach another's rows.
insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
values ('bbbbbbbb-0000-4000-8000-000000000001', 'Legacy Holder',
        'legacy.holder@example.test', 'member', 'sales', true, now(), now())
on conflict (id) do nothing;

-- ── The fifteen that were still available ───────────────────────────────────
insert into public.customer_review_test_cards
  (id, card_ref, status, test_category, test_title, test_body)
select
  ('bbbbbbbb-0000-4000-8000-1' || lpad(n::text, 11, '0'))::uuid,
  'RW-' || lpad(n::text, 6, '0'),
  'available',
  'restaurant_test',
  'Legacy sample draft ' || n,
  'Legacy filler body number ' || n || '. It describes nothing and is attributed to nobody, and exists only so the deletion migration has a row of the right shape to remove.'
  from generate_series(1, 16) n
 where n <> 2;

-- ── The one somebody had booked ─────────────────────────────────────────────
insert into public.customer_review_test_cards
  (id, card_ref, status, test_category, test_title, test_body, booked_by, booked_at)
values
  ('bbbbbbbb-0000-4000-8000-100000000002', 'TEST-002', 'booked',
   'cafe_test', 'Legacy booked card',
   'Legacy filler body for the one card somebody was holding when the drafts migration ran. It describes nothing and is attributed to nobody.',
   'bbbbbbbb-0000-4000-8000-000000000001', now());

-- ── Its trail, and one screenshot, so the cascade is exercised ──────────────
insert into public.customer_review_test_card_events
  (card_id, event_type, previous_status, new_status, detail, actor_id)
values
  ('bbbbbbbb-0000-4000-8000-100000000002', 'booked', 'available', 'booked',
   'Legacy trail row.', 'bbbbbbbb-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-100000000002', 'whatsapp_opened', null, null,
   'Legacy trail row.', 'bbbbbbbb-0000-4000-8000-000000000001');

insert into public.customer_review_test_card_screenshots
  (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
values
  ('bbbbbbbb-0000-4000-8000-100000000002', 'test_screenshot',
   'bbbbbbbb-0000-4000-8000-100000000002/test_screenshot/legacy.png', 'legacy.png',
   'image/png', 1024, repeat('c', 64), 'bbbbbbbb-0000-4000-8000-000000000001');

-- What was here, so the runner can assert that all of it went and nothing else
-- did. Dropped by the runner once it has read it.
create table if not exists public.zz_review_workflow_legacy_probe as
  select count(*)                                                   as cards,
         count(*) filter (where status = 'available')               as available,
         count(*) filter (where status = 'booked')                  as booked
    from public.customer_review_test_cards;
