'use client'

// OLD ORDERS (BDPI) — owner, 2026-10-29. Orders that were never uploaded into
// the app get the same Payment plan: upload the old PI's workbook here, and it
// is kept as BDPI-0001, BDPI-0002, … with its lines, pictures and details.
//
// Who may see / upload is the database's answer (bdpi_list, create_bdpi:
// view_payment_plan / edit_payment_plan). The capabilities read here only
// decide what is drawn.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities, type OrdersCapabilities } from '@/lib/permissions/orders'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatPaise } from '@/lib/orders/paymentPlan'
import type { UserProfile } from '@/lib/types'

type Row = {
  id: string
  bdpi_no: string
  old_order_no: string
  client_name: string
  grand_total: number | null
  ordered_qty: number
  dispatched_qty: number
  lots_dispatched: number
  has_planned: boolean
}

const money = (v: number | null) => (v === null ? '—' : formatPaise(Math.round(Number(v) * 100)))

export default function BdpiListPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState<OrdersCapabilities | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [q, setQ] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [oldNo, setOldNo] = useState('')
  const [client, setClient] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; openId?: string } | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('bdpi_list')
    if (error) { setUnreadable(true); return }
    setUnreadable(false)
    setRows((data ?? []) as Row[])
  }, [supabase])

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, perms] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
      ])
      if (!live) return
      const meRow = me.data as UserProfile | null
      if (meRow) setProfile(meRow)
      const c = deriveOrdersCapabilities(meRow?.role, perms)
      setCaps(c)
      if (c.canViewPaymentPlan) await load()
    })()
    return () => { live = false }
  }, [supabase, router, load])

  const upload = async () => {
    if (!file) { setMessage({ kind: 'error', text: 'Choose the PI file first.' }); return }
    setBusy(true); setMessage(null)
    const body = new FormData()
    body.set('file', file)
    body.set('old_order_no', oldNo)
    body.set('client_name', client)
    try {
      const res = await fetch('/api/orders/bdpi/import', { method: 'POST', body })
      const json = await res.json().catch(() => ({})) as { id?: string; bdpiNo?: string; notes?: string[]; message?: string }
      if (!res.ok || !json.id) {
        setMessage({ kind: 'error', text: json.message ?? 'The PI could not be uploaded. Please try again.' })
      } else {
        const notes = (json.notes ?? []).join(' ')
        setMessage({ kind: 'ok', text: `${json.bdpiNo} saved.${notes ? ` ${notes}` : ''}`, openId: json.id })
        setFile(null); setOldNo(''); setClient('')
        await load()
      }
    } catch {
      setMessage({ kind: 'error', text: 'The PI could not be uploaded. Please check the connection and try again.' })
    }
    setBusy(false)
  }

  const handleSignOut = async () => { await supabase.auth.signOut(); router.replace('/login') }

  const needle = q.trim().toLowerCase()
  const shown = (rows ?? []).filter(r => !needle
    || [r.bdpi_no, r.old_order_no, r.client_name].some(v => v.toLowerCase().includes(needle)))

  return (
    <OrdersLayout profile={profile} title="Old orders (BDPI)" onSignOut={handleSignOut} showRefresh={false}>
      <div className="opp-page">
        {caps && !caps.canViewPaymentPlan && (
          <p className="opp-warn" role="alert">You do not have access to old orders. An Admin can grant &quot;View Payment plan&quot; in Control Center.</p>
        )}
        {caps?.canViewPaymentPlan && (
          <>
            <p className="opp-sub">
              Orders that were never uploaded into the app. Upload the old PI (the usual PI format) to get the same
              Payment plan: dispatch lots, what is paid in account and in cash, and what is still due.
            </p>

            {caps.canEditPaymentPlan && (
              <section className="opp" aria-label="New BDPI">
                <h2 className="opp-title">New BDPI</h2>
                <div className="opp-inputs">
                  <label className="opp-field">
                    <span>PI file (.xlsx)</span>
                    <input type="file" accept=".xlsx" disabled={busy} onChange={e => { setMessage(null); setFile(e.target.files?.[0] ?? null) }} />
                  </label>
                  <label className="opp-field">
                    <span>Old order number <em>blank = taken from the PI</em></span>
                    <input className="boe-input" value={oldNo} maxLength={60} disabled={busy} onChange={e => setOldNo(e.target.value)} />
                  </label>
                  <label className="opp-field">
                    <span>Client <em>blank = Bill-to name on the PI</em></span>
                    <input className="boe-input" value={client} maxLength={200} disabled={busy} onChange={e => setClient(e.target.value)} />
                  </label>
                </div>
                <div className="opp-actions">
                  <button type="button" className="boe-btn boe-btn-primary" disabled={busy || !file} onClick={() => void upload()}>
                    {busy ? 'Uploading…' : 'Upload and create BDPI'}
                  </button>
                  <span className="opp-hint">Payments recorded in Finance against this old order number are picked up automatically.</span>
                </div>
                {message && (
                  <p className={message.kind === 'ok' ? 'opp-note' : 'opp-warn'} role={message.kind === 'ok' ? 'status' : 'alert'}>
                    {message.text}{' '}
                    {message.openId && (
                      <button type="button" className="opp-link" onClick={() => router.push(`/orders/bdpi/${message.openId}`)}>Open it</button>
                    )}
                  </p>
                )}
              </section>
            )}

            <section className="opp" aria-label="Old orders">
              <div className="opp-head">
                <h2 className="opp-title">Old orders{rows ? ` (${rows.length})` : ''}</h2>
                <input className="boe-input boe-list-search" placeholder="Search BDPI, old order or client" value={q}
                  onChange={e => setQ(e.target.value)} aria-label="Search old orders" />
              </div>
              {unreadable && <p className="opp-warn" role="alert">The list could not be read. Please reload.</p>}
              {rows === null && !unreadable && <p className="opp-note" role="status">Loading…</p>}
              {rows && shown.length === 0 && <p className="opp-note">{rows.length === 0 ? 'No old orders yet. Upload the first PI above.' : 'Nothing matches.'}</p>}
              {shown.length > 0 && (
                <div className="opp-scroll">
                  <table className="opp-table opp-bdpi-table">
                    <thead>
                      <tr>
                        <th>BDPI</th><th>Old order</th><th>Client</th>
                        <th className="opp-num">PI total</th>
                        <th className="opp-num">Pieces sent</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map(r => {
                        const done = Number(r.ordered_qty) > 0 && Number(r.dispatched_qty) >= Number(r.ordered_qty)
                        return (
                          <tr key={r.id} className="opp-row-link" tabIndex={0}
                            onClick={() => router.push(`/orders/bdpi/${r.id}`)}
                            onKeyDown={e => { if (e.key === 'Enter') router.push(`/orders/bdpi/${r.id}`) }}>
                            <td><strong>{r.bdpi_no}</strong></td>
                            <td>{r.old_order_no}</td>
                            <td>{r.client_name}</td>
                            <td className="opp-num">{money(r.grand_total)}</td>
                            <td className="opp-num">{Number(r.dispatched_qty)} of {Number(r.ordered_qty)}</td>
                            <td>{done ? 'All sent' : r.has_planned ? 'Lot planned' : r.lots_dispatched > 0 ? `${r.lots_dispatched} lot(s) sent` : 'Nothing sent'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </OrdersLayout>
  )
}
