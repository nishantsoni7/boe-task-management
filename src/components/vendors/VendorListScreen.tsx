'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Phone, Plus, Search, SlidersHorizontal, UserPlus, X } from 'lucide-react'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumListParam, enumParam, pageParam, textParam } from '@/lib/listState'
import { VENDORS_KEY, fetchVendor, fetchVendorPage, setVendorStatus, type VendorFilter } from '@/lib/vendors/api'
import {
  CAPABILITIES, PRE_VISIT_STATUSES, PRODUCT_FOCUS, VENDOR_STATUSES, labelOf, type VendorSummary,
} from '@/lib/vendors/constants'
import { vendorsCsv } from '@/lib/vendors/csv'
import { telHref, formatPhone } from '@/lib/exhibitionLeads/phone'
import { Chips, Highlight, StatusBadge, daysAgoText } from './VendorBits'
import s from './vendors.module.css'

// The vendor base, as a table you can drive from the keyboard:
//   four stage tabs that always fit (All · Potential · Contacted · Registered), one search box, one Filter button;
//   a sortable header on a wide screen; the stage is editable right in the row (a person moves a vendor between
//   Potential and Contacted; Admin sets any stage); ↑ ↓ move between rows, Enter opens, "/" jumps to the search.
// Search, tab, filters and sort live in the URL, so Back, reload and a shared link restore the exact view. Results
// update as you type; the previous list stays on screen while the next one loads.

const PAGE = 30
const STAGES = ['all', 'potential', 'contacted', 'registered'] as const
type Stage = (typeof STAGES)[number]
const SORTS = ['last_visit', 'oldest_visit', 'newest', 'name'] as const
type Sort = (typeof SORTS)[number]
const SORT_LABELS: Record<Sort, string> = {
  last_visit: 'Recently visited first',
  oldest_visit: 'Longest since visited first',
  newest: 'Newest added first',
  name: 'Name A–Z',
}
const REGISTERED = VENDOR_STATUSES.filter(o => !PRE_VISIT_STATUSES.some(p => p === o.value))
const DECISIONS = REGISTERED.map(o => o.value)
const PRE_VISIT_OPTIONS = VENDOR_STATUSES.filter(o => PRE_VISIT_STATUSES.some(p => p === o.value))

const PARAMS = {
  q: textParam(),
  stage: enumParam(STAGES, 'all'),
  decision: enumListParam(DECISIONS),
  can: enumListParam(CAPABILITIES.map(o => o.value)),
  type: enumListParam(PRODUCT_FOCUS.map(o => o.value)),
  sort: enumParam(SORTS, 'last_visit'),
  archived: enumParam(['0', '1'] as const, '0'),
  waiting: enumParam(['0', '1'] as const, '0'),
  page: pageParam(),
}

/** Which statuses a tab shows (and, for Registered / All, which decisions the filter narrows to). */
function statusesFor(stage: Stage, decision: string[]): string[] | undefined {
  if (stage === 'potential' || stage === 'contacted') return [stage]
  if (decision.length > 0) return decision
  return stage === 'registered' ? DECISIONS : undefined
}

