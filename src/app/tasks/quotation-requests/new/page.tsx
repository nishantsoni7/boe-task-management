'use client'

import { requestAssignmentNotification } from '@/lib/tasks/assignmentNotification'
import { AssignmentNotificationNotice, AssignmentNotificationRecovered } from '@/components/tasks/AssignmentNotificationNotice'
import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { prepareFiles, getExt, getFileTypeLabel, filterAcceptedFiles, ACCEPTED_ATTACHMENT_TYPES } from '@/lib/attachment-utils'
import { Paperclip, X, Info } from 'lucide-react'
import { useDragAndPaste } from '@/hooks/useDragAndPaste'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveQuotationCapabilities } from '@/lib/permissions/quotations'
import { canonicalAttachmentRef } from '@/lib/tasks/attachmentStorage'

// Every quotation request is assigned to this user (resolved by email at init).
const DEFAULT_QUOTATION_OWNER = 'admin@bestofexports.com'

const PRIORITY_CFG = {
  low:    { active: '#6B7280', activeBg: '#F9FAFB', border: 'rgba(107,114,128,0.30)' },
  medium: { active: '#B45309', activeBg: '#FFFBEB', border: 'rgba(180,83,9,0.30)'   },
  high:   { active: '#9B3D3D', activeBg: '#FEF2F2', border: 'rgba(155,61,61,0.35)'  },
} as const

