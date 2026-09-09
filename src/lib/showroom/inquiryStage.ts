// ── What stage an inquiry is at, in words a salesperson uses ──────────────────
//
// The database keeps two independent status columns and both are already
// correct, so nothing here is a new status — this is presentation only, and no
// migration is involved:
//
//   showroom_inquiries.status           new | in_discussion | quotation_sent | closed
//   showroom_inquiries.quotation_status draft | sent | converted | lost
//
// Read separately they contradict each other on screen. An inquiry the customer
// submitted five minutes ago is `new` + `draft`, which the admin list showed as
// the single word "Draft" — a salesperson reasonably reads that as "I started a
// quotation", when in fact nobody has touched it yet. And once a quotation is
// won or lost, the quotation column is the only one that still says anything
// useful.
//
// So the two are collapsed into one ordered stage, with the quotation column
// winning wherever it has moved past `draft`, because that is the column that
// records an outcome.

import type { InquiryStatus, QuotationStatus } from '@/lib/types'

export type InquiryStage =
  | 'selecting'
  | 'quotation_draft'
  | 'quotation_sent'
  | 'converted'
  | 'lost'
  | 'closed'

export type StagePresentation = {
  stage: InquiryStage
  label: string
  /** One line of "what to do next", or null once the inquiry has an outcome. */
  hint: string | null
}

const PRESENTATION: Record<InquiryStage, { label: string; hint: string | null }> = {
  selecting:       { label: 'Selecting Products', hint: 'Waiting on the customer’s product list.' },
  quotation_draft: { label: 'Quotation Draft',    hint: 'Set rates and send the quotation.' },
  quotation_sent:  { label: 'Quotation Sent',     hint: 'Follow up with the customer.' },
  converted:       { label: 'Converted',          hint: null },
  lost:            { label: 'Lost',               hint: null },
  closed:          { label: 'Closed',             hint: null },
}

/** The stages in pipeline order — the order filters and any grouping should use. */
export const STAGE_ORDER: InquiryStage[] = [
  'selecting', 'quotation_draft', 'quotation_sent', 'converted', 'lost', 'closed',
]

/**
 * The one stage an inquiry is at.
 *
 * `converted` and `lost` are terminal and always win: they are outcomes, and an
 * outcome must never be overwritten by the fact that a PDF was generated. This
 * matches the route, which refuses to move `quotation_status` off anything but
 * `draft` for the same reason.
 *
 * Below that, an inquiry counts as having a quotation in progress once either
 * column says so — `status` reaches `quotation_sent` when a PDF is generated,
 * `quotation_status` reaches `sent` at the same moment, and a row where only one
 * of them moved (an older row, a partial write) should still read as sent
 * rather than falling back to "Selecting Products".
 */
export function inquiryStage(input: {
  status: InquiryStatus | null | undefined
  quotation_status: QuotationStatus | null | undefined
  /** Whether the inquiry has any line items at all. */
  itemCount?: number
}): InquiryStage {
  const qs = input.quotation_status ?? 'draft'
  if (qs === 'converted') return 'converted'
  if (qs === 'lost')      return 'lost'

  // `closed` is a real, settable inquiry status — /api/showroom/inquiry/[id]
  // accepts it in VALID_STATUSES — and it outranks everything below it. An
  // earlier version of this function ignored the column entirely, so a closed
  // inquiry displayed as "Selecting Products": a label claiming a customer is
  // still on the floor picking furniture, about a record somebody deliberately
  // closed. It ranks BELOW converted and lost because those say how it ended
  // and this only says that it did.
  if (input.status === 'closed') return 'closed'

  if (qs === 'sent' || input.status === 'quotation_sent') return 'quotation_sent'

  // Still a draft. An inquiry with nothing in it is not a draft quotation — the
  // customer is still walking the floor.
  if (input.itemCount === 0) return 'selecting'
  if (input.status === 'new') return 'selecting'
  return 'quotation_draft'
}

/** The stage plus the words for it. */
export function stagePresentation(input: Parameters<typeof inquiryStage>[0]): StagePresentation {
  const stage = inquiryStage(input)
  return { stage, ...PRESENTATION[stage] }
}

/** The label alone, for a badge that has no room for a hint. */
export function stageLabel(stage: InquiryStage): string {
  return PRESENTATION[stage].label
}

// ── The three-stage workflow indicator ────────────────────────────────────────

/**
 * The customer-facing flow, which is deliberately shorter than the pipeline
 * above: a customer in the showroom is doing one of three things, and the
 * salesperson standing next to them should be able to point at where they are.
 */
export const WORKFLOW_STEPS = ['Customer', 'Products', 'Quotation'] as const
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number]

/** Which step a `/showroom/...` path is on, or null for a page outside the flow. */
export function workflowStepForPath(pathname: string | null | undefined): WorkflowStep | null {
  const path = (pathname ?? '').replace(/\/+$/, '')
  if (path.startsWith('/showroom/join'))         return 'Customer'
  if (path.startsWith('/showroom/scan'))         return 'Products'
  if (path.startsWith('/showroom/product'))      return 'Products'
  if (path.startsWith('/showroom/project-list')) return 'Quotation'
  // /showroom/done and /showroom/share are past the flow, not inside it.
  return null
}
