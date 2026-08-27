'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Layers, MessageSquareHeart, Plus, Send, ShieldCheck } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type StatusTab } from '@/components/ui/StatusTabs'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ReviewBadge, MaskedNumber } from '@/components/customerReviews/ReviewPieces'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumParam, textParam } from '@/lib/listState'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  CUSTOMER_REVIEW_LIST_COLUMNS,
  CUSTOMER_REVIEW_STATUS_META,
  formatReviewDate,
  interactionTypeLabel,
  type CustomerReviewRequest,
  type CustomerReviewStatus,
} from '@/lib/customerReviews/types'

// The request list.
//
// It answers ONE question — "what outreach is in flight, and what needs me" —
// and it is deliberately not a dashboard. There are no counters of reviews
// won, no per-employee totals, no ratings and no charts: a screen that scored
// employees on how many reviews they collected would be an incentive to collect
// them by the wrong means, which is the failure this whole module is shaped to
// avoid. The only numbers here are how many rows each tab holds.
//
// WHAT A ROW SHOWS, AND WHAT IT DOES NOT
// The number is masked (maskWhatsAppNumber keeps four digits). There is no
// reveal control on a list, because a list is what gets screenshotted and
// shared; the full number is one click away on the detail screen for whoever
// actually needs to dial it.

const TABS = ['all', 'preparing', 'awaiting_reply', 'to_verify', 'finished'] as const
type TabKey = typeof TABS[number]

// Module scope: useListUrlState needs a stable codec-map identity across
// renders. Filters live in the URL so Back from a request returns to the list
// exactly as it was — the same contract the task and meeting lists have.
const LIST_PARAMS = {
  tab: enumParam(TABS, 'all'),
  q:   textParam(),
}

/**
 * Which statuses each tab holds.
 *
 * Grouped by what the employee has to DO next rather than by status name, which
 * is why there are five tabs for seven statuses: 'draft' and 'ready_to_send'
 * are both "still mine to finish", and 'closed' and 'cancelled' are both "over".
 */
const TAB_STATUSES: Record<Exclude<TabKey, 'all'>, readonly CustomerReviewStatus[]> = {
  preparing:      ['draft', 'ready_to_send'],
  awaiting_reply: ['sent'],
  to_verify:      ['customer_responded', 'sent'],
  finished:       ['verified', 'closed', 'cancelled'],
}

type Row = CustomerReviewRequest & { owner?: { full_name: string } | null }

