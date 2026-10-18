'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import type { ActivityTargetResolver } from '@/lib/finance/paymentActivityLabels'
import { PaymentCustodyTrail, usePaymentDestination } from '@/app/finance/components/PaymentDestinationBlock'
import { PAYMENT_MODE_LABEL, customerDisplayName } from '@/lib/finance/paymentEntry'
import { RequestModalShell } from '@/app/finance/components/FinanceModalShell'
import { CustomerName } from '@/components/finance/CustomerName'
import { type PaymentAllocationSummary } from '@/lib/finance/paymentAllocations'
import { CORRECT_ALLOCATION_ACTION_LABEL } from '@/lib/finance/allocationCorrection'
import { PaymentRequest, receivedInLabel, STATUS_CORRECTION_OPTIONS, fmtDateTime, fmtDate, fmtAmount, friendlyDbErrorMessage, ErrorBanner } from './receivedPaymentsModel'
import { SectionHeader, DetailRow, DIVIDED_SECTION, StatusBadge } from './receivedPaymentsAtoms'
import { AllocationPanel } from './receivedPaymentsPanel'

// ── Details modal ─────────────────────────────────────────────────────────────
//
// A PAYMENT RECEIPT AND AN ALLOCATION RECORD, not a print-out of the row.
//
// Everything here answers one of eight questions: how much, from whom, when,
// against which record, is any of it still free, who approved it, is there
// proof, and what has happened to it. A field that answers none of them, or
// that answers one already answered somewhere else on this screen, is not shown
// — the old layout said "Order 0524" four times (Payment Against, Order Number,
// the allocation row, and the breakdown strip) and the Payment ID twice.
//
// WHAT WAS REMOVED WAS DUPLICATION, NEVER A FACT:
//   Payment ID field        → it is the modal's own title.
//   Payment Against         → the Allocation list names the same records, with
//                             the amount that went to each.
//   Order Number            → likewise, and it could only name one Order.
//   Allocation Status badge → Allocated + Remaining are the figures the status
//                             is derived from, and they are printed in full.
//   To PI Drafts / To Orders → per-target amounts already sum to exactly this.
//   Initiated By            → Activity, where it belongs, with when.
//   Not attached / Not provided / No notes provided → an absent optional field
//                             is now absent from the layout.

