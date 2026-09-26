'use client'

// DESIGN FILES AND CLIENT PO, ATTACHED WHERE THE PI IS SENT FOR APPROVAL
// (20270112000000 §11).
//
// The hook holds what the submitter chose; the picker draws it inside the
// existing "Submit for approval" dialog. Sending uploads each new file under
// the PI's own private key (writable only by the owner while the PI is a draft
// or returned, sealed on submit) and then calls ONE RPC that submits the PI
// through its unchanged door and records the documents and any confirmed
// absence in the same transaction.
//
// "ALREADY ATTACHED". A PI that was returned carries its previous attachments
// forward by default — shown with a checkbox each — so a correction does not
// mean uploading the same PO again.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FileText } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  CATEGORY_LABEL,
  DOCUMENT_ACCEPT_ATTR,
  MAX_CLIENT_PO_FILES,
  MAX_DESIGN_FILES,
  ORDER_DOCUMENT_SUBMISSION_SELECT,
  SENT_WITH_PI_TITLE,
  SUPPORTING_DOCUMENTS_NOTE,
  SUPPORTING_DOCUMENTS_TITLE,
  describeDocumentFailure,
  missingSupporting,
  piDocumentObjectPath,
  sentWithPi,
  validateDocumentFile,
  type DocumentCategory,
  type PersistedDocumentFile,
  type PersistedDocumentSubmission,
} from '@/lib/orders/orderDocumentSubmissions'

const BUCKET = 'order-files'

export type SupportingState = ReturnType<typeof usePiSupportingDocuments>

/** A file attached to the PI Draft before it is sent (20270114000000). */
export type StagedDocument = {
  id: string
  staging_submission_id: string
  category: DocumentCategory
  storage_path: string
  file_name: string
}

