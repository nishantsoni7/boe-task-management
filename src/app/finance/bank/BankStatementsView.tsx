'use client'

// ── /finance/bank — Bank Statements ─────────────────────────────────────────
//
// THREE JOBS, ONE SCREEN:
//   Money in            every credit of the month and whether it is Synced into
//                       Confirmed Payments, Not Synced (with the reason), or
//                       does not need it (an Old order, Not customer money).
//   Not in the bank     recorded payments of the month no bank credit has been
//                       linked to — the other direction of the same check.
//   Money out           the debits, so the balances can be seen to add up.
//
// SYNC: uploading a statement adds each new customer credit to Confirmed Payments
// (sync_bank_credits, which reuses the Add to Confirmed rules and refuses
// duplicates); "Check sync" repeats it for the month and lists what could not be
// synced. LINKING an existing payment to a credit is NOT done here: it is done in
// Confirmed Payments. This page never verifies or approves anything itself; the
// database verifies only for an admin / verify_own_payment holder, as it does for
// the Add to Confirmed button.
//
// WHO: finance.reconcile (protected; admins hold it through the admin branch).
// The database refuses everyone else regardless of what this page draws.
//
// SIZE: one account, one month at a time. A month is a few hundred lines, so the
// month is read whole (capped at 2,000) and paged on screen, 50 at a time.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { Toast, useToast } from '@/components/ui/toast'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveFinanceCapabilities, NO_FINANCE_CAPABILITIES } from '@/lib/permissions/finance'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL, DEBIT_KIND_LABEL, type BankAccountKey, type DebitKind } from '@/lib/finance/bankStatement'
import { payerFromNarration } from '@/lib/finance/bankMatching'
import { payeeFromDebitNarration } from '@/lib/finance/bankStatement'
import { toPaise } from '@/lib/finance/bankMoney'
import type { UserProfile } from '@/lib/types'
import { FinanceEmpty, FinanceStatusCards, FilterChip } from '@/app/finance/components/FinanceListParts'
import {
  STATUS_TONE,
  activeLinks,
  analyseLine,
  formatBankDate,
  linkedTotal,
  loadCandidateExpenses,
  loadCandidatePayments,
  loadImportSyncableIds,
  loadMonthLines,
  loadPayerHistory,
  loadStoredRange,
  monthLabel,
  monthOf,
  monthsBetween,
  rpcMessage,
  statusLabelFor,
  syncBankCredits,
  syncState,
  SYNC_NOT_YET,
  type BankExpense,
  type BankLine,
  type BankPayment,
  type LineWithSuggestions,
  type SyncResult,
} from './bankStatementsModel'
import type { PayerHistoryEntry } from '@/lib/finance/bankOrderHistory'
import { BankLineModal } from './bankLineModal'
import { BankAddConfirmedModal } from './bankAddConfirmedModal'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { BankUploadModal } from './bankUploadModal'

const PAGE_SIZE = 50

type CardKey = 'all' | 'not_synced' | 'synced' | 'old_order' | 'not_customer'
const CARD_LABEL: Record<CardKey, string> = {
  all: 'All credits', not_synced: 'Not synced', synced: 'Synced', old_order: 'Old orders', not_customer: 'Not customer money',
}
const SYNC_PILL: Record<'synced' | 'not_synced' | 'not_needed', { tone: 'full' | 'over' | 'neutral'; label: string }> = {
  synced: { tone: 'full', label: 'Synced' },
  not_synced: { tone: 'over', label: 'Not Synced' },
  not_needed: { tone: 'neutral', label: 'Not needed' },
}

/** The card a credit is counted under. A credit marked, or looking like, non-customer money counts as Not customer money. */
function bucket(a: LineWithSuggestions): Exclude<CardKey, 'all'> {
  if (a.status === 'old_order') return 'old_order'
  if (a.status === 'not_customer' || a.nonCustomer) return 'not_customer'
  return syncState(a) === 'synced' ? 'synced' : 'not_synced'
}
type OutCardKey = 'all' | 'unexplained' | 'suggested' | 'linked' | 'not_expense'
type Tab = 'in' | 'payments' | 'out'

