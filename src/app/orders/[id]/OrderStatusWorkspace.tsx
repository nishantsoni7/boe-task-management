'use client'

// THE AREA BETWEEN THE ORDER SUMMARY AND THE PRODUCT LIST.
//
// PAGE-OWNED, like OrderWorkspace.tsx and OrderPiSections.tsx beside it.
// EVERY COMPONENT HERE IS A FUNCTION OF ITS PROPS: nothing fetches, writes,
// authorizes or decides. Which PI is in force is orderMainPi's answer; which
// supporting files are current is orderDocumentSubmissions'; who may move a
// Fabric or Finish status is the database's, re-derived under a row lock every
// time. These draw the answers.
//
// TWO FULL-WIDTH BLOCKS, IN ONE FIXED ORDER, on every screen size:
//
//   Fabric & Finish  a one-line strip: two statuses and one Update action.
//   Documents        what is changing (only when something is), then the
//                    current Main PI, Design Files and Client PO as rows.

import { useCallback, useEffect, useRef } from 'react'
import { Download, FileSpreadsheet, FileText, History, Upload, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MultilineText } from '@/components/ui/MultilineText'
import type { PiViewerItem } from '@/lib/pi/previewView'
import {
  MAIN_PI_APPROVED_LABEL,
  MAIN_PI_DOWNLOAD_LABEL,
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
  REAPPROVE_REVISION_CONFIRM,
  REAPPROVE_REVISION_LABEL,
  REAPPROVE_REVISION_NOTE,
  REVIEW_REVISION_LABEL,
  revisionStage,
  type PiVersionView,
} from '@/lib/orders/orderPiVersions'
import { DESIGN_IMAGES_LOADING } from '@/lib/orders/orderCurrentStatus'
import { PI_EDITED_VERSION_WORKBOOK_NOTE, PI_VERSION_PDF_VIEW_LABEL } from '@/lib/orders/piVersionPdf'
import {
  ACCEPT_FOR_PRODUCTION_LABEL,
  CANNOT_ACCEPT_LABEL,
  type OperationsHandoffView,
} from '@/lib/orders/operationsHandoff'
import {
  CLIENT_PO_UNSUPPORTED_NOTE,
  DOCUMENTS_TITLE,
  DOC_CLIENT_PO_TITLE,
  DOC_DESIGN_FILES_TITLE,
  DOC_MAIN_PI_TITLE,
  DOC_ACCEPTED_LABEL,
  DOC_PI_PICTURES_LABEL,
  DOC_VIEW_PI_LABEL,
  DOCUMENTS_HISTORY_LABEL,
  DOCUMENTS_HISTORY_TITLE,
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
import {
  CORRECT_AND_RESUBMIT_LABEL,
  DOCUMENT_CHANGES_TITLE,
  DOCUMENT_CURRENT_LABEL,
  NEEDS_YOUR_ACTION_TITLE,
  REVIEW_CHANGE_LABEL,
  type DocumentChangeView,
  type PersistedDocumentFile,
  type SupportingRowView,
} from '@/lib/orders/orderDocumentSubmissions'

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

// ── 1. Documents ──────────────────────────────────────────────────────────────

/** One file, opened on the press through the page's signer. Never a URL. */
function FileLinks({ files, onOpen, limit = 3 }: {
  files: readonly PersistedDocumentFile[]
  onOpen: (f: PersistedDocumentFile) => void
  /** How many names to show before the rest fold behind "N more". */
  limit?: number
}) {
  const link = (f: PersistedDocumentFile) => (
    <li key={f.id}>
      <button type="button" className="order-doc-file" onClick={() => onOpen(f)} title={`Open ${f.file_name}`}>
        <FileText size={13} strokeWidth={2} aria-hidden="true" />
        <span className="order-doc-file-name">{f.file_name}</span>
      </button>
    </li>
  )
  const shown = files.slice(0, limit)
  const rest = files.slice(limit)
  return (
    <>
      <ul className="order-doc-files">{shown.map(link)}</ul>
      {rest.length > 0 && (
        <details className="order-doc-files-more">
          <summary>{rest.length} more</summary>
          <ul className="order-doc-files">{rest.map(link)}</ul>
        </details>
      )}
    </>
  )
}

/** A label above its value, for the dates on a document row. */
function DocMeta({ items }: { items: readonly { label: string; value: string }[] }) {
  if (items.length === 0) return null
  return (
    <dl className="order-doc-dates">
      {items.map(item => (
        <div key={item.label} className="order-doc-dates-item">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * ONE CURRENT DOCUMENT, ONE ROW: what it is, what is on file, when, and the one
 * thing a reader does with it. The same three columns for all three rows, so the
 * card is scanned rather than read; on a narrow screen they stack.
 */
function DocRow({ title, status, children, meta, actions, primary = false }: {
  title: string
  /** The Main PI: the first and most prominent row. */
  primary?: boolean
  status?: React.ReactNode
  children?: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className={primary ? 'order-doc-section order-doc-section--primary' : 'order-doc-section'} aria-label={title.split(' · ')[0]}>
      <div className="order-doc-row-main">
        <p className="order-doc-row-head">
          <span className="order-doc-row-title">{title}</span>
          {status}
        </p>
        {children}
      </div>
      <div className="order-doc-row-meta">{meta}</div>
      <div className="order-doc-row-actions">{actions}</div>
    </section>
  )
}

/** A proposed PI, as the changes panel states it. */
type PiChange = {
  proposal: PiVersionView
  stage: { owner: string; next: string } | null
}

/**
 * THE DOCUMENTS CARD — which PI and which supporting files are CURRENT, and,
 * only when there is one, what is changing.
 *
 * READ TOP TO BOTTOM:
 *
 *   header      "Documents", a quiet History link, and ONE "Update documents"
 *               menu for somebody allowed to submit (New PI, Design Files,
 *               Client PO). Four equal upload buttons became one control.
 *   changes     drawn ONLY while something is pending or rejected. Each
 *               submission once — a change to both categories used to appear
 *               under each of them — with what it changes, where it stands,
 *               who holds it and the one control this reader owns on it.
 *   rows        Main PI · V1 with one status, its two dates and View PI; then
 *               Design Files and Client PO, each the accepted file names, which
 *               open the file. Nothing proposed is ever drawn in these rows.
 *
 * NOT ONE ACTION LEFT THE PAGE. Opening a file signs it on the press through
 * the reader's own session; Download and the PI history sit behind the row's
 * ⋯ menu and the History link; the reviews open the existing dialogs. Which
 * control is drawn is the page's courtesy — every RPC re-decides it.
 */
export function OrderDocumentsPanel({
  mainPi, design, clientPo,
  onView, onDownload, onHistory, onManageDesign,
  viewing, downloading,
  mainPiOperations, mainPiMenu, updateMenu,
  supporting, changes = [], onReviewChange, onResubmitChange, onOpenFile, fileError = null,
  onReviewRevision, onApproveRevision, onRejectRevision, onOpenProposal, revisionApproverInactive = false, reapprove,
  onOpenPdf,
}: {
  mainPi: MainPiCard
  /** The approved PI's own product pictures (read-only; opened in a dialog). */
  design: DesignFilesDocument
  /** Used only when the Order has no supporting-document read (legacy). */
  clientPo?: ClientPoDocument
  onView: (version: PiVersionView) => void
  onDownload: (version: PiVersionView) => void
  onHistory: () => void
  /** Opens the PI product-picture dialog. */
  onManageDesign: () => void
  viewing: boolean
  downloading: boolean
  /** Where the version in force stands with Operations, in words. */
  mainPiOperations?: { label: string; tone: StatusTone; line: string | null } | null
  /** The Main PI row's ⋯ menu (Download PI, PI history). Absent: Download is a quiet button. */
  mainPiMenu?: React.ReactNode
  /** The single "Update documents" control, or nothing for a reader who may not submit. */
  updateMenu?: React.ReactNode
  /** What is on file for each supporting category (accepted submissions only). */
  supporting?: { design: SupportingRowView; clientPo: SupportingRowView; formatWhen: (iso: string | null) => string }
  /** Design Files / Client PO submissions pending or rejected. */
  changes?: readonly DocumentChangeView[]
  onReviewChange?: (s: DocumentChangeView['submission']) => void
  onResubmitChange?: (s: DocumentChangeView['submission']) => void
  onOpenFile?: (f: PersistedDocumentFile) => void
  /** A file that could not be opened, said once under the rows. */
  fileError?: string | null
  /** The operations reviewer's control on a staged revision (20270101000000). */
  onReviewRevision?: () => void
  /** An admin's decision on a revision still pending Admin. */
  onApproveRevision?: (version: PiVersionView) => void
  onRejectRevision?: (version: PiVersionView) => void
  /** Opens the proposed workbook through the page's signer. */
  onOpenProposal?: (version: PiVersionView) => void
  /** The admin who approved the proposal is no longer active (20270101000000 §6b). */
  revisionApproverInactive?: boolean
  /** An active admin's recovery control, with its page-owned confirm step. */
  reapprove?: {
    confirming: boolean
    busy: boolean
    error: string | null
    onStart: () => void
    onConfirm: () => void
    onCancel: () => void
  }
  /**
   * Opens a PI version's PDF, rendered from that version's own details
   * (20270104000000) — a file hand-off, like the workbook's. Absent: the row
   * offers only the uploaded workbook.
   */
  onOpenPdf?: (versionId: string, download: boolean) => void
}) {
  const open = (f: PersistedDocumentFile) => onOpenFile?.(f)
  const piChange: PiChange | null = mainPi.kind === 'ready' && mainPi.proposal
    ? { proposal: mainPi.proposal, stage: revisionStage(mainPi.proposal, revisionApproverInactive) }
    : null
  const piNeedsYou = !!piChange && (
    !!onReviewRevision
    || (!!onApproveRevision && piChange.proposal.status === 'pending')
    || (!!reapprove && piChange.proposal.status === 'admin_approved')
  )
  const needsYou = piNeedsYou || changes.some(c => c.action !== null)
  const hasChanges = !!piChange || changes.length > 0

  // THE ONE STATUS ON THE MAIN PI ROW. Accepted by Operations (or an Order with
  // no handoff at all) is simply Current; anything short of that says so.
  const piStatus = mainPiOperations && mainPiOperations.tone !== 'green'
    ? <StatusPill label={mainPiOperations.label} tone={mainPiOperations.tone} />
    : <StatusPill label={DOCUMENT_CURRENT_LABEL} tone="green" />

  return (
    <section className="order-docs" aria-label={DOCUMENTS_TITLE} id="documents">
      <div className="order-docs-head">
        <h2 className="order-docs-title">{DOCUMENTS_TITLE}</h2>
        <div className="order-docs-head-actions">
          {/* THE HISTORY IS OFFERED WHETHER OR NOT A PI IS IN FORCE: an Order
              whose only version is a pending revision has a history worth
              reading, and that is exactly when a reader asks for it. */}
          <button type="button" className="order-docs-link" onClick={onHistory}>
            <History size={13} strokeWidth={2} aria-hidden="true" />
            {DOCUMENTS_HISTORY_LABEL}
          </button>
          {updateMenu}
        </div>
      </div>

      {/* ── WHAT IS CHANGING — only when something is ── */}
      {hasChanges && (
        <div className={needsYou ? 'order-doc-changes order-doc-changes--you' : 'order-doc-changes'}
             role="group" aria-label={needsYou ? NEEDS_YOUR_ACTION_TITLE : DOCUMENT_CHANGES_TITLE}>
          <h3 className="order-doc-changes-title">{needsYou ? NEEDS_YOUR_ACTION_TITLE : DOCUMENT_CHANGES_TITLE}</h3>
          <ul className="order-doc-change-list">
            {piChange && (() => {
              const p = piChange.proposal
              const version = `V${p.versionNumber}`
              return (
                <li className="order-doc-change" aria-label={`${p.label} proposed`}>
                  <div className="order-doc-change-main">
                    <p className="order-doc-change-head">
                      <span className="order-doc-change-title">New PI · {version}</span>
                      <StatusPill label={p.status === 'pending' ? 'Waiting for Admin' : 'Waiting for Operations'} tone={p.tone} />
                    </p>
                    {p.revisionReason && <p className="order-doc-change-line">What changed: “{p.revisionReason}”</p>}
                    <p className="order-doc-change-line order-doc-change-muted">
                      Uploaded by {p.uploadedBy}, {p.uploadedAt}{p.decisionLine && ` · ${p.decisionLine}`}
                    </p>
                    {piChange.stage && (
                      <p className="order-doc-change-line"><strong>With:</strong> {piChange.stage.owner} · <strong>Next:</strong> {piChange.stage.next}</p>
                    )}
                    <p className="order-doc-change-line order-doc-change-muted">
                      {mainPi.kind === 'ready' ? `V${mainPi.version.versionNumber}` : 'The current PI'} stays current until Operations accepts {version}.
                    </p>
                    {p.editedInApp && (
                      <p className="order-doc-change-line order-doc-change-muted">
                        Edited in the app — compare it with the current PI under PI versions.
                      </p>
                    )}
                    {onOpenProposal && p.workbookPath && (
                      <ul className="order-doc-files">
                        <li>
                          <button type="button" className="order-doc-file" onClick={() => onOpenProposal(p)} title={`Open ${p.label}`}>
                            <FileSpreadsheet size={13} strokeWidth={2} aria-hidden="true" />
                            <span className="order-doc-file-name">{p.workbookName ?? `Open ${p.label}`}</span>
                          </button>
                        </li>
                      </ul>
                    )}
                  </div>
                  <div className="order-doc-change-actions">
                    {onReviewRevision && (
                      <button type="button" className="boe-btn boe-btn-primary order-doc-action" onClick={onReviewRevision}>
                        {REVIEW_REVISION_LABEL(p.versionNumber)}
                      </button>
                    )}
                    {onApproveRevision && p.status === 'pending' && (
                      <>
                        <button type="button" className="boe-btn boe-btn-primary order-doc-action" onClick={() => onApproveRevision(p)}>
                          {APPROVE_REVISION_BUTTON_LABEL}
                        </button>
                        {onRejectRevision && (
                          <button type="button" className="boe-btn boe-btn-ghost order-doc-action" onClick={() => onRejectRevision(p)}>
                            {REJECT_REVISION_BUTTON_LABEL}
                          </button>
                        )}
                      </>
                    )}
                    {reapprove && !reapprove.confirming && (
                      <button type="button" className="boe-btn boe-btn-primary order-doc-action" onClick={reapprove.onStart}>
                        {REAPPROVE_REVISION_LABEL(p.versionNumber)}
                      </button>
                    )}
                  </div>
                  {reapprove?.confirming && (
                    <div className="order-doc-change-confirm" role="group" aria-label={REAPPROVE_REVISION_LABEL(p.versionNumber)}>
                      <p className="order-doc-change-line">{REAPPROVE_REVISION_NOTE(p.versionNumber)}</p>
                      <div className="order-doc-change-actions">
                        <button type="button" className="boe-btn boe-btn-primary order-doc-action" disabled={reapprove.busy} onClick={reapprove.onConfirm}>
                          {REAPPROVE_REVISION_CONFIRM}
                        </button>
                        <button type="button" className="boe-btn boe-btn-ghost order-doc-action" disabled={reapprove.busy} onClick={reapprove.onCancel}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {reapprove?.error && <p className="order-doc-change-line" role="alert" style={{ color: colors.red }}>{reapprove.error}</p>}
                </li>
              )
            })()}

            {changes.map(c => (
              <li key={c.submission.id} className={c.tone === 'red' ? 'order-doc-change order-doc-change--rejected' : 'order-doc-change'}
                  aria-label={`${c.title}: ${c.statusLabel}`}>
                <div className="order-doc-change-main">
                  <p className="order-doc-change-head">
                    <span className="order-doc-change-title">{c.title}</span>
                    <StatusPill label={c.statusLabel} tone={c.tone} />
                  </p>
                  {c.effect && <p className="order-doc-change-line">{c.effect}</p>}
                  {c.rejection && <p className="order-doc-change-line"><strong>Reason:</strong> {c.rejection}</p>}
                  <p className="order-doc-change-line order-doc-change-muted">{c.submittedLine}</p>
                  <p className="order-doc-change-line"><strong>With:</strong> {c.owner} · <strong>Next:</strong> {c.next}</p>
                  {c.note && <p className="order-doc-change-line order-doc-change-muted">Note: “{c.note}”</p>}
                  {c.status !== 'rejected_admin' && c.status !== 'rejected_operations' && c.files.length > 0 && (
                    <FileLinks files={c.files} onOpen={open} />
                  )}
                </div>
                {c.action && (
                  <div className="order-doc-change-actions">
                    {c.action === 'resubmit' ? (
                      <button type="button" className="boe-btn boe-btn-primary order-doc-action" onClick={() => onResubmitChange?.(c.submission)}>
                        {CORRECT_AND_RESUBMIT_LABEL}
                      </button>
                    ) : (
                      <button type="button" className="boe-btn boe-btn-primary order-doc-action" onClick={() => onReviewChange?.(c.submission)}>
                        {REVIEW_CHANGE_LABEL}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── WHAT IS CURRENT ── */}
      <div className="order-docs-rows">
        {mainPi.kind !== 'ready' ? (
          <DocRow title={DOC_MAIN_PI_TITLE}>
            <p className="order-doc-empty">{DOC_NOT_ATTACHED}</p>
            <p className="order-doc-note">{mainPi.message}</p>
          </DocRow>
        ) : (
          <DocRow
            title={`${DOC_MAIN_PI_TITLE} · V${mainPi.version.versionNumber}`}
            primary
            status={piStatus}
            meta={<DocMeta items={[
              { label: MAIN_PI_UPLOADED_LABEL, value: mainPi.uploadedAt },
              // Absent rather than guessed: see MainPiCard.approvedAt.
              ...(mainPi.approvedAt ? [{ label: MAIN_PI_APPROVED_LABEL, value: mainPi.approvedAt }] : []),
            ]} />}
            actions={
              <>
                {/* THE PI AS A DOCUMENT: this version's PDF, generated from its
                    own details — for a workbook version and an edited one alike. */}
                {onOpenPdf && (
                  <button
                    type="button"
                    className="boe-btn boe-btn-primary order-doc-action order-doc-action--main"
                    onClick={() => onOpenPdf(mainPi.version.id, false)}
                    title="Generated from this version's details"
                  >
                    <FileText size={13} strokeWidth={2} aria-hidden="true" />
                    {PI_VERSION_PDF_VIEW_LABEL(mainPi.version.versionNumber)}
                  </button>
                )}
                {mainPi.version.editedInApp ? (
                  /* EDITED IN THE APP (20270103000000): this version has no
                     workbook of its own, and the original upload is V1's file,
                     never this one's. Its details are the PI; show them there. */
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost order-doc-action order-doc-action--main"
                    onClick={() => document.querySelector('section[aria-label="PI versions"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    title={PI_EDITED_VERSION_WORKBOOK_NOTE(mainPi.version.versionNumber)}
                  >
                    <FileSpreadsheet size={13} strokeWidth={2} aria-hidden="true" />
                    View in PI versions
                  </button>
                ) : (
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost order-doc-action order-doc-action--main"
                    onClick={() => onView(mainPi.version)}
                    disabled={!mainPi.hasFile || viewing}
                    title={mainPi.fileName ?? mainPi.reference}
                  >
                    <FileSpreadsheet size={13} strokeWidth={2} aria-hidden="true" />
                    {viewing ? 'Opening…' : DOC_VIEW_PI_LABEL}
                  </button>
                )}
                {mainPiMenu ?? (
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost order-doc-action"
                    onClick={() => onDownload(mainPi.version)}
                    disabled={!mainPi.hasFile || downloading}
                    aria-label={MAIN_PI_DOWNLOAD_LABEL}
                    title={MAIN_PI_DOWNLOAD_LABEL}
                  >
                    <Download size={13} strokeWidth={2} aria-hidden="true" />
                    {downloading ? 'Preparing…' : null}
                  </button>
                )}
              </>
            }
          >
            {mainPi.fileName && <p className="order-doc-note order-doc-row-file">{mainPi.fileName}</p>}
            {mainPiOperations?.line && <p className="order-doc-note">{mainPiOperations.line}</p>}
          </DocRow>
        )}

        {/* ── Design Files: the Order's accepted files, then the PI's own
            product pictures as a quiet secondary link. ── */}
        {(() => {
          const row = supporting?.design
          const pictures = design.kind === 'ready' ? (
            <button type="button" className="order-docs-link order-docs-link--small" onClick={onManageDesign}>
              {DOC_PI_PICTURES_LABEL(design.total)}
            </button>
          ) : null
          if (!row) {
            // No supporting-document read (legacy): the PI pictures are the row.
            return (
              <DocRow title={DOC_DESIGN_FILES_TITLE} actions={pictures}>
                {design.kind === 'loading' && <p className="order-doc-loading" role="status">{DESIGN_IMAGES_LOADING}</p>}
                {design.kind === 'unavailable' && <><p className="order-doc-unavailable">{design.message}</p><p className="order-doc-note">{design.note}</p></>}
                {design.kind === 'empty' && <><p className="order-doc-empty">{design.message}</p>{design.note && <p className="order-doc-note">{design.note}</p>}</>}
                {design.kind === 'ready' && <><p className="order-doc-row-value">{design.summary}</p><p className="order-doc-note">{design.detail}</p></>}
              </DocRow>
            )
          }
          return (
            <DocRow
              title={DOC_DESIGN_FILES_TITLE}
              status={row.kind === 'files' && row.files.length > 1 ? <span className="order-doc-count">{fileCountLabel(row.files.length)}</span> : undefined}
              meta={row.kind === 'files' && row.acceptedAt ? <DocMeta items={[{ label: DOC_ACCEPTED_LABEL, value: supporting.formatWhen(row.acceptedAt) }]} /> : undefined}
              actions={pictures}
            >
              <SupportingBody row={row} onOpen={open} />
            </DocRow>
          )
        })()}

        {/* ── Client PO: the accepted copy, or a plain statement that none is on file. ── */}
        {supporting ? (
          <DocRow
            title={DOC_CLIENT_PO_TITLE}
            status={supporting.clientPo.kind === 'files' && supporting.clientPo.files.length > 1
              ? <span className="order-doc-count">{fileCountLabel(supporting.clientPo.files.length)}</span> : undefined}
            meta={supporting.clientPo.kind === 'files' && supporting.clientPo.acceptedAt
              ? <DocMeta items={[{ label: DOC_ACCEPTED_LABEL, value: supporting.formatWhen(supporting.clientPo.acceptedAt) }]} /> : undefined}
          >
            <SupportingBody row={supporting.clientPo} onOpen={open} />
          </DocRow>
        ) : (
          <DocRow title={DOC_CLIENT_PO_TITLE}>
            {clientPo?.kind === 'ready' ? (
              <p className="order-doc-row-value">{clientPo.summary}</p>
            ) : (
              <>
                <p className="order-doc-empty">{clientPo?.kind === 'unsupported' ? clientPo.message : DOC_NOT_ATTACHED}</p>
                <p className="order-doc-note">{clientPo?.kind === 'unsupported' ? clientPo.note : CLIENT_PO_UNSUPPORTED_NOTE}</p>
              </>
            )}
          </DocRow>
        )}
      </div>
      {fileError && <p className="order-doc-unavailable order-docs-error" role="alert">{fileError}</p>}
    </section>
  )
}

/** What is on file for one supporting category — accepted files only. */
function SupportingBody({ row, onOpen }: { row: SupportingRowView; onOpen: (f: PersistedDocumentFile) => void }) {
  if (row.kind === 'loading') return <p className="order-doc-loading" role="status">Loading…</p>
  if (row.kind === 'unavailable') return <p className="order-doc-unavailable">These files could not be read.</p>
  if (row.kind === 'none') {
    return (
      <>
        <p className="order-doc-empty">{row.message}</p>
        {row.note && <p className="order-doc-note">{row.note}</p>}
      </>
    )
  }
  return <FileLinks files={row.files} onOpen={onOpen} />
}

const fileCountLabel = (n: number) => `${n} file${n === 1 ? '' : 's'}`

/**
 * WHERE FABRIC AND FINISH STAND — one compact strip above the Documents card.
 *
 * Two status items and one Update action. The status is WORDS with a small dot
 * beside them, not two large tinted pills: "Not Approved" is where every Order
 * starts, and drawing it as a pair of red badges made the calmest state on the
 * page its loudest.
 *
 * A date and a name are drawn only for a status that HAS an event: Not
 * Approved is where every Order starts, and dating it would date an event that
 * never happened. The permanent trail is behind a disclosure per kind.
 *
 * THE UPDATE CONTROL IS A COURTESY, NOT THE SECURITY. It is drawn for the
 * assigned salesperson, an admin or a manager, and never under View As — and
 * record_order_approval_event() re-derives every bit of that under a row lock.
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
    <section className="order-ff" aria-label={FABRIC_FINISH_TITLE}>
      <h2 className="order-ff-title">{FABRIC_FINISH_TITLE}</h2>
      <dl className="order-ff-items">
        {standing.kinds.map(kind => (
          <div key={kind.kind} className="order-ff-item">
            <dt className="order-ff-label">{kind.label}</dt>
            <dd className="order-ff-value">
              <span className={`order-ff-status order-ff-status--${kind.tone}`}>
                <span className="order-ff-dot" aria-hidden="true" />
                {APPROVAL_STATUS_LABEL[kind.status]}
              </span>
              {kind.at && <span className="order-status-approval-at">{kind.at}</span>}
              {kind.approver && <span className="order-status-approval-by">by {kind.approver}</span>}
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
              {/* THE PERMANENT TRAIL, and only when there is one — append-only,
                  so a status this kind has left is still on record with its
                  actor, its moment and its proof. Closed by default. */}
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
            </dd>
          </div>
        ))}
      </dl>
      <div className="order-ff-end">
        {canUpdate ? (
          <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onUpdate}>
            {FABRIC_FINISH_UPDATE_LABEL}
          </button>
        ) : (
          <p className="order-status-note">{standing.readOnlyNote}</p>
        )}
      </div>
    </section>
  )
}

/**
 * FABRIC & FINISH, THEN DOCUMENTS — full width, stacked, one gap between them.
 *
 * It was a two-thirds / one-third row, which left the Fabric & Finish card a
 * short box beside a tall one and the Documents card a 40/60 split of its own
 * with an empty Main PI column. Both are full width now: the approvals as a
 * one-line strip, the paperwork as rows that use the whole width.
 */
export function OrderDocumentsRow({ children }: { children: React.ReactNode }) {
  return <div className="order-docs-row">{children}</div>
}

// ── 4. Operations review: the reviewer's decision ─────────────────────────────

/**
 * THE OPERATIONS REVIEWER'S DECISION ON THE PI VERSION IN FORCE
 * (20261229000000), drawn as the two buttons on the right of the attention
 * strip that already names that version as awaiting review or flagged.
 *
 * IT REPLACED THE OPERATIONS REVIEW CARD, which restated the version, the
 * approver, the reviewer and the alignment — facts the strip, the Production
 * row of the summary and the Documents box already carry, and the Order's
 * activity trail keeps on record. Only the decision moved; the rule behind it
 * did not.
 *
 * ONE SET OF CONTROLS, FOR ONE PERSON. They come from view.actions, which
 * draws them only for the assigned operations reviewer, never under View As,
 * and never for an administrator in their place — being an admin is not being
 * operations. decide_order_operations_handoff() re-derives all of that under a
 * row lock, so a call from somebody who never saw the buttons is refused just
 * the same.
 *
 * NOTHING ONCE THE VERSION IS ACCEPTED. The strip stops naming the review, so
 * these go with it; withdrawing an acceptance is a rare move and sits in the
 * header's overflow.
 */
export function OperationsReviewActions({ view, busy, onAccept, onCannotAccept }: {
  view: OperationsHandoffView | null
  busy: boolean
  onAccept: () => void
  onCannotAccept: () => void
}) {
  if (!view || view.kind !== 'recorded' || view.status === 'accepted') return null
  if (!view.actions.accept && !view.actions.cannotAccept) return null
  return (
    <>
      {view.actions.cannotAccept && (
        <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={onCannotAccept} disabled={busy}>
          {CANNOT_ACCEPT_LABEL}
        </button>
      )}
      {view.actions.accept && (
        <button type="button" className="boe-btn boe-btn-primary order-status-action" onClick={onAccept} disabled={busy}>
          {ACCEPT_FOR_PRODUCTION_LABEL}
        </button>
      )}
    </>
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
  canPropose, onPropose, canDecide, onApprove, onReject, error, supporting,
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
  /**
   * THE DESIGN FILES AND CLIENT PO SUBMISSIONS, when the page has them: one
   * History link on the Documents card opens both trails, PI versions first.
   */
  supporting?: React.ReactNode
}) {
  return (
    <Modal title={supporting ? DOCUMENTS_HISTORY_TITLE : PI_HISTORY_MODAL_TITLE} onClose={onClose} wide>
      {supporting && <h3 className="order-history-section-title">PI versions</h3>}
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
                {/* THE OPERATIONS DECISION (20270101000000): who accepted — or
                    rejected — this version for production, when, and why. */}
                {v.operationsLine && (
                  <div className="order-history-meta">
                    {v.operationsLine}{v.operationsReason ? ` — “${v.operationsReason}”` : ''}
                  </div>
                )}
                {v.status === 'admin_approved' && (
                  <div className="order-history-meta">
                    Awaiting operations acceptance{v.operationsReviewer ? ` by ${v.operationsReviewer}` : ' — no reviewer assigned'}. Not in force yet.
                  </div>
                )}

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
      {supporting && (
        <>
          <h3 className="order-history-section-title">Design Files and Client PO</h3>
          {supporting}
        </>
      )}
    </Modal>
  )
}

