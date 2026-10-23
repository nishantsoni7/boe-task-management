'use client'

import { CheckCircle2, Clock, AlertTriangle, Hand } from 'lucide-react'
import { cashStateLabel, waitingAge, type CashPayment } from '@/lib/finance/cashJourney'

const STYLE: Record<CashPayment['state'], { fg: string; bg: string; border: string }> = {
  with_company: { fg: '#1B4A35', bg: '#E8F2EC', border: 'rgba(39,98,71,0.45)' },
  waiting:      { fg: '#5E4106', bg: '#FFF8E8', border: 'rgba(196,138,26,0.6)' },
  disputed:     { fg: '#5F1B49', bg: '#F9EAF4', border: 'rgba(138,43,107,0.6)' },
  with_holder:  { fg: '#6A3208', bg: '#FFF0E3', border: 'rgba(210,105,30,0.55)' },
}

/**
 * Where a payment's money is, in one chip: icon + words + how long, never colour
 * alone. The same chip on the Finance page, the order and PI pages and the
 * journey.
 */
export function CashStateChip({ payment, showAge = true, quiet = false }: { payment: CashPayment; showAge?: boolean; quiet?: boolean }) {
  const s = STYLE[payment.state]
  const Icon = payment.state === 'with_company' ? CheckCircle2
    : payment.state === 'disputed' ? AlertTriangle
    : payment.state === 'waiting' ? Clock : Hand
  // quiet: no pill, just the icon and words in the status colour (list rows).
  const chip = (
    <span style={quiet ? {
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: s.fg,
      maxWidth: '100%', whiteSpace: 'normal',
    } : {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999,
      fontSize: 12.5, fontWeight: 700, color: s.fg, background: s.bg, border: `1px solid ${s.border}`,
      maxWidth: '100%', whiteSpace: 'normal',
    }}>
      <Icon size={13} strokeWidth={2} aria-hidden="true" />
      {cashStateLabel(payment)}
      {showAge && payment.state !== 'with_company' && payment.ageHours >= 1 && (
        <span style={{ fontWeight: 500 }}>· {waitingAge(payment.ageHours)}</span>
      )}
    </span>
  )
  // ORDER APPROVED WITHOUT THIS CASH (20270414000000): said under the chip, with
  // the approver's reason, for as long as the money has not reached the company.
  if (!payment.orderException || payment.state === 'with_company') return chip
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, maxWidth: '100%' }}>
      {chip}
      <span style={{ fontSize: 12, color: '#7A1523', fontWeight: 600, overflowWrap: 'anywhere' }}>
        Order approved without this cash{payment.orderException.byName ? ` by ${payment.orderException.byName}` : ''}: “{payment.orderException.reason}”
      </span>
    </span>
  )
}
