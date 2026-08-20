'use client'

// ── The PI payment card ───────────────────────────────────────────────────────
//
// ONE card on the existing PI detail page. It shows what has been received
// against this PI, what is still waiting on Finance, and what is still needed —
// and offers Add Payment to the people permitted to record one.
//
// It deliberately does NOT redesign anything: it reuses PiCard/PiCardHeader, the
// existing colour tokens and the existing Finance modal shell, and it sits in the
// same lower grid as the Commercial Summary and Activity cards it is styled to
// match. No banner, no dashboard, no chart.
//
// Every figure it prints is computed in the database (pi_submission_payment_summary)
// in numeric. This file formats; it never calculates money.

import { useCallback, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { PiCard, PiCardHeader } from '@/components/orders/piPreview'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import {
  EMPTY_PI_PAYMENT_FORM,
  PI_PAYMENT_MODES,
  PI_PAYMENT_PROOF_FAILED,
  PI_PAYMENT_RECORDED_BODY,
  PI_PAYMENT_RECORDED_TITLE,
  canSubmitPiPayment,
  formatMoney,
  isAwaitingVerification,
  paymentModeLabel,
  piPaymentErrorMessage,
  piPaymentStatusLabel,
  piPaymentStatusTone,
  piPaymentTermLines,
  piPaymentTiles,
  validatePiPaymentForm,
  type PiPaymentFormState,
  type PiPaymentSummary,
  type PiPaymentSummaryRow,
  type PiPaymentTone,
} from '@/lib/finance/piPaymentView'
import {
  PAYMENT_POSITION_HINT,
  PAYMENT_POSITION_LABEL,
  PAYMENT_POSITION_TONE,
  asPaymentPosition,
  type PaymentPositionTone,
} from '@/lib/orders/paymentGate'

const TONE_COLOR: Record<PiPaymentTone, { fg: string; bg: string; border: string }> = {
  amber:   { fg: colors.amber, bg: colors.amberTint, border: 'rgba(232,160,48,0.25)' },
  blue:    { fg: colors.blue,  bg: colors.blueTint,  border: 'rgba(85,133,232,0.25)' },
  red:     { fg: colors.red,   bg: colors.redTint,   border: 'rgba(217,79,79,0.25)' },
  green:   { fg: colors.green, bg: colors.greenTint, border: 'rgba(69,168,112,0.25)' },
  neutral: { fg: colors.tertiary, bg: colors.raised, border: colors.border },
}

function StatusChip({ status }: { status: string }) {
  const tone = TONE_COLOR[piPaymentStatusTone(status)]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: '5px', whiteSpace: 'nowrap',
      fontSize: '11px', fontWeight: 600,
      color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`,
    }}>
      {piPaymentStatusLabel(status)}
    </span>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <div style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: '10px', color: colors.muted }}>{hint}</div>}
    </div>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── One row of the payment list ───────────────────────────────────────────────

function PaymentRow({ row, isMobile, onOpenProof }: {
  row: PiPaymentSummaryRow
  isMobile: boolean
  onOpenProof: (paymentId: string) => void
}) {
  const reversed = row.allocation_status === 'reversed'
  // A reversed allocation is history: shown, but visibly not counting.
  const dim = reversed ? 0.55 : 1

  const remark = row.admin_note ?? null

  return (
    <div style={{
      padding: isMobile ? '12px 16px' : '12px 20px',
      borderTop: `1px solid ${colors.border}`,
      display: 'flex', flexDirection: 'column', gap: '6px',
      opacity: dim,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '10px', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <span style={{
            fontSize: '14px', fontWeight: 700, color: colors.primary,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {formatMoney(row.allocated_amount)}
          </span>
          <StatusChip status={row.status} />
          {reversed && (
            <span style={{ fontSize: '11px', color: colors.muted }}>allocation reversed</span>
          )}
        </div>
        <div style={{ fontSize: '11px', color: colors.muted, fontFamily: 'var(--font-mono)' }}>
          {row.request_number ?? '—'}
        </div>
      </div>

      <div style={{
        display: 'flex', gap: '14px', flexWrap: 'wrap',
        fontSize: '12px', color: colors.secondary,
      }}>
        <span>{formatDate(row.payment_date)}</span>
        <span>{paymentModeLabel(row.payment_mode)}</span>
        {row.reference && <span style={{ color: colors.tertiary }}>Ref {row.reference}</span>}
        <span style={{ color: colors.muted }}>by {row.entered_by ?? '—'}</span>
        {row.proof_count > 0 && row.can_view_proof && (
          <button
            type="button"
            onClick={() => onOpenProof(row.payment_id)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontSize: '12px', color: colors.blue, textDecoration: 'underline',
            }}
          >
            Proof
          </button>
        )}
      </div>

      {remark && (
        <div style={{
          fontSize: '12px', color: row.status === 'rejected' ? colors.red : colors.secondary,
          background: row.status === 'rejected' ? colors.redTint : colors.raised,
          border: `1px solid ${row.status === 'rejected' ? 'rgba(217,79,79,0.2)' : colors.border}`,
          borderRadius: '6px', padding: '6px 10px',
        }}>
          {row.status === 'rejected' ? 'Rejected: ' : 'Finance note: '}{remark}
        </div>
      )}
    </div>
  )
}

// ── Add Payment ───────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.secondary, marginBottom: '4px',
}
const INPUT: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: '13px',
  border: `1px solid ${colors.borderSoft}`, borderRadius: '6px',
  background: colors.base, color: colors.primary, boxSizing: 'border-box',
}
const ERR: React.CSSProperties = { fontSize: '11px', color: colors.red, marginTop: '3px' }

export function AddPiPaymentModal({ todayIso, saving, onClose, onSubmit }: {
  todayIso: string
  saving: boolean
  onClose: () => void
  onSubmit: (form: PiPaymentFormState, proof: File | null) => Promise<string | null>
}) {
  const [form, setForm] = useState<PiPaymentFormState>({ ...EMPTY_PI_PAYMENT_FORM, paymentDate: todayIso })
  const [proof, setProof] = useState<File | null>(null)
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Belt and braces alongside `saving`: a second click that lands in the same
  // tick, before the parent's saving state has propagated, is still refused.
  const submittedRef = useRef(false)
  const [submitted, setSubmitted] = useState(false)

  const errors = validatePiPaymentForm(form, todayIso)
  const allowed = canSubmitPiPayment({ form, todayIso, saving, submitted })

  const set = (k: keyof PiPaymentFormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (submittedRef.current || !allowed) { setTouched(true); return }
    submittedRef.current = true
    setSubmitted(true)
    setError(null)
    const err = await onSubmit(form, proof)
    if (err) {
      // A failure returns the form to the user with what they typed intact.
      submittedRef.current = false
      setSubmitted(false)
      setError(err)
    }
  }

  return (
    <FinanceModal title="Add payment" onClose={onClose} width="440px" closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <div style={LABEL}>Amount received <span style={{ color: colors.red }}>*</span></div>
          <input
            style={INPUT} inputMode="decimal" autoFocus placeholder="0.00"
            value={form.amount} onChange={e => set('amount')(e.target.value)}
          />
          {touched && errors.amount && <div style={ERR}>{errors.amount}</div>}
        </div>

        <div>
          <div style={LABEL}>Payment date <span style={{ color: colors.red }}>*</span></div>
          <input
            style={INPUT} type="date" max={todayIso}
            value={form.paymentDate} onChange={e => set('paymentDate')(e.target.value)}
          />
          {touched && errors.paymentDate && <div style={ERR}>{errors.paymentDate}</div>}
        </div>

        <div>
          <div style={LABEL}>Payment mode <span style={{ color: colors.red }}>*</span></div>
          <select style={INPUT} value={form.paymentMode} onChange={e => set('paymentMode')(e.target.value)}>
            <option value="">Select…</option>
            {PI_PAYMENT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          {touched && errors.paymentMode && <div style={ERR}>{errors.paymentMode}</div>}
        </div>

        <div>
          <div style={LABEL}>Reference / UTR <span style={{ color: colors.muted }}>(optional)</span></div>
          <input style={INPUT} value={form.reference} onChange={e => set('reference')(e.target.value)} />
        </div>

        <div>
          <div style={LABEL}>Remarks <span style={{ color: colors.muted }}>(optional)</span></div>
          <input style={INPUT} value={form.remarks} onChange={e => set('remarks')(e.target.value)} />
        </div>

        <div>
          <div style={LABEL}>Payment proof <span style={{ color: colors.muted }}>(optional)</span></div>
          <input
            style={{ ...INPUT, padding: '6px 8px' }} type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            onChange={e => setProof(e.target.files?.[0] ?? null)}
          />
        </div>

        {error && (
          <div style={{
            fontSize: '12px', color: colors.red, background: colors.redTint,
            border: '1px solid rgba(217,79,79,0.2)', borderRadius: '6px', padding: '8px 10px',
          }}>
            {error}
          </div>
        )}

        <div style={{
          fontSize: '11px', color: colors.muted, background: colors.raised,
          border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '8px 10px',
        }}>
          This records that a payment was received. Finance verifies it separately —
          nothing counts as confirmed until they do.
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '2px' }}>
          <button
            type="button" onClick={onClose} disabled={saving || submitted}
            style={{
              padding: '8px 14px', fontSize: '12px', fontWeight: 600, borderRadius: '6px',
              border: `1px solid ${colors.borderSoft}`, background: colors.base,
              color: colors.secondary, cursor: saving || submitted ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={submit} disabled={!allowed}
            style={{
              padding: '8px 14px', fontSize: '12px', fontWeight: 600, borderRadius: '6px',
              border: 'none', background: allowed ? colors.primary : colors.hover,
              color: allowed ? '#fff' : colors.muted,
              cursor: allowed ? 'pointer' : 'not-allowed',
            }}
          >
            {saving || submitted ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}

// ── The approval position ─────────────────────────────────────────────────────

const POSITION_COLOR: Record<PaymentPositionTone, { fg: string; bg: string; border: string }> = {
  green: { fg: '#166534', bg: colors.greenTint, border: 'rgba(69,168,112,0.28)' },
  amber: { fg: '#9A6212', bg: colors.amberTint, border: 'rgba(232,160,48,0.28)' },
  red:   { fg: '#991B1B', bg: colors.redTint,   border: 'rgba(217,79,79,0.28)' },
  blue:  { fg: '#1E3A8A', bg: colors.blueTint,  border: 'rgba(85,133,232,0.28)' },
}

function PositionBand({ position }: { position: keyof typeof PAYMENT_POSITION_LABEL }) {
  const tone = POSITION_COLOR[PAYMENT_POSITION_TONE[position]]
  return (
    <div style={{
      margin: '0 20px 14px', padding: '9px 11px', borderRadius: '7px',
      background: tone.bg, border: `1px solid ${tone.border}`, color: tone.fg,
      fontSize: '12px', lineHeight: 1.45,
    }}>
      <strong>{PAYMENT_POSITION_LABEL[position]}</strong>
      <span style={{ display: 'block', marginTop: '2px' }}>{PAYMENT_POSITION_HINT[position]}</span>
    </div>
  )
}

// ── The card ──────────────────────────────────────────────────────────────────

export function PiPaymentCard({
  summary, loading, canAdd, isMobile, todayIso, saving, notice,
  onAdd, onOpenProof, onDismissNotice,
}: {
  summary: PiPaymentSummary | null
  loading: boolean
  canAdd: boolean
  isMobile: boolean
  todayIso: string
  saving: boolean
  notice: string | null
  onAdd: (form: PiPaymentFormState, proof: File | null) => Promise<string | null>
  onOpenProof: (paymentId: string) => void
  onDismissNotice: () => void
}) {
  const [open, setOpen] = useState(false)
  const tiles = piPaymentTiles(summary)
  const terms = piPaymentTermLines(summary)
  const position = asPaymentPosition(summary?.approval_position)
  const rows = summary?.payments ?? []
  const waiting = rows.filter(r => r.allocation_status === 'active' && isAwaitingVerification(r.status)).length

  const handleAdd = useCallback(async (form: PiPaymentFormState, proof: File | null) => {
    const err = await onAdd(form, proof)
    if (!err) setOpen(false)
    return err
  }, [onAdd])

  return (
    <PiCard>
      <PiCardHeader
        title="Payments"
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {waiting > 0 && (
              <span style={{ fontSize: '11px', color: colors.amber, whiteSpace: 'nowrap' }}>
                {waiting} awaiting verification
              </span>
            )}
            {canAdd && (
              <button
                type="button" onClick={() => setOpen(true)}
                style={{
                  padding: '5px 11px', fontSize: '11px', fontWeight: 600, borderRadius: '6px',
                  border: `1px solid ${colors.borderSoft}`, background: colors.base,
                  color: colors.primary, cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                Add payment
              </button>
            )}
          </div>
        }
      />

      {notice && (
        <div style={{
          margin: '12px 20px 0', padding: '8px 10px', borderRadius: '6px',
          background: colors.greenTint, border: '1px solid rgba(69,168,112,0.2)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px',
        }}>
          <div style={{ fontSize: '12px', color: colors.secondary }}>
            <strong style={{ color: colors.primary }}>{PI_PAYMENT_RECORDED_TITLE}.</strong>{' '}
            {notice}
          </div>
          <button
            type="button" onClick={onDismissNotice}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '14px', lineHeight: 1 }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div style={{
        padding: isMobile ? '14px 16px' : '14px 20px',
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, minmax(0, 1fr))',
        gap: isMobile ? '12px' : '14px',
      }}>
        {loading && tiles.length === 0
          ? <div style={{ fontSize: '12px', color: colors.muted }}>Loading…</div>
          : tiles.map(t => <Tile key={t.key} label={t.label} value={t.value} hint={t.hint} />)}
      </div>

      {/* WHERE THIS PI STANDS ON APPROVAL, in the card that already holds every
          figure the answer is made of. A second card would put the question and
          its answer in two places on one screen.

          The position is the DATABASE'S, resolved in the same order
          approve_order_submission() resolves it — money first, then the decision
          that stands in for money, then what is missing. Nothing here re-derives
          it. */}
      {position && <PositionBand position={position} />}

      {/* The agreed commercial terms, when there are any. Plain text, printed as
          typed: this is not a schedule and nothing here parses it. */}
      {terms.length > 0 && (
        <div style={{
          padding: isMobile ? '0 16px 14px' : '0 20px 14px',
          display: 'flex', flexDirection: 'column', gap: '6px',
        }}>
          {terms.map(t => (
            <div key={t.key} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <div style={{ fontSize: '11px', color: colors.muted }}>{t.label}</div>
              <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.45 }}>{t.value}</div>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{
          padding: '16px 20px', fontSize: '12px', color: colors.secondary,
          borderTop: `1px solid ${colors.border}`,
        }}>
          {loading ? 'Loading payments…' : 'No payment has been recorded against this PI yet.'}
        </div>
      ) : (
        <div>
          {rows.map(r => (
            <PaymentRow key={r.allocation_id} row={r} isMobile={isMobile} onOpenProof={onOpenProof} />
          ))}
        </div>
      )}

      {open && (
        <AddPiPaymentModal
          todayIso={todayIso}
          saving={saving}
          onClose={() => setOpen(false)}
          onSubmit={handleAdd}
        />
      )}
    </PiCard>
  )
}

export { PI_PAYMENT_RECORDED_BODY, PI_PAYMENT_PROOF_FAILED, piPaymentErrorMessage }
