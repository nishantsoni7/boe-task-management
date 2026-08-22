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
  AlertTriangle, Ban, CheckCircle2, ChevronRight, ExternalLink, FileSpreadsheet,
  History, Info, Percent, Send, ShieldCheck, ThumbsUp, Undo2, Upload,
} from 'lucide-react'
import { MultilineText } from '@/components/ui/MultilineText'
import { PiCard, PiCardHeader, PiDiagnosticList } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { Avatar } from '@/components/ui/atoms'
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
  BILLING_LABEL,
  BILLING_VALUE_LABEL,
  type BillingSummary,
  type ClientDetails,
  type DateSummary,
  type PiOwnership,
  type SummaryFigure,
  type PaymentSummaryView,
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

/**
 * The one name for the control that opens the payment record.
 *
 * It used to read "View payments" when the PI had payments and "Payment
 * details" when it had none — one control wearing two names depending on state.
 * Both press the same thing: PiPaymentDetailsModal, which is also what the page
 * calls it (`setPaymentDialog('details')`). So the established name is the name.
 */
export const PAYMENT_DETAILS_LABEL = 'Payment details'

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

// ── 2. The top summary ────────────────────────────────────────────────────────

/**
 * THE TOP SUMMARY: who, when, and how much has actually arrived.
 *
 * WHAT REPLACED WHAT. This card replaces an overview that answered a different
 * set of questions from the ones people actually open a saved PI to ask. It
 * printed Bill to and Ship to as two strong fields — the same company name
 * twice on most orders, and the page title a third time — a PI-created date and
 * a prose dispatch commitment, a product-line count the Products card states on
 * its own header, and a large standalone Grand Total whose only job was to be
 * the thing payment is measured against. It answered "how much has been paid"
 * in a small block here and again in a full card several screens down.
 *
 * The three groups below are the four questions instead: who the client is and
 * how to reach them, when the order was confirmed and when it is due, and how
 * much VERIFIED money has arrived against the order's worth — with the way in
 * to every payment record, and to recording another, on the same line as the
 * figure.
 *
 * PAYMENT IS THE STRONGEST GROUP and takes the most width, because it is the
 * one thing on this card that changes.
 *
 * NOT ONE FIGURE IS COMPUTED HERE. See ./piDetailView.
 */
