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
// THREE DESTINATIONS, THE SAME THREE THE PAYMENT REQUEST FORM ASKS FOR. PI
// Draft, Confirmed Order, Suspense Entry — one list, one component, so the two
// forms cannot drift into asking the same question in different words. The
// destination narrows the picker to one kind and decides whether the entry
// carries allocations at all; it does NOT narrow it to one target, because
// dividing one payment across several Orders is the reason this form exists.
//
// A PAYMENT THAT COVERS BOTH A PI DRAFT AND AN ORDER is recorded as a Suspense
// Entry and then divided through Allocate Funds, which offers both kinds. That
// is one round trip more than the old mixed list allowed, and it is the price
// of the three destinations being the same three everywhere.
//
// THE CUSTOMER IS NOT ASKED FOR. record_payment_with_allocations derives it
// from the targets it has already validated (20261013000000), and leaves it
// null when there are none. Nothing here types a name, sends one, or invents an
// account to put in received_in.
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
  type SplitTargetKind,
} from '@/lib/finance/splitPaymentEntry'
import {
  EMPTY_PAYMENT_ENTRY,
  DestinationCards,
} from '@/app/finance/components/PaymentEntryFields'
import { DiscardConfirmation, useDiscardGuard } from '@/app/finance/components/DiscardGuard'
import {
  DEFAULT_PAYMENT_MODE,
  SUSPENSE_NOTICE,
  destinationTargetKind,
  paymentModeOptionsFor,
  type PaymentDestination,
} from '@/lib/finance/paymentEntry'
import {
  custodyDraftsError,
  modeRequiresCustodyTrail,
  toRpcCustodyEvents,
  type CustodyDraft,
} from '@/lib/finance/custodyTrail'
import { attachPaymentProof } from '@/lib/finance/paymentProof'
import { validateProofFile } from '@/lib/paymentProof'
import { CustodyTrailFields } from '@/app/finance/components/CustodyTrailFields'
import {
  ProofReferenceField,
  ProofReferenceSection,
} from '@/app/finance/components/ProofReferenceSection'
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


let rowSeq = 0
const nextRowKey = () => `alloc-${++rowSeq}`

