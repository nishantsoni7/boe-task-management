-- ═════════════════════════════════════════════════════════════════════════════
-- TEST FIXTURE — Review Workflow Test (Internal) cards
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- WHY IT IS NOT A MIGRATION
-- -------------------------
-- Migrations run against production. Test data that runs against production is
-- test data in production, and the migration itself asserts that it created no
-- cards at all (20261017000000 §12, "THE MODULE SHIPS EMPTY"). So the sixteen
-- rows below live here, outside the migration chain, where nothing will apply
-- them by accident.
--
-- HOW IT IS LOADED
-- ----------------
--   Automatically, as the last step of
--     BOE_DB_CONTAINER=supabase_db_<project> \
--       supabase/tests/run_customer_review_outreach_local.sh
--
--   By hand, against the same disposable stack:
--     docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres \
--       -v ON_ERROR_STOP=1 -f - < supabase/fixtures/customer_review_test_cards.sql
--
-- HOW IT IS CLEARED
--   supabase/fixtures/customer_review_test_cards_clear.sql, loaded the same
--   way. It removes exactly the rows this file inserts, by card_ref, and
--   nothing else.
--
-- WHY IT CANNOT REACH PRODUCTION EVEN IF SOMEBODY RUNS IT THERE
-- ------------------------------------------------------------
-- The guard below. This file refuses to insert anything unless the database it
-- is connected to carries the disposable-stack marker — the same comment
-- run_customer_review_outreach_local.sh requires, which a person has to set
-- deliberately and which no BOE deployment has. Pointing psql at production and
-- running this file raises and inserts nothing.
--
-- That is a property of THIS FILE, not of the harness around it, which is the
-- point: a guard that only exists in the runner protects only the people who
-- use the runner.
--
-- WHAT THE CONTENT IS
-- -------------------
-- Sixteen pieces of obviously fictional filler, written to exercise LAYOUT AND
-- MESSAGE HANDLING and nothing else:
--
--   * short, medium and long bodies, so wrapping and truncation are visible;
--   * all ten test categories;
--   * no customer, no person, no place, no company, no date, no order.
--
-- NONE OF IT IS A REVIEW. None of it is attributed to anybody, describes an
-- experience, expresses satisfaction, or reads as an endorsement — every body
-- says what it is in its own first sentence. None of it is copied, adapted or
-- paraphrased from any real review anywhere; it is filler written for this file.
--
-- THE MANDATORY LABEL IS NOT IN THESE ROWS, and that is deliberate. It is
-- prepended by trusted application code
-- (src/lib/customerReviews/internalTest.ts) and rendered by a component that
-- takes no text, so it cannot be edited or dropped. A copy stored in the body
-- would be a copy somebody could reword — which is why the table's own CHECK
-- constraint REFUSES a body containing it.

-- ── THE GUARD ───────────────────────────────────────────────────────────────
do $$
declare
  v_marker text;
begin
  select coalesce(shobj_description(oid, 'pg_database'), '')
    into v_marker
  from pg_database
  where datname = current_database();

  if v_marker <> 'boe-disposable-customer-review-test' then
    raise exception
      'REFUSING TO LOAD TEST DATA: % is not a database marked disposable. Nothing was written.',
      current_database()
      using errcode = '42501',
            hint = 'Only a throwaway local stack carrying the disposable-stack marker may hold these rows.';
  end if;
end $$;

insert into public.customer_review_test_cards (card_ref, test_category, test_title, test_body)
values

-- ── SHORT bodies: the minimum a card can carry, for tight layouts ──
('TEST-001', 'restaurant_test', 'Restaurant layout test, short',
 'Short restaurant-test filler. This card exists to check a one-line body renders correctly. It describes nothing real.'),

('TEST-002', 'cafe_test', 'Cafe layout test, short',
 'Short cafe-test filler for layout checking only. No event, person or order is described anywhere in this text.'),

('TEST-003', 'delivery_test', 'Delivery layout test, short',
 'Short delivery-test filler. Used to confirm a brief body does not leave the card looking broken. Entirely fictional.'),

('TEST-004', 'service_test', 'Service layout test, short',
 'Short service-test filler. It is here to be displayed, not to be read as a statement about anything.'),

-- ── MEDIUM bodies: the common case, two or three sentences ──
('TEST-005', 'hotel_test', 'Hotel layout test, medium',
 'Medium-length hotel-test filler, written to occupy roughly the space a normal card body would. It exists so that wrapping across two or three lines can be checked on a phone and on a desktop at the same time. Nothing in this sentence, or the ones around it, refers to a real project, a real place, or a real person.'),

