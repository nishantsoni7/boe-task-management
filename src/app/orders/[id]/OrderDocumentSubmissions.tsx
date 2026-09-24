'use client'

// DESIGN FILES AND CLIENT PO ON A CONFIRMED ORDER: what is accepted, what is
// proposed, and the one decision the reader owns (20261231000000).
//
// PAGE-OWNED, like OrderStatusWorkspace.tsx beside it. The hook reads and
// writes through the reader's own session; every write is an RPC that
// re-derives who may do it under row locks. Controls are drawn only for the
// person whose stage it is — never under View As — and hiding one is a
// courtesy: the database refuses the same call from anybody else.
//
// NOTHING PROPOSED IS DRAWN AS CURRENT. The Documents card's rows are derived
// from accepted submissions only (supportingRow); a pending or rejected
// submission is one entry in its "Document changes" panel (documentChanges),
// labelled with its stage and owner. This file keeps the hook, the two dialogs
// and the permanent trail the History dialog lists.

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FileText } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  OrderModal, OrderField, OrderModalActions, OrderModalError, OrderModalNotice,
} from '@/components/orders/OrderModal'
import {
  ADMIN_APPROVE_LABEL,
  ADMIN_REJECT_LABEL,
  CATEGORY_LABEL,
  CATEGORY_PENDING_BLOCKS_UPLOAD,
  DECISION_REASON_MAX_LENGTH,
  DESIGN_MODE_ADD_LABEL,
  DESIGN_MODE_REPLACE_LABEL,
  DOCUMENT_ACCEPT_ATTR,
  MAX_CLIENT_PO_FILES,
  MAX_DESIGN_FILES,
  NOTE_MAX_LENGTH,
  OPS_ACCEPT_LABEL,
  OPS_REJECT_LABEL,
  ORDER_DOCUMENT_SUBMISSION_SELECT,
  SUBMISSION_STATUS_LABEL,
  SUBMISSION_STATUS_TONE,
  SUBMIT_DOCUMENTS_CONFIRM,
  SUBMIT_DOCUMENTS_NOTE,
  SUBMIT_DOCUMENTS_TITLE,
  categoriesLabel,
  currentAcceptedFiles,
  describeDocumentFailure,
  documentObjectPath,
  openSubmissionFor,
  rejectionOf,
  submissionActions,
  validateDecisionReason,
  validateDocumentFile,
  type DocumentCategory,
  type DocumentViewer,
  type PersistedDocumentFile,
  type PersistedAbsence,
  type PersistedDocumentSubmission,
} from '@/lib/orders/orderDocumentSubmissions'
import { StatusPill } from './OrderStatusWorkspace'

const BUCKET = 'order-files'
const URL_TTL_SECONDS = 60 * 10

