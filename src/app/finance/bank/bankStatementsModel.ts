// ── Bank Statements: types, status rules and loaders ────────────────────────
//
// Reads go straight to the tables (RLS: finance.reconcile holders only);
// every write is an RPC. Nothing here decides who may do what — the database
// does, through assert_bank_reconcile_door().

import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankAccountKey } from '@/lib/finance/bankStatement'
import {
  suggestNonCustomerKind,
  type NonCustomerKind,
} from '@/lib/finance/bankStatement'
import {
  suggestPaymentsForLine,
  type MatchPayment,
  type PaymentSuggestion,
} from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'

export type BankLink = {
  id: string
  payment_id: string
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
  classification: 'old_order' | 'not_customer_money' | null
  non_customer_kind: NonCustomerKind | null
  old_order_customer: string | null
  old_order_ref: string | null
  note: string | null
  bank_line_payment_links: BankLink[]
}

export type BankPayment = MatchPayment & {
  /** Links currently active against this payment. */
  linkedAmount: number
}

export type LineStatus = 'unlinked' | 'partly' | 'linked' | 'old_order' | 'not_customer'

const num = (v: unknown) => Number(v)

export function activeLinks(line: BankLine): BankLink[] {
  return line.bank_line_payment_links.filter(l => l.unlinked_at === null)
}

export function linkedTotal(line: BankLine): number {
  return activeLinks(line).reduce((a, l) => a + toPaise(num(l.amount)), 0) / 100
}

export function lineStatus(line: BankLine): LineStatus {
  if (line.classification === 'old_order') return 'old_order'
  if (line.classification === 'not_customer_money') return 'not_customer'
  const linked = toPaise(linkedTotal(line))
  if (linked === 0) return 'unlinked'
  return linked >= toPaise(line.deposit) ? 'linked' : 'partly'
}

export const STATUS_LABEL: Record<LineStatus, string> = {
  unlinked: 'Unlinked',
  partly: 'Partly linked',
  linked: 'Linked',
  old_order: 'Old order',
  not_customer: 'Not customer money',
}

/** Pill tones from the shared Finance colour key: amber = needs attention, blue = in progress, green = done. */
export const STATUS_TONE: Record<LineStatus, 'zero' | 'partial' | 'full' | 'over' | 'neutral'> = {
  unlinked: 'zero',
  partly: 'partial',
  linked: 'full',
  old_order: 'neutral',
  not_customer: 'neutral',
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting verification',
  approved_unlinked: 'Verified',
  approved_linked: 'Verified',
  needs_clarification: 'Needs clarification',
  rejected: 'Rejected',
}

export type LineWithSuggestions = {
  line: BankLine
  status: LineStatus
  suggestions: PaymentSuggestion[]
  nonCustomer: { kind: NonCustomerKind; reason: string } | null
}

export function analyseLine(line: BankLine, payments: BankPayment[]): LineWithSuggestions {
  const status = lineStatus(line)
  if (line.deposit <= 0 || (status !== 'unlinked' && status !== 'partly')) {
    return { line, status, suggestions: [], nonCustomer: null }
  }
  const remaining = (toPaise(line.deposit) - toPaise(linkedTotal(line))) / 100
  const nonCustomer = suggestNonCustomerKind(line.narration)
  const suggestions = nonCustomer
    ? []
    : suggestPaymentsForLine(
        { id: line.id, account: line.account, line_date: line.line_date, narration: line.narration, bank_ref: line.bank_ref, remaining },
        payments,
      )
  return { line, status, suggestions, nonCustomer }
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
  'id, account, seq, line_date, value_date, narration, bank_ref, withdrawal, deposit, balance, classification, non_customer_kind, old_order_customer, old_order_ref, note, ' +
  'bank_line_payment_links(id, payment_id, amount, unlinked_at)'

/** Every line of one account in one month (a month is a few hundred lines at most). */
export async function loadMonthLines(supabase: SupabaseClient, account: BankAccountKey, month: string): Promise<BankLine[]> {
  const { from, to } = monthBounds(month)
  const { data, error } = await supabase
    .from('bank_statement_lines')
    .select(LINE_COLUMNS)
    .eq('account', account)
    .gte('line_date', from)
    .lte('line_date', to)
    .order('line_date', { ascending: true })
    .order('seq', { ascending: true })
    .range(0, 1999)
  if (error) throw new Error('Bank lines could not be read.')
  return ((data ?? []) as unknown as BankLine[]).map(l => ({
    ...l,
    withdrawal: num(l.withdrawal),
    deposit: num(l.deposit),
    balance: num(l.balance),
    bank_line_payment_links: (l.bank_line_payment_links ?? []).map(k => ({ ...k, amount: num(k.amount) })),
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

/** The message after the RPC's error code ("BANK_LINE_OVER_LINKED: the bank line has only 5 left"). */
export function rpcMessage(error: { message?: string } | null | undefined, fallback: string): string {
  const m = /BANK_[A-Z_]+:\s*(.+)$/.exec(error?.message ?? '')
  return m ? m[1] : fallback
}
