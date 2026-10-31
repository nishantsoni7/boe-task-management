'use client'

// ── Founders' payouts: the small pieces more than one tab draws ──────────────

import type { FounderPayoutKind, SideYear } from '@/lib/finance/founderPayouts'
import styles from './founders.module.css'

/**
 * Drawings is grey on purpose: it is the money that is not a named kind of pay.
 * The other four pass the colour-blind checks of the dataviz validator; beside
 * them the old Salary teal (#2F6E8F) failed against Interest.
 */
export const KIND_COLOUR: Record<FounderPayoutKind, string> = {
  partner_remuneration: '#4F7FB8',
  incentive: '#3F9B6E',
  interest_on_capital: '#8A6FB8',
  salary: '#C98A2B',
  drawings: '#A8A39C',
}

const SIDE_COLOURS = ['#4F7FB8', '#C98A2B', '#8A6FB8', '#3F9B6E']

export function sideColour(sides: readonly SideYear[], side: string): string {
  return SIDE_COLOURS[Math.max(0, sides.findIndex(s => s.side === side)) % SIDE_COLOURS.length]
}

export function SideDot({ sides, side }: { sides: readonly SideYear[]; side: string }) {
  return <span className="fin-dot" aria-hidden="true" style={{ background: sideColour(sides, side) }} />
}

/** The line that heads a side's group of accounts. */
export function SideLabel({ sides, side, count }: { sides: readonly SideYear[]; side: string; count?: number }) {
  return (
    <span className={styles.sideLabel}>
      <SideDot sides={sides} side={side} /> {side}&rsquo;s side
      {count !== undefined && <span className={styles.count}>· {count} account{count === 1 ? '' : 's'}</span>}
    </span>
  )
}

export type MeterTone = 'good' | 'warn' | 'bad'

const FILL: Record<MeterTone, string> = { good: styles.fillGood, warn: styles.fillWarn, bad: styles.fillBad }

/** Red past the line, amber in the last 15% of it. */
export function meterTone(roomRupees: number, percent: number): MeterTone {
  if (roomRupees < 0) return 'bad'
  return percent > 85 ? 'warn' : 'good'
}

export function Meter({ percent, tone, label }: { percent: number; tone: MeterTone; label: string }) {
  return (
    <div className={styles.meter} role="img" aria-label={label}>
      <span className={`${styles.meterFill} ${FILL[tone]}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  )
}
