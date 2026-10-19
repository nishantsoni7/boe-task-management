'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import React, { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { groupIndianDigits, isValidAmount } from '@/lib/currency'
import { notifyFinance } from '@/lib/notify'
import { PaymentEntryFields, isPaymentEntryComplete, type PaymentEntryState, type PaymentEntryTarget } from './components/PaymentEntryFields'
import { CustodyTrailFields } from './components/CustodyTrailFields'
import { FormDialog, FormStep, OptionalDisclosure, PaymentDetailsFields, scrollToFirstProblem } from './components/PaymentFormParts'
import { DiscardConfirmation, useDiscardGuard } from './components/DiscardGuard'
import { ProofReferenceField, ProofReferenceSection } from './components/ProofReferenceSection'
import { ProofDropZone } from './components/ProofDropZone'
import { attachPaymentProof } from '@/lib/finance/paymentProof'
import { compressImageFile } from '@/lib/attachment-utils'
import { customerDisplayName, destinationNeedsTarget, isPaymentMode, paymentEntryErrorMessage, paymentModeLabel, type PaymentDestination as PaymentEntryDestination } from '@/lib/finance/paymentEntry'
import { custodyDraftsError, modeRequiresCustodyTrail, toRpcCustodyEvents, type CustodyDraft } from '@/lib/finance/custodyTrail'
import { searchAllocationTargets } from './received/AllocatePaymentModal'
import { loadPaymentAllocation, loadPaymentIntent, type StoredAllocation } from './paymentIntents'
import { APPROVED_RACE_MESSAGE, type PaymentRequest } from './paymentRequestsModel'
import { ErrorBanner } from './paymentRequestsAtoms'

// ── Edit Payment modal (creator only) ────────────────────────────────────────

export type EditPaymentModalProps = {
  request: PaymentRequest
  isAdmin: boolean
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}

