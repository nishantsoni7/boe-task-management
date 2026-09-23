'use client'

// THE THREE-COLUMN STATUS WORKSPACE, above the product list.
//
// PAGE-OWNED, like OrderWorkspace.tsx and OrderPiSections.tsx beside it.
// EVERY COMPONENT HERE IS A FUNCTION OF ITS PROPS: nothing fetches, writes,
// authorizes or decides. Which PI is in force is orderMainPi's answer; what the
// advance comes to is the shared finance position's; who may move a Fabric or
// Finish status is the database's, re-derived under a row lock every time.
// These draw the answers.
//
// TWO ROWS OF CARDS, EACH IN ONE FIXED ORDER, sharing one grid and therefore
// one set of breakpoints:
//
//   Order status     Advance Received, Fabric & Finish — the operational cards,
//                    the second of which is the one place either approval is
//                    moved.
//   Current Status   Main PI, Design Files, Manufacturing Status — read-only,
//                    directly above the product list, for a reader who wants
//                    the Order's position without opening three screens.
//
// They stack in those same orders on a narrow screen, so a person describing
// the screen over the phone is describing the same thing whatever the other
// person is holding.

import { useCallback, useEffect, useRef } from 'react'
import { Download, FileSpreadsheet, History, Upload, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MultilineText } from '@/components/ui/MultilineText'
import type { PiViewerItem } from '@/lib/pi/previewView'
import {
  MAIN_PI_APPROVED_LABEL,
  MAIN_PI_DOWNLOAD_LABEL,
  MAIN_PI_HISTORY_LABEL,
  MAIN_PI_UPLOADED_LABEL,
  MAIN_PI_VIEW_LABEL,
  PI_HISTORY_CURRENT_BADGE,
  PI_HISTORY_MODAL_EMPTY,
  PI_HISTORY_MODAL_TITLE,
  REMARK_LABEL,
  type MainPiCard,
  type PiTimelineEntry,
} from '@/lib/orders/orderMainPi'
import {
  APPROVE_REVISION_BUTTON_LABEL,
  REJECT_REVISION_BUTTON_LABEL,
  UPLOAD_REVISION_BUTTON_LABEL,
  type PiVersionTone,
  type PiVersionView,
} from '@/lib/orders/orderPiVersions'
import { DESIGN_IMAGES_LOADING } from '@/lib/orders/orderCurrentStatus'
import {
  ACCEPT_FOR_PRODUCTION_LABEL,
  CANNOT_ACCEPT_LABEL,
  OPERATIONS_REVIEW_ANCHOR,
  OPERATIONS_REVIEW_TITLE,
  ACCEPTANCE_MEANING,
  OPEN_CURRENT_PI_LABEL,
  OPEN_PREVIOUS_PI_LABEL,
  REVISION_COMPARE_NOTE,
  WITHDRAW_ACCEPTANCE_LABEL,
  type OperationsHandoffTone,
  type OperationsHandoffView,
  type describeOperationsHandoffHistory,
} from '@/lib/orders/operationsHandoff'
import {
  CLIENT_PO_UNSUPPORTED_NOTE,
  DOCUMENTS_TITLE,
  DOC_CLIENT_PO_TITLE,
  DOC_DESIGN_FILES_TITLE,
  DOC_MAIN_PI_TITLE,
  DOC_VIEW_FILES_LABEL,
  DOC_NOT_ATTACHED,
  type ClientPoDocument,
  type DesignFilesDocument,
} from '@/lib/orders/orderDocumentsPanel'
import {
  APPROVAL_HISTORY_LABEL,
  APPROVAL_STATUS_LABEL,
  EVIDENCE_VIEW_LABEL,
  FABRIC_FINISH_TITLE,
  FABRIC_FINISH_UPDATE_LABEL,
  type ApprovalStanding,
} from '@/lib/orders/orderApprovals'

// ── Shared chrome ─────────────────────────────────────────────────────────────

export type StatusTone = 'green' | 'amber' | 'red' | 'neutral'

const TONE: Record<StatusTone, { bg: string; fg: string; border: string }> = {
  green:   { bg: colors.greenTint, fg: '#2F7A52', border: 'rgba(69,168,112,0.32)' },
  amber:   { bg: colors.amberTint, fg: '#9A6A12', border: 'rgba(190,140,40,0.30)' },
  red:     { bg: colors.redTint,   fg: '#B42318', border: 'rgba(217,79,79,0.32)' },
  neutral: { bg: colors.raised,    fg: colors.secondary, border: colors.border },
}

