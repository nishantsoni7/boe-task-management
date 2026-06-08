'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'
import { ClipboardList, Trash2 } from 'lucide-react'

type PeriodFilter = 'today' | 'this_week' | 'this_month'

const PERIOD_LABELS: Record<PeriodFilter, string> = {
  today:      'Today',
  this_week:  'This Week',
  this_month: 'This Month',
}

function formatDateTime(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

const COL = '44px minmax(0,1fr) 150px 130px 100px 150px'

export default function SuperAdminPage() {
  const { viewAsUserId, exitViewMode } = useViewAs()
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [members,   setMembers]   = useState<UserProfile[]>([])
  const [tasks,     setTasks]     = useState<Task[]>([])
  const [userMap,   setUserMap]   = useState<Record<string, string>>({})
  const [loading,   setLoading]   = useState(true)
  const [fetching,  setFetching]  = useState(false)
  const [memberId,  setMemberId]  = useState('')
  const [period,    setPeriod]    = useState<PeriodFilter>('today')
  const [selected,  setSelected]  = useState<Set<string>>(new Set())
  const [deleting,  setDeleting]  = useState(false)
  const [confirm,   setConfirm]   = useState(false)
  const [error,     setError]     = useState('')
  const [success,   setSuccess]   = useState('')
  const [hasLoaded, setHasLoaded] = useState(false)

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
      if (viewAsUserId) { exitViewMode(); router.push('/dashboard'); return }
      setProfile(p as UserProfile)
      if (Array.isArray(membersRes?.members)) setMembers(membersRes.members as UserProfile[])
      if (usersData) {
        const map: Record<string, string> = {}
        for (const u of usersData) map[u.id] = u.full_name
        setUserMap(map)
      }
      setLoading(false)
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
    params.set('period', period)
    const res = await fetch(`/api/admin-tasks?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${session?.access_token ?? ''}` },
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Failed to fetch tasks'); setFetching(false); return }
    setTasks((data.tasks ?? []) as Task[])
    setHasLoaded(true)
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

  const memberLabel = memberId
    ? (members.find(m => m.id === memberId)?.full_name ?? 'Selected Member')
    : 'All Members'

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Super Admin"
      subtitle="Member-wise task reporting. View and permanently delete tasks."
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

      {/* Filter card */}
      <div className="boe-card" style={{ padding: '20px 24px', marginBottom: '16px', display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: colors.muted, display: 'block', marginBottom: '6px' }}>
            Member
          </label>
          <select value={memberId} onChange={e => setMemberId(e.target.value)} className="boe-input" style={{ fontSize: '13px', width: '100%' }}>
            <option value="">All Members</option>
            {members.map(m => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </div>

        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: colors.muted, display: 'block', marginBottom: '6px' }}>
            Period
          </label>
          <select value={period} onChange={e => setPeriod(e.target.value as PeriodFilter)} className="boe-input" style={{ fontSize: '13px', width: '100%' }}>
            <option value="today">Today</option>
            <option value="this_week">This Week</option>
            <option value="this_month">This Month</option>
          </select>
        </div>

        <div style={{ marginLeft: 'auto' }}>
          <button onClick={fetchTasks} disabled={fetching} className="boe-btn boe-btn-primary" style={{ padding: '10px 24px', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {fetching ? 'Loading…' : 'Load Tasks'}
          </button>
        </div>
      </div>

      {/* Summary row */}
      {hasLoaded && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: colors.float,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <ClipboardList size={16} color={colors.secondary} />
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, lineHeight: 1.3 }}>
                Total tasks created: {tasks.length}
              </div>
              <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px' }}>
                Member: {memberLabel} &bull; Period: {PERIOD_LABELS[period]}
              </div>
            </div>
          </div>

          <button
            onClick={() => setConfirm(true)}
            disabled={selected.size === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 16px', fontSize: '12px', fontWeight: 500,
              background: 'transparent',
              color: selected.size > 0 ? colors.red : colors.muted,
              border: `1px solid ${selected.size > 0 ? colors.red : colors.border}`,
              borderRadius: '6px',
              cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
            }}
          >
            <Trash2 size={13} />
            Delete selected permanently
          </button>
        </div>
      )}

      {/* Task table */}
      {!hasLoaded ? (
        <div className="boe-card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ fontSize: '13px', color: colors.muted, margin: 0 }}>
            Select filters and click <strong>Load Tasks</strong> to view tasks.
          </p>
        </div>
      ) : tasks.length === 0 && !fetching ? (
        <div className="boe-card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ fontSize: '13px', color: colors.muted, margin: 0 }}>
            No tasks found for the selected filters.
          </p>
        </div>
      ) : (
        <div className="boe-card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: COL,
            padding: '10px 20px',
            background: colors.raised,
            borderBottom: `1px solid ${colors.border}`,
            fontSize: '10px', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.07em',
            color: colors.muted,
            alignItems: 'center',
          }}>
            <div>
              <input
                type="checkbox"
                checked={tasks.length > 0 && selected.size === tasks.length}
                onChange={toggleAll}
                style={{ cursor: 'pointer' }}
              />
            </div>
            <div>Title &amp; Description</div>
            <div>Assigned To</div>
            <div>Created By</div>
            <div>Status</div>
            <div>Created Date</div>
          </div>

          {/* Table rows */}
          {tasks.map(task => {
            const isSelected = selected.has(task.id)
            return (
              <div
                key={task.id}
                onClick={() => toggleSelect(task.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COL,
                  padding: '14px 20px',
                  borderBottom: `1px solid ${colors.border}`,
                  background: isSelected ? colors.redTint : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                  alignItems: 'start',
                }}
              >
                {/* Checkbox */}
                <div style={{ paddingTop: '2px' }} onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(task.id)}
                    style={{ cursor: 'pointer' }}
                  />
                </div>

                {/* Title & Description */}
                <div style={{ minWidth: 0, paddingRight: '24px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, lineHeight: 1.35 }}>
                    {task.title}
                  </div>
                  {task.note && (
                    <div style={{
                      fontSize: '11.5px', color: colors.muted, marginTop: '3px', lineHeight: 1.4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>
                      {task.note}
                    </div>
                  )}
                </div>

                {/* Assigned To */}
                <div style={{ fontSize: '12.5px', color: colors.secondary, paddingRight: '8px' }}>
                  {userMap[task.assigned_to] ?? '—'}
                </div>

                {/* Created By */}
                <div style={{ fontSize: '12.5px', color: colors.secondary, paddingRight: '8px' }}>
                  {userMap[task.created_by] ?? '—'}
                </div>

                {/* Status */}
                <div>
                  <span className={`boe-badge boe-badge-${task.status}`} style={{ fontSize: '10px', textTransform: 'capitalize' }}>
                    {task.status}
                  </span>
                </div>

                {/* Created Date */}
                <div style={{ fontSize: '11.5px', color: colors.secondary, lineHeight: 1.35 }}>
                  {formatDateTime(task.created_at ?? null)}
                </div>
              </div>
            )
          })}

          {/* Footer */}
          <div style={{
            padding: '12px 20px',
            borderTop: `1px solid ${colors.border}`,
            fontSize: '12px', color: colors.muted,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>Showing 1 to {tasks.length} of {tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
            {selected.size > 0 && (
              <span style={{ color: colors.secondary }}>{selected.size} selected</span>
            )}
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
