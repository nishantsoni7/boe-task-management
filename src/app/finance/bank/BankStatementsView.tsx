'use client'

// ── /finance/bank — Bank Statements ─────────────────────────────────────────
//
// THREE JOBS, ONE SCREEN:
//   Money in            every credit of the month, with what it is: Linked to a
//                       recorded payment, an Old order, Not customer money, or
//                       Unlinked (nobody has said yet).
//   Not in the bank     recorded payments of the month no bank credit has been
//                       linked to — the other direction of the same check.
//   Money out           the debits, so the balances can be seen to add up.
//
// THE PAGE NEVER LINKS, VERIFIES OR APPROVES ANYTHING BY ITSELF. It suggests,
// with reasons; a person presses Link. Linking is a note beside a payment and
// leaves its verification flow untouched.
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
import { BANK_ACCOUNT_LABEL, type BankAccountKey } from '@/lib/finance/bankStatement'
import { payerFromNarration } from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'
import type { UserProfile } from '@/lib/types'
import { FinanceEmpty, FinanceStatusCards, FilterChip } from '@/app/finance/components/FinanceListParts'
import {
  STATUS_LABEL,
  STATUS_TONE,
  activeLinks,
  analyseLine,
  formatBankDate,
  linkedTotal,
  loadCandidatePayments,
  loadMonthLines,
  loadStoredRange,
  monthLabel,
  monthOf,
  monthsBetween,
  type BankLine,
  type BankPayment,
  type LineWithSuggestions,
} from './bankStatementsModel'
import { BankLineModal } from './bankLineModal'
import { BankUploadModal } from './bankUploadModal'

const PAGE_SIZE = 50

