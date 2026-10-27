// ── Bank Statements: types, status rules and loaders ────────────────────────
//
// Reads go straight to the tables (RLS: finance.reconcile holders only);
// every write is an RPC. Nothing here decides who may do what — the database
// does, through assert_bank_reconcile_door().

import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankAccountKey } from '@/lib/finance/bankStatement'
import {
  suggestDebitKind,
  suggestNonCustomerKind,
  type DebitKind,
  type NonCustomerKind,
} from '@/lib/finance/bankStatement'
import {
  suggestExpensesForDebit,
  suggestPaymentsForLine,
  type ExpenseSuggestion,
  type MatchExpense,
  type MatchPayment,
  type PaymentSuggestion,
} from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'
import { samePayer, suggestOrdersForLine, type OrderSuggestion, type PayerHistoryEntry } from '@/lib/finance/bankOrderHistory'

export type BankLink = {
  id: string
  /** Set on a credit's links (to a payment). */
  payment_id?: string
  /** Set on a debit's links (to an expense). */
  expense_id?: string
  amount: number
  unlinked_at: string | null
}

export type BankLine = {
  id: string
  account: BankAccountKey
  seq: number
  line_date: string
  value_date: string | null
  narration: string
  bank_ref: string | null
  withdrawal: number
  deposit: number
  balance: number
  classification: 'old_order' | 'not_customer_money' | 'not_expense' | null
  non_customer_kind: NonCustomerKind | null
  old_order_customer: string | null
  old_order_ref: string | null
  debit_kind: DebitKind | null
  debit_payee: string | null
  note: string | null
  bank_line_payment_links: BankLink[]
  bank_line_expense_links: BankLink[]
}

export type BankPayment = MatchPayment & {
  /** Links currently active against this payment. */
  linkedAmount: number
}

export type LineStatus = 'unlinked' | 'partly' | 'linked' | 'old_order' | 'not_customer' | 'not_expense'

const num = (v: unknown) => Number(v)

/** The line's live links: to payments for a credit, to expenses for a debit. */
export function activeLinks(line: BankLine): BankLink[] {
  const source = line.withdrawal > 0 ? line.bank_line_expense_links : line.bank_line_payment_links
  return source.filter(l => l.unlinked_at === null)
}

export function linkedTotal(line: BankLine): number {
  return activeLinks(line).reduce((a, l) => a + toPaise(num(l.amount)), 0) / 100
}

export function lineStatus(line: BankLine): LineStatus {
  if (line.classification === 'old_order') return 'old_order'
  if (line.classification === 'not_customer_money') return 'not_customer'
  if (line.classification === 'not_expense') return 'not_expense'
  const linked = toPaise(linkedTotal(line))
  if (linked === 0) return 'unlinked'
  return linked >= toPaise(line.deposit > 0 ? line.deposit : line.withdrawal) ? 'linked' : 'partly'
}

export const STATUS_LABEL: Record<LineStatus, string> = {
  unlinked: 'Unlinked',
  partly: 'Partly linked',
  linked: 'Linked',
  old_order: 'Old order',
  not_customer: 'Not customer money',
  not_expense: 'Not an expense',
}

/** The same statuses in the words of money out: an unlinked debit is "Unexplained". */
export const DEBIT_STATUS_LABEL: Record<LineStatus, string> = {
  ...STATUS_LABEL,
  unlinked: 'Unexplained',
  linked: 'Linked to expense',
}

export function statusLabelFor(line: BankLine, status: LineStatus): string {
  return line.withdrawal > 0 ? DEBIT_STATUS_LABEL[status] : STATUS_LABEL[status]
}

/** Pill tones from the shared Finance colour key: amber = needs attention, blue = in progress, green = done. */
export const STATUS_TONE: Record<LineStatus, 'zero' | 'partial' | 'full' | 'over' | 'neutral'> = {
  unlinked: 'zero',
  partly: 'partial',
  linked: 'full',
  old_order: 'neutral',
  not_customer: 'neutral',
  not_expense: 'neutral',
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting verification',
  approved_unlinked: 'Verified',
  approved_linked: 'Verified',
  needs_clarification: 'Needs clarification',
  rejected: 'Rejected',
}

export type BankExpense = MatchExpense & {
  amount: number
  /** Links currently active against this expense. */
  linkedAmount: number
}