// EXPORTED FOR ITS RENDER TEST only — this page mounts it. The test pins that
// Correct Allocation is drawn for a holder of the capability and for nobody else.
export function DetailsModal({
  request: r,
  onClose,
  mayCorrectPayments,
  supabase,
  onCorrected,
  allocation,
  canOpenLinkedRecord,
  onOpenLinked,
  onCorrectAllocation,
}: {
  request: PaymentRequest
  onClose: () => void
  /**
   * Opens Correct Allocation for this payment. Passed only to a reader holding
   * finance.allocate_correct; reverse_payment_allocation() asks again.
   */
  onCorrectAllocation?: () => void
  /** May correct or reverse a recorded payment — the finance.manage authority. */
  mayCorrectPayments?: boolean
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
  /** This payment's live allocations, from the list's one bounded read. */
  allocation: PaymentAllocationSummary
  /** orders.view — module entry, so a target is a door rather than a dead link. */
  canOpenLinkedRecord: boolean
  onOpenLinked: (href: string) => void
}) {
  // CORRECTED. This used to say every row on this page is approved_linked or
  // approved_unlinked, "scoped to exactly those two statuses". It is not:
  // CLASSIFIED_PAYMENT_STATUSES also loads pending_approval and
  // needs_clarification, and an allocated one of those is exactly the row a PI
  // deletion blocker sends an operator here to deal with. Believing otherwise is
  // what left this page with no Delete control for years.
  //
  // The check itself was always right and is unchanged — it is false for an
  // unapproved row, so the linkage controls correctly do not render for one.
  // Only the claim about what reaches this page was wrong.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  const noteRequiredForCorrection = newStatus === 'needs_clarification' || newStatus === 'rejected'
  const statusChanged = newStatus !== r.status
  const canCorrect = statusChanged && (!noteRequiredForCorrection || correctionNote.trim())

  const handleCorrect = async () => {
    if (!canCorrect || !supabase || !onCorrected) return
    setCorrecting(true)
    setCorrectionError(null)
    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        status:     newStatus,
        admin_note: correctionNote.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setCorrecting(false)
    if (dbError) { setCorrectionError(friendlyDbErrorMessage(dbError)); return }
    onCorrected()
  }

  // WHICH RECORD THIS MONEY IS FOR, from the allocation ledger. Read here only
  // for the status badge's live label — the destination is SHOWN by the
  // Allocation list, which names every target rather than the first one.
  const destination = usePaymentDestination(supabase, r.id)

  // WHO PAID AND WHEN, on one line under the Payment ID. This replaces
  // "Submitted by … · <created_at>", which named the wrong person (whoever
  // typed the entry) and the wrong date (when it was typed, not when the money
  // arrived) in the one place a reader looks first. Submission is in Activity.
  const headerLine = `${customerDisplayName(r.client_name)} · Received ${fmtDate(r.payment_date)}`

  // NAMES FOR THE ACTIVITY TRAIL'S ALLOCATION EVENTS, out of records this modal
  // already holds. The audit rows carry target uuids and no display number, so
  // without this they read "a Confirmed Order" — true, and never a uuid. NO
  // QUERY is issued for this: an id that is not in hand simply stays unnamed.
  const resolveActivityTarget = useMemo<ActivityTargetResolver>(() => {
    const named = new Map<string, string>()
    for (const t of allocation.targets) {
      if (t.label) named.set(`${t.kind}:${t.targetId}`, t.label)
    }
    if (destination?.orderId && destination.orderNumber) {
      named.set(`order:${destination.orderId}`, destination.orderNumber)
    }
    if (destination?.submissionId && destination.reference) {
      named.set(`submission:${destination.submissionId}`, destination.reference)
    }
    return (kind, id) => named.get(`${kind}:${id}`) ?? null
  }, [allocation, destination])

  const paymentModeText = PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode
  // THE ACCOUNT, and only when it says something the mode has not. Since the
  // four modes became bank names, a payment recorded as HDFC into the HDFC
  // account printed "HDFC" twice under two labels. A genuinely different
  // account — and a legacy row whose mode is "Cash" or "UPI" — still shows it.
  const receivedInText = r.received_in ? receivedInLabel(r.received_in) : null
  const showReceivedIn = receivedInText !== null && receivedInText !== paymentModeText

  const left = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionHeader>Payment Details</SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
          <DetailRow label="Client">
            <CustomerName name={r.client_name} truncate={false} />
          </DetailRow>
          <DetailRow label="Payment Mode">{paymentModeText}</DetailRow>
          {showReceivedIn && <DetailRow label="Received In">{receivedInText}</DetailRow>}
          <DetailRow label="Received">{fmtDate(r.payment_date)}</DetailRow>
          {/* CONDITIONAL, all three. An approval that has not happened, an
              account that was never stated and a reference that was never given
              are absences — and an absence does not need a row of its own
              saying so. Activity still records the approval when it comes. */}
          {r.approved_by_name && <DetailRow label="Approved By">{r.approved_by_name}</DetailRow>}
          {r.proof_note && <DetailRow label="Reference">{r.proof_note}</DetailRow>}
        </div>
      </div>

      {/* WHO PHYSICALLY CARRIED IT. Shown for PNB and Paytm, and for any payment
          that already has a trail — including one recorded before the trail
          existed, whose five legacy columns are projected into the same shape.
          Draws nothing at all for a payment neither clause applies to.

          FINANCE MAY STILL ADD TO IT, verified or not: a custody event is a
          statement about who carried cash, not about how much money arrived, so
          the post-approval freeze that protects the FIGURES has nothing to say
          about it. append_payment_custody_events decides that server-side. */}
      {supabase && (
        <PaymentCustodyTrail
          supabase={supabase}
          payment={r}
          canAppend={mayCorrectPayments}
          formatDateTime={fmtDateTime}
        />
      )}
    </div>
  )

  const right = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* ── Where this money went ──
          The payment is ONE record; this lists the claims against it without
          restating the payment itself. A payment split across two Orders appears
          here as two allocations of one sum — never as two payments, which is
          exactly the duplication the allocation table exists to avoid. */}
      <SectionHeader>Allocation</SectionHeader>
      <AllocationPanel
        summary={allocation}
        amount={r.amount}
        canOpenLinkedRecord={canOpenLinkedRecord}
        onOpen={onOpenLinked}
      />
      {/* CORRECT ALLOCATION — for an allocation that names the wrong record.
          Offered only when there is an active allocation this reader can see;
          the correction screen reads the allocations again for itself. */}
      {onCorrectAllocation && allocation.targets.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCorrectAllocation}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '6px 12px', fontSize: '12.5px' }}
          >
            {CORRECT_ALLOCATION_ACTION_LABEL}
          </button>
        </div>
      )}
    </div>
  )

  const bottom = (
    <>
      {/* PAYMENT PROOF — heading and all, or nothing. The heading travels INTO
          PaymentProofView because only it knows whether an attachment exists;
          drawing "Payment Proof" over a row reading "Not attached" is the
          empty state this replaces. */}
      {supabase && (
        <PaymentProofView
          supabase={supabase}
          paymentRequestId={r.id}
          inline
          heading={<div style={DIVIDED_SECTION}><SectionHeader>Payment Proof</SectionHeader></div>}
        />
      )}

      {/* THE NOTE, when there is one. proof_note (the reference) is a different
          column with a different meaning and is shown under Payment Details;
          this is the note to Finance. */}
      {r.sales_note && (
        <div style={DIVIDED_SECTION}>
          <SectionHeader>Note</SectionHeader>
          <div style={{
            fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55,
            marginTop: '8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {r.sales_note}
          </div>
        </div>
      )}

      {/* ACTIVITY — the audit trail, unchanged in content and re-worded for a
          reader. Every row keeps its actor and its timestamp; only the sentence
          describing the event is this module's, and it is one shared function
          so the two Finance surfaces cannot disagree. */}
      {supabase && (
        <PaymentRequestActivity
          supabase={supabase}
          paymentRequestId={r.id}
          resolveTarget={resolveActivityTarget}
          heading={<div style={DIVIDED_SECTION}><SectionHeader>Activity</SectionHeader></div>}
        />
      )}

      {/* Admin controls — never renders on this page in practice (every row
          here is approved_unlinked/approved_linked), kept for parity with the
          Payment Requests page's guard structure. */}
      {mayCorrectPayments && supabase && onCorrected && !isLinkageStatus && (
        <div style={{ ...DIVIDED_SECTION, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <SectionHeader>Admin controls</SectionHeader>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
              Administrative correction. This action will be recorded in activity history.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <select
              className="boe-input"
              aria-label="Correct status"
              value={newStatus}
              onChange={e => { setNewStatus(e.target.value); setCorrectionNote(''); setCorrectionError(null) }}
              style={{ fontSize: '13px', maxWidth: '260px' }}
            >
              {STATUS_CORRECTION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!statusChanged && (
              <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
                Select a different status to make a correction.
              </div>
            )}
            {statusChanged && noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label={newStatus === 'needs_clarification' ? 'Clarification note' : 'Rejection reason'}
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder={newStatus === 'needs_clarification' ? 'Clarification note (required)' : 'Rejection reason (required)'}
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {statusChanged && !noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label="Admin note"
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder="Admin note (optional)"
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {correctionError && <ErrorBanner message={correctionError} />}
            {statusChanged && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={handleCorrect}
                  disabled={!canCorrect || correcting}
                  className="boe-btn boe-btn-primary"
                  style={{ padding: '7px 16px', fontSize: '13px' }}
                >
                  {correcting ? 'Saving…' : 'Save Correction'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {mayCorrectPayments && isLinkageStatus && (
        <div style={{ ...DIVIDED_SECTION, fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          Funds are attached to a PI Draft or an Order with Allocate Funds, not here.
        </div>
      )}
    </>
  )

  return (
    <RequestModalShell
      requestNumber={r.human_payment_id}
      submittedLine={headerLine}
      /* THE AMOUNT IS THE LOUDEST THING ON THE SCREEN, and it sits in the
         header beside the state of the money rather than in a card below it —
         "how much" is the first of the eight questions. */
      statusBadge={
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '5px' }}>
          <span style={{
            fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 700, color: colors.primary,
            lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {fmtAmount(r.amount)}
          </span>
          <StatusBadge status={r.status} destination={destination} />
        </div>
      }
      onClose={onClose}
      left={left}
      right={right}
      bottom={bottom}
    />
  )
}
