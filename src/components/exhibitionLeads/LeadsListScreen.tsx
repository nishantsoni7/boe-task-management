'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, Filter, Plus, Search } from 'lucide-react'
import { ExhibitionLeadsLayout } from '@/components/layout/ExhibitionLeadsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useExhibitionLeads, useExhibitions } from '@/hooks/useExhibitionLeads'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import {
  BUYING_TIMELINES, CLIENT_TYPES, FOLLOW_UP_FILTERS, LEAD_TYPES, REQUIREMENTS, STATUSES,
  clientTypeText, requirementsLabel, type Lead,
} from '@/lib/exhibitionLeads/constants'
import {
  EXHIBITION_LEADS_KEY, fetchExportPage, fetchLeadPage, fetchPeople, type LeadPage,
} from '@/lib/exhibitionLeads/api'
import {
  ALL_LIST_PARAMS, MY_LIST_PARAMS, PAGE_SIZE, activeFilterCount, dateWindow, toRpcFilter, toggleIn,
  type ListFilterState,
} from '@/lib/exhibitionLeads/filters'
import { buildLeadsCsv, type ExportLead } from '@/lib/exhibitionLeads/csv'
import { exhibitionDates, exhibitionLabel, istDateTime, longDate, shortDate } from '@/lib/exhibitionLeads/format'
import { formatPhone } from '@/lib/exhibitionLeads/phone'
import { istDateOf, istToday } from '@/lib/istDate'
import { LeadRequestError } from '@/lib/exhibitionLeads/api'
import { ContactActions, FollowUpText, LeadTypeBadge, NoExhibitionNotice, StatusBadge } from './LeadBits'
import dynamic from 'next/dynamic'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
// The update sheet is the heaviest piece and is only needed once a lead is opened.
const LeadDetailSheet = dynamic(() => import('./LeadDetailSheet'), { ssr: false })
import s from './leads.module.css'

type Mode = 'mine' | 'all'

function Chips<T extends string>({
  title, options, selected, onToggle,
}: { title: string; options: readonly { value: T; label: string }[]; selected: readonly T[]; onToggle: (v: T) => void }) {
  return (
    <div className={s.filterGroup} role="group" aria-label={title}>
      <div className={s.filterTitle}>{title}</div>
      <div className={s.chips}>
        {options.map(o => (
          <button
            key={o.value} type="button"
            className={`${s.chip}${selected.includes(o.value) ? ` ${s.chipOn}` : ''}`}
            aria-pressed={selected.includes(o.value)}
            onClick={() => onToggle(o.value)}
          >{o.label}</button>
        ))}
      </div>
    </div>
  )
}

