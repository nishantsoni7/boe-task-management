'use client'

// ── /finance/reimbursements — every expense reimbursement done so far ────────
//
// One line per reimbursement (a challan that paid one person back for several
// of their expenses): the date, the challan ID, who was paid, how many
// expenses, the total, and whether it still stands or was reversed. A line
// opens the same reimbursement window the Expenses page uses, where it can be
// downloaded or — by someone who may reimburse — reversed.
//
// WHO: finance.reimburse with company-wide Finance sight (admins hold both
// through the admin branch). The database decides every row independently: the
// batches are readable only with view_all (or by whoever recorded one).
//
// Read-only except the reversal inside the window. Nothing here edits or deletes
// an expense.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { Toast, useToast } from '@/components/ui/toast'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveFinanceCapabilities, NO_FINANCE_CAPABILITIES } from '@/lib/permissions/finance'
import { mayRecordReimbursement } from '@/lib/finance/expenseReimbursements'
import {
  downloadWorkbook,
  reimbursementExportFileName,
  type ExportBatch,
} from '@/lib/finance/expenseReimbursementExport'
import { exactToString, sumExact } from '@/lib/finance/exactMoney'
import { formatMoney, localTodayIso } from '@/lib/finance/piPaymentView'
import type { UserProfile } from '@/lib/types'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import { ReimbursementBatchModal } from '@/app/finance/expenses/ExpenseReimbursementModals'
import { EMPTY_BATCH_FILTERS, loadAllBatches, loadPeopleNames, loadReimbursementSheets, type BatchFilters } from './reimbursementData'