/**
 * A status, in words first.
 *
 * COLOUR IS NEVER THE MESSAGE. Every pill below carries the word as well as the
 * tint, so nothing on this workspace depends on a reader telling amber from
 * red — the same rule the Order status pill in the command header follows.
 */
export function StatusPill({ label, tone, strong = false }: {
  label: string
  tone: StatusTone
  strong?: boolean
}) {
  const t = TONE[tone]
  return (
    <span
      className={strong ? 'order-status-chip order-status-chip--strong' : 'order-status-chip'}
      style={{ background: t.bg, color: t.fg, borderColor: t.border }}
    >
      {label}
    </span>
  )
}

function CardShell({ title, right, children, id }: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
  /** A fragment target, so a notification can open the page AT this card. */
  id?: string
}) {
  return (
    <section className="order-status-card" aria-label={title} id={id}>
      <div className="order-status-card-head">
        <h3 className="order-status-card-title">{title}</h3>
        {right}
      </div>
      <div className="order-status-card-body">{children}</div>
    </section>
  )
}

/** A label above its value, the shape all three cards state a fact in. */
function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="order-status-fact">
      <dt className="order-status-fact-label">{label}</dt>
      <dd className="order-status-fact-value" style={tone ? { color: tone } : undefined}>{value}</dd>
    </div>
  )
}

// ── 1. Main PI ────────────────────────────────────────────────────────────────

/**
 * THE PI THIS ORDER IS ACTUALLY RUNNING ON.
 *
 * The latest APPROVED version — never the latest upload. A pending revision is
 * reported as a line under the facts rather than as the headline, because the
 * document in force has not changed until somebody approves it.
 *
 * NO URL IS EVER BUILT INTO THE MARKUP. View and Download both call back to the
 * page, which signs the object on the click through the reader's own session;
 * the storage policy decides again at that moment. That is the same pattern the
 * PI workbook and the product photographs already use, and it is why a key
 * copied out of this page stops working within the hour.
 */
/**
 * ONE SUBSECTION OF THE DOCUMENTS BOX: a title, what is on file, and the
 * actions for it.
 *
 * THE SAME THREE-PART SHAPE FOR ALL THREE, so a reader learns the box once. The
 * title column is fixed on desktop, which is what lines the three bodies up
 * into a column that can be scanned rather than read; below 720px the parts
 * stack and the actions wrap under what they act on.
 */
function DocSection({ title, children, actions }: {
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="order-doc-section" aria-label={title}>
      <h3 className="order-doc-section-title">{title}</h3>
      <div className="order-doc-section-body">{children}</div>
      {actions && <div className="order-doc-section-actions">{actions}</div>}
    </section>
  )
}

/** An absent document, said quietly. Never an alarm: most Orders carry none. */
function DocEmpty({ message, note }: { message: string; note?: string | null }) {
  return (
    <>
      <p className="order-doc-empty">{message}</p>
      {note && <p className="order-doc-note">{note}</p>}
    </>
  )
}

/**
 * THE DOCUMENTS BOX — the PI this Order runs on, the design files behind its
 * products, and the client's own purchase order, in one card with rules between
 * them.
 *
 * WHAT IT REPLACED. A Main PI card and a Design Files card side by side, each
 * with its own heading, its own padding and its own outline, and both restating
 * the fabric and finish approvals that the card beside them states in full.
 * Three separate outlines for one question — "what paperwork does this Order
 * have?" — and a row of white space under the shorter of them.
 *
 * NOT ONE ACTION LEFT THE PAGE. View and Download hand the browser a file
 * through a URL signed on the press; PI History and View files open dialogs
 * over this page. Nothing here navigates to a PI screen, a document screen or
 * another module.
 */