export function usePiSupportingDocuments(supabase: SupabaseClient, piSubmissionId: string) {
  const [previous, setPrevious] = useState<PersistedDocumentFile[]>([])
  const [keep, setKeep] = useState<Set<string>>(new Set())
  const [design, setDesign] = useState<File[]>([])
  const [po, setPo] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  // ATTACHED EARLIER (20270114000000): files uploaded on the draft page before
  // the PI is sent, under the id they will be sent with. Null until one exists.
  const [staged, setStaged] = useState<StagedDocument[]>([])
  const [stagingId, setStagingId] = useState<string | null>(null)
  const [stagedReadable, setStagedReadable] = useState(true)
  const [staging, setStaging] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // The last initial submission of this PI that its return sent back: its
  // files are offered again, kept by default. And whatever was attached to the
  // draft since and not yet sent, also kept by default.
  useEffect(() => {
    let live = true
    void (async () => {
      const [{ data }, sentIds, stagedRead] = await Promise.all([
        supabase
          .from('order_document_submissions')
          .select(ORDER_DOCUMENT_SUBMISSION_SELECT)
          .eq('pi_submission_id', piSubmissionId)
          .eq('stage', 'initial')
          .eq('status', 'rejected_admin')
          .order('submitted_at', { ascending: false })
          .limit(1),
        supabase.from('order_document_submissions').select('id').eq('pi_submission_id', piSubmissionId),
        supabase
          .from('order_pi_staged_documents')
          .select('id, staging_submission_id, category, storage_path, file_name')
          .eq('pi_submission_id', piSubmissionId)
          .order('uploaded_at', { ascending: true }),
      ])
      if (!live) return
      const last = ((data ?? []) as unknown as PersistedDocumentSubmission[])[0]
      const carried = last?.files ?? []
      // A staged file whose staging id has since been SENT belongs to that
      // submission now, and is not offered again as unsent.
      const sent = new Set(((sentIds.data ?? []) as { id: string }[]).map(r => r.id))
      const unsent = stagedRead.error
        ? []
        : ((stagedRead.data ?? []) as StagedDocument[]).filter(s => !sent.has(s.staging_submission_id))
      // ROLLOUT SAFETY: before 20270114000000 the table does not exist; the
      // draft page then offers no early attachment rather than a broken one.
      setStagedReadable(!stagedRead.error)
      setStaged(unsent)
      setStagingId(unsent[0]?.staging_submission_id ?? null)
      const offered: PersistedDocumentFile[] = [
        ...carried,
        ...unsent.map(s => ({
          id: s.id, category: s.category, storage_path: s.storage_path, file_name: s.file_name,
          mime_type: '', size_bytes: 0,
        })),
      ]
      setPrevious(offered)
      setKeep(new Set(offered.map(f => f.storage_path)))
    })()
    return () => { live = false }
  }, [supabase, piSubmissionId, reloadKey])

  /**
   * Attach files to the draft now; they are sent with the PI later. Uploaded
   * under the one staging id (the storage rule the dialog uses allows exactly
   * this key while the PI is a draft or returned), then recorded by name.
   */
  const stage = useCallback(async (list: FileList | null, category: DocumentCategory): Promise<string | null> => {
    const files = Array.from(list ?? [])
    if (files.length === 0) return null
    const bad = files.map(validateDocumentFile).find(Boolean)
    if (bad) return bad
    const max = category === 'design_files' ? MAX_DESIGN_FILES : MAX_CLIENT_PO_FILES
    if (staged.filter(s => s.category === category).length + files.length > max) {
      return `At most ${max} ${CATEGORY_LABEL[category]} files.`
    }
    setStaging(true)
    const id = stagingId ?? crypto.randomUUID()
    try {
      for (const file of files) {
        const path = piDocumentObjectPath({
          piSubmissionId, submissionId: id, category, fileId: crypto.randomUUID(), mime: file.type,
        })
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
        if (upErr) return `${file.name} could not be uploaded. Nothing else was changed.`
        const { error: rowErr } = await supabase.from('order_pi_staged_documents').insert({
          pi_submission_id: piSubmissionId, staging_submission_id: id, category,
          storage_path: path, file_name: file.name.slice(0, 200),
        })
        if (rowErr) return `${file.name} was uploaded but could not be recorded on this PI. Try again.`
      }
      return null
    } finally {
      setStaging(false)
      setReloadKey(k => k + 1)
    }
  }, [supabase, piSubmissionId, staged, stagingId])

  /** Take a staged file off the list. It is simply not sent. */
  const unstage = useCallback(async (path: string): Promise<string | null> => {
    const { error: delErr } = await supabase.from('order_pi_staged_documents').delete().eq('storage_path', path)
    setReloadKey(k => k + 1)
    return delErr ? 'That file could not be removed from this PI just now.' : null
  }, [supabase])

  const kept = useMemo(() => previous.filter(f => keep.has(f.storage_path)), [previous, keep])
  const count = (c: DocumentCategory) =>
    kept.filter(f => f.category === c).length + (c === 'design_files' ? design.length : po.length)
  const missing = missingSupporting({ designCount: count('design_files'), clientPoCount: count('client_po') })

  const pick = (list: FileList | null, category: DocumentCategory) => {
    const files = Array.from(list ?? [])
    const bad = files.map(validateDocumentFile).find(Boolean)
    if (bad) { setError(bad); return }
    const max = category === 'design_files' ? MAX_DESIGN_FILES : MAX_CLIENT_PO_FILES
    if (files.length > max) { setError(`At most ${max} ${CATEGORY_LABEL[category]} files.`); return }
    setError(null)
    if (category === 'design_files') setDesign(files); else setPo(files)
  }

  const toggle = (path: string) => setKeep(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })

  /**
   * Upload the new files, then send the PI with them in ONE transaction.
   * Returns the RPC's own { data, error } so the caller treats it exactly as
   * it treats submit_pi_for_review.
   */
  const send = useCallback(async (input: {
    note: string | null
    terms: { reason: string | null; paymentTerms: string | null; billingTerms: string | null }
    acknowledgedMissing: string[]
  }): Promise<{ data: unknown; error: { message: string } | null }> => {
    // Files attached to the draft earlier were uploaded under the staging id,
    // so the submission is sent under that same id (20270114000000).
    const documentSubmissionId = stagingId ?? crypto.randomUUID()
    const files: { path: string; file_name: string }[] = kept.map(f => ({ path: f.storage_path, file_name: f.file_name }))
    const fresh: { file: File; category: DocumentCategory }[] = [
      ...design.map(file => ({ file, category: 'design_files' as const })),
      ...po.map(file => ({ file, category: 'client_po' as const })),
    ]
    for (const { file, category } of fresh) {
      const path = piDocumentObjectPath({
        piSubmissionId, submissionId: documentSubmissionId, category, fileId: crypto.randomUUID(), mime: file.type,
      })
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      if (upErr) return { data: null, error: { message: `${file.name} could not be uploaded. The PI was not sent.` } }
      files.push({ path, file_name: file.name.slice(0, 200) })
    }
    const { data, error: rpcErr } = await supabase.rpc('submit_pi_for_review_with_documents', {
      p_submission_id: piSubmissionId,
      p_note: input.note,
      p_reason: input.terms.reason,
      p_payment_terms: input.terms.paymentTerms,
      p_billing_terms: input.terms.billingTerms,
      p_document_submission_id: files.length > 0 ? documentSubmissionId : null,
      p_files: files,
      p_acknowledged_missing: input.acknowledgedMissing,
    })
    // ROLLOUT SAFETY. If this code reaches a database without 20270112000000,
    // the wrapper does not exist (PostgREST PGRST202). A PI with nothing
    // attached is then sent exactly as before, through the one door; one WITH
    // attachments is refused in words rather than sent without them.
    const missingFn = (rpcErr as { code?: string } | null)?.code === 'PGRST202'
    if (missingFn && files.length === 0) {
      return supabase.rpc('submit_pi_for_review', {
        p_submission_id: piSubmissionId,
        p_note: input.note,
        p_reason: input.terms.reason,
        p_payment_terms: input.terms.paymentTerms,
        p_billing_terms: input.terms.billingTerms,
      }) as unknown as Promise<{ data: unknown; error: { message: string } | null }>
    }
    if (missingFn) {
      return { data: null, error: { message: 'Attaching files to a PI is not available yet. Remove the attachments to send the PI.' } }
    }
    if (rpcErr && /ORDER_DOCUMENT_/.test(rpcErr.message ?? '')) {
      return { data, error: { message: describeDocumentFailure(rpcErr) } }
    }
    return { data, error: rpcErr }
  }, [supabase, piSubmissionId, kept, design, po, stagingId])

  return {
    previous, keep, toggle, design, po, pick, error, missing, send,
    staged, stagedReadable, staging, stage, unstage,
  }
}

