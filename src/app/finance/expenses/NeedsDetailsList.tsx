'use client'

// ── Needs Details — the captures waiting for the rest of themselves ─────────
//
// ── WHY "NEEDS DETAILS" AND NOT "PENDING APPROVAL" ─────────────────────────
//
// Nobody else has to look at these. A capture is waiting for ITS OWN AUTHOR to
// finish it, and calling that queue "approval" would invent a second person, a
// second permission and a rejection path that do not exist anywhere in this
// workflow. Every word on this screen says Needs Details, and the action is
// Complete, not Approve.
//
// ── NOTHING HERE IS AN EXPENSE ─────────────────────────────────────────────
//
// Not one row on this tab counts towards the expense total, the category
// totals, the Smart suggestion's learning or any report — and not because this
// component filters them out. They live in public.expense_drafts, and NOTHING
// THAT READS EXPENSES READS THAT TABLE. The separation is structural; this
// screen is just where the other table is shown.
//
// ── CARDS, AT EVERY WIDTH ──────────────────────────────────────────────────
//
// Unlike the expense list there is no table variant. A draft is read, not
// scanned: its captured sentence is the important part and a sentence does not
// belong in a 120px column. Cards fit 320px and 1440px alike, so there is no
// threshold to get wrong.

import { useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import type { createClient } from '@/lib/supabase/client'
import {
  DISCARD_DRAFT_EXPLANATION,
  NEEDS_DETAILS_BLURB,
  draftMissingFields,
  draftMissingSummary,
  type ExpenseDraftRow,
} from '@/lib/finance/expenseDrafts'
import { friendlyWriteError } from './ExpenseForm'

type Supabase = ReturnType<typeof createClient>

function fmtCaptured(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDate(value: string): string {
  const at = new Date(`${value}T00:00:00`)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function NeedsDetailsList({
  rows, loading, error, personName, mayAct, onComplete, onDiscarded, supabase, userId,
}: {
  rows: readonly ExpenseDraftRow[]
  loading: boolean
  error: string | null
  personName: (id: string) => string
  mayAct: (row: ExpenseDraftRow) => boolean
  onComplete: (row: ExpenseDraftRow) => void
  onDiscarded: (row: ExpenseDraftRow) => void
  supabase: Supabase
  userId: string
}) {
  const [discarding, setDiscarding] = useState<ExpenseDraftRow | null>(null)

  if (loading) {
    return <Empty title="Loading captures…" />
  }
  if (error) {
    return <Empty title={error} tone="error" />
  }
  if (rows.length === 0) {
    return (
      <Empty
        title="Nothing is waiting for details."
        body="Anything captured in a hurry shows up here until you complete it."
      />
    )
  }

  return (
    <>
      <div style={{
        padding: '10px 14px', fontSize: '11.5px', color: colors.tertiary,
        lineHeight: 1.55, borderBottom: `1px solid ${colors.border}`,
      }}>
        {NEEDS_DETAILS_BLURB}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map(row => {
          const missing = draftMissingFields(row)
          const actionable = mayAct(row)
          return (
            <div
              key={row.id}
              data-testid="needs-details-row"
              style={{
                padding: '13px 14px', borderBottom: `1px solid ${colors.border}`,
                display: 'flex', flexDirection: 'column', gap: '7px',
              }}
            >
              {/* ── THE CAPTURED TEXT, FIRST AND VERBATIM. Everything below is a
                  machine's reading of this line, and it is only checkable while
                  the line itself is on screen beside it. */}
              <div style={{ fontSize: '13px', color: colors.primary, lineHeight: 1.5 }}>
                &ldquo;{row.raw_text}&rdquo;
              </div>

              {/* What was understood: the amount and the payee, which are the
                  two facts somebody needs to recognise their own capture. */}
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap',
                fontSize: '12.5px', color: colors.secondary,
              }}>
                {row.parsed_amount !== null ? (
                  <span style={{ fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                    {formatMoney(row.parsed_amount)}
                  </span>
                ) : (
                  <span style={{ fontWeight: 600, color: '#8A5A00' }}>Amount missing</span>
                )}
                <span>{row.parsed_paid_to ?? 'Payee not heard'}</span>
                <span style={{ color: colors.muted, fontSize: '11.5px' }}>
                  Paid {fmtDate(row.parsed_date)}
                </span>
              </div>

              {/* ── WHAT COMPLETING IT WILL ASK FOR ──
                  Said here, on the card, so the decision to open it is made
                  with the answer already known. */}
              <div style={{
                fontSize: '11.5px', lineHeight: 1.5,
                color: missing.length > 0 ? '#8A5A00' : colors.tertiary,
              }}>
                {draftMissingSummary(missing)}
              </div>

              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '8px', flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: '11px', color: colors.muted }}>
                  Captured {fmtCaptured(row.created_at)} · {personName(row.created_by)}
                </span>
                {actionable && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={() => setDiscarding(row)}
                      className="boe-btn boe-btn-ghost"
                      style={{ minHeight: '40px', padding: '6px 12px', fontSize: '12.5px' }}
                      aria-label={`Discard the capture “${row.raw_text}”`}
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      onClick={() => onComplete(row)}
                      className="boe-btn boe-btn-primary"
                      style={{ minHeight: '40px', padding: '6px 16px', fontSize: '12.5px' }}
                      aria-label={`Complete the capture “${row.raw_text}”`}
                    >
                      Complete
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {discarding && (
        <DiscardDraftModal
          supabase={supabase}
          userId={userId}
          draft={discarding}
          onClose={() => setDiscarding(null)}
          onDiscarded={row => { setDiscarding(null); onDiscarded(row) }}
        />
      )}
    </>
  )
}

// ── Discarding one ───────────────────────────────────────────────────────────
//
// NOT A DELETION. The row stays, with who discarded it and when — there is no
// DELETE policy on public.expense_drafts either, so this is a status change and
// could not be anything else. A confirmation, because a capture is somebody's
// only record of a payment until they complete it, and one stray tap on a phone
// should not be able to lose it.
//
// NO TYPED WORD HERE, DELIBERATELY, and the asymmetry with the expense delete
// dialog is the point: discarding an unfinished note costs a sentence of typing
// to recreate, while deleting a finalized expense removes a figure from a total
// somebody has reconciled. The friction should match the consequence, or people
// learn to type past it without reading.

function DiscardDraftModal({
  supabase, userId, draft, onClose, onDiscarded,
}: {
  supabase: Supabase
  userId: string
  draft: ExpenseDraftRow
  onClose: () => void
  onDiscarded: (row: ExpenseDraftRow) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const discard = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const { error: dbError } = await supabase
        .from('expense_drafts')
        .update({ status: 'discarded', discarded_by: userId, discarded_at: new Date().toISOString() })
        .eq('id', draft.id)
        // ONLY A PENDING ONE. The guard trigger refuses anything else anyway;
        // this makes a stale list a no-op rather than an error to interpret.
        .eq('status', 'pending')

      if (dbError) { setError(friendlyWriteError(dbError)); return }
      onDiscarded(draft)
    } catch {
      setError('The capture could not be discarded. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <FinanceModal title="Discard capture" onClose={onClose} width="400px" closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '10px',
          background: colors.raised, padding: '11px 13px',
          fontSize: '12.5px', color: colors.primary, lineHeight: 1.5,
        }}>
          &ldquo;{draft.raw_text}&rdquo;
        </div>
        <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
          {DISCARD_DRAFT_EXPLANATION}
        </div>
        {error && (
          <div role="alert" style={{
            padding: '10px 12px', borderRadius: '8px',
            background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button" onClick={onClose} disabled={busy}
            className="boe-btn boe-btn-ghost" style={{ minHeight: '44px', fontSize: '13px' }}
          >
            Keep it
          </button>
          <button
            type="button" onClick={() => void discard()} disabled={busy}
            className="boe-btn"
            style={{
              minHeight: '44px', fontSize: '13px', minWidth: '120px', fontWeight: 600,
              background: busy ? 'rgba(217,79,79,0.18)' : '#C13030',
              color: busy ? 'rgba(193,48,48,0.65)' : '#FFFFFF',
              border: '1px solid rgba(193,48,48,0.35)',
            }}
          >
            {busy ? 'Discarding…' : 'Discard'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}

function Empty({ title, body, tone }: { title: string; body?: string; tone?: 'error' }) {
  return (
    <div style={{
      padding: '36px 20px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: tone === 'error' ? '#C13030' : colors.secondary }}>
        {title}
      </div>
      {body && <div style={{ fontSize: '12px', color: colors.muted, maxWidth: '340px', lineHeight: 1.55 }}>{body}</div>}
    </div>
  )
}