export function OrderDocumentsPanel({
  mainPi, design, clientPo,
  onView, onDownload, onHistory, onManageDesign,
  viewing, downloading,
}: {
  mainPi: MainPiCard
  design: DesignFilesDocument
  clientPo: ClientPoDocument
  onView: (version: PiVersionView) => void
  onDownload: (version: PiVersionView) => void
  onHistory: () => void
  /** Opens the design-file dialog. Absent when there is nothing to open. */
  onManageDesign: () => void
  viewing: boolean
  downloading: boolean
}) {
  return (
    <section className="order-docs" aria-label={DOCUMENTS_TITLE}>
      <h2 className="order-docs-title">{DOCUMENTS_TITLE}</h2>

      {/* ── 1. The PI this Order runs on ── */}
      <DocSection
        title={DOC_MAIN_PI_TITLE}
        actions={
          <>
            {mainPi.kind === 'ready' && (
              <>
                <button
                  type="button"
                  className="boe-btn boe-btn-ghost order-doc-action"
                  onClick={() => onView(mainPi.version)}
                  disabled={!mainPi.hasFile || viewing}
                  title={mainPi.fileName ?? mainPi.reference}
                >
                  <FileSpreadsheet size={13} strokeWidth={2} aria-hidden="true" />
                  {viewing ? 'Opening…' : MAIN_PI_VIEW_LABEL}
                </button>
                <button
                  type="button"
                  className="boe-btn boe-btn-ghost order-doc-action"
                  onClick={() => onDownload(mainPi.version)}
                  disabled={!mainPi.hasFile || downloading}
                  title={mainPi.fileName ?? mainPi.reference}
                >
                  <Download size={13} strokeWidth={2} aria-hidden="true" />
                  {downloading ? 'Preparing…' : MAIN_PI_DOWNLOAD_LABEL}
                </button>
              </>
            )}
            {/* THE HISTORY IS OFFERED WHETHER OR NOT A PI IS IN FORCE: an Order
                whose only version is a pending revision has a history worth
                reading, and that is exactly when a reader asks for it. */}
            <button type="button" className="boe-btn boe-btn-ghost order-doc-action" onClick={onHistory}>
              <History size={13} strokeWidth={2} aria-hidden="true" />
              {MAIN_PI_HISTORY_LABEL}
            </button>
          </>
        }
      >
        {mainPi.kind !== 'ready' ? (
          <DocEmpty message={DOC_NOT_ATTACHED} note={mainPi.message} />
        ) : (
          <>
            <p className="order-doc-lead">
              <span className="order-doc-lead-value">{mainPi.reference}</span>
              <StatusPill label={mainPi.statusLabel} tone="green" />
            </p>
            <dl className="order-doc-facts">
              <Fact label={MAIN_PI_UPLOADED_LABEL} value={mainPi.uploadedAt} />
              {/* Absent rather than guessed: see MainPiCard.approvedAt. */}
              {mainPi.approvedAt && <Fact label={MAIN_PI_APPROVED_LABEL} value={mainPi.approvedAt} />}
            </dl>
            {mainPi.pendingRevision && (
              <p className="order-doc-note">
                A revised PI is uploaded and waiting for a decision. This one stays in force until it is approved.
              </p>
            )}
          </>
        )}
      </DocSection>

      {/* ── 2. The design record behind the products ──
          FOUR STATES AND NO FIFTH (PR #195): loading is not "none", a refused
          read is not "none", and an empty read says so in its own words. */}
      <DocSection
        title={DOC_DESIGN_FILES_TITLE}
        actions={design.kind === 'ready' ? (
          <button type="button" className="boe-btn boe-btn-ghost order-doc-action" onClick={onManageDesign}>
            {DOC_VIEW_FILES_LABEL}
          </button>
        ) : undefined}
      >
        {design.kind === 'loading' && (
          <p className="order-doc-loading" role="status">{DESIGN_IMAGES_LOADING}</p>
        )}
        {design.kind === 'unavailable' && (
          <>
            <p className="order-doc-unavailable">{design.message}</p>
            <p className="order-doc-note">{design.note}</p>
          </>
        )}
        {design.kind === 'empty' && <DocEmpty message={design.message} note={design.note} />}
        {design.kind === 'ready' && (
          <>
            <p className="order-doc-lead">
              <span className="order-doc-lead-value">{design.summary}</span>
              <StatusPill label="Attached" tone="green" />
            </p>
            <p className="order-doc-note">{design.detail}</p>
          </>
        )}
      </DocSection>

      {/* ── 3. The client's own purchase order ──
          NO STORE EXISTS YET and this says so in one muted line rather than
          offering a control that could not keep what it took. See
          orderDocumentsPanel.ts for the audit behind that. */}
      <DocSection title={DOC_CLIENT_PO_TITLE}>
        {clientPo.kind === 'ready' ? (
          <>
            <p className="order-doc-lead">
              <span className="order-doc-lead-value">{clientPo.summary}</span>
              <StatusPill label="Attached" tone="green" />
            </p>
            {clientPo.detail && <p className="order-doc-note">{clientPo.detail}</p>}
          </>
        ) : (
          <DocEmpty
            message={clientPo.kind === 'unsupported' ? clientPo.message : DOC_NOT_ATTACHED}
            note={clientPo.kind === 'unsupported' ? clientPo.note : CLIENT_PO_UNSUPPORTED_NOTE}
          />
        )}
      </DocSection>
    </section>
  )
}

