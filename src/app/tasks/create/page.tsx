'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'
import { Target, CalendarDays, FileText, Paperclip, X } from 'lucide-react'
import { prepareFiles, getExt, getFileTypeLabel } from '@/lib/attachment-utils'

const PRIORITIES = ['low', 'medium', 'high'] as const

export default function CreateTaskPage() {
  const { viewAsUserId } = useViewAs()
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [title,          setTitle]          = useState('')
  const [description,    setDescription]    = useState('')
  const [priority,       setPriority]       = useState('')
  const [type] = useState('completion')
  const [isUrgent,       setIsUrgent]       = useState(false)
  const [dueDate,        setDueDate]        = useState('')
  const [titleDirty,     setTitleDirty]     = useState(false)
  const [dateDirty,      setDateDirty]      = useState(false)
  const [priorityDirty,  setPriorityDirty]  = useState(false)
  const [assigneeId,     setAssigneeId]     = useState('')
  const [team,           setTeam]           = useState('sales')
  const [users,          setUsers]          = useState<UserProfile[]>([])
  const [loading,        setLoading]        = useState(false)
  const [initDone,       setInitDone]       = useState(false)
  const [success,        setSuccess]        = useState(false)
  const [createdId,      setCreatedId]      = useState<string | null>(null)
  const [submitError,    setSubmitError]    = useState<string | null>(null)
  const [isMobile,       setIsMobile]       = useState(false)
  const [attachFiles,    setAttachFiles]    = useState<File[]>([])
  const [attachError,    setAttachError]    = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/login'); return }
        if (viewAsUserId) { router.push('/dashboard'); return }

        const [{ data: profileData }, { data: allUsers }] = await Promise.all([
          supabase.from('users').select('*').eq('id', session.user.id).single(),
          supabase.from('users')
            .select('id, full_name, team, role, email, phone, is_active, created_at')
            .eq('is_active', true).order('full_name'),
        ])

        if (profileData) {
          setProfile(profileData as UserProfile)
          setTeam(profileData.team)
        }
        if (allUsers) setUsers(allUsers as UserProfile[])
      } finally {
        setInitDone(true)
      }
    }
    init()
  }, [])

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
    setTitleDirty(true)
    setDateDirty(true)
    setPriorityDirty(true)
    if (!title.trim() || !assigneeId || !priority) return
    setLoading(true)
    setSubmitError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const { data: existing } = await supabase
      .from('tasks').select('id, title')
      .eq('assigned_to', assigneeId)
      .not('status', 'eq', 'completed')

    const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 3)
    const duplicate  = existing?.find((t: { title: string }) => {
      const matches = titleWords.filter(w => t.title.toLowerCase().includes(w))
      return matches.length >= 3
    })

    if (duplicate) {
      const ok = window.confirm(
        `A similar task may already exist:\n"${duplicate.title}"\n\nCreate anyway?`
      )
      if (!ok) { setLoading(false); return }
    }

    // Validate attachments before creating the task
    if (attachFiles.length) {
      const { error: prepErr } = await prepareFiles(attachFiles)
      if (prepErr) {
        setAttachError(prepErr)
        setLoading(false)
        return
      }
    }

    const notePayload = description.trim() || null
    const isSelf = assigneeId === session.user.id
    const now = new Date().toISOString()

    const taskPayload: Record<string, unknown> = {
      title:          title.trim(),
      note:           notePayload,
      priority,       type,
      is_urgent:      isUrgent,
      due_date:       dueDate || null,
      assigned_to:    assigneeId,
      created_by:     session.user.id,
      team,
      status:         isSelf ? 'working' : 'pending',
      acknowledged_at: isSelf ? now : null,
    }
    const { data: task, error } = await supabase
      .from('tasks')
      .insert(taskPayload)
      .select().single()

    if (error || !task) {
      console.error('[tasks insert error]', error)
      setSubmitError(error?.message ?? 'Failed to create task. Please check your connection and try again.')
      setLoading(false)
      return
    }
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: session.user.id,
      action: 'created', note: isSelf ? 'Task created for self' : 'Task created and assigned',
    })
    await supabase.from('notifications').insert({
      user_id:      assigneeId,
      task_id:      task.id,
      type:         'task_assigned',
      title:        'New task assigned to you',
      body:         title.trim(),
      is_push_sent: true,
    })

    // Upload attachments and link to the new task
    if (attachFiles.length) {
      const { ready } = await prepareFiles(attachFiles)
      let anyFailed = false
      for (const file of ready) {
        const ext  = getExt(file.name)
        const path = `tasks/${task.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('task-attachments')
          .upload(path, file, { upsert: false })
        if (upErr) { console.error('[attach upload]', upErr); anyFailed = true; continue }
        const { data: urlData } = supabase.storage.from('task-attachments').getPublicUrl(path)
        await supabase.from('task_attachments').insert({
          task_id:    task.id,
          url:        urlData.publicUrl,
          file_name:  file.name,
          file_type:  getFileTypeLabel(file.name),
          created_by: session.user.id,
        })
      }
      if (anyFailed) setSubmitError('Task created, but some attachments failed to upload.')
    }

    // Reset form and show success — stay on page
    setTitle('')
    setDescription('')
    setPriority('')
    setIsUrgent(false)
    setDueDate('')
    setTitleDirty(false)
    setDateDirty(false)
    setPriorityDirty(false)
    setAssigneeId('')
    setAttachFiles([])
    setAttachError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setCreatedId(task.id)
    setSuccess(true)
    setLoading(false)
  }

  const canSubmit = !loading && title.trim().length > 0 && assigneeId !== '' && dueDate !== '' && priority !== ''

  if (!initDone) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="New Task for Team"
      subtitle="Assign work to a team member"
      onSignOut={handleLogout}
    >
      {/* Success banner */}
      {success && (
        <div style={{
          maxWidth: isMobile ? '100%' : '90%',
          marginBottom: '16px',
          padding: '11px 16px',
          borderRadius: '8px',
          background: colors.greenTint,
          border: `1px solid rgba(69,168,112,0.25)`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <p style={{ fontSize: '13px', fontWeight: 500, color: colors.green }}>
              New task has been created successfully.
            </p>
            {createdId && (
              <button
                onClick={() => router.push(`/tasks/${createdId}`)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: '12px', fontWeight: 600,
                  color: colors.green,
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px',
                  whiteSpace: 'nowrap',
                  opacity: 0.8,
                }}
              >
                View Task
              </button>
            )}
          </div>
          <button
            onClick={() => setSuccess(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '16px', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {/* Error banner */}
      {submitError && (
        <div style={{
          maxWidth: isMobile ? '100%' : '90%',
          marginBottom: '16px',
          padding: '11px 16px',
          borderRadius: '8px',
          background: colors.redTint,
          border: `1px solid rgba(217,79,79,0.25)`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '12px',
        }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: colors.red }}>
            {submitError}
          </p>
          <button
            onClick={() => setSubmitError(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '16px', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {/* Two-column: form left, tips right */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '0' : '20px', alignItems: 'flex-start', maxWidth: isMobile ? '100%' : '90%' }}>

        {/* ── Form card ───────────────────────────────────────────────── */}
        <div style={{
          flex: 2.5, minWidth: 0,
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: '10px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          padding: '24px',
        }}>

          {/* Task Name */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">
              Task Name <span style={{ color: colors.red, fontWeight: 500 }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={e => { setTitle(e.target.value); setTitleDirty(true) }}
              placeholder="e.g. Follow up — Leela Hotel — confirm fabric selection by Friday"
              className="boe-input"
            />
            {titleDirty && !title.trim() ? (
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Task name is required</p>
            ) : title.length > 0 && title.length < 20 ? (
              <p style={{ fontSize: '11px', color: colors.amber, marginTop: '4px' }}>Be specific: who, what, and by when</p>
            ) : null}
          </div>

          {/* Assign To */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">
              Assign To <span style={{ color: colors.red, fontWeight: 500 }}>*</span>
            </label>
            <select
              value={assigneeId}
              onChange={e => setAssigneeId(e.target.value)}
              className="boe-input"
            >
              <option value="">Select team member</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.full_name} — {u.team}</option>
              ))}
            </select>
          </div>

          {/* Priority + Due Date row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
            <div>
              <label className="boe-form-section-label">
                Priority <span style={{ color: colors.red, fontWeight: 500 }}>*</span>
              </label>
              <div style={{ display: 'flex', gap: '5px' }}>
                {PRIORITIES.map(p => {
                  const selected = priority === p
                  const cfg = {
                    low:    { bg: '#16a34a', border: 'rgba(22,163,74,0.4)',  text: '#16a34a' },
                    medium: { bg: '#d97706', border: 'rgba(217,119,6,0.4)',  text: '#d97706' },
                    high:   { bg: '#dc2626', border: 'rgba(220,38,38,0.4)',  text: '#dc2626' },
                  }[p]!
                  return (
                    <button
                      key={p}
                      onClick={() => { setPriority(p); setPriorityDirty(true) }}
                      style={{
                        flex: 1, textAlign: 'center', textTransform: 'capitalize',
                        fontSize: '12px', fontWeight: selected ? 700 : 500,
                        padding: '6px 4px',
                        borderRadius: '6px',
                        border: `1px solid ${selected ? cfg.bg : cfg.border}`,
                        background: selected ? cfg.bg : 'transparent',
                        color: selected ? '#fff' : cfg.text,
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                      }}
                    >
                      {p}
                    </button>
                  )
                })}
              </div>
              {priorityDirty && !priority && (
                <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Priority is required</p>
              )}
            </div>
            <div>
              <label className="boe-form-section-label">
                Due Date <span style={{ color: colors.red, fontWeight: 500 }}>*</span>
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={e => { setDueDate(e.target.value); setDateDirty(true) }}
                className="boe-input"
                style={{ colorScheme: 'light' }}
              />
              {dateDirty && !dueDate && (
                <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Due date is required</p>
              )}
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">Description <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Context or instructions for the assignee…"
              rows={4}
              className="boe-input"
              style={{ resize: 'none' }}
            />
          </div>

          {/* Mark Important */}
          <div
            onClick={() => setIsUrgent(!isUrgent)}
            style={{
              marginBottom: '14px',
              padding: '11px 13px', cursor: 'pointer', height: '42px', boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderRadius: '8px',
              background: isUrgent ? 'rgba(196,154,40,0.06)' : colors.raised,
              border: `1px solid ${isUrgent ? 'rgba(196,154,40,0.3)' : colors.border}`,
            }}
          >
            <p style={{ fontSize: '12px', fontWeight: 600, color: isUrgent ? '#C49A28' : colors.primary }}>
              {isUrgent ? 'Marked Important' : 'Mark Important'}
            </p>
            <div style={{
              width: '34px', height: '20px', borderRadius: '10px',
              background: isUrgent ? '#C49A28' : colors.float,
              position: 'relative', flexShrink: 0,
              transition: 'background 0.16s',
              border: `1px solid ${colors.border}`,
            }}>
              <div style={{
                position: 'absolute', top: '2px',
                left: isUrgent ? '15px' : '2px',
                width: '14px', height: '14px',
                borderRadius: '50%', background: '#fff',
                transition: 'left 0.16s',
              }} />
            </div>
          </div>

          {/* Attachments */}
          <div style={{ marginBottom: '14px' }}>
            <label className="boe-form-section-label">Attachments <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
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
                    padding: '8px 12px', borderRadius: '8px',
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
                width: '100%', height: '40px', boxSizing: 'border-box',
                borderRadius: '8px', border: `1.5px dashed ${colors.border}`,
                background: colors.raised, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              }}
            >
              <Paperclip size={13} color={colors.secondary} strokeWidth={1.8} />
              <span style={{ fontSize: '12px', color: colors.secondary }}>Add files</span>
              <span style={{ fontSize: '11px', color: colors.muted }}>— 10 MB total</span>
            </button>
            {attachError && <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>{attachError}</p>}
          </div>

          {/* Required fields note */}
          <p style={{ fontSize: '11px', color: colors.muted, marginBottom: '8px' }}>
            <span style={{ color: colors.red }}>*</span> Required fields must be completed before creating a task.
          </p>

          {/* Primary action */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              width: '100%',
              padding: '11px 0',
              borderRadius: '8px',
              border: 'none',
              background: canSubmit ? colors.primary : colors.float,
              color: canSubmit ? '#fff' : colors.muted,
              fontSize: '13px',
              fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s, color 0.15s',
              letterSpacing: '0.01em',
            }}
          >
            {loading ? (attachFiles.length ? 'Uploading & Saving…' : 'Saving…') : 'Create & Assign'}
          </button>

        </div>

        {/* ── Tips card — desktop only ────────────────────────────────── */}
        {!isMobile && <div style={{
          flex: 2, minWidth: 0,
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: '10px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          padding: '20px',
          alignSelf: 'flex-start',
          position: 'sticky', top: '16px',
        }}>
          <p style={{ fontSize: '11px', fontWeight: 700, color: colors.secondary, marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Tips for a good task
          </p>
          {([
            [Target,      colors.blueTint,  colors.blue,  'Be specific',    'Include who, what, and by when in the task name.'],
            [CalendarDays,colors.amberTint, colors.amber, 'Set a deadline', 'Tasks without deadlines are easy to overlook.'],
            [FileText,    colors.greenTint, colors.green, 'Use Description','Add context that the assignee needs to act on this.'],
          ] as const).map(([Icon, bg, iconColor, heading, body], i, arr) => (
            <div key={heading} style={{
              display: 'flex', gap: '10px', alignItems: 'flex-start',
              marginBottom: i < arr.length - 1 ? '12px' : 0,
            }}>
              <div style={{
                flexShrink: 0,
                width: '30px', height: '30px', borderRadius: '50%',
                background: bg,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={14} color={iconColor} strokeWidth={1.8} />
              </div>
              <div style={{ paddingTop: '2px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, color: colors.primary, lineHeight: 1.3 }}>{heading}</p>
                <p style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', lineHeight: 1.45 }}>{body}</p>
              </div>
            </div>
          ))}
        </div>}

      </div>
    </DashboardLayout>
  )
}
