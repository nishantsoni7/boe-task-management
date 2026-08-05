'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, CheckCircle2, FileEdit, Layers, Plus } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type StatusTab } from '@/components/ui/StatusTabs'
import { Toast, useToast } from '@/components/ui/toast'
import { colors } from '@/lib/tokens'
import { MeetingsLayout } from '@/components/layout/MeetingsLayout'
import { MeetingBadge } from '@/components/meetings/MeetingModal'
import { MeetingFormModal } from '@/components/meetings/MeetingFormModal'
import { useMeetings } from '@/hooks/useMeetings'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumParam, optionParam, textParam } from '@/lib/listState'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  MEETING_COLUMNS, MEETING_STATUS_META, MEETING_TYPES, MEETING_TYPE_META,
  formatMeetingDate, type Meeting, type MeetingStatus, type MeetingType,
} from '@/lib/meetings/types'

// The two list screens — Active & Upcoming, and Completed — are one component.
// They ask the same question of the same table and differ only in which
// statuses they show and whether a meeting can be started from them; two files
// would have drifted on the toolbar within a month.

type Scope = 'active' | 'completed'

const ACTIVE_TABS = ['all', 'draft', 'in_progress'] as const
type ActiveTab = typeof ACTIVE_TABS[number]

// Module scope: useListUrlState needs a stable codec-map identity across
// renders. Both screens keep filters in the URL so Back from a meeting returns
// to the list exactly as it was left — the same contract the task lists use.
const ACTIVE_PARAMS = {
  tab:  enumParam(ACTIVE_TABS, 'all'),
  type: optionParam(MEETING_TYPES),
  q:    textParam(),
}

const COMPLETED_PARAMS = {
  type: optionParam(MEETING_TYPES),
  q:    textParam(),
}

/** Counts rolled up per meeting, for the list's "3 orders · 11 SKUs" column. */
type MeetingCounts = { orders: number; items: number; openItems: number }

/**
 * Order numbers per meeting, so "2041" finds the review it was discussed in.
 *
 * Free, because the roll-up query already reads every order row for the listed
 * meetings — it only had to select one more column. Without it, searching this
 * screen for an order number returns nothing, which is the first thing anyone
 * tries.
 */
type MeetingOrderNumbers = Record<string, string[]>

/** A meetings row as it comes back, with the two joined names still nested. */
type MeetingRow = Meeting & {
  lead?: { full_name: string } | null
  creator?: { full_name: string } | null
}

const COMPACT_CONTROL: React.CSSProperties = {
  width: 'auto', minWidth: '132px', maxWidth: '180px',
  padding: '6px 8px', fontSize: '12px', flexShrink: 0, cursor: 'pointer',
}

