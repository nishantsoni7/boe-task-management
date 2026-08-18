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
  AlertTriangle, Ban, CheckCircle2, FileSpreadsheet, History,
  Info, Lock, Percent, Send, ThumbsUp, Undo2, Upload, Wallet,
} from 'lucide-react'
import { MultilineText } from '@/components/ui/MultilineText'
import { PiCard, PiCardHeader, PiDiagnosticList } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { draftStatusLabel, type PiDraftStatusTone } from '@/lib/orders/draftsView'
import {
  APPROVE_BUTTON_LABEL,
  APPROVE_DISABLED_REASON,
  CHANGE_PI_BUTTON_LABEL,
  REJECT_BUTTON_LABEL,
  REQUEST_CHANGES_BUTTON_LABEL,
  submitButtonLabel,
  type SubmissionActions,
} from '@/lib/orders/submissionWorkflow'
import {
  ADVANCE_NOT_A_PAYMENT,
  ADVANCE_SECTION_TITLE,
  ADVANCE_ZERO_EXPLANATION,
  APPROVE_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_BUTTON_LABEL,
  type AdvanceView,
} from '@/lib/orders/advanceRequirement'
import { BLOCKING_PANEL_TITLE, WARNING_PANEL_TITLE, type PiDiagnosticEntry } from '@/lib/pi/previewView'
import type { ActivityEntry, PiActivityTone } from '@/lib/orders/submissionActivity'
import {
  BLOCKING_INSTRUCTION,
  NOT_PROVIDED,
  STORED_COPY_NOTE,
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

/** A label over its value, or a quiet note when the PI did not say. */
function Field({ label, value, strong = false }: {
  label: string
  value: string | null
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
      {value === null ? (
        <div style={{ fontSize: '12.5px', color: colors.muted, fontStyle: 'italic' }}>
          {NOT_PROVIDED}
        </div>
      ) : (
        <MultilineText style={{
          fontSize: strong ? '13.5px' : '12.5px',
          fontWeight: strong ? 600 : 400,
          color: strong ? colors.primary : colors.secondary,
          margin: 0,
        }}>
          {value}
        </MultilineText>
      )}
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

/** One label-and-figure line in the snapshot. */
function SnapshotRow({ label, value, tone = 'plain' }: {
  label: string
  value: React.ReactNode
  tone?: 'plain' | 'strong'
}) {
  return (
    <div style={{
      display: 'flex', gap: '14px', justifyContent: 'space-between',
      alignItems: 'baseline', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: '11.5px', color: colors.muted }}>{label}</span>
      <span style={{
        fontSize: tone === 'strong' ? '13px' : '12.5px',
        fontWeight: tone === 'strong' ? 700 : 600,
        color: colors.primary, textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  )
}

/**
 * The one strong card under the page identity: who and where, when, and what it
 * is worth.
 *
 * THE CLIENT IS NOT REPEATED. It is the page title, and Bill to / Ship to carry
 * the destinations a reader actually compares. Printing it a third time inside
 * this card is what made the old overview feel like a field dump.
 */
export function PiOrderOverview({ billTo, shipTo, dates, snapshot }: {
  billTo: string | null
  shipTo: string | null
  dates: readonly OverviewDate[]
  snapshot: CommercialSnapshot
}) {
  const statusTone = snapshot.statusTone ? TONE_STYLE[snapshot.statusTone] : null

  return (
    <PiCard>
      <div className="pi-detail-overview">

        {/* A — who it is for and where it goes. Given real width, because an
            address is the one field on this card that needs to be read rather
            than glanced at. */}
        <section className="pi-detail-overview-section">
          <SectionLabel icon={<Send size={12} strokeWidth={2} />}>Client &amp; delivery</SectionLabel>
          <Field label="Bill to" value={billTo} strong />
          <Field label="Ship to" value={shipTo} strong />
        </section>

        {/* B — when. Only the dates that exist, plus the moment the record moved. */}
        <section className="pi-detail-overview-section pi-detail-overview-divided">
          <SectionLabel icon={<History size={12} strokeWidth={2} />}>Timeline</SectionLabel>
          {dates.map(date => (
            <Field key={date.key} label={date.label} value={date.value} />
          ))}
        </section>

        {/* C — what it is worth, and on what advance condition. The strongest
            part of the card and the reason it is not a uniform grid. */}
        <section className="pi-detail-overview-section pi-detail-snapshot pi-detail-overview-divided">
          <SectionLabel icon={<Wallet size={12} strokeWidth={2} />}>Commercial snapshot</SectionLabel>

          <div>
            <div style={{
              fontSize: '10px', fontWeight: 600, color: colors.muted,
              textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px',
            }}>
              Grand Total
            </div>
            <div className="pi-detail-snapshot-total" style={{ color: colors.primary }}>
              {snapshot.grandTotal}
            </div>
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '3px' }}>
              {snapshot.productLines}
            </div>
          </div>

          <div className="pi-detail-snapshot-rows">
            {/* The standard is always shown, even under an exception: the
                decision being asked for is a comparison, and half a comparison
                is not one. */}
            <SnapshotRow label={snapshot.standardAdvanceLabel} value={snapshot.standardAdvanceAmount} />
            <SnapshotRow label="Advance condition" value={snapshot.conditionLabel} tone="strong" />
            {snapshot.exceptionFigures && (
              <SnapshotRow label="Proposed advance" value={snapshot.exceptionFigures} tone="strong" />
            )}
          </div>

          {snapshot.statusLabel && statusTone && (
            <div>
              <PiStatusBadge label={`Exception · ${snapshot.statusLabel}`} tone={statusTone} />
            </div>
          )}
        </section>

      </div>
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
 * of this viewer.
 *
 * WHY IT IS ONE PANEL. The old page had the employee's actions in one card, the
 * reviewer's in a second, the advance condition in a third or fourth depending
 * on who was looking, and all of them BELOW the product table — so a person had
 * to scroll past twelve products to find out that nothing was being asked of
 * them. The state, the instruction, the reply, the PI actions and the advance
 * decision are one question with several parts; they are one panel with several
 * bands.
 *
 * THE TWO DECISIONS STAY SEPARATE INSIDE IT. Sending a PI back and settling one
 * of its commercial terms are different acts by possibly different people, so
 * the advance band has its own rule and its own quieter ground — and the PI's
 * own Approve stays disabled whatever happens to the advance.
 */
export function PiWorkflowPanel({
  panel,
  actions,
  status,
  reviewNote,
  employeeReply,
  blockingCount,
  acting,
  onChangePi,
  onSubmit,
  onRequestChanges,
  onReject,
  advanceBand,
}: {
  panel: WorkflowPanel
  actions: SubmissionActions
  status: string
  /** management's note — the correction instruction, or the rejection reason. */
  reviewNote: string | null
  /** The employee's reply on the current submission, off the trail. */
  employeeReply: string | null
  blockingCount: number
  acting: boolean
  onChangePi: () => void
  onSubmit: () => void
  onRequestChanges: () => void
  onReject: () => void
  /** The advance requirement band, or null when the record has none to show. */
  advanceBand: React.ReactNode
}) {
  const tone = TONE_STYLE[panel.tone]
  const isReviewer = actions.canRequestChanges || actions.canReject
  const ownerActions = actions.canSubmit || actions.canChangePi
  const hasActions = isReviewer || ownerActions

  return (
    <PiCard style={panel.closed ? undefined : { borderColor: tone.border }}>
      <div className="pi-detail-workflow-head">
        <div style={{ minWidth: '220px', flex: '1 1 280px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            fontSize: '14px', fontWeight: 700, color: colors.primary,
          }}>
            {panel.heading}
          </div>
          {panel.standing && (
            <div style={{
              fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '3px',
              maxWidth: '62ch',
            }}>
              {panel.standing}
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
                {/* Present, inert, and NARROW. It used to carry its whole
                    explanation inline, which made the one control nobody can
                    press the widest thing in the row; the reason now sits under
                    the row as a muted line. */}
                <span
                  title={APPROVE_DISABLED_REASON}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '6px 12px', borderRadius: '5px',
                    fontSize: '12px', fontWeight: 600,
                    background: colors.raised, color: colors.muted,
                    border: `1px solid ${colors.border}`,
                    cursor: 'not-allowed', whiteSpace: 'nowrap',
                  }}
                >
                  <Lock size={12} strokeWidth={2} />
                  {APPROVE_BUTTON_LABEL}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {(isReviewer || reviewNote || employeeReply) && (
        <div style={{
          padding: '0 20px 15px',
          display: 'flex', flexDirection: 'column', gap: '9px',
        }}>
          {isReviewer && (
            <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
              {APPROVE_BUTTON_LABEL}: {APPROVE_DISABLED_REASON}
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
        </div>
      )}

      {advanceBand && <div className="pi-detail-workflow-band">{advanceBand}</div>}
    </PiCard>
  )
}

// ── The advance requirement band ──────────────────────────────────────────────
//
// ONE COMPONENT, THREE AUDIENCES: the employee reading their own record, a PI
// reviewer, and an authorised exception approver. What differs between them is
// only whether the two decision CONTROLS are drawn — the STATE is shown to
// everybody who can read the PI, because a record waiting on somebody else's
// decision must not look inert to the person waiting.
//
// NO PAYMENT LANGUAGE. Not "received", not "paid", not "collected". The figures
// are what would be required, and the footnote says so.

function AdvanceRow({ label, value, tone = 'plain' }: {
  label: string
  value: React.ReactNode
  tone?: 'plain' | 'strong'
}) {
  return <SnapshotRow label={label} value={value} tone={tone} />
}

const EXCEPTION_STATUS_TONE: Record<string, ToneStyle> = {
  pending:  { bg: colors.amberTint, color: '#9A6212', border: 'rgba(232,160,48,0.35)' },
  approved: { bg: colors.greenTint, color: '#2F7A52', border: 'rgba(69,168,112,0.35)' },
  rejected: { bg: colors.redTint,   color: colors.red, border: 'rgba(217,79,79,0.35)' },
}

export function PiAdvanceBand({
  advance,
  canDecide,
  acting,
  rejectedInstruction,
  requesterName,
  deciderName,
  requestedAt,
  decidedAt,
  onApprove,
  onReject,
}: {
  advance: AdvanceView
  /** Whether THIS viewer may settle a pending proposal. */
  canDecide: boolean
  acting: boolean
  /** Shown to the employee whose proposal was refused, and to nobody else. */
  rejectedInstruction: string | null
  requesterName: string | null
  deciderName: string | null
  requestedAt: string | null
  decidedAt: string | null
  onApprove: () => void
  onReject: () => void
}) {
  const statusTone = advance.status ? EXCEPTION_STATUS_TONE[advance.status] : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
        <Percent size={13} strokeWidth={2} color={colors.tertiary} />
        <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
          {ADVANCE_SECTION_TITLE}
        </span>
        {advance.statusLabel && statusTone && (
          <span style={{ marginLeft: 'auto' }}>
            <PiStatusBadge label={advance.statusLabel} tone={statusTone} />
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <AdvanceRow
          label={`Standard requirement (${advance.standardPercentLabel})`}
          value={advance.standardAmount}
        />
        <AdvanceRow
          label="Selected condition"
          value={advance.undeclared ? 'Not declared' : advance.conditionLabel}
        />
        {advance.exceptionPercentLabel && (
          <AdvanceRow
            label="Proposed advance"
            value={`${advance.exceptionPercentLabel}${advance.exceptionAmount ? ` · ${advance.exceptionAmount}` : ''}`}
            tone="strong"
          />
        )}
      </div>

      {advance.isZeroPercent && (
        <div style={{ fontSize: '11.5px', color: '#9A6212', lineHeight: 1.45 }}>
          {ADVANCE_ZERO_EXPLANATION}
        </div>
      )}

      {/* The employee's own words — what the decision is actually about, so not
          squeezed into a row. */}
      {advance.requestReason && (
        <QuotedNote heading="Employee&rsquo;s reason" body={advance.requestReason} tone="neutral" />
      )}

      {advance.rejectionReason && (
        <QuotedNote heading="Why it was refused" body={advance.rejectionReason} tone="red" />
      )}

      {(requestedAt || decidedAt) && (
        <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
          {requestedAt && (
            <div>Requested by {requesterName ?? 'a colleague'} on {requestedAt}</div>
          )}
          {decidedAt && (
            <div>Decided by {deciderName ?? 'a colleague'} on {decidedAt}</div>
          )}
        </div>
      )}

      {rejectedInstruction && (
        <div style={{
          fontSize: '11.5px', color: colors.primary, lineHeight: 1.5,
          background: colors.amberTint, border: '1px solid rgba(232,160,48,0.3)',
          borderRadius: '7px', padding: '8px 11px',
        }}>
          {rejectedInstruction}
        </div>
      )}

      {/* The two decision controls, for somebody who holds the authority.
          Approve is a CONTAINED POSITIVE action and deliberately looks nothing
          like the disabled "Approve" above it: that one approves the PI and
          cannot be pressed, this one settles one commercial term. */}
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

      <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
        {ADVANCE_NOT_A_PAYMENT}
      </div>
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

const TIMELINE_MARKER: Record<PiActivityTone, string> = {
  neutral: colors.muted,
  blue: colors.blue,
  amber: colors.amber,
  green: colors.green,
  red: colors.red,
}

/**
 * The append-only trail as an audit timeline: a marker, a connecting rule, and
 * what happened.
 *
 * IT IS A HISTORY AND NOT A CONTROL. No ids, no raw metadata, no status enums —
 * only what happened, who did it, when, whatever note they left, and (for the
 * three advance events) the percentage and amount that WERE the event.
 *
 * NEWEST FIRST, unchanged. describeActivityEntries decides the order and has
 * done since the trail existed; reversing it here would silently change what a
 * reader finds at the top of a record they have read before.
 */
export function PiActivityTimeline({ entries }: { entries: readonly ActivityEntry[] }) {
  return (
    <PiCard>
      <PiCardHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <History size={15} strokeWidth={1.9} color={colors.tertiary} />
            Activity
          </span>
        }
        right={
          <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
            {entries.length} event{entries.length === 1 ? '' : 's'}
          </span>
        }
      />
      {entries.length === 0 ? (
        <div style={{ padding: '16px 20px', fontSize: '12px', color: colors.secondary }}>
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
                  <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
                    {entry.at}
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: colors.secondary, marginTop: '2px' }}>
                  {entry.actor}
                  {entry.figures && (
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}> · {entry.figures}</span>
                  )}
                </div>
                {entry.detail && (
                  <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.45, marginTop: '2px' }}>
                    {entry.detail}
                  </div>
                )}
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
 * Commercial breakdown beside the activity trail — how the total was reached,
 * and what has happened to the record — as one band under the products.
 *
 * They are side by side because neither needs full width and both are reference
 * material: the decisions are all above the table, and these two are what a
 * reader drops to when they want to check one. On a narrow screen they stack in
 * that order, and neither is hidden or collapsed.
 */
export function PiLowerGrid({ commercial, activity }: {
  commercial: React.ReactNode
  activity: React.ReactNode
}) {
  return (
    <div className="pi-detail-lower-grid">
      <div style={{ minWidth: 0 }}>{commercial}</div>
      <div style={{ minWidth: 0 }}>{activity}</div>
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
