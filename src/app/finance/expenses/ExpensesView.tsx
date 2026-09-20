'use client'

// ── /finance/expenses — the expense log ──────────────────────────────────────
//
// The list that replaces the spreadsheet: newest first, five filters, a total
// under whatever is on screen, and one Add action. A table on a desktop, cards
// on a phone, decided by the width the list ACTUALLY HAS rather than the
// viewport — the Finance sidebar is a fixed 260px down to 768px, so a 1024px
// window leaves a container the table does not fit. The same rule, and the same
// reasoning, as ConfirmedPaymentsList.
//
// WHAT IT DOES NOT DO, ON PURPOSE. No charts, no reporting dashboard, no export,
// no approval, no ledger. Phase 1 is: record one, find one, correct one.
//
// EVERY ROW IT SHOWS IS RLS'S DECISION. The query below asks for expenses; the
// database returns the ones this caller may see — their own, or every one if
// they hold the protected finance.view_all. Nothing here filters by person, and
// nothing here could grant sight of a row the database withheld.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { Toast, useToast } from '@/components/ui/toast'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveFinanceCapabilities, NO_FINANCE_CAPABILITIES } from '@/lib/permissions/finance'
import { formatMoney } from '@/lib/finance/piPaymentView'
import type { UserProfile } from '@/lib/types'
import {
  EMPTY_EXPENSE_FILTERS,
  EXPENSE_PAYMENT_MODES,
  expenseFiltersActive,
  expensePaymentModeLabel,
  expenseSearchClause,
  expenseTotal,
  orderedDateRange,
  selectableCategories,
  type ExpenseCategory,
  type ExpenseFilters,
  type ExpenseListRow,
  type ExpenseRow,
} from '@/lib/finance/expenses'
import { ExpenseForm, type ExpenseSaveOutcome } from './ExpenseForm'

/**
 * How many rows one read returns.
 *
 * Phase 1 has no paging — the whole filtered result is held, so the total under
 * the list is the total OF THAT RESULT and not of a page. The cap exists so a
 * first load on a table that has grown for years cannot become an unbounded
 * read; when it bites, the list says so in as many words and the total says
 * which rows it describes. It is never silently short.
 */
export const EXPENSE_LIST_LIMIT = 500

const LIST_COLUMNS =
  'id, expense_date, amount, payment_mode, paid_to, category_id, remark, created_by, created_at, updated_at, updated_by'

/**
 * THE TABLE'S COLUMNS, AND THE WIDTHS THE THRESHOLD IS COMPUTED FROM.
 *
 * Six compact columns carry a measured pixel width; Paid to and Remark carry
 * none and share whatever is left, so the columns sit where the header says
 * they are whatever the rows contain.
 *
 * The two flexible columns have no CSS floor — with `table-layout: fixed` they
 * simply divide the remainder — so the floor is enforced by the THRESHOLD
 * instead: below it there is not enough remainder to read a payee, and the list
 * draws cards. The same arrangement as CONFIRMED_PAYMENT_COLUMNS and
 * ALLOCATED_AGAINST_MIN_PX in paymentSurfaces.ts.
 */
export const EXPENSE_TABLE_COLUMNS = [
  { key: 'date',        label: 'Date',        align: 'left',  width: '100px' },
  { key: 'amount',      label: 'Amount',      align: 'right', width: '112px' },
  { key: 'paid_to',     label: 'Paid to',     align: 'left' },
  { key: 'category',    label: 'Category',    align: 'left',  width: '124px' },
  { key: 'mode',        label: 'Mode',        align: 'left',  width: '100px' },
  { key: 'remark',      label: 'Remark',      align: 'left' },
  { key: 'recorded_by', label: 'Recorded by', align: 'left',  width: '110px' },
  { key: 'actions',     label: 'Actions',     align: 'right', width: '72px' },
] as const

/** The room Paid to and Remark each need before the table is worth drawing. */
export const EXPENSE_FLEX_COLUMN_MIN_PX = 160
const EXPENSE_FLEX_REMARK_MIN_PX = 150

