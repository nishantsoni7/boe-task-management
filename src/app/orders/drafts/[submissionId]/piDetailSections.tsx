'use client'

// The sections the PI detail page is assembled from.
//
// PAGE-OWNED ON PURPOSE. These live beside the page rather than in
// src/components/orders/piPreview.tsx because nothing else renders them: the
// import preview has no workflow, no activity trail and no advance condition,
// and moving a one-consumer component into a shared file is how a shared file
// stops being shared. What IS shared with the import screen — the card, the card
// header, the product table head, the thumbnails, the diagnostic list, the
// commercial summary — is still imported from there and is untouched.
//
// EVERY COMPONENT BELOW IS A FUNCTION OF ITS PROPS. Nothing here fetches,
// writes, authorizes or decides. What may be done is decided by
// describeSubmissionActions and describeAdvanceActions; what is SAID is decided
// by ./piDetailView; what a figure means is decided by the shared PI helpers.
// These draw the answers.

import {
  AlertTriangle, Ban, CheckCircle2, ExternalLink, FileSpreadsheet, History,
  Info, Percent, Send, ShieldCheck, ThumbsUp, Undo2, Upload, Wallet,
} from 'lucide-react'
import { MultilineText } from '@/components/ui/MultilineText'
import { PiCard, PiCardHeader, PiDiagnosticList } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { draftStatusLabel, type PiDraftStatusTone } from '@/lib/orders/draftsView'
import {
  APPROVE_BUTTON_LABEL,
  CHANGE_PI_BUTTON_LABEL,
  REJECT_BUTTON_LABEL,
  REQUEST_CHANGES_BUTTON_LABEL,
  submitButtonLabel,
  type SubmissionActions,
} from '@/lib/orders/submissionWorkflow'
import {
  APPROVED_ORDER_HEADING,
  APPROVED_ORDER_NUMBER_LABEL,
  FINANCE_SECTION_LABEL,
  OPEN_ORDER_BUTTON_LABEL,
  VERIFY_FINANCE_BUTTON_LABEL,
  type FinanceStatusView,
} from '@/lib/orders/finalApproval'
import {
  APPROVE_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_BUTTON_LABEL,
  type AdvanceView,
} from '@/lib/orders/advanceRequirement'
import { BLOCKING_PANEL_TITLE, WARNING_PANEL_TITLE, type PiDiagnosticEntry } from '@/lib/pi/previewView'
import type { ActivityEntry, PiActivityTone } from '@/lib/orders/submissionActivity'
import {
  ADVANCE_BAND_TITLE,
  BLOCKING_INSTRUCTION,
  STORED_COPY_NOTE,
  describeRequestedException,
  type ApprovedOrderView,
  type CommercialSnapshot,
  type OverviewDate,
  type PiDetailTone,
  type WorkflowPanel,
} from './piDetailView'

// ── Tone ──────────────────────────────────────────────────────────────────────

type ToneStyle = { bg: string; color: string; border: string }

/** The five states this page ever colours, and nothing else. */
export const TONE_STYLE: Record<PiDetailTone, ToneStyle> = {
  neutral: { bg: colors.raised,    color: colors.secondary, border: colors.border },
  blue:    { bg: colors.blueTint,  color: '#2F5BB7',        border: 'rgba(85,133,232,0.3)' },
  amber:   { bg: colors.amberTint, color: '#9A6212',        border: 'rgba(232,160,48,0.3)' },
  red:     { bg: colors.redTint,   color: colors.red,       border: 'rgba(217,79,79,0.3)' },
  green:   { bg: colors.greenTint, color: '#2F7A52',        border: 'rgba(69,168,112,0.25)' },
}

/** The status vocabulary of the drafts list is the same one, by another name. */
export const statusTone = (tone: PiDraftStatusTone): ToneStyle => TONE_STYLE[tone]

/** A small state chip. Present, legible, and never a banner. */
export function PiStatusBadge({ label, tone }: { label: string; tone: ToneStyle }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '3px 10px', borderRadius: '5px',
      fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
      background: tone.bg, color: tone.color, border: `1px solid ${tone.border}`,
    }}>
      {label}
    </span>
  )
}

// ── 1. Page identity ──────────────────────────────────────────────────────────

/**
 * Status and a short line of facts, directly under the client name the layout
 * header already carries.
 *
 * IT IS NOT A CARD. A card here would be a bordered box whose whole content is
 * one badge and one sentence, sitting above a card that repeats them — which is
 * how the old page opened. This is a strip on the page ground: it costs one line
 * of vertical space and says who, what state, how big and when.
 */