const TEXTAREA: React.CSSProperties = {
  padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${colors.border}`, background: colors.base, color: colors.primary,
  fontSize: '13px', width: '100%', boxSizing: 'border-box', outline: 'none',
  minHeight: '64px', resize: 'vertical', fontFamily: 'inherit',
}

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

// ── The hook: one read, three writes, one signer ─────────────────────────────

export type SubmitInput = {
  designFiles: File[]
  designMode: 'add' | 'replace' | null
  clientPoFiles: File[]
  note: string
  resubmissionOf: string | null
}

export function useOrderDocumentSubmissions(supabase: SupabaseClient, orderId: string | null, piSubmissionId: string | null = null) {
  const [absence, setAbsence] = useState<PersistedAbsence | null>(null)
  const [rows, setRows] = useState<PersistedDocumentSubmission[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [names, setNames] = useState<Map<string, string>>(new Map())

  /** One read of the submissions (files embedded) and the names they cite. */
  const fetchAll = useCallback(async (): Promise<
    { ok: false } | { ok: true; list: PersistedDocumentSubmission[]; names: Map<string, string>; absence: PersistedAbsence | null }
  > => {
    if (!orderId) return { ok: false }
    const { data, error } = await supabase
      .from('order_document_submissions')
      .select(ORDER_DOCUMENT_SUBMISSION_SELECT)
      .eq('order_id', orderId)
      .order('submitted_at', { ascending: false })
    if (error) return { ok: false }
    const list = (data ?? []) as unknown as PersistedDocumentSubmission[]
    // THE ACKNOWLEDGED ABSENCE from the PI's submission, if its PI said so.
    let absence: PersistedAbsence | null = null
    if (piSubmissionId) {
      const { data: abs } = await supabase
        .from('order_pi_document_absences')
        .select('missing, acknowledged_by, acknowledged_at')
        .eq('pi_submission_id', piSubmissionId)
        .order('acknowledged_at', { ascending: false })
        .limit(1)
      absence = ((abs ?? [])[0] as PersistedAbsence | undefined) ?? null
    }
    const ids = new Set<string>()
    for (const r of list) {
      for (const uid of [r.submitted_by, r.admin_decided_by, r.operations_reviewer, r.operations_decided_by]) if (uid) ids.add(uid)
    }
    if (absence) ids.add(absence.acknowledged_by)
    let names = new Map<string, string>()
    if (ids.size > 0) {
      const { data: users } = await supabase.from('users').select('id, full_name').in('id', [...ids])
      names = new Map((users ?? []).map((u: { id: string; full_name: string }) => [u.id, u.full_name]))
    }
    return { ok: true, list, names, absence }
  }, [supabase, orderId, piSubmissionId])

  const apply = useCallback((r: Awaited<ReturnType<typeof fetchAll>>) => {
    if (!r.ok) { setState('unavailable'); return }
    setRows(r.list)
    setNames(r.names)
    setAbsence(r.absence)
    setState('ready')
  }, [])

  const reload = useCallback(async () => { apply(await fetchAll()) }, [fetchAll, apply])

  useEffect(() => {
    let live = true
    void fetchAll().then(r => { if (live) apply(r) })
    return () => { live = false }
  }, [fetchAll, apply])

  /** Upload each file under a fresh submission key, then submit the snapshot. */
  const submit = useCallback(async (input: SubmitInput): Promise<string | null> => {
    if (!orderId) return 'The Order is not loaded.'
    const submissionId = crypto.randomUUID()
    const files: { path: string; file_name: string }[] = []
    const all: { file: File; category: DocumentCategory }[] = [
      ...input.designFiles.map(file => ({ file, category: 'design_files' as const })),
      ...input.clientPoFiles.map(file => ({ file, category: 'client_po' as const })),
    ]
    for (const { file, category } of all) {
      const path = documentObjectPath({ orderId, submissionId, category, fileId: crypto.randomUUID(), mime: file.type })
      const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      if (error) return `${file.name} could not be uploaded. Nothing was submitted.`
      files.push({ path, file_name: file.name.slice(0, 200) })
    }
    const { error } = await supabase.rpc('create_order_document_submission', {
      p_submission_id: submissionId,
      p_order_id: orderId,
      p_design_mode: input.designFiles.length > 0 ? input.designMode : null,
      p_note: input.note.trim() === '' ? null : input.note.trim(),
      p_files: files,
      p_resubmission_of: input.resubmissionOf,
    })
    if (error) return describeDocumentFailure(error)
    await reload()
    return null
  }, [supabase, orderId, reload])

  const decide = useCallback(async (
    s: PersistedDocumentSubmission, stage: 'admin' | 'operations', decision: 'approve' | 'reject', reason: string | null,
  ): Promise<string | null> => {
    const fn = stage === 'admin' ? 'decide_order_document_submission_admin' : 'decide_order_document_submission_operations'
    const p_decision = decision === 'reject' ? 'rejected' : stage === 'admin' ? 'approved' : 'accepted'
    const { error } = await supabase.rpc(fn, {
      p_submission_id: s.id, p_decision, p_reason: reason, p_snapshot: s.snapshot_sha256,
    })
    // A refusal still re-reads: a stale tab learns what actually happened.
    await reload()
    return error ? describeDocumentFailure(error) : null
  }, [supabase, reload])

  const openFile = useCallback(async (file: PersistedDocumentFile, download = false): Promise<string | null> => {
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(file.storage_path, URL_TTL_SECONDS, download ? { download: file.file_name } : undefined)
    if (error || !data?.signedUrl) return `${file.file_name} could not be opened.`
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    return null
  }, [supabase])

  return { rows, state, names, absence, reload, submit, decide, openFile }
}

export type DocumentSubmissionsApi = ReturnType<typeof useOrderDocumentSubmissions>

// ── The permanent trail, for the History dialog ──────────────────────────────

function FileList({ files, onOpen }: { files: PersistedDocumentFile[]; onOpen: (f: PersistedDocumentFile) => void }) {
  return (
    <ul className="order-docsub-files">
      {files.map(f => (
        <li key={f.id}>
          <button type="button" className="order-docsub-file" onClick={() => onOpen(f)} title={`Open ${f.file_name}`}>
            <FileText size={12} strokeWidth={2} aria-hidden="true" />
            <span className="order-docsub-file-name">{f.file_name}</span>
            <span className="order-docsub-file-size">{fmtBytes(f.size_bytes)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * EVERY DESIGN FILES AND CLIENT PO SUBMISSION ON THE ORDER — accepted, rejected
 * or open — newest first, with who submitted, approved and accepted it, when,
 * and why. Nothing replaced is lost; this is where it is read.
 *
 * It used to be a disclosure under each category, open in place on the page.
 * It is one list now, inside the Documents History dialog, so the card itself
 * shows only what is current and what is changing.
 */
export function SubmissionHistoryList({ api, formatWhen, onOpenFile }: {
  api: Pick<DocumentSubmissionsApi, 'rows' | 'state' | 'names'>
  formatWhen: (iso: string | null) => string
  onOpenFile: (f: PersistedDocumentFile) => void
}) {
  const nameOf = (id: string | null) => (id ? api.names.get(id) ?? null : null)
  if (api.state === 'loading') return <p className="order-doc-loading" role="status">Loading submissions…</p>
  if (api.state === 'unavailable') return <p className="order-doc-unavailable">Document submissions could not be read.</p>
  const history = api.rows.slice().sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
  if (history.length === 0) return <p className="order-status-empty">No Design Files or Client PO have been submitted on this Order.</p>
  return (
    <ol className="order-history-list">
      {history.map(r => (
        <li key={r.id} className="order-history-row">
          <div className="order-history-row-head">
            <span className="order-history-version">{categoriesLabel(r)}</span>
            <StatusPill label={SUBMISSION_STATUS_LABEL[r.status]} tone={SUBMISSION_STATUS_TONE[r.status]} />
          </div>
          <div className="order-history-meta">
            {r.stage === 'initial' ? 'Sent with the PI · ' : r.includes_design_files && r.design_mode === 'replace' ? 'Replaced the design set · ' : r.includes_design_files && r.design_mode === 'add' ? 'Added to the design set · ' : ''}
            Submitted by {nameOf(r.submitted_by) ?? 'Sales'}, {formatWhen(r.submitted_at)}
          </div>
          {r.admin_decided_at && (
            <div className="order-history-meta">
              Admin: {r.status === 'rejected_admin' ? 'rejected' : 'approved'} by {nameOf(r.admin_decided_by) ?? 'Admin'}, {formatWhen(r.admin_decided_at)}
              {r.admin_reason ? ` — ${r.admin_reason}` : ''}
            </div>
          )}
          {r.operations_decided_at && (
            <div className="order-history-meta">
              Operations: {r.status === 'accepted' ? 'accepted' : 'rejected'} by {nameOf(r.operations_decided_by) ?? 'Operations'}, {formatWhen(r.operations_decided_at)}
              {r.operations_reason ? ` — ${r.operations_reason}` : ''}
            </div>
          )}
          {r.note && <div className="order-history-meta">Note: “{r.note}”</div>}
          <FileList files={r.files ?? []} onOpen={onOpenFile} />
        </li>
      ))}
    </ol>
  )
}

/**
 * WHETHER A CATEGORY CAN TAKE A NEW SUBMISSION NOW, for the Update documents
 * menu: not while one is already under review (the database allows one open
 * submission per category), and not for a reader who may not submit at all.
 */
export function uploadAvailability(
  category: DocumentCategory,
  api: Pick<DocumentSubmissionsApi, 'rows' | 'state'>,
  viewer: DocumentViewer,
): { offered: boolean; blockedReason: string | null } {
  if (!viewer.canSubmit || viewer.viewingAs || api.state !== 'ready') return { offered: false, blockedReason: null }
  return openSubmissionFor(api.rows, category) !== null
    ? { offered: true, blockedReason: CATEGORY_PENDING_BLOCKS_UPLOAD(CATEGORY_LABEL[category]) }
    : { offered: true, blockedReason: null }
}

// ── Submit dialog ────────────────────────────────────────────────────────────

export function SubmitDocumentsModal({
  orderNumber, initialCategory, api, resubmissionOf, onClose,
}: {
  orderNumber: string
  initialCategory: DocumentCategory
  api: Pick<DocumentSubmissionsApi, 'rows' | 'submit'>
  resubmissionOf: PersistedDocumentSubmission | null
  onClose: () => void
}) {
  const designBlocked = openSubmissionFor(api.rows, 'design_files') !== null
  const poBlocked = openSubmissionFor(api.rows, 'client_po') !== null
  const [design, setDesign] = useState<File[]>([])
  const [po, setPo] = useState<File[]>([])
  const [mode, setMode] = useState<'add' | 'replace' | null>(resubmissionOf?.design_mode ?? null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [includeDesign, setIncludeDesign] = useState(
    resubmissionOf ? resubmissionOf.includes_design_files : initialCategory === 'design_files')
  const [includePo, setIncludePo] = useState(
    resubmissionOf ? resubmissionOf.includes_client_po : initialCategory === 'client_po')

  const pick = (list: FileList | null, max: number, set: (f: File[]) => void) => {
    const files = Array.from(list ?? [])
    const bad = files.map(validateDocumentFile).find(Boolean)
    if (bad) { setFailure(bad); return }
    if (files.length > max) { setFailure(`At most ${max} files.`); return }
    setFailure(null)
    set(files)
  }

  const problems: string[] = []
  if (!includeDesign && !includePo) problems.push('Choose Design Files, Client PO, or both.')
  if (includeDesign && design.length === 0) problems.push('Attach the design files.')
  if (includeDesign && mode === null) problems.push('Choose whether the design files are added or replace the current ones.')
  if (includePo && po.length === 0) problems.push('Attach the client PO.')
  if (includeDesign && designBlocked) problems.push(CATEGORY_PENDING_BLOCKS_UPLOAD('Design Files'))
  if (includePo && poBlocked) problems.push(CATEGORY_PENDING_BLOCKS_UPLOAD('Client PO'))
  const ok = problems.length === 0

  return (
    <OrderModal
      title={resubmissionOf ? 'Correct and resubmit documents' : SUBMIT_DOCUMENTS_TITLE}
      subtitle={`Order ${orderNumber}`}
      onClose={() => { if (!saving) onClose() }}
    >
      <OrderModalNotice>{SUBMIT_DOCUMENTS_NOTE}</OrderModalNotice>
      {resubmissionOf && (() => {
        const rej = rejectionOf(resubmissionOf)
        return rej ? <OrderModalNotice tone="warning">Rejected by {rej.stage}: {rej.reason}</OrderModalNotice> : null
      })()}

      <fieldset className="order-docsub-fieldset">
        <legend>What this submission changes</legend>
        <label className="order-docsub-check">
          <input type="checkbox" checked={includeDesign} disabled={saving || designBlocked}
                 onChange={e => setIncludeDesign(e.target.checked)} />
          {CATEGORY_LABEL.design_files}{designBlocked && ' — a submission is already under review'}
        </label>
        <label className="order-docsub-check">
          <input type="checkbox" checked={includePo} disabled={saving || poBlocked}
                 onChange={e => setIncludePo(e.target.checked)} />
          {CATEGORY_LABEL.client_po}{poBlocked && ' — a submission is already under review'}
        </label>
      </fieldset>

      {includeDesign && (
        <>
          <OrderField label="Design files (PDF, PNG, JPEG or WebP, up to 10 MB each)">
            <input type="file" multiple accept={DOCUMENT_ACCEPT_ATTR} disabled={saving}
                   onChange={e => pick(e.target.files, MAX_DESIGN_FILES, setDesign)} />
          </OrderField>
          <fieldset className="order-docsub-fieldset">
            <legend>Add or replace?</legend>
            <label className="order-docsub-check">
              <input type="radio" name="design-mode" checked={mode === 'add'} disabled={saving} onChange={() => setMode('add')} />
              {DESIGN_MODE_ADD_LABEL}
            </label>
            <label className="order-docsub-check">
              <input type="radio" name="design-mode" checked={mode === 'replace'} disabled={saving} onChange={() => setMode('replace')} />
              {DESIGN_MODE_REPLACE_LABEL}
            </label>
          </fieldset>
        </>
      )}
      {includePo && (
        <OrderField label="Client PO (PDF, PNG, JPEG or WebP, up to 10 MB each)">
          <input type="file" multiple accept={DOCUMENT_ACCEPT_ATTR} disabled={saving}
                 onChange={e => pick(e.target.files, MAX_CLIENT_PO_FILES, setPo)} />
        </OrderField>
      )}
      <OrderField label="Note for the reviewers (optional)">
        <textarea value={note} maxLength={NOTE_MAX_LENGTH} disabled={saving} rows={2} style={TEXTAREA}
                  onChange={e => setNote(e.target.value)} />
      </OrderField>
      {!ok && (includeDesign || includePo) && <p className="order-doc-note" role="status">{problems[0]}</p>}
      {failure && <OrderModalError message={failure} />}
      <OrderModalActions
        onClose={onClose}
        onSave={async () => {
          if (!ok || saving) return
          setSaving(true)
          setFailure(null)
          const err = await api.submit({
            designFiles: includeDesign ? design : [],
            designMode: includeDesign ? mode : null,
            clientPoFiles: includePo ? po : [],
            note,
            resubmissionOf: resubmissionOf?.id ?? null,
          })
          setSaving(false)
          if (err) { setFailure(err); return }
          onClose()
        }}
        saving={saving}
        disabled={!ok}
        saveLabel={SUBMIT_DOCUMENTS_CONFIRM}
      />
    </OrderModal>
  )
}

// ── Review dialog: the exact snapshot, the accepted set beside it ────────────

export function ReviewSubmissionModal({
  orderNumber, submission, api, viewer, formatWhen, onClose,
}: {
  orderNumber: string
  submission: PersistedDocumentSubmission
  api: Pick<DocumentSubmissionsApi, 'rows' | 'names' | 'decide' | 'openFile'>
  viewer: DocumentViewer
  formatWhen: (iso: string | null) => string
  onClose: () => void
}) {
  const actions = submissionActions(submission, viewer)
  const stage: 'admin' | 'operations' | null = actions.adminDecide ? 'admin' : actions.operationsDecide ? 'operations' : null
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const nameOf = (id: string | null) => (id ? api.names.get(id) ?? null : null)

  const decide = async (decision: 'approve' | 'reject') => {
    const check = validateDecisionReason(reason, decision === 'reject')
    if (!check.ok) { setFailure(check.message); return }
    if (!stage || saving) return
    setSaving(true)
    setFailure(null)
    const err = await api.decide(submission, stage, decision, check.reason)
    setSaving(false)
    if (err) { setFailure(err); return }
    onClose()
  }
  const open = async (f: PersistedDocumentFile) => { const e = await api.openFile(f); if (e) setFailure(e) }

  return (
    <OrderModal
      title={`Review ${categoriesLabel(submission)}`}
      subtitle={`Order ${orderNumber} · ${SUBMISSION_STATUS_LABEL[submission.status]}`}
      onClose={() => { if (!saving) onClose() }}
      width={640}
    >
      <OrderModalNotice>
        {stage === 'admin'
          ? 'Approving sends this exact set of files to Operations. Nothing becomes current until Operations accepts it.'
          : stage === 'operations'
            ? 'Accepting makes these files the current accepted documents on this Order. The previous files stay in history.'
            : 'This submission is not at a stage you decide.'}
      </OrderModalNotice>
      <p className="order-doc-note">
        Submitted by {nameOf(submission.submitted_by) ?? 'Sales'} {formatWhen(submission.submitted_at)}
        {submission.admin_decided_at && ` · approved by ${nameOf(submission.admin_decided_by) ?? 'Admin'} ${formatWhen(submission.admin_decided_at)}`}
      </p>
      {submission.note && <p className="order-doc-note">Note: “{submission.note}”</p>}

      {(['design_files', 'client_po'] as const).filter(c => (c === 'design_files' ? submission.includes_design_files : submission.includes_client_po)).map(c => {
        const proposed = (submission.files ?? []).filter(f => f.category === c)
        const current = currentAcceptedFiles(api.rows, c).files
        return (
          <div key={c} className="order-docsub-compare">
            <div>
              <h4 className="order-docsub-compare-title">
                Proposed {CATEGORY_LABEL[c]}
                {c === 'design_files' && submission.design_mode && ` (${submission.design_mode === 'replace' ? 'replaces current' : 'adds to current'})`}
              </h4>
              <FileList files={proposed} onOpen={f => { void open(f) }} />
            </div>
            <div>
              <h4 className="order-docsub-compare-title">Currently accepted</h4>
              {current.length > 0 ? <FileList files={current} onOpen={f => { void open(f) }} />
                : <p className="order-doc-empty">None</p>}
            </div>
          </div>
        )
      })}

      {stage && (
        <OrderField label={rejecting ? 'Reason for rejecting (required — Sales will see it)' : 'Note (optional; required to reject)'}>
          <textarea value={reason} maxLength={DECISION_REASON_MAX_LENGTH} disabled={saving} rows={3} style={TEXTAREA}
                    onChange={e => setReason(e.target.value)} />
        </OrderField>
      )}
      {failure && <OrderModalError message={failure} />}
      {stage ? (
        <div className="order-docsub-decide">
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="boe-btn boe-btn-ghost order-docsub-reject" disabled={saving}
                  onClick={() => { setRejecting(true); void decide('reject') }}>
            {stage === 'admin' ? ADMIN_REJECT_LABEL : OPS_REJECT_LABEL}
          </button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={saving}
                  onClick={() => { setRejecting(false); void decide('approve') }}>
            {saving ? 'Saving…' : stage === 'admin' ? ADMIN_APPROVE_LABEL : OPS_ACCEPT_LABEL}
          </button>
        </div>
      ) : (
        <div className="order-docsub-decide">
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose}>Close</button>
        </div>
      )}
    </OrderModal>
  )
}
