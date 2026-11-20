'use client'

// Quotations › Requests (owner, 20 Nov 2026): the quotations sent to a senior, inside the Quotations module. A salesperson sees the ones they
// sent and how long each has waited; Nitish sees the ones sent to him; the owner sees all. "Waiting" and "Completed" are separate tabs. A row
// opens the quotation itself: the senior prices it there and sends it back. Requests made before 20 Nov were Tasks: they stay readable under
// "Earlier requests" (read-only history, opened in Tasks); nobody can make a new one there.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Inbox, Plus, Search } from 'lucide-react'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useQuotationRequests } from '@/hooks/queries/useQuotationRequests'
import { useUserNames } from '@/hooks/queries/useMyTasks'
import { deriveQuotationCapabilities } from '@/lib/permissions/quotations'
import { quotationWait, type WaitBand } from '@/lib/tasks/quotationWait'
import { taskDetailHref } from '@/lib/tasks/taskReturnPath'
import { ASK_LABEL, askKeys, errorText, fetchRequests, type RequestRow } from '@/lib/quotations/api'
import { formatINR } from '@/lib/currency'
import { formatDateIN } from '@/lib/quotations/math'
import { istDateOf } from '@/lib/istDate'
import { requestTabs } from '@/lib/quotations/requestTabs'
import type { Task } from '@/lib/types'
import s from './quotations.module.css'

const HERE = '/quotations/requests'
const NO_TASKS: Task[] = []
const WAIT_COLOUR: Record<WaitBand, string> = { fresh: 'var(--boe-text-muted)', aging: '#805B0D', late: '#B42332' }
type Tab = 'waiting' | 'done' | 'earlier'

