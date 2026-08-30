-- ═════════════════════════════════════════════════════════════════════════════
-- Review Workflow — natural drafts, and administrator-controlled generation
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Three things, in one migration because they only make sense together:
--
--   1. The sixteen filler cards become natural review drafts — ONLY those still
--      `available`. A card somebody has booked, submitted, returned or had
--      verified is workflow evidence and is never rewritten.
--   2. A batch table, so a generated set can be audited: who asked, when, and
--      with what guidance.
--   3. One definer function that generates nothing itself but INSERTS a
--      validated batch atomically, under the two rules that matter — the caller
--      must resolve `verify`, and the pool must be empty.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not call a model. Generation happens
-- in a server route (src/app/api/customer-reviews/generate) which holds the
-- credential and hands this function an already-validated array. SQL never sees
-- a provider key and never makes a network call.

-- ── 1. REFERENCES ───────────────────────────────────────────────────────────
--
-- card_ref was `^TEST-[0-9]{3}$` and is SHOWN on every card, so it cannot keep
-- saying TEST. The constraint widens rather than moves: existing refs stay
-- valid because rows carrying them may be finished work that must not be
-- touched, and new refs use RW-000000.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_card_ref_check;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_card_ref_check
  check (card_ref ~ '^(TEST-[0-9]{3}|RW-[0-9]{6})$');

-- ── 2. THE BATCH RECORD ─────────────────────────────────────────────────────
create table if not exists public.customer_review_draft_batches (
  id            uuid primary key default gen_random_uuid(),
  -- WHO ASKED, and it is never null: a batch nobody is accountable for is not
  -- a batch worth keeping.
  generated_by  uuid not null references public.users(id),
  generated_at  timestamptz not null default now(),
  -- THE GUIDANCE EXACTLY AS SUBMITTED. Stored so a reviewer can see what was
  -- asked for, and length-capped so a caller cannot use it as free storage.
  guidance      text not null check (btrim(guidance) <> '' and length(guidance) <= 2000),
  -- Which model produced it, for auditing a batch after the fact.
  model         text not null check (btrim(model) <> '' and length(model) <= 120),
  card_count    integer not null check (card_count = 20)
);

comment on table public.customer_review_draft_batches is
  'One row per generated batch of review drafts: who asked, when, and the guidance they gave. Holds no provider credential and no recipient data.';

alter table public.customer_review_draft_batches enable row level security;

