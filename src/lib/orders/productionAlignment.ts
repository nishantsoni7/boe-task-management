// Production alignment of a Confirmed Order, as words and as a rule.
//
// COMMERCIAL APPROVAL IS NOT PRODUCTION ACCEPTANCE. An Order is born
// `not_aligned` (20261119000000): management has agreed the deal, and the Head
// of Manufacturing has not yet said the factory can make it on these terms and
// in this time. Aligning it is that second, explicit decision, taken through
// set_order_production_alignment() under orders.align_production.
//
// NONE OF THIS IS AUTHORIZATION. The RPC re-derives the permission and the
// Order's state under a row lock; this decides what is drawn and what it says.

import type { OrdersCapabilities } from '@/lib/permissions/orders'

export type ProductionAlignment = 'not_aligned' | 'aligned'

export const PRODUCTION_ALIGNMENT_LABEL: Record<ProductionAlignment, string> = {
  not_aligned: 'Not Aligned',
  aligned:     'Aligned',
}

export const PRODUCTION_ALIGNMENT_HINT: Record<ProductionAlignment, string> = {
  not_aligned: 'Awaiting the Head of Manufacturing: feasibility, timeframe and costing are not yet confirmed.',
  aligned:     'Aligned for production.',
}

export const PRODUCTION_SECTION_LABEL = 'Production'
export const ALIGN_PRODUCTION_BUTTON_LABEL = 'Align for Production'
export const UNALIGN_PRODUCTION_BUTTON_LABEL = 'Remove alignment'
export const ALIGN_PRODUCTION_DIALOG_TITLE = 'Align for production'
export const UNALIGN_PRODUCTION_DIALOG_TITLE = 'Remove production alignment'
export const ALIGN_PRODUCTION_NOTE_LABEL = 'Note (optional)'
export const ALIGN_PRODUCTION_NOTE_PLACEHOLDER =
  'e.g. feasibility checked, 6-week timeframe, costing agreed'
export const ALIGN_PRODUCTION_NOTE_MAX_LENGTH = 500
export const ALIGN_PRODUCTION_NOTE_TOO_LONG =
  `A note may be at most ${ALIGN_PRODUCTION_NOTE_MAX_LENGTH} characters.`
export const ALIGN_PRODUCTION_CONFIRM =
  'This records that the order is technically feasible, its production timeframe and costing have been checked, and it may be taken into production.'

export function asProductionAlignment(value: string | null | undefined): ProductionAlignment {
  return value === 'aligned' ? 'aligned' : 'not_aligned'
}

export type ProductionAlignmentView = {
  value: ProductionAlignment
  label: string
  hint: string
  /** "Aligned by X · date", or null while not aligned. */
  line: string | null
  note: string | null
  /** The control's label for the NEXT move, or null when none is offered. */
  action: string | null
}

export function describeProductionAlignment(input: {
  alignment: string | null | undefined
  alignedByName: string | null
  /** Already formatted, or null. This module does no date work. */
  alignedAt: string | null
  note: string | null
  orderStatus: string
  canAlign: boolean
}): ProductionAlignmentView {
  const value = asProductionAlignment(input.alignment)
  const line = value === 'aligned' && input.alignedAt
    ? `Aligned by ${input.alignedByName && input.alignedByName.trim() !== '' ? input.alignedByName.trim() : 'a colleague'} · ${input.alignedAt}`
    : null
  const offered = input.canAlign && input.orderStatus !== 'cancelled'
  return {
    value,
    label: PRODUCTION_ALIGNMENT_LABEL[value],
    hint: PRODUCTION_ALIGNMENT_HINT[value],
    line,
    note: input.note && input.note.trim() !== '' ? input.note.trim() : null,
    action: !offered ? null
      : value === 'aligned' ? UNALIGN_PRODUCTION_BUTTON_LABEL
      : ALIGN_PRODUCTION_BUTTON_LABEL,
  }
}

/** The browser-side half of the rule: orders.align_production, admin included,
 *  never lent by View As. */
export function canAlignProduction(caps: Pick<OrdersCapabilities, 'canAlignProduction'>, viewingAs: boolean): boolean {
  return caps.canAlignProduction && !viewingAs
}

export type NoteValidation = { ok: true; note: string | null } | { ok: false; message: string }

export function validateAlignmentNote(value: string | null | undefined): NoteValidation {
  const note = (value ?? '').trim()
  if (note === '') return { ok: true, note: null }
  if (note.length > ALIGN_PRODUCTION_NOTE_MAX_LENGTH) return { ok: false, message: ALIGN_PRODUCTION_NOTE_TOO_LONG }
  return { ok: true, note }
}

const FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'ORDER_PRODUCTION_ALIGNMENT_CLOSED', message: 'This Order is cancelled and cannot be aligned for production.' },
  { marker: 'ORDER_PRODUCTION_ALIGNMENT_NOTE_TOO_LONG', message: ALIGN_PRODUCTION_NOTE_TOO_LONG },
  { marker: 'do not have permission', message: 'You do not have permission to align an Order for production.' },
  { marker: 'Authentication required', message: 'Your session has expired. Sign in again and try once more.' },
]

export const ALIGNMENT_FALLBACK = 'The production alignment could not be changed just now. Try again in a moment.'

export function describeAlignmentFailure(error: unknown): string {
  const raw = typeof error === 'string'
    ? error
    : String((error as { message?: unknown } | null)?.message ?? '')
  const known = FAILURES.find(entry => raw.includes(entry.marker))
  return known ? known.message : ALIGNMENT_FALLBACK
}
