'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Phone, Plus, Search, UserPlus, X } from 'lucide-react'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumListParam, enumParam, pageParam, textParam, type ParamCodec } from '@/lib/listState'
import { VENDORS_KEY, fetchVendor, fetchVendorPage, setVendorStatus, type VendorFilter } from '@/lib/vendors/api'
import {
  CAPABILITIES, PRE_VISIT_STATUSES, PRODUCT_FOCUS, TEAM_SIZES, VENDOR_STATUSES, labelOf, type VendorSummary,
} from '@/lib/vendors/constants'
import { vendorsCsv } from '@/lib/vendors/csv'
import { telHref, formatPhone } from '@/lib/exhibitionLeads/phone'
import FilterMenu from './FilterMenu'
import { Highlight, StatusBadge, daysAgoText } from './VendorBits'
import s from './vendors.module.css'

// The vendor base, built to answer "which vendor is this, and which of them do I want?" at a glance:
//   each row shows the vendor's expertise (raw manufacturing / full finished piece / only finishing), what they make,
//   the team size, the area, the stage (editable in the row) and when somebody last met them;
//   the filters are always on screen: Expertise, Products, Team size, Area, Status, and "met us, not visited";
//   three tabs split registered (a site visit was made) from not registered.
// Search, tab, filters and sort live in the URL, so Back, reload and a shared link restore the exact view. Arrow keys
// move between rows, Enter opens one, "/" jumps to the search.

const PAGE = 30
const STAGES = ['all', 'registered', 'unregistered'] as const
type Stage = (typeof STAGES)[number]
const SORTS = ['last_visit', 'oldest_visit', 'newest', 'name'] as const
type Sort = (typeof SORTS)[number]
const SORT_LABELS: Record<Sort, string> = {
  last_visit: 'Recently visited first',
  oldest_visit: 'Longest since visited first',
  newest: 'Newest added first',
  name: 'Name A–Z',
}
const PRE = PRE_VISIT_STATUSES as readonly string[]
const DECISIONS = VENDOR_STATUSES.filter(o => !PRE.includes(o.value)).map(o => o.value)
const PRE_VISIT_OPTIONS = VENDOR_STATUSES.filter(o => PRE.includes(o.value))
const ALL_STATUSES = VENDOR_STATUSES.map(o => o.value)

// Areas are typed by people, so the list is open: "|"-separated in the address bar.
const freeListParam = (): ParamCodec<string[]> => ({
  parse: raw => (raw ? raw.split('|').map(x => x.trim()).filter(Boolean).slice(0, 20) : []),
  serialize: value => (value.length > 0 ? value.join('|') : null),
})

const PARAMS = {
  q: textParam(),
  stage: enumParam(STAGES, 'all'),
  status: enumListParam(ALL_STATUSES),
  can: enumListParam(CAPABILITIES.map(o => o.value)),
  type: enumListParam(PRODUCT_FOCUS.map(o => o.value)),
  team: enumListParam(TEAM_SIZES.map(o => o.value)),
  area: freeListParam(),
  sort: enumParam(SORTS, 'last_visit'),
  archived: enumParam(['0', '1'] as const, '0'),
  waiting: enumParam(['0', '1'] as const, '0'),
  page: pageParam(),
}

/** The statuses to ask for: the tab's set, narrowed by the Status filter when one is chosen. */
function statusesFor(stage: Stage, status: string[]): string[] | undefined {
  const tab = stage === 'registered' ? DECISIONS : stage === 'unregistered' ? [...PRE] : undefined
  if (status.length === 0) return tab
  if (!tab) return status
  const both = status.filter(x => tab.includes(x))
  return both.length > 0 ? both : ['none'] // a choice outside the tab matches nothing, not everything
}

const CAP_SHORT: Record<string, string> = { raw_pieces: 'Raw', finished_pieces: 'Full finish', finishing_only: 'Finishing only' }
const CAP_TONE: Record<string, string> = { raw_pieces: s.tagRaw, finished_pieces: s.tagFull, finishing_only: s.tagFinish }

