'use client'

import { useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  MeetingModal, MeetingField, MeetingModalActions, MeetingModalError,
} from '@/components/meetings/MeetingModal'
import { ModuleMemberPicker, type PickableMember } from '../ModuleMemberPicker'
import {
  ANNOUNCEMENT_BUCKET, ANNOUNCEMENT_LIMITS, announcementErrorMessage, buildAnnouncementPdfPath,
  defaultAnnouncementWindow, formatFileSize, validateAnnouncementDraft, validateAnnouncementPdf,
  type AdminAnnouncement,
} from '@/lib/announcements'

// Create or edit one announcement. A form modal, so it follows the Form Modal
// Dismissal Rule through the shared Meetings modal shell: a backdrop click does
// nothing, and a failed save keeps every value.
//
// THE WRITE ORDER, and why:
//   1. upload the PDF (if a new one was chosen) under {id}/ — storage lets only
//      an admin do this;
//   2. call create/update_announcement, which refuses a path naming no object;
//   3. on failure, remove the just-uploaded file (an unclaimed object, which the
//      delete policy allows); on success, remove a replaced/removed old file.
// The database re-checks admin in step 2; this screen being admin-only is the
// UI half.
export function AnnouncementForm({
  existing, members, onClose, onSaved,
}: {
  existing: AdminAnnouncement | null
  members: PickableMember[]
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const initialWindow = useMemo(() => defaultAnnouncementWindow(), [])
  const [title, setTitle]       = useState(existing?.title ?? '')
  const [summary, setSummary]   = useState(existing?.summary ?? '')
  const [body, setBody]         = useState(existing?.body ?? '')
  const [startsOn, setStartsOn] = useState(existing?.starts_on ?? initialWindow.startsOn)
  const [endsOn, setEndsOn]     = useState(existing?.ends_on ?? initialWindow.endsOn)
  const [recipientIds, setRecipientIds] = useState<string[]>(
    existing?.announcement_recipients.map(r => r.user_id) ?? [])
  const [file, setFile] = useState<File | null>(null)
  const [removeExisting, setRemoveExisting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string) =>
    setRecipientIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

  const onPickFile = (f: File | null) => {
    setError(null)
    if (!f) { setFile(null); return }
    const problem = validateAnnouncementPdf(f)
    if (problem) {
      setError(problem)
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setFile(f)
    setRemoveExisting(false)
  }

  const save = async () => {
    if (saving) return
    const draftError = validateAnnouncementDraft(
      { title, summary, body, startsOn, endsOn, recipientIds },
      undefined,
      { allowPastEnd: !!existing },
    )
    if (draftError) { setError(draftError); return }

    setSaving(true)
    setError(null)
    const supabase = createClient()
    const id = existing?.id ?? crypto.randomUUID()
    const oldPath = existing?.attachment_path ?? null
    let newPath: string | null = null

    try {
      if (file) {
        newPath = buildAnnouncementPdfPath(id)
        const { error: upErr } = await supabase.storage
          .from(ANNOUNCEMENT_BUCKET)
          .upload(newPath, file, { contentType: 'application/pdf', upsert: false })
        if (upErr) {
          setError('The PDF could not be uploaded. Please try again.')
          setSaving(false)
          return
        }
      }

      const keepOld = !file && !removeExisting && !!oldPath
      const attachment = newPath
        ? { p_attachment_path: newPath, p_attachment_name: file!.name, p_attachment_size: file!.size }
        : keepOld
          ? { p_attachment_path: oldPath, p_attachment_name: existing!.attachment_name, p_attachment_size: existing!.attachment_size }
          : { p_attachment_path: null, p_attachment_name: null, p_attachment_size: null }

      const { error: rpcErr } = await supabase.rpc(existing ? 'update_announcement' : 'create_announcement', {
        p_id: id,
        p_title: title.trim(),
        p_summary: summary.trim(),
        p_body: body.trim(),
        p_starts_on: startsOn,
        p_ends_on: endsOn,
        p_recipient_ids: recipientIds,
        ...attachment,
      })
      if (rpcErr) throw rpcErr

      // The old file is no longer named by any announcement, so it may go.
      if (oldPath && oldPath !== attachment.p_attachment_path) {
        await supabase.storage.from(ANNOUNCEMENT_BUCKET).remove([oldPath])
      }
      onSaved(existing ? 'Announcement updated.' : 'Announcement published.')
    } catch (e) {
      if (newPath) await supabase.storage.from(ANNOUNCEMENT_BUCKET).remove([newPath])
      setError(announcementErrorMessage(e))
      setSaving(false)
    }
  }

  const activeCount = members.length
  const hasExistingPdf = !!existing?.attachment_path && !removeExisting && !file

  return (
    <MeetingModal
      title={existing ? 'Edit announcement' : 'New announcement'}
      subtitle="Only the people you choose will see it, from the start date to the end date (India time, inclusive)."
      onClose={onClose}
      width={620}
    >
      <MeetingField label="Title">
        <input className="boe-input" value={title} maxLength={ANNOUNCEMENT_LIMITS.title}
          onChange={e => setTitle(e.target.value)} placeholder="e.g. Exhibition staff guidelines" />
      </MeetingField>

      <MeetingField label="Short summary" hint="One or two lines. Shown on the Modules page banner.">
        <input className="boe-input" value={summary} maxLength={ANNOUNCEMENT_LIMITS.summary}
          onChange={e => setSummary(e.target.value)} />
      </MeetingField>

      <MeetingField label="Full text">
        <textarea className="boe-input" value={body} rows={7} maxLength={ANNOUNCEMENT_LIMITS.body}
          onChange={e => setBody(e.target.value)} style={{ resize: 'vertical', minHeight: 120 }} />
      </MeetingField>

      <MeetingField label="PDF attachment" optional group
        hint="PDF only, up to 10 MB. Employees open it from the announcement.">
        {hasExistingPdf ? (
          <div className="boe-announce-form-file">
            <span>{existing!.attachment_name} · {formatFileSize(existing!.attachment_size ?? 0)}</span>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => fileRef.current?.click()}>Replace</button>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setRemoveExisting(true)}>Remove</button>
          </div>
        ) : file ? (
          <div className="boe-announce-form-file">
            <span>{file.name} · {formatFileSize(file.size)}</span>
            <button type="button" className="boe-btn boe-btn-ghost"
              onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = '' }}>Remove</button>
          </div>
        ) : (
          <button type="button" className="boe-btn boe-btn-ghost" style={{ alignSelf: 'flex-start' }}
            onClick={() => fileRef.current?.click()}>Choose PDF…</button>
        )}
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden aria-label="PDF attachment"
          onChange={e => onPickFile(e.target.files?.[0] ?? null)} />
      </MeetingField>

      <div className="boe-announce-form-dates">
        <MeetingField label="Start date">
          <input className="boe-input" type="date" value={startsOn} onChange={e => setStartsOn(e.target.value)} />
        </MeetingField>
        <MeetingField label="End date" hint="Last day it shows, inclusive.">
          <input className="boe-input" type="date" value={endsOn} min={startsOn} onChange={e => setEndsOn(e.target.value)} />
        </MeetingField>
      </div>

      <div role="group" aria-label="Recipients">
        <ModuleMemberPicker
          members={members}
          selectedIds={recipientIds}
          onToggle={toggle}
          onRemove={id => setRecipientIds(ids => ids.filter(x => x !== id))}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="boe-btn boe-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setRecipientIds(members.map(m => m.id))}>
            Select all active employees ({activeCount})
          </button>
          {recipientIds.length > 0 && (
            <button type="button" className="boe-btn boe-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => setRecipientIds([])}>Clear</button>
          )}
        </div>
      </div>

      {error && <MeetingModalError message={error} />}

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        saveLabel={existing ? 'Save changes' : `Publish to ${recipientIds.length} ${recipientIds.length === 1 ? 'person' : 'people'}`}
      />
    </MeetingModal>
  )
}
