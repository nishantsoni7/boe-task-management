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

import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Ban, CalendarDays, Check, CheckCircle2, ChevronRight, Clock, Copy,
  FileSpreadsheet, Hash, History, Info, Pencil, Percent, Send, ShieldCheck, ThumbsUp, Undo2, Upload,
  User,
} from 'lucide-react'
import { MultilineText } from '@/components/ui/MultilineText'
import { PiCard, PiCardHeader, PiDiagnosticList } from '@/components/orders/piPreview'
import { PAYMENT_BAR_COLORS, PiPaymentProgress } from '@/components/orders/PiPaymentCard'
import type { PiPaymentFilter } from '@/lib/finance/piPaymentView'
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
  type ReviewDecision,
} from '@/lib/orders/finalApproval'
import {
  APPROVE_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_BUTTON_LABEL,
  type AdvanceView,
} from '@/lib/orders/advanceRequirement'
import { BLOCKING_PANEL_TITLE, WARNING_PANEL_TITLE, type PiDiagnosticEntry } from '@/lib/pi/previewView'
import {
  NUMBER_LABEL,
  RESERVE_ACTION_LABEL,
  type ReservationView,
} from '@/lib/orders/orderNumberReservation'
import type { PiReadiness, PiRequirement } from '@/lib/orders/piReadiness'
import type { ActivityEntry, PiActivityTone } from '@/lib/orders/submissionActivity'
import {
  ADVANCE_BAND_TITLE,
  BILLING_LABEL,
  BILLING_NOT_DECLARED_LABEL,
  BILLING_VALUE_LABEL,
  BLOCKING_INSTRUCTION,
  NOT_SUBMITTED_TEXT,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUS_TITLE,
  RESERVED_ORDER_LABEL,
  STORED_COPY_NOTE,
  buildPaymentMetrics,
  describeReceivedHeadline,
  describeRequestedException,
  type ApprovedOrderView,
  type BillingSummary,
  type BreakdownView,
  type ClientDetails,
  type DateSummary,
  type OverviewMetaItem,
  type PaymentMetric,
  type PaymentStatusView,
  type PiDetailTone,
  type SubmissionContext,
  type SummaryFigure,
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

// ── 1. The context row ────────────────────────────────────────────────────────

/**
 * The two facts a reader looks for first, side by side: the Order number this
 * PI will carry, and where it stands with management and Finance.
 *
 * ONE CARD, TWO EQUAL COLUMNS from tablet width up, stacked on a phone — the
 * arrangement is the `pi-detail-context` block in globals.css.
 *
 * DRAWING ONLY. describeReservation decides the number's standing and whether a
 * Reserve control is offered at all; buildSubmissionContext words the status.
 * The copy control writes to the clipboard and nothing else. The number is
 * issued by the database and immutable once issued, so there is no input here.
 */
export function PiContextRow({
  reservation, confirmedNumber, reserving, reservationFailure, onReserve, onCopy, copied,
  context, statusLabel, tone,
}: {
  reservation: ReservationView
  /** The Confirmed Order's number, once there is one and this viewer can read it. */
  confirmedNumber: string | null
  reserving: boolean
  reservationFailure: string | null
  /** The compatibility Reserve action, or null wherever the RPC would refuse it. */
  onReserve: (() => void) | null
  onCopy: (value: string) => void
  copied: boolean
  context: SubmissionContext
  statusLabel: string
  tone: ToneStyle
}) {
  const number = reservation.number
  return (
    <PiCard>
      <div className="pi-detail-context">
        <section className="pi-detail-context-cell" aria-label={RESERVED_ORDER_LABEL}>
          <div className="pi-detail-context-label">
            <Hash size={12} strokeWidth={2.2} aria-hidden="true" />
            {RESERVED_ORDER_LABEL}
          </div>

          {number ? (
            <div className="pi-detail-context-number-row">
              <span className="pi-detail-context-number">{number}</span>
              {reservation.canCopy && (
                <button
                  type="button"
                  className="pi-detail-copy"
                  onClick={() => onCopy(number)}
                  aria-label={copied ? 'Order number copied' : `Copy Order number ${number}`}
                >
                  {copied
                    ? <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                    : <Copy size={12} strokeWidth={2.2} aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
          ) : onReserve ? (
            <button
              type="button"
              onClick={onReserve}
              disabled={reserving}
              className="boe-btn boe-btn-primary"
              style={{ alignSelf: 'flex-start' }}
            >
              {reserving ? 'Reserving…' : RESERVE_ACTION_LABEL}
            </button>
          ) : (
            <div className="pi-detail-context-absent">Not reserved</div>
          )}

          {/* ONE LINE saying where the number stands. The blocked reason takes
              its place only where there is no number to stand. */}
          <div className="pi-detail-context-note">
            {!number && reservation.blockedReason ? reservation.blockedReason : reservation.standing}
          </div>

          {/* The Confirmed Order's number under its own label, never beside the
              reserved one without it. Read back from the Order — composed nowhere. */}
          {confirmedNumber && (
            <div className="pi-detail-context-note">
              {NUMBER_LABEL.confirmed}{' '}
              <strong className="pi-detail-context-confirmed">{confirmedNumber}</strong>
            </div>
          )}

          {reservationFailure && (
            <div role="alert" className="pi-detail-context-error">{reservationFailure}</div>
          )}
        </section>

        <section className="pi-detail-context-cell" aria-label={context.heading}>
          <div className="pi-detail-context-head">
            <div className="pi-detail-context-label">
              <Send size={12} strokeWidth={2.2} aria-hidden="true" />
              {context.heading}
            </div>
            <PiStatusBadge label={statusLabel} tone={tone} />
          </div>

          {context.submittedAt ? (
            <div className="pi-detail-context-who">
              <span className="pi-detail-context-name">{context.submittedBy ?? 'A colleague'}</span>
              <span className="pi-detail-context-when">{context.submittedAt}</span>
            </div>
          ) : (
            <div className="pi-detail-context-absent">{NOT_SUBMITTED_TEXT}</div>
          )}

          {/* Colour is never the only channel: every dot sits beside its words. */}
          <ul className="pi-detail-context-lines">
            {context.lines.map(line => (
              <li key={line.key} className="pi-detail-context-line">
                <span
                  className="pi-detail-context-dot"
                  style={{ background: CONTEXT_DOT[line.tone] }}
                  aria-hidden="true"
                />
                <span className="pi-detail-context-line-label">{line.label}</span>
                <span className="pi-detail-context-line-text">{line.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PiCard>
  )
}

/** The status dots, at the same intensity the activity trail uses. */
const CONTEXT_DOT: Record<PiDetailTone, string> = {
  neutral: '#A4ABB9',
  blue: '#5585E8',
  amber: '#D9A552',
  green: '#45A870',
  red: '#D94F4F',
}

// ── 2. The PI overview ────────────────────────────────────────────────────────

/** One icon per metadata item, so the strip scans without reading every label. */
const META_ICON: Record<OverviewMetaItem['key'], typeof User> = {
  salesperson: User,
  submittedBy: Send,
  created: CalendarDays,
}

/**
 * THE PI OVERVIEW: who it is for and when it moves, beside what it is worth.
 *
 * LEFT — the client (the name opens the contact dialog), a compact metadata
 * strip (Salesperson · PI submitted by · Created date, each said once), and the
 * two dates in a band of their own at a size that reads at a glance.
 *
 * RIGHT — three figures and nothing else: Product value, Total before GST, and
 * the billing declaration as a clear state. They fill their column; there is no
 * payment here, because payment has its own card below.
 *
 * NOT ONE FIGURE IS COMPUTED HERE. The two commercial figures are the breakdown's
 * own strings; billing is buildBillingSummary's. Every edit control is drawn from
 * a capability the page asked the database for, and every write re-derives it.
 */
export function PiSummaryCard({
  client, onOpenClient, workbookName, meta,
  dates, figures, billing, canEditBilling, onEditBilling,
  canEditDetails, onEditDetails, onEditSchedule, onRequestCorrection, missingSummary,
}: {
  client: ClientDetails
  /** Opens the client dialog. The card carries the name; the dialog carries
      the contact and the two parties. */
  onOpenClient: () => void
  /** Provenance, only when the record names a workbook. */
  workbookName: string | null
  /** Salesperson, PI submitted by, Created date. */
  meta: readonly OverviewMetaItem[]
  dates: readonly DateSummary[]
  /** The two commercial figures, picked out of the breakdown's own rows. */
  figures: readonly SummaryFigure[]
  /** The billing declaration, and what it comes to. */
  billing: BillingSummary
  /** can_edit_order_submission OR can_admin_edit_order_submission, as the page
      resolved them. set_order_submission_billing_percentage re-derives it. */
  canEditBilling: boolean
  onEditBilling: () => void
  /** The owner in draft/needs_changes, or an active admin at any stage. The
      client-details RPC re-derives the whole rule. */
  canEditDetails: boolean
  onEditDetails: () => void
  /** Opens the dates-and-terms section of the same editor. */
  onEditSchedule: () => void
  /** The OWNER's channel for a PI that has left their hands, or null. Shown
      INSTEAD OF the edit controls, never alongside them. */
  onRequestCorrection: (() => void) | null
  /** What this PI still needs before it can take a payment, or null. */
  missingSummary: string | null
}) {
  return (
    <PiCard>
      {/* ── What is still missing, and the way to fix it ── */}
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

      <div className="pi-detail-overview">
        <div className="pi-detail-overview-main">

          {/* THE NAME IS THE CONTROL, and it still looks like the name. The edit
              control is a sibling, never nested: a button cannot hold a button. */}
          <div className="pi-detail-summary-party">
            <button
              type="button"
              onClick={onOpenClient}
              className="pi-detail-summary-client"
              aria-haspopup="dialog"
              title="Contact number, billing and shipping details"
            >
              <MultilineText style={{
                fontSize: '18px', fontWeight: 700, color: colors.primary, margin: 0, lineHeight: 1.25,
              }}>
                {client.name}
              </MultilineText>
              <ChevronRight size={15} strokeWidth={2.2} className="pi-detail-summary-client-more" />
            </button>

            {canEditDetails && (
              <button
                type="button"
                onClick={onEditDetails}
                className="pi-detail-summary-inline-action"
                aria-haspopup="dialog"
                aria-label="Edit customer details"
              >
                <Pencil size={11} strokeWidth={2.1} aria-hidden="true" />
                Edit
              </button>
            )}
            {!canEditDetails && onRequestCorrection && (
              <button
                type="button"
                onClick={onRequestCorrection}
                className="pi-detail-summary-inline-action"
                aria-haspopup="dialog"
              >
                Request correction
              </button>
            )}
          </div>

          {workbookName && (
            <span className="pi-detail-overview-file" title={workbookName}>
              <FileSpreadsheet size={11.5} strokeWidth={1.9} style={{ flexShrink: 0 }} aria-hidden="true" />
              <span className="pi-detail-summary-file-name">{workbookName}</span>
            </span>
          )}

          {/* ── The metadata strip: icon, label, value — each fact once ── */}
          <dl className="pi-detail-meta">
            {meta.map(item => {
              const Icon = META_ICON[item.key]
              return (
                <div key={item.key} className="pi-detail-meta-item">
                  <Icon size={13} strokeWidth={2} className="pi-detail-meta-icon" aria-hidden="true" />
                  <dt className="pi-detail-meta-label">{item.label}</dt>
                  <dd className={item.value ? 'pi-detail-meta-value' : 'pi-detail-meta-absent'}>
                    {item.value ?? item.absent}
                  </dd>
                </div>
              )
            })}
          </dl>

          {/* ── The dates, at a size that reads at a glance ──
              The commitment stays secondary: a muted line under an absent due
              date, clamped, and never a date of its own. */}
          <section className="pi-detail-dates" aria-label="Order dates">
            <div className="pi-detail-dates-grid">
              {dates.map(date => (
                <div key={date.key} className="pi-detail-date">
                  <div className="pi-detail-date-label">{date.label}</div>
                  {date.value ? (
                    <div className="pi-detail-date-value">{date.value}</div>
                  ) : (
                    <div className="pi-detail-date-absent">{date.absent}</div>
                  )}
                  {date.note && <div className="pi-detail-date-note">{date.note}</div>}
                </div>
              ))}
            </div>
            {canEditDetails && (
              <button
                type="button"
                onClick={onEditSchedule}
                className="pi-detail-summary-inline-action pi-detail-dates-edit"
                aria-haspopup="dialog"
                aria-label="Edit dates and terms"
              >
                <Pencil size={11} strokeWidth={2.1} aria-hidden="true" />
                Edit
              </button>
            )}
          </section>
        </div>

        {/* ── Three figures, filling their column ── */}
        {/* The outer element is the CONTAINER the column's width is measured
            on; the grid inside it is what that width rearranges. A container
            query cannot restyle the element it measures. */}
        <div className="pi-detail-figures">
          <div className="pi-detail-figures-grid">
            {figures.map(figure => (
              <div key={figure.key} className="pi-detail-figure">
                <div className="pi-detail-figure-label">{figure.label}</div>
                <div className={figure.kind === 'missing' ? 'pi-detail-figure-absent' : 'pi-detail-figure-value'}>
                  {figure.value}
                </div>
              </div>
            ))}

            <div className="pi-detail-figure">
              <div className="pi-detail-figure-head">
                <span className="pi-detail-figure-label">{BILLING_LABEL}</span>
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
              {/* DECLARED IS A FIGURE; UNDECLARED IS A STATE. Never 0%, never a
                  muted word standing where a number should be. */}
              {billing.declared ? (
                <>
                  <div className="pi-detail-figure-value">{billing.percent}</div>
                  <div className="pi-detail-figure-sub">
                    {BILLING_VALUE_LABEL}{' '}
                    <span className={billing.amountMissing ? 'pi-detail-figure-sub-absent' : 'pi-detail-figure-sub-value'}>
                      {billing.amount}
                    </span>
                  </div>
                </>
              ) : (
                <span className="pi-detail-state-chip">{BILLING_NOT_DECLARED_LABEL}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </PiCard>
  )
}

// ── 2a. Payment status ────────────────────────────────────────────────────────

/**
 * WHERE THE MONEY STANDS, in one card: how much of the PI total has been
 * reported as received, and what that is made of.
 *
 * THE HEADLINE IS RECEIVED — the database's attached figure, confirmed plus
 * awaiting verification — as a share of the FULL PI total. Beside it are its two
 * parts: Confirmed (Finance verified it) in green, and Awaiting verification in
 * amber, each with the count of rows behind it. Under both, one bar: green,
 * amber, then red for what has not been received. The advance requirement is
 * the tick on the bar and changes no colour. Every figure arrived formatted —
 * see buildPaymentStatusView — and nothing here does arithmetic.
 *
 * EACH PART OPENS THE ROWS IT IS MADE OF, in the one Payment details dialog,
 * filtered. A part with no rows behind it is a plain block rather than a
 * control, so nothing invites a click that would open an empty list.
 *
 * THREE CONTROLS AT MOST, in the header. Add payment for somebody canAddPiPayment
 * allows; Payment details for everybody who can read the PI; and, for a viewer
 * the page resolved as a payment verifier, a way into the pending rows. That
 * control decides nothing — the rows' Approve and Reject run Finance's own doors.
 */
export function PiPaymentStatusCard({
  status, canAdd, canVerify, decidableCount, onAddPayment, onOpenDetails, notice, onDismissNotice,
}: {
  /** null only while the summary has not been read. */
  status: PaymentStatusView | null
  canAdd: boolean
  /** finance.approve with Finance module entry, as the page resolved it. */
  canVerify: boolean
  /** Pending rows a verifier could decide now. A count of rows. */
  decidableCount: number
  onAddPayment: () => void
  /** Opens Payment details on every row, or on the rows behind one figure. */
  onOpenDetails: (filter: PiPaymentFilter) => void
  notice: string | null
  onDismissNotice: () => void
}) {
  return (
    <PiCard>
      <section className="pi-detail-paystatus" aria-label={PAYMENT_STATUS_TITLE}>
        <div className="pi-detail-paystatus-head">
          <h2 className="pi-detail-paystatus-title">{PAYMENT_STATUS_TITLE}</h2>
          <div className="pi-detail-paystatus-actions">
            {canVerify && decidableCount > 0 && (
              <button type="button" className="boe-btn boe-btn-ghost" onClick={() => onOpenDetails('awaiting')} aria-haspopup="dialog">
                <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
                Verify {decidableCount} pending
              </button>
            )}
            {canAdd && (
              <button type="button" className="boe-btn boe-btn-primary" onClick={onAddPayment} aria-haspopup="dialog">
                Add payment
              </button>
            )}
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => onOpenDetails('all')} aria-haspopup="dialog">
              {PAYMENT_DETAILS_LABEL}
            </button>
          </div>
        </div>

        {status === null ? (
          <div style={{ fontSize: '12px', color: colors.muted }}>Loading…</div>
        ) : (
          <>
            <PiPaymentPosition status={status} onOpenDetails={onOpenDetails} />

            {notice && (
              <div className="pi-detail-paystatus-notice" role="status">
                <span>{notice}</span>
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
          </>
        )}
      </section>
    </PiCard>
  )
}

const METRIC_ICON: Record<PaymentMetric['key'], typeof Clock> = {
  confirmed: CheckCircle2,
  awaiting: Clock,
}

/**
 * One part of the received figure. A real button — focusable, announced as
 * opening a dialog — when there are rows behind it; a plain block when there are
 * none, so a zero never looks like somewhere to press.
 */
function PiPaymentMetric({ metric, onOpen }: { metric: PaymentMetric; onOpen: () => void }) {
  const Icon = METRIC_ICON[metric.key]
  const className = `pi-detail-paystatus-metric pi-detail-paystatus-metric-${metric.key}`
  const body = (
    <>
      <span className="pi-detail-paystatus-metric-label">
        <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
        {metric.label}
      </span>
      <span className="pi-detail-paystatus-metric-value">{metric.amount}</span>
      <span className="pi-detail-paystatus-metric-meta">{metric.meta}</span>
    </>
  )
  if (!metric.interactive) {
    return <div className={`${className} is-empty`} data-metric={metric.key}>{body}</div>
  }
  return (
    <button type="button" className={className} data-metric={metric.key} onClick={onOpen} aria-haspopup="dialog">
      {body}
      <ChevronRight size={15} strokeWidth={2.2} className="pi-detail-paystatus-metric-chevron" aria-hidden="true" />
    </button>
  )
}

/** The headline, its two parts, and the bar they make up — with the bar's key. */
function PiPaymentPosition({ status, onOpenDetails }: {
  status: PaymentStatusView
  onOpenDetails: (filter: PiPaymentFilter) => void
}) {
  const headline = describeReceivedHeadline(status)
  return (
    <div className="pi-detail-paystatus-body">
      <div className="pi-detail-paystatus-grid">
        <div className="pi-detail-paystatus-position">
          <div className="pi-detail-paystatus-headline">
            <span className="pi-detail-paystatus-percent">{headline.figure}</span>
            <span className="pi-detail-paystatus-word">{PAYMENT_STATUS_LABEL.received}</span>
          </div>
          <div className="pi-detail-paystatus-of">{headline.line}</div>
        </div>
        <div className="pi-detail-paystatus-metrics">
          {buildPaymentMetrics(status).map(metric => (
            <PiPaymentMetric key={metric.key} metric={metric} onOpen={() => onOpenDetails(metric.key)} />
          ))}
        </div>
      </div>

      <PiPaymentProgress
        confirmedPercent={status.barPercent}
        receivedPercent={status.receivedBarPercent}
        thresholdPercent={status.thresholdPercent}
        height={10}
        label={`Received: ${status.receivedPercent} of the PI total — ${status.percent} confirmed, ${status.pendingPercent} awaiting verification`}
      />

      <ul className="pi-detail-paystatus-legend">
        <li className="pi-detail-paystatus-legend-item">
          <span className="pi-detail-paystatus-swatch" style={{ background: PAYMENT_BAR_COLORS.confirmed }} aria-hidden="true" />
          {PAYMENT_STATUS_LABEL.confirmed}
        </li>
        <li className="pi-detail-paystatus-legend-item">
          <span className="pi-detail-paystatus-swatch" style={{ background: PAYMENT_BAR_COLORS.awaiting }} aria-hidden="true" />
          {PAYMENT_STATUS_LABEL.awaiting}
        </li>
        <li className="pi-detail-paystatus-legend-item">
          <span className="pi-detail-paystatus-swatch" style={{ background: PAYMENT_BAR_COLORS.unpaid }} aria-hidden="true" />
          {PAYMENT_STATUS_LABEL.unpaid}
        </li>
        {status.thresholdLabel && (
          <li className="pi-detail-paystatus-legend-item">
            <span className="pi-detail-paystatus-tick" aria-hidden="true" />
            {status.thresholdLabel} advance marker
          </li>
        )}
      </ul>
    </div>
  )
}

// ── 6a. The commercial breakdown ──────────────────────────────────────────────

export const BREAKDOWN_TITLE = 'Commercial breakdown'

/**
 * The PI total, large, then the lines that lead to it.
 *
 * THE ROWS ARE THE SHARED BUILDER'S, selected by buildBreakdownView and never
 * recomputed. Amounts are right-aligned tabular figures; a worded value
 * ("Included", "as applicable") keeps its words and a lighter weight. Total
 * before GST opens the tax group, the one rule inside the card.
 */
export function PiCommercialBreakdown({ view }: { view: BreakdownView }) {
  return (
    <PiCard>
      <section className="pi-detail-breakdown" aria-label={BREAKDOWN_TITLE}>
        <div className="pi-detail-breakdown-head">
          <div className="pi-detail-breakdown-title">{BREAKDOWN_TITLE}</div>
          {view.total && (
            <div className="pi-detail-breakdown-total">
              <span className="pi-detail-breakdown-total-label">{view.total.label}</span>
              <span className={view.total.kind === 'amount'
                ? 'pi-detail-breakdown-total-value'
                : 'pi-detail-breakdown-total-absent'}>
                {view.total.value}
              </span>
            </div>
          )}
        </div>
        <dl className="pi-detail-breakdown-rows">
          {view.rows.map(row => (
            <div
              key={row.key}
              className={row.groupStart ? 'pi-detail-breakdown-row pi-detail-breakdown-subtotal' : 'pi-detail-breakdown-row'}
            >
              <dt>{row.label}</dt>
              <dd className={row.kind === 'amount' ? 'pi-detail-breakdown-amount' : 'pi-detail-breakdown-word'}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </PiCard>
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
/**
 * Is anything still missing, and can a form fix it?
 *
 * Split out so the button, its title and the panel below it cannot disagree
 * about the answer — three copies of `readiness !== null && !readiness.ready`
 * is three chances for one of them to drift.
 */
function readinessState(readiness: PiReadiness | null) {
  const blocked = readiness !== null && !readiness.ready
  return {
    blocked,
    summary: blocked ? readiness.summary : null,
    missing: blocked ? readiness.missing : [],
  }
}

export function PiWorkflowPanel({
  panel,
  actions,
  status,
  reviewNote,
  employeeReply,
  advanceRefusal,
  blockingCount,
  readiness,
  onFixReadiness,
  acting,
  finance,
  approvalBlocker,
  approvalReady,
  decision = null,
  piApprovedLine = null,
  approvedOrder,
  onChangePi,
  onSubmit,
  onRequestChanges,
  onReject,
  onVerifyFinance,
  onApprove,
  onOpenOrder,
  openOrderHref = null,
  advanceBand,
  statusShownAbove = false,
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
  /**
   * EVERYTHING STILL MISSING, in one list, for the person who would submit.
   *
   * Before this, each requirement was discovered by being refused: submitting
   * named the client, fixing that named a product line, fixing that named an
   * image. The list is the whole remaining distance, computed once by
   * piReadiness and read identically by the approval control below and by the
   * finance dialog — which is what stops three surfaces disagreeing about
   * whether a record is ready.
   *
   * Null on a record where submitting is not the question.
   */
  readiness: PiReadiness | null
  /** Opens the editor at the first section a form can actually fix, or null. */
  onFixReadiness: ((section: PiRequirement['section']) => void) | null
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
  /**
   * WHICH DOOR this reviewer is offered (20261119000000): approve-and-create,
   * approve the PI only, or create the Order the PI already earned — with the
   * one sentence that goes beside it. When absent the panel falls back to the
   * single approve-and-create control the two props above describe.
   */
  decision?: ReviewDecision | null
  /** "PI approved by X · date", once the PI decision stands. */
  piApprovedLine?: string | null
  /** The Order this PI became, once it exists and this viewer can see it. */
  approvedOrder: ApprovedOrderView | null
  onChangePi: () => void
  onSubmit: () => void
  onRequestChanges: () => void
  onReject: () => void
  onVerifyFinance: () => void
  onApprove: () => void
  onOpenOrder: () => void
  /** The approved Order's page, when this reader can see it. Drawn as a real
   *  link; `onOpenOrder` remains for callers that have no href. */
  openOrderHref?: string | null
  /** The pending advance decision, or null. */
  advanceBand: React.ReactNode
  /**
   * True where the page already states who submitted the PI, when, and where
   * Finance and management stand — the context row above the overview. The
   * panel then keeps its controls and the notes people wrote, and drops the
   * three restatements: the metadata line, the finance line when there is
   * nothing to press on it, and the PI-approved line.
   */
  statusShownAbove?: boolean
}) {
  const tone = TONE_STYLE[panel.tone]
  const isReviewer = actions.canRequestChanges || actions.canReject
  const ownerActions = actions.canSubmit || actions.canChangePi
  const hasActions = isReviewer || ownerActions

  const {
    blocked: readinessBlocked,
    summary: readinessSummary,
    missing: readinessMissing,
  } = readinessState(readiness)

  // SHOWN AND DISABLED, never hidden. A control that vanishes takes the reason
  // with it; a disabled one with the list above it says what to do next.
  const submitBlocked = readinessBlocked
  const submitTitle = blockingCount > 0
    ? 'Fix the issues in the PI first'
    : (readinessSummary ?? undefined)
  // The primary control: the decision's door when the page resolved one, the
  // plain approve-and-create control otherwise. `decision.rpc === null` means
  // no door is open — the PI is approved and the money is somebody else's
  // move, or something other than payment blocks it.
  const primaryLabel = decision?.label ?? APPROVE_BUTTON_LABEL
  const primaryDisabled = decision ? decision.rpc === null : !approvalReady
  const primaryNote = decision ? decision.note : approvalBlocker

  // What the context row already says is not said again. The Verify Finance
  // control is never dropped: it is an action, not a restatement.
  const showMeta = panel.meta !== null && !statusShownAbove
  const showFinance = finance !== null && (!statusShownAbove || finance.canVerify)
  const showPiApproved = piApprovedLine !== null && !statusShownAbove

  const hasBody = Boolean(
    panel.instruction || reviewNote || employeeReply || advanceRefusal
    || showFinance || approvedOrder || showPiApproved || (isReviewer && primaryNote),
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
  if (!hasActions && !hasBody && !showMeta && !advanceBand) return null

  return (
    <PiCard style={panel.closed ? undefined : { borderColor: tone.border }}>
      <div className="pi-detail-workflow-head">
        <div style={{ minWidth: '200px', flex: '1 1 260px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
            {panel.heading}
          </div>
          {showMeta && (
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '3px' }}>
              {panel.meta}
            </div>
          )}
        </div>

        {/* ── WHAT IS STILL MISSING, ALL OF IT, BEFORE ANYTHING IS PRESSED ──
            Above the actions rather than beside the button: it is a list, and a
            list does not fit in a tooltip. Each entry that a form can fix is a
            way in to that form; each one that only a corrected workbook can fix
            says so instead of offering a control that would refuse. */}
        {ownerActions && readinessBlocked && (
          <div style={{
            margin: '10px 0 0', padding: '10px 12px', borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised,
            display: 'flex', flexDirection: 'column', gap: '6px',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
              {readinessSummary}
            </div>
            <ul style={{ margin: 0, paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {readinessMissing.map(requirement => (
                <li key={requirement.key} style={{ fontSize: '11.5px', color: colors.secondary }}>
                  {requirement.label}
                  {requirement.needsReimport
                    ? ' — a corrected workbook is needed'
                    : ''}
                  {/* NO "Add" FOR AN INCOMPLETE PRODUCT LINE, on purpose. The
                      list counts them rather than naming them — eleven lines
                      each missing an image is one sentence a reader can act on
                      and eleven sentences is a wall — so a button here would
                      have to guess which row it meant. Each line carries its
                      own Edit control in the table below, where the reader can
                      see which one is short of what. */}
                  {!requirement.needsReimport
                    && requirement.section !== 'products'
                    && onFixReadiness && (
                    <button
                      type="button"
                      className="boe-btn boe-btn-ghost"
                      style={{ marginLeft: '8px' }}
                      onClick={() => onFixReadiness(requirement.section)}
                      disabled={acting}
                    >
                      Add
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

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
                  disabled={acting || blockingCount > 0 || submitBlocked}
                  title={submitTitle}
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
                  className="boe-btn boe-btn-primary pi-approve-btn"
                  onClick={onApprove}
                  disabled={acting || primaryDisabled}
                  title={primaryNote ?? undefined}
                >
                  <CheckCircle2 size={13} strokeWidth={2} />
                  {primaryLabel}
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
            <PiApprovedOrderStrip order={approvedOrder} onOpen={onOpenOrder} href={openOrderHref} acting={acting} />
          )}
          {/* Where finance stands: one compact line, never a card of its own.
              A second full-size panel for a single boolean would outweigh the
              decision it reports. */}
          {showFinance && finance && (
            <PiFinanceLine finance={finance} acting={acting} onVerify={onVerifyFinance} />
          )}
          {/* THE PI DECISION, once it stands: one line, the same weight as the
              finance line above it — unless the context row already says it. */}
          {showPiApproved && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap',
              fontSize: '12px', color: TONE_STYLE.green.color, lineHeight: 1.5,
            }}>
              <ShieldCheck size={13} strokeWidth={2} />
              <span>{piApprovedLine}</span>
            </div>
          )}
          {/* Why the primary action cannot be pressed yet, or what it will and
              will not do — for the reviewer it is addressed to, and nobody else. */}
          {isReviewer && primaryNote && (
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
              {primaryNote}
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
export function PiApprovedOrderStrip({ order, onOpen, href = null, acting }: {
  order: ApprovedOrderView
  onOpen: () => void
  /** When given, the control is a link — it opens in this tab, or a new one on
   *  request. It used to be a button wearing an "external link" icon while
   *  navigating in the same tab: the icon promised a new tab that never came. */
  href?: string | null
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
      {href && !acting ? (
        <Link href={href} className="boe-btn boe-btn-ghost" style={{ marginLeft: 'auto' }}>
          {OPEN_ORDER_BUTTON_LABEL}
          <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
        </Link>
      ) : (
        <button
          className="boe-btn boe-btn-ghost"
          onClick={onOpen}
          disabled={acting}
          style={{ marginLeft: 'auto' }}
        >
          {OPEN_ORDER_BUTTON_LABEL}
          <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
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
            className="boe-btn boe-btn-primary pi-approve-btn"
            onClick={onApprove}
            disabled={acting}
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
