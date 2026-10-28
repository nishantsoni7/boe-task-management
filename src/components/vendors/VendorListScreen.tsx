'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Phone, Plus, Search, SlidersHorizontal, UserPlus, X } from 'lucide-react'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumListParam, enumParam, pageParam, textParam } from '@/lib/listState'
import { VENDORS_KEY, fetchVendor, fetchVendorPage, type VendorFilter } from '@/lib/vendors/api'
import {
  CAPABILITIES, CATEGORIES, VENDOR_STATUSES, labelOf, type VendorSummary,
} from '@/lib/vendors/constants'
import { vendorsCsv } from '@/lib/vendors/csv'
import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import { Chips, Freshness, Highlight, StatusBadge } from './VendorBits'
import s from './vendors.module.css'

// The vendor base. Search, status tabs and filters all live in the URL, so Back, reload and a shared link
// restore exactly the view that was left. Results update as you type (the previous list stays on screen while
// the next one loads — nothing flashes), every word typed must match somewhere, and "/" jumps to the search box.

const PAGE = 24
const SORTS = ['last_visit', 'oldest_visit', 'newest', 'name'] as const
const SORT_LABELS: Record<(typeof SORTS)[number], string> = {
  last_visit: 'Recently visited first',
  oldest_visit: 'Longest since visited first',
  newest: 'Newest added first',
  name: 'Name A–Z',
}
const STATUS_VALUES = VENDOR_STATUSES.map(o => o.value)
const CAPABILITY_VALUES = CAPABILITIES.map(o => o.value)
const CATEGORY_VALUES = CATEGORIES.map(o => o.value)

const PARAMS = {
  q: textParam(),
  status: enumListParam(STATUS_VALUES),
  can: enumListParam(CAPABILITY_VALUES),
  type: enumListParam(CATEGORY_VALUES),
  sort: enumParam(SORTS, 'last_visit'),
  archived: enumParam(['0', '1'] as const, '0'),
  waiting: enumParam(['0', '1'] as const, '0'),
  page: pageParam(),
}