export type LineWithSuggestions = {
  line: BankLine
  status: LineStatus
  suggestions: PaymentSuggestion[]
  nonCustomer: { kind: NonCustomerKind; reason: string } | null
  /** Money out: recorded expenses this debit may be. */
  expenseSuggestions: ExpenseSuggestion[]
  /** Money out: what kind of non-expense this debit looks like. */
  debitKind: { kind: DebitKind; reason: string; payee: string | null } | null
  /** Money in: orders that earlier credits from the same payer went to. */
  orderSuggestions: OrderSuggestion[]
}

export function analyseLine(
  line: BankLine, payments: BankPayment[], expenses: BankExpense[] = [], history: PayerHistoryEntry[] = [],
): LineWithSuggestions {
  const status = lineStatus(line)
  const none = { line, status, suggestions: [], nonCustomer: null, expenseSuggestions: [], debitKind: null, orderSuggestions: [] }
  if (status !== 'unlinked' && status !== 'partly') return none
  if (line.withdrawal > 0) {
    const remainingOut = (toPaise(line.withdrawal) - toPaise(linkedTotal(line))) / 100
    return {
      ...none,
      expenseSuggestions: suggestExpensesForDebit(
        { id: line.id, line_date: line.line_date, narration: line.narration, remaining: remainingOut }, expenses),
      debitKind: suggestDebitKind(line.narration),
    }
  }
  if (line.deposit <= 0) return none
  const remaining = (toPaise(line.deposit) - toPaise(linkedTotal(line))) / 100
  const nonCustomer = suggestNonCustomerKind(line.narration)
  const suggestions = nonCustomer
    ? []
    : suggestPaymentsForLine(
        { id: line.id, account: line.account, line_date: line.line_date, narration: line.narration, bank_ref: line.bank_ref, remaining },
        payments,
      )
  return { ...none, suggestions, nonCustomer, orderSuggestions: nonCustomer ? [] : suggestOrdersForLine(line, history) }
}

// ── Months ──────────────────────────────────────────────────────────────────

export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = []
  let [y, m] = first.split('-').map(Number)
  const [ly, lm] = last.split('-').map(Number)
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out.reverse() // newest first
}

export function formatBankDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

// ── Loaders ─────────────────────────────────────────────────────────────────

/** Newest and oldest stored line date for an account, or null when nothing is imported. */
export async function loadStoredRange(supabase: SupabaseClient, account: BankAccountKey) {
  const [newest, oldest] = await Promise.all([
    supabase.from('bank_statement_lines').select('line_date').eq('account', account).order('line_date', { ascending: false }).limit(1),
    supabase.from('bank_statement_lines').select('line_date').eq('account', account).order('line_date', { ascending: true }).limit(1),
  ])
  if (newest.error || oldest.error) throw new Error('Bank lines could not be read.')
  const last = newest.data?.[0]?.line_date as string | undefined
  const first = oldest.data?.[0]?.line_date as string | undefined
  return first && last ? { first, last } : null
}

const LINE_COLUMNS =
  'id, account, seq, line_date, value_date, narration, bank_ref, withdrawal, deposit, balance, classification, non_customer_kind, old_order_customer, old_order_ref, debit_kind, debit_payee, note, ' +
  'bank_line_payment_links(id, payment_id, amount, unlinked_at), bank_line_expense_links(id, expense_id, amount, unlinked_at)'

/** Every line of one account in one month (a month is a few hundred lines at most), newest first. */
export async function loadMonthLines(supabase: SupabaseClient, account: BankAccountKey, month: string): Promise<BankLine[]> {
  const { from, to } = monthBounds(month)
  const { data, error } = await supabase
    .from('bank_statement_lines')
    .select(LINE_COLUMNS)
    .eq('account', account)
    .gte('line_date', from)
    .lte('line_date', to)
    .order('line_date', { ascending: false })
    .order('seq', { ascending: false })
    .range(0, 1999)
  if (error) throw new Error('Bank lines could not be read.')
  return ((data ?? []) as unknown as BankLine[]).map(l => ({
    ...l,
    withdrawal: num(l.withdrawal),
    deposit: num(l.deposit),
    balance: num(l.balance),
    bank_line_payment_links: (l.bank_line_payment_links ?? []).map(k => ({ ...k, amount: num(k.amount) })),
    bank_line_expense_links: (l.bank_line_expense_links ?? []).map(k => ({ ...k, amount: num(k.amount) })),
  }))
}

