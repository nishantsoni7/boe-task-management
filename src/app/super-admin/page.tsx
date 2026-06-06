'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { Trash2 } from 'lucide-react'
type RelationFilter = 'all' | 'created_by' | 'assigned_to' | 'delegated_by'

const STATUS_OPTIONS = ['pending', 'started', 'working', 'waiting', 'blocked', 'completed']

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

export default function SuperAdminPage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [members,    setMembers]    = useState<UserProfile[]>([])
  const [tasks,      setTasks]      = useState<Task[]>([])
  const [userMap,    setUserMap]    = useState<Record<string, string>>({})
  const [loading,    setLoading]    = useState(true)
  const [fetching,   setFetching]   = useState(false)
  const [memberId,   setMemberId]   = useState('')
  const [relation,   setRelation]   = useState<RelationFilter>('all')
  const [status,     setStatus]     = useState('')
  const [selected,   setSelected]   = useState<Set<string>>(new Set())
  const [deleting,   setDeleting]   = useState(false)
  const [confirm,    setConfirm]    = useState(false)
  const [error,      setError]      = useState('')
  const [success,    setSuccess]    = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: p }, membersRes, { data: usersData }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, position, is_active, created_at').eq('id', session.user.id).single(),
        fetch('/api/admin-members', { headers: { 'Authorization': `Bearer ${session.access_token}` } }).then(r => r.json()),
        supabase.from('users').select('id, full_name'),
      ])

      if (p?.role !== 'admin') { router.push('/dashboard'); return }
      setProfile(p as UserProfile)
      if (Array.isArray(membersRes?.members)) setMembers(membersRes.members as UserProfile[])
      if (usersData) {
        const map: Record<string, string> = {}
        for (const u of usersData) map[u.id] = u.full_name
        setUserMap(map)
      }
      setLoading(false)

      // Auto-load all tasks on first visit
      setFetching(true)
      const tasksRes = await fetch('/api/admin-tasks', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      const tasksData = await tasksRes.json()
      if (tasksRes.ok) setTasks((tasksData.tasks ?? []) as Task[])
      setFetching(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchTasks = async () => {
    setFetching(true)
    setError('')
    setSelected(new Set())
    const { data: { session } } = await supabase.auth.getSession()
    const params = new URLSearchParams()
    if (memberId) params.set('memberId', memberId)
    if (relation !== 'all') params.set('relation', relation)
    if (status) params.set('status', status)
    const res = await fetch(`/api/admin-tasks?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${session?.access_token ?? ''}` },
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Failed to fetch tasks'); setFetching(false); return }
    setTasks((data.tasks ?? []) as Task[])
    setFetching(false)
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === tasks.length) setSelected(new Set())
    else setSelected(new Set(tasks.map(t => t.id)))
  }

  const handleDeleteConfirmed = async () => {
    setDeleting(true)
    setError('')
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin-delete-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ taskIds: [...selected] }),
    })
    const data = await res.json()
    setDeleting(false)
    setConfirm(false)
    if (!res.ok) { setError(data.error || 'Failed to delete tasks'); return }
    setSuccess(`${data.deleted} task${data.deleted !== 1 ? 's' : ''} permanently deleted.`)
    setTimeout(() => setSuccess(''), 4000)
    setSelected(new Set())
    await fetchTasks()
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Super Admin"
      subtitle="View and permanently delete tasks across all members."
      onSignOut={handleLogout}
    >

      {/* Confirmation modal */}
      {confirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="boe-card" style={{ maxWidth: '400px', width: '90%', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ fontWeight: 600, fontSize: '14px', color: colors.primary, margin: 0 }}>Permanently Delete Tasks</p>
            <p style={{ fontSize: '13px', color: colors.secondary, margin: 0 }}>
              This will permanently delete <strong>{selected.size} selected task{selected.size !== 1 ? 's' : ''}</strong> and all their activity logs. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirm(false)} className="boe-btn boe-btn-ghost" style={{ padding: '7px 14px', fontSize: '12px' }}>
                Cancel
              </button>
              <button type="button" onClick={handleDeleteConfirmed} disabled={deleting} className="boe-btn"
                style={{ padding: '7px 14px', fontSize: '12px', background: colors.red, color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                {deleting ? 'Deleting…' : 'Permanently Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Banners */}
      {error && (
        <div style={{ padding: '10px 14px', background: '#fff5f5', border: `1px solid ${colors.red}`, borderRadius: '8px', fontSize: '12px', color: colors.red, marginBottom: '16px' }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ padding: '10px 14px', background: '#f0faf4', border: '1px solid #b7e4c7', borderRadius: '8px', fontSize: '12px', color: '#2d6a4f', marginBottom: '16px' }}>
          {success}
        </div>
      )}

      {/* Filters */}
      <div className="boe-card" style={{ padding: '16px', marginBottom: '20px', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' }}>
        {/* Member */}
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.muted, display: 'block', marginBottom: '4px' }}>
            Member
          </label>
          <select value={memberId} onChange={e => setMemberId(e.target.value)} className="boe-input" style={{ fontSize: '12px' }}>
            <option value="">All Members</option>
            {members.map(m => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </div>

        {/* Relation */}
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.muted, display: 'block', marginBottom: '4px' }}>
            Task Relation
          </label>
          <select value={relation} onChange={e => setRelation(e.target.value as RelationFilter)} className="boe-input" style={{ fontSize: '12px' }}>
            <option value="all">All (Created / Assigned / Delegated)</option>
            <option value="created_by">Created by member</option>
            <option value="assigned_to">Assigned to member</option>
            <option value="delegated_by">Delegated by member</option>
          </select>
        </div>

        {/* Status */}
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.muted, display: 'block', marginBottom: '4px' }}>
            Status
          </label>
          <select value={status} onChange={e => setStatus(e.target.value)} className="boe-input" style={{ fontSize: '12px' }}>
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s}</option>
            ))}
          </select>
        </div>

        <button onClick={fetchTasks} disabled={fetching} className="boe-btn boe-btn-primary" style={{ padding: '9px 20px', fontSize: '12px', alignSelf: 'flex-end' }}>
          {fetching ? 'Loading…' : 'Load Tasks'}
        </button>
      </div>

      {/* Action bar */}
      {tasks.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', color: colors.muted }}>
            {tasks.length} task{tasks.length !== 1 ? 's' : ''} · {selected.size} selected
          </div>
          <button
            onClick={() => setConfirm(true)}
            disabled={selected.size === 0}
            className="boe-btn"
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', fontSize: '12px',
              background: selected.size > 0 ? colors.red : colors.float,
              color: selected.size > 0 ? '#fff' : colors.muted,
              border: 'none', borderRadius: '6px',
              cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            <Trash2 size={13} />
            Delete selected permanently
          </button>
        </div>
      )}

      {/* Task table */}
      {tasks.length === 0 && !fetching ? (
        <div className="boe-card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ fontSize: '13px', color: colors.muted, margin: 0 }}>
            Select filters and click <strong>Load Tasks</strong> to view tasks.
          </p>
        </div>
      ) : (
        <div className="boe-card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '36px 1fr 140px 100px 80px 100px',
            gap: '0',
            padding: '10px 14px',
            background: colors.raised,
            borderBottom: `1px solid ${colors.border}`,
            fontSize: '10px', fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            color: colors.muted,
          }}>
            <div>
              <input
                type="checkbox"
                checked={tasks.length > 0 && selected.size === tasks.length}
                onChange={toggleAll}
                style={{ cursor: 'pointer' }}
              />
            </div>
            <div>Title</div>
            <div>Assigned To</div>
            <div>Created By</div>
            <div>Status</div>
            <div>Due Date</div>
          </div>

          {/* Rows */}
          {tasks.map(task => {
            const isSelected = selected.has(task.id)
            return (
              <div
                key={task.id}
                onClick={() => toggleSelect(task.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr 140px 100px 80px 100px',
                  gap: '0',
                  padding: '11px 14px',
                  borderBottom: `1px solid ${colors.border}`,
                  background: isSelected ? `${colors.red}08` : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                  alignItems: 'center',
                }}
              >
                <div onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(task.id)}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {task.title}
                  </div>
                  {task.note && (
                    <div style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                      {task.note}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '11.5px', color: colors.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {userMap[task.assigned_to] ?? '—'}
                </div>
                <div style={{ fontSize: '11.5px', color: colors.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {userMap[task.created_by] ?? '—'}
                </div>
                <div>
                  <span className={`boe-badge boe-badge-${task.status}`} style={{ fontSize: '9px', textTransform: 'capitalize' }}>
                    {task.status}
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: colors.secondary }}>
                  {formatDate(task.due_date)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </DashboardLayout>
  )
}
