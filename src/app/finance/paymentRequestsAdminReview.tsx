'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import React, { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { REVIEW_STALE_MESSAGE, sendBackOrReject } from '@/lib/finance/reviewDecision'
import { notifyFinance, notifyOrderUpdate } from '@/lib/notify'
import { RequestModalShell } from '@/app/finance/components/FinanceModalShell'
import { CircleCheck, CircleX, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import { paymentDestinationLabel } from './paymentDestinations'
import { PaymentModeHint } from './components/PaymentModeHint'
import { PaymentCustodyTrail, usePaymentDestination } from './components/PaymentDestinationBlock'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { paymentAgainstDisplay } from '@/lib/finance/paymentDestination'
import { fmtDate, fmtDateTime, fmtAmount, orderNoCell, friendlyDbErrorMessage, type PaymentRequest, type AdminAction } from './paymentRequestsModel'
import { Field, ErrorBanner, SectionHeader, MetaItem, StatusBadge } from './paymentRequestsAtoms'

// ── Admin Review presentation primitives ─────────────────────────────────────
// The review modal is an approval workspace, not a detail view: an admin reads
// three facts (how much, from whom, when), checks the routing and the proof,
// and commits one of three decisions. These primitives exist so that hierarchy
// is expressed once — a heavy figure band at the top, quiet dense facts in the
// middle, and one deliberate decision control — instead of every block wearing
// the same 12px-radius card and competing for attention.

// Top figure band. One hairline grid: the container paints the divider colour
// and each cell paints over it, so the 1px rules survive the cells wrapping on
// a narrow dialog (a per-cell borderLeft would not).
export function FigureBand({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
      background: colors.border,
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '1px',
    }}>
      {children}
    </div>
  )
}

// One cell of the figure band, in three weights.
//
// `lead` carries the amount at display weight. `strong` sits between that and a
// plain cell, and exists for the payment MODE: an approver's first scan is "how
// much, through which account, on what date", so the account cannot be set in
// the same quiet type as an ordinary field. It is deliberately NOT a badge —
// HDFC is information about the money, not a state the payment is in, and
// tinting it would make it read as a status beside the real one in the header.
export function FigureCell({ label, value, lead, strong, hint }: {
  label: string
  value: string
  lead?: boolean
  strong?: boolean
  /** One muted line under the figure — the payment-mode helper, for a verifier. */
  hint?: React.ReactNode
}) {
  return (
    <div style={{ background: colors.raised, padding: '11px 14px', minWidth: 0 }}>
      <div style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{
        marginTop: lead ? '3px' : '4px',
        fontSize: lead ? '26px' : strong ? '19px' : '15px',
        fontWeight: lead || strong ? 700 : 600,
        color: colors.primary,
        lineHeight: lead ? 1.1 : strong ? 1.25 : 1.35,
        fontVariantNumeric: 'tabular-nums',
        wordBreak: 'break-word',
      }}>
        {value}
      </div>
      {hint}
    </div>
  )
}

// The three review decisions, defined once. Order is deliberate: the outcome an
// admin reaches for most sits first, and the destructive one last. Labels are
// the established workflow wording and are not changed here.
export const REVIEW_DECISIONS: {
  key: AdminAction
  label: string
  hint: string
  color: string
  tint: string
  Icon: LucideIcon
}[] = [
  { key: 'approve',             label: 'Verify Payment',        hint: 'Confirm Finance has checked this payment', color: colors.green, tint: colors.greenTint, Icon: CircleCheck },
  { key: 'needs_clarification', label: 'Needs Clarification',   hint: 'Send back with a question',            color: colors.blue,  tint: colors.blueTint,  Icon: MessageCircleQuestion },
  { key: 'reject',              label: 'Reject',                hint: 'Decline this payment request',         color: colors.red,   tint: colors.redTint,   Icon: CircleX },
]

