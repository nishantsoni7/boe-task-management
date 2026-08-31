-- ═════════════════════════════════════════════════════════════════════════════
-- Review Workflow — remove the legacy test dataset
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS DOES. It deletes every review card that predates the batch-approval
-- workflow, together with the screenshots and audit events that hang off them,
-- and the storage objects those screenshots point at.
--
-- WHY. The sixteen rows in production are rehearsal data. Fifteen were seeded
-- by 20261021000000 as fictional filler and rewritten into sample drafts by
-- 20261023000000; the sixteenth, TEST-002, was booked during the internal walk
-- through and never released. None of them came from a verifier's guidance,
-- none was ever approved, and under the workflow 20261026000000 installs an
-- unapproved card must not sit in the candidate-visible pool. Carrying them
-- forward would mean shipping sixteen reviews nobody approved.
--
-- Nishant approved removing all of it, TEST-002 and its trail included. That
-- reverses the earlier instruction to preserve TEST-002, which is why this is a
-- separate reviewable file rather than a clause inside the schema migration.
--
-- ═══ THE GUARD, WHICH IS THE POINT OF THE FILE ═══════════════════════════════
--
-- A bare `delete from customer_review_test_cards` would be correct today and
-- catastrophic on any day production has moved on — a batch generated between
-- this file being written and being applied would be deleted along with the
-- rehearsal rows, silently, with no way to tell afterwards.
--
-- So this refuses to run unless the database still looks EXACTLY like the state
-- that was read on 2026-08-31:
--
--   * exactly 16 cards, and not one more or fewer;
--   * every card_ref is a legacy reference — TEST-nnn, or RW-nnnnnn inside
--     RW-000001..RW-000016, the only range 20261023000000 could produce by
--     renaming the seed;
--   * no card belongs to a batch (batch_id is null on all sixteen);
--   * zero rows in customer_review_draft_batches;
--   * exactly 15 available and exactly 1 booked, and nothing submitted or
--     verified;
--   * no screenshot is attached to any of them — see below.
--
-- Any deviation raises and the transaction rolls back with nothing deleted,
-- which is what "fail loudly" has to mean for a destructive file: the operator
-- goes and reads production before this is applied again.
--
-- THE ONE STATE THAT IS ALLOWED THROUGH IS AN EMPTY ONE. Zero cards and zero
-- batches means either a fresh database that never held the rehearsal data or a
-- database this file has already cleaned; both are nothing-to-do rather than
-- something-unexpected, and there is no data to protect in either. Without that
-- branch this file would break the migration chain forever on any new Supabase
-- project, which is a landmine rather than a safeguard.
--
-- ═══ WHY IT REFUSES WHILE A SCREENSHOT EXISTS ════════════════════════════════
--
-- A screenshot is two things: a row in customer_review_test_card_screenshots
-- and an object in the private `customer-review-test-screenshots` bucket. The
-- row cascades away with its card. THE OBJECT CANNOT BE DELETED FROM SQL AT
-- ALL — storage.objects carries a protect_objects_delete trigger that refuses
-- direct deletion and tells the caller to use the Storage API, which is exactly
-- why this module removes an image in two steps through
-- /api/customer-reviews/photos rather than in one statement.
--
-- So a migration that deleted the cards while a screenshot existed would leave
-- a stored image with nothing in the database pointing at it: unreadable,
-- because the bucket's SELECT policy resolves through a card that no longer
-- exists, and unfindable, because the only record of its key has just been
-- cascaded away. That is worse than refusing.
--
-- The fix is one action in the product, not a change to this file: the holder
-- removes the screenshot while they still hold the card (a verifier returns the
-- card first if it has been submitted), and this file is applied afterwards.
--
-- IT DELETES NOTHING OUTSIDE THIS MODULE. It touches one table, and its two
-- child tables by cascade. No storage object, no other table, no bucket, no
-- user, no permission row.
--
-- ═══ THE PRE-FLIGHT, BEFORE THIS IS EVER APPLIED TO PRODUCTION ═══════════════
--
-- NOTHING BELOW IS AUTHORISED BY WRITING IT DOWN. This is the sequence to
-- follow when the removal is approved as a separate decision; no production
-- read, no removal and no application of this file has been performed.
--
-- 1. READ-ONLY: is there a screenshot, in either half?
--
--      select count(*) as metadata_rows
--        from public.customer_review_test_card_screenshots;
--
--      select count(*) as storage_objects
--        from storage.objects
--       where bucket_id = 'customer-review-test-screenshots';
--
--    BOTH must be zero. A metadata row with no object, or an object with no
--    metadata row, is itself a finding: stop and reconcile it before going on.
--
-- 2. READ-ONLY: does the legacy dataset still match this file's fingerprint?
--
--      select count(*)                                        as cards,
--             count(*) filter (where status = 'available')     as available,
--             count(*) filter (where status = 'booked')        as booked,
--             count(*) filter (where status not in ('available','booked')) as other,
--             count(*) filter (where batch_id is not null)     as batched,
--             count(*) filter (where card_ref !~ '^(TEST-[0-9]{3}|RW-[0-9]{6})$') as odd_refs
--        from public.customer_review_test_cards;
--
--      select count(*) as batches from public.customer_review_draft_batches;
--
--    Expected: cards 16, available 15, booked 1, other 0, batched 0,
--    odd_refs 0, batches 0. Anything else and this file will abort anyway —
--    reading first means finding out before a deploy rather than during one.
--
-- 3. IF STEP 1 IS ZERO AND STEP 2 MATCHES: the migration may be applied, after
--    explicit approval from Nishant for that specific application.
--
-- 4. IF A SCREENSHOT EXISTS: STOP. Do not apply this file and do not delete
--    anything by hand. The image comes off through the application's own
--    supported path and nothing else — the holder removes it while they hold
--    the card (a verifier returns a submitted card to its holder first), which
--    runs begin_/finish_customer_review_test_screenshot_removal and deletes the
--    stored object through the Storage API. That is a separate decision needing
--    its own confirmation. Then repeat steps 1 and 2 from the top.
--
-- 5. NEVER DELETE A CARD WHILE LEAVING AN UNREACHABLE OBJECT. This is the rule
--    the guard in section 6 enforces mechanically, and it is written here as
--    well because the guard can only refuse — it cannot explain, at three in
--    the morning, why refusing was right.
--
-- ORDER MATTERS. This file is numbered BEFORE 20261026000000 so the schema
-- migration lands on an empty table and can enforce its approval invariants
-- without a legacy exemption. A card with no approval record is not
-- expressible after that point, and there is no row here that would have needed
-- one.

