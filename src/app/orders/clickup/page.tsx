'use client'

// DRAFT ORDERS (CLICKUP) — owner, 2026-11-13. ClickUp's "Running Orders" list is
// being copied into BOE One before the subscription ends: kept here as DRAFTS,
// apart from Confirmed Orders, payments and dispatch, so they can be tested and
// read. Administrators only; the routes ask for the role again.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { AppLink } from '@/components/ui/AppLink'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { downloadWorkbook } from '@/lib/finance/expenseReimbursementExport'
import { DRAFT_STATUS_TABS, dayIst, draftWorkbook, inr, statusLabel, type DraftOrder } from '@/lib/orders/clickupDrafts'
import { callDrafts } from './callDrafts'
import styles from './clickupDrafts.module.css'

type Row = Pick<DraftOrder, 'id' | 'order_no' | 'name' | 'client_name' | 'status' | 'assignees' | 'due_date' | 'fields' | 'file_count' | 'comment_count'>

const ALL = 'all'

export default function ClickupDraftsPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { profile } = usePermissionContext()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [tab, setTab] = useState<string>('running orders')
  const [q, setQ] = useState('')
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    void callDrafts<{ rows: Row[] }>('/api/orders/clickup-drafts').then(r => {
      if (r.ok) setRows(r.body.rows)
      else setProblem(r.message)
    })
  }, [])

  const handleSignOut = async () => { await supabase.auth.signOut(); router.replace('/login') }

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const r of rows ?? []) c.set(r.status, (c.get(r.status) ?? 0) + 1)
    return c
  }, [rows])

  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => (rows ?? [])
    .filter(r => (tab === ALL || r.status === tab)
      && (!needle || [r.order_no ?? '', r.name, r.client_name, ...r.assignees].some(v => v.toLowerCase().includes(needle))))
    .sort((a, b) => Number(b.order_no ?? 0) - Number(a.order_no ?? 0) || a.name.localeCompare(b.name)),
  [rows, tab, needle])

  const downloadExcel = async () => {
    setDownloading(true)
    const all = await callDrafts<{ rows: DraftOrder[] }>('/api/orders/clickup-drafts?full=1')
    if (all.ok) await downloadWorkbook('Draft Orders (ClickUp).xlsx', draftWorkbook(all.body.rows.sort((a, b) => Number(b.order_no ?? 0) - Number(a.order_no ?? 0))))
    else setProblem(all.message)
    setDownloading(false)
  }

  return (
    <OrdersLayout profile={profile} title="Draft Orders (ClickUp)" onSignOut={handleSignOut} showRefresh={false}
      phoneSubtitle={rows ? `${rows.length} orders copied from ClickUp` : undefined}>
      <div className="opp-page">
        <p className="opp-sub">
          Orders copied from ClickUp&apos;s Running Orders list, with their client details, comments and files (and when each file
          was uploaded). They are drafts: nothing here is a Confirmed Order, a payment or a dispatch.
        </p>

        {problem && <p className="opp-warn" role="alert">{problem}</p>}
        {rows === null && !problem && <p className="opp-note" role="status">Loading…</p>}

        {rows && (
          <>
            <div className={styles.bar}>
              <div className={styles.tabs} role="tablist" aria-label="Status">
                {DRAFT_STATUS_TABS.map(t => (
                  <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                    className={`${styles.tab}${tab === t.key ? ` ${styles.tabOn}` : ''}`} onClick={() => setTab(t.key)}>
                    {t.label} <span className={styles.count}>{counts.get(t.key) ?? 0}</span>
                  </button>
                ))}
                <button type="button" role="tab" aria-selected={tab === ALL}
                  className={`${styles.tab}${tab === ALL ? ` ${styles.tabOn}` : ''}`} onClick={() => setTab(ALL)}>
                  All <span className={styles.count}>{rows.length}</span>
                </button>
              </div>
              <div className={styles.right}>
                <button type="button" className="boe-btn boe-btn-secondary" disabled={downloading || rows.length === 0} onClick={() => void downloadExcel()}>
                  {downloading ? 'Preparing…' : 'Download Excel'}
                </button>
                <AppLink href="/orders/clickup/import" className="boe-btn boe-btn-primary">Import from backup folder</AppLink>
              </div>
            </div>

            <input className={`boe-input boe-list-search ${styles.grow}`} placeholder="Search order number, client or person" value={q}
              onChange={e => setQ(e.target.value)} aria-label="Search draft orders" />

            {rows.length === 0 && <p className="opp-note">No draft orders yet. Use Import from backup folder to copy the ClickUp export in.</p>}
            {rows.length > 0 && shown.length === 0 && <p className="opp-note">Nothing matches.</p>}
            {shown.length > 0 && (
              <div className="opp-scroll">
                <table className="opp-table opp-bdpi-table">
                  <thead>
                    <tr>
                      <th>Order</th><th>Client</th><th>Status</th><th>Assigned</th><th>Confirm date</th><th>Due</th>
                      <th className="opp-num">Total value</th><th>Fabric / Finish</th><th className="opp-num">Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(r => (
                      <tr key={r.id} className="opp-row-link" onClick={() => router.push(`/orders/clickup/${r.id}`)}>
                        <td><AppLink href={`/orders/clickup/${r.id}`} onClick={e => e.stopPropagation()}><strong>{r.order_no ?? '—'}</strong></AppLink></td>
                        <td>{r.client_name}</td>
                        <td><span className={styles.pill}>{statusLabel(r.status)}</span></td>
                        <td>{r.assignees.join(', ') || '—'}</td>
                        <td>{dayIst(r.fields['Confirm Date'] ?? null)}</td>
                        <td>{dayIst(r.due_date)}</td>
                        <td className="opp-num">{inr(r.fields['Total Product Value'])}</td>
                        <td>{[r.fields['FABRIC STATUS'], r.fields['FINISH STATUS']].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="opp-num">{r.file_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </OrdersLayout>
  )
}