export function EditPaymentModal({ request: r, isAdmin, supabase, onClose, onSaved }: EditPaymentModalProps) {
  const [form, setForm] = useState({
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    proofNote:   r.proof_note ?? '',
    salesNote:   r.sales_note  ?? '',
  })

  // ── THE DESTINATION IS EDITABLE, THROUGH THE PROTECTED DOOR ──
  //
  // Since 20261013000000 a pending request's destination lives in its ALLOCATION
  // INTENT, not in the payment row's linkage columns — that is what keeps
  // unverified money out of finance_payment_allocations until Finance approves.
  // So a correction has to move the row AND the intent together, which a client
  // UPDATE cannot do atomically: edit_payment_request does it, re-derives the
  // customer from whichever record is chosen, and refuses outright once the
  // request has been approved.
  //
  // UNDEFINED IS NOT NULL HERE. `undefined` means the intent has not been read
  // back yet; `null` means the request carries none, which is what a Suspense
  // Entry is. Collapsing the two would show every request as Suspense for a
  // moment and let a Save land before the form knew what it was editing.
  const [entry, setEntry] = useState<PaymentEntryState | null>(null)

  // What the form OPENED with, so "has the destination changed?" compares
  // against the request rather than against a default.
  // A payment recorded from a PI carries an ALLOCATION, not an intent. Its
  // destination is then LOCKED (20270322000000): moving the money is Correct
  // Allocation's job. 'split' = several allocations, which cannot be corrected
  // here; null = an ordinary request whose destination is its intent.
  const [allocation, setAllocation] = useState<StoredAllocation | null>(null)

  const loadedDestination = useRef<PaymentEntryDestination | null>(null)
  const loadedTargetId    = useRef<string | undefined>(undefined)

  useEffect(() => {
    let active = true
    ;(async () => {
      const found = await loadPaymentIntent(supabase, r.id)
      const attached = found ? null : await loadPaymentAllocation(supabase, r.id)
      if (!active) return
      if (attached) {
        setAllocation(attached)
        if (attached.kind === 'attached') {
          loadedDestination.current = attached.targetType
          loadedTargetId.current    = attached.targetId
          setEntry({
            destination: attached.targetType,
            target: {
              id: attached.targetId,
              reference: attached.reference ?? 'Not visible to you',
              clientName: customerDisplayName(r.client_name),
            },
          })
          return
        }
      }
      loadedDestination.current = found ? found.targetType : 'suspense'
      loadedTargetId.current    = found ? found.targetId : undefined
      setEntry(found
        ? {
            destination: found.targetType,
            target: {
              id: found.targetId,
              reference: found.reference ?? 'Not visible to you',
              // The customer already ON THE ROW: the server derived it from
              // this very record at submission. Nothing here re-reads or
              // re-guesses it.
              clientName: customerDisplayName(r.client_name),
            },
          }
        : { destination: 'suspense', target: null })
    })()
    return () => { active = false }
  }, [supabase, r.id, r.client_name])

  // The payment mode and its cash trail ARE editable, in exactly the window
  // every other field on this form is: the row is still pre-approval, which the
  // .in('status', UNAPPROVED_STATUSES) filter below re-checks server-side and
  // finance_payment_requests_guard_approved enforces independently. This is what
  // makes "collect today, hand over tomorrow, record it then" work — the
  // handover is filled in on a later visit to this same form.
  const [paymentMode, setPaymentMode] = useState<string>(r.payment_mode)

  // THE CUSTODY ACTIVITIES THIS CORRECTION ADDS — never the ones it already has.
  // A saved activity cannot be edited or removed by anybody, so this list starts
  // empty on every visit and holds only what has not been sent yet.
  const [custody, setCustody] = useState<CustodyDraft[]>([])

  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  // Problems are named only after Save was pressed, and clear as they are put right.
  const [showProblems, setShowProblems] = useState(false)
  // Proof and notes open by themselves when the request already has some.
  const [proofOpen, setProofOpen] = useState(!!((r.proof_note ?? '').trim() || (r.sales_note ?? '').trim()))
  const formRef = useRef<HTMLDivElement>(null)

  // Set once an approval was detected mid-edit: the request is gone from this
  // page's jurisdiction, so retrying the save can only fail the same way.
  const [stale, setStale] = useState(false)

  // A proof added in this correction. It is uploaded AFTER the correction is
  // saved: a payment sent back for clarification only becomes pending (the one
  // state a proof may be attached in) when the correction lands. A failed upload
  // never undoes the saved correction; `recorded` makes the next press retry only
  // the proof, so nothing is saved twice.
  const [attachFile,  setAttachFile]  = useState<File | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [recorded, setRecorded] = useState(false)

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  // ONE SUBMISSION, NOT ONE PER CLICK. Read and written synchronously, so a
  // second click inside the same tick finds the window already shut.
  const submitting = useRef(false)

  // Same single blocking rule as the submission form, and for the same reason:
  // a half-entered activity would be refused server-side and take the whole
  // correction with it.
  const custodyError = custodyDraftsError(custody)

  // Nothing may be saved before the destination has been read back: a Save that
  // landed while `entry` was still null would write Suspense over a targeted
  // request that had simply not loaded yet.
  const splitBlocked = allocation?.kind === 'split'
  const canSubmit = entry !== null && isPaymentEntryComplete(entry)
    && isValidAmount(form.amount) && !!form.paymentDate
    && isPaymentMode(paymentMode) && !custodyError && !splitBlocked

  // ── Not losing what was typed ──
  const isDirty = () =>
    form.amount !== String(r.amount) ||
    form.paymentDate !== r.payment_date ||
    form.proofNote.trim() !== (r.proof_note ?? '').trim() ||
    form.salesNote.trim() !== (r.sales_note ?? '').trim() ||
    paymentMode !== r.payment_mode ||
    custody.length > 0 ||
    attachFile !== null ||
    (entry !== null && (entry.destination !== loadedDestination.current
      || entry.target?.id !== loadedTargetId.current))

  const guard = useDiscardGuard({ isDirty, onClose: stale || recorded ? onSaved : onClose, disabled: saving })

  // The SAME search the submission form and Allocate Funds use, narrowed to the
  // one kind the chosen destination admits.
  const searchTargets = async (kind: 'submission' | 'order', term: string): Promise<PaymentEntryTarget[]> => {
    const found = await searchAllocationTargets(supabase, term, kind)
    return found.map(c => ({
      id: c.id,
      reference: c.reference,
      clientName: c.clientName,
      totalValue: typeof c.value === 'string' ? Number(c.value) : c.value,
    }))
  }

  // ── What is still missing, in words ──
  // Presentation only: canSubmit and the database decide.
  const needsTarget = entry !== null && destinationNeedsTarget(entry.destination)
  const targetProblem = showProblems && entry !== null && needsTarget && !entry.target
    ? (entry.destination === 'pi_draft'
        ? 'Choose which PI Draft this payment is for.'
        : 'Choose which Confirmed Order this payment is for.')
    : null
  const amountProblem = showProblems && form.amount.trim() === '' ? 'Enter the amount received.' : null
  const dateProblem = showProblems && !form.paymentDate ? 'Pick the date it was paid.' : null

  const summary = [
    isValidAmount(form.amount) ? `₹${groupIndianDigits(form.amount)}` : null,
    paymentModeLabel(paymentMode),
    entry?.target
      ? `${entry.target.reference} · ${entry.target.clientName}`
      : entry?.destination === 'suspense' ? 'Suspense Entry' : null,
  ].filter(Boolean).join(' · ')

  // SAVE IS NEVER GREYED OUT BY AN UNFINISHED FORM. It names what is missing and
  // takes the person to it. Only a form still reading what the payment is for
  // waits — saving then would write Suspense over a request that had not loaded.
  // Uploads the proof added here. Null on success (or when there is none).
  const uploadProof = async (): Promise<string | null> => {
    if (!attachFile) return null
    const { data: { user } } = await supabase.auth.getUser()
    return attachPaymentProof(supabase, {
      paymentRequestId: r.id,
      file: attachFile,
      userId: user?.id ?? null,
      prepare: compressImageFile,
    })
  }

  const retryProof = async () => {
    if (saving || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError(null)
    const proofErr = await uploadProof()
    submitting.current = false
    setSaving(false)
    if (proofErr) { setError(`The correction is saved, but the proof did not upload: ${proofErr}`); return }
    onSaved()
  }

  const reviewAndSave = () => {
    if (recorded) { void retryProof(); return }
    if (saving || submitting.current || entry === null) return
    if (!canSubmit) {
      setShowProblems(true)
      scrollToFirstProblem(formRef.current)
      return
    }
    void handleSave()
  }

  const handleSave = async () => {
    if (!canSubmit || !entry || saving || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError(null)
    const isCreatorReapply = !isAdmin && (r.status === 'needs_clarification' || r.status === 'rejected')

    // ONE CALL, ONE TRANSACTION. The payment row and its allocation intent move
    // together or not at all — which a client cannot do, and which is why the
    // direct UPDATE this form used to issue is gone. The RPC locks the payment
    // first, so an approval that landed while the modal was open is seen under
    // the lock and refused by name rather than half-applied.
    //
    // NO CUSTOMER IS SENT. There is no parameter for one: edit_payment_request
    // re-derives it from whichever record the destination now names, and sets
    // it NULL for Suspense.
    // THE ACTIVITIES BEING ADDED, and only those. Correcting a request away from
    // PNB or Paytm sends none and DELETES none: what was already recorded stays,
    // because the money really did pass through those hands.
    const custodyEvents = modeRequiresCustodyTrail(paymentMode)
      ? toRpcCustodyEvents(custody)
      : []

    const { data, error: rpcError } = await supabase.rpc('edit_payment_request', {
      p_payment_request_id: r.id,
      p_destination:     entry.destination,
      p_target_id:       entry.target?.id ?? null,
      p_amount:          Number(form.amount),
      p_payment_date:    form.paymentDate,
      p_payment_mode:    paymentMode,
      p_proof_note:      form.proofNote.trim() || null,
      p_sales_note:      form.salesNote.trim() || null,
      p_custody_events:  custodyEvents,
    })

    if (rpcError || !data) {
      setSaving(false)
      submitting.current = false
      // An approval that won the race is not a retryable failure: the request
      // has left this page's jurisdiction, so the form collapses to a single
      // dismissal that refreshes the table.
      if ((rpcError?.message ?? '').includes('PAYMENT_ALREADY_APPROVED')) {
        setStale(true)
        setError(APPROVED_RACE_MESSAGE)
        return
      }
      setError(paymentEntryErrorMessage(rpcError?.message))
      return
    }

    // A creator editing a needs_clarification or rejected request moves it
    // back to pending_approval — notify approvers it is ready for review again.
    // The customer named here is the one the SERVER just derived, not the one
    // the row carried before the correction.
    if (isCreatorReapply) {
      const saved = data as { client_name: string | null }
      void notifyFinance({
        event: 'finance_resubmitted',
        requestNumber: r.request_number,
        entityId: r.id,
        clientName: customerDisplayName(saved.client_name),
      })
    }

    const proofErr = await uploadProof()
    submitting.current = false
    setSaving(false)
    if (proofErr) {
      setRecorded(true)
      setProofOpen(true)
      setError(`Your correction is saved, but the proof did not upload: ${proofErr} Press the button again to retry the proof — nothing will be saved twice.`)
      return
    }
    onSaved()
  }

  return (
    <>
    {/* Once an approval has been detected, every dismissal path refreshes so the
        table stops showing the request as still editable (see the same note on
        DeleteConfirmModal). ✕ and Escape ask before discarding; a backdrop click
        does nothing at all — the rule both entry forms carry. */}
    <FormDialog
      title={!isAdmin && r.status === 'rejected' ? 'Reapply Payment Request' : 'Edit Payment Request'}
      subtitle={r.request_number}
      onClose={guard.requestClose}
      closeDisabled={saving}
      width="660px"
      summary={stale ? null : summary}
      banner={<>
      {!isAdmin && r.status === 'needs_clarification' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#EAF0F8', border: '1px solid #C3D3E6',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#335A86', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Clarification Required
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#335A86', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '12px', color: '#335A86', marginTop: '4px' }}>
            Saving your changes will resubmit this request for admin review.
          </div>
        </div>
      )}
      {!isAdmin && r.status === 'rejected' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#FBE9EC', border: '1px solid #E9B9C1',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#A12438', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Rejection Reason
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#7F1D1D', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '12px', color: '#B42332', marginTop: '4px' }}>
            Saving your changes will reapply this request for admin review. The rejection above stays visible in Activity history.
          </div>
        </div>
      )}
      </>}
      actions={stale ? (
        /* Once an approval has been detected there is nothing left to save here,
           so the form's actions collapse to a single dismissal that also
           refreshes the table (onSaved) — never a retry that must fail again. */
        <button onClick={onSaved} className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
          Close
        </button>
      ) : (
        <>
          <button onClick={guard.requestClose} disabled={saving}
            className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>Cancel</button>
          <button onClick={reviewAndSave} disabled={saving || entry === null}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {recorded
              ? (saving ? 'Uploading…' : 'Retry proof upload')
              : !isAdmin && r.status === 'rejected'
                ? (saving ? 'Reapplying…' : 'Save & Reapply')
                : (saving ? 'Saving…' : 'Save Changes')}
          </button>
        </>
      )}
    >
      <div ref={formRef} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* WHAT THIS PAYMENT IS FOR — the same three cards the submission form
          offers, preloaded with what was chosen. Changing one clears the target
          the old one carried; the customer beneath is read-only and is
          re-derived server-side from whichever record is picked. */}
      <FormStep number={1} title="What is this payment for?">
        {entry === null ? (
          <div style={{
            padding: '11px 12px', borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised,
            fontSize: '13px', color: colors.muted,
          }}>
            Reading what this payment is for…
          </div>
        ) : allocation?.kind === 'split' ? (
          <div role="alert" style={{
            padding: '11px 12px', borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised,
            fontSize: '13px', color: colors.secondary, lineHeight: 1.5,
          }}>
            This payment is split across more than one PI or Order, so it cannot be corrected
            here. Ask Finance to correct its allocations first.
          </div>
        ) : allocation?.kind === 'attached' && entry.target ? (
          <div style={{
            padding: '11px 12px', borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised,
            fontSize: '13px', color: colors.secondary, lineHeight: 1.5,
          }}>
            <div style={{ fontWeight: 600, color: colors.primary }}>
              {entry.destination === 'pi_draft' ? 'PI Draft' : 'Order'} {entry.target.reference} · {entry.target.clientName}
            </div>
            This payment is already attached here, so the destination cannot be changed in this form.
            To move it, ask Finance to correct the allocation.
            {allocation.allocatedAmount === Number(r.amount) && (
              <> The amount attached will follow the amount you save.</>
            )}
          </div>
        ) : (
          <PaymentEntryFields
            state={entry}
            onChange={next => { setEntry(next); setError(null) }}
            onSearch={searchTargets}
            disabled={saving}
            problem={targetProblem}
          />
        )}
      </FormStep>

      <FormStep number={2} title="Payment">
        {/* A HISTORICAL ROW KEEPS ITS OWN VALUE AS AN OPTION. Without it, opening
            this form on a 2026 payment would silently move it onto HDFC the
            moment anything else was saved. The picker draws paymentModeOptionsFor,
            which adds it, marked retired, and only ever for a row that already
            carries one — a new entry never sees it. */}
        <PaymentDetailsFields
          amount={form.amount}
          onAmount={v => setForm(prev => ({ ...prev, amount: v }))}
          date={form.paymentDate}
          onDate={v => setForm(prev => ({ ...prev, paymentDate: v }))}
          mode={paymentMode}
          onMode={setPaymentMode}
          disabled={saving}
          amountProblem={amountProblem}
          dateProblem={dateProblem}
          modeHintId="edit-payment-mode-hint"
        />
      </FormStep>

      {/* WHO CARRIED IT. Adding an activity is possible for as long as the
          request is editable — which is what makes "collect today, hand over
          tomorrow, record it then" work. What is ALREADY saved is shown by the
          details popup and cannot be changed here or anywhere. */}
      {modeRequiresCustodyTrail(paymentMode) && (
        <FormStep number={3} title="Who carried the money" hint="Optional">
          <CustodyTrailFields
            supabase={supabase}
            paymentMode={paymentMode}
            drafts={custody}
            onDraftsChange={setCustody}
            // The submitter is who collected the cash, not whoever is editing — an
            // admin correcting someone else's request must not become the collector
            // by opening the form.
            defaultActorId={r.submitted_by}
            disabled={saving}
            showTitle={false}
          />
        </FormStep>
      )}

      {/* PAYMENT PROOF / REFERENCE — one heading over the reference and the
          notes, closed until wanted unless the request already has some. What was
          typed lives in this form's state, so closing never loses it. */}
      <OptionalDisclosure
        title="Add proof or notes"
        hint={attachFile ? 'Proof attached' : (form.proofNote.trim() || form.salesNote.trim()) ? 'Added' : 'Optional'}
        open={proofOpen}
        onToggle={() => setProofOpen(o => !o)}
      >
        <ProofReferenceSection>
        <ProofReferenceField label="Payment proof (screenshot or PDF)">
          <ProofDropZone
            file={attachFile}
            error={attachError}
            onFile={setAttachFile}
            onError={setAttachError}
            disabled={saving}
            note="A file added here is kept with any proof already on this payment."
          />
        </ProofReferenceField>
        <ProofReferenceField label="Payment reference">
          <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
            placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office (optional)"
            rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </ProofReferenceField>
        <ProofReferenceField label="Notes / remarks (optional)">
          <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
            placeholder="Any additional context for admin"
            rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </ProofReferenceField>
      </ProofReferenceSection>
      </OptionalDisclosure>

      {error && <ErrorBanner message={error} />}

      </div>
    </FormDialog>

    <DiscardConfirmation
      open={guard.asking}
      onKeepEditing={guard.keepEditing}
      onDiscard={guard.discard}
    />
    </>
  )
}
