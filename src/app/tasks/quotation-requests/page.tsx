'use client'

import { useEffect, useState, useMemo, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, TaskPriority } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useProfile } from '@/hooks/queries/useProfile'
import { useUserNames } from '@/hooks/queries/useMyTasks'
import { ExternalLink, Plus, Building2, User } from 'lucide-react'
import {
  DATE_FILTERS, PRIORITY_FILTERS,
  applyQuotationFilters, assignedByOptions, assignerName,
  filtersActive,
  type DateFilterKey, type QuotationFilters,
} from './filters'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveQuotationCapabilities } from '@/lib/permissions/quotations'
import { useListUrlState, useUrlSearchInput, usePruneUnknownValue } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { enumParam, idParam, optionParam, textParam } from '@/lib/listState'

const QTN_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type', 'task_type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'customer_name', 'contact_number', 'company_name', 'city_project',
].join(', ')

// Customer | Assigned By | Priority | Created Date | Notes | Action.
// One definition for the header and the rows so the two can never drift. The
// minimums are trimmed alongside the added Created Date column so the table's
// total minimum width — and therefore its mobile behaviour — is unchanged.
// Priority took the Status slot verbatim: both hold a single small badge.
const GRID_COLUMNS =
  'minmax(170px, 1.6fr) minmax(96px, 0.8fr) minmax(84px, 0.55fr) minmax(80px, 0.5fr) minmax(170px, 2fr) 40px'

// Compact listing control. `.boe-input` is `width: 100%` and form-sized, so
// each select overrides both: an explicit px width (never a percentage, which
// would make the band's layout depend on its own container) and `flexShrink: 0`
// so a select never compresses far enough to truncate its label. The search
// input is the only elastic control in the band — see `.boe-qtn-toolbar`.
const COMPACT_CONTROL: React.CSSProperties = {
  padding: '6px 8px', fontSize: '12px', flexShrink: 0, cursor: 'pointer',
}

// ─── URL-backed list state ────────────────────────────────────────────────────
// Tab, search and the three filters live in the query string so Back from a
// request detail returns to the same view. The filter model in ./filters.ts
// spells "no filter" as 'all'; the URL spells it as an absent param, and the two
// are mapped at the edges below.
const PRIORITY_KEYS = PRIORITY_FILTERS.map(p => p.key)
const DATE_KEYS     = DATE_FILTERS.map(d => d.key)

const LIST_PARAMS = {
  tab:        enumParam(['pending', 'closed'] as const, 'pending'),
  assignedBy: idParam(),
  priority:   optionParam(PRIORITY_KEYS),
  date:       enumParam(DATE_KEYS, 'all' as DateFilterKey),
  q:          textParam(),
}

function PriorityBadge({ priority }: { priority: string }) {
  const cfg = priority === 'high'
    ? { color: '#B45309', bg: '#FFFBEB' }
    : priority === 'low'
      ? { color: '#6B7280', bg: '#F3F4F6' }
      : { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600,
      color: cfg.color, background: cfg.bg,
      borderRadius: '4px', padding: '1px 6px',
      textTransform: 'capitalize', flexShrink: 0,
    }}>{priority}</span>
  )
}

