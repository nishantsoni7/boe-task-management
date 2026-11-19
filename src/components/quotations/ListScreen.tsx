'use client'

import { PriceQueue } from './PricingDesk'
import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, FileUp, ImageIcon, Plus, Search } from 'lucide-react'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import {
  STATUS_LABEL, errorText, fetchList, fetchQuotation, pictureUrl, quotationKeys, saveDoc, saveQuotation, setStatus, startQuotation,
  type ListRow, type QuotationStatus,
} from '@/lib/quotations/api'
import { formatDateIN, gstModeForState } from '@/lib/quotations/math'
import { ImportDialog } from './ImportDialog'
import { LeadStep, leadName, type StartChoice } from './LeadStep'
import s from './quotations.module.css'
import { Pic } from './Pic'

type StatusFilter = 'open' | 'all' | QuotationStatus
const OPEN: QuotationStatus[] = ['draft', 'sent', 'negotiating']
const FILTERS: [StatusFilter, string][] = [['open', 'Open'], ['draft', 'Draft'], ['sent', 'Sent'], ['negotiating', 'Negotiating'], ['confirmed', 'Confirmed'], ['lost', 'Lost'], ['archived', 'Archived'], ['all', 'All']]

export const StatusPill = ({ status }: { status: QuotationStatus }) => <span className={`${s.pill} ${s[`st_${status}`]}`}>{STATUS_LABEL[status]}</span>