export default function VendorListScreen() {
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const qc = useQueryClient()
  const { state, setState, resetState } = useListUrlState(PARAMS, { pageKey: 'page' })
  const [input, setInput, flush] = useUrlSearchInput(state.q, q => setState({ q }))
  const [showFilters, setShowFilters] = useState(false)
  const [exporting, setExporting] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // "/" focuses the search box from anywhere on the page (unless the person is already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const archived = state.archived === '1'
  const filter: VendorFilter = {
    q: state.q, statuses: state.status, capabilities: state.can, categories: state.type,
    sort: state.sort, archived, awaiting_visit: state.waiting === '1', limit: PAGE, offset: (state.page - 1) * PAGE,
  }
  const { data, isLoading, error, isFetching, isPlaceholderData } = useQuery({
    queryKey: [VENDORS_KEY, 'list', filter],
    queryFn: () => fetchVendorPage(supabase, filter),
    enabled: !!profile,
    placeholderData: keepPreviousData,
  })

  // Open a vendor faster: start loading its page the moment a row is touched.
  const prefetch = useCallback((id: string) => {
    void qc.prefetchQuery({ queryKey: [VENDORS_KEY, 'detail', id], queryFn: () => fetchVendor(supabase, id), staleTime: 30_000 })
  }, [qc, supabase])

  if (loading || !profile) return <LoadingScreen />

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const counts = data?.status_counts ?? {}
  const allCount = Object.values(counts).reduce((a, b) => a + b, 0)
  const advancedOn = state.can.length + state.type.length
  const anyFilter = !!state.q || state.status.length > 0 || advancedOn > 0 || state.waiting === '1'
  const pages = Math.max(1, Math.ceil(total / PAGE))

  async function exportCsv() {
    setExporting(true)
    try {
      const all = await fetchVendorPage(supabase, { ...filter, limit: 1000, offset: 0 })
      const blob = new Blob([vendorsCsv(all.rows)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'vendors.csv'
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const header = (
    <>
      {isAdmin && (
        <button type="button" className={`${s.secondary} ${s.hideOnPhone}`} onClick={() => void exportCsv()} disabled={exporting}>
          <Download size={16} aria-hidden="true" /> {exporting ? 'Preparing…' : 'Export'}
        </button>
      )}
      <Link className={`${s.secondary} ${s.hideOnPhone}`} href="/vendors/new"><UserPlus size={16} aria-hidden="true" /> Add potential vendor</Link>
      <Link className={`${s.primary} ${s.hideOnPhone}`} href="/vendors/visit"><Plus size={16} aria-hidden="true" /> Log a Visit</Link>
    </>
  )

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut}
                   title={archived ? 'Archived Vendors' : 'Vendors'}
                   subtitle={archived ? 'Removed from the active list' : 'Your outsourcing partners'}
                   actions={header}>
      <div className={s.wrapWide}>
        {/* Status tabs — each shows how many vendors it holds under the current search */}
        <div className={s.tabs} role="tablist" aria-label="Vendor status">
          <button type="button" role="tab" aria-selected={state.status.length === 0}
                  className={`${s.tab}${state.status.length === 0 ? ` ${s.tabOn}` : ''}`} onClick={() => setState({ status: [] })}>
            All <span className={s.tabCount}>{allCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={state.waiting === '1'}
                  className={`${s.tab} ${s.tabAlert}${state.waiting === '1' ? ` ${s.tabOn}` : ''}`}
                  onClick={() => setState({ waiting: state.waiting === '1' ? '0' : '1', status: [] })}>
            Met us · awaiting site visit
          </button>
          {VENDOR_STATUSES.map(o => {
            const on = state.status.length === 1 && state.status[0] === o.value
            return (
              <button key={o.value} type="button" role="tab" aria-selected={on}
                      className={`${s.tab}${on ? ` ${s.tabOn}` : ''}`} onClick={() => setState({ status: [o.value] })}>
                {o.label} <span className={s.tabCount}>{counts[o.value] ?? 0}</span>
              </button>
            )
          })}
        </div>

        {/* Search + filters */}
        <div className={s.toolbar}>
          <div className={s.searchWrap}>
            <Search size={18} className={s.searchIcon} aria-hidden="true" />
            <input ref={searchRef} className={`${s.input} ${s.searchInput}`} value={input} type="search" enterKeyHint="search"
                   onChange={e => setInput(e.target.value)} onBlur={flush}
                   onKeyDown={e => { if (e.key === 'Escape') { setInput(''); e.currentTarget.blur() } }}
                   placeholder="Search name, person, phone, city, material…" aria-label="Search vendors" autoComplete="off" />
            {input ? (
              <button type="button" className={s.searchClear} aria-label="Clear search" onClick={() => { setInput(''); searchRef.current?.focus() }}>
                <X size={16} aria-hidden="true" />
              </button>
            ) : <kbd className={`${s.kbd} ${s.hideOnPhone}`} aria-hidden="true">/</kbd>}
          </div>
          <button type="button" className={`${s.secondary} ${showFilters || advancedOn > 0 ? s.secondaryOn : ''}`}
                  onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal size={16} aria-hidden="true" /> Filters{advancedOn > 0 ? ` · ${advancedOn}` : ''}
          </button>
          <select className={`${s.select} ${s.sortSelect}`} value={state.sort} aria-label="Sort order"
                  onChange={e => setState({ sort: e.target.value as (typeof SORTS)[number] })}>
            {SORTS.map(k => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
          </select>
        </div>

        {showFilters && (
          <div className={s.card}>
            <div className={s.field}><span className={s.label}>What they can do</span>
              <Chips multiple label="Capability" options={CAPABILITIES} value={state.can}
                     onChange={v => setState({ can: v as typeof state.can })} /></div>
            <div className={s.field}><span className={s.label}>Product types</span>
              <Chips multiple label="Product types" options={CATEGORIES} value={state.type}
                     onChange={v => setState({ type: v as typeof state.type })} /></div>
          </div>
        )}

        {/* What is currently narrowing the list, each removable */}
        {(state.can.length > 0 || state.type.length > 0 || state.q) && (
          <div className={s.pills} aria-label="Active filters">
            {state.q && <Pill label={`“${state.q}”`} onRemove={() => { setInput(''); setState({ q: '' }) }} />}
            {state.can.map(v => <Pill key={v} label={labelOf(CAPABILITIES, v)} onRemove={() => setState({ can: state.can.filter(x => x !== v) })} />)}
            {state.type.map(v => <Pill key={v} label={labelOf(CATEGORIES, v)} onRemove={() => setState({ type: state.type.filter(x => x !== v) })} />)}
            <button type="button" className={s.linkBtn} onClick={() => { setInput(''); resetState() }}>Clear all</button>
          </div>
        )}

        <div className={s.resultLine} aria-live="polite">
          {isFetching && isPlaceholderData ? 'Updating…' : `${total} vendor${total === 1 ? '' : 's'}${anyFilter ? ' match' : ''}`}
          {isAdmin && (
            <button type="button" className={s.linkBtn} style={{ marginLeft: 'auto' }}
                    onClick={() => setState({ archived: archived ? '0' : '1' })}>
              {archived ? 'Back to active vendors' : 'Show archived'}
            </button>
          )}
        </div>

        {error && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{error instanceof Error ? error.message : 'Could not load the vendors.'}</div>}

        {isLoading && <SkeletonRows />}

        {!isLoading && rows.length === 0 && !error && (
          <div className={s.emptyState}>
            <div className={s.emptyIcon} aria-hidden="true"><Search size={26} /></div>
            <div className={s.emptyTitle}>
              {anyFilter ? 'No vendor matches' : archived ? 'No archived vendors' : 'No vendors yet'}
            </div>
            <div className={s.muted}>
              {anyFilter ? 'Try fewer words, or clear the filters.' : archived ? 'Archived vendors appear here.' : 'Add a vendor you have heard about, or log your first visit, to start the vendor base.'}
            </div>
            {anyFilter
              ? <button type="button" className={s.secondary} onClick={() => { setInput(''); resetState() }}>Clear search and filters</button>
              : !archived && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Link className={s.primary} href="/vendors/new"><UserPlus size={16} aria-hidden="true" /> Add potential vendor</Link>
                  <Link className={s.secondary} href="/vendors/visit"><Plus size={16} aria-hidden="true" /> Log a Visit</Link>
                </div>
              )}
          </div>
        )}

        <div className={`${s.rows} ${isPlaceholderData ? s.rowsStale : ''}`}>
          {rows.map(r => <VendorRow key={r.id} v={r} q={state.q} onTouch={prefetch} />)}
        </div>

        {total > PAGE && (
          <nav className={s.pager} aria-label="Pages">
            <button type="button" className={s.secondary} disabled={state.page <= 1} onClick={() => setState({ page: state.page - 1 }, 'push')}>Previous</button>
            <span className={s.muted}>Page {state.page} of {pages}</span>
            <button type="button" className={s.secondary} disabled={state.page >= pages} onClick={() => setState({ page: state.page + 1 }, 'push')}>Next</button>
          </nav>
        )}
      </div>
    </VendorsLayout>
  )
}

function Pill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className={s.pill}>
      {label}
      <button type="button" className={s.pillX} aria-label={`Remove ${label}`} onClick={onRemove}><X size={13} aria-hidden="true" /></button>
    </span>
  )
}

function SkeletonRows() {
  return (
    <div className={s.rows} aria-hidden="true">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className={s.row}>
          <div className={s.skel} style={{ width: '55%', height: 18 }} />
          <div className={s.skel} style={{ width: '35%', height: 13 }} />
          <div className={s.skel} style={{ width: '70%', height: 13 }} />
        </div>
      ))}
    </div>
  )
}

