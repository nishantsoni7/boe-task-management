'use client'

// ── Correct Allocation ────────────────────────────────────────────────────────
//
// The staff-facing door onto reverse_payment_allocation(), which has existed
// since 20260918000000 and until now had no screen. The ordinary correction is:
//
//   open the payment → Correct Allocation → choose the wrong allocation →
//   write the reason → confirm → (optionally) Allocate Funds for the released money
//
// A REVERSAL IS WHOLE. The chosen allocation ends and ALL of its amount returns
// to the payment's unallocated balance; the screen says so before anything is
// sent, and the confirmation names the exact amount and the balance afterwards.
// Moving part of it elsewhere is done by reversing it and allocating again —
// and Allocate Funds, the existing workflow, is offered for exactly that.
//
// NOTHING IS DELETED OR OVERWRITTEN. The reversed allocation stays on the
// payment, listed under "Reversed" with who reversed it, when and why, and the
// payment's activity trail records the same event.
//
// THE LEDGER IS COMPLETE OR ABSENT. Every figure here comes from
// payment_allocation_ledger_for_correction() (20261215000000), which returns
// the WHOLE ledger of this one payment to an authorized corrector. A direct
// read of finance_payment_allocations would be filtered row by row by RLS and
// could show a participant part of the ledger — and a wrong balance. If the
// complete read fails, no figure is drawn and no correction is offered.
//
// THE DATABASE DECIDES. This screen is drawn for finance.allocate_correct, and
// the RPC asks for that permission again, with its own reason check and its own
// locks. Success is shown only after the server has answered. The pure rules
// and the send path live in src/lib/finance/allocationCorrection.ts.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import {
  CORRECTION_REASON_MAX,
  CORRECT_ALLOCATION_MODAL_TITLE,
  REVERSE_ALLOCATION_BUTTON_LABEL,
  correctionBlockedReason,
  correctionPosition,
  ledgerTargetName,
  loadAllocationLedger,
  performAllocationReversal,
  unallocatedAfterReversal,
  type AllocationLedgerEntry,
} from '@/lib/finance/allocationCorrection'
import { ALLOCATE_FUNDS_ACTION_LABEL } from './AllocateFundsModal'

export type CorrectAllocationPayment = {
  id: string
  human_payment_id: string | null
  amount: number | string
}

/** Which of the three screens the modal is on. */
export type CorrectionStep = 'choose' | 'confirm' | 'done'

type Notice = { tone: 'error' | 'warning'; text: string }

export function CorrectAllocationModal({
  payment,
  supabase,
  canAllocate,
  onClose,
  onChanged,
  onAllocateFunds,
}: {
  payment: CorrectAllocationPayment
  supabase: ReturnType<typeof createClient>
  /** finance.allocate — whether Allocate Funds can be offered after the reversal. */
  canAllocate: boolean
  onClose: () => void
  /** The payment's allocations changed (or were found changed): refresh its row. */
  onChanged: () => void
  /** Leave this modal for Allocate Funds on the same payment. */
  onAllocateFunds: () => void
}) {
  const [entries, setEntries] = useState<AllocationLedgerEntry[] | null>(null)
  const [readable, setReadable] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<CorrectionStep>('choose')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [result, setResult] = useState<{ amount: string; target: string; balance: string | null } | null>(null)
  const sending = useRef(false)
  const loadToken = useRef(0)

  const reload = useCallback(async () => {
    const token = ++loadToken.current
    const ledger = await loadAllocationLedger(supabase, payment.id)
    if (token !== loadToken.current) return
    setEntries(ledger.entries)
    setReadable(ledger.readable)
    setReadError(ledger.readable ? null : ledger.message)
    // A selection that is no longer active is dropped rather than kept pointing
    // at an allocation that cannot be reversed.
    setSelectedId(prev => (prev && ledger.entries.some(e => e.allocationId === prev && e.status === 'active') ? prev : null))
  }, [supabase, payment.id])

  useEffect(() => {
    // Fetch on open: the rows this screen acts on are read now, not taken from
    // the list, so a list loaded an hour ago cannot supply a stale allocation.
    void reload()
  }, [reload])

  const selected = entries?.find(e => e.allocationId === selectedId) ?? null

  const submit = async () => {
    if (!selected || saving || sending.current) return
    sending.current = true
    setSaving(true)
    setNotice(null)
    const outcome = await performAllocationReversal(supabase, { paymentId: payment.id, allocation: selected, reason })
    setSaving(false)
    sending.current = false

    if (outcome.kind === 'reversed') {
      setResult({ amount: selected.amount, target: ledgerTargetName(selected), balance: outcome.unallocatedBalance })
      setStep('done')
      setReason('')
      setSelectedId(null)
      onChanged()
      void reload()
      return
    }

    // Every other outcome changed nothing BY THIS PERSON. The payment is read
    // again so what they see next is what is true now.
    setNotice({ tone: outcome.kind === 'refused' ? 'error' : 'warning', text: outcome.message })
    setStep('choose')
    if (outcome.kind !== 'refused') onChanged()
    void reload()
  }

  return (
    <FinanceModal
      title={CORRECT_ALLOCATION_MODAL_TITLE}
      onClose={onClose}
      width="640px"
      /* Holds a typed reason, so a stray backdrop click must not discard it. */
      closeOnBackdropClick={false}
    >
      <CorrectAllocationBody
        payment={payment}
        entries={entries}
        readable={readable}
        readError={readError}
        selectedId={selectedId}
        reason={reason}
        step={step}
        saving={saving}
        notice={notice}
        result={result}
        canAllocate={canAllocate}
        onSelect={id => { setSelectedId(id); setNotice(null) }}
        onReasonChange={text => { setReason(text); setNotice(null) }}
        onReview={() => { if (!correctionBlockedReason({ selected, reason })) setStep('confirm') }}
        onBack={() => setStep('choose')}
        onConfirm={submit}
        onAnother={() => { setStep('choose'); setResult(null) }}
        onAllocateFunds={onAllocateFunds}
        onClose={onClose}
      />
    </FinanceModal>
  )
}