// One decision as a full-width choice row rather than a chip in a wrapping bar.
// Three chips labelled "Verify Payment" / "Needs Clarification" /
// "Reject" cannot sit on one line in a side column, so they wrapped into an
// uneven cluster that read as three unrelated buttons. Stacked rows give each
// outcome equal width, room for a one-line consequence, and a selected state
// that is obvious at a glance.
//
// Keyboard: these carry real radio semantics, so the group is one tab stop and
// the arrow keys move between the three (roving tabIndex driven by the parent).
export function DecisionRow({
  decision: d,
  selected,
  first,
  tabIndex,
  innerRef,
  onSelect,
  onKeyDown,
}: {
  decision: (typeof REVIEW_DECISIONS)[number]
  selected: boolean
  first: boolean
  tabIndex: number
  innerRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void
}) {
  const [hover, setHover] = useState(false)
  const { Icon } = d
  return (
    <button
      ref={innerRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%', textAlign: 'left',
        padding: '10px 12px', cursor: 'pointer',
        border: 'none', borderTop: first ? 'none' : `1px solid ${colors.border}`,
        background: selected ? d.tint : hover ? colors.raised : 'transparent',
        // The selected row is marked on its leading edge as well as by tint, so
        // the choice survives for anyone who cannot separate the three tints.
        boxShadow: selected ? `inset 3px 0 0 ${d.color}` : 'none',
        transition: 'background 0.16s ease',
      }}
    >
      <Icon
        size={15}
        strokeWidth={2.2}
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: '1px', color: selected ? d.color : colors.muted }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: '13px', fontWeight: 600, lineHeight: 1.35,
          color: selected ? d.color : colors.primary,
        }}>
          {d.label}
        </span>
        <span style={{ display: 'block', fontSize: '12px', color: colors.tertiary, marginTop: '2px', lineHeight: 1.4 }}>
          {d.hint}
        </span>
      </span>
    </button>
  )
}

// ── Admin Review modal ────────────────────────────────────────────────────────

export type AdminReviewModalProps = {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onActioned: () => void
}