function Row({ file }: { file: { name: string; size: number } }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: colors.primary }}>
      <FileText size={12} strokeWidth={2} aria-hidden="true" />
      <span style={{ overflowWrap: 'anywhere' }}>{file.name}</span>
      <span style={{ color: colors.muted, fontSize: '11px' }}>{Math.max(1, Math.round(file.size / 1024))} KB</span>
    </li>
  )
}

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
}

/**
 * What a SUBMITTED PI carries, read-only, and who acts next — shown until the
 * Order exists, after which the Order page's Documents section takes over.
 * `refreshKey` is the PI's submitted_at, so a resubmission re-reads it.
 */
export function PiSentDocuments({ supabase, piSubmissionId, refreshKey }: {
  supabase: SupabaseClient
  piSubmissionId: string
  refreshKey: string | null
}) {
  const [rows, setRows] = useState<PersistedDocumentSubmission[]>([])
  useEffect(() => {
    let live = true
    void (async () => {
      const { data } = await supabase
        .from('order_document_submissions')
        .select(ORDER_DOCUMENT_SUBMISSION_SELECT)
        .eq('pi_submission_id', piSubmissionId)
        .eq('stage', 'initial')
      if (live) setRows((data ?? []) as unknown as PersistedDocumentSubmission[])
    })()
    return () => { live = false }
  }, [supabase, piSubmissionId, refreshKey])

  const shown = sentWithPi(rows)
  if (!shown) return null
  const files = shown.submission.files ?? []
  return (
    <section aria-label={SENT_WITH_PI_TITLE} style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>{SENT_WITH_PI_TITLE}</div>
      {(['design_files', 'client_po'] as const).map(category => {
        const inCategory = files.filter(f => f.category === category)
        if (inCategory.length === 0) return null
        return (
          <div key={category} role="group" aria-label={CATEGORY_LABEL[category]}
               style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span style={LABEL}>{CATEGORY_LABEL[category]}</span>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {inCategory.map(f => <Row key={f.storage_path} file={{ name: f.file_name, size: f.size_bytes }} />)}
            </ul>
          </div>
        )
      })}
      <div style={{ fontSize: '12px', color: colors.primary, lineHeight: 1.5 }}>
        <div><span style={{ color: colors.muted }}>Current owner:</span> {shown.owner}</div>
        <div><span style={{ color: colors.muted }}>Next:</span> {shown.next}, then Operations accepts them with PI V1</div>
      </div>
    </section>
  )
}

export const DRAFT_ATTACHMENTS_TITLE = 'Client PO and Design Files (optional)'
export const DRAFT_ATTACHMENTS_NOTE =
  'Attach them now or later — they are sent with the PI when you submit it for approval, and stay private to the people who can open this PI.'

/**
 * CLIENT PO AND DESIGN FILES ON THE DRAFT (20270114000000).
 *
 * Attached any time while the PI is a draft or returned, kept between visits,
 * and ticked by default in the "Submit for approval" dialog, which sends them.
 * Real storage, the same private key and rule the dialog uses; nothing here is
 * approved or made current — that is still the PI's own decisions, then
 * Operations. Drawn only once the database can remember the files: before the
 * migration the card offers nothing rather than an upload that would be lost.
 */