export function PiIdentityStrip({ statusLabel, tone, facts, workbookName }: {
  statusLabel: string
  tone: ToneStyle
  facts: readonly string[]
  /** Only when the record actually names one. A labelled hole is worse. */
  workbookName: string | null
}) {
  return (
    <div className="pi-detail-identity">
      <PiStatusBadge label={statusLabel} tone={tone} />

      <div className="pi-detail-identity-meta" style={{ fontSize: '12px', color: colors.secondary }}>
        {facts.map((fact, i) => (
          <span key={fact} style={{ whiteSpace: 'nowrap' }}>
            {i > 0 && <span style={{ color: colors.muted, margin: '0 6px' }}>·</span>}
            {fact}
          </span>
        ))}
      </div>

      {workbookName && (
        <span
          className="pi-detail-identity-file"
          title={workbookName}
          style={{ fontSize: '11.5px', color: colors.tertiary }}
        >
          <FileSpreadsheet size={12} strokeWidth={1.9} style={{ flexShrink: 0 }} />
          <span className="pi-detail-identity-file-name">{workbookName}</span>
        </span>
      )}
    </div>
  )
}

// ── 2. Order overview ─────────────────────────────────────────────────────────

/**
 * A label over its value.
 *
 * THERE IS NO "MISSING" BRANCH ANY MORE. Every caller now omits a fact the PI
 * did not carry rather than reserving a labelled block for it: three stacked
 * "Not provided" lines were the single largest piece of dead space on the page,
 * and none of them asked anybody to do anything.
 */
function Field({ label, value, strong = false }: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      <MultilineText style={{
        fontSize: strong ? '13.5px' : '12.5px',
        fontWeight: strong ? 600 : 400,
        color: strong ? colors.primary : colors.secondary,
        margin: 0,
      }}>
        {value}
      </MultilineText>
    </div>
  )
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '7px',
      fontSize: '10.5px', fontWeight: 700, color: colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      <span style={{ display: 'flex', color: colors.tertiary }}>{icon}</span>
      {children}
    </div>
  )
}

/**
 * The one strong card under the page identity: who and where, when, and what it
 * is worth.
 *
 * THE CLIENT IS NOT REPEATED. It is the page title, and Bill to / Ship to carry
 * the destinations a reader actually compares.
 *
 * A SECTION WITH NOTHING IN IT IS NOT DRAWN, and the card re-columns around what
 * is left. Most saved PIs carry no order-confirmation date and no dispatch
 * commitment, and reserving a third of a wide card for three "Not provided"
 * lines was the largest piece of dead space on the screen. Three populated
 * groups get three columns; two get two balanced ones; a record with neither an
 * address nor a date leaves the commercial snapshot the whole card, which is the
 * one thing that is always worth showing.
 */
export function PiOrderOverview({ billTo, shipTo, dates, snapshot }: {
  billTo: string | null
  shipTo: string | null
  dates: readonly OverviewDate[]
  snapshot: CommercialSnapshot
}) {
  const hasDelivery = billTo !== null || shipTo !== null
  const hasDates = dates.length > 0
  const groups = 1 + (hasDelivery ? 1 : 0) + (hasDates ? 1 : 0)

  return (
    <PiCard>
      <div className={`pi-detail-overview pi-detail-overview-${groups}`}>

        {/* A — who it is for and where it goes. Given real width, because an
            address is the one field on this card that needs to be read rather
            than glanced at. Ship to is dropped when the PI did not name one:
            plenty of orders ship to the billing address and say so by omission. */}
        {hasDelivery && (
          <section className="pi-detail-overview-section">
            <SectionLabel icon={<Send size={12} strokeWidth={2} />}>Client &amp; delivery</SectionLabel>
            {billTo !== null && <Field label="Bill to" value={billTo} strong />}
            {shipTo !== null && <Field label="Ship to" value={shipTo} strong />}
          </section>
        )}

        {/* B — when. Only the dates the document actually gave. */}
        {hasDates && (
          <section className="pi-detail-overview-section pi-detail-overview-divided">
            <SectionLabel icon={<History size={12} strokeWidth={2} />}>Timeline</SectionLabel>
            {dates.map(date => (
              <Field key={date.key} label={date.label} value={date.value} />
            ))}
          </section>
        )}

        {/* C — what it is worth, and how much of it has actually been received
            and VERIFIED BY FINANCE. THE SINGLE CURRENT-STATE SOURCE for the
            payment position: the verified figure, the percentage it comes to and
            where approval stands, in one block that appears nowhere else on the
            page. The DECLARED advance is deliberately not among them — what a
            client agreed to pay is not money that arrived. */}
        <section className="pi-detail-overview-section pi-detail-snapshot pi-detail-overview-divided">
          <SectionLabel icon={<Wallet size={12} strokeWidth={2} />}>Commercial snapshot</SectionLabel>

          <div>
            <div style={SNAPSHOT_LABEL_STYLE}>Grand Total</div>
            <div className="pi-detail-snapshot-total" style={{ color: colors.primary }}>
              {snapshot.grandTotal}
            </div>
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '3px' }}>
              {snapshot.productLines}
            </div>
          </div>

          {snapshot.payment && <PiPaymentPosition payment={snapshot.payment} />}
        </section>

      </div>
    </PiCard>
  )
}

