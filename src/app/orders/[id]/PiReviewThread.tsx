'use client'

// THE PI REVIEW THREAD on the Confirmed Order page (owner, 2026-11-14): who holds the PI version now, and every
// hop so far — flags, send-backs, replies, pass-ons — with its round. A function of its props; the rules are
// in lib/orders/piReviewThread. Drawn only when Operations has flagged a version at least once.
// It lives INSIDE the operations-review notice (owner, 14 Nov: "part of the above box, with a link to open a
// popup"): one line in the notice says who holds it and how many steps, and opens the full thread in a popup.
// Every text keeps the writer's own line breaks (white-space: pre-line).

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { OrderModal } from '@/components/orders/OrderModal'
import type { ChainHolder } from '@/lib/orders/operationsHandoff'
import type { ThreadEntry } from '@/lib/orders/piReviewThread'

const DOT: Record<ThreadEntry['tone'], string> = { neutral: colors.muted, amber: colors.amber, red: colors.red, green: colors.green }

const HOLDER_WORDS: Record<ChainHolder, (since: string | null) => string> = {
  operations: since => `With Operations${since ? ` since ${since}` : ''}`,
  coordinator: since => `With the approver${since ? ` since ${since}` : ''}`,
  sales: since => `With Sales${since ? ` since ${since}` : ''}`,
}

export function reviewThreadSummary(holder: ChainHolder | null, holderSince: string | null, rounds: number, steps: number): string {
  return [holder ? HOLDER_WORDS[holder](holderSince) : 'Settled', rounds >= 2 ? `Round ${rounds}` : null, `${steps} steps`]
    .filter(Boolean).join(' · ')
}

export function PiReviewThreadLink({ entries, rounds, holder, holderSince, formatWhen, orderNumber }: {
  entries: readonly ThreadEntry[]
  rounds: number
  /** Who holds the live version; null once it is accepted or when nothing is live. */
  holder: ChainHolder | null
  /** When they got it, already formatted; null when not known. */
  holderSince: string | null
  formatWhen: (iso: string) => string
  orderNumber: string
}) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0 || rounds < 1) return null
  const summary = reviewThreadSummary(holder, holderSince, rounds, entries.length)
  return (
    <>
      <button type="button" data-review-thread="true" onClick={() => setOpen(true)} style={{
        alignSelf: 'flex-start', marginTop: 6, padding: 0, border: 0, background: 'none', cursor: 'pointer',
        font: 'inherit', fontSize: 13, color: colors.primary, textAlign: 'left',
      }}>
        <span style={{ fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 3 }}>PI review thread</span>
        <span style={{ color: colors.secondary }}> · {summary}</span>
      </button>
      {open && (
        <OrderModal title="PI review thread" subtitle={`Order ${orderNumber} · ${summary}`} width={640} onClose={() => setOpen(false)}>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {entries.map(e => (
              <li key={e.key} style={{ display: 'grid', gridTemplateColumns: '12px 1fr', gap: 10, alignItems: 'start' }}>
                <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: DOT[e.tone], marginTop: 6 }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: colors.primary, fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {e.round >= 1 ? <span style={{ color: colors.muted, fontWeight: 500 }}>R{e.round} · </span> : null}{e.title}
                  </span>
                  <span style={{ fontSize: 12, color: colors.muted }}>{formatWhen(e.atIso)}</span>
                  {e.text && <span style={{ fontSize: 13, color: colors.secondary, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>“{e.text}”</span>}
                </span>
              </li>
            ))}
          </ol>
        </OrderModal>
      )}
    </>
  )
}
