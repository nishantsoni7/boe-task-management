'use client'

// "BOE Credits" on the employee's own payslip — turn spendable credits into a
// salary addition for this month (Phase 1D).
//
// ONE DECISION, NOTHING TO CALCULATE. The employee picks a number of credits;
// the rupees are shown from the rate the server sent, and the server derives
// everything again before it writes: the employee from the token, the period,
// the spendable balance, the rate, the rupees, the lock. Nothing here is
// trusted by the route — it is the offer the payload made, echoed back.
//
// Three states, each explicit:
//   * no application yet  → a stepper and Apply
//   * an application      → what is applied, with Change and Remove
//   * locked              → the application (if any) and a sentence saying
//                           why nothing can change. No button that would fail.

import { useRef, useState } from 'react'
import { Coins, Minus, Plus } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { formatRupees } from '@/lib/payroll/money'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { formatCreditValue } from '@/lib/boeCredits/settings'

export type PayrollCreditsPanelData = {
  spendable_credits: number
  provisional_credits: number
  credit_value: number
  can_apply: boolean
  locked: boolean
  application: {
    id: string
    credits_used: number
    credit_value: number
    amount: number
    created_at: string
  } | null
}

export function PayrollCreditsPanel({
  credits, busy, onApply, onRemove, guideHref,
}: {
  credits: PayrollCreditsPanelData
  busy: boolean
  /** Resolves to null on success, or the message to show. */
  onApply: (credits: number) => Promise<string | null>
  onRemove: () => Promise<string | null>
  guideHref: string
}) {
  const { application, locked } = credits
  // The credits the employee could put on this month: what they hold plus
  // what this month already holds (changing 5 → 3 frees 2 first).
  const ceiling = credits.spendable_credits + (application?.credits_used ?? 0)

  const [editing, setEditing] = useState(false)
  const [amount,  setAmount]  = useState<number>(application?.credits_used ?? Math.min(ceiling, 1))
  const [error,   setError]   = useState<string | null>(null)
  const [notice,  setNotice]  = useState<string | null>(null)
  const submitting = useRef(false)

  // A fresh application (after a save) resets the draft: the parent keys this
  // panel by the application id, so it remounts with what is actually applied.

  const clamp = (n: number) => Math.max(1, Math.min(ceiling, Math.trunc(Number.isFinite(n) ? n : 1)))
  const rupees = (n: number) => n * credits.credit_value

  const submit = async () => {
    if (submitting.current) return
    submitting.current = true
    setError(null)
    setNotice(null)
    try {
      const failure = await onApply(clamp(amount))
      if (failure) setError(failure)
      else { setEditing(false); setNotice(`${formatCredits(clamp(amount))} applied to this month.`) }
    } finally {
      submitting.current = false
    }
  }

  const remove = async () => {
    if (submitting.current) return
    submitting.current = true
    setError(null)
    setNotice(null)
    try {
      const failure = await onRemove()
      if (failure) setError(failure)
      else setNotice('Credits removed from this month. They are back in your balance.')
    } finally {
      submitting.current = false
    }
  }

  const heading = (
    <div style={{
      padding: '11px 16px 9px', borderBottom: `1px solid ${colors.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Coins size={15} strokeWidth={1.9} color="#3B63B8" aria-hidden="true" />
        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: '#4F6FD0' }}>
          BOE Credits
        </span>
      </div>
      <a href={guideHref} style={{ fontSize: 11.5, color: colors.muted, textDecoration: 'underline' }}>
        How credits work
      </a>
    </div>
  )

  const balanceLine = (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>
          Spendable
        </div>
        <div style={{ fontSize: 19, fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>
          {formatCredits(credits.spendable_credits)}
        </div>
      </div>
      <div style={{ fontSize: 12, color: colors.tertiary }}>
        1 credit = {formatCreditValue(credits.credit_value)}
        {credits.provisional_credits > 0 && (
          <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 2 }}>
            {formatCredits(credits.provisional_credits)} pending this month&rsquo;s review target
          </div>
        )}
      </div>
    </div>
  )

  return (
    <section
      aria-labelledby="payroll-credits-panel"
      style={{
        background: '#fff', borderRadius: 12, marginBottom: 16,
        border: '1px solid rgba(79,111,208,0.28)', overflow: 'hidden',
      }}
    >
      <h2 id="payroll-credits-panel" className="payroll-guide-sr-only">BOE Credits for this month</h2>
      {heading}

      <div style={{ padding: '13px 16px 15px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && (
          <div role="alert" style={{
            padding: '9px 12px', borderRadius: 8, fontSize: 12.5,
            background: 'rgba(239,68,68,0.08)', color: '#B91C1C', border: '1px solid rgba(239,68,68,0.2)',
          }}>
            {error}
          </div>
        )}
        {notice && !error && (
          <div role="status" style={{
            padding: '9px 12px', borderRadius: 8, fontSize: 12.5,
            background: 'rgba(5,150,105,0.09)', color: '#047857', border: '1px solid rgba(5,150,105,0.3)',
          }}>
            {notice}
          </div>
        )}

        {/* ── What is applied ─────────────────────────────────────────────── */}
        {application && (
          <div style={{
            padding: '10px 12px', borderRadius: 9,
            background: 'rgba(79,111,208,0.06)', border: '1px solid rgba(79,111,208,0.18)',
            display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontSize: 12.5, color: '#3D4455' }}>
                <strong style={{ color: colors.primary }}>{formatCredits(application.credits_used)}</strong> applied to this month
              </div>
              <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 2 }}>
                at {formatCreditValue(application.credit_value)} each — the rate when you applied them
              </div>
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#047857', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              +{formatRupees(application.amount)}
            </div>
          </div>
        )}

        {/* ── Locked: say so, draw nothing that would fail ───────────────── */}
        {locked ? (
          <div style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.55 }}>
            {application
              ? 'This month’s payroll is locked, so the credits applied to it are final.'
              : 'This month’s payroll is locked, so credits can no longer be added to it.'}
          </div>
        ) : !credits.can_apply ? (
          <div style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.55 }}>
            Credits can be applied once payroll for this month has been generated.
          </div>
        ) : (
          <>
            {balanceLine}

            {/* ── The stepper, shown for a new application or a change ─── */}
            {(!application || editing) && (
              ceiling <= 0 ? (
                <div style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.55 }}>
                  You have no spendable credits right now. Verified reviews earn them.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12.5, color: '#3D4455', minWidth: 96 }}>Credits to use</div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${colors.borderSoft}`, borderRadius: 9, overflow: 'hidden' }}>
                      <button
                        type="button"
                        aria-label="One credit fewer"
                        disabled={busy || amount <= 1}
                        onClick={() => setAmount(a => clamp(a - 1))}
                        style={stepBtn(busy || amount <= 1)}
                      >
                        <Minus size={14} strokeWidth={2.2} />
                      </button>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={ceiling}
                        step={1}
                        value={amount}
                        aria-label="Credits to use"
                        onChange={e => setAmount(clamp(Number(e.target.value)))}
                        style={{
                          width: 64, textAlign: 'center', border: 'none', fontSize: 16, fontWeight: 700,
                          color: colors.primary, background: '#fff', padding: '8px 4px', fontVariantNumeric: 'tabular-nums',
                          minHeight: 40, fontFamily: 'inherit',
                        }}
                      />
                      <button
                        type="button"
                        aria-label="One credit more"
                        disabled={busy || amount >= ceiling}
                        onClick={() => setAmount(a => clamp(a + 1))}
                        style={stepBtn(busy || amount >= ceiling)}
                      >
                        <Plus size={14} strokeWidth={2.2} />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAmount(ceiling)}
                      disabled={busy || amount === ceiling}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '6px 10px', fontSize: 12 }}
                    >
                      Use all {ceiling}
                    </button>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, color: '#3D4455' }}>Salary addition</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: '#047857', fontVariantNumeric: 'tabular-nums' }}>
                      +{formatRupees(rupees(clamp(amount)))}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => void submit()}
                      disabled={busy || (application != null && clamp(amount) === application.credits_used)}
                      className="boe-btn boe-btn-primary"
                      style={{ padding: '8px 16px', fontSize: 13, minHeight: 40 }}
                    >
                      {busy ? 'Saving…' : application ? `Change to ${formatCredits(clamp(amount))}` : `Apply ${formatCredits(clamp(amount))}`}
                    </button>
                    {application && (
                      <button
                        type="button"
                        onClick={() => { setEditing(false); setAmount(application.credits_used); setError(null) }}
                        disabled={busy}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '8px 14px', fontSize: 13, minHeight: 40 }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )
            )}

            {/* ── An application, not being edited: change or remove ────── */}
            {application && !editing && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => { setEditing(true); setError(null); setNotice(null) }}
                  disabled={busy}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '7px 14px', fontSize: 12.5, minHeight: 38 }}
                >
                  Change
                </button>
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '7px 14px', fontSize: 12.5, minHeight: 38, color: '#B91C1C' }}
                >
                  {busy ? 'Working…' : 'Remove'}
                </button>
              </div>
            )}

            <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
              The addition goes on top of your Salary Payable for this month — it does not need a deduction to work
              against. You can change or remove it until payroll is locked.
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function stepBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 40, minHeight: 40, border: 'none', background: disabled ? '#F4F5F7' : '#fff',
    color: disabled ? '#A9AFBD' : '#3B63B8', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  }
}
