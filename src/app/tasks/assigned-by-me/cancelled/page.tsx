'use client'

import React, { useEffect, useState, useMemo, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import {
  ArchiveHeading, ArchiveNote, ArchiveToolbar, ArchiveSelect, ArchiveList, ArchiveEmpty,
  type ArchivePerson,
} from '@/components/tasks/CancelledArchive'
import { useViewAs } from '@/hooks/useViewAs'
import { useListUrlState, useUrlSearchInput, usePruneUnknownValue } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { useCurrentReturnPath } from '@/hooks/useCurrentReturnPath'
import { taskDetailHref } from '@/lib/tasks/taskReturnPath'
import { idParam, optionParam, textParam } from '@/lib/listState'
import { fetchAllRows } from '@/lib/supabasePaging'

/**
 * What the screen says when the archive could not be read in full.
 *
 * Deliberately not an empty list: an empty archive is a statement about
 * somebody's work, and a failed or truncated read is a statement about the
 * request. The two must never look the same.
 */
const ARCHIVE_LOAD_ERROR =
  'This list could not be loaded in full. Check your connection and try again.'


const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'cancelled_by', 'cancelled_at', 'cancellation_reason',
].join(', ')

// ─── URL-backed list state ────────────────────────────────────────────────────
// Search and both filters live in the query string so Back from a task detail
// returns to the same filtered list.
const PRIORITY_KEYS = ['high', 'medium', 'low'] as const

const LIST_PARAMS = {
  assignee: idParam(),
  priority: optionParam(PRIORITY_KEYS),
  q:        textParam(),
}

