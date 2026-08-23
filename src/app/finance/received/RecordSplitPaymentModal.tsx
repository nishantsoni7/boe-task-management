'use client'

// ── Recording one payment, and dividing it as it goes in ─────────────────────
//
// WHAT WAS MISSING. A real payment arrives once and pays for several things. The
// allocation model has expressed that since 20260918000000 — many allocations,
// one payment, each naming a PI Draft or a Confirmed Order — but nothing could
// CREATE such a payment in one act. The money went in attached to one
// destination, and the rest was allocated afterwards, through a separate
// control. Between the two the payment was misclassified, and a failure in
// between left money attached to less than it paid for.
//
// This is the one flow: the payment-level facts once, then as many destinations
// as the payment actually covers, saved by record_payment_with_allocations() in
// a single transaction — every row or none.
//
// A REMAINDER IS ORDINARY AND IS NOT AN ERROR. Recording ₹5,00,000 and
// allocating ₹2,00,000 of it is a correct entry; the rest is an unallocated
// balance the existing Allocate control spends later. So is an empty list —
// that is the plain unallocated payment Finance has always been able to record.
//
// EVERY GATE IS THE DATABASE'S. record_payment_with_allocations() re-derives the
// actor, requires Finance module entry AND finance.allocate, writes the payment
// as pending_approval — Awaiting Verification — and writes each allocation
// through allocate_payment_to_target_internal(), which locks the payment,
// re-computes the balance under that lock, re-validates that each target exists,
// is eligible and is visible to the caller, and refuses a second active claim on
// the same target. Nothing here authorizes anything: the running totals and the
// refusals exist so the person is told before a round trip, and the control is
// drawn only for a holder of finance.allocate because offering one that will
// certainly be refused is worse than not offering it.
//
// AND NOT AN ORDER REQUEST. That workflow is retired (20261007000000): the RPC
// has no parameter for one, the allocation table has no such column, and the
// picker offers only the two kinds of target the business has.
//
// VERIFICATION IS NOT BYPASSED. This records that money was reported. Whether it
// arrived is still Finance's decision, taken afterwards through the existing
// verify / correct-and-verify / reject authority, which this touches in no way.

import { useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { sanitizeAmountInput } from '@/lib/currency'
import {
  EMPTY_ALLOCATION_ROW,
  duplicateTargetKeys,
  splitPaymentBlockedReason,
  splitPaymentErrorMessage,
  splitPaymentTotals,
  targetKey,
  toRpcAllocations,
  type SplitAllocationRow,
} from '@/lib/finance/splitPaymentEntry'
import {
  KindBadge,
  loadTargetPosition,
  searchAllocationTargets,
  statusLabel,
  type AllocationCandidate,
  type TargetPosition,
} from './AllocatePaymentModal'

export const RECORD_PAYMENT_MODAL_TITLE = 'Record Payment'

/** The label on the control that opens this. Named once so tests read the product's word. */
export const RECORD_PAYMENT_ACTION_LABEL = 'Record Payment'

/** The existing closed domain, in the product's words. Neither is new. */
const PAYMENT_MODES: [string, string][] = [
  ['bank_transfer', 'Bank Transfer'],
  ['cash',          'Cash'],
  ['upi',           'UPI'],
  ['cheque',        'Cheque'],
  ['other',         'Other'],
]

const RECEIVED_IN: [string, string][] = [
  ['',                'Not stated'],
  ['company_account', 'Company Account'],
  ['cash_in_hand',    'Cash in Hand'],
  ['savings_account', 'Savings Account'],
  ['other',           'Other'],
]

let rowSeq = 0
const nextRowKey = () => `alloc-${++rowSeq}`

export function RecordSplitPaymentModal({
  supabase,
  onClose,
  onRecorded,
}: {
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onRecorded: (summary: { requestNumber: string; allocationCount: number }) => void
}) {
  // ── The payment, entered once ──
  const [clientName,  setClientName]  = useState('')
  const [amount,      setAmount]      = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [paymentMode, setPaymentMode] = useState('bank_transfer')
  const [receivedIn,  setReceivedIn]  = useState('')
  const [reference,   setReference]   = useState('')
  const [remarks,     setRemarks]     = useState('')

  // ── The destinations ──
  const [rows, setRows] = useState<SplitAllocationRow[]>([EMPTY_ALLOCATION_ROW(nextRowKey())])
  const [pickerFor, setPickerFor] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  const totals     = splitPaymentTotals({ amount, rows })
  const duplicates = duplicateTargetKeys(rows)
  const blocked    = splitPaymentBlockedReason({
    amount, paymentDate, paymentMode, clientName, rows,
  })

  const patchRow = (key: string, patch: Partial<SplitAllocationRow>) => {
    setError(null)
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const removeRow = (key: string) => {
    setError(null)
    setRows(prev => {
      const next = prev.filter(r => r.key !== key)
      // Never zero rows: an empty list is a legitimate SAVE, but a form with no
      // row at all offers nowhere to start and reads as a bug.
      return next.length > 0 ? next : [EMPTY_ALLOCATION_ROW(nextRowKey())]
    })
  }

  const handleSave = async () => {
    if (blocked || saving) return
    setSaving(true)
    setError(null)

    const { data, error: rpcError } = await supabase.rpc('record_payment_with_allocations', {
      p_amount:       Number(amount),
      p_payment_date: paymentDate,
      p_payment_mode: paymentMode,
      p_client_name:  clientName.trim(),
      p_received_in:  receivedIn || null,
      p_reference:    reference.trim() || null,
      p_remarks:      remarks.trim() || null,
      p_allocations:  toRpcAllocations(rows),
    })

    setSaving(false)

    // A FAILURE HERE IS A COMPLETE FAILURE, and is reported as one. The RPC is a
    // single transaction: there is no partial state to describe and nothing for
    // this screen to compensate for.
    if (rpcError || !data) { setError(splitPaymentErrorMessage(rpcError?.message)); return }

    const result = data as { request_number?: string; allocation_count?: number }
    onRecorded({
      requestNumber:   result.request_number ?? '',
      allocationCount: result.allocation_count ?? 0,
    })
  }

  return (
    <FinanceModal
      title={RECORD_PAYMENT_MODAL_TITLE}
      onClose={onClose}
      width="700px"
      /* Holds unsaved input, so a backdrop click must never discard it —
         the project's Form Modal Dismissal Rule. Escape and ✕ still close. */
      closeOnBackdropClick={false}
    >
      <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
        One payment, divided across every Order and PI Draft it actually paid for.
        Anything not allocated stays as an available balance on the payment.
        Finance still verifies it before it counts as received.
      </div>

      {/* ── The payment itself ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <Field label="Client" htmlFor="rsp-client">
          <input
            id="rsp-client" className="boe-input" value={clientName} autoFocus
            onChange={e => { setClientName(e.target.value); setError(null) }}
            placeholder="Who the money came from"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Amount received" htmlFor="rsp-amount">
          <input
            id="rsp-amount" className="boe-input" inputMode="decimal" value={amount}
            onChange={e => { setAmount(sanitizeAmountInput(e.target.value)); setError(null) }}
            placeholder="0.00"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Payment date" htmlFor="rsp-date">
          <input
            id="rsp-date" className="boe-input" type="date" value={paymentDate}
            onChange={e => { setPaymentDate(e.target.value); setError(null) }}
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Payment mode" htmlFor="rsp-mode">
          <select
            id="rsp-mode" className="boe-input" value={paymentMode}
            onChange={e => { setPaymentMode(e.target.value); setError(null) }}
            style={{ width: '100%' }}
          >
            {PAYMENT_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Received in" htmlFor="rsp-received-in">
          <select
            id="rsp-received-in" className="boe-input" value={receivedIn}
            onChange={e => { setReceivedIn(e.target.value); setError(null) }}
            style={{ width: '100%' }}
          >
            {RECEIVED_IN.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Reference" htmlFor="rsp-reference">
          <input
            id="rsp-reference" className="boe-input" value={reference}
            onChange={e => { setReference(e.target.value); setError(null) }}
            placeholder="UTR, cheque number…"
            style={{ width: '100%' }}
          />
        </Field>
      </div>

      <Field label="Remark" htmlFor="rsp-remarks">
        <textarea
          id="rsp-remarks" className="boe-input" value={remarks} rows={2}
          onChange={e => { setRemarks(e.target.value); setError(null) }}
          placeholder="Anything Finance should know when verifying this"
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>

      {/* ── The three figures, always on screen ──
          Total received, total allocated, and what is left. Shown continuously
          rather than on save, because the whole point of the form is the
          arithmetic and somebody typing four rows must see it as they go. */}
      <div style={{
        background: colors.raised, border: `1px solid ${colors.border}`, borderRadius: '8px',
        padding: '12px 14px', display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px',
      }}>
        <Figure label="Payment" value={totals.payment === null ? '—' : formatMoney(totals.payment)} />
        <Figure label="Allocated" value={formatMoney(totals.allocated)} />
        <Figure
          label={totals.overAllocated ? 'Over by' : 'Left to allocate'}
          value={
            totals.remaining === null ? '—'
              : formatMoney(totals.overAllocated ? totals.remaining.replace('-', '') : totals.remaining)
          }
          strong
          tone={totals.overAllocated ? colors.red : undefined}
        />
      </div>

      {/* ── The destinations ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <span style={LABEL}>Allocations</span>
        <button
          type="button"
          onClick={() => setRows(prev => [...prev, EMPTY_ALLOCATION_ROW(nextRowKey())])}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '4px 10px', fontSize: '12px' }}
        >
          + Add allocation
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {rows.map((row, index) => (
          <AllocationRow
            key={row.key}
            row={row}
            index={index}
            supabase={supabase}
            duplicate={Boolean(targetKey(row) && duplicates.has(targetKey(row) as string))}
            picking={pickerFor === row.key}
            onPick={() => setPickerFor(row.key)}
            onClosePicker={() => setPickerFor(null)}
            onChange={patch => patchRow(row.key, patch)}
            onRemove={() => removeRow(row.key)}
          />
        ))}
      </div>

      {/* The reason the control is disabled, always stated. A greyed-out button
          with no explanation is what has somebody clicking it repeatedly. */}
      {blocked && !error && (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{blocked}</div>
      )}

      {error && (
        <div style={{
          fontSize: '12px', color: colors.red, background: colors.redTint,
          border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '8px 12px', lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={blocked !== null || saving}
          className="boe-btn boe-btn-primary"
          style={{
            padding: '8px 18px', fontSize: '13px',
            opacity: (blocked !== null || saving) ? 0.6 : 1,
            cursor: (blocked !== null || saving) ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Recording…' : RECORD_PAYMENT_ACTION_LABEL}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── One destination ───────────────────────────────────────────────────────────
//
// The target, the amount, and a way to remove it. The picker is the SAME search
// the Allocate control uses — same two sources, same RLS scoping, same
// eligibility filters — so "only within your permitted scope" is not a rule
// written twice.

function AllocationRow({
  row, index, supabase, duplicate, picking, onPick, onClosePicker, onChange, onRemove,
}: {
  row: SplitAllocationRow
  index: number
  supabase: ReturnType<typeof createClient>
  duplicate: boolean
  picking: boolean
  onPick: () => void
  onClosePicker: () => void
  onChange: (patch: Partial<SplitAllocationRow>) => void
  onRemove: () => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<AllocationCandidate[]>([])
  const [position, setPosition] = useState<TargetPosition | null>(null)
  const searchToken = useRef(0)

  const runSearch = async (raw: string) => {
    setQuery(raw)
    const term = raw.trim()
    if (!term) { setResults([]); return }
    const token = ++searchToken.current
    setSearching(true)
    const found = await searchAllocationTargets(supabase, term)
    // Only the newest search may write results: a slow earlier query must never
    // overwrite a later one with stale rows.
    if (token !== searchToken.current) return
    setResults(found)
    setSearching(false)
  }

  const choose = async (candidate: AllocationCandidate) => {
    onChange({
      kind: candidate.kind,
      targetId: candidate.id,
      targetLabel: `${candidate.reference} · ${candidate.clientName}`,
    })
    setResults([])
    setQuery('')
    onClosePicker()
    setPosition(null)
    setPosition(await loadTargetPosition(supabase, candidate))
  }

  return (
    <div style={{
      border: `1px solid ${duplicate ? colors.red : colors.border}`,
      borderRadius: '8px', padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ ...LABEL, minWidth: '58px' }}>Row {index + 1}</span>

        {row.targetId && row.kind ? (
          <>
            <KindBadge kind={row.kind} />
            <span style={{
              fontSize: '13px', fontWeight: 600, color: colors.primary,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {row.targetLabel}
            </span>
            <button
              type="button"
              onClick={() => { onChange({ kind: null, targetId: null, targetLabel: null }); setPosition(null); onPick() }}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '3px 9px', fontSize: '11px' }}
            >
              Change
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onPick}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            Choose an Order or PI Draft
          </button>
        )}

        <input
          className="boe-input"
          inputMode="decimal"
          aria-label={`Amount for allocation ${index + 1}`}
          value={row.amount}
          onChange={e => onChange({ amount: sanitizeAmountInput(e.target.value) })}
          placeholder="0.00"
          style={{ marginLeft: 'auto', width: '130px', textAlign: 'right' }}
        />

        <button
          type="button"
          onClick={onRemove}
          className="boe-btn boe-btn-ghost"
          aria-label={`Remove allocation ${index + 1}`}
          style={{ padding: '3px 9px', fontSize: '11px' }}
        >
          Remove
        </button>
      </div>

      {/* WHAT THE TARGET ALREADY HAS, from the same functions its own screen
          reads. "Not visible to you" rather than a zero: an unreadable figure
          and an empty one are different facts, and only one of them means the
          gap is still open. */}
      {row.targetId && position && (
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11.5px', color: colors.secondary }}>
          <span>
            Already received{' '}
            <strong style={{ color: colors.primary }}>
              {position.received === null ? 'Not visible to you' : formatMoney(position.received)}
            </strong>
          </span>
          <span>
            Still outstanding{' '}
            <strong style={{ color: colors.primary }}>
              {position.outstanding === null ? '—' : formatMoney(position.outstanding)}
            </strong>
          </span>
        </div>
      )}

      {duplicate && (
        <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.5 }}>
          This record is already named by another row. One payment holds one allocation per record —
          combine the two.
        </div>
      )}

      {picking && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '6px', padding: '6px 10px',
          }}>
            <input
              type="text"
              autoFocus
              value={query}
              onChange={e => runSearch(e.target.value)}
              placeholder="Order number, PI reference or client name…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
            />
            {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
          </div>

          {results.length > 0 && (
            <div style={{
              border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
              maxHeight: '200px', overflowY: 'auto',
            }}>
              {results.map((candidate, i) => (
                <button
                  key={`${candidate.kind}-${candidate.id}`}
                  type="button"
                  onClick={() => choose(candidate)}
                  style={{
                    display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
                    gap: '12px', padding: '9px 12px', textAlign: 'left', cursor: 'pointer',
                    background: 'transparent', border: 'none',
                    borderBottom: i < results.length - 1 ? `1px solid ${colors.border}` : 'none',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <KindBadge kind={candidate.kind} />
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                        {candidate.reference}
                      </span>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted }}>
                        {statusLabel(candidate.status)}
                      </span>
                    </span>
                    <span style={{
                      display: 'block', fontSize: '12px', color: colors.secondary, marginTop: '2px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {candidate.clientName}
                    </span>
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, flexShrink: 0 }}>
                    {candidate.value != null ? formatMoney(candidate.value) : '—'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {query.trim() !== '' && !searching && results.length === 0 && (
            <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
              Nothing you can allocate to matches &ldquo;{query.trim()}&rdquo;. Only Orders and PI
              Drafts you may open are offered.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

function Field({ label, htmlFor, children }: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 }}>
      <label style={LABEL} htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  )
}

function Figure({ label, value, strong, tone }: {
  label: string
  value: string
  strong?: boolean
  tone?: string
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{
        fontSize: strong ? '15px' : '13px',
        fontWeight: strong ? 700 : 600,
        color: tone ?? colors.primary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {value}
      </div>
    </div>
  )
}
