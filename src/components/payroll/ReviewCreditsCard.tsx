// "BOE Credits — October reviews" on a payslip: one row per approved review and
// the credit it earned, then what the month earned, what was applied to this
// salary, and what the employee still holds.
//
// Shown to the admin reviewing the payslip AND to the employee whose payslip it
// is. Read-only, and it adds no arithmetic: every figure arrives finished from
// src/lib/payroll/reviewCredits.ts. It explains the "BOE Credit Addition" line
// (the credits the employee APPLIED); it never changes it.

import { formatRupees } from '@/lib/payroll/money'
import { formatCredits, reviewMonthLabel } from '@/lib/boeCredits/ledger'
import { formatCreditValue } from '@/lib/boeCredits/settings'
import { reviewMonthNote, type PayslipReviewCredit, type PayslipReviewCreditsBlock } from '@/lib/payroll/reviewCredits'

const TYPE_LABEL: Record<string, string> = { text: 'Text review', image: 'Image review' }

/** "29 Oct" from YYYY-MM-DD, built from the parts so no timezone shifts the day. */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const NOTE_STYLE = {
  pending: { fg: '#805B0D', bg: 'rgba(196,138,26,0.10)', border: 'rgba(196,138,26,0.35)' },
  ok:      { fg: '#276247', bg: 'rgba(39,98,71,0.07)',   border: 'rgba(39,98,71,0.25)' },
  lapsed:  { fg: '#B42332', bg: 'rgba(180,35,50,0.07)',  border: 'rgba(180,35,50,0.22)' },
} as const

function ReviewRow({ r }: { r: PayslipReviewCredit }) {
  return (
    <li style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 12, flexWrap: 'wrap', padding: '7px 0',
      borderBottom: '1px solid #F0EBE4', listStyle: 'none',
    }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: r.reversed ? '#686D6C' : '#303536', whiteSpace: 'nowrap' }}>
          {shortDay(r.submitted_on)}
        </span>
        <span style={{
          fontSize: 11.5, fontWeight: 600, color: '#4C5352', background: '#F7F5F1',
          border: '1px solid #E4DED7', borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap',
        }}>
          {(r.review_type && TYPE_LABEL[r.review_type]) || 'Review'}
        </span>
        <span style={{ fontSize: 12, color: '#686D6C', fontVariantNumeric: 'tabular-nums' }}>{r.card_ref}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap' }}>
        {r.reversed && (
          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#B42332' }}>Reversed</span>
        )}
        <span style={{
          fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: r.reversed ? '#686D6C' : '#276247',
          textDecoration: r.reversed ? 'line-through' : 'none',
        }}>
          {formatCredits(r.credits, { signed: true })}
        </span>
      </span>
    </li>
  )
}

function TotalRow({ label, value, remark, strong }: { label: string; value: string; remark?: string | null; strong?: boolean }) {
  return (
    <div style={{ padding: '5px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: strong ? 13 : 12.5, fontWeight: strong ? 600 : 400, color: strong ? '#4C5352' : '#686D6C' }}>
          {label}
        </span>
        <span style={{
          fontSize: strong ? 14 : 13.5, fontWeight: strong ? 700 : 600, color: '#4C5352',
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>
          {value}
        </span>
      </div>
      {remark && (
        <div style={{ fontSize: 12, color: '#686D6C', marginTop: 2, lineHeight: 1.45 }}>{remark}</div>
      )}
    </div>
  )
}

export function ReviewCreditsCard({
  credits, isAdmin, applied,
}: {
  credits: PayslipReviewCreditsBlock
  isAdmin: boolean
  /**
   * What the employee has put on THIS payroll month: the settlement's own
   * `credits`, which the page keeps current when they apply, change or remove it.
   */
  applied: { credits_used: number; amount: number } | null
}) {
  const monthName = reviewMonthLabel(credits.review_month, { year: false })
  const note = reviewMonthNote(credits)
  const rate = formatCreditValue(credits.credit_value)

  return (
    <section
      aria-labelledby="review-credits-heading"
      style={{
        background: '#fff', borderRadius: 12, border: '1px solid #E4DED7',
        overflow: 'hidden', padding: '13px 16px 15px', marginTop: 16,
      }}
    >
      <div
        id="review-credits-heading"
        style={{
          fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.09em', color: '#686D6C', marginBottom: 4,
        }}
      >
        BOE Credits · {monthName} reviews
      </div>

      <ul style={{ margin: 0, padding: 0 }}>
        {credits.reviews.map(r => <ReviewRow key={r.transaction_id} r={r} />)}
      </ul>

      {note && (
        <div style={{
          marginTop: 10, padding: '8px 11px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
          color: NOTE_STYLE[note.tone].fg, background: NOTE_STYLE[note.tone].bg,
          border: `1px solid ${NOTE_STYLE[note.tone].border}`,
        }}>
          {note.text}
        </div>
      )}

      <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '11px 0 6px' }} />

      <TotalRow
        label={`Earned from ${monthName} reviews`}
        value={formatCredits(credits.earned_credits)}
        remark={`Worth ${formatRupees(credits.earned_amount)} at ${rate} a credit`}
        strong
      />
      <TotalRow
        label="Applied to this salary"
        value={applied ? formatCredits(applied.credits_used) : 'None'}
        remark={applied ? `${formatRupees(applied.amount)} added as the BOE Credit Addition` : null}
      />
      <TotalRow
        label="Spendable now"
        value={formatCredits(credits.spendable_credits)}
        remark="Across all months, not yet applied to any salary"
      />

      {isAdmin && (
        <div style={{ fontSize: 12, color: '#686D6C', marginTop: 8, lineHeight: 1.5 }}>
          Credits reach salary only when the employee applies them from their own payslip.
        </div>
      )}
    </section>
  )
}
