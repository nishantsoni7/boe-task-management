'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { BackBarShell } from '@/components/layout/PageShell'

const TEMPLATES: Record<string, string[]> = {
  sales: [
    'Follow up with [Client] about [Topic]',
    'Proposal to be sent to [Client] by [Date]',
    'Call [Client] at [Hotel] — confirm [Spec]',
    'Meeting scheduled with [Client] — prepare [Document]',
  ],
  operations: [
    'Quality check — [Item] — before [Event]',
    'Vendor coordination — [Supplier] — [Requirement]',
    'Dispatch confirmation — [Order] — by [Date]',
    'Production update — [Item] — status check',
  ],
  design: [
    'Design revision — [Project] — [Changes]',
    'Sample preparation — [Item] — for [Client]',
    'Approval pending — [Design] — from [Person]',
  ],
  purchase: [
    'Purchase order — [Item] — from [Vendor]',
    'Price negotiation — [Material] — with [Supplier]',
    'Stock check — [Item] — reorder if below [Qty]',
  ],
}

const TEAMS     = ['sales', 'operations', 'design', 'purchase', 'bdm', 'management']
const PRIORITIES = ['low', 'medium', 'high'] as const

export default function CreateTaskPage() {
  const [title,         setTitle]         = useState('')
  const [note,          setNote]          = useState('')
  const [priority,      setPriority]      = useState('medium')
  const [type,          setType]          = useState('completion')
  const [isUrgent,      setIsUrgent]      = useState(false)
  const [dueDate,       setDueDate]       = useState('')
  const [assigneeId,    setAssigneeId]    = useState('')
  const [team,          setTeam]          = useState('sales')
  const [users,         setUsers]         = useState<UserProfile[]>([])
  const [loading,       setLoading]       = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const pageStart = performance.now()
      console.log('[create-task] init started')

      // ── CHANGE: getUser() → getSession() ─────────────────────────────────
      // getUser() makes a verified network call to Supabase auth servers.
      // getSession() reads cached session from localStorage — zero network cost.
      // Safe here: UI gate only. Data security enforced by RLS on every query.
      // ─────────────────────────────────────────────────────────────────────
      const authStart = performance.now()
      const { data: { session } } = await supabase.auth.getSession()
      console.log('[create-task] getSession', Math.round(performance.now() - authStart), 'ms')

      if (!session) { router.push('/login'); return }

      // NOTE: profile and users fetches are sequential here (profile → users).
      // They have no dependency on each other — both only need session.user.id
      // and is_active respectively. Parallelising these is a future optimisation.
      // Not changed here per current task scope.
      const profileStart = performance.now()
      const { data: profile } = await supabase
        .from('users').select('*').eq('id', session.user.id).single()
      console.log('[create-task] profile fetch', Math.round(performance.now() - profileStart), 'ms')
      if (profile) setTeam(profile.team)

      const usersStart = performance.now()
      const { data: allUsers } = await supabase
        .from('users')
        .select('id, full_name, team, role, email, phone, is_active, created_at')
        .eq('is_active', true).order('full_name')
      console.log('[create-task] users fetch', Math.round(performance.now() - usersStart), 'ms')
      if (allUsers) setUsers(allUsers)

      console.log('[create-task] TOTAL init', Math.round(performance.now() - pageStart), 'ms')
    }
    init()
  }, [])

  const handleSubmit = async () => {
    if (!title.trim() || !assigneeId) return
    setLoading(true)

    // ── CHANGE: getUser() → getSession() ─────────────────────────────────
    // Second getUser() call — used to get user.id for created_by and actor_id
    // fields in the task insert and activity log. getSession() is safe here:
    // the actual insert is protected by RLS; a wrong user.id would be rejected.
    // ─────────────────────────────────────────────────────────────────────
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

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title:       title.trim(),
        note:        note.trim() || null,
        priority,    type,
        is_urgent:   isUrgent,
        due_date:    dueDate || null,
        assigned_to: assigneeId,
        created_by:  session.user.id,
        team,
        status:      'pending',
      })
      .select().single()

    if (!error && task) {
      await supabase.from('task_activity_log').insert({
        task_id: task.id, actor_id: session.user.id,
        action: 'created', note: 'Task created and assigned',
      })
      await supabase.from('notifications').insert({
        user_id:      assigneeId,
        task_id:      task.id,
        type:         'task_assigned',
        title:        'New task assigned to you',
        body:         title.trim(),
        is_push_sent: true,
      })
      router.push('/dashboard')
    }
    setLoading(false)
  }

  const templates = TEMPLATES[team] ?? TEMPLATES.sales
  const canSubmit = !loading && title.trim().length > 0 && assigneeId !== ''

  return (
    <BackBarShell
      title="Create Task"
      onBack={() => router.back()}
      actions={
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="boe-btn boe-btn-primary"
        >
          {loading ? 'Saving...' : 'Create & Assign'}
        </button>
      }
    >

      {/* ── Quick Templates ───────────────────────────────────────── */}
      <div className="boe-form-section">
        <label className="boe-form-section-label">Quick Templates</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {templates.map((t, i) => (
            <button
              key={i}
              onClick={() => { setTitle(t); setShowTemplates(false) }}
              className={`boe-chip${title === t ? ' boe-chip-selected' : ''}`}
              style={{ fontSize: '11px' }}
            >
              {t.split(' — ')[0].replace('[', '').replace(']', '')}
            </button>
          ))}
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            style={{
              fontSize: '11px', color: colors.blue,
              background: 'none', border: 'none', cursor: 'pointer', padding: '5px 0',
            }}
          >
            {showTemplates ? '↑ less' : '↓ more'}
          </button>
        </div>
        {showTemplates && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '4px' }}>
            {templates.map((t, i) => (
              <button
                key={i}
                onClick={() => { setTitle(t); setShowTemplates(false) }}
                className="boe-card-interactive"
                style={{
                  padding: '8px 12px', textAlign: 'left',
                  fontSize: '12px', color: colors.secondary,
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Task Title ────────────────────────────────────────────── */}
      <div className="boe-form-section">
        <label className="boe-form-section-label">Task Title</label>
        <textarea
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Follow up — Leela Hotel — confirm fabric selection by Friday"
          rows={2}
          className="boe-input"
          style={{ resize: 'none' }}
        />
        {title.length > 0 && title.length < 20 && (
          <p style={{ fontSize: '11px', color: colors.amber, marginTop: '5px' }}>
            💡 Be specific: who, what, and by when
          </p>
        )}
      </div>

      {/* ── Assign To + Task Type ─────────────────────────────────── */}
      <div className="boe-form-section">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label className="boe-form-section-label">Assign To</label>
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
          <div>
            <label className="boe-form-section-label">Task Type</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              {([['completion', 'Completion'], ['daily_update', 'Daily Update']] as const).map(
                ([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setType(val)}
                    className={`boe-chip${type === val ? ' boe-chip-selected' : ''}`}
                    style={{ flex: 1, textAlign: 'center', fontSize: '11px' }}
                  >
                    {label}
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Priority + Deadline ───────────────────────────────────── */}
      <div className="boe-form-section">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label className="boe-form-section-label">Priority</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              {PRIORITIES.map(p => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`boe-chip${priority === p ? ' boe-chip-selected' : ''}`}
                  style={{
                    flex: 1, textAlign: 'center', textTransform: 'capitalize',
                    ...(p === 'high' && priority !== 'high'
                      ? { color: colors.red, borderColor: 'rgba(217,79,79,0.2)' }
                      : {}),
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="boe-form-section-label">Deadline</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="boe-input"
              style={{ colorScheme: 'dark' }}
            />
          </div>
        </div>
      </div>

      {/* ── Team ─────────────────────────────────────────────────── */}
      <div className="boe-form-section">
        <label className="boe-form-section-label">Team</label>
        <select
          value={team}
          onChange={e => setTeam(e.target.value)}
          className="boe-input"
        >
          {TEAMS.map(t => (
            <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>
          ))}
        </select>
      </div>

      {/* ── Note ─────────────────────────────────────────────────── */}
      <div className="boe-form-section">
        <label className="boe-form-section-label">Note (optional)</label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Context or instructions for the assignee…"
          rows={2}
          className="boe-input"
          style={{ resize: 'none' }}
        />
      </div>

      {/* ── Urgent toggle ─────────────────────────────────────────── */}
      <div
        onClick={() => setIsUrgent(!isUrgent)}
        className={isUrgent ? 'boe-alert-red' : 'boe-card'}
        style={{
          padding: '10px 13px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <div>
          <p style={{
            fontSize: '13px', fontWeight: 600,
            color: isUrgent ? colors.red : colors.primary,
          }}>
            Mark as Urgent
          </p>
          <p style={{ color: colors.muted, fontSize: '11px', marginTop: '1px' }}>
            Sends immediate push notification
          </p>
        </div>
        <div style={{
          width: '34px', height: '20px', borderRadius: '10px',
          background: isUrgent ? colors.red : colors.float,
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

    </BackBarShell>
  )
}
