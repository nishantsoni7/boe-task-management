// ── Who the inquiry belongs to, as the internal UI says it ────────────────────
//
// One place for the wording and for what an unresolved owner reads as, because
// the same fact is shown on three surfaces and had drifted on all three: the
// admin list showed nothing at all, the inquiry detail card showed nothing at
// all, and the quotation PDF showed a bare em dash.
//
// TERMINOLOGY IS DELIBERATELY SPLIT. Internal BOE screens say "Sales Candidate";
// the customer-facing quotation PDF says "Sales Consultant" (see
// SALESPERSON_LABEL in ./quotationImages) because that is what a customer should
// read on a document they keep. Neither is a rename of the other — do not
// "unify" them.
//
// The NAME itself never comes from here. It is resolved server-side from
// `showroom_inquiries.salesperson_id`, so no viewer's identity can reach this
// function in the first place; all this decides is how the resolved value reads.

/** The label used on internal BOE screens. */
export const SALES_CANDIDATE_LABEL = 'Sales Candidate'

/**
 * What the Sales Candidate row shows.
 *
 * An inquiry whose owner cannot be resolved still shows the row, reading
 * "Not assigned". Hiding it would be worse than saying so: a missing row looks
 * like a screen that forgot to render, while "Not assigned" is a fact somebody
 * can act on.
 *
 * A blank or whitespace-only name counts as unresolved, as does the em dash the
 * PDF path uses for the same idea — a stored name is never one of those, so
 * treating them as absent cannot swallow a real person's name.
 */
export function salesCandidateLabel(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed || trimmed === '—' || trimmed === '-') return 'Not assigned'
  return trimmed
}