const SNAPSHOT_LABEL_STYLE: React.CSSProperties = {
  fontSize: '10px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px',
}

/**
 * The verified-payment position, in one block.
 *
 * Three lines at most — what has been verified, what it comes to as a
 * percentage, and where approval stands. Every figure was computed in `numeric`
 * in the database; nothing here calculates money, and nothing here shows a
 * declared advance.
 */
function PiPaymentPosition({ payment }: { payment: NonNullable<CommercialSnapshot['payment']> }) {
  const tone = payment.statusTone ? TONE_STYLE[payment.statusTone] : null

  return (
    <div>
      <div style={SNAPSHOT_LABEL_STYLE}>{payment.label}</div>
      <div style={{
        fontSize: '14px', fontWeight: 700, color: colors.primary,
        fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere',
      }}>
        {payment.figures}
      </div>
      {payment.status && tone && (
        <div style={{ marginTop: '6px' }}>
          <PiStatusBadge label={payment.status} tone={tone} />
        </div>
      )}
    </div>
  )
}

// ── 3. Workflow and actions ───────────────────────────────────────────────────

/** Somebody's own words, verbatim, on a tinted ground. */
function QuotedNote({ heading, body, tone }: {
  heading: string
  body: string
  tone: 'amber' | 'red' | 'neutral'
}) {
  const ground = tone === 'red' ? colors.redTint : tone === 'amber' ? colors.amberTint : colors.raised
  const border = tone === 'red' ? 'rgba(217,79,79,0.25)'
    : tone === 'amber' ? 'rgba(232,160,48,0.3)'
    : colors.border
  const headingColor = tone === 'red' ? '#991B1B' : tone === 'amber' ? '#9A6212' : colors.muted

  return (
    <div style={{
      padding: '9px 12px', borderRadius: '7px',
      background: ground, border: `1px solid ${border}`,
    }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: headingColor, marginBottom: '2px' }}>
        {heading}
      </div>
      <MultilineText style={{ fontSize: '12px', color: colors.primary, margin: 0 }}>
        {body}
      </MultilineText>
    </div>
  )
}

/**
 * One coordinated panel, above the products, carrying everything that is asked
 * of this viewer — and nothing that is not.
 *
 * WHY IT IS ONE PANEL. The old page had the employee's actions in one card, the
 * reviewer's in a second, the advance condition in a third or fourth depending
 * on who was looking, and all of them BELOW the product table — so a person had
 * to scroll past twelve products to find out that nothing was being asked of
 * them.
 *
 * WHAT THIS PASS TOOK OUT OF IT. The panel had become congested in its own
 * right: a standing paragraph under the heading, a muted line explaining why a
 * control could not be pressed, a disabled Approve, and an advance band
 * restating figures the top of the page already carried. What is left is a
 * heading, one metadata line, whatever a person actually wrote, the controls,
 * and — only while a decision is genuinely outstanding — the advance band.
 *
 * NO DISABLED PI APPROVAL. There is no approval RPC in this phase, and a greyed
 * "Approve" beside two live buttons was being read as the current approval
 * action rather than as a promise about a later one. Absence is clearer than an
 * inert control; Phase C introduces a real one.
 *
 * THE TWO DECISIONS STAY SEPARATE. Sending a PI back and settling one of its
 * commercial terms are different acts by possibly different people. Needs
 * Changes and Reject are therefore drawn from the PI-review authority ALONE and
 * survive an approved advance exception: accepting a 0% advance says nothing
 * about whether the products, quantities, rates, dates or addresses are right.
 */
