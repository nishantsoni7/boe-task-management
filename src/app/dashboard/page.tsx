'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'

import { LoadingScreen } from '@/components/ui/atoms'
import { OverduePrompt, type OverdueAction } from '@/components/ui/OverduePrompt'
import { TaskCard } from '@/components/ui/TaskCard'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'

const PRIORITY_WEIGHT: Record<string, number> = { high: 0, medium: 1, low: 2 }

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

export default function DashboardPage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [tasks,         setTasks]         = useState<Task[]>([])
  const [loading,       setLoading]       = useState(true)
  const [currentUserId, setCurrentUserId] = useState('')
  const [promptOpen,    setPromptOpen]    = useState(false)
  const [promptSaving,  setPromptSaving]  = useState(false)
  const [resolvedIds,   setResolvedIds]   = useState<Set<string>>(new Set())
  const [selectedTask,  setSelectedTask]  = useState<Task | null>(null)
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set())
  const [teamTasks,     setTeamTasks]     = useState<Task[]>([])
  const [teamUsers,     setTeamUsers]     = useState<{ id: string; full_name: string }[]>([])
  const [blockedTasks,  setBlockedTasks]  = useState<Task[]>([])

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const pageStart = performance.now()
      console.log('[dashboard] init started')

      // ── CHANGE 1 ──────────────────────────────────────────────────────────
      // Was: supabase.auth.getUser()
      // Now: supabase.auth.getSession()
      //
      // getUser() makes a verified network call to Supabase auth servers.
      // getSession() reads the cached session from localStorage — zero network
      // cost. Safe here because:
      //   (a) this is a client-side UI gate only (redirect to /login)
      //   (b) real data security is enforced by Supabase RLS on every query
      //   (c) user.id is only used to filter queries; wrong id = RLS rejection
      // ──────────────────────────────────────────────────────────────────────
      const authStart = performance.now()
      const { data: { session } } = await supabase.auth.getSession()
      console.log('[dashboard] getSession', Math.round(performance.now() - authStart), 'ms')

      if (!session) { router.push('/login'); return }
      setCurrentUserId(session.user.id)

      // ── CHANGE 2 ──────────────────────────────────────────────────────────
      // Profile and tasks remain in Promise.all (parallel — was already correct).
      // Each branch now has its own .then() timing log so we can see whether
      // profile or tasks is the slower query without breaking parallelism.
      // Both start at the same instant; each reports when it individually finishes.
      // ──────────────────────────────────────────────────────────────────────
      const dataStart    = performance.now()
      const profileStart = performance.now()
      const tasksStart   = performance.now()

      const [{ data: profileData }, { data: taskData }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', session.user.id)
          .single()
          .then((r: any) => {
            console.log('[dashboard] profile fetch', Math.round(performance.now() - profileStart), 'ms')
            return r
          }),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', session.user.id)
          .not('status', 'eq', 'completed')
          .order('created_at', { ascending: false })
          .then((r: any) => {
            console.log('[dashboard] tasks fetch', Math.round(performance.now() - tasksStart), 'ms')
            return r
          }),
      ])

      console.log('[dashboard] parallel data TOTAL', Math.round(performance.now() - dataStart), 'ms')

      if (profileData) setProfile(profileData)

      if (taskData) {
        const typedTasks = taskData as unknown as Task[]
        setTasks(typedTasks)
      }

      if (profileData?.role === 'admin' || profileData?.role === 'manager') {
        const [{ data: tTasks }, { data: tUsers }, { data: bTasks }] = await Promise.all([
          supabase
            .from('tasks')
            .select('id, assigned_to, due_date, created_at, last_update_at, status')
            .not('status', 'eq', 'completed'),
          supabase
            .from('users')
            .select('id, full_name')
            .eq('is_active', true),
          supabase
            .from('tasks')
            .select(TASK_COLUMNS)
            .eq('status', 'blocked')
            .order('created_at', { ascending: false })
            .limit(5),
        ])
        if (tTasks) setTeamTasks(tTasks as unknown as Task[])
        if (tUsers) setTeamUsers(tUsers as { id: string; full_name: string }[])
        if (bTasks) setBlockedTasks(bTasks as unknown as Task[])
      }

      console.log('[dashboard] TOTAL', Math.round(performance.now() - pageStart), 'ms')
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleAcknowledge = async (task: Task) => {
    // Guard: skip if already acknowledged or a write is already in flight
    if (task.acknowledged_at || acknowledging.has(task.id)) return

    setAcknowledging(prev => new Set([...prev, task.id]))

    const now = new Date().toISOString()
    try {
      await Promise.all([
        supabase
          .from('tasks')
          .update({ acknowledged_at: now })
          .eq('id', task.id),
        supabase
          .from('task_activity_log')
          .insert({
            task_id:     task.id,
            actor_id:    currentUserId,
            action:      'acknowledged',
            note:        null,
            from_status: task.status,
            to_status:   task.status,
          }),
      ])
      // Optimistic update — moves task from Action Required → Continue Working
      setTasks(prev =>
        prev.map(t => t.id === task.id ? { ...t, acknowledged_at: now } : t)
      )
      // Success: clean up in-flight Set
      setAcknowledging(prev => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    } catch {
      // Failure: also clean up so user can retry
      setAcknowledging(prev => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }

  const unacknowledged  = tasks.filter(t => !t.acknowledged_at)
  const allOverdueTasks = tasks.filter(t => isOverdue(t.due_date) && t.acknowledged_at)
  const pendingOverdue  = allOverdueTasks.filter(t => !resolvedIds.has(t.id))
  const actionRequired  = [...allOverdueTasks, ...unacknowledged]

  const WAITING_DEPS = [
    'Client', 'Vendor', 'Design Team', 'Purchase Team',
    'Production', 'Management', 'Transport', 'Other',
  ] as const

  const waitingTasks = tasks.filter(t => t.status === 'waiting')

  const waitingByDep = WAITING_DEPS.reduce<Record<string, number>>((acc, dep) => {
    acc[dep] = waitingTasks.filter(t => {
      if (dep === 'Other') return !t.waiting_on_text || t.waiting_on_type === 'team_member'
      return t.waiting_on_type === 'external' && t.waiting_on_text === dep
    }).length
    return acc
  }, {} as Record<string, number>)

  const now = new Date()
  const msPerDay = 24 * 60 * 60 * 1000

  function escalationAge(refIso: string): string {
    const ms = now.getTime() - new Date(refIso).getTime()
    const hours = Math.floor(ms / (60 * 60 * 1000))
    if (hours < 48) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }

  const needsAttention: { task: Task; reason: string; refIso: string }[] = []
  const needsAttentionIds = new Set<string>()

  // Rule 1: Pending ack >24h — unacknowledged and created more than 24h ago
  tasks
    .filter(t => !t.acknowledged_at && (now.getTime() - new Date(t.created_at).getTime()) > msPerDay)
    .forEach(t => {
      if (!needsAttentionIds.has(t.id)) {
        needsAttentionIds.add(t.id)
        needsAttention.push({ task: t, reason: 'Pending ack', refIso: t.created_at })
      }
    })

  // Rule 2: Waiting >2d — status is waiting, last_update_at (or created_at) older than 2 days
  tasks
    .filter(t => {
      if (t.status !== 'waiting') return false
      const ref = t.last_update_at ?? t.created_at
      return (now.getTime() - new Date(ref).getTime()) > 2 * msPerDay
    })
    .forEach(t => {
      if (!needsAttentionIds.has(t.id)) {
        needsAttentionIds.add(t.id)
        const ref = t.last_update_at ?? t.created_at
        needsAttention.push({ task: t, reason: 'Waiting', refIso: ref })
      }
    })

  // Rule 3: Stale working >3d — status is working, no update for more than 3 days
  tasks
    .filter(t => {
      if (t.status !== 'working') return false
      const ref = t.last_update_at ?? t.created_at
      return (now.getTime() - new Date(ref).getTime()) > 3 * msPerDay
    })
    .forEach(t => {
      if (!needsAttentionIds.has(t.id)) {
        needsAttentionIds.add(t.id)
        const ref = t.last_update_at ?? t.created_at
        needsAttention.push({ task: t, reason: 'No update', refIso: ref })
      }
    })

  const continueWorking = tasks
    .filter(t => t.acknowledged_at && !isOverdue(t.due_date))
    .slice()
    .sort((a, b) => {
      if (a.is_urgent !== b.is_urgent) return a.is_urgent ? -1 : 1
      const aHasDue = a.due_date != null
      const bHasDue = b.due_date != null
      if (aHasDue !== bHasDue) return aHasDue ? -1 : 1
      if (aHasDue && bHasDue) {
        const dateDiff = new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime()
        if (dateDiff !== 0) return dateDiff
      }
      return (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1)
    })

  const userMap = useMemo(
    () => Object.fromEntries(teamUsers.map(u => [u.id, u.full_name])),
    [teamUsers]
  )

  const handleDashboardAddUpdate = async (note: string, newStatus: string, waitingOn?: { type: 'team_member' | 'external'; userId?: string; text?: string }) => {
    if (!selectedTask) return
    const now = new Date().toISOString()
    const statusChanged = newStatus !== selectedTask.status
    const trimmedNote = note.trim() || null

    if (statusChanged) {
      const needsBlockerReason = newStatus === 'blocked'
      const clearBlockerReason = selectedTask.status === 'blocked'
      const clearWaiting = selectedTask.status === 'waiting' && newStatus !== 'waiting'
      const taskUpdates: Record<string, unknown> = { status: newStatus, last_update_at: now }
      if (needsBlockerReason) taskUpdates.blocker_reason = trimmedNote
      else if (clearBlockerReason) taskUpdates.blocker_reason = null
      if (newStatus === 'waiting' && waitingOn) {
        taskUpdates.waiting_on_type    = waitingOn.type
        taskUpdates.waiting_on_user_id = waitingOn.type === 'team_member' ? (waitingOn.userId ?? null) : null
        taskUpdates.waiting_on_text    = waitingOn.type === 'external'    ? (waitingOn.text    ?? null) : null
      } else if (clearWaiting) {
        taskUpdates.waiting_on_type    = null
        taskUpdates.waiting_on_user_id = null
        taskUpdates.waiting_on_text    = null
      }
      await supabase.from('tasks')
        .update(taskUpdates)
        .eq('id', selectedTask.id)

      await supabase.from('task_activity_log').insert({
        task_id:     selectedTask.id,
        actor_id:    currentUserId,
        action:      'status_changed',
        from_status: selectedTask.status,
        to_status:   newStatus,
        note:        trimmedNote,
      })
      const localPatch: Partial<Task> = { status: newStatus as Task['status'], last_update_at: now }
      if (needsBlockerReason) localPatch.blocker_reason = trimmedNote
      else if (clearBlockerReason) localPatch.blocker_reason = null
      if (newStatus === 'waiting' && waitingOn) {
        localPatch.waiting_on_type    = waitingOn.type
        localPatch.waiting_on_user_id = waitingOn.type === 'team_member' ? (waitingOn.userId ?? null) : null
        localPatch.waiting_on_text    = waitingOn.type === 'external'    ? (waitingOn.text    ?? null) : null
      } else if (clearWaiting) {
        localPatch.waiting_on_type    = null
        localPatch.waiting_on_user_id = null
        localPatch.waiting_on_text    = null
      }
      setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...localPatch } : t))
      // Keep in blockedTasks with new status so the sync effect can still find selectedTask;
      // the card filters to status === 'blocked' so it will disappear from the list automatically.
      setBlockedTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...localPatch } : t))
      setSelectedTask(prev => prev ? { ...prev, ...localPatch } : prev)
    } else if (trimmedNote) {
      await supabase.from('tasks')
        .update({ last_update_at: now })
        .eq('id', selectedTask.id)
      await supabase.from('task_activity_log').insert({
        task_id:     selectedTask.id,
        actor_id:    currentUserId,
        action:      'status_changed',
        from_status: selectedTask.status,
        to_status:   selectedTask.status,
        note:        trimmedNote,
      })
      setTasks(prev => prev.map(t =>
        t.id === selectedTask.id ? { ...t, last_update_at: now } : t
      ))
      setBlockedTasks(prev => prev.map(t =>
        t.id === selectedTask.id ? { ...t, last_update_at: now } : t
      ))
    }
  }

  const escalationSummary = useMemo(() => {
    if (teamTasks.length === 0) return []
    const userMap = new Map(teamUsers.map(u => [u.id, u.full_name]))
    const byAssignee = new Map<string, { name: string; count: number; oldestDate: string | null }>()
    teamTasks.filter(t => isOverdue(t.due_date)).forEach(t => {
      const name = userMap.get(t.assigned_to) ?? t.assigned_to.slice(0, 8)
      if (!byAssignee.has(t.assigned_to)) {
        byAssignee.set(t.assigned_to, { name, count: 0, oldestDate: null })
      }
      const entry = byAssignee.get(t.assigned_to)!
      entry.count++
      if (!entry.oldestDate || t.due_date! < entry.oldestDate) entry.oldestDate = t.due_date!
    })
    return [...byAssignee.values()].sort((a, b) => b.count - a.count)
  }, [teamTasks, teamUsers])

  const handleOverdueAction = async (task: Task, action: OverdueAction) => {
    setPromptSaving(true)
    const now = new Date().toISOString()
    try {
      if (action.type === 'continue') {
        await Promise.all([
          supabase.from('tasks')
            .update({ last_update_at: now })
            .eq('id', task.id),
          supabase.from('task_activity_log').insert({
            task_id: task.id, actor_id: currentUserId,
            action: 'progress_update', note: action.note || null,
            from_status: task.status, to_status: task.status,
          }),
        ])
        setTasks(prev => prev.map(t =>
          t.id === task.id ? { ...t, last_update_at: now } : t
        ))

      } else if (action.type === 'blocked' || action.type === 'waiting') {
        const newStatus = action.type
        await Promise.all([
          supabase.from('tasks')
            .update(newStatus === 'waiting'
              ? { status: newStatus, waiting_on_type: 'external', waiting_on_text: action.reason, waiting_on_user_id: null, last_update_at: now }
              : { status: newStatus, blocker_reason: action.reason, last_update_at: now })
            .eq('id', task.id),
          supabase.from('task_activity_log').insert({
            task_id: task.id, actor_id: currentUserId, action: 'status_changed',
            note: action.reason, from_status: task.status, to_status: newStatus,
          }),
        ])
        setTasks(prev => prev.map(t =>
          t.id === task.id
            ? newStatus === 'waiting'
              ? { ...t, status: newStatus, waiting_on_type: 'external' as const, waiting_on_text: action.reason, waiting_on_user_id: null, last_update_at: now }
              : { ...t, status: newStatus, blocker_reason: action.reason, last_update_at: now }
            : t
        ))

      } else if (action.type === 'completed') {
        await Promise.all([
          supabase.from('tasks')
            .update({ status: 'completed', completed_at: now, last_update_at: now })
            .eq('id', task.id),
          supabase.from('task_activity_log').insert({
            task_id: task.id, actor_id: currentUserId, action: 'status_changed',
            note: null, from_status: task.status, to_status: 'completed',
          }),
        ])
        setTasks(prev => prev.filter(t => t.id !== task.id))
      }
    } finally {
      setPromptSaving(false)
    }
    setResolvedIds(prev => new Set([...prev, task.id]))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (promptOpen && pendingOverdue.length === 0) setPromptOpen(false)
  }, [pendingOverdue.length, promptOpen])

  useEffect(() => {
    if (!selectedTask) return
    const updated = tasks.find(t => t.id === selectedTask.id)
             ?? blockedTasks.find(t => t.id === selectedTask.id)
    if (!updated) {
      setSelectedTask(null)
    } else if (updated !== selectedTask) {
      setSelectedTask(updated)
    }
  }, [tasks, blockedTasks, selectedTask])

  if (loading) return <LoadingScreen />

  const currentOverdueTask = pendingOverdue[0] ?? null

  return (
    <>
      {promptOpen && currentOverdueTask && (
        <OverduePrompt
          key={currentOverdueTask.id}
          tasks={pendingOverdue}
          currentIdx={0}
          saving={promptSaving}
          onAction={handleOverdueAction}
        />
      )}

      <DashboardLayout
        profile={profile}
        title="Dashboard"
        subtitle={
          profile
            ? `${new Date().toLocaleDateString('en-IN', {
                weekday: 'long', day: 'numeric', month: 'long',
              })} · ${profile.team}`
            : undefined
        }
        actions={
          <button
            onClick={() => router.push('/tasks/create')}
            className="boe-btn boe-btn-primary"
          >
            + New Task
          </button>
        }
        onSignOut={handleLogout}
      >
        <FocusSummary
          actionCount={actionRequired.length}
          blockerCount={waitingTasks.length}
          overdueCount={allOverdueTasks.length}
        />

        {(profile?.role === 'admin' || profile?.role === 'manager') && (
          <BlockedTasksCard
            tasks={blockedTasks.filter(t => t.status === 'blocked')}
            userMap={new Map(teamUsers.map(u => [u.id, u.full_name]))}
            onView={setSelectedTask}
          />
        )}

        {/* ACTION REQUIRED section box */}
        <div style={{
          marginBottom: '16px', borderRadius: '8px',
          background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: '16px',
          alignSelf: 'flex-start', width: '100%',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', marginBottom: '14px',
            color: '#D4893A', borderLeft: '2px solid #D4893A', paddingLeft: '8px',
          }}>
            Action Required ({actionRequired.length})
          </div>
          {actionRequired.length > 0 ? (
            <div>
              {allOverdueTasks.length > 0 && (
                <div className="boe-dashboard-grid">
                  {allOverdueTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onClick={() => setSelectedTask(task)}
                      cardStyle={{ backgroundColor: 'rgba(217,79,79,0.03)' }}
                    />
                  ))}
                </div>
              )}
              {allOverdueTasks.length > 0 && unacknowledged.length > 0 && (
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', margin: '12px 0' }} />
              )}
              {unacknowledged.length > 0 && (
                <div className="boe-dashboard-grid">
                  {unacknowledged.map(task => {
                    const isAcking = acknowledging.has(task.id)
                    return (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => setSelectedTask(task)}
                        cardStyle={{
                          backgroundColor: 'rgba(232,160,48,0.025)',
                          borderLeftColor: colors.amber,
                        }}
                        footer={
                          <button
                            onClick={e => { e.stopPropagation(); handleAcknowledge(task) }}
                            disabled={isAcking}
                            style={{
                              display:       'block',
                              width:         '160px',
                              margin:        '0 auto',
                              padding:       '9px 0',
                              fontSize:      '13px',
                              fontWeight:    600,
                              letterSpacing: '0.02em',
                              color:         isAcking ? '#B8892A' : '#FFFFFF',
                              background:    isAcking ? 'rgba(232,160,48,0.12)' : '#E8A030',
                              border:        '1px solid transparent',
                              borderRadius:  '6px',
                              cursor:        isAcking ? 'default' : 'pointer',
                              boxShadow:     isAcking ? 'none' : '0 1px 4px rgba(232,160,48,0.35)',
                              transition:    'opacity 0.15s',
                            }}
                          >
                            {isAcking ? 'Acknowledging…' : '✓ Acknowledge'}
                          </button>
                        }
                      />
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            <div style={{
              padding: '10px 14px', borderRadius: '6px',
              background: 'rgba(94,163,79,0.05)', border: '1px solid rgba(94,163,79,0.12)',
              fontSize: '12px', color: 'rgba(94,163,79,0.8)',
            }}>
              Nothing needs your attention right now
            </div>
          )}
        </div>

        {/* NEEDS ATTENTION section box */}
        <div style={{
          marginBottom: '16px', borderRadius: '8px',
          background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: '16px',
          alignSelf: 'flex-start', width: '100%',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', marginBottom: '14px',
            color: '#C0392B', borderLeft: '2px solid #C0392B', paddingLeft: '8px',
          }}>
            Needs Attention ({needsAttention.length})
          </div>
          {needsAttention.length > 0 ? (
            <div className="boe-dashboard-grid">
              {needsAttention.slice(0, 10).map(({ task, reason, refIso }) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => setSelectedTask(task)}
                  cardStyle={{ backgroundColor: 'rgba(192,57,43,0.03)', borderLeftColor: '#C0392B' }}
                  footer={
                    <div style={{
                      fontSize: '11px', fontWeight: 600,
                      color: '#C0392B', padding: '4px 0 0',
                      letterSpacing: '0.02em',
                    }}>
                      {reason} · {escalationAge(refIso)}
                    </div>
                  }
                />
              ))}
            </div>
          ) : (
            <div style={{
              padding: '10px 14px', borderRadius: '6px',
              background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(0,0,0,0.06)',
              fontSize: '12px', color: colors.muted,
            }}>
              No stuck tasks right now.
            </div>
          )}
        </div>

        {/* BLOCKERS section box */}
        <div style={{
          marginBottom: '16px', borderRadius: '8px',
          background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: '16px',
          alignSelf: 'flex-start', width: '100%',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', marginBottom: '14px',
            color: 'rgba(200,162,74,0.85)', borderLeft: '2px solid rgba(200,162,74,0.45)', paddingLeft: '8px',
          }}>
            Blockers ({waitingTasks.length})
          </div>
          <WaitingWidget byDep={waitingByDep} deps={WAITING_DEPS} />
        </div>

        {/* CONTINUE WORKING section box */}
        <div style={{
          marginBottom: '16px', borderRadius: '8px',
          background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: '16px',
          alignSelf: 'flex-start', width: '100%',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', marginBottom: '14px',
            color: colors.muted,
          }}>
            Continue Working ({continueWorking.length})
          </div>
          {continueWorking.length > 0 ? (
            <div className="boe-dashboard-grid">
              {continueWorking.map(task => (
                <TaskCard key={task.id} task={task} onClick={() => setSelectedTask(task)} />
              ))}
            </div>
          ) : (
            <div style={{
              padding: '10px 14px', borderRadius: '6px',
              background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(0,0,0,0.06)',
              fontSize: '12px', color: colors.muted,
            }}>
              No active tasks — tap + New Task to create one
            </div>
          )}
        </div>

        {escalationSummary.length > 0 && (
          <EscalationSummaryCard rows={escalationSummary} escalationAge={escalationAge} />
        )}

      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={currentUserId}
          onAddUpdate={handleDashboardAddUpdate}
        />
      )}
    </>
  )
}

