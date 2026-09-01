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
-- So this refuses to run unless the database still holds EXACTLY the legacy
-- dataset, and every one of those cards is still early enough in the workflow
-- that deleting it throws away nothing a person did:
--
--   * exactly 16 cards, and not one more or fewer;
--   * the reference set is EXACTLY {TEST-002, RW-000001, RW-000003..RW-000016}
--     — an identity, not a pattern; see §4;
--   * no card belongs to a batch (batch_id is null on all sixteen);
--   * zero rows in customer_review_draft_batches;
--   * every card is `available`, or `booked` without a send confirmation;
--     nothing submitted, verified or returned;
--   * no card has sent_confirmed_at set;
--   * no screenshot is attached to any of them, and the bucket holds no object
--     — see below.
--
-- ═══ WHAT THIS FILE DELIBERATELY DOES NOT PIN ════════════════════════════════
--
-- THE AVAILABLE/BOOKED SPLIT. It first required 15 available and 1 booked,
-- which was true on 2026-08-31 and was 13 and 3 by 2026-09-01 — two colleagues
-- booked reviews in between, which is the module working. A guard that pins a
-- number the product legitimately moves is not a safeguard, it is a race
-- against your own users, and it would have to be re-derived and re-approved
-- every time somebody pressed Book.
--
-- What it pins instead is the pair of things that CANNOT drift under ordinary
-- use: the reference set, which nothing rewrites after 20261023000000, and the
-- workflow depth, which only moves in one direction and is exactly the axis the
-- approval was about. Booking is reversible and carries no claim about a real
-- person; confirming a send is neither.
--
-- whatsapp_opened_at IS NOT A BLOCKER, and that is a decision rather than an
-- oversight. Opening a wa.me link builds text and hands it to WhatsApp — the
-- module has always refused to read it as evidence that anything was sent, and
-- reading it as one here would contradict the rest of the design.
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
--      select count(*)                                    as cards,
--             count(*) filter (where batch_id is not null) as batched,
--             count(*) filter (where status not in ('available','booked')) as past_booked,
--             count(*) filter (where sent_confirmed_at is not null) as send_confirmed,
--             count(*) filter (where returned_at is not null)       as returned,
--             count(*) filter (where status = 'available') as available,
--             count(*) filter (where status = 'booked')    as booked
--        from public.customer_review_test_cards;
--
--      select count(*) as batches from public.customer_review_draft_batches;
--
--      -- the reference set, which is the actual fingerprint
--      select string_agg(card_ref, ', ' order by card_ref) as refs
--        from public.customer_review_test_cards;
--
--    Expected: cards 16, batched 0, past_booked 0, send_confirmed 0,
--    returned 0, batches 0, and refs exactly
--      RW-000001, RW-000003 … RW-000016, TEST-002
--
--    AVAILABLE AND BOOKED ARE REPORTED, NOT ASSERTED. Any split of the sixteen
--    between those two states is fine and this file accepts it — 15/1 on
--    2026-08-31 and 13/3 on 2026-09-01 are both the same dataset with people
--    using it. Read them so you know what you are deleting; do not treat a
--    change in them as a deviation.
--
--    Anything else and this file will abort anyway — reading first means
--    finding out before a deploy rather than during one.
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
  v_sent       integer;
  v_objects    integer;
  -- THE LEGACY DATASET, WRITTEN OUT. TEST-002 kept its seed reference because
  -- it was booked when 20261023000000 renamed the available cards; every other
  -- seed became RW-00000n with the same n. Hence no RW-000002.
  v_expected_refs text[] := array[
    'TEST-002',
    'RW-000001', 'RW-000003', 'RW-000004', 'RW-000005', 'RW-000006',
    'RW-000007', 'RW-000008', 'RW-000009', 'RW-000010', 'RW-000011',
    'RW-000012', 'RW-000013', 'RW-000014', 'RW-000015', 'RW-000016'
  ];
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

  -- ── 4. The reference set is EXACTLY the legacy one ───────────────────────
  --
  -- THIS IS THE FINGERPRINT, and it is an identity rather than a pattern.
  --
  -- 20261021000000 seeded TEST-001..TEST-016. 20261023000000 then rewrote and
  -- renamed every card that was still AVAILABLE at that moment, TEST-00n ->
  -- RW-00000n; TEST-002 was booked and so kept its name. That leaves exactly
  -- one possible reference set for a legacy database:
  --
  --   TEST-002, RW-000001, RW-000003, RW-000004, ... RW-000016
  --
  -- RW-000002 CANNOT EXIST — the card that would have carried it is TEST-002.
  --
  -- A SYMMETRIC DIFFERENCE, NOT A PATTERN MATCH. The pattern this replaced
  -- accepted any TEST-nnn and any RW-000001..016, so it would have passed a
  -- database holding fifteen legacy cards plus a new RW-000009 that had taken a
  -- deleted one's place. Comparing the SET catches a missing legacy card and an
  -- extra card of any kind, in one query.
  --
  -- References are immutable after 20261023000000 — nothing in the module
  -- rewrites card_ref — which is what makes this the right thing to pin while
  -- the workflow states legitimately move underneath it.
  select string_agg(ref, ', ' order by ref) into v_bad_refs
    from (
      select card_ref as ref from public.customer_review_test_cards
      except
      select unnest(v_expected_refs)
        union all
      select unnest(v_expected_refs)
      except
      select card_ref from public.customer_review_test_cards
    ) d;

  if v_bad_refs is not null then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: the reference set is not the legacy dataset; difference: %s.', v_bad_refs),
      detail  = 'The legacy dataset is exactly TEST-002 and RW-000001, RW-000003..RW-000016. A reference here and not there, or the reverse, means this is not that dataset. Nothing was deleted.';
  end if;

  -- ── 5. Every card is still EARLY in the workflow ─────────────────────────
  --
  -- The available/booked SPLIT is deliberately not pinned; see the header. What
  -- is checked is how far each card has got, because that is the axis the
  -- approval was actually about:
  --
  --   allowed   available                   nobody has taken it
  --   allowed   booked, not send-confirmed  somebody holds it and has not yet
  --                                         claimed to have sent anything
  --   REFUSED   submitted / verified        evidence exists, and may have been
  --                                         accepted
  --
  -- Booking is reversible and says nothing about a real person. It is not a
  -- reason to refuse, and the three current holders are covered by the
  -- approval.
  select count(*) filter (where status = 'available'),
         count(*) filter (where status = 'booked'),
         count(*) filter (where status not in ('available', 'booked'))
    into v_available, v_booked, v_other
    from public.customer_review_test_cards;

  if v_other <> 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STATE_CHANGED: %s card(s) have reached submitted or verified.', v_other),
      detail  = 'A submitted or verified card carries evidence somebody produced and a verifier may already have accepted. Nothing was deleted.',
      hint    = 'Return those cards to their holders and have the screenshots removed, or re-derive and re-approve this file against the state that now exists.';
  end if;

  -- ── 5A. NOBODY HAS CLAIMED TO HAVE SENT ONE ──────────────────────────────
  --
  -- THE ONE FACT THAT MAKES A REVIEW UNDELETABLE HERE. sent_confirmed_at is a
  -- person stating by hand that a message left their phone and reached a real
  -- recipient. Deleting the record of that is not covered by an approval to
  -- remove rehearsal data, and the module treats the claim as irreversible
  -- everywhere else — unbooking is refused after it for the same reason.
  --
  -- returned_at is included because a returned card has necessarily been
  -- submitted, which has necessarily been send-confirmed. It is checked
  -- explicitly rather than left implied.
  select count(*) into v_sent
    from public.customer_review_test_cards
   where sent_confirmed_at is not null
      or returned_at is not null;

  if v_sent <> 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_SEND_CONFIRMED: %s card(s) have been confirmed as sent.', v_sent),
      detail  = 'A candidate stated by hand that they sent that message to a real recipient. This file will not delete the record of it. Nothing was deleted.';
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

  -- ── 6A. AND THE BUCKET IS EMPTY ──────────────────────────────────────────
  --
  -- THE SCREENSHOT ROW AND THE STORED OBJECT ARE TWO THINGS, AND ONLY ONE OF
  -- THEM CASCADES. §6 proves no card points at an image. This proves no image
  -- exists that nothing points at — an object whose row was already removed, or
  -- one left behind by a removal that failed between the Storage call and the
  -- row delete. Deleting the cards would leave it unreachable forever: nothing
  -- would name its key, and SQL cannot remove it.
  --
  -- Either count being non-zero on its own is itself the finding. They are
  -- checked separately so the message says which one it was.
  select count(*) into v_objects
    from storage.objects
   where bucket_id = 'customer-review-test-screenshots';

  if v_objects > 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_STORAGE: %s object(s) remain in the customer-review-test-screenshots bucket.', v_objects),
      detail  = 'No card points at them, so deleting the cards would strand them permanently — SQL cannot remove a stored object. Nothing was deleted.',
      hint    = 'Remove the objects through the Storage API, then apply this migration again.';
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
