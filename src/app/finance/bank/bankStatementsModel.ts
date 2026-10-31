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
import { BANK_ACCOUNT_LABEL } from '@/lib/finance/bankStatement'
import {
  amountsClose,
  daysBetween,
  nameOverlap,
  payerFromNarration,
  suggestExpensesForDebit,
  suggestPaymentsForLine,
  type ExpenseSuggestion,
  type MatchExpense,
  type MatchPayment,
  type PaymentSuggestion,
} from '@/lib/finance/bankMatching'
import { samePaise, toPaise } from '@/lib/finance/bankMoney'
import { samePayer, suggestOrdersForLine, type OrderSuggestion, type PayerHistoryEntry } from '@/lib/finance/bankOrderHistory'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { isConfirmedPayment } from '@/app/finance/paymentRouting'

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
  /** Why the last sync of this credit failed; null once it succeeds. */
  sync_error: string | null
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
  pending_approval: 'Waiting for Finance',
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

// ── What the database says about a credit ───────────────────────────────────
//
// THE PAGE DECIDES NOTHING HERE. bank_lines_sync_state is the one definition of
// Synced and bank_lines_recorded_matches the one list of payments a credit could
// be, the same rule that refuses a second payment, so the screen and the refusal
// cannot disagree. Both are read live, so a payment rejected, deleted or edited
// after it was linked shows at once.

/** Why a credit is not Synced. Null means it truly is. */
export type SyncIssue =
  | 'no_payment' | 'part_linked' | 'waiting'
  | 'payment_rejected' | 'payment_deleted' | 'other_account' | 'amount_changed'

/**
 * reference: the bank's reference is on this payment and it has room: it IS this
 * credit. reference_used: the reference is on a payment already fully linked.
 * amount: the same rupees and paise left, either HDFC account, within 21 days.
 * linked_elsewhere: the same money, on a payment linked in full to a credit further
 * from its date than this one, so that link may be the mistake.
 */
export type MatchKind = 'reference' | 'reference_used' | 'amount' | 'linked_elsewhere'

export type BankMatch = {
  paymentId: string
  humanPaymentId: string | null
  clientName: string | null
  amount: number
  leftToLink: number
  paymentDate: string
  paymentMode: string
  proofNote: string | null
  status: string
  kind: MatchKind
  /** linked_elsewhere only: the link a person can undo, and the credit it is on now. */
  linkedLinkId: string | null
  linkedLineDate: string | null
  linkedNarration: string | null
}

export type LineReview = {
  issue: SyncIssue | null
  /** Rupees of the credit no verified payment covers yet. */
  uncovered: number
  /** The linked payment the issue is about. */
  paymentLabel: string | null
  paymentMode: string | null
  matches: BankMatch[]
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
  /** Money in: what the database found. A credit it did not answer for is not in sync. */
  review: LineReview
}