export default function VendorListScreen() {
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const qc = useQueryClient()
  const { state, setState, resetState } = useListUrlState(PARAMS, { pageKey: 'page' })
  const [input, setInput, flush] = useUrlSearchInput(state.q, q => setState({ q }))
  const [showFilters, setShowFilters] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [rowProblem, setRowProblem] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)

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
    q: state.q, statuses: statusesFor(state.stage, state.decision), capabilities: state.can, products: state.type,
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

  const changeStage = useCallback(async (id: string, next: string) => {
    setRowProblem(null)
    try {
      await setVendorStatus(supabase, id, next)
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
    } catch (e) {
      setRowProblem(e instanceof Error ? e.message : 'Could not change the stage.')
    }
  }, [supabase, qc])

  // ↑ / ↓ move between rows (and from the search box into the first row).
  const moveFocus = useCallback((from: Element | null, delta: 1 | -1) => {
    const links = Array.from(rowsRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-vendor]') ?? [])
    if (links.length === 0) return
    const at = from ? links.findIndex(l => l === from || l.closest('[data-row]') === from.closest('[data-row]')) : -1
    const next = links[Math.min(links.length - 1, Math.max(0, at + delta))]
    next?.focus()
  }, [])

  if (loading || !profile) return <LoadingScreen />

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const counts = data?.status_counts ?? {}
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0)
  const tabCount: Record<Stage, number> = {
    all: Object.values(counts).reduce((a, b) => a + b, 0),
    potential: counts.potential ?? 0,
    contacted: counts.contacted ?? 0,
    registered: sum(DECISIONS),
  }
  const tabLabel: Record<Stage, string> = { all: 'All', potential: 'Potential', contacted: 'Contacted', registered: 'Registered' }
  const advancedOn = state.can.length + state.type.length + state.decision.length + (state.waiting === '1' ? 1 : 0)
  const anyFilter = !!state.q || state.stage !== 'all' || advancedOn > 0
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const awaiting = data?.awaiting_count ?? 0

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
      <Link className={`${s.secondary} ${s.hideOnPhone}`} href="/vendors/new"><UserPlus size={15} aria-hidden="true" /> Add vendor</Link>
      <Link className={`${s.primary} ${s.hideOnPhone}`} href="/vendors/visit"><Plus size={15} aria-hidden="true" /> Log visit</Link>
    </>
  )

  // Clicking a column header sorts by it; clicking it again flips the direction where one exists.
  const nameSortOn = state.sort === 'name'
  const lastSortOn = state.sort === 'last_visit' || state.sort === 'oldest_visit'

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut}
                   title={archived ? 'Archived Vendors' : 'Vendors'}
                   subtitle={archived ? 'Removed from the active list' : undefined}
                   actions={header}>
      <div className={s.wrapWide}>
        <div className={s.tabs} role="tablist" aria-label="Stage">
          {STAGES.map(st => (
            <button key={st} type="button" role="tab" aria-selected={state.stage === st}
                    className={`${s.tab}${state.stage === st ? ` ${s.tabOn}` : ''}`}
                    onClick={() => setState({ stage: st, decision: st === 'potential' || st === 'contacted' ? [] : state.decision })}>
              {tabLabel[st]} <span className={s.tabCount}>{tabCount[st]}</span>
            </button>
          ))}
        </div>

        <div className={s.toolbar}>
          <div className={s.searchWrap}>
            <Search size={16} className={s.searchIcon} aria-hidden="true" />
            <input ref={searchRef} className={`${s.input} ${s.searchInput}`} value={input} type="search" enterKeyHint="search"
                   onChange={e => setInput(e.target.value)} onBlur={flush}
                   onKeyDown={e => {
                     if (e.key === 'Escape') { setInput(''); e.currentTarget.blur() }
                     if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(null, 1) }
                   }}
                   placeholder="Search vendors" aria-label="Search vendors" autoComplete="off" />
            {input ? (
              <button type="button" className={s.searchClear} aria-label="Clear search" onClick={() => { setInput(''); searchRef.current?.focus() }}>
                <X size={15} aria-hidden="true" />
              </button>
            ) : <kbd className={`${s.kbd} ${s.hideOnPhone}`} aria-hidden="true">/</kbd>}
          </div>
          <button type="button" className={`${s.secondary} ${showFilters || advancedOn > 0 ? s.secondaryOn : ''}`}
                  onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span>Filter{advancedOn > 0 ? ` · ${advancedOn}` : ''}</span>
          </button>
        </div>

        {showFilters && (
          <div className={`${s.filterPanel} ${s.fade}`}>
            {state.stage !== 'potential' && state.stage !== 'contacted' && (
              <div className={s.filterRow}><span className={s.label}>Decision</span>
                <Chips multiple label="Decision" options={REGISTERED} value={state.decision}
                       onChange={v => setState({ decision: v as typeof state.decision })} /></div>
            )}
            <div className={s.filterRow}><span className={s.label}>What they do</span>
              <Chips multiple label="What they do" options={CAPABILITIES} value={state.can}
                     onChange={v => setState({ can: v as typeof state.can })} /></div>
            <div className={s.filterRow}><span className={s.label}>Products</span>
              <Chips multiple label="Products" options={PRODUCT_FOCUS} value={state.type}
                     onChange={v => setState({ type: v as typeof state.type })} /></div>
            <label className={s.checkRow}>
              <input type="checkbox" checked={state.waiting === '1'} onChange={e => setState({ waiting: e.target.checked ? '1' : '0' })} />
              Met us at our factory, not visited yet
            </label>
            <div className={s.filterRow}><span className={s.label}>Sort by</span>
              <select className={s.select} style={{ maxWidth: 260 }} value={state.sort} aria-label="Sort order"
                      onChange={e => setState({ sort: e.target.value as Sort })}>
                {SORTS.map(k => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
              </select></div>
            {isAdmin && (
              <div style={{ display: 'flex', gap: 14 }}>
                <button type="button" className={s.linkBtn} onClick={() => void exportCsv()} disabled={exporting}>{exporting ? 'Preparing…' : 'Export to CSV'}</button>
                <button type="button" className={s.linkBtn} onClick={() => setState({ archived: archived ? '0' : '1' })}>
                  {archived ? 'Back to active vendors' : 'Show archived'}
                </button>
              </div>
            )}
          </div>
        )}

        {awaiting > 0 && state.waiting !== '1' && !archived && (
          <div className={`${s.notice} ${s.fade}`} role="status">
            <span>{awaiting} vendor{awaiting === 1 ? ' has' : 's have'} met us but nobody has visited {awaiting === 1 ? 'them' : 'their factory'} yet.</span>
            <button type="button" className={s.linkBtn} onClick={() => setState({ waiting: '1', stage: 'all' })}>Show</button>
          </div>
        )}

        {(state.can.length > 0 || state.type.length > 0 || state.decision.length > 0 || state.waiting === '1') && (
          <div className={s.pills} aria-label="Active filters">
            {state.waiting === '1' && <Pill label="Awaiting a site visit" onRemove={() => setState({ waiting: '0' })} />}
            {state.decision.map(v => <Pill key={v} label={labelOf(VENDOR_STATUSES, v)} onRemove={() => setState({ decision: state.decision.filter(x => x !== v) })} />)}
            {state.can.map(v => <Pill key={v} label={labelOf(CAPABILITIES, v)} onRemove={() => setState({ can: state.can.filter(x => x !== v) })} />)}
            {state.type.map(v => <Pill key={v} label={labelOf(PRODUCT_FOCUS, v)} onRemove={() => setState({ type: state.type.filter(x => x !== v) })} />)}
          </div>
        )}

        <div className={s.resultLine} aria-live="polite">
          {isFetching && isPlaceholderData ? 'Updating…' : `${total} vendor${total === 1 ? '' : 's'}`}
          {anyFilter && (
            <button type="button" className={s.linkBtn} style={{ marginLeft: 10 }} onClick={() => { setInput(''); resetState() }}>Clear all</button>
          )}
        </div>

        {error && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{error instanceof Error ? error.message : 'Could not load the vendors.'}</div>}
        {rowProblem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{rowProblem}</div>}

        {isLoading && <SkeletonRows />}

        {!isLoading && rows.length === 0 && !error && (
          <div className={`${s.emptyState} ${s.fade}`}>
            <EmptyArt />
            <div className={s.emptyTitle}>{anyFilter ? 'No vendor matches' : archived ? 'No archived vendors' : 'No vendors yet'}</div>
            <div className={s.muted}>
              {anyFilter ? 'Try fewer words, or clear the filters.' : archived ? 'Archived vendors appear here.' : 'Add a vendor you have heard about, or log your first visit.'}
            </div>
            {anyFilter
              ? <button type="button" className={s.secondary} onClick={() => { setInput(''); resetState() }}>Clear search and filters</button>
              : !archived && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Link className={s.primary} href="/vendors/new"><UserPlus size={15} aria-hidden="true" /> Add vendor</Link>
                  <Link className={s.secondary} href="/vendors/visit"><Plus size={15} aria-hidden="true" /> Log visit</Link>
                </div>
              )}
          </div>
        )}

        {rows.length > 0 && (
          <div className={s.listHead} role="row">
            <button type="button" className={`${s.sortBtn} ${nameSortOn ? s.sortBtnOn : ''}`}
                    onClick={() => setState({ sort: 'name' })} aria-label="Sort by name">
              Vendor {nameSortOn && <ArrowDown size={12} aria-hidden="true" />}
            </button>
            <span className={s.headLabel}>Stage</span>
            <button type="button" className={`${s.sortBtn} ${lastSortOn ? s.sortBtnOn : ''}`}
                    onClick={() => setState({ sort: state.sort === 'last_visit' ? 'oldest_visit' : 'last_visit' })}
                    aria-label="Sort by last meeting">
              Last meeting {lastSortOn && (state.sort === 'last_visit' ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
            </button>
            <span />
          </div>
        )}

        <div ref={rowsRef} className={`${s.rows} ${isPlaceholderData ? s.rowsStale : ''}`}
             onKeyDown={e => {
               if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                 const t = e.target as HTMLElement
                 if (t.tagName === 'SELECT') return
                 e.preventDefault()
                 moveFocus(t, e.key === 'ArrowDown' ? 1 : -1)
               }
             }}>
          {rows.map(r => (
            <VendorRow key={r.id} v={r} q={state.q} canEditStage={!archived && (isAdmin || PRE_VISIT_STATUSES.some(p => p === r.status))}
                       isAdmin={isAdmin} onTouch={prefetch} onStage={changeStage} />
          ))}
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
      <button type="button" className={s.pillX} aria-label={`Remove ${label}`} onClick={onRemove}><X size={12} aria-hidden="true" /></button>
    </span>
  )
}

