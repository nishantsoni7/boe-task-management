// ── SAMPLE TYPE: "sampling needed" or "sample order only" (20270320000000) ──
//
// Owner, 2026-10-19. Chosen on the PI draft (order_submissions.sample_type,
// set_order_submission_sample_type) and changeable on the Confirmed Order
// (orders.sample_type, set_order_sample_type). The Order's own choice stands
// once one has been made there (orders.sample_type_set_at is not NULL — and a
// NULL value then means "explicitly not a sample"); until then the PI's choice
// applies. A PI sent below the standard advance with the reason "Sample order"
// (advance_exception_reason_code) still reads as a sample order when nobody
// has chosen anything — that was the list's only signal before this column.
//
// IT DECIDES NOTHING. Who may write is re-derived by the two RPCs.

export type SampleType = 'sampling_needed' | 'sample_order'

export const SAMPLE_TYPES: readonly SampleType[] = ['sampling_needed', 'sample_order']

/** The words a reader sees: the option, the tooltip and the Order's row. */
export const SAMPLE_TYPE_LABEL: Record<SampleType, string> = {
  sampling_needed: 'Sampling needed before production',
  sample_order: 'Sample order only',
}

/** Short words for the select's options (the full words are the tooltip). */
export const SAMPLE_TYPE_OPTION_LABEL: Record<SampleType, string> = {
  sampling_needed: 'Sampling needed',
  sample_order: 'Sample order only',
}

export const SAMPLE_NONE_LABEL = 'Not a sample'
export const SAMPLE_FIELD_LABEL = 'Sample'
export const SAMPLE_FIELD_HINT = 'Shown as a symbol beside the Project code on Confirmed Orders.'

export const PI_SAMPLE_TYPE_RPC = 'set_order_submission_sample_type'
export const ORDER_SAMPLE_TYPE_RPC = 'set_order_sample_type'

export function readSampleType(v: unknown): SampleType | null {
  return v === 'sampling_needed' || v === 'sample_order' ? v : null
}

/**
 * The sample type in force for an Order: its own choice once made, else the
 * PI's, else the legacy "Sample order" advance reason.
 */
export function effectiveSampleType(input: {
  orderSampleType?: string | null
  orderSampleTypeSetAt?: string | null
  piSampleType?: string | null
  piAdvanceReasonCode?: string | null
}): SampleType | null {
  if (input.orderSampleTypeSetAt) return readSampleType(input.orderSampleType)
  const pi = readSampleType(input.piSampleType)
  if (pi) return pi
  return input.piAdvanceReasonCode === 'sample_order' ? 'sample_order' : null
}

/** A database refusal, as a sentence for the reader. */
export function describeSampleTypeFailure(error: { message?: string | null } | null | undefined): string {
  const raw = error?.message ?? ''
  const coded = raw.match(/(?:ORDER_SUBMISSION|ORDER)_[A-Z_]+: ([\s\S]*)$/)
  if (coded) return coded[1]
  return 'That did not save. Refresh and try again.'
}
