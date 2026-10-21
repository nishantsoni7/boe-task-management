'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import React, { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { compressImageFile } from '@/lib/attachment-utils'
import { PROOF_BUCKET, validateProofFile, buildProofPath, proofContentType } from '@/lib/paymentProof'
import { groupIndianDigits, isValidAmount } from '@/lib/currency'
import { AmountInput } from './components/AmountInput'
import { notifyFinance } from '@/lib/notify'
import { useDialogFocus, useModalScrollLock, FINANCE_MODAL_OVERLAY_Z, FINANCE_MODAL_DIALOG_Z } from '@/app/finance/components/FinanceModalShell'
import { completePaymentEntry } from '@/lib/finance/paymentEntryCompletion'
import { EMPTY_PAYMENT_ENTRY, PaymentEntryFields, isPaymentEntryComplete, type PaymentEntryState, type PaymentEntryTarget } from './components/PaymentEntryFields'
import { CustodyTrailFields } from './components/CustodyTrailFields'
import { PaymentModeHint } from './components/PaymentModeHint'
import { FieldProblem, FormStep, OptionalDisclosure, PaymentModePicker, QuickDateField } from './components/PaymentFormParts'
import { DiscardConfirmation, useDiscardGuard } from './components/DiscardGuard'
import { ProofReferenceField, ProofReferenceSection } from './components/ProofReferenceSection'
import { ProofDropZone } from './components/ProofDropZone'
import { DEFAULT_PAYMENT_MODE, customerDisplayName, destinationNeedsTarget, isPaymentMode, paymentEntryErrorMessage } from '@/lib/finance/paymentEntry'
import { SubmissionAttempt, SUBMISSION_OUTCOME_UNKNOWN, isAmbiguousFailure } from '@/lib/finance/submissionAttempt'
import { custodyDraftsError, modeRequiresCustodyTrail, toRpcCustodyEvents, type CustodyDraft } from '@/lib/finance/custodyTrail'
import { searchAllocationTargets } from './received/AllocatePaymentModal'
import { Field, ErrorBanner } from './paymentRequestsAtoms'

// ── New Payment Request modal ─────────────────────────────────────────────────
//
// THREE DESTINATIONS, THE SAME THREE RECORD PAYMENT OFFERS. PI Draft, Confirmed
// Order, Suspense Entry — one list, one component (PaymentEntryFields), so the
// two forms cannot drift into asking the same question in different words.
//
// THE CUSTOMER IS NOT TYPED, AND IS NOT SENT. submit_payment_request derives it
// from the record this form validates against (20261013000000 §3): a name from
// the browser would be a claim the browser is in no position to make, so the RPC
// has no parameter for one. A Suspense Entry has none at all, and the column is
// null rather than filled with something invented.
//
// AND IT IS NOT AN ALLOCATION. A payment request is unverified money. Submitting
// one writes the payment and a pending ALLOCATION INTENT in a single
// transaction; nothing reaches finance_payment_allocations until Finance
// approves, so nothing here moves an Order's received total, closes a balance or
// satisfies the 40% gate.
//
// ONE WRITE, ONE DOOR. The form used to INSERT into finance_payment_requests
// directly. Two writes that must both land — the payment and its intent —
// cannot be made atomic from a browser, so the insert is gone and the RPC is the
// only way in. Every gate is still the database's: module entry, RLS, the
// target's eligibility, the canonical five payment modes.

// Everything on the form that is NOT the destination and NOT the cash trail.
//
// There is no `clientName` here, and there is no `receivedIn`. The customer is
// derived server-side from the chosen record; the receiving account is no longer
// asked for at all, and null is stored rather than a fabricated one.
export const EMPTY_FORM = {
  amount:          '',
  paymentDate:     '',
  proofNote:       '',
  salesNote:       '',
  paymentMode:     DEFAULT_PAYMENT_MODE as string,
}