// ── The body, as a function of its state ─────────────────────────────────────
//
// EXPORTED FOR ITS RENDER TEST. Every screen of the flow — the list, the
// confirmation, the result, a refusal — is drawn from props alone, so each can
// be asserted against real markup without a browser or a database.

export function CorrectAllocationBody(props: {
  payment: CorrectAllocationPayment
  entries: AllocationLedgerEntry[] | null
  readable: boolean
  /** Why the complete ledger could not be read. Shown instead of any figure. */
  readError?: string | null
  selectedId: string | null
  reason: string
  step: CorrectionStep
  saving: boolean
  notice: Notice | null
  result: { amount: string; target: string; balance: string | null } | null
  canAllocate: boolean
  onSelect: (allocationId: string) => void
  onReasonChange: (text: string) => void
  onReview: () => void
  onBack: () => void
  onConfirm: () => void
  onAnother: () => void
  onAllocateFunds: () => void
  onClose: () => void
}) {
  const { payment, entries, readable, selectedId, reason, step, saving, notice, result } = props

  if (entries === null) {
    return <p style={MUTED}>Loading this payment’s allocations…</p>
  }
  if (!readable) {
    return (
      <>
        <NoticeBox notice={{ tone: 'error', text: props.readError ?? 'The full allocation list for this payment could not be loaded, so no figures are shown and nothing can be corrected. Nothing was changed — close this and try again.' }} />
        <Footer><button type="button" onClick={props.onClose} className="boe-btn boe-btn-ghost" style={BTN}>Close</button></Footer>
      </>
    )
  }

  const active = entries.filter(e => e.status === 'active')
  const reversed = entries.filter(e => e.status === 'reversed')
  const position = correctionPosition(payment.amount, entries)
  const selected = active.find(e => e.allocationId === selectedId) ?? null
  const blocked = correctionBlockedReason({ selected, reason })

  // ── The result — shown only after the server confirmed it ──
  if (step === 'done' && result) {
    return (
      <>
        <PaymentFigures payment={payment} allocated={position.allocated} unallocated={position.unallocated} />
        <div role="status" style={{
          border: `1px solid ${colors.border}`, background: colors.greenTint, borderRadius: '8px',
          padding: '12px 14px', fontSize: '13px', color: colors.primary, lineHeight: 1.55,
        }}>
          <strong>Allocation reversed.</strong>{' '}
          {formatMoney(result.amount)} is no longer allocated to {result.target} and has returned to this
          payment’s unallocated balance
          {result.balance !== null && <>, which is now <strong>{formatMoney(result.balance)}</strong></>}.
          The reversed allocation stays in the history below.
        </div>
        {!props.canAllocate && (
          <p style={MUTED}>
            To allocate the released money elsewhere, ask someone with the Finance permission to
            allocate payments to use Allocate Funds on this payment.
          </p>
        )}
        <ReversedHistory entries={reversed} />
        <Footer>
          <button type="button" onClick={props.onClose} className="boe-btn boe-btn-ghost" style={BTN}>Done</button>
          {active.length > 0 && (
            <button type="button" onClick={props.onAnother} className="boe-btn boe-btn-ghost" style={BTN}>
              Correct another allocation
            </button>
          )}
          {props.canAllocate && (
            <button type="button" onClick={props.onAllocateFunds} className="boe-btn boe-btn-primary" style={BTN}>
              {ALLOCATE_FUNDS_ACTION_LABEL}
            </button>
          )}
        </Footer>
      </>
    )
  }

  // ── The confirmation ──
  if (step === 'confirm' && selected) {
    const after = unallocatedAfterReversal(payment.amount, entries, selected.allocationId)
    return (
      <>
        <PaymentFigures payment={payment} allocated={position.allocated} unallocated={position.unallocated} />
        <div style={{
          border: '1px solid #FDE68A', background: '#FFFBEB', borderRadius: '8px',
          padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#92400E' }}>Confirm the reversal</div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(110px, auto) 1fr', gap: '4px 12px', fontSize: '13px' }}>
            <dt style={DT}>Allocation</dt>
            <dd style={DD}>{ledgerTargetName(selected)}{selected.clientName ? ` · ${selected.clientName}` : ''}</dd>
            <dt style={DT}>Amount released</dt>
            <dd style={{ ...DD, fontWeight: 700 }}>{formatMoney(selected.amount)} — the whole allocation</dd>
            <dt style={DT}>Unallocated after</dt>
            <dd style={{ ...DD, fontWeight: 700 }}>{formatMoney(after)}</dd>
            <dt style={DT}>Reason</dt>
            <dd style={{ ...DD, whiteSpace: 'pre-wrap' }}>{reason.trim()}</dd>
          </dl>
          <p style={{ margin: 0, fontSize: '12px', color: '#92400E', lineHeight: 1.5 }}>
            The payment itself does not change. {ledgerTargetName(selected)} will no longer count this
            money. The allocation is kept as reversed history with your name, the time and this reason,
            and cannot be made active again — to assign the money, use Allocate Funds afterwards.
          </p>
        </div>
        {notice && <NoticeBox notice={notice} />}
        <Footer>
          <button type="button" onClick={props.onBack} disabled={saving} className="boe-btn boe-btn-ghost" style={BTN}>Back</button>
          <button
            type="button" onClick={props.onConfirm} disabled={saving}
            className="boe-btn boe-btn-primary"
            style={{ ...BTN, background: colors.red, borderColor: colors.red, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Reversing…' : REVERSE_ALLOCATION_BUTTON_LABEL}
          </button>
        </Footer>
      </>
    )
  }

  // ── Choosing ──
  return (
    <>
      <PaymentFigures payment={payment} allocated={position.allocated} unallocated={position.unallocated} />

      <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55 }}>
        Choose the allocation that is wrong. Reversing it returns its <strong>whole amount</strong> to
        this payment’s unallocated balance — part of an allocation cannot be moved on its own. You can
        then use Allocate Funds to divide or reassign the released money.
      </p>

      {notice && <NoticeBox notice={notice} />}

      {active.length === 0 ? (
        <p style={MUTED}>This payment has no active allocations, so there is nothing to correct.</p>
      ) : (
        <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <legend style={{ ...LABEL, marginBottom: '6px' }}>Active allocations</legend>
          {active.map(entry => {
            const checked = entry.allocationId === selectedId
            const inputId = `correct-alloc-${entry.allocationId}`
            return (
              <label
                key={entry.allocationId}
                htmlFor={inputId}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer',
                  border: `1px solid ${checked ? colors.blue : colors.border}`,
                  background: checked ? colors.blueTint : 'transparent',
                  borderRadius: '8px', padding: '10px 12px',
                }}
              >
                <input
                  id={inputId}
                  type="radio"
                  name="correct-allocation"
                  value={entry.allocationId}
                  checked={checked}
                  disabled={saving}
                  onChange={() => props.onSelect(entry.allocationId)}
                  style={{ marginTop: '3px', flexShrink: 0 }}
                />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 600, color: colors.primary, wordBreak: 'break-word' }}>
                      {ledgerTargetName(entry)}
                    </span>
                    <span style={{ display: 'block', fontSize: '12px', color: colors.secondary, wordBreak: 'break-word' }}>
                      {entry.clientName ?? 'Customer not visible to you'}
                    </span>
                  </span>
                  <span style={{ fontSize: '13.5px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {formatMoney(entry.amount)}
                  </span>
                </span>
              </label>
            )
          })}
        </fieldset>
      )}

      {active.length > 0 && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <span style={LABEL}>Reason for the correction <span style={{ color: colors.red }}>*</span></span>
          <textarea
            className="boe-input"
            value={reason}
            maxLength={CORRECTION_REASON_MAX}
            rows={3}
            disabled={saving}
            onChange={e => props.onReasonChange(e.target.value)}
            placeholder="e.g. Customer asked for this advance to be adjusted against Order 529"
            style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
          />
          <span style={{ fontSize: '11px', color: colors.muted }}>Kept permanently with the payment’s history.</span>
        </label>
      )}

      {active.length > 0 && blocked && <p style={MUTED}>{blocked}</p>}

      <ReversedHistory entries={reversed} />

      <Footer>
        <button type="button" onClick={props.onClose} className="boe-btn boe-btn-ghost" style={BTN}>Cancel</button>
        {active.length > 0 && (
          <button
            type="button" onClick={props.onReview} disabled={blocked !== null}
            className="boe-btn boe-btn-primary"
            style={{ ...BTN, opacity: blocked !== null ? 0.6 : 1, cursor: blocked !== null ? 'not-allowed' : 'pointer' }}
          >
            Review reversal
          </button>
        )}
      </Footer>
    </>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────────────

function PaymentFigures({ payment, allocated, unallocated }: {
  payment: CorrectAllocationPayment
  allocated: string
  unallocated: string
}) {
  return (
    <div style={{
      background: colors.raised, border: `1px solid ${colors.border}`, borderRadius: '8px',
      padding: '12px 14px', display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px',
    }}>
      <Figure label="Payment ID" value={payment.human_payment_id ?? '—'} />
      <Figure label="Payment amount" value={formatMoney(payment.amount)} />
      <Figure label="Allocated" value={formatMoney(allocated)} />
      <Figure label="Unallocated" value={formatMoney(unallocated)} strong />
    </div>
  )
}

function ReversedHistory({ entries }: { entries: AllocationLedgerEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={LABEL}>Reversed allocations</span>
      {entries.map(e => (
        <div key={e.allocationId} style={{
          border: `1px dashed ${colors.border}`, borderRadius: '8px', padding: '8px 12px',
          fontSize: '12.5px', color: colors.secondary, lineHeight: 1.5,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px' }}>
            <span style={{ wordBreak: 'break-word' }}>
              <span style={{ textDecoration: 'line-through' }}>{ledgerTargetName(e)}</span>
              {e.clientName ? ` · ${e.clientName}` : ''}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatMoney(e.amount)}</span>
          </div>
          <div style={{ fontSize: '11.5px', color: colors.muted }}>
            Reversed{e.reversedByName ? ` by ${e.reversedByName}` : ''}{e.reversedAt ? ` on ${fmtDateTime(e.reversedAt)}` : ''}
          </div>
          {e.reversalReason && (
            <div style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              Reason: {e.reversalReason}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function NoticeBox({ notice }: { notice: Notice }) {
  const error = notice.tone === 'error'
  return (
    <div role="alert" style={{
      fontSize: '12.5px', lineHeight: 1.5, borderRadius: '6px', padding: '8px 12px',
      color: error ? colors.red : '#92400E',
      background: error ? colors.redTint : '#FFFBEB',
      border: `1px solid ${error ? colors.border : '#FDE68A'}`,
    }}>
      {notice.text}
    </div>
  )
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap', paddingTop: '4px' }}>
      {children}
    </div>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={LABEL}>{label}</div>
      <div style={{
        fontSize: strong ? '15px' : '13px', fontWeight: strong ? 700 : 600, color: colors.primary,
        fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word',
      }}>
        {value}
      </div>
    </div>
  )
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`
}

const LABEL: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}
const MUTED: React.CSSProperties = { margin: 0, fontSize: '12px', color: colors.muted, lineHeight: 1.5 }
const BTN: React.CSSProperties = { padding: '8px 16px', fontSize: '13px' }
const DT: React.CSSProperties = { color: colors.secondary, margin: 0 }
const DD: React.CSSProperties = { color: colors.primary, margin: 0, wordBreak: 'break-word' }