export function CustomerReviewListScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()

  const [requests, setRequests]   = useState<CustomerReviewRequest[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isMobile, setIsMobile]   = useState(false)

  const { state, setState, resetState } = useListUrlState(LIST_PARAMS)
  const tab = state.tab as TabKey
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(
    state.q, next => setState({ q: next }),
  )

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const load = useCallback(async () => {
    // Paged, not a plain select. PostgREST caps a response at 1000 rows
    // SILENTLY (see src/lib/supabasePaging.ts), and this list accumulates
    // forever — it is exactly the shape that quietly starts hiding rows a year
    // from now. Paging keys on `id` because range() needs a deterministic
    // unique order; the business ordering is applied below, in JS.
    //
    // RLS is what decides WHICH rows come back: a `use` holder sees their own,
    // a verifier and an admin see all. The query asks for no filter of its own,
    // so the screen cannot disagree with the database about visibility.
    const result = await fetchAllRows<Row>((from, to) =>
      supabase
        .from('customer_review_requests')
        .select(`${CUSTOMER_REVIEW_LIST_COLUMNS}, owner:users!created_by(full_name)`)
        .order('id', { ascending: true })
        .range(from, to),
    )

    if (!result.ok || result.truncated) {
      // The row shape is never logged: these rows carry a customer's phone
      // number, and a console line is a place private data escapes to.
      console.error('[customer-reviews:list] load failed')
      setLoadError('Could not load review requests. Check your connection and try again.')
      setListLoading(false)
      return
    }
    setLoadError(null)

    const mapped: CustomerReviewRequest[] = [...result.rows]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ owner, ...r }) => ({ ...r, owner_name: owner?.full_name ?? null }))

    setRequests(mapped)
    setListLoading(false)
  }, [supabase])

  const refresh = useCallback(async () => {
    setListLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    if (authLoading) return
    const run = () => { void load() }
    run()
  }, [authLoading, load])

  // Everything except the tab, so each tab can show the count it would actually
  // produce under the search already applied.
  const baseFiltered = useMemo(() => {
    const q = state.q.trim().toLowerCase()
    if (!q) return requests
    return requests.filter(r => {
      const haystack = [
        r.customer_name,
        interactionTypeLabel(r.interaction_type),
        r.owner_name ?? '',
      ].join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [requests, state.q])

  const inTab = useCallback((r: CustomerReviewRequest, key: TabKey): boolean => {
    if (key === 'all') return true
    // "To verify" is the verifier's queue and it means something specific: a
    // request that has actually left BOE and has not been checked yet. A draft
    // is not waiting for a verifier, and a verified one is done.
    if (key === 'to_verify') return r.verified_at === null && TAB_STATUSES.to_verify.includes(r.status)
    return TAB_STATUSES[key].includes(r.status)
  }, [])

  const tabCounts = useMemo(() => ({
    all:            baseFiltered.length,
    preparing:      baseFiltered.filter(r => inTab(r, 'preparing')).length,
    awaiting_reply: baseFiltered.filter(r => inTab(r, 'awaiting_reply')).length,
    to_verify:      baseFiltered.filter(r => inTab(r, 'to_verify')).length,
    finished:       baseFiltered.filter(r => inTab(r, 'finished')).length,
  }), [baseFiltered, inTab])

  const visible = useMemo(
    () => baseFiltered.filter(r => inTab(r, tab)),
    [baseFiltered, tab, inTab],
  )

  const filtersActive = state.q.trim() !== '' || tab !== 'all'

  const tabs: StatusTab<TabKey>[] = [
    { key: 'all',            label: 'All',        Icon: Layers,             accent: BRAND_TAB_ACCENT,                                        count: tabCounts.all },
    { key: 'preparing',      label: 'Preparing',  Icon: MessageSquareHeart, accent: accentFromBadge(CUSTOMER_REVIEW_STATUS_META.draft),      count: tabCounts.preparing },
    { key: 'awaiting_reply', label: 'Sent',       Icon: Send,               accent: accentFromBadge(CUSTOMER_REVIEW_STATUS_META.sent),       count: tabCounts.awaiting_reply },
    // The verifier's queue is shown only to a verifier. For anybody else it
    // would be a tab they can click and never act on.
    ...(caps.canVerify ? [{
      key: 'to_verify' as const, label: 'To Verify', Icon: ShieldCheck,
      accent: accentFromBadge(CUSTOMER_REVIEW_STATUS_META.customer_responded), count: tabCounts.to_verify,
    }] : []),
    { key: 'finished',       label: 'Finished',   Icon: ShieldCheck,        accent: accentFromBadge(CUSTOMER_REVIEW_STATUS_META.verified),   count: tabCounts.finished },
  ]

  if (authLoading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      canVerify={caps.canVerify}
      title="Customer Review Outreach"
      subtitle="Invite genuine customers to leave an honest review."
      onSignOut={signOut}
      actions={caps.canUse ? (
        <button
          onClick={() => router.push('/customer-reviews/new')}
          className="boe-btn boe-btn-primary"
          style={{ padding: '7px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <Plus size={14} strokeWidth={2.2} />
          New Request
        </button>
      ) : undefined}
    >
      {/* Toolbar — one search box. There is no status dropdown because the tab
          strip below already is one, and no owner filter because a `use` holder
          only ever sees their own rows. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <input
          className="boe-input"
          aria-label="Search review requests"
          placeholder="Search customer, project or interaction…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onBlur={flushSearch}
          style={{ flex: 1, minWidth: '180px', maxWidth: '320px', padding: '6px 10px', fontSize: '12px' }}
        />
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
        <StatusTabs
          tabs={tabs}
          active={tab}
          onSelect={key => setState({ tab: key })}
          summary={listLoading
            ? 'Loading…'
            : filtersActive
              ? `${visible.length} of ${requests.length} visible`
              : `${visible.length} request${visible.length !== 1 ? 's' : ''}`}
        />

        {listLoading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <EmptyRequests
            filtersActive={filtersActive}
            canUse={caps.canUse}
            onClear={() => { setSearchInput(''); resetState() }}
            onCreate={() => router.push('/customer-reviews/new')}
          />
        ) : isMobile ? (
          <div style={{ padding: '10px' }}>
            {visible.map(r => (
              <RequestCard key={r.id} request={r} onOpen={() => router.push(`/customer-reviews/${r.id}`)} />
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Customer / Project', 'Interaction', 'WhatsApp', 'Raised by', 'Created', 'Sent', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/customer-reviews/${r.id}`)}
                    style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer', transition: 'background 0.1s' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                  >
                    {/* A long customer or project name wraps inside a bounded
                        column rather than pushing the row wide — the status a
                        reader is scanning for must stay on screen. */}
                    <td style={{
                      padding: '11px 16px', fontWeight: 600, color: colors.primary,
                      maxWidth: '260px', wordBreak: 'break-word',
                    }}>
                      {r.customer_name}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {interactionTypeLabel(r.interaction_type)}
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <MaskedNumber value={r.whatsapp_number} />
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {r.owner_name ?? '—'}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {formatReviewDate(r.created_at)}
                    </td>
                    {/* Sent, not "opened WhatsApp". An em dash here means
                        nobody has confirmed sending it, whatever links have
                        been opened. */}
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {formatReviewDate(r.sent_at)}
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <ReviewBadge meta={CUSTOMER_REVIEW_STATUS_META[r.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </CustomerReviewsLayout>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function RequestCard({
  request, onOpen,
}: { request: CustomerReviewRequest; onOpen: () => void }) {
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
        <div style={{
          fontSize: '13px', fontWeight: 700, color: colors.primary, lineHeight: 1.3,
          minWidth: 0, wordBreak: 'break-word',
        }}>
          {request.customer_name}
        </div>
        <div style={{ flexShrink: 0 }}>
          <ReviewBadge meta={CUSTOMER_REVIEW_STATUS_META[request.status]} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: colors.secondary }}>
          {interactionTypeLabel(request.interaction_type)}
        </span>
        <MaskedNumber value={request.whatsapp_number} />
      </div>
      <div style={{ fontSize: '12px', color: colors.muted, marginTop: '6px' }}>
        Raised {formatReviewDate(request.created_at)}
        {request.owner_name ? ` · ${request.owner_name}` : ''}
        {request.sent_at ? ` · Sent ${formatReviewDate(request.sent_at)}` : ''}
      </div>
    </button>
  )
}

function EmptyRequests({
  filtersActive, canUse, onClear, onCreate,
}: {
  filtersActive: boolean
  canUse: boolean
  onClear: () => void
  onCreate: () => void
}) {
  if (filtersActive) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: colors.muted }}>No requests match the current filters.</p>
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

  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <MessageSquareHeart size={28} strokeWidth={1.4} color={colors.muted} />
      <p style={{ fontSize: '13px', color: colors.secondary, marginTop: '10px', fontWeight: 600 }}>
        No review requests yet
      </p>
      <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', maxWidth: '420px', margin: '4px auto 0' }}>
        {canUse
          ? 'Raise a request for a customer you have actually worked with, prepare the invitation, and open WhatsApp to send it yourself.'
          : 'Requests appear here once somebody raises one. You can verify and close them, but not raise them.'}
      </p>
      {canUse && (
        <button
          onClick={onCreate}
          className="boe-btn boe-btn-primary"
          style={{ marginTop: '14px', padding: '8px 18px', fontSize: '13px' }}
        >
          New Request
        </button>
      )}
    </div>
  )
}