export type NewPaymentModalProps = {
  userId: string
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
  // Optional prefill, used when the form is opened from another module so the
  // salesperson does not retype what that module already knows. The note is an
  // ordinary editable field value; the client name only SEEDS THE SEARCH BOX —
  // see PaymentEntryFields' initialQuery.
  initialClientName?: string
  initialSalesNote?: string
  contextLabel?: string
}

export function NewPaymentConfirmationModal({
  userId, supabase, onClose, onSaved,
  initialClientName, initialSalesNote, contextLabel,
}: NewPaymentModalProps) {
  useModalScrollLock()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, salesNote: initialSalesNote ?? '' }))
  const [entry, setEntry] = useState<PaymentEntryState>(EMPTY_PAYMENT_ENTRY)
  // THE CUSTODY TRAIL, as many activities as the money actually went through.
  // Empty until somebody adds one: a PNB payment that was collected and handed
  // over in one motion is one activity, and one that has not moved yet is none.
  const [custody, setCustody] = useState<CustodyDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  // Nothing is shouted at a person who has not finished. Problems are named only
  // after they press Send, and each one clears the moment it is put right.
  const [showProblems, setShowProblems] = useState(false)
  // Proof and notes stay closed unless something is already in them.
  const [proofOpen, setProofOpen] = useState(!!(initialSalesNote ?? '').trim())

  // ONE SUBMISSION, NOT ONE PER CLICK. `saving` re-renders and a second click
  // can land inside the same tick; a ref is read and written synchronously, so
  // it is what actually closes the window.
  const submitting = useRef(false)

  // ONE SUBMISSION, ONE PAYMENT — ON THE SERVER (20261219000000). The key is
  // reused until the outcome is known AND the proof is attached, so a lost
  // response, a refresh or a proof retry replays the payment already recorded
  // instead of recording it again.
  const attemptRef = useRef<SubmissionAttempt | null>(null)
  if (attemptRef.current === null) attemptRef.current = new SubmissionAttempt('payment-request')

  // Optional payment-proof attachment (uploaded to the private payment-proofs bucket)
  const [attachFile,  setAttachFile]  = useState<File | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)

  const set = (key: keyof typeof EMPTY_FORM) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  // ADDING AN ACTIVITY IS OPTIONAL; FINISHING ONE IS NOT. A half-entered
  // activity — a handover with nobody named, a collection with no time — blocks
  // the save, because the server would refuse it and take the whole request with
  // it. append_payment_custody_events_internal applies exactly these rules.
  const custodyError = custodyDraftsError(custody)

  const canSubmit = !!(
    isPaymentEntryComplete(entry) &&
    isValidAmount(form.amount) &&
    form.paymentDate &&
    isPaymentMode(form.paymentMode) &&
    !custodyError &&
    !attachError
  )

  // ── Not losing what was typed ──
  //
  // The payment mode starts at a value nobody chose, so it counts as dirty only
  // once it has been changed. A prefilled note does not count either: the person
  // did not type it.
  const isDirty = () =>
    form.amount.trim() !== '' ||
    form.paymentDate !== '' ||
    form.proofNote.trim() !== '' ||
    form.salesNote.trim() !== (initialSalesNote ?? '').trim() ||
    form.paymentMode !== EMPTY_FORM.paymentMode ||
    entry.destination !== EMPTY_PAYMENT_ENTRY.destination ||
    entry.target !== null ||
    custody.length > 0 ||
    attachFile !== null

  const guard = useDiscardGuard({ isDirty, onClose, disabled: saving })

  // ── What is still missing, in words ──
  // Presentation only: canSubmit and the server decide. These sentences say WHICH
  // field is unanswered, instead of leaving a button grey with no explanation.
  const needsTarget = destinationNeedsTarget(entry.destination)
  const targetProblem = showProblems && needsTarget && !entry.target
    ? (entry.destination === 'pi_draft'
        ? 'Choose which PI Draft this payment is for.'
        : 'Choose which Confirmed Order this payment is for.')
    : null
  const amountProblem = showProblems && form.amount.trim() === '' ? 'Enter the amount received.' : null
  const dateProblem = showProblems && !form.paymentDate ? 'Pick the date it was paid.' : null

  // The footer does not repeat what the form already shows (the account, the
  // destination): it carries the one thing the form does not say.
  const summary = [
    isValidAmount(form.amount) ? `₹${groupIndianDigits(form.amount)}` : null,
    'Finance verifies it before the money is attached',
  ].filter(Boolean).join(' · ')

  // SEND IS NEVER GREYED OUT. An unfinished form names what is missing and takes
  // the person to it. A finished one goes to handleSubmit, whose own guard is the
  // one that stops a double submission.
  const reviewAndSend = () => {
    if (saving || submitting.current) return
    if (!canSubmit) {
      setShowProblems(true)
      if (attachError) setProofOpen(true)
      requestAnimationFrame(() => {
        const dialog = dialogRef.current
        const target = dialog?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?? dialog?.querySelector<HTMLElement>('[role="alert"]')
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        target?.focus?.({ preventScroll: true })
      })
      return
    }
    void handleSubmit()
  }

  // The SAME search Record Payment and Allocate Funds use — same sources, same
  // RLS scoping, same eligibility filters — narrowed to the one kind this
  // destination admits.
  const searchTargets = async (kind: 'submission' | 'order', term: string): Promise<PaymentEntryTarget[]> => {
    const found = await searchAllocationTargets(supabase, term, kind)
    return found.map(c => ({
      id: c.id,
      reference: c.reference,
      clientName: c.clientName,
      totalValue: typeof c.value === 'string' ? Number(c.value) : c.value,
    }))
  }

  // Uploads the selected proof to the private bucket and records its metadata.
  // Returns null on success, or an error string. On any failure it removes a
  // partially-uploaded object so no orphaned file remains; the CALLER is then
  // responsible for removing the payment request it made, so the user is never
  // told success when the proof was not persisted.
  const persistProof = async (paymentRequestId: string): Promise<string | null> => {
    if (!attachFile) return null
    // Compression can change size/type, so re-validate the prepared file.
    const prepared = await compressImageFile(attachFile)
    const vErr = validateProofFile(prepared)
    if (vErr) return vErr

    // Upload under the type the bucket will actually accept. validateProofFile
    // guarantees this resolves, but fail closed rather than upload as octet-stream.
    const contentType = proofContentType(prepared)
    if (!contentType) return 'Only images (JPG, PNG, WEBP, GIF) or PDF files are allowed.'

    const path = buildProofPath(paymentRequestId, prepared.name)
    const { error: upErr } = await supabase.storage
      .from(PROOF_BUCKET)
      .upload(path, prepared, { upsert: false, contentType })
    if (upErr) return 'Could not upload the payment proof. Please try again.'

    const { error: metaErr } = await supabase
      .from('payment_proof_attachments')
      .insert({
        payment_request_id: paymentRequestId,
        storage_path:       path,
        file_name:          attachFile.name,
        file_type:          contentType,
        file_size:          prepared.size,
        created_by:         userId,
      })
    if (metaErr) {
      // Object uploaded but metadata failed — remove the object. The payment
      // request still exists here, so the storage delete policy authorizes this.
      await supabase.storage.from(PROOF_BUCKET).remove([path])
      return 'Could not save the payment proof. Please try again.'
    }
    return null
  }

  const handleSubmit = async () => {
    if (!canSubmit || saving || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError(null)

    // THE CUSTODY TRAIL IS SENT ONLY WHEN THE MODE CARRIES ONE — and the RPC
    // decides that again for itself, so this agreement is a convenience and not
    // the rule. A stale activity left over from a mode the person changed away
    // from is refused server-side rather than stored.
    const custodyEvents = modeRequiresCustodyTrail(form.paymentMode)
      ? toRpcCustodyEvents(custody)
      : []

    // ONE CALL, ONE TRANSACTION. The payment, its allocation intent and its
    // custody activities are written together or not at all. No client name is
    // sent: there is no parameter for one, deliberately.
    const args = {
      p_destination:     entry.destination,
      p_target_id:       entry.target?.id ?? null,
      p_amount:          Number(form.amount),
      p_payment_date:    form.paymentDate,
      p_payment_mode:    form.paymentMode,
      p_proof_note:      form.proofNote.trim() || null,
      p_sales_note:      form.salesNote.trim() || null,
      p_custody_events:  custodyEvents,
    }
    const attempt = attemptRef.current!
    const { data, error: rpcError } = await supabase.rpc('submit_payment_request', {
      ...args,
      p_idempotency_key: attempt.begin(args),
    })

    if (rpcError || !data) {
      submitting.current = false
      // Unknown outcome: the key is KEPT, so pressing again cannot record twice.
      attempt.settleUnlessAmbiguous(rpcError)
      setError(isAmbiguousFailure(rpcError) ? SUBMISSION_OUTCOME_UNKNOWN : paymentEntryErrorMessage(rpcError?.message))
      setSaving(false)
      return
    }

    const created = data as {
      payment_request_id: string
      request_number: string
      client_name: string | null
    }

    const proofErr = await persistProof(created.payment_request_id)
    if (proofErr) {
      // THE PAYMENT STAYS, PENDING (20270117000000). A proof failure never undoes
      // a recorded payment: the money is real, and it waits for verification
      // like any other. Nothing is verified — the last call below is not made.
      // THE KEY IS NOT SETTLED, so Send replays THIS payment and retries only
      // the proof; it is never recorded twice.
      submitting.current = false
      setError(`Payment ${created.request_number} is recorded and awaiting verification, but its proof did not upload: ${proofErr} Press Send again to retry the proof — the payment will not be recorded twice.`)
      setSaving(false)
      return
    }
    // THE LAST CALL (20270120000000), after the proof: a holder of
    // finance.verify_own_payment has their own payment verified now, and the
    // server tells the other holders for information. Nobody is asked to review
    // it, so the "requires review" notice below is not sent.
    const completion = await completePaymentEntry(supabase, created.payment_request_id)
    attempt.settle()
    setSaving(false)

    // Notify approvers that a new request is waiting (non-blocking). The
    // customer named here is the one the SERVER derived, not one this form
    // guessed — and it is honestly absent for a Suspense Entry.
    if (!completion.verified) {
      void notifyFinance({
        event: 'finance_submitted',
        requestNumber: created.request_number,
        entityId: created.payment_request_id,
        clientName: customerDisplayName(created.client_name),
      })
    }

    onSaved()
  }

  return (
    <>
      {/* Full-page overlay. INERT: this form holds unsaved input, and a
          backdrop click is frequently an accident — a missed target, a stray
          click while reading. There is no version of it that means "throw this
          away". Escape and ✕ still close, and ask first when there is
          something to lose. */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Send Payment Request"
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '660px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 40px)',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          zIndex: FINANCE_MODAL_DIALOG_Z, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          outline: 'none',
        }}>

        {/* ── Header ── */}
        <div style={{
          padding: '16px 24px 14px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: colors.primary }}>
              Send Payment Request
            </div>
            {contextLabel && (
              <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                {contextLabel}
              </div>
            )}
          </div>
          <button
            onClick={guard.requestClose}
            disabled={saving}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{
          padding: '20px 24px', overflowY: 'auto', flex: 1,
          display: 'flex', flexDirection: 'column', gap: '24px',
        }}>

          {/* 1. What the money is for — and, for the two targeted destinations,
              which record. The customer follows from it and is shown read-only;
              there is no field to type one into. */}
          <FormStep number={1} quiet title="What is this payment for?">
            <PaymentEntryFields
              state={entry}
              onChange={next => { setEntry(next); setError(null) }}
              onSearch={searchTargets}
              disabled={saving}
              initialQuery={initialClientName}
              autoFocusSearch
              problem={targetProblem}
            />
          </FormStep>

          {/* 2. The payment itself. */}
          <FormStep number={2} quiet title="Payment">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
              <Field label="Amount" required quiet>
                <AmountInput prefix="₹" value={form.amount} onChange={v => setForm(prev => ({ ...prev, amount: v }))} />
                <FieldProblem message={amountProblem} />
              </Field>
              <Field label="Payment date" required quiet>
                <QuickDateField
                  value={form.paymentDate}
                  onChange={v => setForm(prev => ({ ...prev, paymentDate: v }))}
                  disabled={saving}
                  invalid={!!dateProblem}
                />
                <FieldProblem message={dateProblem} />
              </Field>
            </div>

            {/* THE FOUR ACCOUNTS, from the one shared list. There is no
                receiving-account question: the account picker answered
                payment_mode and received_in at once, and the mode IS the account
                now. What each account means internally is not printed. */}
            <Field label="Payment mode" required quiet>
              <PaymentModePicker
                value={form.paymentMode}
                onChange={v => setForm(prev => ({ ...prev, paymentMode: v }))}
                disabled={saving}
                describedBy="payment-mode-hint"
              />
              <PaymentModeHint mode={form.paymentMode} id="payment-mode-hint" />
            </Field>
          </FormStep>

          {/* 3. WHO CARRIED IT — for PNB and Paytm only, decided by the mode and
              decided again server-side. */}
          {modeRequiresCustodyTrail(form.paymentMode) && (
            <FormStep number={3} quiet title="Who carried the money" hint="Optional">
              <CustodyTrailFields
                supabase={supabase}
                paymentMode={form.paymentMode}
                drafts={custody}
                onDraftsChange={setCustody}
                defaultActorId={userId}
                disabled={saving}
                showTitle={false}
              />
            </FormStep>
          )}

          {/* PAYMENT PROOF / REFERENCE — closed until wanted. The attachment, the
              reference and the note to Finance stay one section; the database
              keeps three columns because they mean three things. What was typed
              lives in this form's state, so closing the section never loses it. */}
          <OptionalDisclosure
            title="Add proof or notes"
            hint={attachFile ? 'Proof attached' : (form.proofNote.trim() || form.salesNote.trim()) ? 'Added' : 'Optional'}
            open={proofOpen}
            onToggle={() => setProofOpen(o => !o)}
          >
            <ProofReferenceSection quiet>
              <ProofReferenceField quiet label="Proof">
                <ProofDropZone
                  file={attachFile}
                  error={attachError}
                  onFile={setAttachFile}
                  onError={setAttachError}
                  disabled={saving}
                />
              </ProofReferenceField>

              <ProofReferenceField quiet label="Reference">
                <input
                  className="boe-input"
                  value={form.proofNote}
                  onChange={set('proofNote')}
                  placeholder="UTR, cheque number or a short note"
                  style={{ width: '100%' }}
                />
              </ProofReferenceField>

              <ProofReferenceField quiet label="Notes for Finance">
                <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
                  placeholder="Anything Finance should know"
                  rows={2} style={{ width: '100%', resize: 'vertical' }} />
              </ProofReferenceField>
            </ProofReferenceSection>
          </OptionalDisclosure>

          {error && <ErrorBanner message={error} />}

        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '12px 24px', borderTop: `1px solid ${colors.border}`,
          display: 'flex', gap: '8px 16px', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', flexShrink: 0,
        }}>
          <div aria-live="polite" style={{ fontSize: '12px', color: colors.muted, minWidth: 0, wordBreak: 'break-word' }}>
            {summary}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
            <button onClick={guard.requestClose} disabled={saving}
              className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>
              Cancel
            </button>
            <button onClick={reviewAndSend} disabled={saving}
              className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
              {saving ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </div>

      </div>

      <DiscardConfirmation
        open={guard.asking}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discard}
      />
    </>
  )
}
