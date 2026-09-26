'use client'

// ── /finance/expenses — the expense log, and the capture inbox ──────────────
//
// TWO TABS, AND THE SECOND ONE IS NOT A SECOND EXPENSE LIST.
//
//   Expenses       the log that replaces the spreadsheet: newest first, five
//                  filters, a total under whatever is on screen, Add, Edit and
//                  Delete.
//   Needs Details  captures waiting for the rest of their details. A DIFFERENT
//                  TABLE — public.expense_drafts — and nothing in it counts
//                  towards the total above, the category totals, the Smart
//                  suggestion's learning or any report. Not because this file
//                  filters it out: because the expense query does not read that
//                  table and never could.
//
// A DELETED EXPENSE IS NOT HERE AT ALL. The list query asks the database for
// `deleted_at is null`, the total re-applies the same rule, and the learning set
// the Smart suggestion is built from asks for it a third time. A removed expense
// is absent from every figure on this page.
//
// EVERY ROW IT SHOWS IS RLS'S DECISION. The queries below ask for expenses and
// drafts; the database returns the ones this caller may see — their own, or
// every one if they hold the protected finance.view_all. Nothing here filters by
// person, and nothing here could grant sight of a row the database withheld.
//
// A table on a desktop, cards on a phone, decided by the width the list ACTUALLY
// HAS rather than the viewport — the Finance sidebar is a fixed 260px down to
// 768px, so a 1024px window leaves a container the table does not fit. The same
// rule, and the same reasoning, as ConfirmedPaymentsList.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
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
import { mayDeleteExpense, mayEditExpense } from '@/lib/finance/expenseDeletion'
import type { ExpenseHistoryEntry } from '@/lib/finance/expenseCategoryMatch'
import {
  NEEDS_DETAILS_LABEL,
  QUICK_CAPTURE_LABEL,
  QUICK_CAPTURE_SAVED_MESSAGE,
  mayActOnDraft,
  pendingDraftCount,
  type ExpenseDraftRow,
} from '@/lib/finance/expenseDrafts'
import { ExpenseForm, type ExpenseSaveOutcome } from './ExpenseForm'
import { ExpenseErrorBoundary } from './ExpenseErrorBoundary'
import { DeleteExpenseModal } from './DeleteExpenseModal'
import { NeedsDetailsList } from './NeedsDetailsList'
import { QuickCapture } from './QuickCapture'

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

/**
 * How many earlier expenses the Smart suggestion learns from.
 *
 * SEPARATE FROM THE LIST, and deliberately so: the list is whatever the filters
 * asked for, and a suggestion must not change because somebody narrowed the
 * dates to September. This is one small read of the most recent expenses —
 * three columns, no names, no joins — and it is the matcher's entire training
 * set.
 */
export const EXPENSE_HISTORY_LIMIT = 400

const LIST_COLUMNS =
  'id, expense_date, amount, payment_mode, paid_to, category_id, remark, created_by, created_at, updated_at, updated_by, deleted_at, deleted_by'

/**
 * THE TABLE'S COLUMNS, AND THE WIDTHS THE THRESHOLD IS COMPUTED FROM.
 *
 * Six compact columns carry a measured pixel width; Paid to and Remark carry
 * none and share whatever is left, so the columns sit where the header says
 * they are whatever the rows contain.
 *
 * ACTIONS GREW FROM 72 TO 106 to hold Delete beside Edit, AND THE FIXED TOTAL
 * DID NOT MOVE: Date, Category, Mode and Recorded by each gave up a few pixels
 * they were not using (100→96, 124→112, 100→92, 110→100), so the six still sum
 * to 618 and EXPENSE_TABLE_MIN_CONTAINER_PX is still 930 — the same width at
 * which Confirmed Payments switches. Adding a second action did not cost the
 * payee or the remark a single pixel, and did not move the breakpoint a phone
 * or a tablet depends on.
 *
 * The two flexible columns have no CSS floor — with `table-layout: fixed` they
 * simply divide the remainder — so the floor is enforced by the THRESHOLD
 * instead: below it there is not enough remainder to read a payee, and the list
 * draws cards. The same arrangement as CONFIRMED_PAYMENT_COLUMNS and
 * ALLOCATED_AGAINST_MIN_PX in paymentSurfaces.ts.
 */
