'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { prepareFiles, getExt, getFileTypeLabel } from '@/lib/attachment-utils'
import { Paperclip, X, Info } from 'lucide-react'

export default function NewQuotationRequestPage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [users,         setUsers]         = useState<UserProfile[]>([])
  const [initDone,      setInitDone]      = useState(false)

  // Quotation-specific fields
  const [customerName,  setCustomerName]  = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [companyName,   setCompanyName]   = useState('')
  const [cityProject,   setCityProject]   = useState('')
  const [requirement,   setRequirement]   = useState('')
  const [assigneeId,    setAssigneeId]    = useState('')
  const [attachFiles,   setAttachFiles]   = useState<File[]>([])
  const [attachError,   setAttachError]   = useState<string | null>(null)

  // Validation dirty flags
  const [nameDirty,     setNameDirty]     = useState(false)
  const [assigneeDirty, setAssigneeDirty] = useState(false)

  const [loading,       setLoading]       = useState(false)
  const [submitError,   setSubmitError]   = useState<string | null>(null)
  const [success,       setSuccess]       = useState(false)
  const [createdId,     setCreatedId]     = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/login'); return }

        const [{ data: profileData }, { data: allUsers }] = await Promise.all([
          supabase.from('users').select('*').eq('id', session.user.id).single(),
          supabase.from('users')
            .select('id, full_name, team, role, email, phone, is_active, created_at')
            .eq('is_active', true).order('full_name'),
        ])

        if (profileData) setProfile(profileData as UserProfile)
        if (allUsers)    setUsers(allUsers as UserProfile[])
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    if (!selected.length) return
    const merged = [...attachFiles, ...selected]
    const { ready, error } = await prepareFiles(merged)
    setAttachError(error)
    if (!error) setAttachFiles(ready)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSubmit = async () => {
    setNameDirty(true)
    setAssigneeDirty(true)
    if (!customerName.trim() || !assigneeId) return

    setLoading(true)
    setSubmitError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }

    if (attachFiles.length) {
      const { error: prepErr } = await prepareFiles(attachFiles)
      if (prepErr) { setAttachError(prepErr); setLoading(false); return }
    }

    const autoTitle = `Quotation - ${customerName.trim()}`
    const isSelf    = assigneeId === session.user.id
    const now       = new Date().toISOString()

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title:           autoTitle,
        note:            requirement.trim() || null,
        priority:        'high',
        type:            'completion',
        task_type:       'quotation_request',
        is_urgent:       false,
        due_date:        null,
        assigned_to:     assigneeId,
        created_by:      session.user.id,
        team:            profile?.team ?? 'sales',
        status:          isSelf ? 'working' : 'pending',
        acknowledged_at: isSelf ? now : null,
        customer_name:   customerName.trim(),
        contact_number:  contactNumber.trim() || null,
        company_name:    companyName.trim()   || null,
        city_project:    cityProject.trim()   || null,
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
    await supabase.from('notifications').insert({
      user_id:      assigneeId,
      task_id:      task.id,
      type:         'task_assigned',
      title:        'New quotation request',
      body:         autoTitle,
      is_push_sent: true,
    })

    if (attachFiles.length) {
      const { ready } = await prepareFiles(attachFiles)
      for (const file of ready) {
        const ext  = getExt(file.name)
        const path = `tasks/${task.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('task-attachments')
          .upload(path, file, { upsert: false })
        if (upErr) { console.error('[qtn attach upload]', upErr); continue }
        const { data: urlData } = supabase.storage.from('task-attachments').getPublicUrl(path)
        await supabase.from('task_attachments').insert({
          task_id:    task.id,
          url:        urlData.publicUrl,
          file_name:  file.name,
          file_type:  getFileTypeLabel(file.name),
          created_by: session.user.id,
        })
      }
    }

    // Reset
    setCustomerName('');  setContactNumber(''); setCompanyName('')
    setCityProject('');   setRequirement('');   setAssigneeId('')
    setAttachFiles([]);   setAttachError(null)
    setNameDirty(false);  setAssigneeDirty(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setCreatedId(task.id)
    setSuccess(true)
    setLoading(false)
  }

  const canSubmit = !loading && customerName.trim().length > 0 && assigneeId !== ''

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
              Fill in the customer details. The request will be assigned and appear in the assignee&apos;s task list.
            </p>
          </div>

          {/* Customer / Lead Name */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">
              Customer / Lead Name <span style={{ color: colors.red }}>*</span>
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
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Customer name is required</p>
            )}
          </div>

          {/* Contact + Company */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
            <div>
              <label className="boe-form-section-label">Contact Number <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={contactNumber}
                onChange={e => setContactNumber(e.target.value)}
                placeholder="e.g. 98765 43210"
                className="boe-input"
              />
            </div>
            <div>
              <label className="boe-form-section-label">Company Name <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="e.g. Taj Hotels Pvt Ltd"
                className="boe-input"
              />
            </div>
          </div>

          {/* City / Project */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">City / Project <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
            <input
              type="text"
              value={cityProject}
              onChange={e => setCityProject(e.target.value)}
              placeholder="e.g. Mumbai — Lobby Renovation"
              className="boe-input"
            />
          </div>

          {/* Requirement */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">Requirement / Notes <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
            <textarea
              value={requirement}
              onChange={e => setRequirement(e.target.value)}
              placeholder="Product type, quantity, finish, special requirements, budget range…"
              rows={3}
              className="boe-input"
              style={{ resize: 'none' }}
            />
          </div>

          {/* Assign To */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">
              Assign To <span style={{ color: colors.red }}>*</span>
            </label>
            <select
              value={assigneeId}
              onChange={e => { setAssigneeId(e.target.value); setAssigneeDirty(true) }}
              className="boe-input"
            >
              <option value="">Select who will prepare this quotation</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.full_name} — {u.team}</option>
              ))}
            </select>
            {assigneeDirty && !assigneeId && (
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Please select an assignee</p>
            )}
          </div>

          {/* Attachment */}
          <div style={{ marginBottom: '20px' }}>
            <label className="boe-form-section-label">
              Attachment
              <span style={{ fontWeight: 400, color: colors.secondary, marginLeft: '5px' }}>— drawings, spec sheets, or photos are strongly encouraged</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              style={{ display: 'none' }}
              accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
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
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: '100%', height: '42px', boxSizing: 'border-box',
                borderRadius: '8px', border: `1.5px dashed rgba(155,111,212,0.30)`,
                background: 'rgba(155,111,212,0.03)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              }}
            >
              <Paperclip size={13} color="#6B4FA0" strokeWidth={1.8} />
              <span style={{ fontSize: '12px', color: '#6B4FA0' }}>Add drawings, photos or spec sheet</span>
            </button>
            {attachError && <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>{attachError}</p>}
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
