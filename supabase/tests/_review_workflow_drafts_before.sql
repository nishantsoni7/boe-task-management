-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — the state 20261023000000 is about to rewrite
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20261023000000 replaces the sixteen filler cards with natural review drafts,
-- and it may only touch the ones still `available`. A card somebody has booked,
-- submitted or had verified is workflow evidence: rewriting it would silently
-- change what a verifier approved.
--
-- That guarantee is a `where status = 'available'` in the migration, and there
-- is no way to check it after the fact — by the time the assertions run, the
-- migration has already decided. So this file lays down three cards in three
-- states BEFORE it runs, records exactly what they said, and section 0A of
-- customer_review_test_card_assertions.sql compares afterwards.
--
-- Applied only by run_customer_review_outreach_local.sh, between
-- 20261017000000 and 20261023000000, into a database that has already been
-- proved disposable. It cleans up after itself in section 0A.

-- Somebody to have booked and verified the cards. Distinct id prefix from the
-- assertion fixtures (ffffffff-…) so neither cleanup can reach the other's rows.
insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
values ('eeeeeeee-0000-4000-8000-000000000001', 'Probe Holder',
        'probe.holder@example.test', 'member', 'sales', true, now(), now())
on conflict (id) do nothing;

insert into public.customer_review_test_cards
  (id, card_ref, status, test_category, test_title, test_body,
   booked_by, booked_at, sent_confirmed_by, sent_confirmed_at,
   submitted_by, submitted_at, verified_by, verified_at)
values
  -- Still available: this one is the migration's to rewrite.
  ('eeeeeeee-0000-4000-8000-00000000000a', 'TEST-001', 'available',
   'restaurant_test', 'Probe filler one',
   'Filler body for the available probe card, long enough for the column check.',
   null, null, null, null, null, null, null, null),

  -- Booked by somebody. Their work in progress.
  ('eeeeeeee-0000-4000-8000-00000000000b', 'TEST-002', 'booked',
   'cafe_test', 'Probe filler two',
   'Filler body for the booked probe card, long enough for the column check.',
   'eeeeeeee-0000-4000-8000-000000000001', now(), null, null, null, null, null, null),

  -- Verified. Finished evidence, and the strongest case for not touching it.
  ('eeeeeeee-0000-4000-8000-00000000000c', 'TEST-003', 'verified',
   'hotel_test', 'Probe filler three',
   'Filler body for the verified probe card, long enough for the column check.',
   'eeeeeeee-0000-4000-8000-000000000001', now(),
   'eeeeeeee-0000-4000-8000-000000000001', now(),
   'eeeeeeee-0000-4000-8000-000000000001', now(),
   'eeeeeeee-0000-4000-8000-000000000001', now());

-- What they said before the migration, kept where the assertions can read it.
create table if not exists public.zz_review_workflow_rewrite_probe as
  select id, card_ref, status, test_title, test_body, test_category
    from public.customer_review_test_cards
   where id::text like 'eeeeeeee-0000-4000-8000-%';