export default function ListScreen() {
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp, accessError } = useQuotations()
  const router = useRouter()
  const params = useSearchParams()
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [filter, setFilter] = useState<StatusFilter>('open')
  const [q, setQ] = useState('')
  // Every quotation starts from a Sales lead (20 Nov 2026): "file" = choose the lead, then read the client's file (Excel, PDF, photo).
  const [flow, setFlow] = useState<'file' | null>(null)
  const [picked, setPicked] = useState<StartChoice | null>(null)
  const qc = useQueryClient()

  const listQ = useQuery({ queryKey: quotationKeys.list(scope), queryFn: () => fetchList(supabase, scope), enabled: accessLoaded, staleTime: 20_000 })
  const rows = useMemo(() => listQ.data ?? [], [listQ.data])
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: rows.length, open: rows.filter(r => OPEN.includes(r.status)).length }
    for (const r of rows) m[r.status] = (m[r.status] ?? 0) + 1
    return m
  }, [rows])
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter(r => (filter === 'all' ? true : filter === 'open' ? OPEN.includes(r.status) : r.status === filter))
      .filter(r => !needle || [r.quote_no, r.client_name, r.project_name, r.owner_name].some(v => (v ?? '').toLowerCase().includes(needle)))
  }, [rows, filter, q])
  const openValue = useMemo(() => rows.filter(r => OPEN.includes(r.status)).reduce((t, r) => t + Number(r.value_before_gst || 0), 0), [rows])

  if (loading) return <LoadingScreen />
  const showNew = params.get('new') === '1' && access.create
  // The desk (edit + see all) and Admin may put a quotation on a salesperson's page, e.g. an Excel quotation they were sent.
  const canAssign = access.admin || (access.edit && access.view_all)
  const begin = async (c: StartChoice) => {
    const id = await startQuotation(supabase, c.lead.id, { ownerId: c.ownerId })
    await qc.invalidateQueries({ queryKey: ['quotations', 'list'] })
    router.push(`/quotations/${id}`)
  }
  // The History API, not router.replace: on a page opened straight at ?new=1 (the menu's New quotation, a refresh),
  // router.replace left ?new=1 in the address, so Cancel and × did nothing.
  const closeNew = () => window.history.replaceState(null, '', '/quotations')

  return (
    <QuotationsLayout
      profile={profile} access={access} onSignOut={signOut}
      title="Quotations" subtitle={listQ.isSuccess ? `${counts.open} open · ${formatINR(openValue)} before GST` : undefined}
      actions={access.create ? (
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={s.btn} onClick={() => setFlow('file')} disabled={!profile}><FileUp size={16} aria-hidden /> Start from a client file</button>
          <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => router.push('/quotations?new=1')}><Plus size={16} /> New quotation</button>
        </span>
      ) : undefined}
    >
      <div className={s.wrap}>
        {notSetUp && <div className={`${s.notice} ${s.noticeWarn}`}><b>Quotations is being set up.</b> Its database part has not been applied yet. Once it is, this page fills in by itself.</div>}
        {!notSetUp && accessError && <div className={`${s.notice} ${s.noticeBad}`}>{errorText(accessError)}</div>}
        {!notSetUp && accessLoaded && (access.admin || (access.edit && access.view_all)) && <PriceQueue supabase={supabase} />}
        {!notSetUp && accessLoaded && (
          <div className={s.card}>
            {(access.view_all || access.admin) && (
              <div className={s.tabs} role="tablist">
                <button className={s.tab} role="tab" aria-selected={scope === 'mine'} onClick={() => setScope('mine')}>My quotations</button>
                <button className={s.tab} role="tab" aria-selected={scope === 'all'} onClick={() => setScope('all')}>Everyone&apos;s</button>
              </div>
            )}
            <div className={s.toolbar}>
              <label className={s.search} style={{ position: 'relative' }}>
                <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--boe-text-muted)' }} aria-hidden />
                <input className={s.input} style={{ paddingLeft: 32 }} placeholder="Search number, client, project" value={q} onChange={e => setQ(e.target.value)} aria-label="Search quotations" />
              </label>
              {FILTERS.map(([k, label]) => (
                <button key={k} className={s.fchip} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label} <span className={s.muted}>{counts[k] ?? 0}</span></button>
              ))}
            </div>
            {listQ.isLoading && <div className={s.empty}>Loading quotations…</div>}
            {listQ.isError && <div className={s.cardBody}><div className={`${s.notice} ${s.noticeBad}`}>{errorText(listQ.error)}</div></div>}
            {listQ.isSuccess && visible.length === 0 && (
              <div className={s.empty}>
                <FileText size={28} aria-hidden />
                <h3>{rows.length === 0 ? 'No quotations yet' : 'Nothing matches'}</h3>
                <div>{rows.length === 0 ? 'Start one from the client’s requirement: room types, products, prices.' : 'Change the search or the status filter.'}</div>
                {rows.length === 0 && access.create && <div style={{ marginTop: 12 }}><button className={`${s.btn} ${s.btnPrimary}`} onClick={() => router.push('/quotations?new=1')}><Plus size={16} /> New quotation</button></div>}
              </div>
            )}
            {visible.length > 0 && (
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th aria-label="Picture" /><th>Quotation</th><th className={s.desktopOnly}>Client</th><th className={s.right}>Before GST</th><th>Status</th><th className={s.desktopOnly}>Last activity</th>{scope === 'all' && <th className={s.desktopOnly}>Owner</th>}</tr></thead>
                  <tbody>{visible.map(r => <Row key={r.id} r={r} scope={scope} url={p => pictureUrl(supabase, p)} onOpen={() => router.push(`/quotations/${r.id}`)} />)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {showNew && profile && <LeadStep supabase={supabase} userId={profile.id} canAssign={canAssign} title="New quotation" action="Start quotation" onClose={closeNew} onPick={begin} />}
      {flow === 'file' && profile && !picked && (
        <LeadStep supabase={supabase} userId={profile.id} canAssign={canAssign} askSent={canAssign} title="Start from a client file" action="Choose the file"
          onClose={() => setFlow(null)} onPick={async c => { setPicked(c) }} />
      )}
      {flow === 'file' && profile && picked && (
        <ImportDialog supabase={supabase} userId={profile.id} areas={[]} start lead={{ name: leadName(picked.lead) }} onClose={() => { setPicked(null); setFlow(null) }}
          onAdd={async (areas, lines, info) => {
            // The quotation from the lead (the client's details are the lead's), then its rooms and products in one save; the builder opens on it.
            const id = await startQuotation(supabase, picked.lead.id, { ownerId: picked.ownerId, source: 'Client file' })
            const q = await fetchQuotation(supabase, id)
            const header = {
              ...q.header, project_name: info.project_name.trim() || q.header.project_name, supply_state: info.supply_state || q.header.supply_state,
              gst_mode: info.supply_state ? gstModeForState(info.supply_state) : q.header.gst_mode, project_type: info.project_type || q.header.project_type,
            }
            await saveQuotation(supabase, id, saveDoc(header, areas, lines, q.updated_at))
            // A quotation that already went out as Excel: record it as Sent (the date of the first send is today; the owner can reopen it).
            if (picked.alreadySent) await setStatus(supabase, id, 'sent', 'Added from a quotation already sent to the client')
            await qc.invalidateQueries({ queryKey: ['quotations', 'list'] })
            router.push(`/quotations/${id}`)
          }} />
      )}
    </QuotationsLayout>
  )
}

function Row({ r, scope, url, onOpen }: { r: ListRow; scope: 'mine' | 'all'; url: (p: string) => string; onOpen: () => void }) {
  const day = (iso: string) => formatDateIN(istDateOf(iso))
  return (
    <tr onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen() }} tabIndex={0}>
      <td>{r.first_image ? <Pic className={s.thumb} src={url(r.first_image)} alt="" lazy /> : <span className={s.thumbEmpty}><ImageIcon size={16} aria-hidden /></span>}</td>
      <td><div className={s.name}>{r.project_name || r.client_name}</div><div className={`${s.sub} ${s.num}`}>{r.quote_no} · {Number(r.line_count)} lines</div></td>
      <td className={s.desktopOnly}><div>{r.client_name}</div></td>
      <td className={`${s.right} ${s.num}`}><b>{formatINR(Number(r.value_before_gst || 0))}</b></td>
      <td><StatusPill status={r.status} /></td>
      <td className={`${s.desktopOnly} ${s.small}`}>{r.last_opened_at ? <>Opened by the client {day(r.last_opened_at)}</> : <>Changed {day(r.updated_at)}</>}</td>
      {scope === 'all' && <td className={`${s.desktopOnly} ${s.small}`}>{r.owner_name}</td>}
    </tr>
  )
}