('TEST-006', 'resort_test', 'Resort layout test, medium',
 'Medium-length resort-test filler. The point of this card is to sit between the very short and the very long ones so that the middle of the range is covered. It is not a description of anything, it makes no claim about quality, and it is not attributed to anybody at all.'),

('TEST-007', 'bulk_order_test', 'Bulk-order layout test, medium',
 'Medium-length bulk-order-test filler. It repeats the same idea in several ways on purpose, because a card body of this length is what most of them will be, and it should be checked with realistic bulk rather than with a single line. No quantity, no product and no order is described.'),

('TEST-008', 'customisation_test', 'Customisation layout test, medium',
 'Medium-length customisation-test filler. It exists so that a body containing several sentences, some of them a little longer than others, can be seen in the list preview and again in full on the detail screen. There is no customisation, and there was no request for one.'),

('TEST-009', 'product_quality_test', 'Product-quality layout test, medium',
 'Medium-length product-quality-test filler. The category name is a label for a test scenario shape and not a judgement about any product. This text is here to be laid out, wrapped and truncated, and for no other reason whatsoever.'),

('TEST-010', 'issue_resolution_test', 'Issue-resolution layout test, medium',
 'Medium-length issue-resolution-test filler. No issue occurred and nothing was resolved; the category exists so the fixture covers the shape of a card that would carry a longer explanation. Read it as placeholder text, because that is all it is.'),

-- ── LONG bodies: the upper end, for truncation and scroll behaviour ──
('TEST-011', 'restaurant_test', 'Restaurant layout test, long body for wrapping and truncation checks',
 'Long restaurant-test filler, written to reach the upper end of what a card body may hold so that truncation in the list and full display on the detail screen can both be checked properly. It repeats itself deliberately, because the purpose is volume rather than meaning, and a shorter piece of text would not reveal where a preview cuts off or whether a long paragraph pushes a control off the bottom of a small screen. Nothing here describes a real project, a real person, a real place or a real order. There is no opinion in it, no rating, and no statement about quality of any kind. It is placeholder prose for a workflow rehearsal, and every sentence in it exists so the next sentence has somewhere to go. If this text ever appears anywhere outside an internal test screen, something has gone wrong and it should be reported rather than read.'),

('TEST-012', 'hotel_test', 'Hotel layout test, long body with several paragraphs of filler content',
 'Long hotel-test filler. The first job of this text is to be long enough that a list preview has to cut it, and the second is to be plainly meaningless so that nobody reading a fragment of it mistakes it for a statement somebody made. Both jobs are served by repetition, so it repeats. A card of this length is also useful for checking how a WhatsApp message behaves when the body is near its limit, because the message builder adds a label at the top and the bottom and the whole thing still has to be readable in a chat window. No hotel, project, person or arrangement is described. There is no assessment here, favourable or otherwise, and no part of this paragraph was taken from anywhere.'),

('TEST-013', 'bulk_order_test', 'Bulk-order layout test, long body for message-length handling',
 'Long bulk-order-test filler, aimed specifically at the message path rather than the card path. When this body is composed into a test message the result is close to the longest thing the workflow will produce, which is exactly what a rehearsal should exercise before anybody relies on it. The text is intentionally flat and repetitive: it carries no information, describes no transaction, names no product and makes no claim. Its only property that matters is its length. A reader who finds themselves trying to work out what it is about has already understood it correctly, because it is not about anything.'),

-- ── EDGE bodies: unusual shapes that still have to render ──
('TEST-014', 'delivery_test', 'Delivery layout test with a deliberately long unbroken word for overflow checking',
 'Delivery-test filler containing an unusually long unbroken token to check that a card does not scroll sideways: supercalifragilisticexpialidociousplaceholdertokenforlayouttesting. The rest of this text is ordinary filler and describes nothing real.'),

('TEST-015', 'service_test', 'Service layout test with punctuation and symbols in the body',
 'Service-test filler with punctuation to check encoding on the way into a message: quotes "like these", an apostrophe in don''t, an ampersand &, a plus +, a percent 100%, a hash #, and an em dash — all in one sentence. None of it means anything; it is here so the message encoding can be inspected.'),

('TEST-016', 'customisation_test', 'Customisation layout test with line breaks in the body',
 E'Customisation-test filler written across more than one line.\nThis second line exists so that a body containing a newline can be checked in the card, in the preview and in the composed message.\nNothing described here happened, and nobody said it.');
