'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import { useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, ChevronDown, ChevronUp, CircleCheck, CircleX, Info, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import { REVIEW_STALE_MESSAGE, sendBackOrReject } from '@/lib/finance/reviewDecision'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { canDeletePayment } from '@/lib/finance/paymentDeletion'
import { canDeleteOwnPaymentRequest } from '@/lib/finance/ownPaymentRequestDeletion'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { notifyFinance, notifyOrderUpdate } from '@/lib/notify'
import type { MergeResult } from '@/lib/finance/paymentDuplicates'
import { RequestModalShell } from '@/app/finance/components/FinanceModalShell'
import { BankWindowBar } from './bankWindowBar'
import { canVerifyPayment, isOwnPaymentDecision } from './paymentRouting'
import { isBankAccountMode } from '@/lib/finance/bankMarks'
import { PaymentCustodyTrail, usePaymentDestination } from './components/PaymentDestinationBlock'
import { PaymentFactsCard, ProofNotesCard } from './components/PaymentPopupParts'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { paymentAgainstDisplay } from '@/lib/finance/paymentDestination'
import {
  DECISION_NOTE_NEEDED,
  OWN_PAYMENT_NOTE,
  decisionButtonLabel,
  decisionConsequence,
  decisionFieldLabel,
  firstName,
} from '@/lib/finance/paymentPopupWords'
import { STATUS_META, fmtDate, fmtDateTime, fmtAmount, friendlyDbErrorMessage, isApproved, APPROVED_LOCK_NOTE, canManageRequest, type AdminAction, type PaymentRequest } from './paymentRequestsModel'
import { ErrorBanner, SectionHeader, StatusBadge, STATUS_CORRECTION_OPTIONS } from './paymentRequestsAtoms'

// ── THE ONE PAYMENT POPUP ───────────────────────────────────────────────────
//
// Clicking anywhere on a Payment Requests row opens THIS, for every reader and
// every status. It used to be two popups: this one (from the View icon) and a
// separate review window (from the row) that held the decision. The decision now
// lives here, as a Decision section, so nothing a verifier could do in the old
// window needs a second popup.

const DECISIONS: { key: AdminAction; label: string; hint: string; Icon: LucideIcon; tint: string; color: string }[] = [
  { key: 'approve',             label: 'Verify Payment',      hint: 'Confirm Finance has checked this payment', Icon: CircleCheck,            color: colors.green, tint: colors.greenTint },
  { key: 'needs_clarification', label: 'Needs Clarification', hint: 'Send back with a question',                Icon: MessageCircleQuestion, color: colors.blue,  tint: colors.blueTint },
  { key: 'reject',              label: 'Reject',              hint: 'Decline this payment request',             Icon: CircleX,               color: colors.red,   tint: colors.redTint },
]

/**
 * Tells the recorder, and the people on the Order, that a payment was verified.
 * The same notices wherever it was verified from.
 */
export function announcePaymentVerified(r: PaymentRequest) {
  void notifyFinance(
    r.payment_against === 'new_order'
      ? { event: 'finance_approved_suspense', requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name }
      : { event: 'finance_approved_linked',   requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name, orderNumber: r.order_number },
  )
  // AND THE PEOPLE ON THE ORDER, when the money landed on one: a verified
  // payment is the event that unblocks their next step. The route reads the
  // payment_verified row the database's own echo trigger just wrote, so the
  // figure in the sentence is the ALLOCATED amount, not one computed here.
  if (r.order_id) void notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })
}

/**
 * Tells the person who sent a request that it was already recorded and merged (nothing for them
 * to do), and the people on the Order when the money now sits on one. For information only; a
 * failed notice never undoes the merge.
 */
export function announcePaymentMerged(r: MergeResult) {
  void notifyFinance({
    event: 'finance_merged',
    requestNumber: r.requestHumanId ?? r.requestNumber ?? '',
    entityId: r.intoPaymentId,
    creatorId: r.submittedBy,
    clientName: r.clientName,
    mergedInto: r.intoHumanId,
  })
  if (r.orderId) void notifyOrderUpdate({ orderId: r.orderId, event: 'payment' })
}

// ── Details modal (read-only for creators; includes status correction for admin) ──