export function AdminReviewModal({ request: r, supabase, onClose, onActioned }: AdminReviewModalProps) {
  const [action,    setAction]    = useState<AdminAction | null>(null)
  const [adminNote, setAdminNote] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const noteRequired = action === 'needs_clarification' || action === 'reject'
  const canConfirm   = action !== null && (!noteRequired || adminNote.trim())

  const handleConfirm = async () => {
    if (!action) return
    setSaving(true)
    setError(null)

    if (action === 'approve') {
      // Confirming receipt never creates an order — see
      // approve_finance_payment_request in 20260690000000. A new_order
      // request always lands in approved_unlinked (Suspense) with order_id
      // left null; an existing_order request links straight to the order it
      // already carries. The client never allocates or chooses an order
      // number either way.
      const { error: rpcError } = await supabase.rpc('approve_finance_payment_request', {
        p_request_id: r.id,
        p_admin_note: adminNote.trim() || null,
      })
      setSaving(false)
      if (rpcError) { setError(friendlyDbErrorMessage(rpcError)); return }

      // A new_order request lands in Suspense; an existing_order request links
      // straight to its order — notify the creator with the matching wording.
      void notifyFinance(
        r.payment_against === 'new_order'
          ? { event: 'finance_approved_suspense', requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name }
          : { event: 'finance_approved_linked',   requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name, orderNumber: r.order_number },
      )
      // The same second audience as the verification modal above, for the same
      // reason and by the same route. See the note there.
      if (r.order_id) void notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })

      onActioned()
      return
    }

    // THROUGH THE DOORS, NOT A TABLE WRITE (PR #172). A direct UPDATE of the
    // payment is refused in production by the Order/Finance reset guard, so
    // both decisions failed. request_finance_payment_clarification and
    // reject_finance_payment_request lock the row, re-check the verifier, act
    // only while it is pending, and say when somebody else decided first.
    const outcome = await sendBackOrReject(supabase, { requestId: r.id, action, note: adminNote })
    setSaving(false)
    if (outcome.kind === 'refused') { setError(outcome.message); return }
    // STALE IS NOT SUCCESS: nothing changed, so nobody is told it did.
    if (outcome.kind === 'stale') { setError(REVIEW_STALE_MESSAGE); return }

    // Notify the creator of the outcome (non-blocking).
    void notifyFinance({
      event: action === 'needs_clarification' ? 'finance_clarification' : 'finance_rejected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
    })

    // A REJECTION MOVES THE ORDER'S MONEY TOO. The echo trigger writes
    // payment_rejected onto every Order the payment's active allocations name,
    // and the people carrying that Order are the ones who have to do something
    // about the shortfall. Clarification is not announced: nothing has been
    // decided yet, and the request's own creator is the only person who can act.
    if (action !== 'needs_clarification' && r.order_id) {
      void notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })
    }

    onActioned()
  }

  // The decision currently selected, resolved once — it drives the note
  // placeholder, the footer sentence and the confirm button's colour, so all
  // three can never describe different outcomes.
  const selected = REVIEW_DECISIONS.find(d => d.key === action) ?? null

  // Roving tabIndex for the decision radiogroup: the group is a single tab
  // stop (the selected row, or the first when nothing is chosen yet) and the
  // arrow keys move the selection, which is what `role="radio"` promises.
  const decisionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const decisionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const forward  = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    const backward = e.key === 'ArrowUp'   || e.key === 'ArrowLeft'
    if (!forward && !backward) return
    e.preventDefault()
    const next = (i + (forward ? 1 : -1) + REVIEW_DECISIONS.length) % REVIEW_DECISIONS.length
    setAction(REVIEW_DECISIONS[next].key)
    decisionRefs.current[next]?.focus()
  }

  // WHAT THIS DIALOG IS, under the Payment ID — not who typed the entry.
  //
  // "Submitted by Test Sales User · 9 Sep 2026" used to sit here, in the most
  // prominent line on the screen after the id itself, which is more weight than
  // the submitter earns on a screen about money. It is still shown, as a field
  // in the payment details where the rest of the context is.
  const subtitleLine = 'Payment verification'

  // WHAT APPROVING THIS WILL ATTACH THE MONEY TO, read from the same projection
  // the requester's popup and the table read. Before this approval it is the
  // pending intent; the moment Approve is clicked it becomes an allocation, and
  // this block is then reading that instead.
  const destination = usePaymentDestination(supabase, r.id)
  const orderNoLine = orderNoCell(destination)

  // ── Figure band — the three facts a VERIFICATION turns on ──────────────────
  //
  // How much, through which account, on what date. The band used to carry the
  // CLIENT in the middle cell, which answered a different question: who the
  // money is from matters for context, but an approver checking a payment
  // against a bank statement is matching an amount to an account to a date, and
  // those three had to be read in three different places.
  //
  // The client has not been dropped — it leads the payment details below, where
  // it sits beside the record the money is for, which is where it is useful.
  const top = (
    <FigureBand>
      <FigureCell label="Amount"       value={fmtAmount(r.amount)} lead />
      {/* THE ACCOUNT, not a second copy of the mode. paymentDestinationLabel
          resolves a historical mode/received_in pair to the account it was
          recorded against, so a 2026 row still reads as an account name. */}
      <FigureCell label="Payment Mode" value={paymentDestinationLabel(r.payment_mode, r.received_in)} strong hint={<PaymentModeHint mode={r.payment_mode} />} />
      <FigureCell label="Payment Date" value={fmtDate(r.payment_date)} />
    </FigureBand>
  )
  // ── Payment details — the evidence, in one column, stated once ────────────
  //
  // WHAT WAS REMOVED WAS DUPLICATION, NOT INFORMATION. This column used to open
  // with a "What this payment is for" card naming PI Draft 417, and then a
  // "Routing" card whose "Payment Against" field named PI Draft 417 again and
  // whose "Order Number" field said "No Order yet — PI Draft" — a third way of
  // saying the same thing, phrased as an absence. The destination is one fact,
  // so it is one field: Against.
  //
  // The card also carried two sentences about the plumbing — "From this
  // payment's allocations" and "Read from the record itself, never typed" —
  // which tell an approver where the interface got a value rather than what the
  // value is. Neither survives.
  //
  // Payment Mode left this column for the band above, where it belongs on a
  // verification screen; the client came down from that band to lead here.
  const left = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <SectionHeader>Payment Details</SectionHeader>

      {/* NEVER BLANK. A Suspense payment has no customer to name, and
          customerDisplayName is the one place that decides what that reads as
          — never an empty cell, a 'null' or an 'undefined'. */}
      <MetaItem label="Client" value={customerDisplayName(r.client_name)} />

      {/* WHAT APPROVING THIS WILL ATTACH THE MONEY TO — the one thing an
          approver is deciding about. Before the decision it is the pending
          intent; the moment Confirm is clicked it becomes a real allocation,
          and this field is then reading that instead. Same shared helper the
          table and the requester's own popup read, so the three cannot
          disagree. */}
      <MetaItem label="Against" value={paymentAgainstDisplay(destination)}
                muted={!destination || destination.kind === 'suspense'} />

      {/* PROOF, REFERENCE AND NOTE — each drawn only when it exists.
          A REVIEW SCREEN IS READ, NOT FILLED. The three used to sit in one
          bordered frame with fixed rows, so a payment with no attachment, no
          UTR and no message printed "Not attached", "Not provided" and "No
          notes provided" — three rows whose entire content was the news that
          there was no content, above the decision somebody opened the dialog to
          make. The heading travels into PaymentProofView because only it knows
          whether there is an attachment to head. */}
      <PaymentProofView
        supabase={supabase}
        paymentRequestId={r.id}
        inline
        heading={<SectionHeader>Payment Proof</SectionHeader>}
      />
      {r.proof_note && <MetaItem label="Reference" value={r.proof_note} />}
      {r.sales_note && <MetaItem label="Note" value={r.sales_note} />}

      {/* WHO RAISED IT — kept, and kept secondary. It used to sit directly under
          the Payment ID in the header, which gave the person who typed the entry
          more prominence than the account the money came through. Finance cares
          about the money first; the submitter matters for accountability and for
          knowing who a clarification goes back to. */}
      <MetaItem
        label="Submitted by"
        value={r.submitted_by_name
          ? `${r.submitted_by_name} · ${fmtDate(r.created_at)}`
          : fmtDate(r.created_at)}
      />

      {/* WHO IS HOLDING THIS MONEY RIGHT NOW. For PNB and Paytm the mode says
          somebody physically carried it, and an admin about to confirm receipt
          has to be able to see the whole chain — not one collection and one
          handover, but every hand it passed through. Draws nothing at all when
          neither clause applies.

          THE ADMIN MAY ADD TO IT HERE, including after approval: a custody event
          is a statement about who carried cash, not about how much money
          arrived, so the post-approval freeze that protects the FIGURES has
          nothing to say about it. append_payment_custody_events decides that
          again server-side. */}
      <PaymentCustodyTrail
        supabase={supabase}
        payment={r}
        canAppend
        formatDateTime={fmtDateTime}
      />
    </div>
  )


  const right = (
    <>
      {/* ── Decision — the one thing this modal exists to capture, so it is the
             only bordered card in this column and the only element carrying a
             tint. Business logic (approve RPC, status update for
             clarification/rejection, notifications) is untouched: this is the
             same three-way choice and the same admin note as before. ── */}
      <div style={{ border: `1px solid ${colors.borderSoft}`, borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{
          padding: '9px 12px', background: colors.raised, borderBottom: `1px solid ${colors.border}`,
          fontSize: '12px', fontWeight: 700, color: colors.secondary, textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Decision
        </div>

        <div role="radiogroup" aria-label="Review decision">
          {REVIEW_DECISIONS.map((d, i) => (
            <DecisionRow
              key={d.key}
              decision={d}
              first={i === 0}
              selected={action === d.key}
              tabIndex={action ? (action === d.key ? 0 : -1) : (i === 0 ? 0 : -1)}
              innerRef={el => { decisionRefs.current[i] = el }}
              onSelect={() => setAction(d.key)}
              onKeyDown={e => decisionKeyDown(e, i)}
            />
          ))}
        </div>

        {action && (
          <div style={{
            borderTop: `1px solid ${colors.border}`, padding: '12px',
            display: 'flex', flexDirection: 'column', gap: '10px',
          }}>
            {action === 'approve' && (() => {
              // WHAT APPROVAL WILL ACTUALLY DO, read from the pending intent
              // rather than from payment_target_type — which reads 'unallocated'
              // for every request the current form writes, and would have told an
              // admin that a Confirmed-Order payment was going to Suspense.
              const linksToOrder = destination?.kind === 'confirmed_order'
              const goesSomewhere = !!destination && destination.kind !== 'suspense'
              return (
                <div style={{
                  padding: '9px 11px', borderRadius: '8px',
                  background: goesSomewhere ? '#E8F2EC' : '#FAF0DA',
                  border: `1px solid ${goesSomewhere ? '#BCD8C8' : '#E6D2A0'}`,
                  fontSize: '12px', color: goesSomewhere ? '#276247' : '#805B0D',
                  lineHeight: 1.5,
                }}>
                  {linksToOrder
                    ? `This payment will be verified and allocated to Order ${destination?.orderNumber ?? orderNoLine.value}.`
                    : destination?.kind === 'pi_draft'
                      ? `This payment will be verified and allocated to PI Draft ${destination.reference ?? ''}.`.trim()
                      : destination?.kind === 'mixed'
                        ? 'This payment will be verified and allocated across every record it names.'
                        : 'This payment will be verified and left unallocated. Attach it to an Order or a PI Draft afterwards through Allocate Funds.'}
                </div>
              )
            })()}

            <Field label={`Admin Note${noteRequired ? '' : ' (optional)'}`} required={noteRequired}>
              <textarea className="boe-input" value={adminNote} onChange={e => setAdminNote(e.target.value)}
                placeholder={
                  action === 'approve'             ? 'Optional note for the salesperson' :
                  action === 'needs_clarification' ? 'Explain what clarification is needed' :
                                                     'Explain why this is being rejected'
                }
                rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '13px' }} />
            </Field>
          </div>
        )}
      </div>

      {/* Activity — history, so it is rendered bare on the dialog surface. It
          keeps its own heading, query, ordering and event text; dropping the
          card around it is what stops it reading as a second panel of equal
          rank to the decision above. */}
      <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
    </>
  )

  // ── Commit bar ──────────────────────────────────────────────────────────────
  // Pinned below the body so the decision is always one click away, and stating
  // what is about to happen beside the button that does it — the amount and the
  // outcome together, so Confirm is never an unlabelled commitment.
  const footerNote = !action
    ? 'Select a decision to continue.'
    : noteRequired && !adminNote.trim()
      ? 'A note is required for this decision.'
      : action === 'approve'
        ? `${fmtAmount(r.amount)} will be verified as received.`
        : action === 'needs_clarification'
          ? `Returns to ${r.submitted_by_name ?? 'the salesperson'} for clarification.`
          : 'This payment request will be rejected.'

  const confirmDisabled = !canConfirm || saving

  const footer = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Errors live in the pinned bar, not the scroller, so a failure can
          never be scrolled away from the button that produced it. */}
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', color: action ? colors.tertiary : colors.muted, minWidth: 0, lineHeight: 1.45 }}>
          {footerNote}
        </div>
        <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
          {/* boe-btn-ghost has no disabled treatment of its own, so the
              in-flight state is stated inline rather than left looking live. */}
          <button
            onClick={onClose}
            disabled={saving}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '7px 16px', fontSize: '13px', opacity: saving ? 0.55 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            style={{
              padding: '8px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none',
              // The commit button wears the chosen outcome's colour, so approve
              // and reject are never one identical click apart.
              background: confirmDisabled ? colors.float : (selected?.color ?? colors.amber),
              color: confirmDisabled ? colors.muted : '#FFFFFF',
              cursor: confirmDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? (action === 'approve' ? 'Verifying…' : 'Saving…') : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <RequestModalShell
      requestNumber={r.human_payment_id}
      submittedLine={subtitleLine}
      statusBadge={<StatusBadge status={r.status} />}
      ariaLabel={`Review payment ${r.human_payment_id}`}
      onClose={onClose}
      top={top}
      left={left}
      right={right}
      footer={footer}
      // This modal holds unsaved input (the admin note) — BOE form-modal
      // dismissal rule: a backdrop click never discards it. Escape and × still
      // close. See docs 05_Business_Rules.md → "Form Modal Dismissal Rule".
      closeOnBackdropClick={false}
    />
  )
}
