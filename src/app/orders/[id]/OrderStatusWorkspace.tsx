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
import {
  MAIN_PI_APPROVED_LABEL,
  MAIN_PI_DOWNLOAD_LABEL,
  MAIN_PI_HISTORY_LABEL,
  MAIN_PI_TITLE,
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
import {
  ADVANCE_AMOUNT_LABEL,
  ADVANCE_NOT_AVAILABLE,
  ADVANCE_ORDER_VALUE_LABEL,
  ADVANCE_TITLE,
  type AdvanceStanding,
} from '@/lib/orders/orderAdvance'
import {
  CURRENT_STATUS_TITLE,
  DESIGN_FILES_TITLE,
  MANUFACTURING_TITLE,
  type CurrentStatusLine,
  type DesignFilesView,
  type ManufacturingStatusView,
} from '@/lib/orders/orderCurrentStatus'
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

function CardShell({ title, right, children }: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="order-status-card" aria-label={title}>
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
export function OrderMainPiCard({
  card, onView, onDownload, onHistory, viewing, downloading,
}: {
  card: MainPiCard
  onView: (version: PiVersionView) => void
  onDownload: (version: PiVersionView) => void
  onHistory: () => void
  viewing: boolean
  downloading: boolean
}) {
  const history = (
    <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onHistory}>
      <History size={13} strokeWidth={2} aria-hidden="true" />
      {MAIN_PI_HISTORY_LABEL}
    </button>
  )

  if (card.kind !== 'ready') {
    return (
      <CardShell title={MAIN_PI_TITLE} right={history}>
        <p className="order-status-empty">{card.message}</p>
      </CardShell>
    )
  }

  return (
    <CardShell title={MAIN_PI_TITLE} right={history}>
      <div className="order-status-lead">
        <span className="order-status-lead-value">{card.reference}</span>
        <StatusPill label={card.statusLabel} tone="green" />
      </div>

      <dl className="order-status-facts">
        <Fact label={MAIN_PI_UPLOADED_LABEL} value={card.uploadedAt} />
        {/* Absent rather than guessed: see MainPiCard.approvedAt. */}
        {card.approvedAt && <Fact label={MAIN_PI_APPROVED_LABEL} value={card.approvedAt} />}
      </dl>

      {card.pendingRevision && (
        <p className="order-status-note">
          A revised PI is uploaded and waiting for a decision. This one stays in force until it is approved.
        </p>
      )}

      <div className="order-status-actions">
        <button
          type="button"
          className="boe-btn boe-btn-ghost order-status-action"
          onClick={() => onView(card.version)}
          disabled={!card.hasFile || viewing}
          title={card.fileName ?? card.reference}
        >
          <FileSpreadsheet size={13} strokeWidth={2} aria-hidden="true" />
          {viewing ? 'Opening…' : MAIN_PI_VIEW_LABEL}
        </button>
        <button
          type="button"
          className="boe-btn boe-btn-ghost order-status-action"
          onClick={() => onDownload(card.version)}
          disabled={!card.hasFile || downloading}
          title={card.fileName ?? card.reference}
        >
          <Download size={13} strokeWidth={2} aria-hidden="true" />
          {downloading ? 'Preparing…' : MAIN_PI_DOWNLOAD_LABEL}
        </button>
      </div>
    </CardShell>
  )
}

// ── 2. Advance Received ───────────────────────────────────────────────────────

/**
 * HOW MUCH OF THIS ORDER IS ACTUALLY PAID FOR.
 *
 * Every figure is the shared finance position's, unchanged — verified money
 * allocated to THIS Order, over its final Order Value. See orderAdvance.ts for
 * why there is no second calculation here, why nothing is capped, and why the
 * Risky/Safe line is an operational indicator and not the confirmation gate.
 */
export function OrderAdvanceCard({ standing }: { standing: AdvanceStanding }) {
  return (
    <CardShell title={ADVANCE_TITLE}>
      <div className="order-status-lead">
        <span className="order-status-lead-value order-status-lead-value--numeric">
          {standing.percentLabel}
        </span>
        {/* Words as well as colour: a reader who cannot tell red from green
            still reads "Risky". */}
        {standing.classification && (
          <StatusPill label={standing.classification.label} tone={standing.classification.tone} strong />
        )}
      </div>

      <dl className="order-status-facts">
        <Fact label={ADVANCE_AMOUNT_LABEL} value={standing.verifiedAmount} />
        <Fact label={ADVANCE_ORDER_VALUE_LABEL} value={standing.orderValue ?? ADVANCE_NOT_AVAILABLE} />
      </dl>

      <p className="order-status-note">{standing.note}</p>
    </CardShell>
  )
}

// ── 3. Fabric & Finish ────────────────────────────────────────────────────────

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

// ── 4. Current Status: Design Files and Manufacturing ─────────────────────────

/**
 * ONE LINE OF A CURRENT STATUS CARD.
 *
 * The value is a pill only where the line HAS a status; a count and an absence
 * are plain words, because a coloured badge around "3 files" would give a
 * number the weight of a decision.
 *
 * `unsupported` is muted rather than hidden. A reader who does not see a CAD
 * row concludes nothing; a reader who sees "CAD & drawings — Not recorded"
 * learns that this system does not hold them, which is the true answer and the
 * only one that stops somebody hunting for the file elsewhere.
 */
function StatusLine({ line }: { line: CurrentStatusLine }) {
  return (
    <div className={line.unsupported ? 'order-status-line order-status-line--muted' : 'order-status-line'}>
      <dt className="order-status-fact-label">{line.label}</dt>
      <dd className="order-status-line-value">
        {line.tone
          ? <StatusPill label={line.value} tone={line.tone} />
          : <span className="order-status-line-plain">{line.value}</span>}
        {line.detail && <span className="order-status-line-detail">{line.detail}</span>}
      </dd>
    </div>
  )
}

/**
 * WHAT DESIGN WORK THIS ORDER HAS ON RECORD.
 *
 * READ-ONLY, ON PURPOSE. Fabric and Finish are the same standing the card below
 * draws in full, stated here without their dates, actors, proof buttons or
 * update control: this card answers "where does design stand", and the one
 * below is where it is moved. Nothing here uploads, edits or approves anything.
 */
export function OrderDesignFilesCard({ view }: { view: DesignFilesView }) {
  return (
    <CardShell title={DESIGN_FILES_TITLE}>
      <dl className="order-status-lines">
        {view.lines.map(line => <StatusLine key={line.key} line={line} />)}
      </dl>
      <p className="order-status-note">{view.note}</p>
    </CardShell>
  )
}

/**
 * HOW FAR THE ORDER HAS GOT, from the two records that actually exist.
 *
 * The closing note is not boilerplate: without it a card headed "Manufacturing
 * Status" that shows only an alignment reads as though manufacturing had not
 * started, when the truth is that this system never tracked it.
 */
export function OrderManufacturingCard({ view }: { view: ManufacturingStatusView }) {
  return (
    <CardShell title={MANUFACTURING_TITLE}>
      <dl className="order-status-lines">
        {view.lines.map(line => <StatusLine key={line.key} line={line} />)}
      </dl>
      <p className="order-status-note">{view.note}</p>
    </CardShell>
  )
}

/**
 * THE SECTION ITSELF: a heading, and the same three-column grid the workspace
 * below it uses.
 *
 * It reuses `order-status-workspace` rather than declaring a second grid, so
 * the two rows of cards can never wrap differently at the same width — one set
 * of breakpoints, one behaviour, one thing to verify.
 */
export function OrderCurrentStatus({ children }: { children: React.ReactNode }) {
  return (
    <section className="order-current-status" aria-label={CURRENT_STATUS_TITLE}>
      <h2 className="order-current-status-title">{CURRENT_STATUS_TITLE}</h2>
      <div className="order-status-workspace">{children}</div>
    </section>
  )
}

// ── The workspace ─────────────────────────────────────────────────────────────

export const STATUS_WORKSPACE_LABEL = 'Order status'

export function OrderStatusWorkspace({ children }: { children: React.ReactNode }) {
  return (
    <div className="order-status-workspace" aria-label={STATUS_WORKSPACE_LABEL} role="group">
      {children}
    </div>
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