/**
 * The narrowest CONTAINER the eight-column table fits in.
 *
 * ARITHMETIC, NOT A GUESS, and the first version of this number was wrong.
 * It was 720 — the container a 1024px window leaves — which is what the LIST
 * has, not what the TABLE needs. At 720 the six fixed columns took 618px and
 * the two flexible ones were left about 50px between them: the payee truncated
 * to a character or two and the headers collided. Found at 768px in the
 * responsive pass and corrected here.
 *
 * The sum: 100 + 112 + 124 + 100 + 110 + 72 = 618 fixed, plus 160 for Paid to
 * and 150 for Remark = 928, rounded to 930 — deliberately the same figure as
 * CONFIRMED_TABLE_MIN_CONTAINER_PX, so both Finance lists switch at one width.
 *
 * What that means in practice, with the fixed 260px sidebar and page padding:
 * a 1280px window leaves ~976px and gets the table; a 1024px window leaves
 * ~720px and gets cards; a tablet and a phone get cards. Nothing is ever
 * clipped and nothing ever scrolls sideways.
 */
export const EXPENSE_TABLE_MIN_CONTAINER_PX =
  100 + 112 + 124 + 100 + 110 + 72 + EXPENSE_FLEX_COLUMN_MIN_PX + EXPENSE_FLEX_REMARK_MIN_PX + 2

/**
 * Table or cards, from the width the list ACTUALLY HAS.
 *
 * NOT THE VIEWPORT. The Finance sidebar is a fixed 260px down to 768px, so the
 * viewport says nothing useful about the room this list has. Measuring the
 * container is also what makes a list inside a modal and a list on a full page
 * agree without either knowing about the other.
 *
 * NULL — before the first measurement — is CARDS, because cards fit any width.
 * The first frame can therefore never clip a column or scroll sideways.
 */
export function expenseListMode(containerWidth: number | null): 'table' | 'cards' {
  if (containerWidth === null) return 'cards'
  return containerWidth >= EXPENSE_TABLE_MIN_CONTAINER_PX ? 'table' : 'cards'
}