type CardKey = 'all' | 'unlinked' | 'suggested' | 'linked' | 'old_order' | 'not_customer'
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
  const [search, setSearch] = useState('')
  // The page number is keyed by the filters it was chosen under: change any of
  // them and the page is 0 again, with no reset in an effect.
  const pageKey = `${account}|${month}|${tab}|${card}|${search}`
  const [pageState, setPageState] = useState({ key: pageKey, page: 0 })
  const page = pageState.key === pageKey ? pageState.page : 0
  const setPage = (p: number) => setPageState({ key: pageKey, page: p })

  // One month's data, tagged with the (account, month) it answers. `loading` is
  // "the data on screen answers a different question", so a reload after a write
  // replaces it in place instead of flashing the list away.
  const dataKey = `${account}|${month}`
  const [data, setData] = useState<{ key: string; lines: BankLine[]; payments: BankPayment[]; error: string | null } | null>(null)
  const loading = month !== null && data?.key !== dataKey
  const lines = useMemo(() => (data?.key === dataKey ? data.lines : []), [data, dataKey])
  const payments = useMemo(() => (data?.key === dataKey ? data.payments : []), [data, dataKey])
  const loadError = data?.key === dataKey ? data.error : null

  const [opened, setOpened] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

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
      const linked = [...new Set(ls.flatMap(l => activeLinks(l).map(k => k.payment_id)))]
      const ps = await loadCandidatePayments(supabase, month, linked)
      setData({ key, lines: ls, payments: ps, error: null })
    } catch (e) {
      setData({ key, lines: [], payments: [], error: e instanceof Error ? e.message : 'This month could not be loaded.' })
    }
  }, [supabase, account, month])

  useEffect(() => {
    if (!caps.canReconcileBank || range === undefined) return
    const startFetch = () => { void loadMonth() }
    startFetch()
  }, [caps.canReconcileBank, range, loadMonth])

  // ── derived ──
  const credits = useMemo(() => lines.filter(l => l.deposit > 0), [lines])
  const debits = useMemo(() => lines.filter(l => l.withdrawal > 0), [lines])
  const analysed = useMemo<LineWithSuggestions[]>(() => credits.map(l => analyseLine(l, payments)), [credits, payments])

  const counts = useMemo(() => {
    const c = { all: analysed.length, unlinked: 0, suggested: 0, linked: 0, old_order: 0, not_customer: 0 }
    for (const a of analysed) {
      if (a.status === 'unlinked' || a.status === 'partly') {
        c.unlinked++
        if (a.suggestions.length > 0) c.suggested++
      } else if (a.status === 'linked') c.linked++
      else if (a.status === 'old_order') c.old_order++
      else c.not_customer++
    }
    return c
  }, [analysed])

  const money = useMemo(() => {
    let unlinked = 0
    for (const a of analysed) {
      if (a.status === 'unlinked' || a.status === 'partly') unlinked += toPaise(a.line.deposit) - toPaise(linkedTotal(a.line))
    }
    return unlinked / 100
  }, [analysed])

  const notInBank = useMemo(() => {
    if (!month) return []
    return payments.filter(p => p.remaining > 0 && p.payment_mode === account && monthOf(p.payment_date) === month)
  }, [payments, account, month])

  const q = search.trim().toLowerCase()
  const qDigits = q.replace(/[,₹\s]/g, '')
  const shownIn = useMemo(() => {
    return analysed.filter(a => {
      if (card === 'unlinked' && !(a.status === 'unlinked' || a.status === 'partly')) return false
      if (card === 'suggested' && !((a.status === 'unlinked' || a.status === 'partly') && a.suggestions.length > 0)) return false
      if (card === 'linked' && a.status !== 'linked') return false
      if (card === 'old_order' && a.status !== 'old_order') return false
      if (card === 'not_customer' && a.status !== 'not_customer') return false
      if (!q) return true
      return a.line.narration.toLowerCase().includes(q) ||
        (a.line.bank_ref ?? '').toLowerCase().includes(q) ||
        (qDigits !== '' && String(a.line.deposit).includes(qDigits))
    })
  }, [analysed, card, q, qDigits])

  const shownOut = useMemo(
    () => debits.filter(l => !q || l.narration.toLowerCase().includes(q) || (qDigits !== '' && String(l.withdrawal).includes(qDigits))),
    [debits, q, qDigits],
  )
  const shownPayments = useMemo(
    () => notInBank.filter(p => !q || (p.client_name ?? '').toLowerCase().includes(q) || (p.human_payment_id ?? '').toLowerCase().includes(q) || (qDigits !== '' && String(p.amount).includes(qDigits))),
    [notInBank, q, qDigits],
  )

  const openedItem = useMemo(() => {
    if (!opened) return null
    const hit = analysed.find(a => a.line.id === opened)
    if (hit) return hit
    const out = debits.find(l => l.id === opened)
    return out ? analyseLine(out, payments) : null
  }, [opened, analysed, debits, payments])

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
      subtitle="Match the money that reached the bank to the payments recorded"
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
          <FinanceStatusCards
            ariaLabel="Money in, by status"
            noun="credit"
            active={tab === 'in' ? card : 'all'}
            onSelect={k => { setTab('in'); setCard(k) }}
            cards={[
              { key: 'all', label: 'All credits', count: loading ? null : counts.all },
              { key: 'unlinked', label: 'Unlinked', tone: 'zero', count: loading ? null : counts.unlinked },
              { key: 'suggested', label: 'Has a suggestion', tone: 'partial', count: loading ? null : counts.suggested },
              { key: 'linked', label: 'Linked', tone: 'full', count: loading ? null : counts.linked },
              { key: 'old_order', label: 'Old orders', tone: 'neutral', count: loading ? null : counts.old_order },
              { key: 'not_customer', label: 'Not customer money', tone: 'neutral', count: loading ? null : counts.not_customer },
            ]}
          />
          {!loading && counts.unlinked > 0 && (
            <p className="bank-unlinked-note">
              <strong>{formatMoney(money)}</strong> reached {BANK_ACCOUNT_LABEL[account]} in {month ? monthLabel(month) : 'this month'} without a payment, an old order or a reason attached.
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
                {tab === 'in' && card !== 'all' && (
                  <FilterChip label={`Showing: ${card === 'suggested' ? 'Has a suggestion' : card === 'unlinked' ? 'Unlinked' : card === 'linked' ? 'Linked' : card === 'old_order' ? 'Old orders' : 'Not customer money'}`} isSet icon="tag">
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
                      <th style={{ width: 170 }}>Status</th>
                      <th style={{ width: 240 }}>Linked to / suggestion</th>
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
                          <td><span className={`fin-pill fin-pill--${STATUS_TONE[a.status]}`}>{STATUS_LABEL[a.status]}</span></td>
                          <td><LinkedCell a={a} payments={payments} /></td>
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
                      <th className="fin-num" style={{ width: 160 }}>Balance after</th>
                    </tr></thead>
                    <tbody>
                      {shownOut.slice(pageStart, pageStart + PAGE_SIZE).map(l => (
                        <tr key={l.id} onClick={() => setOpened(l.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpened(l.id) }}>
                          <td>{formatBankDate(l.line_date)}</td>
                          <td><span className="fin-primary-text">{l.narration}</span></td>
                          <td className="fin-num"><span className="fin-amount">{formatMoney(l.withdrawal)}</span></td>
                          <td className="fin-num fin-muted">{formatMoney(l.balance)}</td>
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
                          <td className="fin-muted">{p.status === 'pending_approval' ? 'Awaiting verification' : p.status === 'needs_clarification' ? 'Needs clarification' : 'Verified'}</td>
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
          onClose={() => setOpened(null)}
          onChanged={(message, close) => {
            show(message)
            if (close !== false) setOpened(null)
            void loadMonth()
          }}
        />
      )}

      {uploading && (
        <BankUploadModal
          supabase={supabase}
          onClose={() => setUploading(false)}
          onImported={(acct, m, message) => {
            setUploading(false)
            show(message)
            setAccount(acct)
            setCard('all')
            setTab('in')
            void loadRange(acct, m)
          }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}

function LinkedCell({ a, payments }: { a: LineWithSuggestions; payments: BankPayment[] }) {
  const byId = new Map(payments.map(p => [p.id, p]))
  const links = activeLinks(a.line)
  if (links.length > 0) {
    const first = byId.get(links[0].payment_id)
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
  if (a.suggestions.length > 0) {
    const s = a.suggestions[0]
    const p = byId.get(s.paymentId)
    return (
      <>
        <span className="fin-primary-text">{p?.client_name ?? 'Suspense payment'}</span>
        <span className="fin-sub">{s.confidence === 'strong' ? 'Strong match' : s.confidence === 'likely' ? 'Likely match' : 'Possible match'} · {p?.human_payment_id}</span>
      </>
    )
  }
  if (a.nonCustomer) return <span className="fin-muted">Looks like: {a.nonCustomer.reason}</span>
  return <span className="fin-muted">No suggestion</span>
}