export function PiWorkflowPanel({
  panel,
  actions,
  status,
  reviewNote,
  employeeReply,
  advanceRefusal,
  blockingCount,
  acting,
  finance,
  approvalBlocker,
  approvalReady,
  approvedOrder,
  onChangePi,
  onSubmit,
  onRequestChanges,
  onReject,
  onVerifyFinance,
  onApprove,
  onOpenOrder,
  advanceBand,
}: {
  panel: WorkflowPanel
  actions: SubmissionActions
  status: string
  /** management's note — the correction instruction, or the rejection reason. */
  reviewNote: string | null
  /** The employee's reply on the current submission, off the trail. */
  employeeReply: string | null
  /**
   * Why a proposed advance was refused, and what to do about it — for the
   * employee holding the returned PI, and for nobody else. Everyone else reads
   * the outcome in the snapshot and the history in Activity.
   */
  advanceRefusal: { reason: string | null; instruction: string } | null
  blockingCount: number
  acting: boolean
  /**
   * Where finance verification stands — for EVERY viewer who can read the PI,
   * not only the person who can act on it. Null on a record where the question
   * does not arise (a draft, a returned PI, a rejected one).
   */
  finance: FinanceStatusView | null
  /**
   * The one sentence explaining why Approve cannot be pressed yet, or null.
   * Rendered beside the control rather than as a banner: it is a note about one
   * button, and a strip across the panel would read as a note about the record.
   */
  approvalBlocker: string | null
  approvalReady: boolean
  /** The Order this PI became, once it exists and this viewer can see it. */
  approvedOrder: ApprovedOrderView | null
  onChangePi: () => void
  onSubmit: () => void
  onRequestChanges: () => void
  onReject: () => void
  onVerifyFinance: () => void
  onApprove: () => void
  onOpenOrder: () => void
  /** The pending advance decision, or null. */
  advanceBand: React.ReactNode
}) {
  const tone = TONE_STYLE[panel.tone]
  const isReviewer = actions.canRequestChanges || actions.canReject
  const ownerActions = actions.canSubmit || actions.canChangePi
  const hasActions = isReviewer || ownerActions
  const hasBody = Boolean(
    panel.instruction || reviewNote || employeeReply || advanceRefusal
    || finance || approvedOrder || (isReviewer && approvalBlocker),
  )

  return (
    <PiCard style={panel.closed ? undefined : { borderColor: tone.border }}>
      <div className="pi-detail-workflow-head">
        <div style={{ minWidth: '200px', flex: '1 1 260px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
            {panel.heading}
          </div>
          {panel.meta && (
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '3px' }}>
              {panel.meta}
            </div>
          )}
        </div>

        {hasActions && (
          <div className="pi-detail-workflow-actions">
            {ownerActions && (
              <>
                <button className="boe-btn boe-btn-ghost" onClick={onChangePi} disabled={acting}>
                  <Upload size={13} strokeWidth={2} />
                  {CHANGE_PI_BUTTON_LABEL}
                </button>
                <button
                  className="boe-btn boe-btn-primary"
                  onClick={onSubmit}
                  disabled={acting || blockingCount > 0}
                  title={blockingCount > 0 ? 'Fix the issues in the PI first' : undefined}
                >
                  <Send size={13} strokeWidth={2} />
                  {submitButtonLabel(status)}
                </button>
              </>
            )}

            {/* Drawn from the PI-review authority alone, and therefore still
                here after an advance exception has been approved.

                NEEDS CHANGES AND REJECT KEEP THEIR PLACE AFTER FINANCE HAS
                VERIFIED. A verified PI is not an approved one, and a reviewer
                who can no longer send back a document finance happened to sign
                off has lost the decision, not gained one. */}
            {isReviewer && (
              <>
                <button className="boe-btn boe-btn-ghost" onClick={onRequestChanges} disabled={acting}>
                  <Undo2 size={13} strokeWidth={2} />
                  {REQUEST_CHANGES_BUTTON_LABEL}
                </button>
                <button
                  className="boe-btn boe-btn-ghost"
                  onClick={onReject}
                  disabled={acting}
                  style={{ color: colors.red, borderColor: 'rgba(217,79,79,0.35)' }}
                >
                  <Ban size={13} strokeWidth={2} />
                  {REJECT_BUTTON_LABEL}
                </button>
                {/* THE PRIMARY ACTION, and the last one, so the destructive
                    choices are never the ones nearest the thumb.

                    SHOWN AND DISABLED rather than hidden when a precondition is
                    unmet: every blocker is somebody's outstanding task, and a
                    reviewer who cannot see the control cannot see what is
                    holding it up. `title` carries the same sentence the panel
                    prints, so a pointer user gets it too. */}
                <button
                  className="boe-btn boe-btn-primary"
                  onClick={onApprove}
                  disabled={acting || !approvalReady}
                  title={approvalBlocker ?? undefined}
                  style={{ background: '#2F7A52', borderColor: '#2F7A52' }}
                >
                  <CheckCircle2 size={13} strokeWidth={2} />
                  {APPROVE_BUTTON_LABEL}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {hasBody && (
        <div style={{
          padding: '0 20px 15px',
          display: 'flex', flexDirection: 'column', gap: '9px',
        }}>
          {/* The created Order, first, because on an approved record it is the
              answer to the only question anybody opens the page with. */}
          {approvedOrder && (
            <PiApprovedOrderStrip order={approvedOrder} onOpen={onOpenOrder} acting={acting} />
          )}
          {/* Where finance stands: one compact line, never a card of its own.
              A second full-size panel for a single boolean would outweigh the
              decision it reports. */}
          {finance && (
            <PiFinanceLine finance={finance} acting={acting} onVerify={onVerifyFinance} />
          )}
          {/* Why the primary action cannot be pressed yet — for the reviewer it
              is addressed to, and nobody else. */}
          {isReviewer && approvalBlocker && (
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
              {approvalBlocker}
            </div>
          )}
          {panel.instruction && (
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
              {panel.instruction}
            </div>
          )}
          {/* Management's own words, verbatim. The same column carries both
              decisions, so the heading says which one wrote it. */}
          {reviewNote && (
            <QuotedNote
              heading={panel.noteHeading}
              body={reviewNote}
              tone={status === 'rejected' ? 'red' : 'amber'}
            />
          )}
          {/* The employee's answer to it, read off the submission event rather
              than off the record — the record has no column for it. */}
          {employeeReply && (
            <QuotedNote heading="The employee&rsquo;s reply" body={employeeReply} tone="neutral" />
          )}
          {/* A refused advance, on the desk of the person who must now correct
              it. Both halves are real content: management's reason, and the
              choice the employee has. */}
          {advanceRefusal && (
            <>
              {advanceRefusal.reason && (
                <QuotedNote
                  heading="Why the advance was refused"
                  body={advanceRefusal.reason}
                  tone="red"
                />
              )}
              <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
                {advanceRefusal.instruction}
              </div>
            </>
          )}
        </div>
      )}

      {advanceBand && <div className="pi-detail-workflow-band">{advanceBand}</div>}
    </PiCard>
  )
}

// ── Finance verification, as one line ─────────────────────────────────────────

/**
 * Where finance stands on this PI: a state, and — for somebody who holds the
 * authority — one restrained control.
 *
 * A LINE, NOT A PANEL. The whole content is a boolean and, once it is true, a
 * name and a time. A card with a heading, a border and its own padding would
 * give a single fact the same weight the page gives the product table, and this
 * screen has already spent its structure on the decisions that need it.
 *
 * EVERYBODY WHO CAN READ THE PI SEES THE STATE. Only the button is gated, on the
 * finance authority alone — a PI waiting on somebody else's sign-off must not
 * look inert to the reviewer who is waiting on it.
 *
 * IT NEVER MENTIONS A PAYMENT, because none exists. The dialog behind the button
 * says so explicitly; the line itself simply does not raise the subject.
 */
export function PiFinanceLine({ finance, acting, onVerify }: {
  finance: FinanceStatusView
  acting: boolean
  onVerify: () => void
}) {
  const tone = finance.verified ? TONE_STYLE.green : TONE_STYLE.amber

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap',
      padding: '8px 11px', borderRadius: '7px',
      background: tone.bg, border: `1px solid ${tone.border}`,
    }}>
      <ShieldCheck size={13} strokeWidth={2} color={tone.color} />
      <span style={{
        fontSize: '11px', fontWeight: 700, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {FINANCE_SECTION_LABEL}
      </span>
      <span style={{ fontSize: '12px', color: colors.primary, lineHeight: 1.5, minWidth: 0 }}>
        {finance.text}
      </span>
      {finance.canVerify && (
        <button
          className="boe-btn boe-btn-ghost"
          onClick={onVerify}
          disabled={acting}
          style={{ marginLeft: 'auto' }}
        >
          <ShieldCheck size={13} strokeWidth={2} />
          {VERIFY_FINANCE_BUTTON_LABEL}
        </button>
      )}
    </div>
  )
}

// ── The Order this PI became ──────────────────────────────────────────────────

/**
 * The official number, prominently, and the way into the Order.
 *
 * THE NUMBER IS THE POINT. It is the thing the business now refers to this work
 * by, it did not exist five seconds before approval, and it is rendered in the
 * page's largest state type with tabular figures so "0413" and "0431" cannot be
 * misread at a glance.
 *
 * Drawn only when the number is actually known — see describeApprovedOrder. A
 * viewer who cannot read the Order gets no number and no link rather than a
 * placeholder and a dead end.
 */
export function PiApprovedOrderStrip({ order, onOpen, acting }: {
  order: ApprovedOrderView
  onOpen: () => void
  acting: boolean
}) {
  const tone = TONE_STYLE.green

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
      padding: '11px 14px', borderRadius: '8px',
      background: tone.bg, border: `1px solid ${tone.border}`,
    }}>
      <CheckCircle2 size={16} strokeWidth={2} color={tone.color} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <span style={{
          fontSize: '11px', fontWeight: 700, color: colors.muted,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {APPROVED_ORDER_HEADING}
        </span>
        <span style={{ fontSize: '12px', color: colors.secondary }}>
          {APPROVED_ORDER_NUMBER_LABEL}
          {' '}
          <span style={{
            fontSize: '17px', fontWeight: 700, color: colors.primary,
            fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em',
          }}>
            {order.displayNumber}
          </span>
        </span>
      </div>
      <button
        className="boe-btn boe-btn-ghost"
        onClick={onOpen}
        disabled={acting}
        style={{ marginLeft: 'auto' }}
      >
        <ExternalLink size={13} strokeWidth={2} />
        {OPEN_ORDER_BUTTON_LABEL}
      </button>
    </div>
  )
}

// ── The advance decision band ─────────────────────────────────────────────────

/**
 * A proposed advance that is still waiting on somebody. DRAWN ONLY WHILE IT IS
 * PENDING.
 *
 * WHY ONLY THEN. A settled exception has an outcome, and the outcome is already
 * in two places that are better suited to it: the snapshot at the top says what
 * the requirement now IS, and Activity keeps who decided it and when, forever. A
 * band restating the request, the reason, the requester, the decider and both
 * timestamps was the single largest block of repetition on the page.
 *
 * WHAT IT SHOWS WHILE IT IS PENDING is what a decision actually needs: the
 * condition being asked for, in one line, and the employee's reason for asking —
 * their own words, which exist nowhere else on this screen. The requester and
 * the timestamp are deliberately absent; they are audit facts and Activity is
 * the audit trail.
 *
 * EVERYBODY WHO CAN READ THE PI SEES IT. Only the two controls are gated, on the
 * exception authority alone — a record waiting on somebody else's decision must
 * not look inert to the person waiting.
 */
export function PiAdvanceBand({
  advance,
  verifiedLine,
  canDecide,
  acting,
  onApprove,
  onReject,
}: {
  advance: AdvanceView
  /** The LIVE verified-payment line, when it has been read. Preferred over the
   *  stored figures: the decision is about money that has actually arrived. */
  verifiedLine?: string | null
  /** Whether THIS viewer may settle the proposal. Never PI-review authority. */
  canDecide: boolean
  acting: boolean
  onApprove: () => void
  onReject: () => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
        <Percent size={13} strokeWidth={2} color={colors.tertiary} />
        <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
          {ADVANCE_BAND_TITLE}
        </span>
        <span style={{
          fontSize: '12.5px', fontWeight: 700, color: colors.primary,
          marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', textAlign: 'right',
        }}>
          {describeRequestedException(advance, verifiedLine)}
        </span>
      </div>

      {/* The employee's own words — what the decision is actually about. */}
      {advance.requestReason && (
        <QuotedNote heading="Employee&rsquo;s reason" body={advance.requestReason} tone="neutral" />
      )}

      {canDecide && (
        <div className="pi-detail-workflow-actions" style={{ paddingTop: '2px' }}>
          <button
            className="boe-btn boe-btn-primary"
            onClick={onApprove}
            disabled={acting}
            style={{ background: '#2F7A52', borderColor: '#2F7A52' }}
          >
            <ThumbsUp size={13} strokeWidth={2} />
            {APPROVE_EXCEPTION_BUTTON_LABEL}
          </button>
          <button className="boe-btn boe-btn-ghost" onClick={onReject} disabled={acting}>
            <Ban size={13} strokeWidth={2} />
            {REJECT_EXCEPTION_BUTTON_LABEL}
          </button>
        </div>
      )}
    </div>
  )
}

// ── 4. Blocking issues ────────────────────────────────────────────────────────

/**
 * What stops this PI being submitted, ABOVE the products.
 *
 * It is above them because it is the reason the primary action is disabled, and
 * a person who has to scroll a table to discover why cannot act on it. Rendered
 * only when there is something to say — an empty diagnostics panel is a panel
 * announcing that it has nothing to announce.
 */
export function PiBlockingPanel({ entries }: { entries: readonly PiDiagnosticEntry[] }) {
  return (
    <PiCard style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
      <div style={{
        padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
        background: colors.redTint,
        display: 'flex', alignItems: 'center', gap: '8px',
      }}>
        <AlertTriangle size={15} strokeWidth={2} color={colors.red} />
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
          {BLOCKING_PANEL_TITLE}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.red, fontWeight: 700 }}>
          {entries.length} {entries.length === 1 ? 'issue' : 'issues'}
        </span>
      </div>
      <PiDiagnosticList entries={entries} tone="red" />
      <div style={{
        padding: '10px 20px', borderTop: `1px solid ${colors.border}`,
        fontSize: '11px', color: colors.muted, lineHeight: 1.5,
      }}>
        {BLOCKING_INSTRUCTION}
      </div>
    </PiCard>
  )
}