export default function LeadsListScreen({ mode }: { mode: Mode }) {
  const router = useRouter()
  const { supabase, profile, isAdmin, loading, signOut } = useExhibitionLeads()
  const { exhibitions, defaultExhibition, isLoading: exhibitionsLoading } = useExhibitions(supabase, !loading)

  const specs = mode === 'all' ? ALL_LIST_PARAMS : MY_LIST_PARAMS
  const { state: rawState, setState } = useListUrlState(specs)
  const state = rawState as ListFilterState

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  // The Admin list is for admins; anyone else lands on their own.
  useEffect(() => {
    if (!loading && mode === 'all' && !isAdmin) router.replace('/exhibition-leads/my')
  }, [loading, mode, isAdmin, router])

  // "all" lists the leads of every exhibition, each tagged with its exhibition.
  const allExhibitions = state.ex === 'all'
  const exhibitionId = allExhibitions ? null : (state.ex || defaultExhibition?.id || null)
  const exhibition = exhibitions.find(e => e.id === exhibitionId) ?? null
  const today = istToday()

  const filter = useMemo(
    () => toRpcFilter(state, { scope: mode, exhibitionId, today, isAdmin }),
    [state, mode, exhibitionId, today, isAdmin],
  )
  const offset = (state.page - 1) * PAGE_SIZE

  const setFilters = useCallback(
    (patch: Partial<ListFilterState>) => setState({ page: 1, ...patch } as Partial<ListFilterState>),
    [setState],
  )

  const [searchText, setSearchText, flushSearch] = useUrlSearchInput(state.q, q => setFilters({ q }))
  const clearFilters = () => {
    setSearchText('')
    setFilters({
      q: '', type: [], req: [], city: [], timeline: [], ltype: [], status: [],
      follow: [], collector: [], owner: [], archived: 'active',
    })
  }

  const enabled = !loading && (mode === 'mine' || isAdmin) && (exhibitions.length === 0 ? false : (allExhibitions || !!exhibitionId))
  const page = useQuery<LeadPage>({
    queryKey: [...EXHIBITION_LEADS_KEY, 'page', filter, offset],
    queryFn: () => fetchLeadPage(supabase, filter, PAGE_SIZE, offset),
    enabled,
    placeholderData: keepPreviousData,
  })
  const people = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'people', exhibitionId],
    queryFn: () => fetchPeople(supabase, exhibitionId),
    enabled: enabled && isAdmin && mode === 'all',
  })

  if (loading || (mode === 'all' && !isAdmin)) return <LoadingScreen />

  const data = page.data
  // Until the exhibition is known the query has not started (it is disabled), so
  // neither "loading" nor an error is set — say Loading rather than "0 matching".
  const waiting = !data && !page.error && (exhibitionsLoading || !!exhibitionId || allExhibitions)
  const filterCount = activeFilterCount(state, isAdmin)
  const window_ = dateWindow(state, today)
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const dateCounts = new Map((data?.date_counts ?? []).map(d => [d.date, d.count]))
  const multiDate = (data?.date_counts.length ?? 0) > 1

  const scopeText = [
    allExhibitions ? 'All exhibitions' : (exhibition?.name ?? 'Exhibition'),
    window_ ? (window_.from === window_.to ? longDate(window_.from) : `${shortDate(window_.from)} – ${shortDate(window_.to)}`) : 'whole exhibition',
    filterCount ? `${filterCount} filter${filterCount === 1 ? '' : 's'} applied` : 'no other filters',
    state.archived === 'active' || mode === 'mine' ? 'active leads' : state.archived === 'archived' ? 'archived leads' : 'active + archived',
  ].join(' · ')

  function openLead(id: string) { setState({ lead: id }, 'push') }
  function closeLead() { setState({ lead: '' }) }

  async function exportCsv() {
    setExportError(null)
    setExporting('Preparing…')
    try {
      const rows: ExportLead[] = []
      for (let off = 0; ; off += 1000) {
        const chunk = await fetchExportPage(supabase, filter, off)
        rows.push(...chunk)
        setExporting(`Preparing… ${rows.length}`)
        if (chunk.length < 1000) break
      }
      const blob = new Blob([buildLeadsCsv(rows)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `exhibition-leads-${allExhibitions ? 'all-exhibitions' : (exhibition?.slug ?? 'all')}-${today}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setExportError((e as LeadRequestError).message || 'The export failed. Nothing was downloaded.')
    } finally {
      setExporting(null)
    }
  }

  const header = (
    <>
      <Link href="/exhibition-leads/add" className={`${s.btn} ${s.btnRed}`}><Plus size={16} aria-hidden="true" /> Add Lead</Link>
      {mode === 'all' && (
        <button className={s.btn} onClick={exportCsv} disabled={!!exporting || total === 0}>
          <Download size={16} aria-hidden="true" /> {exporting ?? 'Export CSV'}
        </button>
      )}
    </>
  )

  function renderGroupHead(lead: Lead, idx: number, list: Lead[]) {
    const d = istDateOf(lead.created_at)
    if (!multiDate) return null
    if (idx > 0 && istDateOf(list[idx - 1].created_at) === d) return null
    return <div className={s.groupHead} key={`h-${d}-${idx}`}><span style={{ color: '#111318' }}>{longDate(d)}</span><span>{dateCounts.get(d) ?? 0} leads</span></div>
  }

  const rows = data?.rows ?? []

  return (
    <ExhibitionLeadsLayout
      profile={profile} isAdmin={isAdmin} onSignOut={signOut}
      title={mode === 'all' ? 'All Exhibition Leads' : 'My Leads'}
      subtitle={allExhibitions ? 'All exhibitions' : exhibition ? `${exhibition.name} · ${exhibitionDates(exhibition)}` : undefined}
      actions={header}
    >
      <div className={s.wrapWide}>
        {mode === 'all' && (
          <>
            <div className={s.kpis}>
              <div className={s.kpi}><div className={s.kpiValue}>{data?.summary.active_valid ?? '–'}</div><div className={s.kpiLabel}>Active valid leads</div></div>
              <div className={s.kpi}><div className={s.kpiValue}>{data?.summary.hot ?? '–'}</div><div className={s.kpiLabel}>Hot leads</div></div>
              <div className={s.kpi}><div className={s.kpiValue}>{data?.summary.overdue ?? '–'}</div><div className={s.kpiLabel}>Follow-ups overdue</div></div>
            </div>
            <div className={s.scopeLine}>Figures cover all matching leads, not just this page — {scopeText}.</div>
          </>
        )}
        {mode === 'mine' && data && (
          <div className={s.ownLine}>
            <span>Assigned to me now: <strong>{data.mine.owned_total}</strong></span>
            <span>Collected by me: <strong>{data.mine.collected_total}</strong></span>
            <span>Added today: <strong>{data.mine.owned_today}</strong></span>
          </div>
        )}

        <div className={s.toolbar}>
          <div className={s.searchBox}>
            <Search size={16} className={s.searchIcon} aria-hidden="true" />
            <input
              className={s.input} type="search" value={searchText} aria-label="Search leads"
              placeholder="Search name, mobile or company"
              onChange={e => setSearchText(e.target.value)} onBlur={flushSearch}
            />
          </div>
          <div className={s.segmented} role="group" aria-label="Added date">
            {([['today', 'Today'], ['date', 'Date'], ['range', 'Range'], ['all', 'Entire exhibition']] as const).map(([v, label]) => (
              <button
                key={v} type="button" className={`${s.seg}${state.when === v ? ` ${s.segOn}` : ''}`} aria-pressed={state.when === v}
                onClick={() => setFilters({ when: v, ...(v === 'date' && !state.day ? { day: today } : {}) })}
              >{label}</button>
            ))}
          </div>
          {state.when === 'date' && (
            <input type="date" className={s.input} aria-label="Added on" value={state.day || today} onChange={e => setFilters({ day: e.target.value })} />
          )}
          {state.when === 'range' && (
            <div className={s.dateRow}>
              <input type="date" className={s.input} aria-label="Added from" value={state.from} onChange={e => setFilters({ from: e.target.value })} />
              <span aria-hidden="true">to</span>
              <input type="date" className={s.input} aria-label="Added to" value={state.to} onChange={e => setFilters({ to: e.target.value })} />
            </div>
          )}
          {exhibitions.length > 1 && (
            <select className={s.select} style={{ width: 'auto' }} aria-label="Exhibition" value={allExhibitions ? 'all' : (exhibitionId ?? '')} onChange={e => setFilters({ ex: e.target.value })}>
              <option value="all">All exhibitions</option>
              {exhibitions.map(x => <option key={x.id} value={x.id}>{exhibitionLabel(x)}</option>)}
            </select>
          )}
          <button type="button" className={s.btn} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(o => !o)}>
            <Filter size={16} aria-hidden="true" /> Filters{filterCount ? ` (${filterCount})` : ''}
          </button>
        </div>

        {filtersOpen && (
          <ReviewSheet
            title="Filters"
            subtitle={waiting ? undefined : `${total} matching lead${total === 1 ? '' : 's'}`}
            onClose={() => setFiltersOpen(false)}
            maxWidth="560px"
            footer={
              <>
                <button type="button" className={s.btn} disabled={filterCount === 0 && !state.q} onClick={clearFilters}>Clear all</button>
                <button type="button" className={`${s.btn} ${s.btnRed}`} style={{ flex: 1 }} onClick={() => setFiltersOpen(false)}>
                  {waiting ? 'Show leads' : `Show ${total} lead${total === 1 ? '' : 's'}`}
                </button>
              </>
            }
          >
          <div className={s.filterSheetBody}>
            <Chips title="Client type" options={CLIENT_TYPES} selected={state.type} onToggle={v => setFilters({ type: toggleIn(state.type, v) })} />
            <Chips title="Requirement" options={REQUIREMENTS} selected={state.req} onToggle={v => setFilters({ req: toggleIn(state.req, v) })} />
            {(data?.cities.length ?? 0) > 0 && (
              <Chips
                title="City" options={(data?.cities ?? []).map(c => ({ value: c, label: c }))} selected={state.city}
                onToggle={v => setFilters({ city: toggleIn(state.city, v) })}
              />
            )}
            <Chips title="Buying timeline" options={BUYING_TIMELINES} selected={state.timeline} onToggle={v => setFilters({ timeline: toggleIn(state.timeline, v) })} />
            <Chips title="Lead type" options={LEAD_TYPES} selected={state.ltype} onToggle={v => setFilters({ ltype: toggleIn(state.ltype, v) })} />
            <Chips title="Status" options={STATUSES} selected={state.status} onToggle={v => setFilters({ status: toggleIn(state.status, v) })} />
            <Chips title="Follow-up" options={FOLLOW_UP_FILTERS} selected={state.follow} onToggle={v => setFilters({ follow: toggleIn(state.follow, v) })} />
            {mode === 'all' && isAdmin && (
              <>
                <Chips
                  title="Original collector" options={(people.data ?? []).map(p => ({ value: p.id, label: p.name }))}
                  selected={state.collector} onToggle={v => setFilters({ collector: toggleIn(state.collector, v) })}
                />
                <Chips
                  title="Current owner" options={(people.data ?? []).map(p => ({ value: p.id, label: p.name }))}
                  selected={state.owner} onToggle={v => setFilters({ owner: toggleIn(state.owner, v) })}
                />
                <Chips
                  title="Record state" options={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'Both' }]}
                  selected={[state.archived]} onToggle={v => setFilters({ archived: v })}
                />
              </>
            )}
          </div>
          </ReviewSheet>
        )}

        <div className={s.matchRow} aria-live="polite">
          <div className={s.matchCount}>{waiting ? 'Loading…' : `${total} matching lead${total === 1 ? '' : 's'}`}</div>
          {(filterCount > 0 || state.q) && (
            <button
              type="button" className={s.linkBtn}
              onClick={clearFilters}
            >Clear filters</button>
          )}
        </div>
        {exportError && <div className={`${s.notice} ${s.noticeErr}`} role="alert">{exportError}</div>}

        {waiting && <div className={s.cards}><div className={s.skeleton} /><div className={s.skeleton} /><div className={s.skeleton} /></div>}
        {page.error && !data && (
          <div className={`${s.notice} ${s.noticeErr}`} role="alert">
            {(page.error as Error).message}
            <div className={s.noticeActions}><button className={s.btn} onClick={() => page.refetch()}>Try again</button></div>
          </div>
        )}
        {!exhibitionId && !allExhibitions && exhibitions.length === 0 && !exhibitionsLoading && (
          <NoExhibitionNotice isAdmin={isAdmin} />
        )}
        {data && rows.length === 0 && (
          <div className={s.empty}>
            {filterCount || state.q ? 'No leads match these filters.' : mode === 'mine' ? 'No leads here yet.' : 'No leads yet.'}
            {mode === 'mine' && !filterCount && !state.q && (
              <div style={{ marginTop: 10 }}><Link href="/exhibition-leads/add" className={`${s.btn} ${s.btnRed}`}>Add Lead</Link></div>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <>
            {/* Phones and narrow screens */}
            <div className={s.cards}>
              {rows.map((l, i) => (
                <Fragment key={l.id}>
                  {renderGroupHead(l, i, rows)}
                  <article className={`${s.card}${l.archived_at ? ` ${s.cardArchived}` : ''}`}>
                    <div className={s.cardTop}>
                      <div>
                        <div className={s.cardName}>{l.contact_name}</div>
                        {l.company_name && <div className={s.cardSub}>{l.company_name}</div>}
                        {allExhibitions && l.exhibition_name && <div className={s.cardSub}>{l.exhibition_name}</div>}
                      </div>
                      <StatusBadge status={l.status} />
                    </div>
                    <div className={s.cardLine}>{formatPhone(l.phone)}</div>
                    <div className={s.cardLine}>{clientTypeText(l)} · {requirementsLabel(l.requirements)}</div>
                    <div className={s.cardMeta}>
                      <LeadTypeBadge leadType={l.lead_type} />
                      {l.project_city && <span className={s.cardSub}>{l.project_city}</span>}
                      {l.archived_at && <span className={`${s.badge} ${s.badgeMuted}`}>Archived</span>}
                    </div>
                    <div className={s.cardSub}><FollowUpText lead={l} today={today} /></div>
                    {mode === 'all' && <div className={s.hint}>Collected by {l.collected_by_name ?? '—'} · Owner {l.owner_name ?? '—'}</div>}
                    <div className={s.cardActions}>
                      <ContactActions phone={l.phone} />
                      <button className={`${s.btn} ${s.btnDark}`} onClick={() => openLead(l.id)}>View / Update</button>
                    </div>
                  </article>
                </Fragment>
              ))}
            </div>

            {/* Desktop table — the same facts */}
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Added</th><th>Contact</th><th>Mobile</th><th>Client / requirement</th><th>City</th>
                    <th>Lead type</th><th>Status</th><th>Follow-up</th>{mode === 'all' && <th>Collected by / Owner</th>}<th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l, i) => (
                    <Fragment key={l.id}>
                      {multiDate && (i === 0 || istDateOf(rows[i - 1].created_at) !== istDateOf(l.created_at)) && (
                        <tr><td colSpan={mode === 'all' ? 10 : 9} style={{ background: '#F4F6F9', fontWeight: 700 }}>
                          {longDate(istDateOf(l.created_at))} · {dateCounts.get(istDateOf(l.created_at)) ?? 0} leads
                        </td></tr>
                      )}
                      <tr className={l.archived_at ? s.rowArchived : undefined}>
                        <td style={{ minWidth: 72 }}>{istDateTime(l.created_at)}</td>
                        <td><strong>{l.contact_name}</strong>{l.company_name && <div className={s.cardSub}>{l.company_name}</div>}{allExhibitions && l.exhibition_name && <div className={s.cardSub}>{l.exhibition_name}</div>}</td>
                        <td className={s.nowrap}>{formatPhone(l.phone)}</td>
                        <td>{clientTypeText(l)}<div className={s.cardSub}>{requirementsLabel(l.requirements)}</div></td>
                        <td className={s.nowrap}>{l.project_city ?? ''}</td>
                        <td><LeadTypeBadge leadType={l.lead_type} /></td>
                        <td><StatusBadge status={l.status} />{l.archived_at && <div className={s.cardSub}>Archived</div>}</td>
                        <td><FollowUpText lead={l} today={today} /></td>
                        {mode === 'all' && <td>{l.collected_by_name ?? '—'}<div className={s.cardSub}>{l.owner_name ?? '—'}</div></td>}
                        <td>
                          <div className={s.tableActions}>
                            <ContactActions phone={l.phone} small iconOnly />
                            <button className={`${s.btn} ${s.btnSm} ${s.btnDark}`} onClick={() => openLead(l.id)}>View / Update</button>
                          </div>
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={s.pager}>
              <div className={s.pagerInfo}>
                Showing {offset + 1}–{offset + rows.length} of {total}
              </div>
              <div className={s.pagerBtns}>
                <button className={s.btn} disabled={state.page <= 1} onClick={() => setState({ page: state.page - 1 })}>Previous</button>
                <span className={s.pagerInfo} style={{ alignSelf: 'center' }}>Page {state.page} of {pageCount}</span>
                <button className={s.btn} disabled={state.page >= pageCount} onClick={() => setState({ page: state.page + 1 })}>Next</button>
              </div>
            </div>
          </>
        )}
      </div>

      {state.lead && (
        <LeadDetailSheet leadId={state.lead} supabase={supabase} isAdmin={isAdmin} onClose={closeLead} />
      )}
    </ExhibitionLeadsLayout>
  )
}