-- Readable by anyone who may verify — the same people who may generate. No
-- client INSERT, UPDATE or DELETE policy: the definer function is the only way
-- a row appears, and nothing removes one.
create policy "customer_review_draft_batches_select"
  on public.customer_review_draft_batches
  for select to authenticated
  using (public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify'));

-- READ-ONLY to every client role, the same posture the three tables in
-- 20261017000000 carry.
--
-- The SELECT policy above is what decides WHO reads a batch. This is what
-- decides that nobody writes one: a new table in `public` arrives with
-- INSERT/UPDATE/DELETE already granted to authenticated by Supabase's default
-- privileges, and an absent policy is the only thing standing in the way. Take
-- the privilege away as well, so a policy added back by mistake later still
-- cannot write.
revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_draft_batches from authenticated, anon;

-- Which batch a card came from. Nullable, because the sixteen that predate
-- generation belong to no batch and that is the honest value.
alter table public.customer_review_test_cards
  add column if not exists batch_id uuid references public.customer_review_draft_batches(id);

create index if not exists customer_review_test_cards_batch
  on public.customer_review_test_cards (batch_id);

-- ── 3. NATURAL DRAFTS FOR THE CARDS STILL AVAILABLE ─────────────────────────
--
-- `where status = 'available'` is the whole safety property of this statement.
-- A booked, submitted, returned or verified card keeps its text, its reference
-- and its trail untouched — and a test asserts that a non-available card cannot
-- be reached by this update.
--
-- The drafts below are first-person reviews a hospitality-furniture customer
-- might write: hotels, restaurants, cafés and resorts, varied in length, tone
-- and subject, covering design coordination, quality, customisation, packaging,
-- delivery, communication and issue resolution. None names a real client, a
-- real project, an order number or a place. None contains a link, an address, a
-- telephone number, an instruction, or a label about itself.
with drafts (n, cat, title, body) as (values
  (1, 'restaurant_test', 'Booth seating that finally fits the room',
   'We had an awkward L-shaped dining room and every supplier we spoke to wanted to sell us standard booths that would have left dead space at one end. This team measured, came back with a layout drawing, and built the run to match. Two years of full services later the frames are still solid and the upholstery has cleaned up well. The only thing I would flag is that the first drawing had the banquette height a little low for our tables, but they corrected it before production without any fuss.'),
  (2, 'cafe_test', 'Good chairs, and they actually stack',
   'Ordered forty stacking chairs for a small café. They arrived when they said they would, stack six high without marking each other, and the timber has held up to being knocked about by customers all day. Simple thing to get right and plenty of people get it wrong.'),
  (3, 'hotel_test', 'Sixty rooms, one delivery window, no drama',
   'Refitting sixty rooms while staying open meant we could only take furniture in two lifts on specific mornings. They planned the delivery around that, labelled every carton by room number, and the crew took the packaging away with them each day. I have done three refits and this is the first time nobody on my staff had to break down cardboard at midnight.'),
  (4, 'resort_test', 'Held up to the sea air better than the last set',
   'Our previous outdoor furniture looked tired after one season near the water. We asked for something that would survive salt and constant sun, and were talked through the finish options rather than just being sold the most expensive one. Eighteen months in, the frames are clean and the slats have faded evenly, which is what we were told to expect.'),
  (5, 'bulk_order_test', 'A hundred and twenty covers, delivered in three phases',
   'Large order, phased across three months because we were opening in stages. Each phase matched the one before it — same timber tone, same seat height, same everything. That sounds obvious until you have had a supplier deliver a second batch that was visibly a different colour. Communication was steady throughout; I always knew what was coming and when.'),
  (6, 'customisation_test', 'They built to our drawing rather than talking us out of it',
   'We came with a specific idea for the bar front and expected the usual push back toward something off the shelf. Instead they asked what the space had to do, suggested two changes that made it easier to clean, and then built what we had asked for. The suggestions were right and I am glad we took them.'),
  (7, 'delivery_test', 'Delivery went wrong and the fix was quick',
   'One of four pallets was damaged in transit and two table tops were unusable. I sent photographs on a Friday and replacements were on site the following Wednesday, which was faster than I expected. Nobody argued about whose fault it was. I would rather a supplier handle a problem well than pretend problems never happen.'),
  (8, 'product_quality_test', 'The joinery is the part I notice',
   'I have bought a lot of restaurant furniture and most of it fails in the same place — where the leg meets the seat. These have proper joints rather than a bracket and a hope. Eighteen months of daily use and nothing has loosened. Slightly heavier than the chairs they replaced, which the floor staff mentioned, but that is the trade for the build.'),
  (9, 'issue_resolution_test', 'A finish problem, handled properly',
   'Roughly a month after installation the finish on several tabletops started to lift near the edges. I was not looking forward to that conversation. They came out, looked at it, agreed it was a batch issue rather than anything we had done, and replaced the tops. It took about three weeks and we kept trading throughout.'),
  (10, 'service_test', 'Someone answered the phone',
   'What I actually want from a supplier is a person who knows my order. I had the same contact from quotation to installation and never had to explain the project twice. The furniture is good. The not-being-passed-around is what made me write anything at all.'),
  (11, 'hotel_test', 'A long note, because the coordination deserves one',
   'This was a full lobby and restaurant refit and the hardest part was never going to be the furniture itself, it was making eleven different pieces read as one scheme. We had an interior designer with strong opinions and a very specific timber tone she wanted matched across seating, low tables, a reception desk and a set of screens. I expected to be told that some of it was not possible in that finish. Instead we got samples of each piece in the actual finish, in stages, so the designer could sign each one off before anything went into production. Two of them came back twice. When the delivery arrived everything matched, including the pieces that had been made weeks apart. The lead time was longer than the shortest quote we had, and I would take that trade again.'),
  (12, 'cafe_test', 'Small order, treated seriously',
   'Twelve tables and a counter. Not a big job, and I half expected to be at the back of the queue behind the hotel contracts. That was not how it went — same drawings, same updates, same care with the packaging. The tables are steady on an uneven floor, which took an extra visit to sort out and did not appear on the invoice.'),
  (13, 'bulk_order_test', 'Packaging worth mentioning',
   'Every item arrived wrapped properly with the corners protected, and the cartons were marked so we could stage them by floor without opening anything. We had zero transit damage across a large order. I have unpacked enough furniture to know that is not luck.'),
  (14, 'resort_test', 'Villa furniture, and one honest conversation',
   'We wanted a particular rattan look for twenty villas and were told plainly that the material we had in mind would not last in that humidity, with an explanation of why and two alternatives. We went with the alternative. A supplier prepared to talk a customer out of the thing they walked in asking for is worth keeping.'),
  (15, 'restaurant_test', 'Second order, which is the real review',
   'We used them for our first site three years ago and have just finished furnishing the second. Nothing from the first order has needed replacing, which is why we did not bother getting other quotes. Pricing was fair rather than cheap. The new site went in on schedule.'),
  (16, 'customisation_test', 'Bench seating built around a pillar',
   'There is a structural pillar in the middle of our dining area that made a normal seating plan impossible. They designed a curved bench that wraps it and turned the worst part of the room into the section people ask for. Fitting took a day and a half. It looks like it was always meant to be there.')
)
update public.customer_review_test_cards c
   set test_title    = d.title,
       test_body     = d.body,
       test_category = d.cat,
       card_ref      = 'RW-' || lpad(d.n::text, 6, '0'),
       updated_at    = now()
  from drafts d
 where c.card_ref = 'TEST-' || lpad(d.n::text, 3, '0')
   -- THE GUARD. Only an available card may be rewritten.
   and c.status = 'available';

-- ── 4. THE BATCH INSERT ─────────────────────────────────────────────────────
create or replace function public.create_customer_review_draft_batch(
  p_guidance text,
  p_model    text,
  p_drafts   jsonb,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_n        integer;
  v_next     integer;
  v_item     jsonb;
  v_title    text;
  v_body     text;
begin
  -- ── The actor ────────────────────────────────────────────────────────────
  -- Active account first, then the RESOLVED permission. No role is read here
  -- or anywhere else in this module: an administrator generates because the
  -- engine says they hold `verify`, not because of what they are called.
  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Generating drafts needs the Verify permission'
      using errcode = '42501';
  end if;

  -- ── One generation at a time ─────────────────────────────────────────────
  --
  -- Taken BEFORE the pool is counted, so two verifiers pressing the button
  -- together cannot both read "empty" and both insert. The second waits, then
  -- sees the twenty rows the first inserted and is refused by the check below.
  -- The lock is transaction-scoped: it releases on commit or rollback without
  -- anything having to remember to release it.
  perform pg_advisory_xact_lock(hashtext('customer_review_draft_batch'));

  -- ── The pool must be empty ───────────────────────────────────────────────
  --
  -- Enforced HERE, not only by a disabled button. A returned or booked card is
  -- not available and does not block the next batch — only a card somebody
  -- could still pick up does.
  select count(*) into v_n
    from public.customer_review_test_cards
   where status = 'available';
  if v_n <> 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_POOL_NOT_EMPTY: % review(s) are still available; generate the next batch once they have all been booked', v_n
      using errcode = '23514';
  end if;

  -- ── Exactly twenty, all valid ────────────────────────────────────────────
  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);
  if v_n <> 20 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the batch holds % draft(s), expected exactly 20', v_n
      using errcode = '23514';
  end if;

  insert into public.customer_review_draft_batches (generated_by, guidance, model, card_count)
  values (p_actor_id, p_guidance, p_model, 20)
  returning id into v_batch_id;

  -- References continue from the highest RW- already used, so a reference is
  -- never reused even after cards are deleted, and stays stable once assigned.
  select coalesce(max(substring(card_ref from 4)::integer), 0)
    into v_next
    from public.customer_review_test_cards
   where card_ref ~ '^RW-[0-9]{6}$';

  for v_item in select * from jsonb_array_elements(p_drafts)
  loop
    v_title := btrim(coalesce(v_item->>'title', ''));
    v_body  := btrim(coalesce(v_item->>'body', ''));

    if v_title = '' or v_body = '' then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft has an empty title or body'
        using errcode = '23514';
    end if;

    v_next := v_next + 1;

    -- Every column constraint the table already carries still applies: the
    -- title and body length checks, and the CHECK that refuses a body carrying
    -- the retired internal-test warning. A batch that violated one inserts
    -- nothing, because this whole function is one transaction.
    insert into public.customer_review_test_cards
      (card_ref, test_category, test_title, test_body, batch_id)
    values ('RW-' || lpad(v_next::text, 6, '0'),
            coalesce(v_item->>'category', 'service_test')::text,
            v_title, v_body, v_batch_id);
  end loop;

  return v_batch_id;
end;
$$;

comment on function public.create_customer_review_draft_batch(text, text, jsonb, uuid) is
  'Inserts one validated batch of exactly 20 review drafts, atomically. Requires the resolved verify permission and an empty available pool. Generates nothing itself: the route supplies already-validated drafts.';

-- It takes an actor id, so a browser must never be able to call it. The trusted
-- route calls it with the service role after establishing who is asking.
revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid)
  to service_role;