// ── 7. Non-blocking warnings ──────────────────────────────────────────────────

/**
 * Worth checking, and nothing more. Below the lower grid, in a quieter treatment
 * than the blocking panel: nothing here stops a submission, so nothing here may
 * compete with the panel that does — or with the actions above it.
 */
export function PiWarningPanel({ entries }: { entries: readonly PiDiagnosticEntry[] }) {
  return (
    <PiCard>
      <div style={{
        padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', gap: '8px',
      }}>
        <Info size={15} strokeWidth={2} color={colors.amber} />
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
          {WARNING_PANEL_TITLE}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.muted }}>
          {entries.length} recorded when this draft was saved
        </span>
      </div>
      <PiDiagnosticList entries={entries} tone="amber" />
    </PiCard>
  )
}

// ── 6. Activity ───────────────────────────────────────────────────────────────

/**
 * The trail's markers — the SAME five meanings, at lower intensity.
 *
 * These are the accent tokens softened towards their own ground. The trail is
 * the page's secondary reference and a column of full-strength dots was pulling
 * the eye away from the money card beside it; at this saturation they still
 * separate one kind of event from another at a glance without competing.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL HERE. Every dot sits beside the event's name
 * in words — "Rejected", "Advance exception approved" — and the rail itself is
 * aria-hidden, so nothing is communicated by hue alone and nothing is lost to a
 * reader who cannot distinguish these five.
 */
