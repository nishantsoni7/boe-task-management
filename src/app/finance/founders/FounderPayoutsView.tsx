'use client'

// ── /finance/founders — Founders' payouts ────────────────────────────────────
//
// The money BOE pays into the partners' and their families' bank accounts, at
// irregular times, split across accounts (owner request 2026-10-29). Four tabs
// for one financial year:
//
//   Overview     the year's total, the two sides compared on the common payments
//                (Namrata's incentive left out), one card per account with its
//                remuneration and incentive apart and the tax-free room, and the
//                months side by side
//   Payments     every payout with its lines; filters; change or delete; Excel
//   Tax planner  how much more each person can take tax-free (FounderPlanner)
//   Accounts     the people paid and their role in BOE (FounderAccounts)
//
// WHO: an explicit finance.founder_payouts grant. Administrators are NOT let in
// by role — the menu entry, this page and every database function ask the same
// question (20270501000000). Owner decision: only the owner.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  FOUNDER_PAID_FROM,
  FOUNDER_PAYOUT_KINDS,
  availableTaxYears,
  equalShareGap,
  formatLakh,
  formatRupees,
  kindLabel,
  kindShort,
  monthsLeftInTaxYear,
  paidFromLabel,
  summariseYear,
  taxYearLabel,
  taxYearMonths,
  taxYearOf,
  type FounderBook,
  type FounderPayout,
  type FounderPayoutKind,
  type FounderYear,
} from '@/lib/finance/founderPayouts'
import { roomLeft, rulesFor } from '@/lib/finance/founderPayoutTax'
import type { UserProfile } from '@/lib/types'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { FounderPayoutModal } from './FounderPayoutModal'
import { FounderPlanner } from './FounderPlanner'
import { FounderAccounts, FounderRolePill } from './FounderAccounts'
import { deleteFounderPayout, founderExportFileName, founderWorkbook, loadFounderBook } from './founderPayoutsData'

type Tab = 'overview' | 'payments' | 'planner' | 'accounts'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'payments', label: 'Payments' },
  { key: 'planner', label: 'Tax planner' },
  { key: 'accounts', label: 'Accounts' },
]

export const KIND_COLOUR: Record<FounderPayoutKind, string> = {
  partner_remuneration: '#4F7FB8',
  incentive: '#3F9B6E',
  interest_on_capital: '#8A6FB8',
  salary: '#2F6E8F',
  drawings: '#A8A39C',
}
const SIDE_COLOURS = ['#4F7FB8', '#C98A2B', '#8A6FB8', '#3F9B6E']

type Filters = { search: string; accountId: string; kind: string; side: string; paidFrom: string; month: string }
const NO_FILTERS: Filters = { search: '', accountId: '', kind: '', side: '', paidFrom: '', month: '' }