function FocusSummary({
  actionCount,
  blockerCount,
  overdueCount,
}: {
  actionCount: number
  blockerCount: number
  overdueCount: number
}) {
  return (
    <div style={{
      padding: '12px 14px', marginBottom: '20px', borderRadius: '8px',
      background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em',
        color: colors.muted, marginBottom: '10px', textTransform: 'uppercase',
      }}>
        Today&apos;s Focus
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
        <div style={{
          padding: '10px 12px', borderRadius: '6px',
          background: actionCount > 0 ? 'rgba(232,160,48,0.07)' : 'rgba(0,0,0,0.02)',
          border: `1px solid ${actionCount > 0 ? 'rgba(232,160,48,0.2)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: font.mono, color: actionCount > 0 ? colors.amber : colors.muted, lineHeight: 1 }}>
            {actionCount}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '4px' }}>
            Tasks need action
          </div>
        </div>
        <div style={{
          padding: '10px 12px', borderRadius: '6px',
          background: blockerCount > 0 ? 'rgba(200,162,74,0.07)' : 'rgba(0,0,0,0.02)',
          border: `1px solid ${blockerCount > 0 ? 'rgba(200,162,74,0.2)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: font.mono, color: blockerCount > 0 ? '#C8A24A' : colors.muted, lineHeight: 1 }}>
            {blockerCount}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '4px' }}>
            Blockers
          </div>
        </div>
        <div style={{
          padding: '10px 12px', borderRadius: '6px',
          background: overdueCount > 0 ? 'rgba(217,79,79,0.07)' : 'rgba(0,0,0,0.02)',
          border: `1px solid ${overdueCount > 0 ? 'rgba(217,79,79,0.2)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: font.mono, color: overdueCount > 0 ? colors.red : colors.muted, lineHeight: 1 }}>
            {overdueCount}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '4px' }}>
            Overdue
          </div>
        </div>
      </div>
    </div>
  )
}

function EscalationSummaryCard({
  rows,
  escalationAge,
}: {
  rows: { name: string; count: number; oldestDate: string | null }[]
  escalationAge: (iso: string) => string
}) {
  return (
    <div style={{
      marginBottom: '16px', borderRadius: '8px',
      background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: '16px',
      alignSelf: 'flex-start', width: '100%',
    }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
        textTransform: 'uppercase', marginBottom: '14px',
        color: '#C0392B', borderLeft: '2px solid #C0392B', paddingLeft: '8px',
      }}>
        Manager Escalation Summary
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {rows.slice(0, 8).map(row => (
          <div key={row.name} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px', borderRadius: '6px',
            background: 'rgba(192,57,43,0.04)', border: '1px solid rgba(192,57,43,0.10)',
          }}>
            <div style={{ fontSize: '13px', fontWeight: 500, color: '#222' }}>
              {row.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {row.oldestDate && (
                <div style={{ fontSize: '11px', color: colors.muted }}>
                  oldest {escalationAge(row.oldestDate)}
                </div>
              )}
              <div style={{
                fontSize: '13px', fontWeight: 700, color: '#C0392B',
                background: 'rgba(192,57,43,0.08)', borderRadius: '4px',
                padding: '2px 8px', minWidth: '28px', textAlign: 'center',
              }}>
                {row.count}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function BlockedTasksCard({
  tasks,
  userMap,
  onView,
}: {
  tasks: Task[]
  userMap: Map<string, string>
  onView: (task: Task) => void
}) {
  return (
    <div style={{
      marginBottom: '16px', borderRadius: '8px',
      background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: '16px',
      alignSelf: 'flex-start', width: '100%',
    }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
        textTransform: 'uppercase', marginBottom: '14px',
        color: '#8B1A1A', borderLeft: '2px solid #8B1A1A', paddingLeft: '8px',
      }}>
        Blocked Tasks ({tasks.length})
      </div>
      {tasks.length === 0 ? (
        <div style={{
          padding: '10px 14px', borderRadius: '6px',
          background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(0,0,0,0.06)',
          fontSize: '12px', color: '#888',
        }}>
          No blocked tasks right now
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {tasks.map(task => {
            const assignee = userMap.get(task.assigned_to)
            return (
              <div key={task.id} style={{
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                gap: '12px', padding: '10px 12px', borderRadius: '7px',
                background: 'rgba(139,26,26,0.04)', border: '1px solid rgba(139,26,26,0.12)',
                borderLeft: '3px solid rgba(139,26,26,0.5)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#222', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {task.title}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px', color: '#666' }}>
                    {assignee && <span>👤 {assignee}</span>}
                    {task.due_date && (
                      <span>📅 {new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                    )}
                    {task.blocker_reason && (
                      <span style={{ color: '#8B1A1A', fontStyle: 'italic' }}>⛔ {task.blocker_reason}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onView(task)}
                  style={{
                    flexShrink: 0, padding: '5px 10px',
                    fontSize: '11px', fontWeight: 600, letterSpacing: '0.02em',
                    color: '#8B1A1A', background: 'rgba(139,26,26,0.07)',
                    border: '1px solid rgba(139,26,26,0.18)', borderRadius: '5px',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  View task
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function WaitingWidget({
  byDep,
  deps,
}: {
  byDep: Record<string, number>
  deps: readonly string[]
}) {
  const active = deps.filter(d => byDep[d] > 0)

  if (active.length === 0) {
    return (
      <div style={{
        padding: '10px 14px', borderRadius: '6px',
        background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(0,0,0,0.06)',
        fontSize: '12px', color: colors.muted,
      }}>
        No blockers right now
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '8px',
    }}>
      {active.map(dep => (
        <div
          key={dep}
          style={{
            padding: '10px 12px', borderRadius: '7px',
            background: 'rgba(232,160,48,0.055)',
            border: '1px solid rgba(232,160,48,0.14)',
            borderLeft: '3px solid rgba(232,160,48,0.42)',
          }}
        >
          <div style={{ fontSize: '11px', color: colors.secondary, fontWeight: 500, marginBottom: '5px' }}>
            {dep}
          </div>
          <div style={{
            fontFamily: font.mono, fontSize: '22px', fontWeight: 700,
            color: '#C8A24A', lineHeight: 1,
          }}>
            {byDep[dep]}
          </div>
          <div style={{ fontSize: '10px', color: colors.muted, marginTop: '3px', letterSpacing: '0.02em' }}>
            waiting tasks
          </div>
        </div>
      ))}
    </div>
  )
}