export default function NewQuotationRequestPage() {
  const [profile,          setProfile]          = useState<UserProfile | null>(null)
  const [quotationOwnerId, setQuotationOwnerId] = useState<string>('')
  const [initDone,         setInitDone]         = useState(false)

  // Form fields
  const [customerName,  setCustomerName]  = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [priority,      setPriority]      = useState<'low' | 'medium' | 'high'>('medium')
  const [attachFiles,   setAttachFiles]   = useState<File[]>([])
  const [requirement,   setRequirement]   = useState('')

  // Validation dirty flags
  const [nameDirty,   setNameDirty]   = useState(false)
  const [attachDirty, setAttachDirty] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)

  const [loading,     setLoading]     = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success,     setSuccess]     = useState(false)
  const [createdId,   setCreatedId]   = useState<string | null>(null)
  // Outcome B. Task id only — see the create screen and the notice component.
  const [notifyFailedFor, setNotifyFailedFor] = useState<string | null>(null)
  const [notifyRecovered, setNotifyRecovered] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/login'); return }

        const [{ data: profileData }, { data: ownerData }] = await Promise.all([
          supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
          supabase.from('users').select('id').eq('email', DEFAULT_QUOTATION_OWNER).single(),
        ])

        // Raising a quotation request is a quotation OPERATION, so it needs
        // manage_quotations — view alone opens the register, not the form.
        // Checked before the form is shown rather than only on submit, so a
        // direct URL cannot present a form the save would refuse.
        const taskPerms = await getEffectivePermissions(supabase, session.user.id, 'task_management').catch(() => [])
        if (!deriveQuotationCapabilities(profileData?.role, taskPerms).canManageQuotations) {
          router.replace('/tasks/my')
          return
        }

        if (profileData) setProfile(profileData as UserProfile)
        if (ownerData)   setQuotationOwnerId(ownerData.id)
      } finally {
        setInitDone(true)
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Shared entry point for browse, drag-and-drop, and paste — keeps validation/behavior
  // identical no matter how a file gets into the upload flow.
  const addFiles = async (incoming: File[]) => {
    if (incoming.length === 0) return
    setAttachDirty(true)
    const { accepted, rejectedNames } = filterAcceptedFiles(incoming)
    const rejectMsg = rejectedNames.length > 0 ? `Unsupported file type: ${rejectedNames.join(', ')}` : null
    if (accepted.length === 0) { setAttachError(rejectMsg); return }
    const merged = [...attachFiles, ...accepted]
    const { ready, error } = await prepareFiles(merged)
    setAttachError(error ?? rejectMsg)
    if (!error) setAttachFiles(ready)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    await addFiles(selected)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const { dropActive: attachDropActive, onDragOver, onDragEnter, onDragLeave, onDrop, onPaste } = useDragAndPaste(addFiles)

  const handleSubmit = async () => {
    setNameDirty(true)
    setAttachDirty(true)
    if (!customerName.trim()) return
    if (!attachFiles.length) return

    setLoading(true)
    setSubmitError(null)
    setNotifyFailedFor(null)
    setNotifyRecovered(false)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }

    if (!quotationOwnerId) {
      setSubmitError('Quotation owner not configured. Please contact your administrator.')
      setLoading(false)
      return
    }

    const { error: prepErr } = await prepareFiles(attachFiles)
    if (prepErr) { setAttachError(prepErr); setLoading(false); return }

    const autoTitle = `Quotation - ${customerName.trim()}`
    const now       = new Date().toISOString()

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title:           autoTitle,
        note:            requirement.trim() || null,
        priority,
        type:            'completion',
        task_type:       'quotation_request',
        is_urgent:       false,
        due_date:        null,
        assigned_to:     quotationOwnerId,
        created_by:      session.user.id,
        team:            profile?.team ?? 'sales',
        status:          'working',
        acknowledged_at: now,
        customer_name:   customerName.trim(),
        contact_number:  contactNumber.trim() || null,
      })
      .select()
      .single()

    if (error || !task) {
      setSubmitError(error?.message ?? 'Failed to submit request. Please try again.')
      setLoading(false)
      return
    }

    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: session.user.id,
      action: 'created', note: 'Quotation request submitted',
    })
    // Server-side write: a browser may not address a notifications row to
    // somebody else. The route derives the recipient from tasks.assigned_to,
    // which this screen has just set to the quotation owner.
    const notified = await requestAssignmentNotification(task.id)
    // The request is KEPT — it was submitted successfully. What changes is that
    // the screen no longer claims the owner was told when they were not.
    // Outcome B. Deliberately NOT setSubmitError: the request was submitted,
    // and an error banner here would read as a failed submission and invite a
    // duplicate. Same sentence and same Retry action as every other screen.
    if (!notified.ok) {
      console.error('[quotation request] assignment notification failed:', notified.reason)
      setNotifyFailedFor(task.id)
    }

    // Upload attachments
    const { ready } = await prepareFiles(attachFiles)
    for (const file of ready) {
      const ext  = getExt(file.name)
      const path = `tasks/${task.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('task-attachments')
        .upload(path, file, { upsert: false })
      if (upErr) { console.error('[qtn attach upload]', upErr); continue }
      await supabase.from('task_attachments').insert({
        task_id:    task.id,
        url:        canonicalAttachmentRef(path),
        storage_path: path,
        file_name:  file.name,
        file_type:  getFileTypeLabel(file.name),
        created_by: session.user.id,
      })
    }

    // Reset
    setCustomerName('');  setContactNumber(''); setPriority('medium')
    setRequirement('');   setAttachFiles([]);   setAttachError(null)
    setNameDirty(false);  setAttachDirty(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setCreatedId(task.id)
    setSuccess(true)
    setLoading(false)
  }

  const canSubmit = !loading && customerName.trim().length > 0 && attachFiles.length > 0

  if (!initDone) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="New Quotation Request"
      subtitle="Submit a customer quotation request"
      onSignOut={handleLogout}
    >
      {success && (
        <div style={{
          maxWidth: '520px', marginBottom: '16px', padding: '11px 16px',
          borderRadius: '8px', background: colors.greenTint,
          border: `1px solid rgba(69,168,112,0.25)`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <p style={{ fontSize: '13px', fontWeight: 500, color: colors.green }}>
              Quotation request submitted successfully.
            </p>
            {createdId && (
              <button
                onClick={() => router.push(`/tasks/${createdId}`)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '12px', fontWeight: 600, color: colors.green, textDecoration: 'underline', textUnderlineOffset: '2px', opacity: 0.8 }}
              >
                View
              </button>
            )}
          </div>
          <button
            onClick={() => setSuccess(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '16px' }}
          >×</button>
        </div>
      )}

      {notifyFailedFor && (
        <div style={{ maxWidth: '520px' }}>
          <AssignmentNotificationNotice
            taskId={notifyFailedFor}
            onResolved={() => { setNotifyFailedFor(null); setNotifyRecovered(true) }}
            onDismiss={() => setNotifyFailedFor(null)}
          />
        </div>
      )}
      {notifyRecovered && (
        <div style={{ maxWidth: '520px' }}>
          <AssignmentNotificationRecovered onDismiss={() => setNotifyRecovered(false)} />
        </div>
      )}

      {submitError && (
        <div style={{
          maxWidth: '520px', marginBottom: '16px', padding: '11px 16px',
          borderRadius: '8px', background: colors.redTint,
          border: `1px solid rgba(217,79,79,0.25)`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: colors.red }}>{submitError}</p>
          <button onClick={() => setSubmitError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '16px' }}>×</button>
        </div>
      )}

      <div style={{ maxWidth: '520px' }}>
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: '12px', padding: '24px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
        }}>

          {/* Header hint */}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: '8px',
            padding: '10px 12px', marginBottom: '20px',
            borderRadius: '8px', background: 'rgba(155,111,212,0.05)',
            border: '1px solid rgba(155,111,212,0.15)',
          }}>
            <Info size={13} color="#6B4FA0" style={{ flexShrink: 0, marginTop: '1px' }} />
            <p style={{ fontSize: '12px', color: '#6B4FA0', lineHeight: 1.5 }}>
              Fill in the lead details and attach relevant files. The request will be sent for quotation preparation.
            </p>
          </div>

          {/* 1. Lead Name */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">
              Lead Name <span style={{ color: colors.red }}>*</span>
            </label>
            <input
              type="text"
              value={customerName}
              onChange={e => { setCustomerName(e.target.value); setNameDirty(true) }}
              placeholder="e.g. Raj Sharma, Taj Hotels, ABC Interiors"
              className="boe-input"
              autoFocus
            />
            {nameDirty && !customerName.trim() && (
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Lead name is required</p>
            )}
          </div>

          {/* 2. Phone + Priority */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
            <div>
              <label className="boe-form-section-label">
                Phone Number <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="text"
                value={contactNumber}
                onChange={e => setContactNumber(e.target.value)}
                placeholder="e.g. 98765 43210"
                className="boe-input"
              />
            </div>
            <div>
              <label className="boe-form-section-label">Priority</label>
              <div style={{ display: 'flex', gap: '6px', marginTop: '1px' }}>
                {(['low', 'medium', 'high'] as const).map(p => {
                  const selected = priority === p
                  const cfg = PRIORITY_CFG[p]
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      style={{
                        flex: 1, padding: '6px 4px', borderRadius: '6px', cursor: 'pointer',
                        fontSize: '11px', fontWeight: selected ? 700 : 500,
                        textTransform: 'capitalize',
                        border: `1px solid ${selected ? cfg.active : cfg.border}`,
                        background: selected ? cfg.activeBg : 'transparent',
                        color: selected ? cfg.active : '#6B7280',
                        transition: 'all 0.12s',
                      }}
                    >
                      {p}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 3. Attachments (required) */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">
              Attachments <span style={{ color: colors.red }}>*</span>
              <span style={{ fontWeight: 400, color: colors.secondary, marginLeft: '5px' }}>— drawings, spec sheets, or photos</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              style={{ display: 'none' }}
              accept={ACCEPTED_ATTACHMENT_TYPES.join(',')}
            />
            {attachFiles.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                {attachFiles.map((f, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 12px', borderRadius: '8px',
                    background: colors.raised, border: `1px solid ${colors.border}`,
                  }}>
                    <Paperclip size={12} color={colors.secondary} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: '12px', color: colors.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <span style={{ fontSize: '11px', color: colors.muted, flexShrink: 0 }}>{(f.size / 1024).toFixed(0)} KB</span>
                    <button
                      onClick={() => { setAttachFiles(prev => prev.filter((_, j) => j !== i)); setAttachError(null) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                    >
                      <X size={13} color={colors.muted} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div
              style={{ position: 'relative' }}
              onDragOver={onDragOver}
              onDragEnter={onDragEnter}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: '100%', height: '42px', boxSizing: 'border-box',
                  borderRadius: '8px', border: `1.5px dashed ${attachDropActive ? '#6B4FA0' : 'rgba(155,111,212,0.30)'}`,
                  background: attachDropActive ? 'rgba(155,111,212,0.08)' : 'rgba(155,111,212,0.03)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <Paperclip size={13} color="#6B4FA0" strokeWidth={1.8} />
                <span style={{ fontSize: '12px', color: '#6B4FA0' }}>Add drawings, photos or spec sheet</span>
              </button>
              {attachDropActive && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  pointerEvents: 'none',
                  fontSize: '12px', fontWeight: 600, color: '#6B4FA0',
                  background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
                }}>
                  Drop files to attach
                </div>
              )}
            </div>
            <p style={{ fontSize: '10px', color: colors.muted, marginTop: '4px' }}>
              Drop files here, paste copied files into the notes, or browse
            </p>
            {attachDirty && attachFiles.length === 0 && !attachError && (
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>
                Please attach at least one file for the quotation request.
              </p>
            )}
            {attachError && <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>{attachError}</p>}
          </div>

          {/* 4. Notes (optional) */}
          <div style={{ marginBottom: '20px' }}>
            <label className="boe-form-section-label">
              Notes <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              value={requirement}
              onChange={e => setRequirement(e.target.value)}
              onPaste={onPaste}
              placeholder="Product type, quantity, finish, special requirements, budget range…"
              rows={3}
              className="boe-input"
              style={{ resize: 'none' }}
            />
          </div>

          <p style={{ fontSize: '11px', color: colors.muted, marginBottom: '10px' }}>
            <span style={{ color: colors.red }}>*</span> Required fields
          </p>

          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              width: '100%', padding: '12px 0', borderRadius: '8px', border: 'none',
              background: canSubmit ? '#6B4FA0' : colors.float,
              color: canSubmit ? '#fff' : colors.muted,
              fontSize: '13px', fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s, opacity 0.12s',
            }}
            onMouseEnter={e => { if (canSubmit) e.currentTarget.style.opacity = '0.90' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >
            {loading ? 'Submitting…' : 'Submit Quotation Request'}
          </button>
        </div>
      </div>
    </DashboardLayout>
  )
}
