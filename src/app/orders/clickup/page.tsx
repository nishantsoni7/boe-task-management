'use client'

// DRAFT ORDERS (CLICKUP) — owner, 2026-11-13. ClickUp's "Running Orders" list is
// being copied into BOE One before the subscription ends: kept here as DRAFTS,
// apart from Confirmed Orders, payments and dispatch, so they can be tested and
// read. Administrators only; the routes ask for the role again.
//
// The list itself is drawn by ./DraftsList (the Finance list design, redesigned
// 2026-11-17). This page reads the data and keeps the status card and the search in
// the address, so Back from an order returns to the same view.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumParam, textParam } from '@/lib/listState'
import { downloadWorkbook } from '@/lib/finance/expenseReimbursementExport'
import { DRAFT_ALL, DRAFT_STATUS_TABS, draftWorkbook, type DraftListRow, type DraftOrder } from '@/lib/orders/clickupDrafts'
import { callDrafts } from './callDrafts'
import { DraftsList } from './DraftsList'

const DEFAULT_TAB = 'running orders'
const TABS = [...DRAFT_STATUS_TABS.map(t => t.key as string), DRAFT_ALL]
const LIST_PARAMS = { status: enumParam<string>(TABS, DEFAULT_TAB), q: textParam() }

function ClickupDraftsList() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { profile } = usePermissionContext()
  const [rows, setRows] = useState<DraftListRow[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  // The data is read here in the browser, so a card or a search changes the address without asking the server again.
  const { state, setState, resetState } = useListUrlState(LIST_PARAMS, { shallow: true })
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(state.q, next => setState({ q: next }))

  useEffect(() => {
    void callDrafts<{ rows: DraftListRow[] }>('/api/orders/clickup-drafts').then(r => {
      if (r.ok) setRows(r.body.rows)
      else setProblem(r.message)
    })
  }, [])

  const handleSignOut = async () => { await supabase.auth.signOut(); router.replace('/login') }

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
          Orders copied from ClickUp, with their client details, comments and files. They are drafts: nothing here is a
          Confirmed Order, a payment or a dispatch.
        </p>

        {problem && <p className="opp-warn" role="alert">{problem}</p>}
        {rows === null && !problem && <p className="opp-note" role="status">Loading…</p>}

        {rows && (
          <DraftsList
            rows={rows} tab={state.status} query={searchInput}
            onTab={status => setState({ status })} onQuery={setSearchInput} onQueryBlur={flushSearch}
            onClear={() => { setSearchInput(''); resetState() }}
            onOpen={id => router.push(`/orders/clickup/${id}`)}
            onDownload={() => void downloadExcel()} downloading={downloading}
          />
        )}
      </div>
    </OrdersLayout>
  )
}

// useSearchParams (the address state) needs a Suspense boundary.
export default function ClickupDraftsPage() {
  return <Suspense fallback={<OrdersRouteFallback />}><ClickupDraftsList /></Suspense>
}