const PAGE_SIZE = 50

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  const at = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function ReimbursementsView() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState(NO_FINANCE_CAPABILITIES)
  const [booting, setBooting] = useState(true)

  const [filters, setFilters] = useState<BatchFilters>(EMPTY_BATCH_FILTERS)
  const [searchTerm, setSearchTerm] = useState('')
  const [batches, setBatches] = useState<ExportBatch[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [payers, setPayers] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  // The page number is keyed by the filters it was chosen under: change any of
  // them and the page is 0 again, with no reset in an effect.
  const pageKey = JSON.stringify(filters)
  const [pageState, setPageState] = useState({ key: pageKey, page: 0 })
  const page = pageState.key === pageKey ? pageState.page : 0

  const mayUse = mayRecordReimbursement(caps)

  // ── who is this, and may they be here ──
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const [{ data: me }, perms] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
      ])
      if (!alive) return
      setProfile(me as UserProfile)
      setCaps(deriveFinanceCapabilities(me?.role, perms))
      setBooting(false)
    })()
    return () => { alive = false }
  }, [supabase, router])

  // The search box waits for a pause in typing before it asks the database.
  useEffect(() => {
    const t = setTimeout(() => setFilters(prev => (prev.search === searchTerm ? prev : { ...prev, search: searchTerm })), 300)
    return () => clearTimeout(t)
  }, [searchTerm])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await loadAllBatches(supabase, filters)
      const people = await loadPeopleNames(supabase, rows.flatMap(b => [b.payer_id, b.recorded_by]))
      setBatches(rows)
      setNames(people)
    } catch (e) {
      setBatches([])
      setError(e instanceof Error ? e.message : 'The reimbursements could not be loaded. Use Refresh to try again.')
    }
    setLoading(false)
  }, [supabase, filters])

  useEffect(() => {
    if (!mayUse) return
    // A FETCH IS STARTED HERE; NO STATE IS SET HERE (every setState inside load
    // runs after its first await), so it goes through a named local.
    const startFetch = () => { void load() }
    startFetch()
  }, [mayUse, load])

  useEffect(() => {
    if (!mayUse) return
    let alive = true
    ;(async () => {
      const { data } = await supabase.from('users').select('id, full_name').eq('is_active', true).order('full_name')
      if (!alive) return
      setPayers(((data ?? []) as { id: string; full_name: string | null }[]).map(u => ({ id: u.id, name: u.full_name || '—' })))
    })()
    return () => { alive = false }
  }, [supabase, mayUse])

  const nameOf = useCallback((id: string | null | undefined) => (id && names.get(id)) || payers.find(p => p.id === id)?.name || '—', [names, payers])

  // A reversed reimbursement paid nothing, so it is not in the total.
  const live = batches.filter(b => b.status === 'recorded')
  const liveTotal = exactToString(sumExact(live.map(b => b.total_amount)))
  const liveExpenses = live.reduce((n, b) => n + b.expense_count, 0)

  const pages = Math.max(1, Math.ceil(batches.length / PAGE_SIZE))
  const shown = batches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const narrowed = JSON.stringify(filters) !== JSON.stringify(EMPTY_BATCH_FILTERS)

  const download = async () => {
    if (downloading || batches.length === 0) return
    setDownloading(true)
    try {
      const sheets = await loadReimbursementSheets(supabase, batches)
      await downloadWorkbook(reimbursementExportFileName('all', localTodayIso()), sheets)
    } catch (e) {
      show(e instanceof Error ? e.message : 'The Excel file could not be made. Try again.', 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (booting) return <FinanceRouteFallback />

  if (!mayUse) {
    return (
      <FinanceLayout profile={profile} title="Reimbursements" onSignOut={handleSignOut}>
        <FinanceEmpty
          icon="file"
          role="alert"
          title="You do not have access to Reimbursements"
          body="Reimbursements show what the company has paid back to staff. Ask an administrator to grant you Reimburse Expenses in Control Center."
        />
      </FinanceLayout>
    )
  }

  return (
    <FinanceLayout
      profile={profile}
      title="Reimbursements"
      subtitle="Every expense reimbursement done so far"
      onSignOut={handleSignOut}
      onRefresh={load}
      actions={
        <button className="boe-btn boe-btn-primary" data-testid="download-all-reimbursements"
          disabled={downloading || loading || batches.length === 0} onClick={() => void download()}>
          {downloading ? 'Preparing…' : 'Download Excel'}
        </button>
      }
    >
      <div className="boe-list-toolbar" role="search" aria-label="Filter reimbursements">
        <label className="boe-list-search">
          <input
            type="search"
            aria-label="Search by challan ID"
            placeholder="Search challan ID"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </label>
        <div className="boe-list-daterange" role="group" aria-label="Reimbursement date">
          <label className="boe-list-date">
            <span>From</span>
            <input type="date" className="boe-input" aria-label="Reimbursed on or after" value={filters.dateFrom}
              onChange={e => setFilters(prev => ({ ...prev, dateFrom: e.target.value }))} />
          </label>
          <label className="boe-list-date">
            <span>to</span>
            <input type="date" className="boe-input" aria-label="Reimbursed on or before" value={filters.dateTo}
              onChange={e => setFilters(prev => ({ ...prev, dateTo: e.target.value }))} />
          </label>
        </div>
        <select className="boe-input expense-filter-select" aria-label="Filter by who was paid" value={filters.payerId}
          onChange={e => setFilters(prev => ({ ...prev, payerId: e.target.value }))}>
          <option value="">Anyone paid</option>
          {payers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="boe-input expense-filter-select" aria-label="Filter by status" value={filters.status}
          onChange={e => setFilters(prev => ({ ...prev, status: e.target.value as BatchFilters['status'] }))}>
          <option value="">Reimbursed and reversed</option>
          <option value="recorded">Reimbursed</option>
          <option value="reversed">Reversed</option>
        </select>
        {narrowed && (
          <button type="button" className="boe-btn boe-btn-ghost boe-list-clear"
            onClick={() => { setSearchTerm(''); setFilters(EMPTY_BATCH_FILTERS) }}>
            Clear filters
          </button>
        )}
      </div>

      <div data-testid="reimbursements-total" style={{ margin: '10px 0', fontSize: '13px' }}>
        {loading || error ? '—' : (
          <>
            <strong>{live.length}</strong> {live.length === 1 ? 'reimbursement' : 'reimbursements'} ·{' '}
            <strong>{liveExpenses}</strong> {liveExpenses === 1 ? 'expense' : 'expenses'} ·{' '}
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(liveTotal)}</strong> paid back
            {batches.length !== live.length ? ` (${batches.length - live.length} reversed not counted)` : ''}
          </>
        )}
      </div>

      <div className="boe-card" style={{ overflowX: 'auto' }}>
        {error ? (
          <FinanceEmpty icon="file" role="alert" title="Reimbursements could not be loaded" body={error} />
        ) : loading ? (
          <div style={{ padding: '24px', fontSize: '13px' }} role="status">Loading…</div>
        ) : batches.length === 0 ? (
          <FinanceEmpty
            icon="check"
            title={narrowed ? 'No reimbursement matches these filters' : 'No reimbursement has been recorded yet'}
            body={narrowed ? undefined : 'Select pending expenses on the Expenses page and record a reimbursement with its challan ID.'}
          />
        ) : (
          <table className="fin-table" data-testid="reimbursements-table" style={{ minWidth: '720px' }}>
            <thead>
              <tr>
                <th style={{ width: 120 }}>Date</th>
                <th>Challan ID</th>
                <th>Paid to</th>
                <th className="fin-num" style={{ width: 90 }}>Expenses</th>
                <th className="fin-num" style={{ width: 140 }}>Total</th>
                <th style={{ width: 120 }}>Status</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(b => (
                <tr key={b.id} tabIndex={0} style={{ cursor: 'pointer' }}
                  onClick={() => setOpened(b.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpened(b.id) } }}>
                  <td>{fmtDate(b.reimbursed_on)}</td>
                  <td><span className="fin-primary-text">{b.reference}</span></td>
                  <td>{nameOf(b.payer_id)}</td>
                  <td className="fin-num">{b.expense_count}</td>
                  <td className="fin-num"><span className="fin-amount">{formatMoney(b.total_amount)}</span></td>
                  <td><span className={`fin-pill fin-pill--${b.status === 'reversed' ? 'over' : 'full'}`}>{b.status === 'reversed' ? 'Reversed' : 'Reimbursed'}</span></td>
                  <td className="fin-muted">{nameOf(b.recorded_by)} · {fmtDate(b.recorded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !error && pages > 1 && (
          <div className="bank-pager">
            <button className="boe-btn boe-btn-ghost" disabled={page === 0} onClick={() => setPageState({ key: pageKey, page: page - 1 })}>Previous</button>
            <span className="fin-muted">Page {page + 1} of {pages}</span>
            <button className="boe-btn boe-btn-ghost" disabled={page >= pages - 1} onClick={() => setPageState({ key: pageKey, page: page + 1 })}>Next</button>
          </div>
        )}
      </div>

      {opened && (
        <ReimbursementBatchModal
          supabase={supabase}
          reimbursementId={opened}
          personName={nameOf}
          mayReverse={mayUse}
          onClose={() => setOpened(null)}
          onReversed={() => { show('Reimbursement reversed — its expenses are pending again'); void load() }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}
