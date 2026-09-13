// The generated-review workflow (generate → assign → book → share → submit →
// verify) is PAUSED FOR CANDIDATES during the Custom Review phase.
//
// NOTHING IS DELETED. The tables, functions, screens and records stay exactly
// as they are, and a verifier keeps every screen they had — the Reviews queue,
// Batches, the Image Library, Progress and a card's own page — for audit and
// for finishing reviews already submitted.
//
// WHAT A CANDIDATE LOSES while this is false:
//   * My Reviews shows the Custom Review workspace and no generated cards;
//   * /customer-reviews/<id> shows a "paused" notice instead of the card;
//   * the database refuses a non-verifier's booking —
//     customer_review_generated_booking_enabled() in
//     supabase/migrations/20261206000000_customer_review_custom_reapply_and_monthly_rules.sql
//     returns false, and a trigger on the card table asks it.
//
// RE-ENABLING is two changes that must travel together: this constant, and a
// migration re-creating that function to return true. generatedWorkflow.test.ts
// pins the two to each other.

export const CANDIDATE_GENERATED_REVIEWS_ENABLED = false

/** True when this viewer must not be shown the generated-review workflow. */
export function candidateGeneratedReviewsHidden(caps: { canVerify: boolean }): boolean {
  return !CANDIDATE_GENERATED_REVIEWS_ENABLED && !caps.canVerify
}

export const GENERATED_REVIEWS_PAUSED_MESSAGE =
  'Generated reviews are paused for now. Submit a Custom Review instead.'
