'use client'

// THE PI REVIEW THREAD on the Confirmed Order page (owner, 2026-11-14): who holds the PI version now, and every
// hop so far — flags, send-backs, replies, pass-ons — with its round. A function of its props; the rules are
// in lib/orders/piReviewThread. Drawn only when Operations has flagged a version at least once, open while the
// loop is still going, closed once it is settled so it does not crowd the page.

import { colors } from '@/lib/tokens'
import type { ChainHolder } from '@/lib/orders/operationsHandoff'
import type { ThreadEntry } from '@/lib/orders/piReviewThread'

const DOT: Record<ThreadEntry['tone'], string> = { neutral: colors.muted, amber: colors.amber, red: colors.red, green: colors.green }

const HOLDER_WORDS: Record<ChainHolder, (since: string | null) => string> = {
  operations: since => `With Operations${since ? ` since ${since}` : ''}`,
  coordinator: since => `With the approver${since ? ` since ${since}` : ''}`,
  sales: since => `With Sales${since ? ` since ${since}` : ''}`,
}

export function PiReviewThread({ entries, rounds, holder, holderSince, formatWhen, defaultOpen }: {
  entries: readonly ThreadEntry[]
  rounds: number
  /** Who holds the live version; null once it is accepted or when nothing is live. */
  holder: ChainHolder | null
  /** When they got it, already formatted; null when not known. */
  holderSince: string | null
  formatWhen: (iso: string) => string
  defaultOpen: boolean
}) {
  if (entries.length === 0 || rounds < 1) return null
  const summary = [holder ? HOLDER_WORDS[holder](holderSince) : 'Settled', rounds >= 2 ? `Round ${rounds}` : null, `${entries.length} steps`]
    .filter(Boolean).join(' · ')
  return (
    <details open={defaultOpen} data-review-thread="true" style={{
      margin: '0 0 12px', padding: '10px 14px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: 10,
    }}>
      <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600, color: colors.primary }}>
        PI review thread <span style={{ fontWeight: 400, color: colors.muted }}>· {summary}</span>
      </summary>
      <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.map(e => (
          <li key={e.key} style={{ display: 'grid', gridTemplateColumns: '12px 1fr', gap: 10, alignItems: 'start' }}>
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: DOT[e.tone], marginTop: 6 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 14, color: colors.primary, fontWeight: 600, overflowWrap: 'anywhere' }}>
                {e.round >= 1 ? <span style={{ color: colors.muted, fontWeight: 500 }}>R{e.round} · </span> : null}{e.title}
              </span>
              <span style={{ fontSize: 12, color: colors.muted }}>{formatWhen(e.atIso)}</span>
              {e.text && <span style={{ fontSize: 13, color: colors.secondary, overflowWrap: 'anywhere' }}>“{e.text}”</span>}
            </span>
          </li>
        ))}
      </ol>
    </details>
  )
}
