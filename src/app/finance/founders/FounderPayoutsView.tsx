'use client'

// ── /finance/founders — Founders' payouts ────────────────────────────────────
//
// The money BOE pays into the partners' and their families' bank accounts, at
// irregular times, split across accounts (owner request 2026-10-29). Four tabs
// for one financial year:
//
//   Overview     the year's total, the two sides compared on the common payments
//                (Namrata's incentive left out), one table of every account with
//                each kind apart and the tax-free room, and the months side by
//                side (FounderOverview)
//   Payments     every payout with its lines; filters; change or delete; Excel
//                (FounderPayments)
//   Tax planner  how much more each person can take tax-free (FounderPlanner)
//   Accounts     the people paid and their role in BOE (FounderAccounts)
//
// WHO: an explicit finance.founder_payouts grant. Administrators are NOT let in
// by role — the menu entry, this page and every database function ask the same
// question (20270501000000). Owner decision: only the owner.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { Toast, useToast } from '@/components/ui/toast'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveFinanceCapabilities, NO_FINANCE_CAPABILITIES } from '@/lib/permissions/finance'
import { istToday } from '@/lib/istDate'
import { downloadWorkbook } from '@/lib/finance/expenseReimbursementExport'
import {
  EMPTY_FOUNDER_BOOK,
  availableTaxYears,
  formatRupees,
  kindShort,
  summariseYear,
  taxYearLabel,
  taxYearOf,
  type FounderBook,
  type FounderPayout,
} from '@/lib/finance/founderPayouts'
import type { UserProfile } from '@/lib/types'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { FounderPayoutModal } from './FounderPayoutModal'
import { FounderOverview } from './FounderOverview'
import { FounderPayments, NO_FILTERS, fmtDate, type Filters } from './FounderPayments'
import { FounderPlanner } from './FounderPlanner'
import { FounderAccounts } from './FounderAccounts'
import { deleteFounderPayout, founderExportFileName, founderWorkbook, loadFounderBook } from './founderPayoutsData'
import styles from './founders.module.css'

type Tab = 'overview' | 'payments' | 'planner' | 'accounts'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'payments', label: 'Payments' },
  { key: 'planner', label: 'Tax planner' },
  { key: 'accounts', label: 'Accounts' },
]