function fmtDate(iso: string): string {
  const at = new Date(`${iso}T00:00:00`)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
function monthName(yyyyMm: string, style: 'short' | 'long' = 'short'): string {
  return new Date(`${yyyyMm}-01T00:00:00`).toLocaleDateString('en-IN', style === 'short' ? { month: 'short' } : { month: 'long', year: 'numeric' })
}

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
      <div className="fin-board fp-topbar">
        <div className="fin-viewbar">
          <div className="fin-tabs" role="tablist" aria-label="Founders' payouts">
            {TABS.map(t => (
              <button key={t.key} type="button" role="tab" className="fin-tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
          <label className="fp-year">
            <span className="fin-muted">Financial year</span>
            <select className="boe-input" value={taxYear} onChange={e => { setTaxYear(Number(e.target.value)); setFilters(NO_FILTERS) }}>
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
        <Overview year={year} todayIso={todayIso} hasAccounts={book.accounts.length > 0}
          onAddAccount={() => setTab('accounts')} onNewPayout={() => setModal({ editing: null })} />
      ) : tab === 'payments' ? (
        <Payments year={year} lines={shownLines} filters={filters} setFilters={setFilters} sides={sides} book={book}
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

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

function Overview({ year, todayIso, hasAccounts, onAddAccount, onNewPayout }: {
  year: FounderYear
  todayIso: string
  hasAccounts: boolean
  onAddAccount: () => void
  onNewPayout: () => void
}) {
  if (!hasAccounts) {
    return (
      <div className="fin-board">
        <FinanceEmpty icon="box" title="Start with the accounts money goes into"
          body="Add each person once (name, whose side, role in BOE). Then every payout is a few taps."
          action={<button className="boe-btn boe-btn-primary" onClick={onAddAccount}>Add the first account</button>} />
      </div>
    )
  }

  const found = rulesFor(year.taxYear)
  const monthsLeft = monthsLeftInTaxYear(todayIso, year.taxYear)
  const isCurrent = year.taxYear === taxYearOf(todayIso)
  const gap = equalShareGap(year.sides)
  const incentive = year.sides.reduce((s, x) => s + x.incentivePaise, 0)
  const cards = year.accounts.filter(a => a.totalPaise > 0 || (isCurrent && a.account.isActive))
  const months = taxYearMonths(year.taxYear)
  const maxMonth = Math.max(1, ...months.flatMap(m => [...(year.months.get(m)?.values() ?? [])]))
  const sideColour = (side: string) => SIDE_COLOURS[Math.max(0, year.sides.findIndex(s => s.side === side)) % SIDE_COLOURS.length]

  return (
    <div className="fp-overview" data-testid="founder-overview">
      <div className="fin-stats">
        <div className="fin-stat">
          <div className="fin-stat-label">Paid in {taxYearLabel(year.taxYear)}</div>
          <div className="fin-stat-value">{formatLakh(year.totalPaise)}</div>
          <div className="fin-stat-sub">{year.payoutCount} payout{year.payoutCount === 1 ? '' : 's'}{incentive > 0 ? ` · ${formatLakh(incentive)} incentive` : ''}</div>
        </div>
        {year.sides.slice(0, 2).map(s => (
          <div key={s.side} className="fin-stat">
            <div className="fin-stat-label"><span className="fin-dot" style={{ background: sideColour(s.side) }} /> {s.side}&rsquo;s side (equal share)</div>
            <div className="fin-stat-value">{formatLakh(s.equalSharePaise)}</div>
            <div className="fin-stat-sub">{s.incentivePaise > 0 ? `plus ${formatLakh(s.incentivePaise)} incentive, kept apart` : `${s.accountCount} account${s.accountCount === 1 ? '' : 's'} paid`}</div>
          </div>
        ))}
        {gap ? (
          <div className="fin-stat" data-testid="founder-gap">
            <div className="fin-stat-label">Gap between the two sides</div>
            <div className={`fin-stat-value ${gap.paise === 0 ? 'fp-good' : 'fp-warn'}`}>{gap.paise === 0 ? 'Level' : formatLakh(gap.paise)}</div>
            <div className="fin-stat-sub">{gap.paise === 0 ? 'Both sides have had the same' : `${gap.behind}’s side is behind`}</div>
          </div>
        ) : year.sides.length > 2 ? (
          <div className="fin-stat"><div className="fin-stat-label">Sides</div><div className="fin-stat-value">{year.sides.length}</div><div className="fin-stat-sub">The gap is shown for exactly two sides</div></div>
        ) : null}
      </div>

      {year.lines.length === 0 && (
        <div className="fin-board" style={{ marginBottom: 16 }}>
          <FinanceEmpty icon="card" title={`Nothing recorded for ${taxYearLabel(year.taxYear)} yet`}
            body="Record each payout as it happens, or add the earlier ones of this year from the bank statements."
            action={<button className="boe-btn boe-btn-primary" onClick={onNewPayout}>+ New payout</button>} />
        </div>
      )}

      <div className="fp-section-title"><h3>Each account</h3><span className="fin-muted">Remuneration and incentive kept apart; the bar below is the tax-free room.</span></div>
      <div className="fp-cards">
        {cards.map(a => {
          const kinds = FOUNDER_PAYOUT_KINDS.filter(k => (a.byKind.get(k.value) ?? 0) > 0)
          const rules = found?.rules ?? null
          const room = rules ? roomLeft(a.account.taxRole, a.incomePaise / 100, a.otherIncomePaise / 100, rules) : null
          let meter: ReactNode
          if (!rules) meter = <p className="fin-muted fp-small">Tax rules for this year are not in the app.</p>
          else if (a.account.taxRole === 'unset') meter = <p className="fp-small"><span className="fin-pill fin-pill--zero">Set the role</span> to see how much {a.account.displayName} can be paid tax-free.</p>
          else if (a.account.taxRole === 'family') meter = <p className="fin-muted fp-small">Not {a.account.displayName}&rsquo;s income: counts as {a.account.side}&rsquo;s drawing, so there is no tax-free room to use.</p>
          else if (room !== null) {
            // The person's own limit after their other income: what has counted plus what is left.
            const limit = a.incomePaise + room * 100
            const pct = Math.min(100, (a.incomePaise / Math.max(1, limit)) * 100)
            const tone = room < 0 ? 'bad' : pct > 85 ? 'warn' : 'good'
            meter = (
              <>
                <div className="fp-meter"><span className={`fp-meter-fill fp-meter-fill--${tone}`} style={{ width: `${room < 0 ? 100 : pct}%` }} /></div>
                <p className="fp-small">
                  {formatLakh(a.incomePaise)} of {formatLakh(limit)} tax-free ·{' '}
                  {room < 0 ? <b className="fp-bad">{formatLakh(-room * 100)} over the line</b>
                    : !isCurrent ? <>year closed {formatLakh(room * 100)} under the line</>
                    : <><b>{formatLakh(room * 100)}</b> left{monthsLeft > 0 ? <>, about <b>{formatLakh((room * 100) / monthsLeft)}</b> a month till March</> : null}</>}
                </p>
              </>
            )
          }
          return (
            <div key={a.account.id} className="fp-card">
              <div className="fp-card-head">
                <b>{a.account.displayName}</b>
                <FounderRolePill role={a.account.taxRole} />
                <span className="fp-card-side"><span className="fin-dot" style={{ background: sideColour(a.account.side) }} /> {a.account.side}</span>
              </div>
              <div className="fp-card-total">{formatLakh(a.totalPaise)}</div>
              <div className="fp-stack" aria-hidden="true">
                {kinds.map(k => <span key={k.value} style={{ width: `${((a.byKind.get(k.value) ?? 0) / Math.max(1, a.totalPaise)) * 100}%`, background: KIND_COLOUR[k.value] }} />)}
              </div>
              <div className="fp-legend">
                {kinds.length === 0 ? <span className="fin-muted">Nothing paid this year</span> : kinds.map(k => (
                  <span key={k.value}><span className="fin-dot" style={{ background: KIND_COLOUR[k.value] }} /> {k.short} <b>{formatRupees(a.byKind.get(k.value) ?? 0)}</b></span>
                ))}
              </div>
              <div className="fp-card-meter">{meter}</div>
            </div>
          )
        })}
      </div>

      {year.lines.length > 0 && (
        <>
          <div className="fp-section-title"><h3>Month by month</h3><span className="fin-muted">April to March, the sides side by side</span></div>
          <div className="boe-card fp-months-card">
            <div className="fp-months">
              {months.map(m => {
                const bucket = year.months.get(m)
                return (
                  <div key={m} className="fp-month" title={year.sides.map(s => `${s.side} ${formatRupees(bucket?.get(s.side) ?? 0)}`).join(' · ')}>
                    <div className="fp-month-bars">
                      {year.sides.map(s => (
                        <span key={s.side} style={{ height: `${((bucket?.get(s.side) ?? 0) / maxMonth) * 100}%`, background: sideColour(s.side) }} />
                      ))}
                    </div>
                    <span className="fp-month-label">{monthName(m)}</span>
                  </div>
                )
              })}
            </div>
            <div className="fp-legend">
              {year.sides.map(s => <span key={s.side}><span className="fin-dot" style={{ background: sideColour(s.side) }} /> {s.side}&rsquo;s side <b>{formatLakh(s.totalPaise)}</b></span>)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Payments ─────────────────────────────────────────────────────────────────

function Payments({ year, lines, filters, setFilters, sides, book, onEdit, onDelete }: {
  year: FounderYear
  lines: FounderYear['lines']
  filters: Filters
  setFilters: (f: Filters | ((prev: Filters) => Filters)) => void
  sides: string[]
  book: FounderBook
  onEdit: (p: FounderPayout) => void
  onDelete: (p: FounderPayout) => void
}) {
  const narrowed = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  const groups: { payout: FounderPayout; lines: typeof lines }[] = []
  for (const l of lines) {
    const last = groups[groups.length - 1]
    if (last && last.payout.id === l.payout.id) last.lines.push(l)
    else groups.push({ payout: l.payout, lines: [l] })
  }
  const total = lines.reduce((s, l) => s + l.paise, 0)
  const byKind = new Map<FounderPayoutKind, number>()
  for (const l of lines) byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + l.paise)
  const set = (patch: Partial<Filters>) => setFilters(prev => ({ ...prev, ...patch }))

  return (
    <div data-testid="founder-payments">
      <div className="boe-list-toolbar fp-filters" role="search" aria-label="Filter payments">
        <label className="boe-list-search">
          <input type="search" aria-label="Search name, note or reference" placeholder="Search name, note or reference"
            value={filters.search} onChange={e => set({ search: e.target.value })} />
        </label>
        <select className="boe-input" aria-label="Account" value={filters.accountId} onChange={e => set({ accountId: e.target.value })}>
          <option value="">All accounts</option>
          {book.accounts.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
        </select>
        <select className="boe-input" aria-label="Kind" value={filters.kind} onChange={e => set({ kind: e.target.value })}>
          <option value="">All kinds</option>
          {FOUNDER_PAYOUT_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {sides.length > 1 && (
          <select className="boe-input" aria-label="Side" value={filters.side} onChange={e => set({ side: e.target.value })}>
            <option value="">Every side</option>
            {sides.map(s => <option key={s} value={s}>{s}&rsquo;s side</option>)}
          </select>
        )}
        <select className="boe-input" aria-label="Paid from" value={filters.paidFrom} onChange={e => set({ paidFrom: e.target.value })}>
          <option value="">Any company account</option>
          {FOUNDER_PAID_FROM.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select className="boe-input" aria-label="Month" value={filters.month} onChange={e => set({ month: e.target.value })}>
          <option value="">Whole year</option>
          {taxYearMonths(year.taxYear).map(m => <option key={m} value={m}>{monthName(m, 'long')}</option>)}
        </select>
        {narrowed && <button type="button" className="boe-btn boe-btn-ghost boe-list-clear" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </div>

      <div className="fp-summary" data-testid="founder-payments-total">
        <span><b>{formatRupees(total)}</b> in {groups.length} payout{groups.length === 1 ? '' : 's'}</span>
        {FOUNDER_PAYOUT_KINDS.filter(k => byKind.has(k.value)).map(k => (
          <span key={k.value}><span className="fin-dot" style={{ background: KIND_COLOUR[k.value] }} /> {k.short}: {formatRupees(byKind.get(k.value) ?? 0)}</span>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="fin-board">
          <FinanceEmpty icon={narrowed ? 'search' : 'card'} title={narrowed ? 'No payment matches these filters' : `No payout recorded for ${taxYearLabel(year.taxYear)}`} />
        </div>
      ) : groups.map(({ payout, lines: own }) => {
        const payoutTotal = payout.lines.reduce((s, l) => s + l.paise, 0)
        return (
          <div key={payout.id} className="fp-payout">
            <div className="fp-payout-head">
              <span className="fp-payout-date">{fmtDate(payout.paidOn)}</span>
              <span className="fin-pill fin-pill--neutral">from {paidFromLabel(payout.paidFrom)}</span>
              {payout.note && <span className="fin-muted fp-payout-note">{payout.note}</span>}
              {payout.bankReference && <span className="fin-muted fp-small">Ref {payout.bankReference}</span>}
              <span className="fp-payout-total">
                {formatRupees(payoutTotal)}
                {payout.lines.length > 1 && <span className="fin-muted fp-small"> · {new Set(payout.lines.map(l => l.accountId)).size} accounts</span>}
              </span>
              <span className="fp-payout-actions">
                <button type="button" className="fp-link" onClick={() => onEdit(payout)}>Change</button>
                <button type="button" className="fp-link fp-link--danger" onClick={() => onDelete(payout)}>Delete</button>
              </span>
            </div>
            {own.map(l => (
              <div key={l.id} className="fp-payout-line">
                <span className="fp-payout-who">{l.account?.displayName ?? '—'}<span className="fin-sub">{l.account?.side ?? ''}{l.account?.bankLabel ? ` · ${l.account.bankLabel}` : ''}</span></span>
                <span className="fp-payout-kind"><span className="fin-dot" style={{ background: KIND_COLOUR[l.kind] }} /> {kindLabel(l.kind)}</span>
                <span className="fp-payout-amount">{formatRupees(l.paise)}</span>
              </div>
            ))}
            {own.length < payout.lines.length && (
              <div className="fp-payout-line fin-muted fp-small">{payout.lines.length - own.length} more line{payout.lines.length - own.length === 1 ? '' : 's'} hidden by the filters</div>
            )}
          </div>
        )
      })}
    </div>
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
      <p style={{ margin: 0, fontSize: 13 }}>
        {fmtDate(payout.paidOn)} · {formatRupees(total)} to {payout.lines.map(l => `${names.get(l.accountId) ?? '—'} (${kindShort(l.kind)})`).join(', ')}.
        It leaves every total. The record is kept, with who deleted it and why.
      </p>
      <label className="fp-field">
        <span>Why (optional)</span>
        <input className="boe-input" maxLength={300} value={reason} placeholder="e.g. typed twice" onChange={e => setReason(e.target.value)} />
      </label>
      {error && <p className="fp-error" role="alert">{error}</p>}
      <div className="fp-modal-foot">
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
    </FinanceModal>
  )
}
