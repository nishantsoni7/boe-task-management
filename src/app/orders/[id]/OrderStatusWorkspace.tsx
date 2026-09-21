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
// THREE CARDS, ONE ROW, IN ONE ORDER: Main PI, Advance Received, Fabric &
// Finish. They stack in that same order on a narrow screen, so a person
// describing the screen over the phone is describing the same thing whatever
// the other person is holding.

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

