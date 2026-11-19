'use client'

// Quotations › Requests (owner, 18 Nov 2026): the quotation requests, Pending and Completed, inside the Quotations
// module. The same rows as Tasks › Quotation requests (one read, useQuotationRequests): the owner sees every request,
// Nitish the ones sent to him, a salesperson the ones they raised. A row opens the request in Tasks, where the
// quotation is made ("Make it in Quotations") and sent.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { formatDateIN } from '@/lib/quotations/math'
import { istDateOf } from '@/lib/istDate'
import { requestTabs, type RequestTab } from '@/lib/quotations/requestTabs'
import type { Task } from '@/lib/types'
import s from './quotations.module.css'

const HERE = '/quotations/requests'
const NO_TASKS: Task[] = []
const WAIT_COLOUR: Record<WaitBand, string> = { fresh: 'var(--boe-text-muted)', aging: '#805B0D', late: '#B42332' }
const PRIORITY_COLOUR: Record<string, string> = { high: '#A12438', medium: '#805B0D', low: 'var(--boe-text-muted)' }

export default function RequestsScreen() {
  const { profile, loading, signOut, access } = useQuotations()
  const { ready, userId, role, permissionsByModule } = usePermissionContext()
  const router = useRouter()
  const [tab, setTab] = useState<RequestTab>('pending')
  const [q, setQ] = useState('')
  const [now] = useState(() => Date.now())

  const caps = useMemo(() => deriveQuotationCapabilities(role, permissionsByModule.get('task_management') ?? []), [role, permissionsByModule])
  const { data, isPending, isError } = useQuotationRequests(userId, ready && caps.canViewQuotations, caps.canSeeAllQuotations)
  const rows = data?.rows ?? NO_TASKS
  const { data: names = {} } = useUserNames(useMemo(() => [...new Set(rows.flatMap(t => [t.assigned_to, t.created_by]))], [rows]))
  const tabs = useMemo(() => requestTabs(rows, q), [rows, q])

  if (loading || !ready) return <LoadingScreen />
  const person = (id: string) => names[id]?.trim() || '…'
  const visible = tabs[tab]

  return (
    <QuotationsLayout
      profile={profile} access={access} onSignOut={signOut}
      title="Quotation requests"
      subtitle={data ? `${tabs.pending.length} pending · ${tabs.completed.length} completed` : undefined}
      actions={caps.canCreateQuotations ? (
        <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => router.push('/tasks/quotation-requests/new')}><Plus size={16} aria-hidden /> New request</button>
      ) : undefined}
    >
      <div className={s.wrap}>
        {!caps.canViewQuotations ? (
          <div className={s.card}><div className={s.empty}>
            <Inbox size={28} aria-hidden />
            <h3>No quotation requests for you</h3>
            <div>Requests appear here for the people who send them and the people who make the quotations.</div>
          </div></div>
        ) : (
          <div className={s.card}>
            <div className={s.tabs} role="tablist">
              <button className={s.tab} role="tab" aria-selected={tab === 'pending'} onClick={() => setTab('pending')}>Pending <span className={s.muted}>{tabs.pending.length}</span></button>
              <button className={s.tab} role="tab" aria-selected={tab === 'completed'} onClick={() => setTab('completed')}>Completed <span className={s.muted}>{tabs.completed.length}</span></button>
            </div>
            <div className={s.toolbar}>
              <label className={s.search} style={{ position: 'relative' }}>
                <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--boe-text-muted)' }} aria-hidden />
                <input className={s.input} style={{ paddingLeft: 32 }} placeholder="Search lead, company, note" value={q} onChange={e => setQ(e.target.value)} aria-label="Search quotation requests" />
              </label>
            </div>
            {isPending && !data && <div className={s.empty}>Loading requests…</div>}
            {(isError || (data && !data.complete)) && (
              <div className={s.cardBody}><div className={`${s.notice} ${s.noticeBad}`} role="alert">Quotation requests could not be loaded in full. Check your connection and try again.</div></div>
            )}
            {data && visible.length === 0 && (
              <div className={s.empty}>
                <Inbox size={28} aria-hidden />
                <h3>{q.trim() ? 'Nothing matches' : tab === 'pending' ? 'No pending requests' : 'No completed requests yet'}</h3>
                <div>{q.trim() ? 'Change the search.' : tab === 'pending' ? 'New requests from the sales team arrive here.' : 'A request moves here once its quotation is sent.'}</div>
              </div>
            )}
            {visible.length > 0 && (
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr>
                    <th>Lead</th><th className={s.desktopOnly}>From</th><th className={s.desktopOnly}>Sent to</th>
                    <th>Priority</th><th>{tab === 'pending' ? 'Waiting' : 'Completed'}</th>
                  </tr></thead>
                  <tbody>{visible.map(t => {
                    const open = () => router.push(taskDetailHref(t.id, HERE))
                    const wait = tab === 'pending' ? quotationWait(t.created_at, now) : null
                    return (
                      <tr key={t.id} onClick={open} onKeyDown={e => { if (e.key === 'Enter') open() }} tabIndex={0}>
                        <td>
                          <div className={s.name}>{t.customer_name || t.title}</div>
                          <div className={s.sub}>{[t.company_name, t.city_project].filter(Boolean).join(' · ') || t.note?.trim() || ' '}</div>
                          <div className={`${s.sub} ${s.mobileOnly}`}>{person(t.created_by)} → {person(t.assigned_to)}</div>
                        </td>
                        <td className={`${s.desktopOnly} ${s.small}`}>{person(t.created_by)}</td>
                        <td className={`${s.desktopOnly} ${s.small}`}><b>{person(t.assigned_to)}</b></td>
                        <td className={s.small}><span style={{ color: PRIORITY_COLOUR[t.priority] ?? 'inherit', fontWeight: t.priority === 'high' ? 700 : 500, textTransform: 'capitalize' }}>{t.priority}</span></td>
                        <td className={`${s.small} ${s.num}`}>
                          {wait
                            ? <span style={{ color: WAIT_COLOUR[wait.band], fontWeight: wait.band === 'fresh' ? 500 : 700 }}>{wait.label}</span>
                            : t.last_update_at ? formatDateIN(istDateOf(t.last_update_at)) : '—'}
                        </td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </QuotationsLayout>
  )
}