do $$
declare
  v_cards      integer;
  v_batches    integer;
  v_available  integer;
  v_booked     integer;
  v_other      integer;
  v_batched    integer;
  v_bad_refs   text;
  v_deleted    integer;
  v_shots      integer;
begin
  -- ── 1. Count what is there ───────────────────────────────────────────────
  select count(*) into v_cards   from public.customer_review_test_cards;
  select count(*) into v_batches from public.customer_review_draft_batches;

  -- ── 1A. Nothing to do is not a failure ───────────────────────────────────
  --
  -- A fresh project, or a database this file has already been applied to. There
  -- is no rehearsal data to remove and none to endanger, so it returns quietly
  -- rather than aborting the chain. This is the ONLY state other than the exact
  -- legacy fingerprint that is allowed past.
  if v_cards = 0 and v_batches = 0 then
    raise notice 'SKIP  review-workflow legacy data: the card table is already empty; nothing to remove';
    return;
  end if;

  -- ── 2. Sixteen cards, exactly ────────────────────────────────────────────
  if v_cards <> 16 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: expected 16 legacy review cards, found %s.', v_cards),
      detail  = 'This migration removes a known rehearsal dataset and refuses to guess. Nothing was deleted.',
      hint    = 'Read the live table before applying this again. If production has legitimately moved on, the expected counts in this file must be re-derived and re-approved.';
  end if;

  -- ── 3. No generated batch exists ─────────────────────────────────────────
  --
  -- A batch row means somebody has generated reviews through the new workflow,
  -- which means the sixteen are no longer the whole story and this file is out
  -- of date.
  if v_batches <> 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: expected 0 draft batches, found %s.', v_batches),
      detail  = 'A generated batch exists, so the legacy dataset is not the only data present. Nothing was deleted.';
  end if;

  select count(*) into v_batched
    from public.customer_review_test_cards where batch_id is not null;
  if v_batched <> 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: %s card(s) belong to a batch.', v_batched),
      detail  = 'Every legacy card predates batch generation and must have a null batch_id. Nothing was deleted.';
  end if;

  -- ── 4. Every reference is a recognised legacy one ────────────────────────
  --
  -- 20261023000000 renamed the available seed cards TEST-00n -> RW-00000n, so
  -- the only RW- values a legacy database can hold are RW-000001..RW-000016.
  -- Anything outside that window came from create_customer_review_draft_batch,
  -- which starts numbering above the highest reference already in use.
  select string_agg(card_ref, ', ' order by card_ref) into v_bad_refs
    from public.customer_review_test_cards
   where not (
     card_ref ~ '^TEST-[0-9]{3}$'
     or (card_ref ~ '^RW-[0-9]{6}$'
         and substring(card_ref from 4)::integer between 1 and 16)
   );
  if v_bad_refs is not null then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: unrecognised reference(s): %s.', v_bad_refs),
      detail  = 'A legacy card carries TEST-nnn or RW-000001..RW-000016. Nothing was deleted.';
  end if;

  -- ── 5. The states are the states that were read ──────────────────────────
  select count(*) filter (where status = 'available'),
         count(*) filter (where status = 'booked'),
         count(*) filter (where status not in ('available', 'booked'))
    into v_available, v_booked, v_other
    from public.customer_review_test_cards;

  if v_available <> 15 or v_booked <> 1 or v_other <> 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: expected 15 available and 1 booked, found %s available, %s booked, %s in another state.',
        v_available, v_booked, v_other),
      detail  = 'Work has happened on these cards since the state this file was written against. Nothing was deleted.';
  end if;

  -- ── 6. No screenshot may be attached ─────────────────────────────────────
  --
  -- Including one already marked for removal: a half-removed screenshot is a
  -- stored object whose only remaining reference is the row about to be
  -- cascaded away, which is the same orphan by a slower route.
  --
  -- SQL CANNOT CLEAN UP AFTER ITSELF HERE. storage.objects refuses a direct
  -- delete (storage.protect_delete), so deleting the cards would strand the
  -- images: unreadable, because the bucket policy resolves through a card that
  -- no longer exists, and unfindable, because the rows naming their keys go
  -- with the cards. Refusing is the only answer that leaves nothing behind.
  select count(*) into v_shots from public.customer_review_test_card_screenshots;
  if v_shots > 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_SCREENSHOT: %s screenshot(s) are still attached to the legacy cards.', v_shots),
      detail  = 'Deleting the cards would leave those images in the private bucket with nothing pointing at them, and SQL cannot remove a stored object. Nothing was deleted.',
      hint    = 'Remove each screenshot through the module first — the holder can while they hold the card; a verifier returns a submitted card to its holder — then apply this migration again.';
  end if;

  -- ── 7. Delete the cards ──────────────────────────────────────────────────
  --
  -- customer_review_test_card_screenshots and customer_review_test_card_events
  -- both reference card_id ON DELETE CASCADE (20261017000000), so the
  -- screenshots and the whole audit trail go with them. That is intended: the
  -- approval covers the test data "in every stage, including associated test
  -- audit events".
  delete from public.customer_review_test_cards;
  get diagnostics v_deleted = row_count;

  if v_deleted <> 16 then
    raise exception
      'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: deleted % card(s), expected 16', v_deleted;
  end if;

  -- ── 8. And nothing is left behind ────────────────────────────────────────
  if exists (select 1 from public.customer_review_test_card_screenshots)
  or exists (select 1 from public.customer_review_test_card_events) then
    raise exception
      'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: child rows survived the cascade';
  end if;

  raise notice 'PASS  review-workflow legacy data: % card(s) removed; the audit trail cascaded with them',
    v_deleted;
end $$;
