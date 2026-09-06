-- Review Workflow — raise the review body length so the word-count range an
-- administrator may ask for is not silently capped by a character limit.
--
-- THE PROBLEM. MAX_WORDS_CEILING in src/lib/customerReviews/generationSettings.ts
-- was 100, chosen conservatively so that even a wordy 100-word draft stayed
-- comfortably under the column's 900-character ceiling. An administrator asking
-- for a longer, more natural review range (40–120 words, for one real example)
-- was refused by the FORM before anything reached the database, with an error
-- that named a word count while the real ceiling was a character count nobody
-- on the screen could see.
--
-- THE FIX IS THE STORAGE, NOT A BIGGER CONVERSION FACTOR. Raising
-- MAX_WORDS_CEILING alone without raising what the column can hold would just
-- move the failure from the form to validateDrafts() — a batch that generates
-- successfully and is then refused whole, after the provider call has already
-- been paid for. So this migration widens the one place that number actually
-- comes from.
--
-- WHY 1800, AND NOT UNLIMITED. The application ceiling for a WORD TARGET is
-- moving from 100 to 200 (src/lib/customerReviews/generationSettings.ts,
-- MAX_WORDS_CEILING) — a deliberate, documented number, not a derived one; see
-- the comment on that constant for the reasoning and why 100 was wrong to begin
-- with. 1800 characters is chosen the same way 900 was: conservatively, with
-- real headroom, for a 200-word ceiling at roughly five to seven characters a
-- word including punctuation and spacing (200 × 7 = 1400 < 1800 — the same
-- ~78% utilisation the previous 100/900 pair held). This is a bound a review
-- MAY reach, never a target every review is expected to hit — validateDrafts()
-- and validateDraftText() still refuse anything past it, exactly as they
-- refused anything past 900 before this file.
--
-- WHAT DOES NOT CHANGE. The floor (20 characters, storage; 40, application) is
-- untouched — a short body was never the problem. Every other rule on the
-- column — no blank body, no internal-test warning, no link — is carried over
-- unchanged; only the upper bound of the length range moves. Nothing here
-- touches a policy, a permission, an RPC's authorization check, assignment
-- eligibility, or the image-group/project-city metadata added in
-- 20260906125555 — this is a single column CHECK, widened.
--
-- THIS IS A WIDENING, NOT A NARROWING. Every test_body already stored is at
-- most 900 characters, which is inside the new 1800-character bound, so there
-- is nothing for a validation scan to skip and no reason to add this NOT
-- VALID — see 20261108000000 for a constraint that did need to skip one, and
-- why.

alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_test_body_check;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_test_body_check
  check (
    btrim(test_body) <> ''
    and length(test_body) between 20 and 1800
    and position(public.customer_review_internal_test_warning() in upper(test_body)) = 0
    and test_body !~* '(https?://|www\.|wa\.me)'
  );

comment on constraint customer_review_test_cards_test_body_check
  on public.customer_review_test_cards is
  'A review body: non-blank, 20-1800 characters (raised from 900 in 20261114000000 to admit a 200-word generation ceiling), carries no internal-test warning, and contains no link.';