export function BankStatementsView() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState(NO_FINANCE_CAPABILITIES)
  const [booting, setBooting] = useState(true)

  const [account, setAccount] = useState<BankAccountKey>('hdfc')
  // The stored date range is remembered WITH the account it belongs to, so
  // switching account reads as "not loaded yet" without resetting state in an effect.
  const [rangeFor, setRangeFor] = useState<{ account: BankAccountKey; range: { first: string; last: string } | null } | null>(null)
  const range = rangeFor?.account === account ? rangeFor.range : undefined
  const [month, setMonth] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('in')
  const [card, setCard] = useState<CardKey>('all')
  const [outCard, setOutCard] = useState<OutCardKey>('all')
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)
  const [search, setSearch] = useState('')
  // The page number is keyed by the filters it was chosen under: change any of
  // them and the page is 0 again, with no reset in an effect.
  const pageKey = `${account}|${month}|${tab}|${card}|${outCard}|${search}`
  const [pageState, setPageState] = useState({ key: pageKey, page: 0 })
  const page = pageState.key === pageKey ? pageState.page : 0
  const setPage = (p: number) => setPageState({ key: pageKey, page: p })

  // One month's data, tagged with the (account, month) it answers. `loading` is
  // "the data on screen answers a different question", so a reload after a write
  // replaces it in place instead of flashing the list away.
  const dataKey = `${account}|${month}`
  const [data, setData] = useState<{ key: string; lines: BankLine[]; payments: BankPayment[]; expenses: BankExpense[]; history: PayerHistoryEntry[]; error: string | null } | null>(null)
  const loading = month !== null && data?.key !== dataKey
  const lines = useMemo(() => (data?.key === dataKey ? data.lines : []), [data, dataKey])
  const payments = useMemo(() => (data?.key === dataKey ? data.payments : []), [data, dataKey])
  const expenses = useMemo(() => (data?.key === dataKey ? data.expenses : []), [data, dataKey])
  const history = useMemo(() => (data?.key === dataKey ? data.history : []), [data, dataKey])
  const loadError = data?.key === dataKey ? data.error : null

  const [opened, setOpened] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncReport, setSyncReport] = useState<SyncResult | null>(null)
  // Bumped when a sync finishes after an upload, so the month is read again.
  const [syncTick, setSyncTick] = useState(0)

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

  // ── which months does this account have ──
  const loadRange = useCallback(async (acct: BankAccountKey, preferMonth?: string) => {
    try {
      const r = await loadStoredRange(supabase, acct)
      setRangeFor({ account: acct, range: r })
      setMonth(prev => {
        if (preferMonth) return preferMonth
        if (!r) return null
        const m = prev && prev >= monthOf(r.first) && prev <= monthOf(r.last) ? prev : monthOf(r.last)
        return m
      })
    } catch {
      setRangeFor({ account: acct, range: null })
    }
  }, [supabase])

  useEffect(() => {
    if (!caps.canReconcileBank) return
    // A FETCH IS STARTED HERE; NO STATE IS SET HERE (every setState inside
    // loadRange runs after its first await). react-hooks/set-state-in-effect cannot
    // see through the await, so the call goes through a named local, as the
    // customer-reviews screens and Data Management do.
    const startFetch = () => { void loadRange(account) }
    startFetch()
  }, [account, caps.canReconcileBank, loadRange])

  // ── the month's lines and candidate payments ──
  const loadMonth = useCallback(async () => {
    if (!month) return
    const key = `${account}|${month}`
    try {
      const ls = await loadMonthLines(supabase, account, month)
      const linked = [...new Set(ls.filter(l => l.deposit > 0).flatMap(l => activeLinks(l).map(k => k.payment_id ?? '')))].filter(Boolean)
      const linkedExpenses = [...new Set(ls.filter(l => l.withdrawal > 0).flatMap(l => activeLinks(l).map(k => k.expense_id ?? '')))].filter(Boolean)
      const [ps, es] = await Promise.all([
        loadCandidatePayments(supabase, month, linked),
        loadCandidateExpenses(supabase, month, linkedExpenses),
      ])
      // Which order earlier money from the same payers went to. A suggestion
      // only: if it cannot be read the page still works, without it.
      const unlinkedNarrations = ls.filter(l => l.deposit > 0 && l.classification === null && activeLinks(l).length === 0).map(l => l.narration)
      const hist = await loadPayerHistory(supabase, unlinkedNarrations).catch(() => [])
      setData({ key, lines: ls, payments: ps, expenses: es, history: hist, error: null })
    } catch (e) {
      setData({ key, lines: [], payments: [], expenses: [], history: [], error: e instanceof Error ? e.message : 'This month could not be loaded.' })
    }
  }, [supabase, account, month])

  useEffect(() => {
    if (!caps.canReconcileBank || range === undefined) return
    const startFetch = () => { void loadMonth() }
    startFetch()
  }, [caps.canReconcileBank, range, loadMonth, syncTick])

  // ── derived ──
  const credits = useMemo(() => lines.filter(l => l.deposit > 0), [lines])
  const debits = useMemo(() => lines.filter(l => l.withdrawal > 0), [lines])
  const analysed = useMemo<LineWithSuggestions[]>(() => credits.map(l => analyseLine(l, payments, [], history)), [credits, payments, history])

  const counts = useMemo(() => {
    const c = { all: analysed.length, not_synced: 0, synced: 0, old_order: 0, not_customer: 0 }
    for (const a of analysed) c[bucket(a)]++
    return c
  }, [analysed])

  const money = useMemo(() => {
    let notSynced = 0
    for (const a of analysed) {
      if (bucket(a) === 'not_synced') notSynced += toPaise(a.line.deposit)
    }
    return notSynced / 100
  }, [analysed])

  const notInBank = useMemo(() => {
    if (!month) return []
    return payments.filter(p => p.remaining > 0 && p.payment_mode === account && monthOf(p.payment_date) === month)
  }, [payments, account, month])

  const q = search.trim().toLowerCase()
  const qDigits = q.replace(/[,₹\s]/g, '')
  const shownIn = useMemo(() => {
    return analysed.filter(a => {
      if (card !== 'all' && bucket(a) !== card) return false
      if (!q) return true
      return a.line.narration.toLowerCase().includes(q) ||
        (a.line.bank_ref ?? '').toLowerCase().includes(q) ||
        (qDigits !== '' && String(a.line.deposit).includes(qDigits))
    })
  }, [analysed, card, q, qDigits])

  const analysedOut = useMemo<LineWithSuggestions[]>(() => debits.map(l => analyseLine(l, payments, expenses)), [debits, payments, expenses])
  const outCounts = useMemo(() => {
    const c = { all: analysedOut.length, unexplained: 0, suggested: 0, linked: 0, not_expense: 0 }
    let unexplainedPaise = 0
    for (const a of analysedOut) {
      if (a.status === 'unlinked' || a.status === 'partly') {
        c.unexplained++
        unexplainedPaise += toPaise(a.line.withdrawal) - toPaise(linkedTotal(a.line))
        if (a.expenseSuggestions.length > 0 || a.debitKind) c.suggested++
      } else if (a.status === 'linked') c.linked++
      else if (a.status === 'not_expense') c.not_expense++
    }
    return { ...c, unexplainedMoney: unexplainedPaise / 100 }
  }, [analysedOut])
  const shownOut = useMemo(
    () => analysedOut.filter(a => {
      const open = a.status === 'unlinked' || a.status === 'partly'
      if (outCard === 'unexplained' && !open) return false
      if (outCard === 'suggested' && !(open && (a.expenseSuggestions.length > 0 || a.debitKind))) return false
      if (outCard === 'linked' && a.status !== 'linked') return false
      if (outCard === 'not_expense' && a.status !== 'not_expense') return false
      if (!q) return true
      return a.line.narration.toLowerCase().includes(q) || (a.line.debit_payee ?? '').toLowerCase().includes(q) ||
        (qDigits !== '' && String(a.line.withdrawal).includes(qDigits))
    }),
    [analysedOut, outCard, q, qDigits],
  )
  // THE SUGGESTIONS THE OWNER CAN CONFIRM IN ONE GO: unexplained debits shown
  // right now that look like a kind of non-expense AND match no recorded
  // expense (a debit that might be a recorded expense is for a person to look at).
  const bulkItems = useMemo(
    () => shownOut.filter(a => a.status === 'unlinked' && a.debitKind && a.expenseSuggestions.length === 0),
    [shownOut],
  )
  const shownPayments = useMemo(
    () => notInBank.filter(p => !q || (p.client_name ?? '').toLowerCase().includes(q) || (p.human_payment_id ?? '').toLowerCase().includes(q) || (qDigits !== '' && String(p.amount).includes(qDigits))),
    [notInBank, q, qDigits],
  )

  const openedItem = useMemo(() => {
    if (!opened) return null
    const hit = analysed.find(a => a.line.id === opened)
    if (hit) return hit
    return analysedOut.find(a => a.line.id === opened) ?? null
  }, [opened, analysed, analysedOut])

  const confirmAll = async () => {
    setMarkingAll(true)
    const items = bulkItems.map(a => ({ line_id: a.line.id, kind: a.debitKind!.kind, payee: a.debitKind!.payee ?? '' }))
    let marked = 0
    let failure: string | null = null
    for (let i = 0; i < items.length && !failure; i += 400) {
      const { data: n, error } = await supabase.rpc('classify_bank_debits', { p_items: items.slice(i, i + 400) })
      if (error) failure = rpcMessage(error, 'The debits could not be marked.')
      else marked += Number(n) || 0
    }
    setMarkingAll(false)
    setConfirmingAll(false)
    show(failure ? `${failure}${marked ? ` (${marked} were marked first)` : ''}` : `${marked} debits marked as not an expense`, failure ? 'error' : 'success')
    void loadMonth()
  }

  const notSynced = useMemo(() => analysed.filter(a => bucket(a) === 'not_synced'), [analysed])

  // Check sync: try every Not Synced credit of the month again, then list what is still not.
  const checkSync = async () => {
    setSyncing(true)
    try {
      const r = notSynced.length > 0
        ? await syncBankCredits(supabase, notSynced.map(a => a.line.id))
        : { created: 0, linkedExisting: 0, alreadySynced: 0, failed: [] }
      await loadMonth()
      setSyncReport(r)
    } catch (e) {
      show(e instanceof Error ? e.message : 'The credits could not be synced.', 'error')
    } finally {
      setSyncing(false)
    }
  }

  // After an upload: sync the credits that upload added (not the older ones).
  const syncUpload = async (importId: string, message: string) => {
    try {
      const r = await syncBankCredits(supabase, await loadImportSyncableIds(supabase, importId))
      const parts = [`${r.created} added to Confirmed Payments`]
      if (r.linkedExisting > 0) parts.push(`${r.linkedExisting} linked to a payment already recorded`)
      if (r.failed.length > 0) parts.push(`${r.failed.length} not synced`)
      show(`${message}. ${parts.join(', ')}.`, r.failed.length > 0 ? 'error' : 'success')
    } catch (e) {
      show(`${message}. Sync did not finish: ${e instanceof Error ? e.message : 'try Check sync'}.`, 'error')
    }
    setSyncTick(t => t + 1)
  }

  const months = range ? monthsBetween(monthOf(range.first), monthOf(range.last)) : []

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (booting) return <FinanceRouteFallback />

  if (!caps.canReconcileBank) {
    return (
      <FinanceLayout profile={profile} title="Bank Statements" onSignOut={handleSignOut}>
        <FinanceEmpty
          icon="file"
          role="alert"
          title="You do not have access to Bank Statements"
          body="Bank statements show the company's balances. Ask an administrator to grant you Reconcile Bank Statements in Control Center."
        />
      </FinanceLayout>
    )
  }

  const total = tab === 'in' ? shownIn.length : tab === 'out' ? shownOut.length : shownPayments.length
  const pageStart = page * PAGE_SIZE
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <FinanceLayout
      profile={profile}
      title="Bank Statements"
      subtitle="Every credit that reaches the bank, synced into Confirmed Payments"
      onSignOut={handleSignOut}
      onRefresh={async () => { await loadRange(account); await loadMonth() }}
      actions={<button className="boe-btn boe-btn-primary" onClick={() => setUploading(true)}>Upload statement</button>}
    >
      <div className="bank-controls">
        <div className="bank-accounts" role="tablist" aria-label="Account">
          {(['hdfc', 'hdfc_sec'] as const).map(a => (
            <button key={a} role="tab" aria-selected={account === a} className="bank-account" onClick={() => { setAccount(a); setCard('all'); setSearch('') }}>
              {BANK_ACCOUNT_LABEL[a]}
              <span className="fin-muted"> {a === 'hdfc' ? 'main' : 'petty cash'}</span>
            </button>
          ))}
        </div>
        {months.length > 0 && (
          <label className="bank-month">
            <span className="fin-muted">Month</span>
            <select className="boe-input" value={month ?? ''} onChange={e => { setMonth(e.target.value); setCard('all') }}>
              {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
        )}
        {range && <span className="fin-muted" style={{ fontSize: 12 }}>Statements stored: {formatBankDate(range.first)} – {formatBankDate(range.last)}</span>}
      </div>

      {range === null && !loadError && (
        <FinanceEmpty
          icon="file"
          title={`No ${BANK_ACCOUNT_LABEL[account]} statement uploaded yet`}
          body="Download the statement from NetBanking and drop the .xls here. You can upload overlapping periods; nothing is counted twice."
          action={<button className="boe-btn boe-btn-primary" onClick={() => setUploading(true)}>Upload statement</button>}
        />
      )}

      {loadError && <FinanceEmpty icon="search" role="alert" title="This month could not be loaded" body={loadError} />}

      {range && !loadError && (
        <>
          {tab === 'out' ? (
            <FinanceStatusCards
              ariaLabel="Money out, by status"
              noun="debit"
              active={outCard}
              onSelect={k => setOutCard(k)}
              cards={[
                { key: 'all', label: 'All debits', count: loading ? null : outCounts.all },
                { key: 'unexplained', label: 'Unexplained', tone: 'zero', count: loading ? null : outCounts.unexplained },
                { key: 'suggested', label: 'Has a suggestion', tone: 'partial', count: loading ? null : outCounts.suggested },
                { key: 'linked', label: 'Linked to expense', tone: 'full', count: loading ? null : outCounts.linked },
                { key: 'not_expense', label: 'Not an expense', tone: 'neutral', count: loading ? null : outCounts.not_expense },
              ]}
            />
          ) : (
          <FinanceStatusCards
            ariaLabel="Money in, by status"
            noun="credit"
            active={tab === 'in' ? card : 'all'}
            onSelect={k => { setTab('in'); setCard(k) }}
            cards={[
              { key: 'all', label: CARD_LABEL.all, count: loading ? null : counts.all },
              { key: 'not_synced', label: CARD_LABEL.not_synced, tone: 'over', count: loading ? null : counts.not_synced },
              { key: 'synced', label: CARD_LABEL.synced, tone: 'full', count: loading ? null : counts.synced },
              { key: 'old_order', label: CARD_LABEL.old_order, tone: 'neutral', count: loading ? null : counts.old_order },
              { key: 'not_customer', label: CARD_LABEL.not_customer, tone: 'neutral', count: loading ? null : counts.not_customer },
            ]}
          />
          )}
          {tab === 'out' && !loading && outCounts.unexplained > 0 && (
            <p className="bank-unlinked-note">
              <strong>{formatMoney(outCounts.unexplainedMoney)}</strong> left {BANK_ACCOUNT_LABEL[account]} in {month ? monthLabel(month) : 'this month'} without an expense or a reason attached.
              {bulkItems.length > 0 && (
                <> <button className="bank-link-button" onClick={() => setConfirmingAll(true)}>Confirm {bulkItems.length} suggested {bulkItems.length === 1 ? 'reason' : 'reasons'}</button></>
              )}
            </p>
          )}
          {tab !== 'out' && !loading && counts.not_synced > 0 && (
            <p className="bank-unlinked-note">
              <strong>{formatMoney(money)}</strong> reached {BANK_ACCOUNT_LABEL[account]} in {month ? monthLabel(month) : 'this month'} and is not in Confirmed Payments yet.
            </p>
          )}

          <div className="fin-board">
            <div className="fin-viewbar">
              <div className="fin-tabs" role="tablist" aria-label="Bank view">
                <button role="tab" className="fin-tab" aria-selected={tab === 'in'} onClick={() => setTab('in')}>
                  Money in <span className="fin-tab-count">{credits.length}</span>
                </button>
                <button role="tab" className="fin-tab" aria-selected={tab === 'payments'} onClick={() => setTab('payments')}>
                  Payments not in the bank <span className="fin-tab-count">{notInBank.length}</span>
                </button>
                <button role="tab" className="fin-tab" aria-selected={tab === 'out'} onClick={() => setTab('out')}>
                  Money out <span className="fin-tab-count">{debits.length}</span>
                </button>
              </div>
              <div className="fin-tools">
                <div className="boe-list-search">
                  <input
                    type="search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={tab === 'payments' ? 'Search client, payment ID or amount' : 'Search name, reference or amount'}
                    aria-label="Search"
                  />
                </div>
                {tab === 'in' && caps.canCreatePaymentRecord && (
                  <button className="boe-btn boe-btn-ghost" disabled={syncing || loading} onClick={checkSync}>{syncing ? 'Checking…' : 'Check sync'}</button>
                )}
                {tab === 'in' && card !== 'all' && (
                  <FilterChip label={`Showing: ${CARD_LABEL[card]}`} isSet icon="tag">
                    <button className="boe-btn boe-btn-ghost" onClick={() => setCard('all')}>Show all credits</button>
                  </FilterChip>
                )}
                <span className="fin-count">{total} {total === 1 ? 'row' : 'rows'}</span>
              </div>
            </div>

            {loading ? (
              <div className="bank-loading" role="status">Loading {month ? monthLabel(month) : ''}…</div>
            ) : total === 0 ? (
              <FinanceEmpty
                icon={tab === 'payments' ? 'check' : 'search'}
                title={tab === 'payments' ? 'Every recorded payment of this month has a bank credit' : 'Nothing to show'}
                body={tab === 'payments' ? 'Payments recorded in this account for this month that no bank line is linked to would appear here.' : 'Try another filter or month.'}
              />
            ) : (
              <div className="fin-table-wrap">
                {tab === 'in' && (
                  <table className="fin-table bank-table">
                    <thead><tr>
                      <th style={{ width: 104 }}>Date</th>
                      <th>Received from</th>
                      <th className="fin-num" style={{ width: 140 }}>Amount</th>
                      <th style={{ width: 170 }}>Synced</th>
                      <th style={{ width: 240 }}>Confirmed payment</th>
                      {caps.canCreatePaymentRecord && <th style={{ width: 150 }} aria-label="Add to Confirmed Payments" />}
                    </tr></thead>
                    <tbody>
                      {shownIn.slice(pageStart, pageStart + PAGE_SIZE).map(a => (
                        <tr key={a.line.id} onClick={() => setOpened(a.line.id)} tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter') setOpened(a.line.id) }}>
                          <td>{formatBankDate(a.line.line_date)}</td>
                          <td>
                            <span className="fin-primary-text">{payerFromNarration(a.line.narration) ?? a.line.narration}</span>
                            <span className="fin-sub">{a.line.narration}</span>
                          </td>
                          <td className="fin-num"><span className="fin-amount">{formatMoney(a.line.deposit)}</span></td>
                          <td><span className={`fin-pill fin-pill--${SYNC_PILL[syncState(a)].tone}`}>{SYNC_PILL[syncState(a)].label}</span></td>
                          <td><LinkedCell a={a} payments={payments} /></td>
                          {caps.canCreatePaymentRecord && (
                            <td onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                              {canAddToConfirmed(a) && (
                                <button className="boe-btn boe-btn-ghost" onClick={() => setAdding(a.line.id)}>Add to Confirmed</button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {tab === 'out' && (
                  <table className="fin-table bank-table">
                    <thead><tr>
                      <th style={{ width: 104 }}>Date</th>
                      <th>Paid to</th>
                      <th className="fin-num" style={{ width: 140 }}>Amount</th>
                      <th style={{ width: 170 }}>Status</th>
                      <th style={{ width: 240 }}>Explained as / suggestion</th>
                    </tr></thead>
                    <tbody>
                      {shownOut.slice(pageStart, pageStart + PAGE_SIZE).map(a => (
                        <tr key={a.line.id} onClick={() => setOpened(a.line.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpened(a.line.id) }}>
                          <td>{formatBankDate(a.line.line_date)}</td>
                          <td>
                            <span className="fin-primary-text">{a.line.debit_payee ?? payeeFromDebitNarration(a.line.narration) ?? a.line.narration}</span>
                            <span className="fin-sub">{a.line.narration}</span>
                          </td>
                          <td className="fin-num"><span className="fin-amount">{formatMoney(a.line.withdrawal)}</span></td>
                          <td><span className={`fin-pill fin-pill--${STATUS_TONE[a.status]}`}>{statusLabelFor(a.line, a.status)}</span></td>
                          <td><DebitCell a={a} expenses={expenses} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {tab === 'payments' && (
                  <table className="fin-table bank-table">
                    <thead><tr>
                      <th style={{ width: 104 }}>Recorded</th>
                      <th>Client</th>
                      <th style={{ width: 120 }}>Payment ID</th>
                      <th className="fin-num" style={{ width: 140 }}>Not in bank</th>
                      <th style={{ width: 170 }}>Payment status</th>
                    </tr></thead>
                    <tbody>
                      {shownPayments.slice(pageStart, pageStart + PAGE_SIZE).map(p => (
                        <tr key={p.id}>
                          <td>{formatBankDate(p.payment_date)}</td>
                          <td><span className="fin-primary-text">{p.client_name ?? 'Suspense payment'}</span></td>
                          <td className="fin-muted">{p.human_payment_id}</td>
                          <td className="fin-num"><span className="fin-amount">{formatMoney(p.remaining)}</span></td>
                          <td className="fin-muted">{p.status === 'pending_approval' ? 'Waiting for Finance' : p.status === 'needs_clarification' ? 'Needs Clarification' : 'Verified'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {!loading && pages > 1 && (
              <div className="bank-pager">
                <button className="boe-btn boe-btn-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
                <span className="fin-muted">Page {page + 1} of {pages}</span>
                <button className="boe-btn boe-btn-ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            )}
          </div>
        </>
      )}

      {openedItem && (
        <BankLineModal
          supabase={supabase}
          item={openedItem}
          payments={payments}
          expenses={expenses}
          onClose={() => setOpened(null)}
          onChanged={(message, close) => {
            show(message)
            if (close !== false) setOpened(null)
            void loadMonth()
          }}
        />
      )}

      {adding && (() => {
        const item = analysed.find(a => a.line.id === adding)
        return item ? (
          <BankAddConfirmedModal
            supabase={supabase}
            item={item}
            verifiesOwn={caps.canDecideOwnPayment}
            onClose={() => setAdding(null)}
            onAdded={() => { void loadMonth() }}
          />
        ) : null
      })()}

      {confirmingAll && (
        <FinanceModal title="Confirm suggested reasons" onClose={() => { if (!markingAll) setConfirmingAll(false) }} width="520px" closeOnBackdropClick={!markingAll}>
          <p style={{ margin: 0, fontSize: 14 }}>
            Mark these {bulkItems.length} debits as <strong>not an expense</strong>, each with the reason shown. Every one can be opened and changed afterwards.
          </p>
          <ul className="bank-checks">
            {(Object.keys(DEBIT_KIND_LABEL) as DebitKind[])
              .map(k => ({ k, n: bulkItems.filter(a => a.debitKind!.kind === k).length }))
              .filter(x => x.n > 0)
              .map(x => <li key={x.k}><strong>{x.n}</strong> {DEBIT_KIND_LABEL[x.k].toLowerCase()}</li>)}
          </ul>
          <p className="fin-muted" style={{ margin: 0, fontSize: 12 }}>Debits that might be a recorded expense are left out, for you to look at one by one.</p>
          <div className="bank-actions">
            <button className="boe-btn boe-btn-ghost" disabled={markingAll} onClick={() => setConfirmingAll(false)}>Cancel</button>
            <button className="boe-btn boe-btn-primary" disabled={markingAll} onClick={confirmAll}>{markingAll ? 'Marking…' : `Mark ${bulkItems.length} debits`}</button>
          </div>
        </FinanceModal>
      )}

      {uploading && (
        <BankUploadModal
          supabase={supabase}
          onClose={() => setUploading(false)}
          onImported={(acct, m, message, importId) => {
            setUploading(false)
            setAccount(acct)
            setCard('all')
            setTab('in')
            void loadRange(acct, m)
            if (importId && caps.canCreatePaymentRecord) void syncUpload(importId, message)
            else show(importId ? `${message}. Not synced: adding payments needs Finance create access.` : message)
          }}
        />
      )}

      {syncReport && (
        <FinanceModal title={`Sync check — ${month ? monthLabel(month) : ''}`} onClose={() => setSyncReport(null)} width="640px">
          <p style={{ margin: 0, fontSize: 14 }}>
            {syncReport.created} added to Confirmed Payments
            {syncReport.linkedExisting > 0 && <>, {syncReport.linkedExisting} linked to a payment already recorded</>}
            {' '}· {notSynced.length === 0 ? 'every customer credit of this month is synced.' : <strong>{notSynced.length} not synced:</strong>}
          </p>
          {notSynced.length > 0 && (
            <ul className="bank-checks">
              {notSynced.map(a => (
                <li key={a.line.id} className="bank-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="fin-primary-text">{formatBankDate(a.line.line_date)} · {payerFromNarration(a.line.narration) ?? a.line.narration} · {formatMoney(a.line.deposit)}</div>
                    <div className="fin-sub" style={{ color: '#A12438' }}>{a.line.sync_error ?? SYNC_NOT_YET}</div>
                  </div>
                  <button className="boe-btn boe-btn-ghost" onClick={() => { setSyncReport(null); setAdding(a.line.id) }}>Add to Confirmed</button>
                </li>
              ))}
            </ul>
          )}
          <p className="fin-muted" style={{ margin: 0, fontSize: 12 }}>
            A credit that may already be recorded is never added on its own. Link it to the existing payment in Confirmed Payments, or add it here if it is a different payment.
          </p>
          <div className="bank-actions">
            <button className="boe-btn boe-btn-primary" onClick={() => setSyncReport(null)}>Close</button>
          </div>
        </FinanceModal>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}

/**
 * A customer credit that is not in Confirmed Payments yet. The database
 * re-checks everything (including duplicates), and a possible duplicate asks for
 * confirmation in the modal.
 */
function canAddToConfirmed(a: LineWithSuggestions): boolean {
  return syncState(a) === 'not_synced'
}

function DebitCell({ a, expenses }: { a: LineWithSuggestions; expenses: BankExpense[] }) {
  const byId = new Map(expenses.map(e => [e.id, e]))
  const links = activeLinks(a.line)
  if (links.length > 0) {
    const first = links[0].expense_id ? byId.get(links[0].expense_id) : undefined
    return (
      <>
        <span className="fin-primary-text">{first?.paid_to ?? 'Expense'}{links.length > 1 ? ` +${links.length - 1}` : ''}</span>
        <span className="fin-sub">{first ? formatBankDate(first.expense_date) : ''}</span>
      </>
    )
  }
  if (a.status === 'not_expense') {
    return (
      <>
        <span className="fin-primary-text">{a.line.debit_kind ? DEBIT_KIND_LABEL[a.line.debit_kind] : ''}</span>
        <span className="fin-sub">{a.line.debit_payee ?? a.line.note ?? ''}</span>
      </>
    )
  }
  if (a.expenseSuggestions.length > 0) {
    const s = a.expenseSuggestions[0]
    const e = byId.get(s.expenseId)
    return (
      <>
        <span className="fin-primary-text">{e?.paid_to ?? 'Expense'}</span>
        <span className="fin-sub">{s.confidence === 'strong' ? 'Strong match' : s.confidence === 'likely' ? 'Likely match' : 'Possible match'} · expense</span>
      </>
    )
  }
  if (a.debitKind) return <span className="fin-muted">Looks like: {DEBIT_KIND_LABEL[a.debitKind.kind].toLowerCase()}</span>
  return <span className="fin-muted">No suggestion</span>
}

function LinkedCell({ a, payments }: { a: LineWithSuggestions; payments: BankPayment[] }) {
  const byId = new Map(payments.map(p => [p.id, p]))
  const links = activeLinks(a.line)
  if (links.length > 0) {
    const first = byId.get(links[0].payment_id ?? '')
    return (
      <>
        <span className="fin-primary-text">{first?.client_name ?? 'Suspense payment'}{links.length > 1 ? ` +${links.length - 1}` : ''}</span>
        <span className="fin-sub">{first?.human_payment_id}</span>
      </>
    )
  }
  if (a.status === 'old_order') {
    return <><span className="fin-primary-text">{a.line.old_order_customer}</span><span className="fin-sub">{a.line.old_order_ref ?? 'Order not in the app'}</span></>
  }
  if (a.status === 'not_customer') {
    return <span className="fin-muted">{a.line.note ?? ''}</span>
  }
  if (a.nonCustomer) return <span className="fin-muted">Looks like: {a.nonCustomer.reason}</span>
  return <span className="fin-sub" style={{ color: '#A12438' }}>{a.line.sync_error ?? SYNC_NOT_YET}</span>
}
