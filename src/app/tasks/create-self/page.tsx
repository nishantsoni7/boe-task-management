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

const PRIORITIES = ['low', 'medium', 'high'] as const
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export default function CreateSelfTaskPage() {
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
  const [loading,        setLoading]        = useState(false)
  const [initDone,       setInitDone]       = useState(false)
  const [success,        setSuccess]        = useState(false)
  const [createdId,      setCreatedId]      = useState<string | null>(null)
  const [isMobile,       setIsMobile]       = useState(false)
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
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

  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/login'); return }
        if (viewAsUserId) { router.push('/dashboard'); return }
        const { data } = await supabase.from('users').select('*').eq('id', session.user.id).single()
        if (data) setProfile(data as UserProfile)
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setAttachError(null)
    if (file && file.size > MAX_FILE_BYTES) {
      setAttachError('File must be 10 MB or smaller.')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setAttachmentFile(file)
  }

  const handleSubmit = async () => {
    setTitleDirty(true)
    setDateDirty(true)
    setPriorityDirty(true)
    if (!title.trim() || !profile || !priority) return
    setLoading(true)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const { data: existing } = await supabase
      .from('tasks').select('id, title')
      .eq('assigned_to', profile.id)
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

    // Upload attachment if selected
    let attachmentUrl: string | null = null
    if (attachmentFile) {
      const ext  = attachmentFile.name.split('.').pop() ?? 'bin'
      const path = `${session.user.id}/${Date.now()}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('task-attachments')
        .upload(path, attachmentFile)
      if (uploadError) {
        console.error('[storage upload error]', uploadError)
        setLoading(false)
        return
      }
      const { data: urlData } = supabase.storage
        .from('task-attachments')
        .getPublicUrl(path)
      attachmentUrl = urlData.publicUrl
    }

    const notePayload = description.trim() || null

    const taskPayload: Record<string, unknown> = {
      title:       title.trim(),
      note:        notePayload,
      priority,    type,
      is_urgent:   isUrgent,
      due_date:    dueDate || null,
      assigned_to: profile.id,
      created_by:  session.user.id,
      team:        profile.team,
      status:      'pending',
    }
    if (attachmentUrl !== null) taskPayload.attachment_url = attachmentUrl

    const { data: task, error } = await supabase
      .from('tasks')
      .insert(taskPayload)
      .select().single()

    if (!error && task) {
      await supabase.from('task_activity_log').insert({
        task_id: task.id, actor_id: session.user.id,
        action: 'created', note: 'Task created for self',
      })
      setTitle('')
      setDescription('')
      setPriority('')
      setIsUrgent(false)
      setDueDate('')
      setTitleDirty(false)
      setDateDirty(false)
      setPriorityDirty(false)
      setAttachmentFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setCreatedId(task.id)
      setSuccess(true)
    }
    setLoading(false)
  }

  const canSubmit = !loading && title.trim().length > 0 && dueDate !== '' && priority !== ''

  if (!initDone) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="New Task for Self"
      subtitle="Create a task for yourself"
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
              placeholder="Context or notes for this task…"
              rows={4}
              className="boe-input"
              style={{ resize: 'none' }}
            />
          </div>

          {/* Mark Important + Attachment — side by side on desktop */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px', marginBottom: '14px' }}>

            {/* Mark Important — label lives inside the box */}
            <div
              onClick={() => setIsUrgent(!isUrgent)}
              style={{
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

            {/* Attachment — no external label */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                id="task-attachment"
                onChange={handleFileChange}
                style={{ display: 'none' }}
                accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
              />
              {attachmentFile ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '11px 12px', height: '42px', boxSizing: 'border-box',
                  borderRadius: '8px',
                  background: colors.raised,
                  border: `1px solid ${colors.border}`,
                }}>
                  <Paperclip size={13} color={colors.secondary} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: colors.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {attachmentFile.name}
                  </span>
                  <span style={{ fontSize: '11px', color: colors.muted, flexShrink: 0 }}>
                    {(attachmentFile.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    onClick={() => {
                      setAttachmentFile(null)
                      setAttachError(null)
                      if (fileInputRef.current) fileInputRef.current.value = ''
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                  >
                    <X size={13} color={colors.muted} strokeWidth={2} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    width: '100%', height: '42px', boxSizing: 'border-box',
                    borderRadius: '8px',
                    border: `1.5px dashed ${colors.border}`,
                    background: colors.raised,
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  }}
                >
                  <Paperclip size={13} color={colors.secondary} strokeWidth={1.8} />
                  <span style={{ fontSize: '12px', color: colors.secondary }}>Attach a file</span>
                  <span style={{ fontSize: '11px', color: colors.muted }}>— max 10 MB</span>
                </button>
              )}
              {attachError && (
                <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>{attachError}</p>
              )}
            </div>
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
            {loading ? (attachmentFile ? 'Uploading & Saving…' : 'Saving…') : 'Create Task'}
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
            [Target,      colors.blueTint,  colors.blue,  'Be specific',    'Include what needs to be done and by when in the task name.'],
            [CalendarDays,colors.amberTint, colors.amber, 'Set a deadline', 'Tasks without deadlines are easy to overlook.'],
            [FileText,    colors.greenTint, colors.green, 'Use Description','Add context or notes you will need when working on this.'],
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