export function FounderPayoutsView() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const { toast, show, dismiss } = useToast()
  const todayIso = useMemo(() => istToday(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [caps, setCaps] = useState(NO_FINANCE_CAPABILITIES)
  const [booting, setBooting] = useState(true)

  const [book, setBook] = useState<FounderBook>(EMPTY_FOUNDER_BOOK)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [taxYear, setTaxYear] = useState(() => taxYearOf(istToday()))
  const [tab, setTab] = useState<Tab>('overview')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [modal, setModal] = useState<{ editing: FounderPayout | null } | null>(null)
  const [deleting, setDeleting] = useState<FounderPayout | null>(null)
  const [downloading, setDownloading] = useState(false)

  const mayUse = caps.canSeeFounderPayouts

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

  const load = useCallback(async () => {
    setError(null)
    try {
      setBook(await loadFounderBook(supabase))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Founders’ payouts could not be loaded. Use Refresh to try again.')
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    if (!mayUse) return
    // A FETCH IS STARTED HERE; NO STATE IS SET HERE (every setState inside load
    // runs after its first await), so it goes through a named local.
    const startFetch = () => { void load() }
    startFetch()
  }, [mayUse, load])

  const years = useMemo(() => availableTaxYears(book, todayIso), [book, todayIso])
  const year = useMemo(() => summariseYear(book, taxYear), [book, taxYear])
  const sides = useMemo(() => [...new Set(book.accounts.map(a => a.side))].sort((a, b) => a.localeCompare(b)), [book.accounts])

  const shownLines = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    return year.lines.filter(l =>
      (!filters.accountId || l.accountId === filters.accountId) &&
      (!filters.kind || l.kind === filters.kind) &&
      (!filters.side || l.account?.side === filters.side) &&
      (!filters.paidFrom || l.payout.paidFrom === filters.paidFrom) &&
      (!filters.month || l.payout.paidOn.startsWith(filters.month)) &&
      (!q || (l.account?.displayName ?? '').toLowerCase().includes(q) ||
        (l.payout.note ?? '').toLowerCase().includes(q) || (l.payout.bankReference ?? '').toLowerCase().includes(q)))
  }, [year.lines, filters])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const download = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadWorkbook(founderExportFileName(taxYear, todayIso), founderWorkbook(year, tab === 'payments' ? shownLines : year.lines))
    } catch (e) {
      show(e instanceof Error ? e.message : 'The Excel file could not be made. Try again.', 'error')
    }
    setDownloading(false)
  }

  if (booting) return <FinanceRouteFallback />

  if (!mayUse) {
    return (
      <FinanceLayout profile={profile} title="Founders' payouts" onSignOut={handleSignOut}>
        <FinanceEmpty icon="file" role="alert" title="This page is private"
          body="Founders’ payouts opens only for people granted it by name. Being an administrator is not enough." />
      </FinanceLayout>
    )
  }

  return (
    <FinanceLayout
      profile={profile}
      title="Founders' payouts"
      subtitle="Money paid into the partners’ and their families’ accounts"
      onSignOut={handleSignOut}
      onRefresh={load}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="boe-btn boe-btn-ghost" disabled={downloading || loading || year.lines.length === 0} onClick={() => void download()}>
            {downloading ? 'Preparing…' : 'Download Excel'}
          </button>
          <button className="boe-btn boe-btn-primary" data-testid="new-founder-payout" disabled={loading || !!error}
            onClick={() => (book.accounts.length === 0 ? setTab('accounts') : setModal({ editing: null }))}>
            + New payout
          </button>
        </div>
      }
    >
      <div className={styles.root}>
        <div className={`fin-board ${styles.topbar}`}>
          <div className="fin-viewbar">
            <div className="fin-tabs" role="tablist" aria-label="Founders' payouts">
              {TABS.map(t => (
                <button key={t.key} type="button" role="tab" className="fin-tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
              ))}
            </div>
            <label className={styles.year}>
              <span>Financial year</span>
              <select className="boe-input" aria-label="Financial year" value={taxYear} onChange={e => { setTaxYear(Number(e.target.value)); setFilters(NO_FILTERS) }}>
                {years.map(y => <option key={y} value={y}>{taxYearLabel(y)}{y === taxYearOf(todayIso) ? ' (this year)' : ''}</option>)}
              </select>
            </label>
          </div>
        </div>

        {error ? (
          <div className="fin-board"><FinanceEmpty icon="file" role="alert" title="Founders’ payouts could not be loaded" body={error} /></div>
        ) : loading ? (
          <div className="boe-card" style={{ padding: 24, fontSize: 13 }} role="status">Loading…</div>
        ) : tab === 'overview' ? (
          <FounderOverview year={year} todayIso={todayIso} hasAccounts={book.accounts.length > 0}
            onOpenAccounts={() => setTab('accounts')} onNewPayout={() => setModal({ editing: null })} />
        ) : tab === 'payments' ? (
          <FounderPayments year={year} lines={shownLines} filters={filters} setFilters={setFilters} sides={sides} book={book}
            onEdit={p => setModal({ editing: p })} onDelete={p => setDeleting(p)} />
        ) : tab === 'planner' ? (
          <FounderPlanner key={taxYear} supabase={supabase} year={year} todayIso={todayIso} onChanged={load} show={show} />
        ) : (
          <FounderAccounts supabase={supabase} year={year} sides={sides} onChanged={load} show={show} />
        )}

        {modal && (
          <FounderPayoutModal
            supabase={supabase}
            book={book}
            editing={modal.editing}
            todayIso={todayIso}
            onClose={() => setModal(null)}
            onSaved={(message, paidOn) => { setModal(null); show(message); setTaxYear(taxYearOf(paidOn)); void load() }}
          />
        )}

        {deleting && (
          <DeletePayoutModal
            payout={deleting}
            book={book}
            onClose={() => setDeleting(null)}
            onConfirm={async reason => {
              await deleteFounderPayout(supabase, deleting.id, reason)
              setDeleting(null)
              show('Payout deleted')
              await load()
            }}
          />
        )}
      </div>

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}

// ── Delete ───────────────────────────────────────────────────────────────────

function DeletePayoutModal({ payout, book, onClose, onConfirm }: {
  payout: FounderPayout
  book: FounderBook
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = new Map(book.accounts.map(a => [a.id, a.displayName]))
  const total = payout.lines.reduce((s, l) => s + l.paise, 0)
  return (
    <FinanceModal title="Delete this payout?" onClose={onClose} width="440px" closeOnBackdropClick={false}>
      <p className={styles.deleteText}>
        {fmtDate(payout.paidOn)} · {formatRupees(total)} to {payout.lines.map(l => `${names.get(l.accountId) ?? '—'} (${kindShort(l.kind)})`).join(', ')}.
        It leaves every total. The record is kept, with who deleted it and why.
      </p>
      <div className={styles.form}>
        <label className={styles.field}>
          <span>Why (optional)</span>
          <input className="boe-input" maxLength={300} value={reason} placeholder="e.g. typed twice" onChange={e => setReason(e.target.value)} />
        </label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.modalFoot}>
          <span />
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="boe-btn boe-btn-danger" disabled={busy}
            onClick={async () => {
              setBusy(true); setError(null)
              try { await onConfirm(reason) } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete. Try again.'); setBusy(false) }
            }}>
            {busy ? 'Deleting…' : 'Delete payout'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}
