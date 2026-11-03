'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Upload } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { enumParam, idParam, optionParam, textParam, type ParamCodec } from '@/lib/listState'
import {
  allotLead, fetchLeadPage, fetchPeople, SALES_KEY, SalesRequestError,
  type LeadPage, type SalesLead,
} from '@/lib/salesLeads/api'
import { allotStep } from '@/lib/salesLeads/allot'
import { LEAD_SOURCES, LEAD_SOURCE_VALUES, PAGE_SIZE, PERIODS, PERIOD_KEYS, type Period } from '@/lib/salesLeads/constants'
import { initialsOf, plural } from '@/lib/salesLeads/format'
import { istToday } from '@/lib/istDate'
import { createClient } from '@/lib/supabase/client'
import { ConfirmChange } from './AllotParts'
import { LeadPanel } from './LeadPanel'
import { LeadTable } from './LeadTable'
import { SalesFrame } from './SalesFrame'
import { useToast } from './useToast'
import s from './salesLeads.module.css'

// The Lead Master: every lead, newest first, and who holds it. The period cards and the "Allotted to" chips are the
// filters (the URL keeps them). Leads are allotted here, from the name dropdown on each row: the first name saves at
// once, and changing a name that is already there asks first.

const holderId = idParam()
/** '' = everyone, 'none' = not allotted yet, or a user id. */
const holderParam: ParamCodec<string> = {
  parse: raw => (raw === 'none' ? 'none' : holderId.parse(raw)),
  serialize: value => (value === 'none' ? 'none' : holderId.serialize(value)),
}

const LIST_PARAMS = {
  period: enumParam(PERIOD_KEYS, 'today'),
  holder: holderParam,
  source: optionParam(LEAD_SOURCE_VALUES),
  q: textParam(),
}

const WHEN_WORDS: Record<Period, string> = { today: 'today', week: 'in the last 7 days', month: 'in the last 30 days', all: 'so far' }

function WhoChip({ pressed, label, count, kind, onClick }: {
  pressed: boolean; label: string; count: number | null; kind: 'all' | 'none' | 'person'; onClick: () => void
}) {
  const cls = `${s.who}${kind === 'all' ? ` ${s.whoAll}` : ''}${kind === 'none' ? ` ${s.whoNone}` : ''}`
  return (
    <button type="button" className={cls} aria-pressed={pressed} onClick={onClick}>
      {kind === 'person' && <span className="fin-avatar" aria-hidden="true">{initialsOf(label)}</span>}
      {kind === 'none' && <span className="fin-dot fin-dot--zero" aria-hidden="true" />}
      {label} <span className={s.count}>{count ?? '–'}</span>
    </button>
  )
}