export default function VendorListScreen() {
  const { supabase, profile, isAdmin, canCreate, canEdit, canExport, loading, signOut } = useVendors()
  const qc = useQueryClient()
  const { state, setState, resetState } = useListUrlState(PARAMS, { pageKey: 'page' })
  const [input, setInput, flush] = useUrlSearchInput(state.q, q => setState({ q }))
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
    q: state.q, statuses: statusesFor(state.stage, state.status), capabilities: state.can, products: state.type,
    team_sizes: state.team, areas: state.area, sort: state.sort, archived, awaiting_visit: state.waiting === '1',
    limit: PAGE, offset: (state.page - 1) * PAGE,
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
    links[Math.min(links.length - 1, Math.max(0, at + delta))]?.focus()
  }, [])

  if (loading || !profile) return <LoadingScreen />

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const counts = data?.status_counts ?? {}
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0)
  const tabCount: Record<Stage, number> = {
    all: Object.values(counts).reduce((a, b) => a + b, 0),
    registered: sum(DECISIONS),
    unregistered: sum([...PRE]),
  }
  const tabLabel: Record<Stage, string> = { all: 'All', registered: 'Registered', unregistered: 'Not registered' }
  const areas = data?.areas ?? []
  const filtersOn = state.status.length + state.can.length + state.type.length + state.team.length + state.area.length + (state.waiting === '1' ? 1 : 0)
  const anyFilter = !!state.q || state.stage !== 'all' || filtersOn > 0
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

  const header = !canCreate ? undefined : (
    <>
      <Link className={`${s.secondary} ${s.hideOnPhone}`} href="/vendors/new"><UserPlus size={15} aria-hidden="true" /> Add vendor</Link>
      <Link className={`${s.primary} ${s.hideOnPhone}`} href="/vendors/visit"><Plus size={15} aria-hidden="true" /> Log visit</Link>
    </>
  )

  const nameSortOn = state.sort === 'name'
  const lastSortOn = state.sort === 'last_visit' || state.sort === 'oldest_visit'

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut}
                   title={archived ? 'Archived Vendors' : 'Vendors'}
                   subtitle={archived ? 'Removed from the active list' : undefined}
                   actions={header}>
      <div className={s.wrapWide}>
        <div className={s.tabs} role="tablist" aria-label="Registration">
          {STAGES.map(st => (
            <button key={st} type="button" role="tab" aria-selected={state.stage === st}
                    className={`${s.tab}${state.stage === st ? ` ${s.tabOn}` : ''}`}
                    onClick={() => setState({ stage: st })}>
              {tabLabel[st]} <span className={s.tabCount}>{tabCount[st]}</span>
            </button>
          ))}
        </div>

        <div className={s.searchWrap}>
          <Search size={16} className={s.searchIcon} aria-hidden="true" />
          <input ref={searchRef} className={`${s.input} ${s.searchInput}`} value={input} type="search" enterKeyHint="search"
                 onChange={e => setInput(e.target.value)} onBlur={flush}
                 onKeyDown={e => {
                   if (e.key === 'Escape') { setInput(''); e.currentTarget.blur() }
                   if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(null, 1) }
                 }}
                 placeholder="Search name, phone or area" aria-label="Search vendors" autoComplete="off" />
          {input ? (
            <button type="button" className={s.searchClear} aria-label="Clear search" onClick={() => { setInput(''); searchRef.current?.focus() }}>
              <X size={15} aria-hidden="true" />
            </button>
          ) : <kbd className={`${s.kbd} ${s.hideOnPhone}`} aria-hidden="true">/</kbd>}
        </div>

        <div className={s.filterBar} role="group" aria-label="Filters">
          <FilterMenu label="Expertise" options={CAPABILITIES} value={state.can} onChange={v => setState({ can: v as typeof state.can })} />
          <FilterMenu label="Products" options={PRODUCT_FOCUS} value={state.type} onChange={v => setState({ type: v as typeof state.type })} />
          <FilterMenu label="Team size" options={TEAM_SIZES} value={state.team} onChange={v => setState({ team: v as typeof state.team })} />
          <FilterMenu label="Area" options={areas.map(a => ({ value: a, label: a }))} value={state.area}
                      onChange={v => setState({ area: v })} emptyText="No areas yet: add one on a vendor" />
          <FilterMenu label="Status" options={VENDOR_STATUSES} value={state.status} onChange={v => setState({ status: v as typeof state.status })} />
          <button type="button" className={`${s.fbtn}${state.waiting === '1' ? ` ${s.fbtnOn}` : ''}`} aria-pressed={state.waiting === '1'}
                  onClick={() => setState({ waiting: state.waiting === '1' ? '0' : '1' })}>
            Met us, not visited
          </button>
          <span className={s.showOnPhone}>
            <select className={`${s.select} ${s.sortSelect}`} value={state.sort} aria-label="Sort order"
                    onChange={e => setState({ sort: e.target.value as Sort })}>
              {SORTS.map(k => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
            </select>
          </span>
        </div>

        {awaiting > 0 && state.waiting !== '1' && !archived && (
          <div className={`${s.notice} ${s.fade}`} role="status">
            <span>{awaiting} vendor{awaiting === 1 ? ' has' : 's have'} met us but nobody has visited {awaiting === 1 ? 'them' : 'their factory'} yet.</span>
            <button type="button" className={s.linkBtn} onClick={() => setState({ waiting: '1', stage: 'all' })}>Show</button>
          </div>
        )}

        <div className={s.resultLine} aria-live="polite">
          {isFetching && isPlaceholderData ? 'Updating…' : `${total} vendor${total === 1 ? '' : 's'}`}
          {anyFilter && (
            <button type="button" className={s.linkBtn} style={{ marginLeft: 10 }} onClick={() => { setInput(''); resetState() }}>Clear all</button>
          )}
          {(canExport || isAdmin) && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
              {canExport && <button type="button" className={s.linkBtn} onClick={() => void exportCsv()} disabled={exporting}>{exporting ? 'Preparing…' : 'Export CSV'}</button>}
              {isAdmin && (
                <button type="button" className={s.linkBtn} onClick={() => setState({ archived: archived ? '0' : '1' })}>
                  {archived ? 'Back to active' : 'Show archived'}
                </button>
              )}
            </span>
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
              {anyFilter ? 'Try fewer words, or clear the filters.' : archived ? 'Archived vendors appear here.' : canCreate ? 'Add a vendor you have heard about, or log your first visit.' : 'Nothing has been added yet.'}
            </div>
            {anyFilter
              ? <button type="button" className={s.secondary} onClick={() => { setInput(''); resetState() }}>Clear search and filters</button>
              : !archived && canCreate && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Link className={s.primary} href="/vendors/new"><UserPlus size={15} aria-hidden="true" /> Add vendor</Link>
                  <Link className={s.secondary} href="/vendors/visit"><Plus size={15} aria-hidden="true" /> Log visit</Link>
                </div>
              )}
          </div>
        )}

        {rows.length > 0 && (
          <div className={s.listHead} role="row">
            <button type="button" className={`${s.sortBtn} ${nameSortOn ? s.sortBtnOn : ''}`} onClick={() => setState({ sort: 'name' })} aria-label="Sort by name">
              Vendor {nameSortOn && <ArrowDown size={12} aria-hidden="true" />}
            </button>
            <span className={s.headLabel}>Expertise</span>
            <span className={s.headLabel}>Team</span>
            <span className={s.headLabel}>Area</span>
            <span className={s.headLabel}>Stage</span>
            <button type="button" className={`${s.sortBtn} ${lastSortOn ? s.sortBtnOn : ''}`}
                    onClick={() => setState({ sort: state.sort === 'last_visit' ? 'oldest_visit' : 'last_visit' })} aria-label="Sort by last meeting">
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
            <VendorRow key={r.id} v={r} q={state.q} canEditStage={!archived && canEdit && (isAdmin || PRE.includes(r.status))}
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
  if (v.visit_count === 0) return v.status === 'potential' ? { text: 'Not contacted yet', warn: false } : { text: 'Not visited yet', warn: true }
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
  const where = standing(v)
  const options = isAdmin ? VENDOR_STATUSES : PRE_VISIT_OPTIONS
  const makes = v.product_focus ? labelOf(PRODUCT_FOCUS, v.product_focus) : null
  const inline = [v.team_size ? `${v.team_size} people` : null, v.area].filter(Boolean).join(' · ')
  return (
    <div className={s.row} data-row onMouseEnter={() => onTouch(v.id)} onTouchStart={() => onTouch(v.id)}
         onClick={e => { if (!(e.target as HTMLElement).closest('select, a[data-stop]')) router.push(`/vendors/${v.id}`) }}
         style={{ cursor: 'pointer' }}>
      <Link href={`/vendors/${v.id}`} className={s.rowLink} data-vendor onFocus={() => onTouch(v.id)}>
        <span className={s.rowName}><Highlight text={v.company_name} q={q} /></span>
        {v.contact_name && <span className={s.rowMeta}><Highlight text={v.contact_name} q={q} /></span>}
      </Link>
      <span className={s.rowTags}>
        {v.capabilities.map(c => <span key={c} className={`${s.tag} ${CAP_TONE[c] ?? ''}`}>{CAP_SHORT[c] ?? c}</span>)}
        {makes && <span className={`${s.tag} ${s.tagPlain}`}>{makes}</span>}
        {v.capabilities.length === 0 && !makes && <span className={s.rowDash}>—</span>}
      </span>
      <span className={s.rowInline}>{inline}</span>
      <span className={s.rowTeam}>{v.team_size ?? <span className={s.rowDash}>—</span>}</span>
      <span className={s.rowArea}>{v.area ? <Highlight text={v.area} q={q} /> : <span className={s.rowDash}>—</span>}</span>
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
