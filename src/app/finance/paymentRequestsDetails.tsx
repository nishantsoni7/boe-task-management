'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import { useRef, useState } from 'react'
import { CircleCheck, CircleX, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import { REVIEW_STALE_MESSAGE, sendBackOrReject } from '@/lib/finance/reviewDecision'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { canDeletePayment } from '@/lib/finance/paymentDeletion'
import { canDeleteOwnPaymentRequest } from '@/lib/finance/ownPaymentRequestDeletion'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { notifyFinance, notifyOrderUpdate } from '@/lib/notify'
import { RequestModalShell } from '@/app/finance/components/FinanceModalShell'
import { BankWindowBar } from './bankWindowBar'
import { canVerifyPayment, isOwnPaymentDecision } from './paymentRouting'
import { isBankAccountMode } from '@/lib/finance/bankMarks'
import { PaymentCustodyTrail, PaymentDestinationSummary, usePaymentDestination } from './components/PaymentDestinationBlock'
import { PaymentModeHint } from './components/PaymentModeHint'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { paymentAgainstDisplay } from '@/lib/finance/paymentDestination'
import { STATUS_META, fmtDate, fmtDateTime, fmtAmount, orderNoCell, friendlyDbErrorMessage, isApproved, APPROVED_LOCK_NOTE, canManageRequest, type AdminAction, type PaymentRequest } from './paymentRequestsModel'
import { ErrorBanner, SectionHeader, MetaItem, PaymentDestinationLine, StatusBadge, STATUS_CORRECTION_OPTIONS } from './paymentRequestsAtoms'

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

  // ── Verification ──
  // Only a PENDING payment can be verified, and only by somebody holding the
  // approval authority. Both are re-derived inside
  // approve_finance_payment_request under a row lock on every call, so this
  // decides whether a control is DRAWN and never whether it is allowed.
  // Never on a payment this viewer recorded themselves, unless they may verify
  // their own payments — the database refuses that decision, so it is not offered.
  const canVerify = canVerifyPayment(r.status, mayApprovePayments)
    && !isOwnPaymentDecision(r.submitted_by, userId, mayDecideOwnPayments)
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

  // Status-specific decision/clarification block. Shown only when a stored
  // admin_note exists; tinted with the request's own status colours.
  const decision = r.admin_note
    ? (() => {
        const m = STATUS_META[r.status] ?? { bg: '#F1EEE9', color: '#4C5352', border: '#E4DED7' }
        const title =
          r.status === 'rejected'            ? 'Rejection reason' :
          r.status === 'needs_clarification' ? 'Clarification required' :
          (isLinkageStatus)                  ? 'Approval note' :
                                               'Admin note'
        return { title, bg: m.bg, border: m.border, color: m.color, note: r.admin_note }
      })()
    : null

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  // ── WHAT THIS PAYMENT IS FOR, from the ledger and the intent ──
  //
  // This popup used to read order_number, then order_request_number, then
  // payment_target_type — and printed a plain "New Order" whenever all three
  // were empty, which is every request the current form writes. Every one of
  // those columns became provenance at 20261012000000. It reads
  // finance_payment_destinations now: the pending INTENT before Finance
  // approves, the ACTIVE ALLOCATIONS afterwards.
  const destination  = usePaymentDestination(supabase, r.id)
  const againstLine  = paymentAgainstDisplay(destination)
  const orderNoLine  = orderNoCell(destination)

  const proofBlock = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <SectionHeader>Payment Proof / Reference</SectionHeader>
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '104px', flexShrink: 0 }}>Payment proof</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {supabase
              ? <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline emptyLabel="No payment proof attached" />
              : <span style={{ fontSize: '13px', color: colors.muted }}>No payment proof attached</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '104px', flexShrink: 0, paddingTop: '1px' }}>Reference</span>
          <span style={{ fontSize: '13.5px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
            {r.proof_note || 'No reference provided'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '104px', flexShrink: 0, paddingTop: '1px' }}>Notes</span>
          <span style={{ fontSize: '13.5px', color: r.sales_note ? colors.secondary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
            {r.sales_note || 'No notes provided'}
          </span>
        </div>
      </div>
    </div>
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
      <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
    </div>
  )

  const left = (
    <>
      {/* A. Primary summary card — amount + client lead, payment details below */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(r.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {customerDisplayName(r.client_name)}
            </div>
          </div>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px',
          borderTop: `1px solid ${colors.border}`, paddingTop: '14px',
        }}>
          <MetaItem label="Payment Date"    value={fmtDate(r.payment_date)} />
          <MetaItem label="Payment Against" value={againstLine} muted={!destination || destination.kind === 'suspense'} />
          <MetaItem label="Order Number"    value={orderNoLine.value} muted={orderNoLine.muted} />
          {/* ONE destination row, spanning both columns, in place of the
              Payment Mode + Received In pair that was printing the same
              account name twice ("Paytm" over "Paytm"). Spanning is what keeps
              the grid from ending on a lone empty cell. */}
          <div style={{ gridColumn: '1 / -1' }}>
            <PaymentDestinationLine payment_mode={r.payment_mode} received_in={r.received_in} />
            {/* What the account IS, in a line ("Company bank account — primary HDFC
                current account"): the verification window had it, and a verifier
                matching a payment to a statement reads it. */}
            <PaymentModeHint mode={r.payment_mode} />
          </div>
        </div>
      </div>

      {/* B. Decision block — compact status-tinted note, only when one exists */}
      {decision && (
        <div style={{ padding: '12px 14px', borderRadius: '8px', background: decision.bg, border: `1px solid ${decision.border}` }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: decision.color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '5px' }}>
            {decision.title}
          </div>
          <div style={{ fontSize: '13.5px', color: decision.color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {decision.note}
          </div>
        </div>
      )}

      {/* B2. WHAT THIS PAYMENT IS FOR, in full: the kind, the record, and which
          of the two sources answered — a promise (the pending intent) reads
          differently from a fact (the allocations), and a person deciding
          anything about this payment needs to know which they are looking at. */}
      <PaymentDestinationSummary destination={destination} clientName={r.client_name} />

      {/* C. WHO PHYSICALLY CARRIED IT. Shown for PNB and Paytm, and for any
          payment that already has a trail — a request corrected onto a bank
          account keeps its history visible, because the money really did pass
          through somebody's hands.

          THE SUBMITTER MAY STILL ADD TO IT while the request is unapproved,
          which is what makes "collect today, hand over tomorrow" work. That is a
          DRAWING rule: append_payment_custody_events re-derives the authority
          itself and refuses anyone else. */}
      {custodyBlock}

      {/* D. PAYMENT PROOF / REFERENCE — the attachment, the reference and the
          notes, under ONE heading and in one frame. They are three parts of the
          same question ("what backs this payment up?") and they are asked
          together on all three entry forms, so they are answered together here.
          The database keeps them in separate columns because they mean separate
          things; this is a grouping, not a merge. */}
      {proofBlock}

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
          <div role="radiogroup" aria-label="Decision" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                    padding: '10px 12px', borderRadius: '10px', cursor: 'pointer',
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

          {decisionAction === 'approve' && (
            <div style={{
              fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
              background: colors.greenTint, border: '1px solid rgba(39,98,71,0.2)',
              borderRadius: '8px', padding: '10px 12px',
            }}>
              Verify {fmtAmount(r.amount)} from {customerDisplayName(r.client_name)}? It will be verified as received
              {r.payment_against === 'new_order'
                ? ' and held until an order is linked.'
                : ` against ${r.order_number ?? 'the linked order'}.`} This cannot be undone from this page.
            </div>
          )}
          {decisionAction && (
            <textarea
              className="boe-input"
              aria-label={decisionAction === 'approve' ? 'Verification note' : decisionAction === 'reject' ? 'Rejection reason' : 'Clarification note'}
              value={decisionNote}
              onChange={e => setDecisionNote(e.target.value)}
              placeholder={
                decisionAction === 'approve' ? 'Note for the salesperson (optional)'
                : decisionAction === 'reject' ? 'Rejection reason (required)'
                : 'What do you need to know? (required)'
              }
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
            />
          )}
          {decisionError && <ErrorBanner message={decisionError} />}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', alignItems: 'center' }}>
            {!decisionAction && <span style={{ fontSize: '12px', color: colors.muted, marginRight: 'auto' }}>Select a decision to continue.</span>}
            {decisionAction && (
              <button
                onClick={() => { setDecisionAction(null); setDecisionNote(''); setDecisionError(null) }}
                disabled={deciding}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '7px 16px', fontSize: '13px' }}
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleDecide}
              disabled={!canConfirmDecision || deciding}
              className="boe-btn boe-btn-primary"
              style={{ padding: '7px 16px', fontSize: '13px' }}
            >
              {deciding ? (decisionAction === 'approve' ? 'Verifying…' : 'Saving…') : 'Confirm'}
            </button>
          </div>
        </div>
  ) : null

  const right = (
    <>
      {/* E. Activity panel — subtle bordered panel; the timeline keeps its
          own "Activity" heading, query, ordering, and event text. */}
      {activityBlock}

      {/* E2. DECISION — verify, send back, or reject. One section, three outcomes,
          each through its own protected door (see handleDecide). Drawn only for
          somebody holding finance.approve, on a pending payment they did not
          record themselves (unless they may decide their own). A DRAWING rule:
          every call re-derives the actor, the permission and the row's status
          under a row lock. Moving a row into the approved statuses is never an
          option in a status <select>: a protected action gets its own door. */}
      {!bankWindow && decisionBlock}

      {/* F. Admin controls — compact action panel. Never for
          approved_unlinked/approved_linked rows; those are managed only via
          Verify Payment and Allocate Funds. */}
      {mayCorrectPayments && supabase && onCorrected && !isLinkageStatus && !canVerify && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
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
      {/* Approved requests are view-only on this page for every role. The note
          says where the record now lives instead of offering a disabled
          control; the admin-only linkage sentence is kept alongside it. */}
      {isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          fontSize: '12px', color: colors.muted, lineHeight: 1.5,
        }}>
          {APPROVED_LOCK_NOTE}
          {isAdmin && ' Funds are attached to a PI Draft or an Order there, with Allocate Funds.'}
        </div>
      )}
    </>
  )

  // Actions live in the shell's pinned footer so they stay reachable while the
  // body scrolls. Delete and Edit/Reapply are gated SEPARATELY — canDelete
  // (admin-only) and canManage (edit/reapply) — so the footer renders whenever
  // either offers something, not only when both do.
  const footer = ((canManage && onEdit) || (canDelete && onDelete)) ? (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {onDelete && canDelete && (
        <button
          onClick={() => onDelete(r)}
          style={{
            padding: '7px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.red}`, background: colors.redTint, color: colors.red, cursor: 'pointer',
          }}
        >
          Delete
        </button>
      )}
      {onEdit && canManage && (
        <button onClick={() => onEdit(r)} className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
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
      ) : submittedLine}
      statusBadge={<StatusBadge status={r.status} />}
      onClose={onClose}
      left={bankWindow ? <>{proofBlock}{custodyBlock}</> : left}
      right={bankWindow ? activityBlock : right}
      body={bankWindow && !showDetails ? bankPanel : undefined}
      width={bankWindow ? '1040px' : undefined}
      footer={bankWindow ? bankFooter : footer}
    />
  )
}