function fmtDate(value: string): string {
  const at = new Date(`${value}T00:00:00`)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function ExpensesView() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { toast, show, dismiss } = useToast()

  const [pageLoading, setPageLoading] = useState(true)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [caps, setCaps] = useState(NO_FINANCE_CAPABILITIES)

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [rows, setRows] = useState<ExpenseListRow[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [filters, setFilters] = useState<ExpenseFilters>(EMPTY_EXPENSE_FILTERS)
  const [searchTerm, setSearchTerm] = useState('')

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ExpenseRow | null>(null)

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }, [supabase, router])

  // ── Names, resolved once ───────────────────────────────────────────────────
  //
  // Category names come from the categories already loaded for the picker, and
  // the recorder's name from one read of the people on the rows in hand. Neither
  // is joined in the list query: PostgREST would need an embedded resource whose
  // own RLS could silently drop the row's parent, and a list that loses a row
  // because its author is not readable is worse than one that prints an id.
  const [people, setPeople] = useState<Map<string, string>>(new Map())

  const loadCategories = useCallback(async (): Promise<ExpenseCategory[]> => {
    const { data, error } = await supabase
      .from('expense_categories')
      .select('id, name, is_active')
      .order('name')
    if (error) return []
    const list = (data ?? []) as ExpenseCategory[]
    setCategories(list)
    return list
  }, [supabase])

  // A load token, so a slow response for an older filter cannot land on top of a
  // newer one and repaint the list with rows nobody asked for.
  const loadToken = useRef(0)

  const loadExpenses = useCallback(async () => {
    const token = ++loadToken.current
    setListLoading(true)
    setListError(null)

    const range = orderedDateRange(filters)
    let query = supabase
      .from('expenses')
      .select(LIST_COLUMNS, { count: 'exact' })
      // NEWEST FIRST, by the date the money left — and by id after it, so two
      // expenses on the same day keep a stable order between reads.
      .order('expense_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(EXPENSE_LIST_LIMIT)

    if (range.from) query = query.gte('expense_date', range.from)
    if (range.to) query = query.lte('expense_date', range.to)
    if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
    if (filters.paymentMode) query = query.eq('payment_mode', filters.paymentMode)
    const searchClause = expenseSearchClause(filters.search)
    if (searchClause) query = query.or(searchClause)

    const { data, error, count } = await query
    if (token !== loadToken.current) return

    if (error) {
      // "The read failed" and "there are none" must never look the same on a
      // money screen. The empty state below branches on this.
      setListError('The expenses could not be loaded. Use Refresh to try again.')
      setRows([])
      setTotal(0)
      setListLoading(false)
      return
    }

    const loaded = (data ?? []) as ExpenseRow[]
    setTotal(count ?? loaded.length)

    const ids = [...new Set(loaded.map(r => r.created_by))]
    if (ids.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', ids)
      if (token !== loadToken.current) return
      setPeople(new Map((users ?? []).map((u: { id: string; full_name: string | null }) =>
        [u.id, u.full_name ?? ''])))
    }

    setRows(loaded.map(r => ({ ...r, category_name: null, created_by_name: null })))
    setListLoading(false)
  }, [supabase, filters])

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let active = true
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      if (!active) return
      setUserId(session.user.id)

      const [{ data: me }, perms] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
        loadCategories(),
        loadExpenses(),
      ])
      if (!active) return
      setProfile(me as UserProfile)
      // Capabilities start at NONE and widen only once the resolver answers, so
      // no Add or Edit control can appear before it is authorized.
      setCaps(deriveFinanceCapabilities((me as UserProfile | null)?.role, perms))
      setPageLoading(false)
    }
    void init()
    return () => { active = false }
    // Runs once: the filter-driven reload is the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The search box is DEBOUNCED — the filter it feeds is a database query, so
  // without this every keystroke would be a round trip. The other controls are
  // each one deliberate click and are applied at once.
  useEffect(() => {
    const at = setTimeout(() => setFilters(prev => ({ ...prev, search: searchTerm })), 300)
    return () => clearTimeout(at)
  }, [searchTerm])

  const firstLoad = useRef(true)
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return }
    void loadExpenses()
  }, [filters, loadExpenses])

  // ── Derived ────────────────────────────────────────────────────────────────

  const categoryName = useMemo(() => {
    const byId = new Map(categories.map(c => [c.id, c.name]))
    return (id: string) => byId.get(id) ?? '—'
  }, [categories])

  const narrowed = expenseFiltersActive(filters)
  const shownTotal = expenseTotal(rows)
  const capped = total > rows.length

  const clearFilters = () => {
    setSearchTerm('')
    setFilters(EMPTY_EXPENSE_FILTERS)
  }

  const afterSave = (outcome: ExpenseSaveOutcome, andAnother: boolean) => {
    show(outcome.mode === 'edit'
      ? `Expense corrected — ${formatMoney(outcome.amount)} to ${outcome.paidTo}`
      : `Expense saved — ${formatMoney(outcome.amount)} to ${outcome.paidTo}`)
    void loadExpenses()
    if (!andAnother) { setAdding(false); setEditing(null) }
  }

  // An expense is corrected by the person who recorded it, or by a holder of the
  // protected finance.manage. Exactly what the two UPDATE policies allow, so a
  // button drawn here matches what the database will accept.
  const mayEdit = (row: ExpenseRow) =>
    caps.canManageFinance || (userId !== null && row.created_by === userId)

  if (pageLoading) return <FinanceRouteFallback />

  return (
    <FinanceLayout
      profile={profile}
      title="Expenses"
      subtitle="Money paid out"
      onSignOut={handleSignOut}
      onRefresh={async () => { await loadCategories(); await loadExpenses() }}
      actions={caps.canCreatePaymentRecord && (
        <button onClick={() => setAdding(true)} className="boe-btn boe-btn-primary">
          Add Expense
        </button>
      )}
    >
      {/* ── Everything that narrows the list, and nothing else ── */}
      <div className="boe-list-toolbar" role="search" aria-label="Filter expenses">
        <label className="boe-list-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            aria-label="Search by paid-to name or remark"
            placeholder="Search paid to or remark"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
          )}
        </label>

        <div className="boe-list-daterange" role="group" aria-label="Expense date">
          <label className="boe-list-date">
            <span>Paid from</span>
            <input
              type="date" className="boe-input" aria-label="Expenses on or after"
              value={filters.dateFrom}
              onChange={e => setFilters(prev => ({ ...prev, dateFrom: e.target.value }))}
            />
          </label>
          <label className="boe-list-date">
            <span>to</span>
            <input
              type="date" className="boe-input" aria-label="Expenses on or before"
              value={filters.dateTo}
              onChange={e => setFilters(prev => ({ ...prev, dateTo: e.target.value }))}
            />
          </label>
        </div>

        <select
          className="boe-input expense-filter-select"
          aria-label="Filter by category"
          value={filters.categoryId}
          onChange={e => setFilters(prev => ({ ...prev, categoryId: e.target.value }))}
        >
          <option value="">All categories</option>
          {selectableCategories(categories, filters.categoryId || null).map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <select
          className="boe-input expense-filter-select"
          aria-label="Filter by payment mode"
          value={filters.paymentMode}
          onChange={e => setFilters(prev => ({ ...prev, paymentMode: e.target.value }))}
        >
          <option value="">All modes</option>
          {EXPENSE_PAYMENT_MODES.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>

        {narrowed && (
          <button type="button" onClick={clearFilters} className="boe-btn boe-btn-ghost boe-list-clear">
            Clear filters
          </button>
        )}
      </div>

      {/* ── The total of what is on screen ──
          Stated as what it is. When the cap has bitten it says which rows it
          describes rather than presenting a partial figure as the whole. */}
      <div
        aria-live="polite"
        style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: '10px', flexWrap: 'wrap', marginBottom: '10px',
          padding: '10px 12px', borderRadius: '10px',
          border: `1px solid ${colors.border}`, background: colors.raised,
        }}
      >
        <span style={{ fontSize: '12px', color: colors.tertiary }}>
          {listLoading
            ? 'Loading…'
            : listError
              ? 'Total unavailable'
              : capped
                ? `Total of the ${rows.length} most recent shown, of ${total}`
                : `Total${narrowed ? ' (filtered)' : ''} · ${total} ${total === 1 ? 'expense' : 'expenses'}`}
        </span>
        <span style={{
          fontSize: '17px', fontWeight: 700, color: colors.primary,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {listLoading || listError ? '—' : formatMoney(shownTotal)}
        </span>
      </div>

      {capped && !listLoading && !listError && (
        <div role="status" style={{
          marginBottom: '10px', padding: '9px 12px', borderRadius: '8px',
          border: `1px solid ${colors.border}`, background: colors.amberTint,
          fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
        }}>
          Showing the {rows.length} most recent of {total} matching expenses. Narrow the
          dates to see the rest, and for a complete total of a period.
        </div>
      )}

      <div className="boe-card" style={{ overflow: 'hidden' }}>
        <ExpenseList
          rows={rows}
          loading={listLoading}
          error={listError}
          narrowed={narrowed}
          categoryName={categoryName}
          personName={(id: string) => people.get(id) ?? '—'}
          mayEdit={mayEdit}
          onEdit={setEditing}
          onClearFilters={clearFilters}
        />
      </div>

      {adding && userId && (
        <FinanceModal title="Add Expense" onClose={() => setAdding(false)} width="560px" closeOnBackdropClick={false}>
          <ExpenseForm
            supabase={supabase}
            userId={userId}
            mode="add"
            categories={categories}
            onCategoryCreated={c => setCategories(prev => [...prev, c])}
            onSaved={afterSave}
            onCancel={() => setAdding(false)}
            showSaveAndAddAnother
            autoFocus
          />
        </FinanceModal>
      )}

      {editing && userId && (
        <FinanceModal
          title="Correct Expense"
          onClose={() => setEditing(null)}
          width="560px"
          closeOnBackdropClick={false}
        >
          <ExpenseForm
            supabase={supabase}
            userId={userId}
            mode="edit"
            expense={editing}
            categories={categories}
            onCategoryCreated={c => setCategories(prev => [...prev, c])}
            onSaved={afterSave}
            onCancel={() => setEditing(null)}
          />
        </FinanceModal>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}

// ── Table or cards, by the room actually available ───────────────────────────

type ListProps = {
  rows: ExpenseListRow[]
  loading: boolean
  error: string | null
  narrowed: boolean
  categoryName: (id: string) => string
  personName: (id: string) => string
  mayEdit: (row: ExpenseRow) => boolean
  onEdit: (row: ExpenseRow) => void
  onClearFilters: () => void
}

export function ExpenseList(props: ListProps) {
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setContainerWidth(Math.floor(width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const asTable = expenseListMode(containerWidth) === 'table'

  const { loading, error, rows, narrowed } = props

  return (
    <div ref={containerRef} data-expense-list={asTable ? 'table' : 'cards'} style={{ width: '100%' }}>
      {loading ? (
        <EmptyState title="Loading expenses…" />
      ) : error ? (
        <EmptyState title={error} tone="error" />
      ) : rows.length === 0 ? (
        narrowed ? (
          <EmptyState
            title="No expenses match these filters."
            action={<button onClick={props.onClearFilters} className="boe-btn boe-btn-ghost" style={{ minHeight: '44px' }}>Clear filters</button>}
          />
        ) : (
          <EmptyState title="No expenses recorded yet." body="Use Add Expense to record the first one." />
        )
      ) : asTable ? (
        <ExpenseTable {...props} />
      ) : (
        <ExpenseCards {...props} />
      )}
    </div>
  )
}

function EmptyState({ title, body, action, tone }: {
  title: string; body?: string; action?: React.ReactNode; tone?: 'error'
}) {
  return (
    <div style={{
      padding: '36px 20px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: tone === 'error' ? '#C13030' : colors.secondary }}>
        {title}
      </div>
      {body && <div style={{ fontSize: '12px', color: colors.muted }}>{body}</div>}
      {action}
    </div>
  )
}

const TH: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left',
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em',
  borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = {
  padding: '9px 12px', borderBottom: `1px solid ${colors.border}`,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}

export function ExpenseTable({ rows, categoryName, personName, mayEdit, onEdit }: ListProps) {
  return (
    // FIXED LAYOUT, so the columns sit where the header says they are whatever
    // the rows contain, and a long payee truncates instead of widening the table
    // past its container.
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <thead>
        <tr>
          {EXPENSE_TABLE_COLUMNS.map(column => (
            <th
              key={column.key}
              style={{
                ...TH,
                textAlign: column.align,
                ...('width' in column ? { width: column.width } : {}),
              }}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>{fmtDate(row.expense_date)}</td>
            <td style={{
              ...TD, fontSize: '13.5px', fontWeight: 700, color: colors.primary,
              textAlign: 'right', fontVariantNumeric: 'tabular-nums',
            }}>
              {formatMoney(row.amount)}
            </td>
            <td style={{ ...TD, fontSize: '13px', color: colors.primary }} title={row.paid_to}>
              {row.paid_to}
            </td>
            <td style={{ ...TD, fontSize: '12px', color: colors.secondary }} title={categoryName(row.category_id)}>
              {categoryName(row.category_id)}
            </td>
            <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
              {expensePaymentModeLabel(row.payment_mode)}
            </td>
            {/* COMPACT, and complete on hover: a remark is context, not a field
                anybody scans down a column. */}
            <td style={{ ...TD, fontSize: '12px', color: colors.tertiary }} title={row.remark ?? ''}>
              {row.remark ?? '—'}
            </td>
            <td style={{ ...TD, fontSize: '12px', color: colors.tertiary }} title={personName(row.created_by)}>
              {personName(row.created_by)}
            </td>
            <td style={{ ...TD, textAlign: 'right' }}>
              {mayEdit(row) ? (
                <button
                  onClick={() => onEdit(row)}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '4px 10px', fontSize: '12px' }}
                  aria-label={`Correct the expense of ${formatMoney(row.amount)} paid to ${row.paid_to}`}
                >
                  Edit
                </button>
              ) : <span style={{ fontSize: '12px', color: colors.muted }}>—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── The mobile list ──────────────────────────────────────────────────────────
//
// SAME DATA, SAME DECISIONS. Nothing a desktop reader sees is hidden here: the
// amount and payee lead, the date, mode and category sit under them, the remark
// is on its own line, and Edit is a full-height tap target rather than a
// squeezed link.

export function ExpenseCards({ rows, categoryName, personName, mayEdit, onEdit }: ListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(row => (
        <div
          key={row.id}
          style={{
            padding: '12px 14px', borderBottom: `1px solid ${colors.border}`,
            display: 'flex', flexDirection: 'column', gap: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{
              fontSize: '13.5px', fontWeight: 600, color: colors.primary,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {row.paid_to}
            </span>
            <span style={{
              fontSize: '14.5px', fontWeight: 700, color: colors.primary,
              flexShrink: 0, fontVariantNumeric: 'tabular-nums',
            }}>
              {formatMoney(row.amount)}
            </span>
          </div>

          <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
            {fmtDate(row.expense_date)} · {categoryName(row.category_id)} · {expensePaymentModeLabel(row.payment_mode)}
          </div>

          {row.remark && (
            <div style={{ fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.5 }}>
              {row.remark}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: colors.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {personName(row.created_by)}
            </span>
            {mayEdit(row) && (
              <button
                onClick={() => onEdit(row)}
                className="boe-btn boe-btn-ghost"
                style={{ flexShrink: 0, minHeight: '40px', padding: '6px 14px', fontSize: '12.5px' }}
                aria-label={`Correct the expense of ${formatMoney(row.amount)} paid to ${row.paid_to}`}
              >
                Edit
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// Exported for the quick-entry page's "Add Expense" affordance, so both surfaces
// say the same words.
export const ADD_EXPENSE_LABEL = 'Add Expense'
export { Plus as AddExpenseIcon }
