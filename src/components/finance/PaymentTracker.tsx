// ── The payment tracker ──────────────────────────────────────────────────────
//
// One picture for every payment (Payments counted once, 2026-10-29): Recorded,
// then what Finance has done with it. Green is done, amber is waiting, red needs
// a person. The third step (In the bank / Cash received) arrives with the bank
// proof step; until then the tracker has two.
//
// Server-safe: no hooks, so it renders the same in a test and on the page.

import { colors } from '@/lib/tokens'
import { paymentStatusWord, paymentStepTone, type PaymentStepTone } from '@/lib/finance/paymentWords'

const TONE: Record<PaymentStepTone | 'recorded', { dot: string; text: string }> = {
  recorded: { dot: '#276247', text: '#276247' },
  done:     { dot: '#276247', text: '#276247' },
  waiting:  { dot: '#C48A1A', text: '#805B0D' },
  problem:  { dot: '#B42332', text: '#A12438' },
}

function Step({ label, tone }: { label: string; tone: PaymentStepTone | 'recorded' }) {
  const t = TONE[tone]
  return (
    <span className={`payment-track-step payment-track-step--${tone}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      fontSize: '12px', fontWeight: 600, color: t.text, whiteSpace: 'nowrap',
    }}>
      <span aria-hidden="true" style={{
        width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0,
        background: tone === 'waiting' ? colors.amberTint : t.dot,
        border: `2px solid ${t.dot}`,
      }} />
      {label}
    </span>
  )
}

export function PaymentTracker({ status }: { status: string | null | undefined }) {
  const tone = paymentStepTone(status)
  const word = paymentStatusWord(status)
  return (
    <span
      className="payment-track"
      role="img"
      aria-label={`Recorded, then ${word}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}
    >
      <Step label="Recorded" tone="recorded" />
      <span aria-hidden="true" style={{
        width: '16px', height: '2px', flexShrink: 0,
        background: tone === 'done' ? TONE.done.dot : colors.border,
      }} />
      <Step label={word} tone={tone} />
    </span>
  )
}