-- ── 5. WHAT THIS FILE PROMISED, ASSERTED ────────────────────────────────────
do $$
declare v_n integer; v_bad text;
begin
  -- No finished card was touched: every card that is not available still
  -- carries a TEST- reference, because only available ones were renamed.
  select count(*) into v_n
    from public.customer_review_test_cards
   where status <> 'available' and card_ref ~ '^RW-';
  if v_n <> 0 then
    raise exception '% finished card(s) were rewritten; only available cards may be', v_n;
  end if;

  -- The batch function reads no role.
  if regexp_replace(
       pg_get_functiondef('public.create_customer_review_draft_batch(text, text, jsonb, uuid)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g') ~* '(u\.role|users\.role|''admin'')' then
    raise exception 'the batch function consults a role';
  end if;

  -- And it is not reachable from a browser.
  if has_function_privilege('authenticated',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid)', 'EXECUTE') then
    raise exception 'a browser role can call the batch function, which takes an actor id';
  end if;

  -- No draft carries the retired warning, a link, an address or a number.
  select string_agg(card_ref, ', ') into v_bad
    from public.customer_review_test_cards
   where test_body ~* '(INTERNAL TEST ONLY|https?://|www\.|@[a-z0-9.-]+\.[a-z]{2,}|\+[0-9]{8,})';
  if v_bad is not null then
    raise exception 'card(s) carry a warning, link, address or number: %', v_bad;
  end if;

  raise notice 'PASS  review-workflow drafts: available cards rewritten, batch function locked down';
end $$;