const TIMELINE_MARKER: Record<PiActivityTone, string> = {
  neutral: '#A4ABB9',
  blue: '#7A9DE0',
  amber: '#D9A552',
  green: '#6BB68C',
  red: '#CE7272',
}

/**
 * ACTIVITY IS THE SECONDARY REFERENCE, and now looks like it.
 *
 * A very light cool grey rather than the strong white the commercial card keeps,
 * a neutral hairline, and no shadow at all. The difference is one step — the
 * card must still read as a card, and every word in it must stay legible.
 */
const ACTIVITY_CARD_STYLE: React.CSSProperties = {
  background: colors.raised,
  borderColor: 'rgba(0,0,0,0.09)',
  boxShadow: 'none',
}

/**
 * The append-only trail as an audit timeline: a marker, a connecting rule, and
 * what happened.
 *
 * IT IS A HISTORY AND NOT A CONTROL. No ids, no raw metadata, no status enums —
 * only what happened, who did it, when, whatever note they left, and (for the
 * three advance events) the percentage and amount that WERE the event.
 *
 * NOTHING GENERATED IS PRINTED UNDER AN EVENT. Each advance event used to carry
 * a fixed sentence explaining what it did and did not mean; the same paragraph
 * appeared under every occurrence and pushed the actor, the time and the words a
 * person actually typed down the card. User-entered notes and reasons are
 * untouched — they are the only prose the trail carries now.
 *
 * NEWEST FIRST, unchanged. describeActivityEntries decides the order and has
 * done since the trail existed; reversing it here would silently change what a
 * reader finds at the top of a record they have read before.
 */