function EmptyArt() {
  return (
    <svg className={s.emptyArt} viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <rect x="6" y="10" width="44" height="9" rx="3" stroke="currentColor" strokeWidth="2" />
      <rect x="6" y="24" width="44" height="9" rx="3" stroke="currentColor" strokeWidth="2" />
      <rect x="6" y="38" width="30" height="9" rx="3" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />
    </svg>
  )
}

function SkeletonRows() {
  return (
    <div className={s.rows} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div key={i} className={s.row}>
          <div className={s.rowNameCol}>
            <div className={s.skel} style={{ width: '45%', height: 14 }} />
            <div className={s.skel} style={{ width: '30%', height: 11, marginTop: 4 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The one line that says where this vendor stands with us. */
function standing(v: VendorSummary): { text: string; warn: boolean } {
  if (v.awaiting_site_visit) return { text: 'Met us · awaiting a site visit', warn: true }
  if (v.visit_count === 0) {
    if (v.status === 'potential') return { text: 'Not contacted yet', warn: false }
    return { text: 'Not visited yet', warn: true }
  }
  const stale = v.days_since_visit !== null && v.days_since_visit >= 30
  return { text: `${daysAgoText(v.days_since_visit)} · ${v.visit_count} meeting${v.visit_count === 1 ? '' : 's'}`, warn: stale }
}

function stageTone(status: string): string {
  return status === 'approved' ? s.stagePickGood : status === 'rejected' ? s.stagePickBad : status === 'on_hold' ? s.stagePickWarn : ''
}

function VendorRow({ v, q, canEditStage, isAdmin, onTouch, onStage }: {
  v: VendorSummary; q: string; canEditStage: boolean; isAdmin: boolean
  onTouch: (id: string) => void; onStage: (id: string, next: string) => void
}) {
  const router = useRouter()
  const meta = v.contact_name ?? ''
  const where = standing(v)
  const options = isAdmin ? VENDOR_STATUSES : PRE_VISIT_OPTIONS
  return (
    <div className={s.row} data-row onMouseEnter={() => onTouch(v.id)} onTouchStart={() => onTouch(v.id)}
         onClick={e => { if (!(e.target as HTMLElement).closest('select, a[data-stop]')) router.push(`/vendors/${v.id}`) }}
         style={{ cursor: 'pointer' }}>
      <Link href={`/vendors/${v.id}`} className={s.rowLink} data-vendor onFocus={() => onTouch(v.id)}>
        <span className={s.rowName}><Highlight text={v.company_name} q={q} /></span>
        {meta && <span className={s.rowMeta}><Highlight text={meta} q={q} /></span>}
      </Link>
      <span className={s.rowStage}>
        {canEditStage ? (
          <select className={`${s.stagePick} ${stageTone(v.status)}`} value={v.status} aria-label={`Stage of ${v.company_name}`}
                  onChange={e => onStage(v.id, e.target.value)}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <StatusBadge status={v.status} />
        )}
      </span>
      <span className={`${s.rowLast}${where.warn ? ` ${s.rowLastWarn}` : ''}`}>{where.text}</span>
      <span className={s.rowActions}>
        {v.phone && (
          <a className={s.callHover} data-stop href={telHref(v.phone)} aria-label={`Call ${v.contact_name ?? v.company_name} on ${formatPhone(v.phone)}`}>
            <Phone size={14} aria-hidden="true" />
          </a>
        )}
      </span>
    </div>
  )
}