export function MeetingsListScreen({ scope }: { scope: Scope }) {
  const { supabase, profile, caps, loading: authLoading, signOut } = useMeetings()
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [counts, setCounts]     = useState<Record<string, MeetingCounts>>({})
  const [orderNumbers, setOrderNumbers] = useState<MeetingOrderNumbers>({})
  const [listLoading, setListLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  const params = scope === 'active' ? ACTIVE_PARAMS : COMPLETED_PARAMS
  // The codec maps have different shapes; the screen only ever reads the keys
  // its own scope declares, so a single loose read here is simpler than
  // threading a generic through the whole component.
  const { state, setState, resetState } = useListUrlState(params as typeof ACTIVE_PARAMS)
  const tab  = scope === 'active' ? (state.tab as ActiveTab) : 'all'
  const type = state.type as MeetingType | ''
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(
    state.q, next => setState({ q: next }),
  )

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Reads before it writes: the first thing this does is await the query, so
  // the mount effect below can call it without setting state synchronously.
  // `refresh` is the wrapper that shows the spinner, for Retry.
  const load = useCallback(async () => {
    const statuses: MeetingStatus[] = scope === 'active' ? ['draft', 'in_progress'] : ['completed']

    // Paged, not a plain select. PostgREST caps a response at 1000 rows
    // SILENTLY — no error, no warning, a plausible-looking array (see
    // src/lib/supabasePaging.ts). Completed meetings accumulate forever, so
    // this list is exactly the shape that quietly starts hiding rows a year
    // from now. Paging keys on `id` because range() needs a deterministic
    // unique order; the business ordering is applied below, in JS.
    const result = await fetchAllRows<MeetingRow>((from, to) =>
      supabase
        .from('meetings')
        .select(`${MEETING_COLUMNS}, lead:users!lead_id(full_name), creator:users!created_by(full_name)`)
        .in('status', statuses)
        .order('id', { ascending: true })
        .range(from, to),
    )

    if (!result.ok || result.truncated) {
      console.error('[meetings:list] load failed', result)
      setLoadError('Could not load meetings. Check your connection and try again.')
      setListLoading(false)
      return
    }
    setLoadError(null)

    // Upcoming first on the active list — a lead opens this screen to start
    // today's review, not to read last month's. Completed reads newest first.
    const rows = [...result.rows].sort((a, b) =>
      b.meeting_date.localeCompare(a.meeting_date)
      || b.created_at.localeCompare(a.created_at),
    )

    // Lift the joined names onto the row and drop the join objects, so what
    // reaches state is exactly the `Meeting` shape.
    const mapped: Meeting[] = rows.map(({ lead, creator, ...m }) => ({
      ...m,
      lead_name: lead?.full_name ?? null,
      created_by_name: creator?.full_name ?? null,
    }))
    setMeetings(mapped)

    // Roll-up counts. Two small reads rather than a nested select, because a
    // nested select of items-through-orders would return the whole tree just to
    // count it.
    const ids = mapped.map(m => m.id)
    if (ids.length === 0) {
      setCounts({})
      setOrderNumbers({})
      setListLoading(false)
      return
    }

    // Paged for the same reason: one order row per order per meeting adds up
    // far faster than the meetings themselves do.
    const orderResult = await fetchAllRows<{ id: string; meeting_id: string; order_number: string }>(
      (from, to) => supabase
        .from('meeting_orders')
        .select('id, meeting_id, order_number')
        .in('meeting_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    const orderRows = orderResult.ok && !orderResult.truncated ? orderResult.rows : []

    const orderToMeeting = new Map<string, string>()
    const next: Record<string, MeetingCounts> = {}
    const numbers: MeetingOrderNumbers = {}
    for (const id of ids) { next[id] = { orders: 0, items: 0, openItems: 0 }; numbers[id] = [] }
    for (const o of orderRows) {
      orderToMeeting.set(o.id, o.meeting_id)
      if (next[o.meeting_id]) next[o.meeting_id].orders += 1
      numbers[o.meeting_id]?.push(o.order_number)
    }
    setOrderNumbers(numbers)

    if (orderToMeeting.size > 0) {
      const itemResult = await fetchAllRows<{ meeting_order_id: string; status: string }>(
        (from, to) => supabase
          .from('meeting_order_items')
          .select('id, meeting_order_id, status')
          .in('meeting_order_id', [...orderToMeeting.keys()])
          .order('id', { ascending: true })
          .range(from, to),
      )
      const itemRows = itemResult.ok && !itemResult.truncated ? itemResult.rows : []

      for (const it of itemRows) {
        const meetingId = orderToMeeting.get(it.meeting_order_id)
        if (!meetingId || !next[meetingId]) continue
        next[meetingId].items += 1
        if (it.status !== 'resolved') next[meetingId].openItems += 1
      }
    }

    setCounts(next)
    setListLoading(false)
  }, [supabase, scope])

  const refresh = useCallback(async () => {
    setListLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    if (authLoading) return
    // Called through a local function rather than directly, matching the
    // convention in src/app/assets-access/[id]/page.tsx: the effect schedules
    // the read, it does not itself set state.
    const run = () => { void load() }
    run()
  }, [authLoading, load])

  // Everything except the status tab, so each tab can show the count it would
  // actually produce under the filters already applied.
  const baseFiltered = useMemo(() => {
    const q = state.q.trim().toLowerCase()
    return meetings.filter(m => {
      if (type && m.meeting_type !== type) return false
      if (q) {
        const haystack = [
          m.title, m.lead_name ?? '', m.note ?? '',
          // Order numbers included so "2041" finds the review it was discussed
          // in — the first search anyone tries on this screen.
          ...(orderNumbers[m.id] ?? []),
        ].join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [meetings, type, state.q, orderNumbers])

  const tabCounts = useMemo(() => ({
    all: baseFiltered.length,
    draft: baseFiltered.filter(m => m.status === 'draft').length,
    in_progress: baseFiltered.filter(m => m.status === 'in_progress').length,
  }), [baseFiltered])

  const visible = useMemo(
    () => (tab === 'all' ? baseFiltered : baseFiltered.filter(m => m.status === tab)),
    [baseFiltered, tab],
  )

  const filtersActive = !!type || state.q.trim() !== '' || (scope === 'active' && tab !== 'all')

  const tabs: StatusTab<ActiveTab>[] = [
    { key: 'all',         label: 'All',         Icon: Layers,        accent: BRAND_TAB_ACCENT,                          count: tabCounts.all },
    { key: 'in_progress', label: 'In Progress', Icon: CalendarClock, accent: accentFromBadge(MEETING_STATUS_META.in_progress), count: tabCounts.in_progress },
    { key: 'draft',       label: 'Draft',       Icon: FileEdit,      accent: accentFromBadge(MEETING_STATUS_META.draft),       count: tabCounts.draft },
  ]

  if (authLoading) return <LoadingScreen />

  const title = scope === 'active' ? 'Active & Upcoming' : 'Completed Meetings'
  const subtitle = scope === 'active'
    ? 'Order review meetings you can start or continue.'
    : 'Past reviews, kept as a permanent record.'

  return (
    <MeetingsLayout
      profile={profile}
      title={title}
      subtitle={subtitle}
      onSignOut={signOut}
      actions={scope === 'active' && caps.canCreateMeeting ? (
        <button
          onClick={() => setCreateOpen(true)}
          className="boe-btn boe-btn-primary"
          style={{ padding: '7px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <Plus size={14} strokeWidth={2.2} />
          New Meeting
        </button>
      ) : undefined}
    >
      {/* Toolbar — form controls only. Status navigation belongs to the table
          card below, so the two never read as the same kind of control. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <input
          className="boe-input"
          aria-label="Search meetings"
          placeholder="Search meeting, lead or order number…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onBlur={flushSearch}
          style={{ flex: 1, minWidth: '180px', maxWidth: '320px', padding: '6px 10px', fontSize: '12px' }}
        />
        <select
          className="boe-input"
          aria-label="Filter by meeting type"
          value={type}
          onChange={e => setState({ type: e.target.value as MeetingType | '' })}
          style={COMPACT_CONTROL}
        >
          <option value="">All meeting types</option>
          {MEETING_TYPES.map(t => (
            <option key={t} value={t}>{MEETING_TYPE_META[t].label}</option>
          ))}
        </select>
        {filtersActive && (
          <button
            onClick={() => { setSearchInput(''); resetState() }}
            style={{
              padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              cursor: 'pointer', border: `1px solid ${colors.border}`,
              background: 'transparent', color: colors.muted, whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {loadError && (
        <div role="alert" style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '10px',
          background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
          fontSize: '13px', color: colors.red,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
        }}>
          <span>{loadError}</span>
          <button onClick={refresh} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
            Retry
          </button>
        </div>
      )}

      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', overflow: 'hidden',
      }}>
        {scope === 'active' && (
          <StatusTabs
            tabs={tabs}
            active={tab}
            onSelect={key => setState({ tab: key })}
            summary={listLoading
              ? 'Loading…'
              : filtersActive
                ? `${visible.length} of ${meetings.length} visible`
                : `${visible.length} meeting${visible.length !== 1 ? 's' : ''}`}
          />
        )}

        {listLoading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <EmptyMeetings
            scope={scope}
            filtersActive={filtersActive}
            canCreate={caps.canCreateMeeting}
            onClear={() => { setSearchInput(''); resetState() }}
            onCreate={() => setCreateOpen(true)}
          />
        ) : isMobile ? (
          <div style={{ padding: '10px' }}>
            {visible.map(m => (
              <MeetingCard key={m.id} meeting={m} counts={counts[m.id]} onOpen={() => router.push(`/meetings/${m.id}`)} />
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Meeting', 'Type', 'Date', 'Lead', 'Under Review', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(m => {
                  const c = counts[m.id]
                  return (
                    <tr
                      key={m.id}
                      onClick={() => router.push(`/meetings/${m.id}`)}
                      style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer', transition: 'background 0.1s' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                    >
                      <td style={{ padding: '11px 16px', fontWeight: 600, color: colors.primary, maxWidth: '320px' }}>
                        {m.title}
                      </td>
                      <td style={{ padding: '11px 16px' }}>
                        <MeetingBadge meta={MEETING_TYPE_META[m.meeting_type]} />
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {formatMeetingDate(m.meeting_date)}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {m.lead_name ?? '—'}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        <ReviewSummary counts={c} />
                      </td>
                      <td style={{ padding: '11px 16px' }}>
                        <MeetingBadge meta={MEETING_STATUS_META[m.status]} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {createOpen && profile && (
        <MeetingFormModal
          supabase={supabase}
          profile={profile}
          onClose={() => setCreateOpen(false)}
          onSaved={(id) => {
            setCreateOpen(false)
            show('Meeting created')
            router.push(`/meetings/${id}`)
          }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </MeetingsLayout>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function ReviewSummary({ counts }: { counts: MeetingCounts | undefined }) {
  if (!counts || counts.orders === 0) {
    return <span style={{ color: colors.muted }}>Nothing added yet</span>
  }
  return (
    <span>
      {counts.orders} order{counts.orders !== 1 ? 's' : ''} · {counts.items} SKU{counts.items !== 1 ? 's' : ''}
      {counts.openItems > 0 && (
        <span style={{ color: colors.amber, fontWeight: 600 }}> · {counts.openItems} open</span>
      )}
    </span>
  )
}

function MeetingCard({
  meeting, counts, onOpen,
}: { meeting: Meeting; counts: MeetingCounts | undefined; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      style={{
        width: '100%', textAlign: 'left', display: 'block',
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', padding: '12px 14px', marginBottom: '8px', cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, lineHeight: 1.3 }}>
          {meeting.title}
        </div>
        <MeetingBadge meta={MEETING_STATUS_META[meeting.status]} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
        <MeetingBadge meta={MEETING_TYPE_META[meeting.meeting_type]} />
        <span style={{ fontSize: '12px', color: colors.secondary }}>{formatMeetingDate(meeting.meeting_date)}</span>
        {meeting.lead_name && (
          <span style={{ fontSize: '12px', color: colors.muted }}>· {meeting.lead_name}</span>
        )}
      </div>
      <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '6px' }}>
        <ReviewSummary counts={counts} />
      </div>
    </button>
  )
}

function EmptyMeetings({
  scope, filtersActive, canCreate, onClear, onCreate,
}: {
  scope: Scope
  filtersActive: boolean
  canCreate: boolean
  onClear: () => void
  onCreate: () => void
}) {
  if (filtersActive) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: colors.muted }}>No meetings match the current filters.</p>
        <button
          onClick={onClear}
          className="boe-btn boe-btn-ghost"
          style={{ marginTop: '10px', padding: '6px 14px', fontSize: '12px' }}
        >
          Clear filters
        </button>
      </div>
    )
  }

  if (scope === 'completed') {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center' }}>
        <CheckCircle2 size={28} strokeWidth={1.4} color={colors.muted} />
        <p style={{ fontSize: '13px', color: colors.secondary, marginTop: '10px', fontWeight: 600 }}>
          No completed meetings yet
        </p>
        <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
          A review appears here once it has been completed. Completed meetings stay read-only.
        </p>
      </div>
    )
  }

  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <CalendarClock size={28} strokeWidth={1.4} color={colors.muted} />
      <p style={{ fontSize: '13px', color: colors.secondary, marginTop: '10px', fontWeight: 600 }}>
        No active meetings
      </p>
      <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', maxWidth: '380px', margin: '4px auto 0' }}>
        {canCreate
          ? 'Schedule a New Order or Repair Order review, add the orders being discussed, and record updates SKU by SKU.'
          : 'You will see reviews here once you are added as an attendee.'}
      </p>
      {canCreate && (
        <button
          onClick={onCreate}
          className="boe-btn boe-btn-primary"
          style={{ marginTop: '14px', padding: '8px 18px', fontSize: '13px' }}
        >
          New Meeting
        </button>
      )}
    </div>
  )
}