export function DetailsModal({
  request: r,
  onClose,
  isAdmin,
  mayCorrectPayments,
  mayApprovePayments,
  mayDecideOwnPayments,
  userId,
  supabase,
  onCorrected,
  onEdit,
  onDelete,
  bankPanel,
  adminNotePanel,
}: {
  request: PaymentRequest
  onClose: () => void
  /**
   * Still used for the OWNERSHIP rules and for the creator-facing copy
   * ("Reapply" vs "Edit"), which are about who submitted a request, not about
   * who may correct one.
   */
  isAdmin?: boolean
  /**
   * May correct or reverse a recorded payment — the finance.manage authority.
   * Separate from isAdmin because an employee can now hold it without being an
   * admin, and an admin holds it through the capability helper's short-circuit.
   */
  mayCorrectPayments?: boolean
  /**
   * May VERIFY a pending payment — the finance.approve authority, and a
   * different one from mayCorrectPayments. Correcting rewrites a record that has
   * already been decided; verifying is the decision.
   *
   * This modal previously had no verification control at all, which meant an
   * admin who opened a pending payment through the row's View button — the
   * obvious action in the row — could send it back or reject it but could not
   * confirm it. The only route to verification was clicking the row itself, and
   * its only affordance was a small "Review" chip. See the panel below.
   */
  mayApprovePayments?: boolean
  /**
   * May decide a payment this viewer recorded themselves — the protected
   * finance.verify_own_payment authority (Control Center), which an admin holds
   * through the admin branch. See FinanceCapabilities.canDecideOwnPayment.
   */
  mayDecideOwnPayments?: boolean
  userId?: string
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
  onEdit?: (r: PaymentRequest) => void
  onDelete?: (r: PaymentRequest) => void
  /**
   * The bank-statement panel (BankMatchPanel), passed ready-made and ONLY for a
   * holder of finance.reconcile. This modal does not know what it contains and
   * decides nothing with it.
   */
  bankPanel?: React.ReactNode
  /**
   * The admin's private note box, passed ready-made and ONLY to an admin (the page
   * decides; the database refuses everybody else). Not the Finance decision note
   * above, which the salesperson reads. This modal does not know what it contains.
   */
  adminNotePanel?: React.ReactNode
}) {
  // Order-linkage states are out of this control's jurisdiction entirely —
  // neither entering nor leaving approved_unlinked/approved_linked may happen
  // here, since either direction would move status without the RPCs' row
  // locking, eligibility checks, and order_id/order_number bookkeeping.
  const isLinkageStatus = isApproved(r.status)

  // Same rule the table's action buttons use, so the two surfaces can never
  // disagree about whether a request is still manageable from this page.
  const canManage = canManageRequest(r, !!isAdmin, userId ?? '')
  // DELETE IS A SEPARATE, NARROWER RULE (20261011000000 §3a): admin-only, for
  // any status. Self-delete by the submitter of an unapproved request — which
  // canManage still grants for Edit/Reapply — is withdrawn for Delete alone.
  const canDelete = canDeletePayment(r, { isAdmin: !!isAdmin })
    // ...and the submitter may remove their own never-approved request (a soft
    // delete, confirmed in its own dialog; the database has the final say).
    || canDeleteOwnPaymentRequest(r, userId)

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  // A status correction is rare, so its form opens on demand.
  const [showCorrect, setShowCorrect] = useState(false)

  // ── Verification ──
  // Only a PENDING payment can be verified, and only by somebody holding the
  // approval authority. Both are re-derived inside
  // approve_finance_payment_request under a row lock on every call, so this
  // decides whether a control is DRAWN and never whether it is allowed.
  // Never on a payment this viewer recorded themselves, unless they may verify
  // their own payments — the database refuses that decision, so it is not offered.
  const canVerify = canVerifyPayment(r.status, mayApprovePayments)
    && !isOwnPaymentDecision(r.submitted_by, userId, mayDecideOwnPayments)
  // The one case the Decision card is withheld from somebody who could otherwise
  // decide: they recorded this payment. Say so, rather than let it just vanish.
  const ownPaymentBlocked = canVerifyPayment(r.status, mayApprovePayments)
    && isOwnPaymentDecision(r.submitted_by, userId, mayDecideOwnPayments)
  // AN HDFC PAYMENT IS VERIFIED AGAINST THE BANK (20270516000000): its Verify is on
  // the bank match in this window, so this list offers only the other two decisions.
  const verifiedAtTheBank = isBankAccountMode(r.payment_mode)
  const decisions = verifiedAtTheBank ? DECISIONS.filter(d => d.key !== 'approve') : DECISIONS
  // A PENDING HDFC PAYMENT, FOR SOMEBODY WHO MAY DECIDE IT, HAS ONE JOB: is this the
  // same money? The comparison is the whole window, every fact appears once, and what
  // is left of the record waits behind Details.
  const bankWindow = canVerify && verifiedAtTheBank && !!bankPanel && !!supabase && !!onCorrected
  const [showDetails, setShowDetails] = useState(false)
  const [decisionAction, setDecisionAction] = useState<AdminAction | null>(null)
  const [decisionNote,   setDecisionNote]   = useState('')
  const [deciding,       setDeciding]       = useState(false)
  const [decisionError,  setDecisionError]  = useState<string | null>(null)
  // A decision is not idempotent from the caller's side — a second click would
  // race the first — so the guard is a ref set BEFORE the await, not a state
  // update that only lands on the next render.
  const decidingRef = useRef(false)
  const decisionNoteRequired = decisionAction === 'needs_clarification' || decisionAction === 'reject'
  const canConfirmDecision = decisionAction !== null && (!decisionNoteRequired || decisionNote.trim() !== '')

  const handleDecide = async () => {
    if (!canVerify || !supabase || !onCorrected || !decisionAction || !canConfirmDecision) return
    if (decidingRef.current) return
    decidingRef.current = true
    setDeciding(true)
    setDecisionError(null)

    if (decisionAction === 'approve') {
      // THE EXISTING BACKEND, UNCHANGED. approve_finance_payment_request
      // (20260690000000, re-gated onto finance.approve by 20260901000000) already
      // handles every route: a new_order payment — which is what a PI-recorded
      // payment is — lands in approved_unlinked with order_id left null, and an
      // existing_order payment links straight to the order it already carries.
      const { error: rpcError } = await supabase.rpc('approve_finance_payment_request', {
        p_request_id: r.id,
        p_admin_note: decisionNote.trim() || null,
      })
      if (rpcError) {
        decidingRef.current = false
        setDeciding(false)
        setDecisionError(friendlyDbErrorMessage(rpcError))
        return
      }
      announcePaymentVerified(r)
      // The ref is deliberately NOT reset: the modal is going away, and leaving
      // it armed makes a late second click a no-op rather than a second call.
      onCorrected()
      return
    }

    // THROUGH THE DOORS, NOT A TABLE WRITE (PR #172): request_finance_payment_
    // clarification and reject_finance_payment_request lock the row, re-check the
    // verifier, act only while it is pending, and say when somebody else decided
    // first.
    const outcome = await sendBackOrReject(supabase, { requestId: r.id, action: decisionAction, note: decisionNote })
    if (outcome.kind === 'refused') {
      decidingRef.current = false
      setDeciding(false)
      setDecisionError(outcome.message)
      return
    }
    // STALE IS NOT SUCCESS: nothing changed, so nobody is told it did.
    if (outcome.kind === 'stale') {
      decidingRef.current = false
      setDeciding(false)
      setDecisionError(REVIEW_STALE_MESSAGE)
      return
    }
    void notifyFinance({
      event: decisionAction === 'needs_clarification' ? 'finance_clarification' : 'finance_rejected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
    })
    // A REJECTION MOVES THE ORDER'S MONEY TOO: the people carrying that Order
    // have to deal with the shortfall. Clarification is not announced: nothing
    // has been decided yet.
    if (decisionAction !== 'needs_clarification' && r.order_id) void notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })
    onCorrected()
  }

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

    // The status genuinely changed (canCorrect requires it) — tell the creator.
    void notifyFinance({
      event: 'finance_status_corrected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
      statusLabel: STATUS_META[newStatus]?.label ?? newStatus,
    })

    onCorrected()
  }

  // Finance's reason, question or note, when a stored admin_note exists, tinted
  // with the request's own status colours. It is a BANNER across the top of the
  // popup: for a salesperson whose payment was sent back or rejected it is the
  // first thing to read, and it used to sit in the middle of a column. The
  // activity entry that carries the same words keeps its actor and time but not
  // the text again (hideNote on the activity below).
  const decision = r.admin_note
    ? (() => {
        const m = STATUS_META[r.status] ?? { bg: '#F1EEE9', color: '#4C5352', border: '#E4DED7' }
        const title =
          r.status === 'rejected'            ? 'Rejection reason' :
          r.status === 'needs_clarification' ? 'Clarification required' :
          (isLinkageStatus)                  ? 'Approval note' :
                                               'Admin note'
        const Icon: LucideIcon =
          r.status === 'rejected'            ? CircleX :
          r.status === 'needs_clarification' ? MessageCircleQuestion :
          (isLinkageStatus)                  ? CircleCheck :
                                               Info
        return { title, Icon, bg: m.bg, border: m.border, color: m.color, note: r.admin_note }
      })()
    : null
  const banner = decision && !bankWindow ? (
    <div role="note" style={{
      display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px', borderRadius: '10px',
      background: decision.bg, border: `1px solid ${decision.border}`, color: decision.color,
    }}>
      <decision.Icon size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px' }}>
          {decision.title}
        </div>
        <div style={{ fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {decision.note}
        </div>
      </div>
    </div>
  ) : null

  // ── WHAT THIS PAYMENT IS FOR, from the ledger and the intent ──
  //
  // This popup used to read order_number, then order_request_number, then
  // payment_target_type — and printed a plain "New Order" whenever all three
  // were empty, which is every request the current form writes. Every one of
  // those columns became provenance at 20261012000000. It reads
  // finance_payment_destinations now: the pending INTENT before Finance
  // approves, the ACTIVE ALLOCATIONS afterwards. It is stated ONCE, in the
  // "Paid for" row (PaymentFactsCard).
  const destination  = usePaymentDestination(supabase, r.id)
  const againstLine  = paymentAgainstDisplay(destination)

  // The bank window's header still names who sent the payment; every other
  // header carries the client and the paid date instead, and who sent it is in
  // Activity, where it is stated once, with the time.
  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`
  const headerLine = (
    <>
      <span style={{ fontWeight: 600, color: colors.secondary }}>{customerDisplayName(r.client_name, { distinctAllocationCustomers: destination?.customerCount ?? 0 })}</span>
      {' · Paid '}{fmtDate(r.payment_date)}
    </>
  )
  // Who the decision is sent to, by first name, in the sentences that say so.
  const sender = firstName(r.submitted_by_name)

  // PROOF / REFERENCE / NOTES — the attachment, the reference and the notes, in
  // ONE card. They are three parts of the same question ("what backs this
  // payment up?"). The database keeps them in separate columns because they mean
  // separate things; this is a grouping, not a merge. On a payment still waiting
  // for Finance a missing proof is drawn in amber: the verifier needs to see it.
  const proofBlock = (
    <ProofNotesCard
      proof={supabase
        ? <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline emptyLabel="No payment proof attached" emptyWarn={r.status === 'pending_approval' || r.status === 'needs_clarification'} />
        : <span style={{ fontSize: '13px', color: colors.muted }}>No payment proof attached</span>}
      reference={r.proof_note}
      notes={r.sales_note}
    />
  )
  const custodyBlock = supabase && (
    <PaymentCustodyTrail
      supabase={supabase}
      payment={r}
      canAppend={mayApprovePayments || mayCorrectPayments || r.submitted_by === userId}
      formatDateTime={fmtDateTime}
      onAppended={onCorrected}
    />
  )
  const activityBlock = supabase && (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
      <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} hideNote={banner ? r.admin_note : null} />
    </div>
  )

  // LEFT: what the payment is, and what backs it up. RIGHT: what to do about it,
  // then what happened. On a phone the right column stacks under the left, so a
  // verifier reads the facts, the proof and the cash trail before the Decision.
  const left = (
    <>
      {/* A. WHAT IT IS FOR AND WHERE IT LANDED — each stated once */}
      <PaymentFactsCard destination={destination} paymentMode={r.payment_mode} receivedIn={r.received_in} />

      {/* B. PAYMENT PROOF / REFERENCE / NOTES */}
      {proofBlock}

      {/* C. WHO PHYSICALLY CARRIED IT. Shown for PNB and Paytm, and for any
          payment that already has a trail — a request corrected onto a bank
          account keeps its history visible, because the money really did pass
          through somebody's hands.

          THE SUBMITTER MAY STILL ADD TO IT while the request is unapproved,
          which is what makes "collect today, hand over tomorrow" work. That is a
          DRAWING rule: append_payment_custody_events re-derives the authority
          itself and refuses anyone else. */}
      {custodyBlock}

      {/* G. BANK STATEMENT — only for a holder of finance.reconcile (the page
          decides). Information for the verifier; linking never verifies. */}
      {!bankWindow && bankPanel}
    </>
  )

  const decisionBlock = canVerify && supabase && onCorrected ? (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <SectionHeader>Decision</SectionHeader>
          {verifiedAtTheBank && (
            <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
              An HDFC payment is verified against its bank credit, which needs access to Bank Statements.
            </div>
          )}
          <div role="radiogroup" aria-label="Decision" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {decisions.map(d => {
              const on = decisionAction === d.key
              return (
                <button
                  key={d.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => { setDecisionAction(d.key); setDecisionError(null) }}
                  disabled={deciding}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left', width: '100%',
                    padding: '10px 12px', borderRadius: '10px', cursor: 'pointer', minHeight: '56px',
                    border: `1px solid ${on ? d.color : colors.border}`, background: on ? d.tint : '#FFFFFF',
                  }}
                >
                  <d.Icon size={18} color={d.color} aria-hidden="true" />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: colors.primary }}>{d.label}</span>
                    <span style={{ display: 'block', fontSize: '12px', color: colors.muted }}>{d.hint}</span>
                  </span>
                  <span aria-hidden="true" style={{
                    width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${on ? d.color : colors.border}`, background: on ? d.color : 'transparent',
                    boxShadow: on ? 'inset 0 0 0 3px #FFFFFF' : 'none',
                  }} />
                </button>
              )
            })}
          </div>

          {/* CHOOSING ONE OPENS ITS NOTE, ITS ONE-LINE CONSEQUENCE AND A BUTTON NAMED
              FOR WHAT IT DOES. Nothing is drawn before a choice: no greyed Confirm
              and no "select a decision" sentence. The consequence is read from the
              destination this popup already loaded, so it cannot say "held until an
              order is linked" about a payment that names an Order, a PI Draft or an
              old order. */}
          {decisionAction && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <label htmlFor="decision-note" style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {decisionFieldLabel(decisionAction, sender)}
                </label>
                <textarea
                  id="decision-note"
                  className="boe-input"
                  autoFocus
                  value={decisionNote}
                  onChange={e => setDecisionNote(e.target.value)}
                  rows={2}
                  style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
                />
                {decisionNoteRequired && (
                  <div style={{ fontSize: '12.5px', minHeight: '18px', color: decisionNote.trim() === '' ? colors.red : colors.muted }}>
                    {decisionNote.trim() === '' ? DECISION_NOTE_NEEDED : ' '}
                  </div>
                )}
              </div>
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', lineHeight: 1.5,
                color: colors.secondary, background: colors.raised, border: `1px solid ${colors.border}`,
                borderRadius: '8px', padding: '9px 11px',
              }}>
                <Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{decisionConsequence(decisionAction, destination, sender)}</span>
              </div>
            </div>
          )}
          {decisionError && <ErrorBanner message={decisionError} />}
          {decisionAction && (
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={() => { setDecisionAction(null); setDecisionNote(''); setDecisionError(null) }}
                disabled={deciding}
                className="boe-btn boe-btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={handleDecide}
                disabled={!canConfirmDecision || deciding}
                className={`boe-btn ${decisionAction === 'reject' ? 'boe-btn-danger-solid' : 'boe-btn-primary'}`}
              >
                {decisionButtonLabel(decisionAction, sender, deciding)}
              </button>
            </div>
          )}
        </div>
  ) : null

  const right = (
    <>
      {/* E. DECISION — verify, send back, or reject. One section, three outcomes,
          each through its own protected door (see handleDecide). Drawn only for
          somebody holding finance.approve, on a pending payment they did not
          record themselves (unless they may decide their own). A DRAWING rule:
          every call re-derives the actor, the permission and the row's status
          under a row lock. Moving a row into the approved statuses is never an
          option in a status <select>: a protected action gets its own door.
          It comes FIRST: deciding is what a verifier opened this for, and the
          history is reference. */}
      {!bankWindow && decisionBlock}

      {/* A verifier who recorded this payment is not offered the decision; the
          database would refuse it. Say why, instead of a card that is missing. */}
      {ownPaymentBlocked && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', lineHeight: 1.5,
          color: colors.secondary, background: colors.raised, border: `1px solid ${colors.border}`,
          borderRadius: '8px', padding: '10px 12px',
        }}>
          <Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>{OWN_PAYMENT_NOTE}</span>
        </div>
      )}

      {/* F. Correct status — a rare administrative tool, so it opens on demand.
          Never for approved_unlinked/approved_linked rows; those are managed only
          via Verify Payment and Allocate Funds. */}
      {mayCorrectPayments && supabase && onCorrected && !isLinkageStatus && !canVerify && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <button
            type="button"
            onClick={() => setShowCorrect(open => !open)}
            aria-expanded={showCorrect}
            aria-controls="status-correction"
            style={{
              display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
              background: 'none', border: 0, padding: 0, cursor: 'pointer', minHeight: '32px', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Correct status</span>
            {showCorrect
              ? <ChevronUp size={16} aria-hidden="true" color={colors.muted} />
              : <ChevronDown size={16} aria-hidden="true" color={colors.muted} />}
          </button>
          {showCorrect && (
          <div id="status-correction" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
              Administrative correction. This action will be recorded in activity history.
            </div>
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
          )}
        </div>
      )}
      {/* Approved requests are view-only on this page for every role. The note
          says where the record now lives, and the link takes you there; the
          admin-only linkage sentence is kept alongside it. */}
      {isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '8px',
          fontSize: '13px', color: colors.secondary, lineHeight: 1.5,
        }}>
          <span>
            {APPROVED_LOCK_NOTE}
            {isAdmin && ' Funds are attached to a PI Draft or an Order there, with Allocate Funds.'}
          </span>
          <Link
            href={`/finance/received?payment=${r.id}`}
            className="boe-btn boe-btn-text"
            style={{ alignSelf: 'flex-start' }}
          >
            Open in Confirmed Payments <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
      )}

      {/* H. ACTIVITY — below the decision. The timeline keeps its own heading,
          query, ordering and event text. */}
      {activityBlock}

      {/* H2. THE ADMIN'S PRIVATE NOTE — admins only (the page decides). It sits
          under the history, so on a phone the verifier reaches the Decision first. */}
      {adminNotePanel}
    </>
  )

  // Actions live in the shell's pinned footer so they stay reachable while the
  // body scrolls. Delete and Edit/Reapply are gated SEPARATELY — canDelete
  // (admin-only) and canManage (edit/reapply) — so the footer renders whenever
  // either offers something, not only when both do. Delete sits at the far left,
  // away from the main action: a destructive button beside Edit is one slip on a phone.
  const footer = ((canManage && onEdit) || (canDelete && onDelete)) ? (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {onDelete && canDelete && (
        <button
          onClick={() => onDelete(r)}
          className="boe-btn boe-btn-danger"
          style={{ marginRight: 'auto' }}
        >
          Delete
        </button>
      )}
      {onEdit && canManage && (
        <button onClick={() => onEdit(r)} className="boe-btn boe-btn-primary">
          {!isAdmin && r.status === 'rejected' ? 'Reapply' : 'Edit'}
        </button>
      )}
    </div>
  ) : undefined

  const bankFooter = bankWindow ? (
    <BankWindowBar
      details={showDetails}
      action={decisionAction === 'approve' ? null : decisionAction}
      note={decisionNote}
      sending={deciding}
      error={decisionError}
      manage={footer}
      onToggleDetails={() => setShowDetails(!showDetails)}
      onAsk={a => { setDecisionAction(a); setDecisionNote(''); setDecisionError(null) }}
      onNote={setDecisionNote}
      onCancel={() => { setDecisionAction(null); setDecisionNote(''); setDecisionError(null) }}
      onSend={handleDecide}
    />
  ) : undefined

  return (
    <RequestModalShell
      requestNumber={r.human_payment_id}
      submittedLine={bankWindow ? (
        <>
          <span className="bank-window-amount">{fmtAmount(r.amount)} <span>· {customerDisplayName(r.client_name)}</span></span>
          {againstLine} · {submittedLine}
        </>
      ) : headerLine}
      /* THE AMOUNT IS THE LOUDEST THING ON THE SCREEN, beside the state of the
         money: "how much" is the first question. The bank window carries it in
         its own header line, so there it is only the badge. */
      statusBadge={bankWindow ? <StatusBadge status={r.status} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '5px' }}>
          <span style={{
            fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 700, color: colors.primary,
            lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {fmtAmount(r.amount)}
          </span>
          <StatusBadge status={r.status} />
        </div>
      )}
      onClose={onClose}
      top={banner}
      left={bankWindow ? <>{proofBlock}{custodyBlock}{adminNotePanel}</> : left}
      right={bankWindow ? activityBlock : right}
      body={bankWindow && !showDetails ? bankPanel : undefined}
      width={bankWindow ? '1040px' : undefined}
      footer={bankWindow ? bankFooter : footer}
    />
  )
}
