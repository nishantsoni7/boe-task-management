'use client'

import React, { useEffect, useState, useMemo, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { Task } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { CompletedOnFilter, CompletedPager, CompletionSummaryCard } from '@/components/tasks/CompletedHistory'
import { useViewAs } from '@/hooks/useViewAs'
import {
  CheckCircle2, ExternalLink, Star,
  Search, RotateCcw,
} from 'lucide-react'
import { useListUrlState, useUrlSearchInput, usePruneUnknownValue } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { useCurrentReturnPath } from '@/hooks/useCurrentReturnPath'
import { taskDetailHref } from '@/lib/tasks/taskReturnPath'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useProfile } from '@/hooks/queries/useProfile'
import { useCompletedCounterparts, useCompletedTaskPage, useUserNames } from '@/hooks/queries/useCompletedTasks'
import { useCompletionSummary } from '@/hooks/queries/useTaskReports'
import { DELEGATED_COMPLETED_PARAMS, totalPages } from '@/lib/tasks/taskReporting'

/**
 * What the screen says when the archive could not be read.
 *
 * Deliberately not an empty list: an empty archive is a statement about
 * somebody's work, and a failed read is a statement about the request. The two
 * must never look the same.
 */
const ARCHIVE_LOAD_ERROR =
  'This list could not be loaded. Check your connection and try again.'

const SCOPE = 'assigned-by-me' as const
const NO_TASKS: Task[] = []
const NO_NAMES: Record<string, string> = {}

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
  low:    { label: 'Low',  color: colors.muted },
}

