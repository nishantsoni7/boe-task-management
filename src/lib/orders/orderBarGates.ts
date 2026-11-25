// THE FACTS LINE'S TWO GATES, IN WORDS (Nitish / Operations, 24 Nov 2026).
//
// Under the order number the Order page draws ONE line of facts: ERP, Production,
// Order type, Due with its countdown, and Advance. Two of them need wording: the
// due date's countdown and the advance cell, which says whether production can
// start on the money Finance has verified.
//
// THIS FILE ONLY WORDS THINGS. Every figure and status is handed in already
// computed by the page's own builders (the advance readiness, the dates timeline)
// and is never recomputed here: the line is a second VIEW of the same values, and
// the detail still lives once, in the Payment and Dates sections. Nothing here
// reads, writes or authorizes, so it is safe to unit test without React.
//
// (The seven folded rows that used to share this file are gone: every section
// below the products is open now, so none needs a one-line summary.)

import { dueCountdownLabel } from '@/lib/orders/orderDatesTimeline'
import { percentText, type AdvanceReadiness } from '@/lib/orders/advanceReadiness'

export type ChipTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red'

export type BarGate = {
  /** What is drawn in the cell. */
  value: string
  chip: { text: string; tone: ChipTone } | null
  /** One sentence for a screen reader and the tooltip. */
  label: string
}

export type OrderBarGates = {
  due: { date: string | null; countdown: string | null; late: boolean }
  advance: BarGate
}

const DASH = '—'

/**
 * The advance cell. The percentage and the threshold are the database's own
 * (order_advance_readiness), measured on the Total before GST exactly as the
 * Payment section says; the 40 is never a literal here.
 */
export function advanceGate(advance: AdvanceReadiness | null): BarGate {
  if (!advance) return { value: DASH, chip: null, label: 'Not read yet' }
  const threshold = percentText(advance.threshold_percent)
  if (advance.value_known === false) {
    return {
      value: DASH,
      chip: { text: 'Cannot measure', tone: 'amber' },
      label: 'The advance cannot be measured: no Total before GST is on record',
    }
  }
  const value = advance.percent === null || advance.percent === undefined ? DASH : percentText(advance.percent)
  const base = 'of the Total before GST, verified by Finance'
  if (!advance.below) {
    return { value, chip: { text: 'Met', tone: 'green' }, label: `${value} ${base}; the ${threshold} requirement is met` }
  }
  if (advance.ready && advance.exception) {
    return {
      value,
      chip: { text: `Approved below ${threshold}`, tone: 'amber' },
      label: `${value} ${base}; production is approved below ${threshold}`,
    }
  }
  if (advance.hold) {
    return { value, chip: { text: 'On hold', tone: 'red' }, label: `${value} ${base}; production is on hold, below ${threshold}` }
  }
  return { value, chip: { text: `Below ${threshold}`, tone: 'red' }, label: `${value} ${base}; below the ${threshold} requirement` }
}

export function orderBarGates(input: {
  advance: AdvanceReadiness | null
  dueDate: string | null
  daysToDue: number | null
}): OrderBarGates {
  return {
    due: {
      date: input.dueDate,
      countdown: input.daysToDue === null ? null : dueCountdownLabel(input.daysToDue),
      late: input.daysToDue !== null && input.daysToDue < 0,
    },
    advance: advanceGate(input.advance),
  }
}