// ─── Who the task is tied to ──────────────────────────────────────────────────
const personFor = (userMap: Record<string, string>) => (task: Task): ArchivePerson => {
  const name = userMap[task.assigned_to ?? ''] ?? 'member'
  return { label: name, tone: 'assignee', title: `Assigned to ${name}` }
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function AssignedByMeCancelledContent() {
  const { viewAsUserId } = useViewAs()
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [allTasks,     setAllTasks]     = useState<Task[]>([])
  const [loadError,    setLoadError]    = useState<string | null>(null)
  const [userId,       setUserId]       = useState<string>('')
  const [userMap,      setUserMap]      = useState<Record<string, string>>({})
  const [loading,      setLoading]      = useState(true)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [isMobile,     setIsMobile]     = useState(false)

  const { state, setState } = useListUrlState(LIST_PARAMS)
  const filterAssignee = state.assignee
  const filterPriority = state.priority
  const search         = state.q
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(search, next => setState({ q: next }))

  useListScrollRestore()
  // This exact view, handed to Task Detail so Submit for Approval returns here.
  const returnTo = useCurrentReturnPath()

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
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const loggedInId = session.user.id
      const uid = viewAsUserId ?? loggedInId
      setUserId(uid)

      // THE ARCHIVE IS PAGED, BECAUSE POSTGREST TRUNCATES SILENTLY. A plain
      // .select() is capped at 1000 rows with no error and no warning — see
      // src/lib/supabasePaging.ts. An archive of finished work only ever grows
      // and reads newest-first, so past 1000 the OLDEST records quietly stop
      // appearing: exactly the ones somebody opens this page to find.
      //
      // fetchAllRows pages it and REPORTS truncation instead of under-reporting.
      // The whole set stays in memory, so this page's search and filters work
      // exactly as before — which is why this and not server-side paging:
      // narrowing one page in the browser would hide every match beyond it.
      //
      // The secondary sort on `id` is required, not cosmetic: range() maps to
      // LIMIT/OFFSET, which promises nothing about row order unless the ordering
      // is unique, so two rows sharing a timestamp could swap between pages —
      // showing one twice and losing the other.
      const [{ data: profileData }, taskResult, { data: userData }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, is_active, created_at').eq('id', uid).single(),
        fetchAllRows<Task>((from, to) => supabase.from('tasks').select(TASK_COLUMNS)
          .eq('created_by', uid)
          .not('assigned_to', 'is', null)
          .neq('assigned_to', uid)
          .eq('status', 'cancelled')
          .order('cancelled_at', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false })
          .range(from, to)),
        supabase.from('users').select('id, full_name'),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      // A FAILED OR TRUNCATED READ IS NOT AN EMPTY ARCHIVE.
      setLoadError(taskResult.ok && !taskResult.truncated ? null : ARCHIVE_LOAD_ERROR)
      setAllTasks(taskResult.ok ? (taskResult.rows as unknown as Task[]) : [])
      if (userData) {
        const map: Record<string, string> = {}
        for (const u of userData) map[u.id] = u.full_name
        setUserMap(map)
      }
      setLoading(false)
    }
    init()
  }, [viewAsUserId, router, supabase])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const assigneeOptions = useMemo(() => {
    const ids = [...new Set(allTasks.map(t => t.assigned_to).filter(Boolean))]
    return (ids as string[]).map(id => ({ value: id, label: userMap[id] ?? 'Unknown' }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [allTasks, userMap])

  // An assignee id in the URL that matches nobody in this list falls back to
  // "All Assignees" instead of showing an empty list.
  const assigneeIds = useMemo(() => assigneeOptions.map(o => o.value), [assigneeOptions])
  usePruneUnknownValue(!loading, filterAssignee, assigneeIds, () => setState({ assignee: '' }))

  const visibleTasks = useMemo(() => {
    let tasks = allTasks
    if (filterAssignee) tasks = tasks.filter(t => t.assigned_to === filterAssignee)
    if (filterPriority) tasks = tasks.filter(t => t.priority === filterPriority)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.cancellation_reason ?? '').toLowerCase().includes(q)
      )
    }
    return tasks
  }, [allTasks, filterAssignee, filterPriority, search])

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout profile={profile} title="Assigned By Me" onSignOut={handleLogout}>

        <ArchiveHeading
          title="Cancelled tasks"
          subtitle={`${allTasks.length} delegated task${allTasks.length !== 1 ? 's' : ''} cancelled. Newest first.`}
        />

        <ArchiveNote>
          <strong style={{ fontWeight: 600, color: colors.primary }}>These are tasks you delegated that were cancelled before completion.</strong>{' '}
          Open one to restore it to active work.
        </ArchiveNote>

        <ArchiveToolbar searchInput={searchInput} onSearch={setSearchInput} onSearchBlur={flushSearch}>
          {assigneeOptions.length > 1 && (
            <ArchiveSelect value={filterAssignee} label="Assigned to" onChange={v => setState({ assignee: v })}>
              <option value="">All assignees</option>
              {assigneeOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </ArchiveSelect>
          )}
          <ArchiveSelect value={filterPriority} label="Priority" onChange={v => setState({ priority: v as typeof filterPriority })}>
            <option value="">All priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </ArchiveSelect>
        </ArchiveToolbar>

        {/* A FAILED OR TRUNCATED READ, SAID OUT LOUD. Without this the
            screen shows its empty state — a statement about somebody's work
            — when the truth is that the request did not finish. Above the
            list, not instead of it, so whatever loaded stays usable. */}
        {loadError && (
          <div
            role="alert"
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              padding: '10px 14px', marginBottom: '10px', borderRadius: '8px',
              background: 'rgba(180,35,50,0.08)', color: '#B42332', fontSize: '12px',
            }}
          >
            <span style={{ flex: 1, minWidth: '200px' }}>{loadError}</span>
          </div>
        )}
        {visibleTasks.length === 0 ? (
          <ArchiveEmpty title="No cancelled delegated tasks" hint="Cancelled tasks you assigned will appear here." />
        ) : (
          <ArchiveList
            tasks={visibleTasks}
            selectedId={selectedTask?.id ?? null}
            personHeader="Assigned to"
            personFor={personFor(userMap)}
            isMobile={isMobile}
            onOpen={task => setSelectedTask(prev => prev?.id === task.id ? null : task)}
          />
        )}

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
export default function AssignedByMeCancelledPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AssignedByMeCancelledContent />
    </Suspense>
  )
}