export const EXPENSE_TABLE_COLUMNS = [
  { key: 'date',        label: 'Date',        align: 'left',  width: '96px' },
  { key: 'amount',      label: 'Amount',      align: 'right', width: '112px' },
  { key: 'paid_to',     label: 'Paid to',     align: 'left' },
  { key: 'category',    label: 'Category',    align: 'left',  width: '112px' },
  { key: 'mode',        label: 'Mode',        align: 'left',  width: '92px' },
  { key: 'remark',      label: 'Remark',      align: 'left' },
  { key: 'recorded_by', label: 'Recorded by', align: 'left',  width: '100px' },
  { key: 'actions',     label: 'Actions',     align: 'right', width: '106px' },
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
 * The sum: 96 + 112 + 112 + 92 + 100 + 106 = 618 fixed, plus 160 for Paid to
 * and 150 for Remark = 928, rounded to 930 — deliberately the same figure as
 * CONFIRMED_TABLE_MIN_CONTAINER_PX, so both Finance lists switch at one width.
 *
 * What that means in practice, with the fixed 260px sidebar and page padding:
 * a 1280px window leaves ~976px and gets the table; a 1024px window leaves
 * ~720px and gets cards; a tablet and a phone get cards. Nothing is ever
 * clipped and nothing ever scrolls sideways.
 */
export const EXPENSE_TABLE_MIN_CONTAINER_PX =
  96 + 112 + 112 + 92 + 100 + 106 + EXPENSE_FLEX_COLUMN_MIN_PX + EXPENSE_FLEX_REMARK_MIN_PX + 2

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

/** The two tabs, as a value the render branches on. */
export type ExpenseTab = 'expenses' | 'drafts'

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

  const [tab, setTab] = useState<ExpenseTab>('expenses')

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [rows, setRows] = useState<ExpenseListRow[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [history, setHistory] = useState<ExpenseHistoryEntry[]>([])

  const [drafts, setDrafts] = useState<ExpenseDraftRow[]>([])
  const [draftsLoading, setDraftsLoading] = useState(true)
  const [draftsError, setDraftsError] = useState<string | null>(null)

  const [filters, setFilters] = useState<ExpenseFilters>(EMPTY_EXPENSE_FILTERS)
  const [searchTerm, setSearchTerm] = useState('')

  const [adding, setAdding] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [editing, setEditing] = useState<ExpenseRow | null>(null)
  const [deleting, setDeleting] = useState<ExpenseRow | null>(null)
  const [completing, setCompleting] = useState<ExpenseDraftRow | null>(null)

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

  /**
   * THE SMART SUGGESTION'S TRAINING SET, read once and separately.
   *
   * `deleted_at is null` is asked of the DATABASE, so a removed expense never
   * reaches the browser to be learned from; the matcher re-applies the same rule
   * over whatever it is handed. Drafts cannot appear here at all — this reads
   * public.expenses, and a draft is not in it.
   */
  const loadHistory = useCallback(async () => {
    const { data, error } = await supabase
      .from('expenses')
      .select('category_id, paid_to, remark, deleted_at')
      .is('deleted_at', null)
      .order('expense_date', { ascending: false })
      .limit(EXPENSE_HISTORY_LIMIT)
    // A failed read means no suggestions, never wrong ones.
    setHistory(error ? [] : ((data ?? []) as ExpenseHistoryEntry[]))
  }, [supabase])

  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true)
    setDraftsError(null)
    const { data, error } = await supabase
      .from('expense_drafts')
      .select('*')
      // ONLY THE PENDING ONES. A finalized draft became an expense and a
      // discarded one was not wanted; both stay in the table for audit and
      // neither belongs in an inbox.
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) {
      setDraftsError('The captures could not be loaded. Use Refresh to try again.')
      setDrafts([])
    } else {
      setDrafts((data ?? []) as ExpenseDraftRow[])
    }
    setDraftsLoading(false)
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
      // ── DELETED EXPENSES ARE NOT IN THE LIST, THE FILTERS OR THE TOTAL ──
      // Asked of the database rather than filtered in the browser, so the
      // `count` beside the rows is a count of LIVE expenses and the total under
      // them describes the same set. A removed expense is absent from every
      // figure on this page.
      .is('deleted_at', null)
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
        loadDrafts(),
        loadHistory(),
      ])
      if (!active) return
      setProfile(me as UserProfile)
      // Capabilities start at NONE and widen only once the resolver answers, so
      // no Add, Edit or Delete control can appear before it is authorized.
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
  const pendingCount = pendingDraftCount(drafts)

  const clearFilters = () => {
    setSearchTerm('')
    setFilters(EMPTY_EXPENSE_FILTERS)
  }

  const afterSave = (outcome: ExpenseSaveOutcome, andAnother: boolean) => {
    show(outcome.mode === 'edit'
      ? `Expense corrected — ${formatMoney(outcome.amount)} to ${outcome.paidTo}`
      : `Expense saved — ${formatMoney(outcome.amount)} to ${outcome.paidTo}`)
    void loadExpenses()
    // THE SUGGESTION LEARNS FROM WHAT WAS JUST FILED, on the next form that
    // opens. This is the whole of "it gets better as more expenses are
    // finalized" — one more row in the training set, no model, no retraining.
    void loadHistory()
    if (outcome.mode === 'complete') {
      // The capture has left the inbox. Re-read rather than removing it here:
      // the database decided, and the badge should agree with the database.
      void loadDrafts()
      setCompleting(null)
      return
    }
    if (!andAnother) { setAdding(false); setEditing(null) }
  }

  // An expense is corrected or removed by the person who recorded it, or by a
  // holder of the protected finance.manage — and never once it has been
  // deleted. Exactly what the two UPDATE policies and the guard trigger allow,
  // so a button drawn here matches what the database will accept.
  const actor = { userId, canManageFinance: caps.canManageFinance }
  const mayEdit = (row: ExpenseRow) => mayEditExpense(row, actor)
  const mayDelete = (row: ExpenseRow) => mayDeleteExpense(row, actor)

  if (pageLoading) return <FinanceRouteFallback />

  return (
    <FinanceLayout
      profile={profile}
      title="Expenses"
      subtitle="Money paid out"
      onSignOut={handleSignOut}
      onRefresh={async () => {
        await loadCategories()
        await loadExpenses()
        await loadDrafts()
        await loadHistory()
      }}
      actions={caps.canCreatePaymentRecord && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={() => setCapturing(true)} className="boe-btn boe-btn-ghost">
            {QUICK_CAPTURE_LABEL}
          </button>
          <button onClick={() => setAdding(true)} className="boe-btn boe-btn-primary">
            Add Expense
          </button>
        </div>
      )}
    >
      {/* ── THE TWO TABS ──
          Needs Details carries a count because it IS a queue — something is
          waiting for this person, which is exactly the fact a badge should
          report. The Expenses tab carries none: a log is not a queue, and a
          number beside it would count rows rather than report work. */}
      <div
        role="tablist"
        aria-label="Expenses and captures"
        data-testid="expense-tabs"
        style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}
      >
        <TabButton
          id="expenses" label="Expenses" active={tab === 'expenses'}
          onClick={() => setTab('expenses')}
        />
        <TabButton
          id="drafts" label={NEEDS_DETAILS_LABEL} active={tab === 'drafts'}
          badge={pendingCount}
          onClick={() => setTab('drafts')}
        />
      </div>

      {tab === 'drafts' ? (
        <div className="boe-card" style={{ overflow: 'hidden' }}>
          {userId && (
            <NeedsDetailsList
              rows={drafts}
              loading={draftsLoading}
              error={draftsError}
              personName={(id: string) => people.get(id) ?? '—'}
              mayAct={row => mayActOnDraft(row, actor)}
              onComplete={setCompleting}
              onDiscarded={row => {
                show('Capture discarded')
                setDrafts(prev => prev.filter(d => d.id !== row.id))
                void loadDrafts()
              }}
              supabase={supabase}
              userId={userId}
            />
          )}
        </div>
      ) : (
        <>
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
              describes rather than presenting a partial figure as the whole.
              DELETED EXPENSES ARE NOT IN IT: the query excluded them and
              expenseTotal excludes them again. */}
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
            {/* ONE MALFORMED ROW MUST NOT COST THE WHOLE PAGE. The filters,
                the total and the tabs above stay usable. */}
            <ExpenseErrorBoundary label="list">
            <ExpenseList
              rows={rows}
              loading={listLoading}
              error={listError}
              narrowed={narrowed}
              categoryName={categoryName}
              personName={(id: string) => people.get(id) ?? '—'}
              mayEdit={mayEdit}
              mayDelete={mayDelete}
              onEdit={setEditing}
              onDelete={setDeleting}
              onClearFilters={clearFilters}
            />
            </ExpenseErrorBoundary>
          </div>
        </>
      )}

      {adding && userId && (
        <FinanceModal title="Add Expense" onClose={() => setAdding(false)} width="560px" closeOnBackdropClick={false}>
          <ExpenseForm
            supabase={supabase}
            userId={userId}
            mode="add"
            categories={categories}
            history={history}
            onCategoryCreated={c => setCategories(prev => [...prev, c])}
            onSaved={afterSave}
            onCancel={() => setAdding(false)}
            showSaveAndAddAnother
            autoFocus
          />
        </FinanceModal>
      )}

      {capturing && userId && (
        <FinanceModal title={QUICK_CAPTURE_LABEL} onClose={() => setCapturing(false)} width="480px" closeOnBackdropClick={false}>
          <QuickCapture
            supabase={supabase}
            userId={userId}
            autoFocus
            onSaved={() => {
              show(QUICK_CAPTURE_SAVED_MESSAGE)
              setCapturing(false)
              setTab('drafts')
              void loadDrafts()
            }}
            onCancel={() => setCapturing(false)}
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
          {/* A CRASH HERE USED TO TAKE THE WHOLE PAGE. Now it costs the
              modal, and the list behind it keeps working. */}
          <ExpenseErrorBoundary label="edit" onReset={() => setEditing(null)}>
            <ExpenseForm
              supabase={supabase}
              userId={userId}
              mode="edit"
              expense={editing}
              categories={categories}
              history={history}
              onCategoryCreated={c => setCategories(prev => [...prev, c])}
              onSaved={afterSave}
              onCancel={() => setEditing(null)}
            />
          </ExpenseErrorBoundary>
        </FinanceModal>
      )}

      {/* ── COMPLETING A CAPTURE OPENS THE ORDINARY FORM ──
          Same fields, same validation, same Smart suggestion, same final
          review. Only the write differs, and only because it must be one
          transaction. */}
      {completing && userId && (
        <FinanceModal
          title="Complete capture"
          onClose={() => setCompleting(null)}
          width="560px"
          closeOnBackdropClick={false}
        >
          {/* THE SAME GUARD AS EDIT. This form is also prefilled from a stored
              row (parsed_amount arrives as a NUMBER), and before #179 it
              crashed the whole route exactly as Edit did. */}
          <ExpenseErrorBoundary label="complete" onReset={() => setCompleting(null)}>
            <ExpenseForm
              supabase={supabase}
              userId={userId}
              mode="complete"
              draft={completing}
              categories={categories}
              history={history}
              onCategoryCreated={c => setCategories(prev => [...prev, c])}
              onSaved={afterSave}
              onCancel={() => setCompleting(null)}
            />
          </ExpenseErrorBoundary>
        </FinanceModal>
      )}

      {deleting && userId && (
        <DeleteExpenseModal
          supabase={supabase}
          userId={userId}
          expense={deleting}
          categoryName={categoryName(deleting.category_id)}
          onClose={() => setDeleting(null)}
          onDeleted={row => {
            setDeleting(null)
            show(`Expense deleted — ${formatMoney(row.amount)} to ${row.paid_to}`)
            // THE LIST AND THE TOTAL UPDATE IMMEDIATELY. Removed from the rows
            // in hand first so the figure changes in the same frame as the
            // toast, then re-read so the count beside it comes from the
            // database rather than from arithmetic here.
            setRows(prev => prev.filter(r => r.id !== row.id))
            setTotal(prev => Math.max(0, prev - 1))
            void loadExpenses()
            // AND IT STOPS TEACHING THE MATCHER. Re-read, so the next
            // suggestion is computed without it.
            void loadHistory()
          }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </FinanceLayout>
  )
}

// ── One tab ──────────────────────────────────────────────────────────────────

function TabButton({ id, label, active, badge, onClick }: {
  id: string
  label: string
  active: boolean
  badge?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`expense-tab-${id}`}
      aria-selected={active}
      onClick={onClick}
      className="boe-btn"
      style={{
        display: 'flex', alignItems: 'center', gap: '7px',
        minHeight: '42px', padding: '8px 15px', fontSize: '13px',
        fontWeight: active ? 700 : 600,
        background: active ? colors.base : 'transparent',
        color: active ? colors.primary : colors.tertiary,
        border: `1px solid ${active ? colors.borderSoft : 'transparent'}`,
      }}
    >
      {label}
      {/* Hidden at a real zero: a badge showing 0 is a thing to read and
          dismiss, every time, forever. */}
      {typeof badge === 'number' && badge > 0 && (
        <span
          data-testid="needs-details-badge"
          style={{
            minWidth: '19px', height: '19px', padding: '0 5px', borderRadius: '10px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '10.5px', fontWeight: 700,
            background: 'rgba(217,148,0,0.16)', color: '#8A5A00',
          }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
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
  mayDelete: (row: ExpenseRow) => boolean
  onEdit: (row: ExpenseRow) => void
  onDelete: (row: ExpenseRow) => void
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

export function ExpenseTable({ rows, categoryName, personName, mayEdit, mayDelete, onEdit, onDelete }: ListProps) {
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
              {mayEdit(row) || mayDelete(row) ? (
                <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end', alignItems: 'center' }}>
                  {mayEdit(row) && (
                    <button
                      onClick={() => onEdit(row)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '4px 9px', fontSize: '12px' }}
                      aria-label={`Correct the expense of ${formatMoney(row.amount)} paid to ${row.paid_to}`}
                    >
                      Edit
                    </button>
                  )}
                  {/* ICON-ONLY, AND NAMED FOR EVERYBODY WHO CANNOT SEE IT. The
                      column has room for one word and one icon; the word goes
                      to the action somebody performs often. */}
                  {mayDelete(row) && (
                    <button
                      onClick={() => onDelete(row)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '4px 7px', fontSize: '12px', color: '#C13030', lineHeight: 1 }}
                      aria-label={`Delete the expense of ${formatMoney(row.amount)} paid to ${row.paid_to}`}
                      title="Delete"
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  )}
                </div>
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
// is on its own line, and Edit and Delete are full-height tap targets rather
// than squeezed links.

export function ExpenseCards({ rows, categoryName, personName, mayEdit, mayDelete, onEdit, onDelete }: ListProps) {
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
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
              {mayEdit(row) && (
                <button
                  onClick={() => onEdit(row)}
                  className="boe-btn boe-btn-ghost"
                  style={{ minHeight: '40px', padding: '6px 14px', fontSize: '12.5px' }}
                  aria-label={`Correct the expense of ${formatMoney(row.amount)} paid to ${row.paid_to}`}
                >
                  Edit
                </button>
              )}
              {mayDelete(row) && (
                <button
                  onClick={() => onDelete(row)}
                  className="boe-btn boe-btn-ghost"
                  style={{ minHeight: '40px', padding: '6px 12px', fontSize: '12.5px', color: '#C13030' }}
                  aria-label={`Delete the expense of ${formatMoney(row.amount)} paid to ${row.paid_to}`}
                >
                  Delete
                </button>
              )}
            </div>
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