type PaymentRow = {
  id: string
  human_payment_id: string | null
  client_name: string | null
  amount: number | string
  payment_date: string
  payment_mode: string
  proof_note: string | null
  status: string
  bank_line_payment_links: { amount: number | string; unlinked_at: string | null }[] | null
}

const PAYMENT_COLUMNS =
  'id, human_payment_id, client_name, amount, payment_date, payment_mode, proof_note, status, bank_line_payment_links(amount, unlinked_at)'

function toBankPayment(r: PaymentRow): BankPayment {
  const linked = (r.bank_line_payment_links ?? [])
    .filter(k => k.unlinked_at === null)
    .reduce((a, k) => a + toPaise(num(k.amount)), 0) / 100
  const amount = num(r.amount)
  return {
    id: r.id,
    human_payment_id: r.human_payment_id,
    client_name: r.client_name,
    amount,
    remaining: (toPaise(amount) - toPaise(linked)) / 100,
    linkedAmount: linked,
    payment_date: r.payment_date,
    payment_mode: r.payment_mode,
    proof_note: r.proof_note,
    status: r.status,
  }
}

/**
 * Payments that could be the origin of a month's credits: HDFC payments (either
 * account — a payment is sometimes recorded against the wrong one) dated within
 * three weeks of the month, not rejected, not deleted. Plus any payment already
 * linked to a line of the month, so a link always has a name beside it.
 */
export async function loadCandidatePayments(
  supabase: SupabaseClient, month: string, linkedPaymentIds: string[],
): Promise<BankPayment[]> {
  const { from, to } = monthBounds(month)
  const { data, error } = await supabase
    .from('finance_payment_requests')
    .select(PAYMENT_COLUMNS)
    .in('payment_mode', ['hdfc', 'hdfc_sec'])
    .in('status', ['pending_approval', 'approved_unlinked', 'approved_linked', 'needs_clarification'])
    .is('deleted_at', null)
    .gte('payment_date', addDays(from, -21))
    .lte('payment_date', addDays(to, 21))
    .order('payment_date', { ascending: true })
    .range(0, 1999)
  if (error) throw new Error('Payments could not be read.')
  const byId = new Map<string, BankPayment>()
  for (const r of (data ?? []) as unknown as PaymentRow[]) byId.set(r.id, toBankPayment(r))

  const missing = linkedPaymentIds.filter(id => !byId.has(id))
  if (missing.length > 0) {
    const { data: extra, error: e2 } = await supabase
      .from('finance_payment_requests')
      .select(PAYMENT_COLUMNS)
      .in('id', missing)
    if (e2) throw new Error('Linked payments could not be read.')
    for (const r of (extra ?? []) as unknown as PaymentRow[]) byId.set(r.id, toBankPayment(r))
  }
  return [...byId.values()]
}

type ExpenseRow = {
  id: string
  expense_date: string
  amount: number | string
  payment_mode: string
  paid_to: string
  paid_from: 'company' | 'personal' | null
  remark: string | null
  bank_line_expense_links: { amount: number | string; unlinked_at: string | null }[] | null
}

const EXPENSE_COLUMNS = 'id, expense_date, amount, payment_mode, paid_to, paid_from, remark, bank_line_expense_links(amount, unlinked_at)'

function toBankExpense(r: ExpenseRow): BankExpense {
  const linked = (r.bank_line_expense_links ?? [])
    .filter(k => k.unlinked_at === null)
    .reduce((a, k) => a + toPaise(num(k.amount)), 0) / 100
  const amount = num(r.amount)
  return {
    id: r.id, expense_date: r.expense_date, paid_to: r.paid_to, payment_mode: r.payment_mode,
    paid_from: r.paid_from, remark: r.remark, amount, linkedAmount: linked,
    remaining: (toPaise(amount) - toPaise(linked)) / 100,
  }
}

/**
 * Expenses that could be the origin of a month's debits: recorded within three
 * weeks of the month and not deleted. Plus any expense already linked to a debit
 * of the month, so a link always has a name beside it. Readable by a reconciler
 * through finance.view_all, which `reconcile` depends on.
 */