export function PiActivityTimeline({ entries }: { entries: readonly ActivityEntry[] }) {
  return (
    <PiCard style={ACTIVITY_CARD_STYLE}>
      <PiCardHeader
        title={
          // Softer than the commercial card's heading by a weight and a shade —
          // the two sit side by side, and which one is the reference should be
          // answerable without reading either.
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            fontWeight: 600, color: colors.secondary,
          }}>
            <History size={15} strokeWidth={1.9} color={colors.muted} />
            Activity
          </span>
        }
        right={
          <span style={{ fontSize: '12px', color: colors.tertiary, whiteSpace: 'nowrap' }}>
            {entries.length} event{entries.length === 1 ? '' : 's'}
          </span>
        }
      />
      {entries.length === 0 ? (
        <div style={{ padding: '16px 20px', fontSize: '12px', color: colors.tertiary }}>
          No activity has been recorded against this PI yet.
        </div>
      ) : (
        <ol className="pi-detail-timeline">
          {entries.map(entry => (
            <li key={entry.key} className="pi-detail-timeline-item">
              <div className="pi-detail-timeline-rail" aria-hidden="true">
                <span
                  className="pi-detail-timeline-dot"
                  style={{ background: TIMELINE_MARKER[entry.tone] }}
                />
                <span className="pi-detail-timeline-line" />
              </div>
              <div className="pi-detail-timeline-body">
                <div style={{
                  display: 'flex', gap: '10px', flexWrap: 'wrap',
                  alignItems: 'baseline', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
                    {entry.label}
                  </span>
                  {/* Darkened, not lightened. The card's ground moved off pure
                      white, and a muted grey on it would have fallen below the
                      contrast this text had before — quieter must not mean
                      harder to read. */}
                  <span style={{ fontSize: '11px', color: colors.tertiary, whiteSpace: 'nowrap' }}>
                    {entry.at}
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: colors.tertiary, marginTop: '2px' }}>
                  {entry.actor}
                  {entry.figures && (
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}> · {entry.figures}</span>
                  )}
                </div>
                {entry.note && (
                  <MultilineText style={{
                    fontSize: '12px', color: colors.secondary, margin: '5px 0 0',
                    paddingLeft: '10px', borderLeft: `2px solid ${colors.border}`,
                    lineHeight: 1.5,
                    // A long reason wraps inside the narrow column rather than
                    // widening it.
                    overflowWrap: 'anywhere',
                  }}>
                    {entry.note}
                  </MultilineText>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </PiCard>
  )
}

// ── The lower grid ────────────────────────────────────────────────────────────

/**
 * The activity trail beside the commercial breakdown, as one band under the
 * products.
 *
 * ACTIVITY TAKES THE LEFT AND THE WIDTH (~62%). It is prose: notes people typed,
 * names, timestamps. Squeezed into the narrow column it wrapped every line.
 *
 * THE BREAKDOWN TAKES THE RIGHT (~38%). It is compact label-value data that
 * needs no more, and on the right its figures land under the Cost / piece and
 * Line total columns of the products table directly above — which is the way a
 * reader moves anyway, from line totals down to order totals.
 *
 * STACKED, THE BREAKDOWN COMES FIRST. A phone reader has just finished the
 * product values and wants the total next, not a history. The DOM order is
 * activity-then-breakdown so the desktop layout needs no reordering; the single
 * column flips it with `order`, which costs nothing and no JavaScript.
 *
 * Top-aligned and never stretched: a long trail must not drag the breakdown card
 * down to its own height.
 */
export function PiLowerGrid({ commercial, activity }: {
  commercial: React.ReactNode
  activity: React.ReactNode
}) {
  return (
    <div className="pi-detail-lower-grid">
      <div className="pi-detail-activity-col">{activity}</div>
      <div className="pi-detail-commercial-col">{commercial}</div>
    </div>
  )
}

// ── 8. The footnote ───────────────────────────────────────────────────────────

export function PiStoredCopyNote() {
  return (
    <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.6, padding: '0 4px' }}>
      {STORED_COPY_NOTE}
    </div>
  )
}

// ── The transient save confirmation ───────────────────────────────────────────

/** Shown once, after a save, and never load-bearing. */
export function PiSavedStrip() {
  return (
    <div style={{
      display: 'flex', gap: '9px', alignItems: 'center',
      padding: '9px 14px', borderRadius: '9px',
      background: colors.greenTint, border: '1px solid rgba(69,168,112,0.35)',
    }}>
      <CheckCircle2 size={15} strokeWidth={1.9} color={colors.green} style={{ flexShrink: 0 }} />
      <span style={{ fontSize: '12px', color: colors.primary }}>
        Draft saved. This is the copy the server verified and stored.
      </span>
    </div>
  )
}

/** The status label, so the page and this file cannot word a state differently. */
export { draftStatusLabel }