function formatDate(d: string | null): string | null {
  if (!d) return null
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

function RequestCard({
  task, userMap, onClick, onView,
}: {
  task: Task
  userMap: Record<string, string>
  onClick: () => void
  onView: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [hoveredView, setHoveredView] = useState(false)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLUMNS,
        columnGap: '12px',
        alignItems: 'center',
        background: hovered ? colors.raised : colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '8px',
        minHeight: '52px',
        cursor: 'pointer',
        padding: '0 4px',
        transition: 'background 0.12s',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.07)' : '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {/* Customer */}
      <div style={{ minWidth: 0, padding: '10px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '2px' }}>
          <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', color: '#DC1F2E', background: 'rgba(220,31,46,0.08)', border: '1px solid rgba(220,31,46,0.18)', letterSpacing: '0.04em', flexShrink: 0 }}>QTN</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.customer_name ?? task.title}
          </span>
        </div>
        {task.company_name && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Building2 size={10} color={colors.muted} />
            <span style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {task.company_name}
            </span>
          </div>
        )}
      </div>

      {/* Assigned By — the person who raised the request. The icon stays as the
          only cue that this column holds a person now that the label is gone. */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <User size={10} color={colors.muted} />
          <span style={{ fontSize: '11px', color: colors.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {assignerName(task, userMap)}
          </span>
        </div>
      </div>

      {/* Priority — moved out of the customer cell into its own column, which
          replaced Status: a quotation request is effectively always `working`
          in this view, so the status badge carried no information. */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <PriorityBadge priority={task.priority} />
      </div>

      {/* Created Date — the request's own created_at, not last_update_at. */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <span style={{ fontSize: '11px', color: colors.secondary, whiteSpace: 'nowrap' }}>
          {formatDate(task.created_at) ?? '—'}
        </span>
      </div>

      {/* Notes */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <span style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
          {task.note?.trim() || '—'}
        </span>
      </div>

      {/* View button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <button
          onClick={e => { e.stopPropagation(); onView() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="Open full page"
          aria-label={`Open quotation request for ${task.customer_name ?? task.title}`}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: '6px',
            background: hoveredView ? 'rgba(155,111,212,0.10)' : 'transparent',
            border: `1px solid ${hoveredView ? 'rgba(155,111,212,0.30)' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredView ? '#DC1F2E' : colors.muted,
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  )
}

function QuotationRequestsContent() {
  const [loggedInId,   setLoggedInId]   = useState('')
  const [tasks,        setTasks]        = useState<Task[]>([])
  const [loading,      setLoading]      = useState(true)

  const { state, setState } = useListUrlState(LIST_PARAMS)
  const viewTab = state.tab
  const filters: QuotationFilters = useMemo(() => ({
    search:     state.q,
    assignedBy: state.assignedBy || 'all',
    priority:   state.priority   || 'all',
    dateRange:  state.date,
  }), [state])
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(state.q, next => setState({ q: next }))

  useListScrollRestore()

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const { data: profile = null } = useProfile(loggedInId)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setLoggedInId(session.user.id)

      // This whole screen is quotation-specific, so it is gated rather than
      // filtered. Someone without the permission is sent to their ordinary task
      // list — their assigned quotation tasks are still there, without the
      // customer's commercial details. Denied BEFORE the query runs, so a
      // direct URL never fetches a row it may not show.
      const { data: me } = await supabase
        .from('users').select('role').eq('id', session.user.id).single()
      const taskPerms = await getEffectivePermissions(supabase, session.user.id, 'task_management').catch(() => [])
      if (!deriveQuotationCapabilities(me?.role, taskPerms).canViewQuotations) {
        router.replace('/tasks/my')
        return
      }

      const { data } = await supabase
        .from('tasks')
        .select(QTN_COLUMNS)
        .eq('task_type', 'quotation_request')
        .or(`assigned_to.eq.${session.user.id},created_by.eq.${session.user.id}`)
        .order('created_at', { ascending: false })

      setTasks((data ?? []) as unknown as Task[])
      setLoading(false)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const allUserIds = useMemo(
    () => [...new Set(tasks.flatMap(t => [t.assigned_to, t.created_by]))],
    [tasks]
  )
  const { data: userMap = {} } = useUserNames(allUserIds)

  // Tab counts stay unfiltered — they describe the workload, not the current
  // search.
  const pendingCount = tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length
  const closedCount  = tasks.filter(t => t.status === 'completed').length

  // The selected tab's dataset. Filters apply to this and never across tabs.
  const tabTasks = useMemo(
    () => viewTab === 'closed'
      ? tasks.filter(t => t.status === 'completed')
      : tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled'),
    [tasks, viewTab],
  )

  const assignerOptions = useMemo(() => {
    const opts = assignedByOptions(tabTasks, userMap)
    // An assigner with rows in Pending may have none in Closed. Keep the current
    // selection listed so the select shows the name it is filtering on instead
    // of falling back to a blank value while the filter is still applied.
    if (filters.assignedBy !== 'all' && !opts.some(o => o.id === filters.assignedBy)) {
      opts.push({ id: filters.assignedBy, name: userMap[filters.assignedBy]?.trim() || 'Unknown' })
    }
    return opts
  }, [tabTasks, userMap, filters.assignedBy])

  // Validated against every request the user can see, not just this tab's — an
  // assigner with rows only in Closed is still a real selection while Pending is
  // open. Only an id matching nobody at all is dropped.
  const allAssignerIds = useMemo(
    () => [...new Set(tasks.map(t => t.created_by).filter(Boolean))],
    [tasks],
  )
  usePruneUnknownValue(
    !loading,
    state.assignedBy,
    allAssignerIds,
    () => setState({ assignedBy: '' }),
  )

  const anyFilterActive = filtersActive(filters)

  const visibleTasks = useMemo(() => {
    const filtered = applyQuotationFilters(tabTasks, filters)
    return [...filtered].sort((a, b) => {
      const aTime = new Date(a.last_update_at ?? a.created_at).getTime()
      const bTime = new Date(b.last_update_at ?? b.created_at).getTime()
      return bTime - aTime
    })
  }, [tabTasks, filters])

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Quotation Requests"
        subtitle="Customer quotation and inquiry requests"
        onSignOut={handleLogout}
        actions={
          <button
            onClick={() => router.push('/tasks/quotation-requests/new')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', borderRadius: '8px', border: 'none',
              background: '#DC1F2E', color: '#fff',
              fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              transition: 'opacity 0.12s', whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <Plus size={13} strokeWidth={2.5} />
            New Request
          </button>
        }
      >
        {/* ── Top section: tabs left, search + filters right ──
            Row and no-wrap from 1280px up, column below it. The rules live in
            globals.css (`.boe-qtn-toolbar`) because the breakpoint cannot be
            expressed in an inline style, and this project has no Tailwind
            responsive utilities in use — named class + @media is its convention
            (cf. `.product-toolbar-grid`). */}
        <div className="boe-qtn-toolbar">
          {/* Prominent Pending / Closed toggle */}
          <div className="boe-qtn-toolbar-tabs" style={{ display: 'flex', gap: '0', borderRadius: '10px', overflow: 'hidden', border: '1.5px solid #E5E7EB', width: 'fit-content', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            {([
              { key: 'pending', label: 'Pending Quotations', count: pendingCount },
              { key: 'closed',  label: 'Closed Quotations',  count: closedCount  },
            ] as const).map((tab, i) => {
              const active = viewTab === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setState({ tab: tab.key })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '7px',
                    padding: '8px 14px',
                    background: active ? '#DC1F2E' : '#F9FAFB',
                    color: active ? '#fff' : '#374151',
                    fontSize: '12.5px', fontWeight: 700,
                    border: 'none',
                    borderLeft: i > 0 ? '1.5px solid #E5E7EB' : 'none',
                    cursor: 'pointer', transition: 'all 0.15s',
                    fontFamily: 'inherit', whiteSpace: 'nowrap',
                  }}
                >
                  {tab.label}
                  <span style={{
                    fontSize: '11px', fontWeight: 700,
                    padding: '1px 6px', borderRadius: '20px',
                    background: active ? 'rgba(255,255,255,0.22)' : '#E5E7EB',
                    color: active ? '#fff' : '#6B7280',
                  }}>
                    {tab.count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Search + filters. Form controls only — the toggle to the left stays
              the tab navigation. */}
          <div className="boe-qtn-toolbar-controls">
            {/* The band's only elastic control: it takes the leftover width on a
                wide screen and gives it back first when the row is tight, so the
                selects beside it are never pushed onto a second line. */}
            <input
              className="boe-input"
              type="search"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onBlur={flushSearch}
              placeholder="Search customer or quotation…"
              aria-label="Search quotation requests by customer, title or notes"
              style={{ flex: '0 1 275px', width: '275px', minWidth: '118px', padding: '6px 9px', fontSize: '12px' }}
            />

            <select
              className="boe-input"
              aria-label="Filter by who assigned the request"
              value={filters.assignedBy}
              onChange={e => setState({ assignedBy: e.target.value === 'all' ? '' : e.target.value })}
              style={{ ...COMPACT_CONTROL, width: '140px' }}
            >
              {/* Short neutral label so a long full name still fits the 140px. */}
              <option value="all">Anyone</option>
              {assignerOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>

            <select
              className="boe-input"
              aria-label="Filter by priority"
              value={filters.priority}
              onChange={e => {
                const next = e.target.value as TaskPriority | 'all'
                setState({ priority: next === 'all' ? '' : next })
              }}
              style={{ ...COMPACT_CONTROL, width: '130px' }}
            >
              <option value="all">Any priority</option>
              {PRIORITY_FILTERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>

            <select
              className="boe-input"
              aria-label="Filter by created date"
              value={filters.dateRange}
              onChange={e => setState({ date: e.target.value as DateFilterKey })}
              style={{ ...COMPACT_CONTROL, width: '130px' }}
            >
              {DATE_FILTERS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>

            {/* Appearing only when something is applied is itself the signal, and
                the label says so in words rather than by colour alone. No result
                count beside it: it would crowd the row for no extra information
                the empty state and the controls do not already carry. */}
            {anyFilterActive && (
              <button
                // Filters only — the selected tab is navigation, not a filter.
                // The input is cleared alongside the URL so a keystroke still
                // inside the debounce window cannot re-apply itself afterwards.
                onClick={() => {
                  setSearchInput('')
                  setState({ q: '', assignedBy: '', priority: '', date: 'all' })
                }}
                title="Reset search and filters"
                aria-label="Reset search and filters"
                style={{
                  padding: '6px 9px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', border: `1px solid ${colors.border}`,
                  background: 'transparent', color: colors.muted,
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: '12px', overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: GRID_COLUMNS,
            columnGap: '12px',
            padding: '8px 4px',
            background: 'rgba(248,250,252,0.9)',
            borderBottom: `1px solid ${colors.border}`,
            fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em', color: colors.muted,
          }}>
            <div style={{ paddingLeft: '6px' }}>Customer</div>
            <div style={{ paddingLeft: '4px' }}>Assigned By</div>
            <div style={{ paddingLeft: '4px' }}>Priority</div>
            <div style={{ paddingLeft: '4px' }}>Created Date</div>
            <div style={{ paddingLeft: '4px' }}>Notes</div>
            <div />
          </div>

          {/* Rows */}
          {visibleTasks.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center' }}>
              {anyFilterActive ? (
                <>
                  <p style={{ fontSize: '13px', color: colors.secondary, fontWeight: 500 }}>No requests match these filters</p>
                  <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
                    Reset the filters to see all {tabTasks.length} request{tabTasks.length === 1 ? '' : 's'} in this tab.
                  </p>
                </>
              ) : (
                <>
                  <p style={{ fontSize: '13px', color: colors.secondary, fontWeight: 500 }}>No quotation requests yet</p>
                  <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
                    Use the New Request button to submit a quotation request.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {visibleTasks.map(task => (
                <RequestCard
                  key={task.id}
                  task={task}
                  userMap={userMap}
                  onClick={() => router.push(`/tasks/${task.id}`)}
                  onView={() => router.push(`/tasks/${task.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </DashboardLayout>

    </>
  )
}

// Reading the list state from the URL opts this tree into client-side
// rendering, which needs a Suspense boundary.
export default function QuotationRequestsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <QuotationRequestsContent />
    </Suspense>
  )
}