export default function RequestsScreen() {
  const { supabase, profile, loading, signOut, access, accessLoaded } = useQuotations()
  const { ready, userId, role, permissionsByModule } = usePermissionContext()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('waiting')
  const [q, setQ] = useState('')
  const [now] = useState(() => Date.now())

  const list = useQuery({ queryKey: askKeys.list, queryFn: () => fetchRequests(supabase), enabled: accessLoaded, staleTime: 20_000 })
  const rows = useMemo(() => list.data ?? [], [list.data])
  const needle = q.trim().toLowerCase()
  const match = (r: RequestRow) => !needle || [r.quote_no, r.client_name, r.project_name, r.from_name, r.to_name, r.note].some(v => (v ?? '').toLowerCase().includes(needle))
  const waiting = useMemo(() => rows.filter(r => r.status === 'pending').filter(match), [rows, needle]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => rows.filter(r => r.status !== 'pending').filter(match), [rows, needle]) // eslint-disable-line react-hooks/exhaustive-deps

  // The Task-based requests of before 20 Nov: read only when the tab is opened.
  const caps = useMemo(() => deriveQuotationCapabilities(role, permissionsByModule.get('task_management') ?? []), [role, permissionsByModule])
  const old = useQuotationRequests(userId, ready && caps.canViewQuotations && tab === 'earlier', caps.canSeeAllQuotations)
  const oldRows = old.data?.rows ?? NO_TASKS
  const { data: names = {} } = useUserNames(useMemo(() => [...new Set(oldRows.flatMap(t => [t.assigned_to, t.created_by]))], [oldRows]))
  const oldTabs = useMemo(() => requestTabs(oldRows, q), [oldRows, q])
  const person = (id: string) => names[id]?.trim() || '…'

  if (loading) return <LoadingScreen />
  const visible = tab === 'waiting' ? waiting : done
  const open = (r: RequestRow) => router.push(`/quotations/${r.quotation_id}`)

  return (
    <QuotationsLayout
      profile={profile} access={access} onSignOut={signOut} title="Requests"
      subtitle={list.isSuccess ? `${rows.filter(r => r.status === 'pending').length} waiting · ${rows.filter(r => r.status === 'answered').length} completed` : undefined}
      actions={access.create ? <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => router.push('/quotations?new=1')}><Plus size={16} aria-hidden /> New quotation</button> : undefined}
    >
      <div className={s.wrap}>
        <div className={s.card}>
          <div className={s.tabs} role="tablist">
            <button className={s.tab} role="tab" aria-selected={tab === 'waiting'} onClick={() => setTab('waiting')}>Waiting <span className={s.muted}>{waiting.length}</span></button>
            <button className={s.tab} role="tab" aria-selected={tab === 'done'} onClick={() => setTab('done')}>Completed <span className={s.muted}>{done.length}</span></button>
            {caps.canViewQuotations && <button className={s.tab} role="tab" aria-selected={tab === 'earlier'} onClick={() => setTab('earlier')}>Earlier requests</button>}
          </div>
          <div className={s.toolbar}>
            <label className={s.search} style={{ position: 'relative' }}>
              <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--boe-text-muted)' }} aria-hidden />
              <input className={s.input} style={{ paddingLeft: 32 }} placeholder="Search client, number, person, note" value={q} onChange={e => setQ(e.target.value)} aria-label="Search requests" />
            </label>
          </div>

          {tab !== 'earlier' && (
            <>
              {list.isLoading && <div className={s.empty}>Loading requests…</div>}
              {list.isError && <div className={s.cardBody}><div className={`${s.notice} ${s.noticeBad}`} role="alert">{errorText(list.error)}</div></div>}
              {list.isSuccess && visible.length === 0 && (
                <div className={s.empty}>
                  <Inbox size={28} aria-hidden />
                  <h3>{needle ? 'Nothing matches' : tab === 'waiting' ? 'Nothing is waiting' : 'No completed requests yet'}</h3>
                  <div>{needle ? 'Change the search.' : tab === 'waiting' ? 'Open a quotation and use “Ask a senior” to send it for prices.' : 'A request moves here once the senior sends the quotation back.'}</div>
                </div>
              )}
              {visible.length > 0 && (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead><tr><th>Quotation</th><th className={s.desktopOnly}>From</th><th className={s.desktopOnly}>Sent to</th><th>Needs</th><th className={s.right}>Before GST</th><th>{tab === 'waiting' ? 'Waiting' : 'Completed'}</th></tr></thead>
                    <tbody>{visible.map(r => {
                      const wait = r.status === 'pending' ? quotationWait(r.created_at, now) : null
                      const mine = r.to_id === userId && r.status === 'pending'
                      return (
                        <tr key={r.id} onClick={() => open(r)} onKeyDown={e => { if (e.key === 'Enter') open(r) }} tabIndex={0}>
                          <td>
                            <div className={s.name}>{r.project_name || r.client_name}{mine && <span className={s.chip} style={{ marginLeft: 8 }}>Waiting for you</span>}</div>
                            <div className={`${s.sub} ${s.num}`}>{r.quote_no}{r.lead_no ? ` · Lead ${r.lead_no}` : ''}{r.project_name ? ` · ${r.client_name}` : ''}</div>
                            <div className={`${s.sub} ${s.mobileOnly}`}>{r.from_name} → {r.to_name}</div>
                            {r.note && <div className={s.sub}>“{r.note}”</div>}
                          </td>
                          <td className={`${s.desktopOnly} ${s.small}`}>{r.from_name}</td>
                          <td className={`${s.desktopOnly} ${s.small}`}><b>{r.to_name}</b></td>
                          <td className={s.small}>{ASK_LABEL[r.kind]}</td>
                          <td className={`${s.right} ${s.num}`}>{formatINR(Number(r.value || 0))}</td>
                          <td className={`${s.small} ${s.num}`}>
                            {wait ? <span style={{ color: WAIT_COLOUR[wait.band], fontWeight: wait.band === 'fresh' ? 500 : 700 }}>{wait.label}</span>
                              : r.status === 'withdrawn' ? 'Withdrawn' : r.answered_at ? formatDateIN(istDateOf(r.answered_at)) : '—'}
                          </td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'earlier' && (
            <>
              <div className={s.cardBody}><div className={`${s.small} ${s.muted}`}>Requests made in Task Management before 20 November 2026. They stay here to read; new ones are made from a quotation.</div></div>
              {old.isPending && !old.data && <div className={s.empty}>Loading requests…</div>}
              {oldRows.length > 0 && (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead><tr><th>Lead</th><th className={s.desktopOnly}>From</th><th className={s.desktopOnly}>Sent to</th><th>Status</th><th>Raised</th></tr></thead>
                    <tbody>{[...oldTabs.pending, ...oldTabs.completed].map(t => (
                      <tr key={t.id} onClick={() => router.push(taskDetailHref(t.id, HERE))} onKeyDown={e => { if (e.key === 'Enter') router.push(taskDetailHref(t.id, HERE)) }} tabIndex={0}>
                        <td><div className={s.name}>{t.customer_name || t.title}</div><div className={s.sub}>{[t.company_name, t.city_project].filter(Boolean).join(' · ') || ' '}</div></td>
                        <td className={`${s.desktopOnly} ${s.small}`}>{person(t.created_by)}</td>
                        <td className={`${s.desktopOnly} ${s.small}`}>{person(t.assigned_to)}</td>
                        <td className={s.small}>{t.status === 'completed' ? 'Completed' : 'Pending'}</td>
                        <td className={`${s.small} ${s.num}`}>{formatDateIN(istDateOf(t.created_at))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {old.data && oldRows.length === 0 && <div className={s.empty}><Inbox size={28} aria-hidden /><h3>No earlier requests</h3></div>}
            </>
          )}
        </div>
      </div>
    </QuotationsLayout>
  )
}
