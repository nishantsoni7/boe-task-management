import { colors } from '@/lib/tokens'
import { paymentModeHelper } from '@/lib/finance/paymentEntry'

// The one line under a Payment Mode picker saying what kind of route the chosen
// account is. Draws nothing for a legacy mode, which has no current meaning to
// explain. For entry, editing and verification screens only — never a list.

export function PaymentModeHint({ mode, id }: { mode: string | null | undefined; id?: string }) {
  const text = paymentModeHelper(mode)
  if (!text) return null
  return (
    <span id={id} style={{ display: 'block', fontSize: '11.5px', color: colors.muted, marginTop: '4px', lineHeight: 1.45 }}>
      {text}
    </span>
  )
}
