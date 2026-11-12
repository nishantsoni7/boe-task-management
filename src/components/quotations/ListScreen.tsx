'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, ImageIcon, Plus, Search } from 'lucide-react'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import {
  CLIENT_TYPES, STATUS_LABEL, createQuotation, errorText, fetchList, pictureUrl, quotationKeys, type ListRow, type QuotationStatus,
} from '@/lib/quotations/api'
import { SUPPLY_STATES, formatDateIN } from '@/lib/quotations/math'
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
  const closeNew = () => router.replace('/quotations')

  return (
    <QuotationsLayout
      profile={profile} access={access} onSignOut={signOut}
      title="Quotations" subtitle={listQ.isSuccess ? `${counts.open} open · ${formatINR(openValue)} before GST` : undefined}
      actions={access.create ? <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => router.push('/quotations?new=1')}><Plus size={16} /> New quotation</button> : undefined}
    >
      <div className={s.wrap}>
        {notSetUp && <div className={`${s.notice} ${s.noticeWarn}`}><b>Quotations is being set up.</b> Its database part has not been applied yet. Once it is, this page fills in by itself.</div>}
        {!notSetUp && accessError && <div className={`${s.notice} ${s.noticeBad}`}>{errorText(accessError)}</div>}
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
      {showNew && <NewQuotation onClose={closeNew} onCreated={id => router.push(`/quotations/${id}`)} create={data => createQuotation(supabase, data)} />}
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

function NewQuotation({ onClose, onCreated, create }: {
  onClose: () => void; onCreated: (id: string) => void
  create: (d: { client_name: string; project_name?: string; contact_name?: string; contact_phone?: string; contact_role?: string; client_type?: string; supply_state?: string }) => Promise<string>
}) {
  const qc = useQueryClient()
  const [f, setF] = useState({ client_name: '', project_name: '', contact_name: '', contact_phone: '', contact_role: '', client_type: '', supply_state: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF(p => ({ ...p, [k]: e.target.value }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!f.client_name.trim()) { setErr('Enter the client’s name.'); return }
    setBusy(true); setErr('')
    try {
      const id = await create(f)
      await qc.invalidateQueries({ queryKey: ['quotations', 'list'] })
      onCreated(id)
    } catch (x) { setErr(errorText(x)); setBusy(false) }
  }
  return (
    <div className={s.scrim} onClick={onClose}>
      <form className={s.modal} onClick={e => e.stopPropagation()} onSubmit={submit} aria-labelledby="newq-title">
        <div className={s.cardHead}><h2 id="newq-title">New quotation</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <div className={s.grid2}>
            <label className={s.field}><span>Client *</span><input id="newq-client" className={s.input} value={f.client_name} onChange={set('client_name')} placeholder="Babylon Resort" autoFocus /></label>
            <label className={s.field}><span>Project</span><input id="newq-project" className={s.input} value={f.project_name} onChange={set('project_name')} placeholder="Resort, Shamshabad" /></label>
            <label className={s.field}><span>Contact person</span><input id="newq-contact" className={s.input} value={f.contact_name} onChange={set('contact_name')} placeholder="Who decides or forwards it" /></label>
            <label className={s.field}><span>Contact phone</span><input id="newq-phone" className={s.input} value={f.contact_phone} onChange={set('contact_phone')} inputMode="tel" placeholder="For the WhatsApp link" /></label>
            <label className={s.field}><span>Their role</span><input id="newq-role" className={s.input} value={f.contact_role} onChange={set('contact_role')} placeholder="Architect, owner, purchase…" /></label>
            <label className={s.field}><span>Client type</span><select id="newq-type" className={s.input} value={f.client_type} onChange={set('client_type')}><option value="">Choose…</option>{CLIENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>
          <label className={s.field}><span>Delivery state (decides CGST + SGST or IGST)</span><input id="newq-state" className={s.input} list="newq-states" value={f.supply_state} onChange={set('supply_state')} placeholder="Telangana" /><datalist id="newq-states">{SUPPLY_STATES.map(x => <option key={x} value={x} />)}</datalist></label>
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          <button type="button" className={s.btn} onClick={onClose}>Cancel</button>
          <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={busy}>{busy ? 'Starting…' : 'Start quotation'}</button>
        </div>
      </form>
    </div>
  )
}