export function LeadMasterScreen() {
  const { ready } = usePermissionContext()
  const { canCreate, canEdit, canAssign } = useSalesAccess()
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { state, setState } = useListUrlState(LIST_PARAMS)
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(state.q, next => setState({ q: next }))
  const [openId, setOpenId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ lead: SalesLead; toId: string } | null>(null)
  /** Allotments being saved: lead id → the person it is being saved to. Several can run at once. */
  const [saving, setSaving] = useState<Record<string, string>>({})
  const toast = useToast()
  const today = istToday()
  // A search looks through every day: a person looking for a number that came in last week must find it.
  const searching = state.q !== ''
  const period: Period = searching ? 'all' : state.period

  const people = useQuery({
    queryKey: [SALES_KEY, 'people'],
    queryFn: () => fetchPeople(supabase),
    staleTime: 5 * 60_000,
    enabled: ready,
  })

  const list = useInfiniteQuery({
    queryKey: [SALES_KEY, 'list', period, state.holder, state.source, state.q],
    queryFn: ({ pageParam }) => fetchLeadPage(supabase, {
      period, holder: state.holder, source: state.source, q: state.q, limit: PAGE_SIZE, offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (last: LeadPage, all: LeadPage[]) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    enabled: ready,
  })

  const first = list.data?.pages[0]
  const rows = useMemo(() => {
    // A lead added while the list is open can shift a later page by one: never show a row twice.
    const seen = new Map<string, SalesLead>()
    for (const page of list.data?.pages ?? []) for (const r of page.rows) if (!seen.has(r.id)) seen.set(r.id, r)
    return [...seen.values()]
  }, [list.data])

  const peopleList = useMemo(() => people.data ?? [], [people.data])
  const chips = useMemo(() => {
    const held = new Map((first?.holders ?? []).map(h => [h.id, h]))
    const named = peopleList.map(p => ({ id: p.id, name: p.full_name, n: held.get(p.id)?.n ?? 0 }))
    // Somebody who still holds leads but no longer counts as a sales candidate is still a name to filter by.
    const extra = (first?.holders ?? []).filter(h => !peopleList.some(p => p.id === h.id)).map(h => ({ id: h.id, name: h.name, n: h.n }))
    return [...named, ...extra]
  }, [first, peopleList])
  const nameOf = (id: string) => peopleList.find(p => p.id === id)?.full_name ?? 'this person'
  const holderName = state.holder && state.holder !== 'none' ? chips.find(c => c.id === state.holder)?.name ?? null : null

  async function allot(lead: SalesLead, toId: string) {
    setSaving(s => ({ ...s, [lead.id]: toId }))
    try {
      await allotLead(supabase, lead.id, toId, lead.assigned_to)
      toast.show(lead.assigned_to
        ? `Lead #${lead.lead_no} moved from ${lead.holder_name ?? 'its holder'} to ${nameOf(toId)}`
        : `Lead #${lead.lead_no} allotted to ${nameOf(toId)}`)
    } catch (e) {
      toast.show(e instanceof SalesRequestError ? e.message : 'Something went wrong. Nothing was changed.', true)
    }
    try {
      // Either way the list is read again (a refused change means the screen was out of date), and the row keeps
      // showing the person it was saved to until the fresh list is in: never the old name with an "allotted" toast.
      await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
    } finally {
      setSaving(s => { const next = { ...s }; delete next[lead.id]; return next })
      // Only this lead's own question closes: another lead finishing must not take away one still being asked.
      setPending(p => (p && p.lead.id === lead.id ? null : p))
    }
  }

  function pick(lead: SalesLead, toId: string) {
    const step = allotStep(lead.assigned_to, toId)
    if (step === 'save') void allot(lead, toId)
    else if (step === 'confirm') setPending({ lead, toId })
  }

  const hasFilters = state.q !== '' || state.holder !== '' || state.source !== ''
  const periods = first?.periods

  let body: React.ReactNode
  if (!ready || (list.isPending && !first)) {
    body = <LoadingScreen message="Loading leads..." />
  } else if (list.isError && !first) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">The leads could not be loaded</p>
        <p>Check your connection and try again.</p>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={() => list.refetch()}>Try again</button>
      </div>
    )
  } else {
    body = (
      <div className={s.wrap}>
        <div className="fin-stats" role="group" aria-label="Leads received">
          {PERIODS.map(p => (
            <button key={p.key} type="button" className="fin-stat" aria-pressed={!searching && state.period === p.key} onClick={() => setState({ period: p.key })}>
              <span className="fin-stat-label">{p.label}</span>
              <span className="fin-stat-value" style={{ display: 'block' }}>{periods ? periods[p.key].toLocaleString('en-IN') : '—'}</span>
              <span className="fin-stat-sub" style={{ display: 'block' }}>{periods?.[p.key] === 1 ? 'lead' : 'leads'}</span>
            </button>
          ))}
        </div>

        <section className="fin-board" aria-label="Leads">
          <div className="fin-viewbar">
            <div className="fin-tools" role="search" aria-label="Search leads">
              <label className="boe-list-search">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#686D6C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="search"
                  aria-label="Search leads"
                  placeholder="Phone, name, email or location"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onBlur={flushSearch}
                />
                {searchInput && <button type="button" className="boe-list-search-clear" aria-label="Clear search" onClick={() => { setSearchInput(''); setState({ q: '' }) }}>✕</button>}
              </label>
              <select
                className={`${s.sourceSelect}${state.source ? ` ${s.sourceSet}` : ''}`}
                aria-label="Source"
                value={state.source}
                onChange={e => setState({ source: e.target.value as typeof state.source })}
              >
                <option value="">All sources</option>
                {LEAD_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="fin-count">{first ? plural(first.total, 'lead') : ''}</span>
              {(canCreate || canAssign) && (
                <div className={s.headActions}>
                  {canAssign && <Link className={`boe-btn boe-btn-secondary ${s.add}`} href="/sales/import"><Upload aria-hidden="true" />Import from ClickUp</Link>}
                  {canCreate && <Link className={`boe-btn boe-btn-primary ${s.add}`} href="/sales/lead-master/new"><Plus aria-hidden="true" />Add lead</Link>}
                </div>
              )}
            </div>
          </div>

          <div className={s.whoBar} role="group" aria-label="Allotted to">
            <span className={s.whoLabel}>Allotted to</span>
            <WhoChip kind="all" label="Everyone" count={first?.everyone ?? null} pressed={state.holder === ''} onClick={() => setState({ holder: '' })} />
            <WhoChip kind="none" label="Not allotted" count={first?.unallotted ?? null} pressed={state.holder === 'none'} onClick={() => setState({ holder: 'none' })} />
            {chips.map(c => (
              <WhoChip key={c.id} kind="person" label={c.name} count={c.n} pressed={state.holder === c.id} onClick={() => setState({ holder: c.id })} />
            ))}
          </div>

          {canAssign && people.isError && (
            <div className="boe-callout boe-callout-error" role="alert" style={{ margin: 12 }}>
              <div>
                <span className="boe-callout-title">The Sales team could not be loaded</span>
                <span>Without it a lead cannot be allotted. <button type="button" className="boe-btn boe-btn-secondary" onClick={() => people.refetch()}>Try again</button></span>
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <LeadTable rows={rows} people={peopleList} canAssign={canAssign} today={today} saving={saving} onOpen={l => setOpenId(l.id)} onPick={pick} />
          )}

          {rows.length === 0 && (
            <div className={s.empty} style={{ display: 'block' }}>
              {hasFilters
                ? <>No lead matches. <button type="button" className="boe-btn boe-btn-secondary" onClick={() => { setSearchInput(''); setState({ holder: '', source: '', q: '' }) }}>Clear the filters</button></>
                : <>No leads {WHEN_WORDS[period]} yet.{canCreate && <> <Link className="boe-btn boe-btn-secondary" href="/sales/lead-master/new">Add a lead</Link></>}</>}
            </div>
          )}

          <div className="fin-footer">
            <span>
              {first ? plural(first.total, 'lead') : 'No leads'} received {WHEN_WORDS[period]}
              {state.holder === 'none' ? ', not allotted yet' : holderName ? `, allotted to ${holderName}` : ''}. Newest first.
              {searching && ' A search looks through every day.'}
            </span>
            {list.hasNextPage && (
              <button type="button" className="boe-btn boe-btn-secondary" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'Loading…' : `Show more (${(first?.total ?? 0) - rows.length} left)`}
              </button>
            )}
          </div>
        </section>
      </div>
    )
  }

  return (
    <SalesFrame title="Lead Master" subtitle="Every lead, and who holds it">
      {body}
      {openId && (
        <LeadPanel
          leadId={openId}
          people={peopleList}
          canAssign={canAssign}
          canEdit={canEdit}
          saving={saving}
          onClose={() => setOpenId(null)}
          onPick={pick}
          onSaved={toast.show}
        />
      )}
      {pending && (
        <ConfirmChange
          lead={pending.lead}
          fromName={pending.lead.holder_name ?? 'its holder'}
          toName={nameOf(pending.toId)}
          saving={pending.lead.id in saving}
          onConfirm={() => void allot(pending.lead, pending.toId)}
          onCancel={() => setPending(null)}
        />
      )}
      {toast.node}
    </SalesFrame>
  )
}