function VendorRow({ v, q, onTouch }: { v: VendorSummary; q: string; onTouch: (id: string) => void }) {
  const initial = (v.company_name.trim()[0] ?? '?').toUpperCase()
  return (
    <div className={s.rowCard}>
      <Link href={`/vendors/${v.id}`} className={s.row} onMouseEnter={() => onTouch(v.id)} onFocus={() => onTouch(v.id)} onTouchStart={() => onTouch(v.id)}>
        <div className={s.rowTop}>
          <span className={s.avatar} aria-hidden="true">{initial}</span>
          <div className={s.rowMain}>
            <span className={s.rowName}><Highlight text={v.company_name} q={q} /></span>
            <span className={s.rowMeta}>
              {[v.contact_name, [v.city, v.state].filter(Boolean).join(', ')].filter(Boolean).map((part, i) => (
                <span key={i}>{i > 0 ? ' · ' : ''}<Highlight text={part as string} q={q} /></span>
              ))}
              {!v.contact_name && !v.city && <span className={s.muted}>No contact details yet</span>}
            </span>
          </div>
          <StatusBadge status={v.status} />
        </div>
        <div className={s.rowBadges}>
          {v.capabilities.map(c => <span key={c} className={s.badge}>{labelOf(CAPABILITIES, c)}</span>)}
          {v.categories.slice(0, 3).map(c => <span key={c} className={`${s.badge} ${s.badgeSoft}`}>{labelOf(CATEGORIES, c)}</span>)}
          {v.categories.length > 3 && <span className={`${s.badge} ${s.badgeSoft}`}>+{v.categories.length - 3}</span>}
          {v.headcount !== null && <span className={`${s.badge} ${s.badgeSoft}`}>{v.headcount} people</span>}
        </div>
        {v.referred_by && <div className={s.rowMeta}><strong>Recommended by:</strong> <Highlight text={v.referred_by} q={q} /></div>}
        {v.awaiting_site_visit && <div className={`${s.badge} ${s.badgeWarn}`} style={{ alignSelf: 'flex-start' }}>Met us · awaiting a site visit</div>}
        {v.site_visit_count === 0 && !v.awaiting_site_visit
          ? <div className={s.fresh}><span className={`${s.dot} ${s.dotWarn}`} aria-hidden="true" /><span>
              {v.inbound_count > 0 ? 'Not visited yet' : v.status === 'potential' ? 'Not contacted yet' : 'No visit recorded yet'}
            </span></div>
          : <Freshness days={v.days_since_visit} visits={v.visit_count} by={v.last_visited_by} />}
      </Link>
      {v.phone && (
        <a className={s.callBtn} href={telHref(v.phone)} aria-label={`Call ${v.contact_name ?? v.company_name} on ${formatPhone(v.phone)}`}>
          <Phone size={18} aria-hidden="true" />
        </a>
      )}
    </div>
  )
}