export async function loadCandidateExpenses(
  supabase: SupabaseClient, month: string, linkedExpenseIds: string[],
): Promise<BankExpense[]> {
  const { from, to } = monthBounds(month)
  const { data, error } = await supabase
    .from('expenses')
    .select(EXPENSE_COLUMNS)
    .is('deleted_at', null)
    .gte('expense_date', addDays(from, -21))
    .lte('expense_date', addDays(to, 21))
    .order('expense_date', { ascending: true })
    .range(0, 1999)
  if (error) throw new Error('Expenses could not be read.')
  const byId = new Map<string, BankExpense>()
  for (const r of (data ?? []) as unknown as ExpenseRow[]) byId.set(r.id, toBankExpense(r))
  const missing = linkedExpenseIds.filter(id => !byId.has(id))
  if (missing.length > 0) {
    const { data: extra, error: e2 } = await supabase.from('expenses').select(EXPENSE_COLUMNS).in('id', missing)
    if (e2) throw new Error('Linked expenses could not be read.')
    for (const r of (extra ?? []) as unknown as ExpenseRow[]) byId.set(r.id, toBankExpense(r))
  }
  return [...byId.values()]
}

type HistoryLinkRow = {
  payment_id: string
  bank_statement_lines: { narration: string; line_date: string; deposit: number | string } | null
}

/**
 * Where earlier credits from the payers of THESE lines went. Reads the active
 * links of stored credits, keeps only those from the same payer as an unlinked
 * credit on screen, and asks the existing allocation-targets read (verified
 * payments only, visible ones only) where each payment is allocated. At most
 * 50 payments per call, so the matching payments are chunked.
 */
export async function loadPayerHistory(supabase: SupabaseClient, wantedNarrations: string[]): Promise<PayerHistoryEntry[]> {
  if (wantedNarrations.length === 0) return []
  const { data, error } = await supabase
    .from('bank_line_payment_links')
    .select('payment_id, bank_statement_lines!inner(narration, line_date, deposit)')
    .is('unlinked_at', null)
    .order('linked_at', { ascending: false })
    .range(0, 1999)
  if (error) throw new Error('Earlier payments could not be read.')
  const rows = ((data ?? []) as unknown as HistoryLinkRow[]).filter(
    r => r.bank_statement_lines && wantedNarrations.some(n => samePayer(n, r.bank_statement_lines!.narration)))
  const ids = [...new Set(rows.map(r => r.payment_id))]
  if (ids.length === 0) return []

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))
  const targets: { payment_request_id: string; target_type: string; target_id: string; target_reference: string | null; reserved_order_number: string | null; allocated_amount: number | string }[] = []
  const humans = new Map<string, string | null>()
  for (const chunk of chunks) {
    const [t, p] = await Promise.all([
      supabase.rpc('received_payment_allocation_targets', { p_payment_request_ids: chunk }),
      supabase.from('finance_payment_requests').select('id, human_payment_id').in('id', chunk),
    ])
    if (t.error || p.error) throw new Error('Earlier allocations could not be read.')
    targets.push(...((t.data ?? []) as typeof targets))
    for (const r of (p.data ?? []) as { id: string; human_payment_id: string | null }[]) humans.set(r.id, r.human_payment_id)
  }

  const out: PayerHistoryEntry[] = []
  for (const r of rows) {
    const line = r.bank_statement_lines!
    for (const t of targets.filter(x => x.payment_request_id === r.payment_id)) {
      if (t.target_type !== 'order' && t.target_type !== 'pi_draft') continue
      out.push({
        narration: line.narration, lineDate: line.line_date, allocatedAmount: num(t.allocated_amount),
        paymentId: r.payment_id, humanPaymentId: humans.get(r.payment_id) ?? null,
        targetType: t.target_type, targetId: t.target_id,
        reference: t.target_reference, reservedOrderNumber: t.reserved_order_number,
      })
    }
  }
  return out
}

/** The message after the RPC's error code ("BANK_LINE_OVER_LINKED: the bank line has only 5 left"). */
export function rpcMessage(error: { message?: string } | null | undefined, fallback: string): string {
  const m = /BANK_[A-Z_]+:\s*(.+)$/.exec(error?.message ?? '')
  return m ? m[1] : fallback
}