function InfoPanel() {
  return (
    <div style={{
      width: '220px', flexShrink: 0,
      background: 'rgba(76,175,125,0.04)',
      border: '1.5px solid rgba(76,175,125,0.18)',
      borderRadius: '10px', padding: '16px 14px',
      display: 'flex', flexDirection: 'column', gap: '14px', alignSelf: 'flex-start',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <CheckCircle2 size={14} color="#4CAF7D" />
        <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>About Completed</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {[
          'Tasks you delegated that have been marked completed.',
          'You can reopen a task if it was closed by mistake or has issues.',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <span style={{ marginTop: '3px', flexShrink: 0, width: '5px', height: '5px', borderRadius: '50%', background: 'rgba(76,175,125,0.5)', display: 'inline-block' }} />
            <span style={{ fontSize: '11.5px', color: colors.secondary, lineHeight: '1.5' }}>{text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CompletedTaskCard({
  task, userMap, onClick, onRestore, isMobile,
}: {
  task: Task
  userMap: Record<string, string>
  onClick: () => void
  onRestore: () => void
  isMobile?: boolean
}) {
  const [hovered,        setHovered]        = useState(false)
  const [hoveredRestore, setHoveredRestore] = useState(false)
  const [hoveredView,    setHoveredView]    = useState(false)

  const priority     = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const assigneeName = userMap[task.assigned_to ?? ''] ?? 'member'

  const completionInfo = (() => {
    // The completion timestamp the list is ordered and filtered by. A task
    // completed before completed_at was recorded falls back to its last update.
    const base = task.completed_at ?? task.last_update_at
    if (!base) return { completedLabel: 'Unknown', countdownLabel: 'Removal date unknown', warn: false }
    const completedAt = new Date(base)
    const completedLabel = completedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    const removeAt = new Date(completedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    const daysLeft = Math.ceil((removeAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    let countdownLabel: string
    let warn = false
    if (daysLeft <= 0)       { countdownLabel = 'Eligible for removal'; warn = true }
    else if (daysLeft === 1) { countdownLabel = 'Deletes tomorrow';      warn = true }
    else if (daysLeft <= 7)  { countdownLabel = `Deletes in ${daysLeft} days`; warn = true }
    else                     { countdownLabel = `Deletes in ${daysLeft} days`; warn = false }
    return { completedLabel, countdownLabel, warn }
  })()

  if (isMobile) {
    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
        style={{ background: hovered ? colors.raised : colors.base, border: `1.5px solid ${colors.border}`, borderRadius: '8px', opacity: 0.82, cursor: 'pointer', padding: '10px 12px' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
          {task.is_urgent && <Star size={11} fill="#C49A28" color="#C49A28" style={{ marginTop: '2px', flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            <button onClick={e => { e.stopPropagation(); onRestore() }}
              onMouseEnter={() => setHoveredRestore(true)} onMouseLeave={() => setHoveredRestore(false)}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '6px', background: hoveredRestore ? 'rgba(91,166,127,0.15)' : 'rgba(91,166,127,0.07)', border: `1px solid ${hoveredRestore ? 'rgba(91,166,127,0.45)' : 'rgba(91,166,127,0.25)'}`, cursor: 'pointer', outline: 'none', color: hoveredRestore ? '#3a9e6d' : '#4CAF7D', fontSize: '11px', fontWeight: 600 }}>
              <RotateCcw size={11} />
            </button>
            <button onClick={e => { e.stopPropagation(); onClick() }}
              onMouseEnter={() => setHoveredView(true)} onMouseLeave={() => setHoveredView(false)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', background: hoveredView ? 'rgba(76,175,125,0.12)' : 'transparent', border: `1px solid ${hoveredView ? 'rgba(76,175,125,0.35)' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredView ? '#4CAF7D' : colors.muted }}>
              <ExternalLink size={12} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', color: '#2E7D6B', background: 'rgba(46,158,107,0.10)', whiteSpace: 'nowrap' }}>{assigneeName}</span>
          <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.7 }}>{priority.label}</span>
          <span style={{ fontSize: '10.5px', color: completionInfo.warn ? '#C07820' : colors.muted, whiteSpace: 'nowrap' }}>{completionInfo.completedLabel}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center',
        background: hovered ? colors.raised : colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '8px',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.09)' : '0 1px 3px rgba(0,0,0,0.04)',
        opacity: 0.72,
        transition: 'background 0.12s, box-shadow 0.12s',
        minHeight: '48px', cursor: 'pointer',
      }}
    >
      {/* Star indicator */}
      <div style={{ width: '28px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {task.is_urgent ? <Star size={11} fill="#C49A28" color="#C49A28" /> : <div style={{ width: '11px' }} />}
      </div>

      {/* Title + note */}
      <div style={{ flex: 1, minWidth: 0, padding: '10px 8px 10px 0' }}>
        <div style={{ fontSize: '13px', fontWeight: 500, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
          {task.title}
        </div>
        {task.note && (
          <div style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
            {task.note}
          </div>
        )}
      </div>

      {/* Assigned to — fixed 140px */}
      <div style={{ flexShrink: 0, width: '140px', display: 'flex', alignItems: 'center', paddingLeft: '8px', paddingRight: '6px', overflow: 'hidden' }}>
        <span
          title={`Assigned to ${assigneeName}`}
          style={{
            display: 'inline-block', maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px',
            color: '#2E7D6B', background: 'rgba(46,158,107,0.10)',
          }}
        >
          {assigneeName}
        </span>
      </div>

      {/* Priority — fixed 52px */}
      <div style={{ flexShrink: 0, width: '52px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.6 }}>{priority.label}</span>
      </div>

      {/* Completion info — fixed 140px */}
      <div style={{ flexShrink: 0, width: '140px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px', paddingLeft: '4px' }}>
        <span style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap' }}>
          <span style={{ opacity: 0.6 }}>Completed on: </span>{completionInfo.completedLabel}
        </span>
        <span style={{ fontSize: '10.5px', fontWeight: 600, whiteSpace: 'nowrap', color: completionInfo.warn ? '#C07820' : colors.muted, opacity: completionInfo.warn ? 1 : 0.65 }}>
          {completionInfo.countdownLabel}
        </span>
      </div>

      {/* Actions: Restore + View */}
      <div style={{ flexShrink: 0, width: '140px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', paddingRight: '10px' }}>
        <button
          onClick={e => { e.stopPropagation(); onRestore() }}
          onMouseEnter={() => setHoveredRestore(true)}
          onMouseLeave={() => setHoveredRestore(false)}
          title="Reopen Task"
          style={{
            display: 'flex', alignItems: 'center', gap: '5px',
            padding: '4px 10px', borderRadius: '6px', height: '28px',
            background: hoveredRestore ? 'rgba(91,166,127,0.15)' : 'rgba(91,166,127,0.07)',
            border: `1px solid ${hoveredRestore ? 'rgba(91,166,127,0.45)' : 'rgba(91,166,127,0.25)'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredRestore ? '#3a9e6d' : '#4CAF7D',
            fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          <RotateCcw size={11} />
          Reopen Task
        </button>
        <button
          onClick={e => { e.stopPropagation(); onClick() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="View task details"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '28px', height: '28px', borderRadius: '6px',
            background: hoveredView ? 'rgba(76,175,125,0.12)' : 'transparent',
            border: `1px solid ${hoveredView ? 'rgba(76,175,125,0.35)' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredView ? '#4CAF7D' : colors.muted,
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: '6px' }}>
      <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '4px' }}>
        <CheckCircle2 size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>No completed delegated tasks</span>
      <span style={{ fontSize: '12px', color: colors.muted }}>Completed tasks will appear here.</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function AssignedByMeCompletedContent() {
  const { viewAsUserId } = useViewAs()

  // WHOSE ARCHIVE: the signed-in user's, or the viewed employee's under View As —
  // unchanged. Identity comes from the shared session query, a cache hit under
  // ModuleGuard, instead of a getSession() await before anything could load.
  const { data: signedInUserId, isPending: idPending } = useSignedInUserId()
  const userId = viewAsUserId ?? signedInUserId ?? ''
  const { data: profile = null } = useProfile(userId || null)

  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [restoredIds,  setRestoredIds]  = useState<ReadonlySet<string>>(() => new Set())
  const [isMobile,     setIsMobile]     = useState(false)

  // Filters, completion date AND page live in the URL, so Back from a task
  // restores this exact view. Any filter change drops the page back to 1.
  const { state, setState } = useListUrlState(DELEGATED_COMPLETED_PARAMS, { pageKey: 'page' })
  const filterAssignee = state.assignee
  const filterPriority = state.priority
  const search         = state.q
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(search, next => setState({ q: next }))

  useListScrollRestore()
  // This exact view, handed to Task Detail so Submit for Approval returns here.
  const returnTo = useCurrentReturnPath()

  const router      = useRouter()
  const queryClient = useQueryClient()
  const supabase    = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    if (!idPending && !signedInUserId) router.push('/login')
  }, [idPending, signedInUserId, router])

  // ── ONE PAGE OF THE ARCHIVE, AND ITS TOTAL, FROM THE DATABASE ──
  //
  // This page used to read every completed delegated task (paged through
  // fetchAllRows so PostgREST's 1000-row cap could not clip it) and filter in
  // the browser. It now asks for twenty rows plus an exact count with every
  // filter applied by the database, so the page, its total and the pager can
  // never disagree.
  const pageQuery = useCompletedTaskPage(SCOPE, userId, {
    counterpart: filterAssignee,
    priority:    filterPriority,
    q:           search,
    completedOn: state.completedOn,
  }, state.page)
  const { data: summary } = useCompletionSummary(SCOPE, userId)
  const counterparts = useCompletedCounterparts(SCOPE, userId)
  const { data: userMap = NO_NAMES } = useUserNames()

  const total     = pageQuery.data?.total ?? 0
  const pageTasks = pageQuery.data?.tasks ?? NO_TASKS
  // A FAILED READ IS NOT AN EMPTY ARCHIVE.
  const loadError = pageQuery.isError ? ARCHIVE_LOAD_ERROR : null

  // A page past the end lands on the last real page instead of an empty one.
  const lastPage = totalPages(total)
  const onStalePage = pageQuery.isSuccess && !pageQuery.isPlaceholderData && state.page > lastPage
  useEffect(() => {
    if (onStalePage) setState({ page: lastPage })
  }, [onStalePage, lastPage, setState])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleRestore = async (task: Task) => {
    const res = await fetch('/api/restore-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id }),
    })
    if (!res.ok) { console.error('[restore] failed:', await res.text()); window.alert('Failed to restore task. Please try again.'); return }
    // Gone from the list at once; the page, total and summary are then re-read.
    setRestoredIds(prev => new Set(prev).add(task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'completed', SCOPE, userId] })
    queryClient.invalidateQueries({ queryKey: ['task-report', 'completed', SCOPE, userId] })
    queryClient.invalidateQueries({ queryKey: ['task-report', 'completed-counterparts', SCOPE, userId] })
  }

  const assigneeOptions = useMemo(() => {
    return (counterparts.data ?? []).map(id => ({ value: id, label: userMap[id] ?? 'Unknown' }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [counterparts.data, userMap])

  // An assignee id in the URL that matches nobody in this archive falls back to
  // "All Assignees" instead of showing an empty list.
  const assigneeIds = useMemo(() => assigneeOptions.map(o => o.value), [assigneeOptions])
  usePruneUnknownValue(counterparts.isSuccess, filterAssignee, assigneeIds, () => setState({ assignee: '' }))

  const visibleTasks = useMemo(
    () => pageTasks.filter(t => !restoredIds.has(t.id)),
    [pageTasks, restoredIds],
  )

  const hasFilters = !!(filterAssignee || filterPriority || search.trim() || state.completedOn)

  const goToPage = (next: number) => {
    setState({ page: next })
    window.scrollTo({ top: 0 })
  }

  if (!userId || pageQuery.isPending) return <LoadingScreen />

  return (
    <>
      <DashboardLayout profile={profile} title="Assigned By Me" onSignOut={handleLogout}>

        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#4CAF7D' }}>
            {`Completed · ${total}`}
          </div>
          <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
            {hasFilters ? 'Delegated tasks matching the current filters' : 'Delegated tasks that have been completed'}
          </div>
        </div>

        {isMobile && <CompletionSummaryCard summary={summary} compact />}

        {/* Search + filter toolbar */}
        <div style={{
          background: colors.raised, border: `1.5px solid ${colors.border}`,
          borderRadius: '8px', padding: '8px 10px', marginBottom: '10px',
          display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
        }}>
          <Search size={13} color={colors.muted} style={{ flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Find tasks…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onBlur={flushSearch}
            style={{ flex: 1, minWidth: '140px', padding: '4px 6px', background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary }}
          />
          {assigneeOptions.length > 1 && (
            <select
              value={filterAssignee}
              onChange={e => setState({ assignee: e.target.value })}
              style={{ padding: '4px 10px', minWidth: '130px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '11.5px', color: filterAssignee ? colors.primary : colors.muted, cursor: 'pointer' }}
            >
              <option value="">All Assignees</option>
              {assigneeOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
          <select
            value={filterPriority}
            onChange={e => setState({ priority: e.target.value as typeof filterPriority })}
            style={{ padding: '4px 10px', minWidth: '110px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '11.5px', color: filterPriority ? colors.primary : colors.muted, cursor: 'pointer' }}
          >
            <option value="">All Priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <CompletedOnFilter value={state.completedOn} onChange={next => setState({ completedOn: next })} />
        </div>

        {/* Two-column: task list + summary and info */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* A FAILED READ, SAID OUT LOUD. Without this the screen shows its
                empty state — a statement about somebody's work — when the truth
                is that the request did not finish. Above the list, not instead of
                it, so a page that already loaded stays usable. */}
            {loadError && (
              <div
                role="alert"
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                  padding: '10px 14px', marginBottom: '10px', borderRadius: '8px',
                  background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '12px',
                }}
              >
                <span style={{ flex: 1, minWidth: '200px' }}>{loadError}</span>
              </div>
            )}
            {visibleTasks.length === 0 ? (
              <EmptyState />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {visibleTasks.map(task => (
                  <CompletedTaskCard
                    key={task.id}
                    task={task}
                    userMap={userMap}
                    onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                    onRestore={() => handleRestore(task)}
                    isMobile={isMobile}
                  />
                ))}
              </div>
            )}
            <CompletedPager page={state.page} total={total} onPage={goToPage} />
          </div>
          {!isMobile && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flexShrink: 0 }}>
              <CompletionSummaryCard summary={summary} />
              <InfoPanel />
            </div>
          )}
        </div>

      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          fullPageHref={taskDetailHref(selectedTask.id, returnTo)}
          currentUserId={userId}
        />
      )}
    </>
  )
}

// Reading the list state from the URL opts this tree into client-side
// rendering, which needs a Suspense boundary.
export default function AssignedByMeCompletedPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AssignedByMeCompletedContent />
    </Suspense>
  )
}
