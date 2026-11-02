import type { ReactNode } from 'react'
import { CircleCheck, Clock, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ChipTone } from '@/lib/orders/adminDashboard'
import styles from './adminDashboard.module.css'

const TONE_CLASS: Record<ChipTone, string> = {
  ok: styles.chipOk, warn: styles.chipWarn, danger: styles.chipDanger, info: styles.chipInfo, neutral: styles.chipNeutral,
}

/** The icon a tone carries when the caller has no better one, so colour is never the only signal. */
export const TONE_ICON: Record<ChipTone, LucideIcon> = {
  ok: CircleCheck, warn: TriangleAlert, danger: TriangleAlert, info: Clock, neutral: Clock,
}

export function ToneChip({ tone, icon: Icon, children }: { tone: ChipTone; icon: LucideIcon; children: ReactNode }) {
  return (
    <span className={`${styles.chip} ${TONE_CLASS[tone]}`}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {children}
    </span>
  )
}