export function analyseLine(
  line: BankLine, payments: BankPayment[], expenses: BankExpense[] = [], history: PayerHistoryEntry[] = [],
  review: LineReview = { issue: 'no_payment', uncovered: line.deposit, paymentLabel: null, paymentMode: null, matches: [] },
): LineWithSuggestions {
  const status = lineStatus(line)
  const none = { line, status, suggestions: [], nonCustomer: null, expenseSuggestions: [], debitKind: null, orderSuggestions: [], review }
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
  'id, account, seq, line_date, value_date, narration, bank_ref, withdrawal, deposit, balance, classification, non_customer_kind, old_order_customer, old_order_ref, debit_kind, debit_payee, note, sync_error, ' +
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

// ── Sync: every customer credit should be a payment in Confirmed Payments ───

/**
 * Synced = verified payments in this account cover every rupee of the credit.
 * Not needed = a PERSON marked it; a text guess never finishes a credit. Waiting
 * = fully linked, but the payment is not verified, so it is not in Confirmed
 * Payments yet. Everything else is Not Synced, with the reason.
 */
export type SyncState = 'synced' | 'waiting' | 'not_synced' | 'not_needed'

export function syncState(a: LineWithSuggestions): SyncState {
  if (a.line.deposit <= 0) return 'not_needed'
  if (a.status === 'old_order' || a.status === 'not_customer') return 'not_needed'
  if (a.review.issue === null) return 'synced'
  return a.review.issue === 'waiting' ? 'waiting' : 'not_synced'
}

export const SYNC_PILL: Record<SyncState, { tone: 'full' | 'over' | 'zero' | 'neutral'; label: string }> = {
  synced: { tone: 'full', label: 'Synced' },
  waiting: { tone: 'zero', label: 'Waiting for Finance' },
  not_synced: { tone: 'over', label: 'Not Synced' },
  not_needed: { tone: 'neutral', label: 'Not needed' },
}

export const SYNC_NOT_YET = 'Not added to Confirmed Payments yet'

/** Sentences the page wrote before these reasons existed; live matches replace them. */
const OUTDATED_SYNC_ERROR = /may already be recorded|already carries|(already on|this may be) .* linked to another/

/** What stands between this credit and Synced, in a sentence. Null when nothing does. */
export function syncReason(a: LineWithSuggestions): string | null {
  const { issue, paymentLabel, paymentMode, uncovered, matches } = a.review
  const payment = paymentLabel ?? 'The linked payment'
  switch (issue) {
    case null: return null
    case 'waiting': return `${payment} is waiting for Finance`
    case 'payment_rejected': return `${payment} was rejected`
    case 'payment_deleted': return `${payment} was deleted`
    case 'other_account': return `${payment} says ${paymentModeLabel(paymentMode)}`
    case 'amount_changed': return `${payment} was changed and no longer covers this credit`
    case 'part_linked': return `${formatMoney(uncovered)} of this credit has no payment`
    case 'no_payment': {
      const match = matches[0]
      if (match?.linkedLineDate) return `May be ${match.humanPaymentId ?? 'a recorded payment'}, linked to the credit of ${formatBankDate(match.linkedLineDate)}`
      if (match) return `May already be ${match.humanPaymentId ?? 'a recorded payment'}`
      if (a.nonCustomer) return `Looks like: ${a.nonCustomer.reason}. Please confirm.`
      const error = a.line.sync_error
      return error && !OUTDATED_SYNC_ERROR.test(error) ? error : SYNC_NOT_YET
    }
  }
}

/** Plain credit nobody can mistake for anything else: one press adds it. Anything else is looked at first. */
export function rowAction(a: LineWithSuggestions, canAdd: boolean): 'add' | 'review' | null {
  if (syncState(a) !== 'not_synced') return null
  const plain = a.review.issue === 'no_payment' && a.review.matches.length === 0 && !a.nonCustomer
  return plain && canAdd ? 'add' : 'review'
}

/** The credits Check sync may try: no payment yet, and not a guess that it is not a customer's. */
export function syncableLineIds(items: LineWithSuggestions[]): string[] {
  return items.filter(a => a.review.issue === 'no_payment' && !a.nonCustomer).map(a => a.line.id)
}

export type CompareRow = { label: string; credit: string; payment: string; verdict: string; tone: 'same' | 'differs' | 'plain' }

/** A date this close, and a name overlapping this much, count as fitting. */
const NEAR_DAYS = 3
const NAME_FITS = 0.5

/** The credit and a recorded payment side by side, so a person can decide. */
export function compareMatch(line: BankLine, m: BankMatch): CompareRow[] {
  const left = (toPaise(line.deposit) - toPaise(linkedTotal(line))) / 100
  // A payment linked elsewhere has nothing left to link; the money to compare is the payment itself.
  const elsewhere = m.kind === 'linked_elsewhere'
  const compared = elsewhere ? m.amount : m.leftToLink
  const sameAmount = samePaise(left, compared)
  const sharedReference = m.kind === 'reference' || m.kind === 'reference_used'
  const days = Math.abs(daysBetween(line.line_date, m.paymentDate))
  const sameAccount = m.paymentMode === line.account
  const payer = payerFromNarration(line.narration)
  const overlap = nameOverlap(m.clientName, line.narration)
  const verified = isConfirmedPayment(m.status)
  return [
    {
      label: 'Amount',
      credit: formatMoney(left),
      payment: elsewhere || samePaise(m.amount, m.leftToLink) ? formatMoney(m.amount) : `${formatMoney(m.amount)} (${formatMoney(m.leftToLink)} left)`,
      verdict: m.kind === 'reference_used' ? 'Already linked' : sameAmount ? 'Same' : `Differs by ${formatMoney(Math.abs(toPaise(left) - toPaise(compared)) / 100)}`,
      tone: sameAmount ? 'same' : 'differs',
    },
    {
      label: 'Date',
      credit: formatBankDate(line.line_date),
      payment: formatBankDate(m.paymentDate),
      verdict: days === 0 ? 'Same day' : `${days} day${days === 1 ? '' : 's'} apart`,
      tone: days <= NEAR_DAYS ? 'same' : 'differs',
    },
    {
      label: 'Account',
      credit: BANK_ACCOUNT_LABEL[line.account],
      payment: paymentModeLabel(m.paymentMode),
      verdict: sameAccount ? 'Same' : 'Different',
      tone: sameAccount ? 'same' : 'differs',
    },
    {
      label: 'Name',
      credit: payer ?? '—',
      payment: m.clientName ?? 'Not identified',
      verdict: !m.clientName ? '' : overlap >= 0.99 ? 'Same' : overlap >= NAME_FITS ? 'Partly the same' : 'No match',
      tone: overlap >= NAME_FITS ? 'same' : 'plain',
    },
    {
      label: 'Reference',
      credit: line.bank_ref ?? '—',
      payment: m.proofNote ?? 'None recorded',
      verdict: sharedReference ? 'Same reference' : '',
      tone: sharedReference ? 'same' : 'plain',
    },
    {
      label: 'Status',
      credit: '',
      payment: PAYMENT_STATUS_LABEL[m.status] ?? m.status,
      verdict: verified ? 'In Confirmed Payments' : 'Not verified yet',
      tone: verified ? 'same' : 'differs',
    },
  ]
}

/**
 * What should stop a person before linking this payment to this credit. The same
 * amount is not proof, round sums repeat, so a name that does not fit or a date
 * more than a few days off is said aloud and must be confirmed. Empty when nothing
 * stands out. The bank's own reference outweighs both.
 */
export function matchDoubts(line: BankLine, m: BankMatch): string[] {
  if (m.kind === 'reference' || m.kind === 'reference_used') return []
  const days = Math.abs(daysBetween(line.line_date, m.paymentDate))
  const doubts: string[] = []
  if (nameOverlap(m.clientName, line.narration) < NAME_FITS) doubts.push(m.clientName ? 'the name does not match' : 'the payment has no client name')
  if (days > NEAR_DAYS) doubts.push(`the dates are ${days} days apart`)
  return doubts
}

/** Where a payment opens: Confirmed Payments once verified, Payment Requests before that. */
export function paymentHref(paymentId: string, status: string): string {
  return isConfirmedPayment(status) ? `/finance/received?payment=${paymentId}` : `/finance?tab=all&request=${paymentId}`
}

export type LookAlike = { line: BankLine; exact: boolean; otherPayment: string | null }

/**
 * A payment with no bank credit, beside a credit of the same money that already
 * has a payment: the signature of one credit recorded twice. A flag for a person.
 * Only this month's credits are on the page, so one just over a month-end is not
 * flagged; the payment is still listed.
 */
export function lookAlikeCredit(p: BankPayment, credits: LineWithSuggestions[], payments: BankPayment[]): LookAlike | null {
  const found = credits
    .filter(a => a.status === 'linked' && !activeLinks(a.line).some(k => k.payment_id === p.id))
    .filter(a => amountsClose(a.line.deposit, p.remaining) && Math.abs(daysBetween(a.line.line_date, p.payment_date)) <= 21)
    .sort((a, b) => Number(samePaise(b.line.deposit, p.remaining)) - Number(samePaise(a.line.deposit, p.remaining))
      || Math.abs(daysBetween(a.line.line_date, p.payment_date)) - Math.abs(daysBetween(b.line.line_date, p.payment_date)))[0]
  if (!found) return null
  const other = payments.find(x => x.id === activeLinks(found.line)[0].payment_id)
  return { line: found.line, exact: samePaise(found.line.deposit, p.remaining), otherPayment: other?.human_payment_id ?? null }
}

export type SyncResult = {
  created: number
  linkedExisting: number
  alreadySynced: number
  failed: { lineId: string; reason: string }[]
}

/** Runs sync_bank_credits over the lines, 200 at a time (its limit). */
export async function syncBankCredits(supabase: SupabaseClient, lineIds: string[]): Promise<SyncResult> {
  const out: SyncResult = { created: 0, linkedExisting: 0, alreadySynced: 0, failed: [] }
  for (let i = 0; i < lineIds.length; i += 200) {
    const { data, error } = await supabase.rpc('sync_bank_credits', { p_line_ids: lineIds.slice(i, i + 200) })
    if (error) throw new Error(rpcMessage(error, 'The credits could not be synced.'))
    const r = data as { created?: number; linked_existing?: number; already_synced?: number; failed?: { line_id: string; reason: string }[] } | null
    out.created += Number(r?.created) || 0
    out.linkedExisting += Number(r?.linked_existing) || 0
    out.alreadySynced += Number(r?.already_synced) || 0
    out.failed.push(...(r?.failed ?? []).map(f => ({ lineId: f.line_id, reason: f.reason })))
  }
  return out
}

const REVIEW_CHUNK = 500

type SyncRow = { line_id: string; issue: SyncIssue | null; uncovered: number | string; payment_label: string | null; payment_mode: string | null }
type MatchRow = {
  line_id: string; payment_id: string; human_payment_id: string | null; client_name: string | null; amount: number | string
  left_to_link: number | string; payment_date: string; payment_mode: string; proof_note: string | null; status: string; match_kind: MatchKind
  linked_link_id: string | null; linked_line_date: string | null; linked_narration: string | null
}

/**
 * What the database says about these credits. A failed read throws, so the month
 * shows an error rather than a list nobody has checked.
 */
export async function loadLineReview(supabase: SupabaseClient, creditIds: string[]): Promise<Map<string, LineReview>> {
  const out = new Map<string, LineReview>()
  for (let i = 0; i < creditIds.length; i += REVIEW_CHUNK) {
    const { data, error } = await supabase.rpc('bank_lines_sync_state', { p_line_ids: creditIds.slice(i, i + REVIEW_CHUNK) })
    if (error) throw new Error('The sync status could not be read.')
    for (const r of (data ?? []) as SyncRow[]) {
      out.set(r.line_id, { issue: r.issue, uncovered: num(r.uncovered), paymentLabel: r.payment_label, paymentMode: r.payment_mode, matches: [] })
    }
  }
  const open = [...out].filter(([, r]) => r.issue !== null && r.issue !== 'waiting').map(([id]) => id)
  for (let i = 0; i < open.length; i += REVIEW_CHUNK) {
    const { data, error } = await supabase.rpc('bank_lines_recorded_matches', { p_line_ids: open.slice(i, i + REVIEW_CHUNK) })
    if (error) throw new Error('The recorded payments could not be compared.')
    for (const r of (data ?? []) as MatchRow[]) {
      out.get(r.line_id)?.matches.push({
        paymentId: r.payment_id, humanPaymentId: r.human_payment_id, clientName: r.client_name, amount: num(r.amount),
        leftToLink: num(r.left_to_link), paymentDate: r.payment_date, paymentMode: r.payment_mode, proofNote: r.proof_note,
        status: r.status, kind: r.match_kind,
        linkedLinkId: r.linked_link_id, linkedLineDate: r.linked_line_date, linkedNarration: r.linked_narration,
      })
    }
  }
  return out
}

export type SyncOverview = {
  accounts: BankAccountKey[]
  months: { account: BankAccountKey; month: string; not_synced: number; not_synced_amount: number; not_in_bank: number }[]
  gaps: { account: BankAccountKey; gap_from: string; gap_to: string }[]
}

/** Both accounts, every month: what is still open, and dates no statement covers. */
export async function loadSyncOverview(supabase: SupabaseClient): Promise<SyncOverview> {
  const { data, error } = await supabase.rpc('bank_sync_overview')
  if (error || !data) throw new Error('The sync check could not be read.')
  const r = data as SyncOverview
  return { ...r, months: r.months.map(m => ({ ...m, not_synced_amount: num(m.not_synced_amount) })) }
}

/** The customer credits of one import: unmarked, and not looking like non-customer money. */
export async function loadImportSyncableIds(supabase: SupabaseClient, importId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('bank_statement_lines')
    .select('id, narration')
    .eq('import_id', importId)
    .gt('deposit', 0)
    .is('classification', null)
    .range(0, 1999)
  if (error) throw new Error('The imported credits could not be read.')
  return ((data ?? []) as { id: string; narration: string }[])
    .filter(l => !suggestNonCustomerKind(l.narration))
    .map(l => l.id)
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