/**
 * WHERE THE TWO APPROVALS STAND, AND WHEN EACH LAST MOVED.
 *
 * A date is drawn only for a status that HAS one: `Not Approved` is where every
 * Order starts, and dating it would date an event that never happened.
 *
 * THE UPDATE CONTROL IS A COURTESY, NOT THE SECURITY. It is drawn for the
 * assigned salesperson, an admin or a manager, and never under View As — and
 * record_order_approval_event() re-derives every bit of that under a row lock,
 * so a direct call from somebody who never saw the button is refused just the
 * same.
 */
export function OrderFabricFinishCard({ standing, canUpdate, onUpdate, onViewEvidence, busyEvidence }: {
  standing: ApprovalStanding
  canUpdate: boolean
  onUpdate: () => void
  onViewEvidence: (path: string) => void
  /** Which proof is being signed, if any. */
  busyEvidence: string | null
}) {
  return (
    <CardShell
      title={FABRIC_FINISH_TITLE}
      right={canUpdate ? (
        <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onUpdate}>
          {FABRIC_FINISH_UPDATE_LABEL}
        </button>
      ) : undefined}
    >
      <dl className="order-status-approvals">
        {standing.kinds.map(kind => (
          <div key={kind.kind} className="order-status-approval">
            <dt className="order-status-fact-label">{kind.label}</dt>
            <dd className="order-status-approval-value">
              <StatusPill label={APPROVAL_STATUS_LABEL[kind.status]} tone={kind.tone} />
              {/* WHEN AND WHO, only where there is an event to name. Not
                  Approved is where every Order starts; dating it or crediting
                  somebody with it would report an event that never happened. */}
              {kind.at && <span className="order-status-approval-at">{kind.at}</span>}
              {kind.approver && (
                <span className="order-status-approval-by">by {kind.approver}</span>
              )}
              {kind.evidencePath && (
                <button
                  type="button"
                  className="order-status-proof"
                  onClick={() => onViewEvidence(kind.evidencePath as string)}
                  disabled={busyEvidence === kind.evidencePath}
                >
                  {busyEvidence === kind.evidencePath ? 'Opening…' : EVIDENCE_VIEW_LABEL}
                </button>
              )}
            </dd>

            {/* THE PERMANENT TRAIL, and only when there is one. The table is
                append-only, so a status this kind has left is still on record
                with its actor, its moment and its proof. It sits behind a
                disclosure because the question a reader opens this page with is
                where fabric and finish stand NOW — a card that led with four
                superseded states would answer a question nobody asked.

                A native <details>: it opens with a keyboard, it is announced,
                and it needs no state of its own. */}
            {kind.history.length > 0 && (
              <details className="order-approval-history">
                <summary className="order-approval-history-summary">
                  {APPROVAL_HISTORY_LABEL} ({kind.history.length})
                </summary>
                <ol className="order-approval-history-list">
                  {kind.history.map(event => (
                    <li key={event.id} className="order-approval-history-row">
                      <span className="order-approval-history-status">{event.statusLabel}</span>
                      <span className="order-approval-history-meta">
                        {event.at} · {event.actor}
                      </span>
                      {event.evidencePath && (
                        <button
                          type="button"
                          className="order-status-proof"
                          onClick={() => onViewEvidence(event.evidencePath as string)}
                          disabled={busyEvidence === event.evidencePath}
                        >
                          {busyEvidence === event.evidencePath ? 'Opening…' : EVIDENCE_VIEW_LABEL}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        ))}
      </dl>
      {!canUpdate && <p className="order-status-note">{standing.readOnlyNote}</p>}
    </CardShell>
  )
}

/**
 * DOCUMENTS ON THE LEFT, FABRIC & FINISH ON THE RIGHT — two thirds and one
 * third at desktop widths, stacked in that order below 900px.
 *
 * THE PROPORTION IS THE CONTENT'S. Documents holds three subsections of prose
 * and up to three actions each; Fabric & Finish holds two statuses and their
 * evidence. Equal columns gave the narrower card a third of a screen of white
 * space under it, which is the emptiness this pass exists to remove.
 *
 * ALIGNED TO THE TOP, NOT STRETCHED. Each card ends where its content ends; a
 * stretched pair would hand the shorter one a blank tail again.
 */
export function OrderDocumentsRow({ children }: { children: React.ReactNode }) {
  return <div className="order-docs-row">{children}</div>
}

// ── 4. Operations review ──────────────────────────────────────────────────────

const HANDOFF_TONE: Record<OperationsHandoffTone, StatusTone> = {
  green: 'green', amber: 'amber', red: 'red', neutral: 'neutral',
}

/**
 * THE PI-TO-OPERATIONS HANDOFF FOR THE VERSION IN FORCE (20261229000000).
 *
 * WHAT IT STATES, IN WORDS: which PI version is current, who approved it and
 * when, why it was revised (V2+), who must review it for operations, whether
 * that exact version is awaiting review, accepted for production, or flagged
 * for clarification — and what the Order's production alignment says as a
 * result. An Order approved before handoffs were recorded says "Not
 * recorded"; nothing is invented for it.
 *
 * ONE SET OF CONTROLS, FOR ONE PERSON. "Accept for production", "Cannot
 * accept" and "Withdraw acceptance" are drawn only for the assigned operations
 * reviewer, never under View As, and never for an administrator in their place
 * — being an admin is not being operations. They are the SAME door the old
 * "Align for Production" header button used to open: on an Order with a
 * handoff that button is gone, because accepting IS aligning.
 * decide_order_operations_handoff() re-derives all of that under a row lock,
 * so a call from somebody who never saw the buttons is refused just the same.
 *
 * A REVISED WORKBOOK: the revision reason is shown, and the current and the
 * previous PI can be opened side by side. No field-by-field comparison is
 * claimed, because none exists yet; the note says so.
 */
export function OrderOperationsReviewCard({
  view, history, busy, onAccept, onCannotAccept, onWithdraw,
  currentVersion, previousVersion, onOpenVersion, openingVersion,
}: {
  view: OperationsHandoffView
  history: ReturnType<typeof describeOperationsHandoffHistory>
  busy: boolean
  onAccept: () => void
  onCannotAccept: () => void
  onWithdraw: () => void
  /** The approved PI version and the one it replaced, for the two Open buttons. */
  currentVersion: PiVersionView | null
  previousVersion: PiVersionView | null
  onOpenVersion: (version: PiVersionView) => void
  openingVersion: boolean
}) {
  const controls = view.kind === 'recorded' && (view.actions.accept || view.actions.cannotAccept || view.actions.withdraw) ? (
    <span className="order-status-actions">
      {view.actions.cannotAccept && (
        <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onCannotAccept} disabled={busy}>
          {CANNOT_ACCEPT_LABEL}
        </button>
      )}
      {view.actions.withdraw && (
        <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onWithdraw} disabled={busy}>
          {WITHDRAW_ACCEPTANCE_LABEL}
        </button>
      )}
      {view.actions.accept && (
        <button type="button" className="boe-btn boe-btn-primary order-status-action" onClick={onAccept} disabled={busy}>
          {ACCEPT_FOR_PRODUCTION_LABEL}
        </button>
      )}
    </span>
  ) : undefined

  return (
    <CardShell id={OPERATIONS_REVIEW_ANCHOR} title={OPERATIONS_REVIEW_TITLE} right={controls}>
      {view.kind === 'not_recorded' ? (
        <>
          <StatusPill label={view.label} tone="neutral" />
          <p className="order-status-note">{view.hint}</p>
        </>
      ) : (
        <>
          <dl className="order-status-approvals">
            <div className="order-status-approval">
              <dt className="order-status-fact-label">{view.versionLabel}</dt>
              <dd className="order-status-approval-value">
                <StatusPill label={view.statusLabel} tone={HANDOFF_TONE[view.tone]} strong />
                <span className="order-status-approval-at">{view.approvedLine}</span>
              </dd>
              {view.revisionReason && (
                <dd className="order-status-approval-value">
                  <span className="order-status-approval-by">Revised because: <MultilineText>{view.revisionReason}</MultilineText></span>
                </dd>
              )}
            </div>
            <div className="order-status-approval">
              <dt className="order-status-fact-label">Operations reviewer</dt>
              <dd className="order-status-approval-value">
                {view.unassigned ? (
                  <>
                    {/* WHY nobody is assigned — configured nobody, configured
                        somebody inactive, or somebody who cannot open this
                        Order — and what an administrator must do about it. */}
                    <StatusPill label={view.reviewerLine} tone="amber" />
                    <span className="order-status-approval-by">{view.unassignedHint}</span>
                  </>
                ) : (
                  <span className="order-status-approval-by">{view.reviewerName ?? 'Assigned'}</span>
                )}
              </dd>
            </div>
            {view.decision && (
              <div className="order-status-approval">
                <dt className="order-status-fact-label">Decision</dt>
                <dd className="order-status-approval-value">
                  <span className="order-status-approval-by">
                    {view.decision.label}
                    {view.decision.by ? ` by ${view.decision.by}` : ''}
                    {view.decision.at ? ` · ${view.decision.at}` : ''}
                  </span>
                  {view.decision.note && (
                    <span className="order-status-approval-by"><MultilineText>{view.decision.note}</MultilineText></span>
                  )}
                </dd>
                {view.withdrawn && (
                  <dd className="order-status-approval-value">
                    <span className="order-status-approval-by">
                      Accepted earlier{view.withdrawn.acceptedBy ? ` by ${view.withdrawn.acceptedBy}` : ''}{view.withdrawn.acceptedAt ? ` · ${view.withdrawn.acceptedAt}` : ''};
                      {' '}withdrawn{view.withdrawn.by ? ` by ${view.withdrawn.by}` : ''} · {view.withdrawn.at}
                    </span>
                  </dd>
                )}
              </div>
            )}
            <div className="order-status-approval">
              <dt className="order-status-fact-label">Production alignment</dt>
              <dd className="order-status-approval-value">
                <StatusPill label={view.alignment.label} tone={view.alignment.aligned ? 'green' : 'amber'} />
                {view.alignment.line && <span className="order-status-approval-at">{view.alignment.line}</span>}
              </dd>
            </div>
          </dl>
          {view.priorAcceptedNotice && <p className="order-status-note order-status-note--warn">{view.priorAcceptedNotice}</p>}
          {view.alignmentWarning && <p className="order-status-note order-status-note--warn">{view.alignmentWarning}</p>}
          {(currentVersion || previousVersion) && (
            <div className="order-status-actions order-status-actions--start">
              {currentVersion && (
                <button type="button" className="boe-btn boe-btn-ghost order-status-action" disabled={openingVersion || !currentVersion.workbookPath}
                        onClick={() => onOpenVersion(currentVersion)}>
                  {OPEN_CURRENT_PI_LABEL(currentVersion.versionNumber)}
                </button>
              )}
              {previousVersion && (
                <button type="button" className="boe-btn boe-btn-ghost order-status-action" disabled={openingVersion || !previousVersion.workbookPath}
                        onClick={() => onOpenVersion(previousVersion)}>
                  {OPEN_PREVIOUS_PI_LABEL(previousVersion.versionNumber)}
                </button>
              )}
            </div>
          )}
          {previousVersion && <p className="order-status-note">{REVISION_COMPARE_NOTE}</p>}
          <p className="order-status-note">{ACCEPTANCE_MEANING}</p>
          {view.readOnlyNote && <p className="order-status-note">{view.readOnlyNote}</p>}
          {history.length > 0 && (
            <details className="order-approval-history">
              <summary className="order-approval-history-summary">
                Earlier versions ({history.length})
              </summary>
              <ol className="order-approval-history-list">
                {history.map(h => (
                  <li key={h.key} className="order-approval-history-row">
                    <span className="order-approval-history-status">{h.versionLabel}: {h.statusLabel}</span>
                    <span className="order-approval-history-meta">{h.line}</span>
                    {h.note && <span className="order-approval-history-meta"><MultilineText>{h.note}</MultilineText></span>}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </CardShell>
  )
}

// ── The PI history modal ──────────────────────────────────────────────────────

const VERSION_TONE: Record<PiVersionTone, StatusTone> = {
  green: 'green', amber: 'amber', red: 'red', neutral: 'neutral',
}

/**
 * A modal that closes the way every modal should.
 *
 * Escape closes it, the backdrop closes it, focus moves into it on open and
 * returns to whatever opened it on close, and Tab is held inside it while it is
 * open. None of that is decoration: a dialog a keyboard cannot leave, or one
 * that drops focus back to the top of a long page, is a dialog that stops
 * people using the keyboard at all.
 */
function Modal({ title, onClose, children, wide = false }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null
    const node = panel.current
    const focusable = node?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    ;(focusable ?? node)?.focus()
    return () => returnTo.current?.focus?.()
  }, [])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
    if (event.key !== 'Tab') return
    const node = panel.current
    if (!node) return
    const items = [...node.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(el => el.offsetParent !== null || el === document.activeElement)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  }, [onClose])

  return (
    <div className="order-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={panel}
        className={wide ? 'order-modal order-modal--wide' : 'order-modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="order-modal-head">
          <h2 className="order-modal-title">{title}</h2>
          <button type="button" className="order-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="order-modal-body">{children}</div>
      </div>
    </div>
  )
}

export { Modal as OrderModalShell }

// ── The design-file dialog ────────────────────────────────────────────────────

export const DESIGN_FILES_DIALOG_TITLE = 'Design files'
export const DESIGN_FILES_DIALOG_EMPTY = 'No design files are recorded against this Order.'
/** Said in the dialog, so nobody hunts this screen for an upload control. */
export const DESIGN_FILES_DIALOG_NOTE =
  'These files come from the approved PI. They are added and removed there.'

/**
 * EVERY PICTURE THIS ORDER HOLDS, WITHOUT LEAVING THE ORDER.
 *
 * The Documents box states how many there are; this is the list behind that
 * number, and it opens over the page. There is no design-file screen to go to
 * and this does not invent one.
 *
 * THE PICTURES ARE THE PAGE'S OWN, already resolved and already ordered by
 * buildImageViewerItems — the same sequence the product table and the full-size
 * viewer walk, so a picture is the same picture and in the same place wherever
 * it is opened. Clicking one hands it to that viewer.
 *
 * READ-ONLY, AND HONESTLY SO. These pictures BELONG TO THE APPROVED PI, which is
 * where they are added and removed; this Order screen has never had a way to
 * upload one and this does not pretend otherwise. An upload control here would
 * be a button with nothing behind it, and the control that opens this dialog is
 * called "View files" for the same reason.
 *
 * ORDER-LEVEL DESIGN DOCUMENTS ARE NOT BUILT. Giving an Order its own design
 * files — rather than its PI's — needs a table, an RLS pair, a storage policy
 * and an upload permission, none of which exists. Until it does, this lists what
 * the PI holds, and says so.
 *
 * THUMBNAILS LOAD WHEN THIS OPENS, not when the page does — the dialog is
 * mounted only while it is open, so a reader who never asks for the list never
 * fetches a single image.
 */
export function OrderDesignFilesDialog({ items, onOpen, onClose }: {
  items: readonly PiViewerItem[]
  onOpen: (key: string) => void
  onClose: () => void
}) {
  return (
    <Modal title={DESIGN_FILES_DIALOG_TITLE} onClose={onClose} wide>
      {items.length === 0 ? (
        <p className="order-doc-empty">{DESIGN_FILES_DIALOG_EMPTY}</p>
      ) : (
        <ul className="order-file-grid">
          {items.map(item => (
            <li key={item.key} className="order-file-cell">
              <button
                type="button"
                className="order-file-thumb"
                onClick={() => onOpen(item.key)}
                aria-label={item.label}
              >
                {/* Native lazy loading: a long list fetches what is scrolled to
                    rather than everything the moment the dialog opens.
                    eslint-disable-next-line @next/next/no-img-element */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.url} alt="" loading="lazy" decoding="async" />
              </button>
              <p className="order-file-role">{item.roleLabel}</p>
              <p className="order-file-meta">{item.sequence} · {item.name}</p>
            </li>
          ))}
        </ul>
      )}
      {/* WHERE THESE CAME FROM, AND WHERE THEY ARE CHANGED. Without it a reader
          who finds no upload here concludes the control is missing, rather than
          that it lives on the PI. */}
      {items.length > 0 && <p className="order-doc-note">{DESIGN_FILES_DIALOG_NOTE}</p>}
    </Modal>
  )
}

// ── The approval-evidence dialog ──────────────────────────────────────────────

export const EVIDENCE_DIALOG_TITLE = 'Approval evidence'
export const EVIDENCE_DIALOG_PENDING = 'Opening…'

/**
 * ONE ERP SCREENSHOT, OVER THIS PAGE.
 *
 * It used to be window.open() onto a signed URL — a new tab, no title, no way
 * back, and the Order lost behind it. The URL is still signed on the press
 * through the reader's own session, so the evidence bucket's own policy decides
 * at that moment exactly as before; only where the picture is shown changed.
 *
 * NOTHING IS SIGNED UNTIL SOMEBODY ASKS. The dialog is mounted when a proof is
 * named and unmounted when it closes, so no proof on the page is signed at load.
 */
export function OrderEvidenceDialog({ url, failure, onClose }: {
  /** The signed URL, or null while it is being minted. */
  url: string | null
  failure: string | null
  onClose: () => void
}) {
  return (
    <Modal title={EVIDENCE_DIALOG_TITLE} onClose={onClose} wide>
      {failure ? (
        <p className="order-doc-unavailable" role="alert">{failure}</p>
      ) : url ? (
        <div className="order-evidence-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={EVIDENCE_DIALOG_TITLE} />
        </div>
      ) : (
        <p className="order-doc-loading" role="status">{EVIDENCE_DIALOG_PENDING}</p>
      )}
    </Modal>
  )
}

/**
 * EVERY PI VERSION THIS ORDER HAS CARRIED, newest first, without leaving the
 * page.
 *
 * THE CURRENT ONE IS MARKED, NOT SHOUTED. One quiet badge and a left rule: a
 * history in which one row is three times the size of the others stops being a
 * history and becomes an advertisement for the row somebody already knows.
 *
 * THE FILES ARE NOT SIGNED UNTIL SOMEBODY ASKS. A modal that signed every
 * archived version on open would spend a request per row for files nobody
 * opened, and would mint URLs for documents the reader never named.
 */
export function PiHistoryModal({
  entries, onClose, onView, onDownload, busyId,
  canPropose, onPropose, canDecide, onApprove, onReject, error,
}: {
  entries: readonly PiTimelineEntry[]
  onClose: () => void
  onView: (version: PiVersionView) => void
  onDownload: (version: PiVersionView) => void
  /** Which version's file is being signed, if any. */
  busyId: string | null
  canPropose: boolean
  onPropose: () => void
  canDecide: boolean
  onApprove: (version: PiVersionView) => void
  onReject: (version: PiVersionView) => void
  error: string | null
}) {
  return (
    <Modal title={PI_HISTORY_MODAL_TITLE} onClose={onClose} wide>
      {canPropose && (
        <div className="order-history-toolbar">
          <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onPropose}>
            <Upload size={13} strokeWidth={2} aria-hidden="true" />
            {UPLOAD_REVISION_BUTTON_LABEL}
          </button>
        </div>
      )}

      {error && <p className="order-history-error" role="alert">{error}</p>}

      {entries.length === 0 ? (
        <p className="order-status-empty">{PI_HISTORY_MODAL_EMPTY}</p>
      ) : (
        <ol className="order-history-list">
          {entries.map(entry => {
            const v = entry.version
            return (
              <li
                key={v.id}
                className={entry.isCurrent ? 'order-history-row order-history-row--current' : 'order-history-row'}
              >
                <div className="order-history-row-head">
                  <span className="order-history-version">{v.label}</span>
                  <StatusPill label={v.statusLabel} tone={VERSION_TONE[v.tone]} />
                  {entry.isCurrent && <span className="order-history-current">{PI_HISTORY_CURRENT_BADGE}</span>}
                </div>

                <div className="order-history-meta">
                  Uploaded by {v.uploadedBy} · {v.uploadedAt}
                  {v.decisionLine ? ` · ${v.decisionLine}` : ''}
                </div>

                <div className="order-history-remark">
                  <span className="order-history-remark-label">{REMARK_LABEL}: </span>
                  <MultilineText
                    className={entry.remarkMissing ? 'order-history-remark-missing' : 'order-history-remark-text'}
                    style={{ margin: 0, display: 'inline' }}
                  >
                    {entry.remark}
                  </MultilineText>
                </div>

                {v.decisionReason && (
                  <div className="order-history-refused">
                    <span className="order-history-remark-label">Refused: </span>
                    <MultilineText style={{ margin: 0, display: 'inline' }}>{v.decisionReason}</MultilineText>
                  </div>
                )}

                <div className="order-history-actions">
                  {canDecide && v.status === 'pending' && (
                    <>
                      <button type="button" className="boe-btn boe-btn-primary order-status-action"
                        onClick={() => onApprove(v)}>
                        {APPROVE_REVISION_BUTTON_LABEL}
                      </button>
                      <button type="button" className="boe-btn boe-btn-ghost order-status-action"
                        onClick={() => onReject(v)}>
                        {REJECT_REVISION_BUTTON_LABEL}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost order-status-action"
                    onClick={() => onView(v)}
                    disabled={!v.workbookPath || busyId === v.id}
                    title={v.workbookName ?? v.label}
                  >
                    <FileSpreadsheet size={13} strokeWidth={2} aria-hidden="true" />
                    {busyId === v.id ? 'Opening…' : MAIN_PI_VIEW_LABEL}
                  </button>
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost order-status-action"
                    onClick={() => onDownload(v)}
                    disabled={!v.workbookPath || busyId === v.id}
                    title={v.workbookName ?? v.label}
                  >
                    <Download size={13} strokeWidth={2} aria-hidden="true" />
                    {MAIN_PI_DOWNLOAD_LABEL}
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Modal>
  )
}