export function PiSummaryCard({
  client, onOpenClient, ownership, statusLabel, tone, workbookName,
  dates, figures, billing, canEditBilling, onEditBilling,
  canEditDetails, onEditDetails, onEditSchedule, onRequestCorrection, missingSummary,
  payment, canAdd, onOpenPayments, onAddPayment, notice, onDismissNotice,
}: {
  client: ClientDetails
  /** Opens the client dialog. The card carries the name; the dialog carries
      the contact and the two parties. */
  onOpenClient: () => void
  /** Who the PI belongs to, and when it last moved. */
  ownership: PiOwnership
  statusLabel: string
  tone: ToneStyle
  /** Provenance, only when the record names a workbook. */
  workbookName: string | null
  dates: readonly DateSummary[]
  /** The two commercial figures, picked out of the breakdown's own rows. */
  figures: readonly SummaryFigure[]
  /** The billing declaration, and what it comes to. */
  billing: BillingSummary
  /**
   * Whether THIS viewer may declare one — describeSubmissionActions' answer,
   * which is draft/needs_changes and owner-or-admin. Hiding the control is not
   * the security: set_order_submission_billing_percentage re-derives the same
   * rule against the record's own state.
   */
  canEditBilling: boolean
  onEditBilling: () => void
  /**
   * Whether this viewer may correct the client and party details — the owner in
   * draft/needs_changes, or an active admin at any stage. As everywhere else on
   * this page, hiding the control is not the security:
   * update_order_submission_client_details re-derives the whole rule.
   */
  canEditDetails: boolean
  onEditDetails: () => void
  /** Opens the dates-and-terms section of the same editor. */
  onEditSchedule: () => void
  /**
   * The OWNER's channel for a PI that has left their hands, or null.
   *
   * Shown INSTEAD OF the edit controls, never alongside them: the two answer
   * the same impulse, and offering both would suggest the owner has a choice
   * about which one works.
   */
  onRequestCorrection: (() => void) | null
  /**
   * What this PI still needs before it can take a payment, as one sentence.
   *
   * Null when nothing is missing. Present, this is the whole point of the
   * panel: a workbook imported without a client name used to leave the reader
   * with "Not provided" and a payment refusal, and no way to connect the two.
   */
  missingSummary: string | null
  /** null only while the payment summary has not been read yet. */
  payment: PaymentSummaryView | null
  canAdd: boolean
  onOpenPayments: () => void
  onAddPayment: () => void
  notice: string | null
  onDismissNotice: () => void
}) {
  return (
    <PiCard>
      {/* ── What is still missing, and the way to fix it ──
          Above the summary rather than beside the field, because it is about
          the record as a whole and because a reader who cannot proceed needs to
          meet this before they go looking for the reason. */}
      {missingSummary && (
        <div
          role="status"
          style={{
            display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center',
            padding: '10px 18px', fontSize: '12.5px',
            background: '#fdf6ee', borderBottom: `1px solid ${colors.border}`,
            color: '#8a4b12',
          }}
        >
          <span style={{ flex: '1 1 240px', minWidth: 0 }}>{missingSummary}</span>
          {canEditDetails && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={onEditDetails}>
              Add client details
            </button>
          )}
          {!canEditDetails && onRequestCorrection && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={onRequestCorrection}>
              Request correction
            </button>
          )}
        </div>
      )}

      <div className="pi-detail-summary">

        {/* ── The left column: everything ABOUT the order ──
            Who it is for, when it moves, and whose record it is — three groups
            stacked and separated by hairlines rather than by boxes. Ownership
            used to sit top-right, level with the client, where it read as a
            header control belonging to the page rather than a fact about this
            record. At the foot of this column it is plainly the last thing the
            order says about itself. */}
        <div className="pi-detail-summary-left">

          {/* THE NAME IS THE CONTROL, and it still looks like the name.
              A button element carries Enter, Space, focus and the announcement
              for free — what it must not carry is the LOOK of a button, because
              this is the heading of the card. So: no border, no ground, no
              padding beyond what the focus ring needs, and a chevron that says
              there is more behind it. The contact number and both addresses
              used to sit under here as a supporting line; they are reference
              material, and they live in the dialog now. */}
          <div className="pi-detail-summary-party">
            <button
              type="button"
              onClick={onOpenClient}
              className="pi-detail-summary-client"
              aria-haspopup="dialog"
              title="Contact number, billing and shipping details"
            >
              <MultilineText style={{
                fontSize: '16px', fontWeight: 650, color: colors.primary, margin: 0, lineHeight: 1.25,
              }}>
                {client.name}
              </MultilineText>
              <ChevronRight size={15} strokeWidth={2.2} className="pi-detail-summary-client-more" />
            </button>
          </div>

          {/* ── ONE SCHEDULE BAND, not two treatments ──
              The due date used to sit in its own warm box behind a 2px accent,
              which read as a card inserted into a card and made the two dates
              look like different KINDS of fact. They are the same kind: when
              the order was agreed, and when it is owed. So one soft surface
              holds both, split by a hairline that stops inside the band's own
              padding, and the emphasis the due date still needs is carried by a
              dot and a heavier figure rather than by a ground of its own. */}
          <section className="pi-detail-summary-schedule">
            {dates.flatMap((date, i) => [
              i > 0
                ? <div key={`${date.key}-rule`} className="pi-detail-summary-sched-rule" role="presentation" />
                : null,
              (
                <div key={date.key} className="pi-detail-summary-sched-cell">
                  <div className="pi-detail-summary-metric-label">
                    {date.label}
                    {/* The whole of the due date's emphasis at label level: one
                        small amber dot. Decorative — the label already says
                        which date this is. */}
                    {date.key === 'due' && (
                      <span className="pi-detail-summary-due-dot" aria-hidden="true" />
                    )}
                  </div>
                  {date.value ? (
                    <div className={date.key === 'due'
                      ? 'pi-detail-summary-metric-value pi-detail-summary-due-value'
                      : 'pi-detail-summary-metric-value'}>
                      {date.value}
                    </div>
                  ) : (
                    <div className="pi-detail-summary-metric-absent">{date.absent}</div>
                  )}
                  {/* Clamped to two lines. A long commitment is prose about a
                      lead time; left unbounded it sets the height of the band
                      the other date has to align inside. */}
                  {date.note && <div className="pi-detail-summary-metric-note">{date.note}</div>}
                </div>
              ),
            ])}
          </section>

          {/* ── Whose record this is, at the FOOT of the column it belongs to ──
              Avatar beside three lines: the creator's name with the record's
              state anchored opposite it, what that name means and when the
              record last moved, and the workbook it came from when there is
              one. Pushed to the bottom of the column so it reads as the last
              thing the order says about itself rather than as a control. */}
          <div className="pi-detail-summary-hr pi-detail-summary-hr-foot" role="presentation" />

          <div className="pi-detail-summary-owner">
            {ownership.name && <Avatar name={ownership.name} size={30} />}
            <div className="pi-detail-summary-owner-text">
              <div className="pi-detail-summary-owner-top">
                <span className="pi-detail-summary-owner-name">
                  {ownership.name ?? 'Not named'}
                </span>
                <PiStatusBadge label={statusLabel} tone={tone} />
              </div>
              {/* "PI created by", never "Assignee": nobody was assigned this
                  record — somebody made it. */}
              <div className="pi-detail-summary-owner-when">
                PI created by · {ownership.when}
              </div>
              {workbookName && (
                <span
                  className="pi-detail-summary-file"
                  title={workbookName}
                  style={{ fontSize: '11px', color: colors.tertiary }}
                >
                  <FileSpreadsheet size={11.5} strokeWidth={1.9} style={{ flexShrink: 0 }} />
                  <span className="pi-detail-summary-file-name">{workbookName}</span>
                </span>
              )}
            </div>
          </div>
        </div>

      {/* ── The finance surface ──
            What the order is worth, a rule, then what has arrived against it:
            the label and the percentage on one line, the amount as the
            strongest number under them, one full-width bar, and the two
            controls beneath. The percentage lives in the header rather than
            floating beside the bar, where it read as a caption for the track
            instead of a figure in its own right. */}
        <section className="pi-detail-summary-paycard">

          {/* The order's worth, as label-left / figure-right rows — the same
              idiom the Commercial breakdown card below uses, because these are
              two lines OF that breakdown. Side by side as label-over-value
              pairs they drifted to opposite ends of the surface and stopped
              reading as a pair at all.

              Outside the payment branch below because these come from the
              record itself: they must not blank out while the payment summary
              is still being read. */}
          {/* ── The surface's two upper areas, side by side ──
              What the order is WORTH on the left, what has ARRIVED against it
              on the right, one hairline between them. The hairline is an
              element rather than a border, so it insets from the surface's top
              and bottom padding instead of running its whole height; at phone
              width the same element lies down and becomes the horizontal rule
              between the two stacked areas. */}
          <div className="pi-detail-summary-paybody">

            <div className="pi-detail-summary-values">
              {figures.map(figure => (
                /* Label OVER value, the same way in both rows. Side by side as
                   label-left/figure-right they need ~166px, and 38% of this
                   surface at tablet is not that — the label wrapped, which is
                   the compressed reading a narrow column has to avoid. */
                <div key={figure.key} className="pi-detail-summary-value-row">
                  <div className="pi-detail-summary-metric-label">{figure.label}</div>
                  <div className={figure.kind === 'missing'
                    ? 'pi-detail-summary-metric-absent'
                    : 'pi-detail-summary-money'}>
                    {figure.value}
                  </div>
                </div>
              ))}

              {/* ── The billing declaration ──
                  Below the two figures it is measured against, in space this
                  column already had. Not another card and not behind a rule: a
                  wider gap above it is what says "a different kind of fact",
                  and the label treatment is the figures' own. */}
              <div className="pi-detail-summary-value-row pi-detail-summary-billing">
                <div className="pi-detail-summary-billing-head">
                  <span className="pi-detail-summary-metric-label">{BILLING_LABEL}</span>
                  {canEditDetails && (
                    <button
                      type="button"
                      className="boe-btn boe-btn-ghost"
                      onClick={onEditSchedule}
                      style={{ fontSize: '11.5px' }}
                    >
                      Dates and terms
                    </button>
                  )}
                  {!canEditDetails && onRequestCorrection && (
                    <button
                      type="button"
                      className="boe-btn boe-btn-ghost"
                      onClick={onRequestCorrection}
                      style={{ fontSize: '11.5px' }}
                    >
                      Request correction
                    </button>
                  )}
                  {canEditBilling && (
                    <button
                      type="button"
                      onClick={onEditBilling}
                      className="pi-detail-summary-billing-action"
                      aria-haspopup="dialog"
                      aria-label={`${billing.action} ${BILLING_LABEL.toLowerCase()}`}
                    >
                      {billing.action}
                    </button>
                  )}
                </div>
                {/* UNDECLARED IS MUTED, and says so in words. Not 0%, not an em
                    dash — nobody has decided yet. */}
                <div className={billing.declared
                  ? 'pi-detail-summary-money'
                  : 'pi-detail-summary-metric-absent'}>
                  {billing.percent}
                </div>
              </div>

              {/* Only where there is a percentage to measure. A missing pre-GST
                  total shows the card's own missing treatment, never ₹0. */}
              {billing.declared && (
                <div className="pi-detail-summary-value-row">
                  <div className="pi-detail-summary-metric-label">{BILLING_VALUE_LABEL}</div>
                  <div className={billing.amountMissing
                    ? 'pi-detail-summary-metric-absent'
                    : 'pi-detail-summary-money'}>
                    {billing.amount}
                  </div>
                </div>
              )}
            </div>

            <div className="pi-detail-summary-payrule" role="presentation" />

            <div className="pi-detail-summary-paystate">
          {payment === null ? (
            <>
              <div className="pi-detail-summary-payhead">
                <span className="pi-detail-summary-metric-label">Payment received</span>
              </div>
              <div style={{ fontSize: '12px', color: colors.muted }}>Loading…</div>
            </>
          ) : (
            <>
              <div className="pi-detail-summary-payhead">
                <span className="pi-detail-summary-metric-label">Payment received</span>
                <span className="pi-detail-summary-percent">{payment.percent}</span>
              </div>

              {/* The figure IS the way in — one control carrying the amount
                  and the total it is measured against. */}
              <button
                type="button"
                onClick={onOpenPayments}
                aria-haspopup="dialog"
                className="pi-detail-summary-open"
                title="Show every payment recorded against this PI"
              >
                <span className="pi-detail-summary-received">{payment.received}</span>
                <span className="pi-detail-summary-oftotal">{payment.ofTotal}</span>
              </button>

              <div className="pi-detail-summary-bar" role="presentation">
                <div
                  className="pi-detail-summary-bar-fill"
                  style={{ width: `${payment.barPercent}%` }}
                />
              </div>

              {/* Money Finance has not decided is NOT in the bar or the
                  percentage, and saying so is what keeps the two honest. */}
              {payment.awaitingCount > 0 && (
                <button type="button" onClick={onOpenPayments} className="pi-detail-summary-awaiting">
                  {payment.awaitingCount} payment{payment.awaitingCount === 1 ? '' : 's'} awaiting
                  verification — not counted above
                </button>
              )}

              {notice && (
                <div className="pi-detail-summary-notice">
                  <span style={{ fontSize: '11.5px', color: colors.secondary }}>{notice}</span>
                  <button
                    type="button" onClick={onDismissNotice} aria-label="Dismiss"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: colors.muted, fontSize: '14px', lineHeight: 1, padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {/* THE CONTROLS BELONG TO THE PAYMENT SECTION, immediately under
                  the bar they act on. As a footer spanning the whole surface
                  they were detached from the thing they change, and the auto
                  margin that pushed them down opened a hole in the middle of
                  the card. */}
              <div className="pi-detail-summary-actions">
                {/* Unchanged gate: canAddPiPayment decides this, exactly as
                    record_pi_submission_payment() decides it server-side. */}
                {canAdd && (
                  <button type="button" onClick={onAddPayment} className="pi-detail-summary-add">
                    Add payment
                  </button>
                )}
                {/* ONE label, always. It opens PiPaymentDetailsModal in either
                    case, so wording that changed with the record made the same
                    control look like two. */}
                <button type="button" onClick={onOpenPayments} className="pi-detail-summary-view">
                  {PAYMENT_DETAILS_LABEL}
                </button>
              </div>
            </>
          )}
            </div>
          </div>
        </section>

      </div>
    </PiCard>
  )
}

/** A small sentence-case group label. Not uppercase: three shouted words over
 *  every group was noise on a card meant to be scanned. */
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

  /**
   * A PANEL WITH NOTHING IN IT IS NOT DRAWN.
   *
   * describeWorkflowPanel gives a plain draft viewed by somebody who can
   * neither submit nor review it `heading: "Draft"`, `meta: null` and no
   * instruction — so the card came out as a bordered white box containing one
   * word, directly under a summary whose status badge already says it. That is
   * a restatement occupying a full section of the page, and it pushed the
   * product table down for nothing.
   *
   * The test is emptiness, NOT the draft state: any status that offers this
   * viewer no action and carries no note, no finance line, no advance band and
   * no Order link is the same empty box. Every state that carries any of those
   * — a returned PI with management's note, a submitted one with the finance
   * line, a reviewer's decisions, an approved one naming its Order — still
   * renders exactly as before, because each sets hasActions or hasBody.
   */
  if (!hasActions && !hasBody && !panel.meta && !advanceBand) return null

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