export function PiDraftAttachments({ supabase, state, canEdit }: {
  supabase: SupabaseClient
  state: SupportingState
  canEdit: boolean
}) {
  const [failure, setFailure] = useState<string | null>(null)
  if (!state.stagedReadable) return null
  if (!canEdit && state.staged.length === 0) return null

  const open = async (path: string) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    else setFailure('That file could not be opened just now.')
  }

  return (
    <section aria-label={DRAFT_ATTACHMENTS_TITLE} style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: '10px', background: colors.base,
    }}>
      <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>{DRAFT_ATTACHMENTS_TITLE}</div>
      {(['design_files', 'client_po'] as const).map(category => {
        const files = state.staged.filter(s => s.category === category)
        return (
          <div key={category} role="group" aria-label={CATEGORY_LABEL[category]}
               style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <span style={LABEL}>{CATEGORY_LABEL[category]}</span>
            {files.length === 0 ? (
              <span style={{ fontSize: '12px', color: colors.muted }}>None attached yet</span>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {files.map(f => (
                  <li key={f.storage_path} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', flexWrap: 'wrap' }}>
                    <FileText size={12} strokeWidth={2} aria-hidden="true" />
                    <button type="button" onClick={() => void open(f.storage_path)}
                            style={{ overflowWrap: 'anywhere', textAlign: 'left', background: 'none', border: 'none', padding: 0, color: colors.blue, textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
                      {f.file_name}
                    </button>
                    {canEdit && (
                      <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '2px 8px', fontSize: '11.5px' }}
                              disabled={state.staging}
                              aria-label={`Remove ${f.file_name}`}
                              onClick={() => void state.unstage(f.storage_path).then(setFailure)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <label className="boe-btn boe-btn-ghost" style={{ alignSelf: 'flex-start', cursor: state.staging ? 'default' : 'pointer' }}>
                {state.staging ? 'Uploading…' : `Add ${CATEGORY_LABEL[category]}`}
                <input type="file" multiple={category === 'design_files'} accept={DOCUMENT_ACCEPT_ATTR}
                       disabled={state.staging} style={{ display: 'none' }}
                       aria-label={`Add ${CATEGORY_LABEL[category]}`}
                       onChange={e => { const list = e.target.files; void state.stage(list, category).then(setFailure); e.target.value = '' }} />
              </label>
            )}
          </div>
        )
      })}
      <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.45 }}>
        PDF, PNG, JPEG or WebP, up to 10 MB each. {DRAFT_ATTACHMENTS_NOTE}
      </div>
      {failure && <div role="alert" style={{ fontSize: '11.5px', color: colors.red }}>{failure}</div>}
    </section>
  )
}

/** The two optional categories, drawn inside the submit dialog. */
export function PiSupportingDocumentsPicker({ state, disabled }: { state: SupportingState; disabled: boolean }) {
  const section = (category: DocumentCategory) => {
    const carried = state.previous.filter(f => f.category === category)
    const chosen = category === 'design_files' ? state.design : state.po
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }} aria-label={CATEGORY_LABEL[category]} role="group">
        <span style={LABEL}>{CATEGORY_LABEL[category]}</span>
        {carried.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {carried.map(f => (
              <li key={f.storage_path}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}>
                  <input type="checkbox" checked={state.keep.has(f.storage_path)} disabled={disabled}
                         onChange={() => state.toggle(f.storage_path)} />
                  Already attached: {f.file_name}
                </label>
              </li>
            ))}
          </ul>
        )}
        <input type="file" multiple accept={DOCUMENT_ACCEPT_ATTR} disabled={disabled}
               aria-label={`Attach ${CATEGORY_LABEL[category]}`}
               onChange={e => state.pick(e.target.files, category)} />
        {chosen.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {chosen.map(f => <Row key={f.name + f.size} file={f} />)}
          </ul>
        )}
        {!state.missing.includes(category)
          ? <span style={{ fontSize: '11.5px', color: '#2F7A52', fontWeight: 600 }}>Attached to this submission</span>
          : <span style={{ fontSize: '11.5px', color: colors.muted }}>Nothing attached</span>}
      </div>
    )
  }
  return (
    <section style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: '12px',
    }} aria-label={SUPPORTING_DOCUMENTS_TITLE}>
      <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>{SUPPORTING_DOCUMENTS_TITLE}</div>
      {section('design_files')}
      {section('client_po')}
      <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.45 }}>
        PDF, PNG, JPEG or WebP, up to 10 MB each. {SUPPORTING_DOCUMENTS_NOTE}
      </div>
      {state.error && <div role="alert" style={{ fontSize: '11.5px', color: colors.red }}>{state.error}</div>}
    </section>
  )
}
