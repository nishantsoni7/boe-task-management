// ── /finance/founders: the database calls and the Excel file ─────────────────
//
// Every read and write is one SECURITY DEFINER function of 20270501000000; the
// tables themselves are not reachable from the browser. Each function asks the
// door (an explicit finance.founder_payouts grant) before anything else.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseFounderBook, type DraftLine, type FounderBook, type FounderYear, kindShort, kindLabel, paidFromLabel, roleLabel, taxYearLabel, FOUNDER_PAYOUT_KINDS } from '@/lib/finance/founderPayouts'
import { roomLeft, rulesFor, taxFreeLimit } from '@/lib/finance/founderPayoutTax'
import type { Sheet, SheetCell } from '@/lib/finance/expenseReimbursementExport'

/** The database's FOUNDERS_* refusals, in the words the page shows. */
export function founderErrorMessage(error: unknown): string {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? '')
  if (/FOUNDERS_(FORBIDDEN|UNAUTHENTICATED)/.test(raw)) return 'You do not have access to Founders’ payouts.'
  const m = raw.match(/FOUNDERS_[A-Z_]+:\s*(.+)$/)
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1)
  if (/founder_payouts_read|does not exist|schema cache/i.test(raw)) {
    return 'Founders’ payouts is not set up in the database yet (migration 20270501000000).'
  }
  return raw || 'Something went wrong. Try again.'
}

export async function loadFounderBook(supabase: SupabaseClient): Promise<FounderBook> {
  const { data, error } = await supabase.rpc('founder_payouts_read')
  if (error) throw new Error(founderErrorMessage(error))
  return parseFounderBook(data)
}

const rupees = (paise: number) => Math.round(paise) / 100

export async function saveFounderPayout(
  supabase: SupabaseClient,
  payout: { id: string | null; paidOn: string; paidFrom: string; note: string; bankReference: string; lines: readonly DraftLine[]; idempotencyKey: string | null },
): Promise<string> {
  const { data, error } = await supabase.rpc('founder_payout_save', {
    p_payout_id: payout.id,
    p_paid_on: payout.paidOn,
    p_paid_from: payout.paidFrom,
    p_note: payout.note,
    p_bank_reference: payout.bankReference,
    p_lines: payout.lines.map(l => ({ account_id: l.accountId, kind: l.kind, amount: rupees(l.paise) })),
    p_idempotency_key: payout.id ? null : payout.idempotencyKey,
  })
  if (error) throw new Error(founderErrorMessage(error))
  return String(data)
}

export async function deleteFounderPayout(supabase: SupabaseClient, id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('founder_payout_delete', { p_payout_id: id, p_reason: reason || null })
  if (error) throw new Error(founderErrorMessage(error))
}

export async function saveFounderAccount(
  supabase: SupabaseClient,
  account: { id: string | null; displayName: string; side: string; taxRole: string; bankLabel: string; isActive: boolean },
): Promise<string> {
  const { data, error } = await supabase.rpc('founder_payout_account_save', {
    p_account_id: account.id,
    p_display_name: account.displayName,
    p_side: account.side,
    p_tax_role: account.taxRole,
    p_bank_label: account.bankLabel || null,
    p_is_active: account.isActive,
  })
  if (error) throw new Error(founderErrorMessage(error))
  return String(data)
}

export async function saveOtherIncome(supabase: SupabaseClient, taxYear: number, accountId: string, paise: number): Promise<void> {
  const { error } = await supabase.rpc('founder_payout_account_year_save', { p_tax_year: taxYear, p_account_id: accountId, p_other_income: rupees(paise) })
  if (error) throw new Error(founderErrorMessage(error))
}

export async function saveBookProfit(supabase: SupabaseClient, taxYear: number, paise: number | null): Promise<void> {
  const { error } = await supabase.rpc('founder_payout_firm_year_save', { p_tax_year: taxYear, p_expected_book_profit: paise === null ? null : rupees(paise) })
  if (error) throw new Error(founderErrorMessage(error))
}

// ── Excel for the CA ─────────────────────────────────────────────────────────

export const PAYMENTS_SHEET_HEADER: SheetCell[] = ['Date', 'Account', 'Side', 'Role in BOE', 'Kind', 'Amount (₹)', 'Paid from', 'Bank reference', 'Note']

/**
 * Two sheets: every line of the year as shown (the filters applied), and one
 * row per account for the whole year with each kind's total and the tax-free
 * room. The second sheet ignores the filters on purpose: the CA needs the year.
 */
export function founderWorkbook(year: FounderYear, shownLines: FounderYear['lines']): Sheet[] {
  const label = taxYearLabel(year.taxYear)
  const payments: SheetCell[][] = [PAYMENTS_SHEET_HEADER]
  for (const l of shownLines) {
    payments.push([
      l.payout.paidOn,
      l.account?.displayName ?? '—',
      l.account?.side ?? '—',
      l.account ? roleLabel(l.account.taxRole) : '—',
      kindLabel(l.kind),
      rupees(l.paise),
      paidFromLabel(l.payout.paidFrom),
      l.payout.bankReference ?? '',
      l.payout.note ?? '',
    ])
  }

  const rules = rulesFor(year.taxYear)?.rules ?? null
  const perAccount: SheetCell[][] = [[
    'Account', 'Side', 'Role in BOE',
    ...FOUNDER_PAYOUT_KINDS.map(k => `${kindShort(k.value)} (₹)`),
    'Total (₹)', 'Counts as their income (₹)', 'Other income (₹)', 'Tax-free limit (₹)', 'Room left (₹)',
  ]]
  for (const a of year.accounts) {
    if (a.totalPaise === 0 && a.otherIncomePaise === 0) continue
    const limit = rules ? taxFreeLimit(a.account.taxRole, rules) : null
    const room = rules ? roomLeft(a.account.taxRole, a.incomePaise / 100, a.otherIncomePaise / 100, rules) : null
    perAccount.push([
      a.account.displayName,
      a.account.side,
      roleLabel(a.account.taxRole),
      ...FOUNDER_PAYOUT_KINDS.map(k => rupees(a.byKind.get(k.value) ?? 0)),
      rupees(a.totalPaise),
      rupees(a.incomePaise),
      rupees(a.otherIncomePaise),
      limit,
      room,
    ])
  }
  return [
    { name: `Payments ${label}`, rows: payments },
    { name: `Per account ${label}`, rows: perAccount },
  ]
}

export function founderExportFileName(taxYear: number, todayIso: string): string {
  return `founders-payouts-${taxYearLabel(taxYear)}-${todayIso}.xlsx`
}