export function RecordSplitPaymentModal({
  supabase,
  userId,
  onClose,
  onRecorded,
}: {
  supabase: ReturnType<typeof createClient>
  /** Whoever is recording this. Seeds the first custody activity and the proof row. */
  userId?: string | null
  onClose: () => void
  onRecorded: (summary: { requestNumber: string; allocationCount: number }) => void
}) {
  // ── Where the money is for ──
  //
  // The SAME three the Payment Request form offers, from the same list, drawn by
  // the same component. What differs below is only how many targets the answer
  // admits: a request names one, and this form divides one payment across
  // several of that one kind.
  const [destination, setDestination] = useState<PaymentDestination>(EMPTY_PAYMENT_ENTRY.destination)

  // ── The payment, entered once ──
  const [amount,      setAmount]      = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [paymentMode, setPaymentMode] = useState<string>(DEFAULT_PAYMENT_MODE)
  const [reference,   setReference]   = useState('')
  const [remarks,     setRemarks]     = useState('')

  // ── The custody trail, for the two modes a person carries ──
  const [custody, setCustody] = useState<CustodyDraft[]>([])

  // ── The optional proof, attached after the payment exists ──
  const [attachFile,  setAttachFile]  = useState<File | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [proofNotice, setProofNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── The destinations ──
  const [rows, setRows] = useState<SplitAllocationRow[]>([EMPTY_ALLOCATION_ROW(nextRowKey())])
  const [pickerFor, setPickerFor] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  // ONE SUBMISSION, NOT ONE PER CLICK. `saving` re-renders and a second click can
  // land inside the same tick; a ref is read and written synchronously, so it is
  // the thing that actually closes the window.
  const submitting = useRef(false)

  const targetKind = destinationTargetKind(destination)

  // SUSPENSE SENDS NOTHING, AND HOLDS NOTHING. Switching to it empties the list
  // rather than hiding it, so what is on screen and what is in the payload are
  // the same set of rows.
  const totals     = splitPaymentTotals({ amount, rows })
  const duplicates = duplicateTargetKeys(rows)
  // A HALF-ENTERED CUSTODY ACTIVITY BLOCKS THE SAVE, for the same reason a
  // half-entered allocation does: the server refuses it and takes the whole
  // entry with it, so the person is told here instead of after a round trip.
  const custodyError = custodyDraftsError(custody)
  const blocked    = splitPaymentBlockedReason({ destination, amount, paymentDate, paymentMode, rows })
    ?? custodyError ?? attachError

  // ── Not losing what was typed ──
  //
  // Dirty means "there is something here worth a question". The payment mode
  // starts at a value nobody chose, so it counts only once it has been changed.
  const isDirty = () =>
    amount.trim() !== '' ||
    paymentDate !== '' ||
    paymentMode !== DEFAULT_PAYMENT_MODE ||
    reference.trim() !== '' ||
    remarks.trim() !== '' ||
    destination !== EMPTY_PAYMENT_ENTRY.destination ||
    custody.length > 0 ||
    attachFile !== null ||
    rows.some(r => r.kind || r.targetId || r.amount.trim())

  const guard = useDiscardGuard({ isDirty, onClose, disabled: saving })

  const changeDestination = (next: PaymentDestination) => {
    if (next === destination) return
    setError(null)
    setDestination(next)
    // A row chosen under one destination is not an answer to another: an Order
    // left behind under "PI Draft" would be refused by the server after the
    // person had stopped looking, and one left behind under "Suspense Entry"
    // would allocate money they had said not to allocate.
    setRows([EMPTY_ALLOCATION_ROW(nextRowKey())])
    setPickerFor(null)
  }

  const patchRow = (key: string, patch: Partial<SplitAllocationRow>) => {
    setError(null)
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const removeRow = (key: string) => {
    setError(null)
    setRows(prev => {
      const next = prev.filter(r => r.key !== key)
      // Never zero rows: a targeted entry with no row at all offers nowhere to
      // start and reads as a bug. An entry that should carry none is Suspense.
      return next.length > 0 ? next : [EMPTY_ALLOCATION_ROW(nextRowKey())]
    })
  }

  const handleSave = async () => {
    if (blocked || saving || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError(null)

    const { data, error: rpcError } = await supabase.rpc('record_payment_with_allocations', {
      p_amount:       Number(amount),
      p_payment_date: paymentDate,
      p_payment_mode: paymentMode,
      // THE CUSTOMER IS NOT SENT. record_payment_with_allocations derives it
      // from the targets it validates (20261013000000); a name from here would
      // be a claim this form is in no position to make.
      p_client_name:  null,
      // AND NEITHER IS THE ACCOUNT. received_in has been nullable since
      // 20260919000000 and this form no longer asks for it. null means "not
      // stated", which is true — nothing is fabricated to fill it.
      p_received_in:  null,
      p_reference:    reference.trim() || null,
      p_remarks:      remarks.trim() || null,
      // A SUSPENSE ENTRY IS AN EMPTY LIST, not a hidden one. There is no branch
      // here that could send a row the person cannot see.
      p_allocations:  targetKind ? toRpcAllocations(rows) : [],
      // THE CUSTODY TRAIL, in the same transaction as the payment and its
      // allocations. Sent only for a mode somebody carries — and the RPC decides
      // that again for itself, so a section left on screen after the mode changed
      // has its rows refused rather than stored.
      p_custody_events: modeRequiresCustodyTrail(paymentMode) ? toRpcCustodyEvents(custody) : [],
    })

    setSaving(false)

    // A FAILURE HERE IS A COMPLETE FAILURE, and is reported as one. The RPC is a
    // single transaction: there is no partial state to describe and nothing for
    // this screen to compensate for. The form STAYS OPEN with everything in it,
    // so a refusal costs a correction and not a re-entry.
    if (rpcError || !data) {
      submitting.current = false
      setError(splitPaymentErrorMessage(rpcError?.message))
      return
    }

    const result = data as {
      request_number?: string
      allocation_count?: number
      payment_request_id?: string
    }

    // ── THE PROOF, AFTER THE PAYMENT EXISTS ──
    //
    // A storage object needs the payment's id in its path and the payment row
    // for its policy, so it cannot be written first. attachPaymentProof NEVER
    // removes the payment if it fails: the money is recorded, and discarding a
    // recorded payment because a file did not upload would throw away the fact
    // that matters. The person is told, and the proof can be attached from the
    // payment's own screen.
    if (attachFile && result.payment_request_id) {
      const proofError = await attachPaymentProof(supabase, {
        paymentRequestId: result.payment_request_id,
        file: attachFile,
        userId: userId ?? null,
      })
      if (proofError) {
        submitting.current = false
        setProofNotice(`${proofError} The payment itself was recorded.`)
        return
      }
    }

    onRecorded({
      requestNumber:   result.request_number ?? '',
      allocationCount: result.allocation_count ?? 0,
    })
  }

  return (
    <FinanceModal
      title={RECORD_PAYMENT_MODAL_TITLE}
      /* ✕ asks before it discards; so does Escape, through the guard's own
         capture-phase listener, which stops this shell's from also firing. */
      onClose={guard.requestClose}
      width="700px"
      /* Holds unsaved input, so a backdrop click must never discard it —
         the project's Form Modal Dismissal Rule. */
      closeOnBackdropClick={false}
    >
      <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
        One payment, divided across every record it actually paid for.
        Anything not allocated stays as an available balance on the payment.
        Finance still verifies it before it counts as received.
      </div>

      {/* ── 1. Where the money is for ── */}
      <DestinationCards value={destination} onChange={changeDestination} disabled={saving} />

      {destination === 'suspense' && (
        <p style={{
          margin: 0, fontSize: '12px', color: colors.muted, lineHeight: 1.5,
          padding: '10px 12px', borderRadius: '8px', background: colors.hover,
        }}>
          {SUSPENSE_NOTICE}
        </p>
      )}

      {/* ── 2. The payment itself ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <Field label="Amount received" htmlFor="rsp-amount">
          <input
            id="rsp-amount" className="boe-input" inputMode="decimal" value={amount} autoFocus
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
        {/* THE FOUR ACCOUNTS, from the one shared list — the same four the
            Payment Request form offers. What each means internally is not
            printed here or anywhere. */}
        <Field label="Payment mode" htmlFor="rsp-mode">
          <select
            id="rsp-mode" className="boe-input" value={paymentMode}
            onChange={e => { setPaymentMode(e.target.value); setError(null) }}
            style={{ width: '100%' }}
          >
            {paymentModeOptionsFor(null).map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* WHO CARRIED IT — for PNB and Paytm only. */}
      <CustodyTrailFields
        supabase={supabase}
        paymentMode={paymentMode}
        drafts={custody}
        onDraftsChange={setCustody}
        defaultActorId={userId ?? undefined}
        disabled={saving}
      />

      {/* PAYMENT PROOF / REFERENCE — the attachment, the reference and the
          remark under ONE heading, exactly as the two Payment Request forms ask
          them. Three parts of one question; three columns in the database,
          because they mean three things. */}
      <ProofReferenceSection>
        <ProofReferenceField
          label="Payment reference"
          htmlFor="rsp-reference"
          hint={attachError
            ? <span style={{ fontSize: '11px', color: colors.red }}>{attachError}</span>
            : attachFile
              ? <span style={{ fontSize: '11px', color: colors.muted }}>
                  Attached: {attachFile.name} — proof is optional and stored privately.
                </span>
              : undefined}
        >
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              id="rsp-reference" className="boe-input" value={reference}
              onChange={e => { setReference(e.target.value); setError(null) }}
              placeholder="UTR, cheque number…"
              style={{ flex: 1, minWidth: 0 }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0] ?? null
                if (!f) { setAttachFile(null); setAttachError(null); return }
                const vErr = validateProofFile(f)
                if (vErr) {
                  setAttachFile(null)
                  setAttachError(vErr)
                  if (fileInputRef.current) fileInputRef.current.value = ''
                  return
                }
                setAttachError(null)
                setAttachFile(f)
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {attachFile
                ? '📎 ' + attachFile.name.slice(0, 14) + (attachFile.name.length > 14 ? '…' : '')
                : '📎 Attach'}
            </button>
          </div>
        </ProofReferenceField>

        <ProofReferenceField label="Notes / remarks (optional)" htmlFor="rsp-remarks">
          <textarea
            id="rsp-remarks" className="boe-input" value={remarks} rows={2}
            onChange={e => { setRemarks(e.target.value); setError(null) }}
            placeholder="Anything Finance should know when verifying this"
            style={{ width: '100%', resize: 'vertical' }}
          />
        </ProofReferenceField>
      </ProofReferenceSection>

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

      {/* ── 3. The targets, when the destination has any ── */}
      {targetKind && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <span style={LABEL}>
              {destination === 'pi_draft' ? 'PI Drafts' : 'Orders'}
            </span>
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
                kind={targetKind}
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
        </>
      )}

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

      {/* THE PAYMENT LANDED AND THE FILE DID NOT. Said plainly, and NOT as a
          failure of the entry: the money is recorded, and the proof can be
          attached from the payment's own screen. */}
      {proofNotice && (
        <div style={{
          fontSize: '12px', color: '#9A3412', background: '#FFF7ED',
          border: '1px solid #FED7AA', borderRadius: '6px', padding: '8px 12px', lineHeight: 1.5,
        }}>
          {proofNotice}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={guard.requestClose} disabled={saving}
                className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
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

      <DiscardConfirmation
        open={guard.asking}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discard}
      />
    </FinanceModal>
  )
}

// ── One destination ───────────────────────────────────────────────────────────
//
// The target, the amount, and a way to remove it. The picker is the SAME search
// the Allocate control uses — same sources, same RLS scoping, same eligibility
// filters — so "only within your permitted scope" is not a rule written twice.
//
// NARROWED TO ONE KIND, by the destination the form already asked about.
// Offering Orders under "PI Draft" would offer a choice the entry then refuses,
// and it would read the other table for rows every one of which is discarded.

function AllocationRow({
  row, index, kind, supabase, duplicate, picking, onPick, onClosePicker, onChange, onRemove,
}: {
  row: SplitAllocationRow
  index: number
  kind: SplitTargetKind
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
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const noun = kind === 'submission' ? 'PI Draft' : 'Order'

  // DEBOUNCED, THEN GUARDED. The delay stops a query per keystroke; the token
  // stops a slow earlier query from overwriting a later one with stale rows.
  // Neither is a substitute for the other.
  const runSearch = (raw: string) => {
    setQuery(raw)
    if (debounce.current) clearTimeout(debounce.current)
    const term = raw.trim()
    if (!term) { setResults([]); return }
    debounce.current = setTimeout(async () => {
      const token = ++searchToken.current
      setSearching(true)
      const found = await searchAllocationTargets(supabase, term, kind)
      if (token !== searchToken.current) return
      setResults(found)
      setSearching(false)
    }, 250)
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
            {kind === 'submission' ? 'Choose a PI Draft' : 'Choose an Order'}
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
              placeholder={kind === 'submission'
                ? 'PI reference or customer name…' : 'Order number or customer name…'}
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
              No {noun} you can allocate to matches &ldquo;{query.trim()}&rdquo;. Only records you
              may open are offered.
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
