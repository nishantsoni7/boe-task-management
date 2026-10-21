// ── Is this payment in the bank? ────────────────────────────────────────────
//
// The marker drawn on Payment Requests and in the review window. Pure derivation
// plus one loader. It READS bank statements and links; it never writes, and a
// marker is information for the verifier, not a decision on the payment.
//
// WHO MAY SEE IT: finance.reconcile only. The bank tables are closed to everyone
// else by RLS, so for any other reader these reads would return nothing — the
// page does not call the loader for them at all.

import type { SupabaseClient } from '@supabase/supabase-js'
import { suggestLinesForPayment, type MatchLine, type MatchPayment, type MatchConfidence } from './bankMatching'
import { toPaise } from './bankMoney'
import type { BankAccountKey } from './bankStatement'

export type BankCandidate = {
  lineId: string
  account: BankAccountKey
  lineDate: string
  deposit: number
  remaining: number
  narration: string
  confidence: MatchConfidence
  amountExact: boolean
  reasons: string[]
  warnings: string[]
}

export type BankMark =
  | { kind: 'linked'; complete: boolean; links: { lineId: string; lineDate: string; amount: number; narration: string }[] }
  | { kind: 'suggested'; candidates: BankCandidate[] }
  | { kind: 'none' }
  | { kind: 'uncovered' }

export type MarkPayment = MatchPayment

export type MarkLink = { payment_id: string; line_id: string; amount: number; line_date: string; narration: string }
export type MarkLine = {
  id: string
  account: BankAccountKey
  line_date: string
  deposit: number
  narration: string
  bank_ref: string | null
  linkedAmount: number
}
export type Coverage = Partial<Record<BankAccountKey, { first: string; last: string }>>

const BANK_MODES = new Set(['hdfc', 'hdfc_sec'])

/** Only a payment that says it arrived in an HDFC account can be looked for in the bank. */
export function isBankCheckable(p: { payment_mode: string; status: string }): boolean {
  return BANK_MODES.has(p.payment_mode) && p.status !== 'rejected'
}

export function deriveBankMarks(
  payments: MarkPayment[], links: MarkLink[], lines: MarkLine[], coverage: Coverage,
): Map<string, BankMark> {
  const marks = new Map<string, BankMark>()
  const linksByPayment = new Map<string, MarkLink[]>()
  for (const l of links) {
    const a = linksByPayment.get(l.payment_id) ?? []
    a.push(l)
    linksByPayment.set(l.payment_id, a)
  }
  const matchLines: (MatchLine & { raw: MarkLine })[] = lines.map(l => ({
    id: l.id, account: l.account, line_date: l.line_date, narration: l.narration, bank_ref: l.bank_ref,
    remaining: (toPaise(l.deposit) - toPaise(l.linkedAmount)) / 100, raw: l,
  }))
  const byId = new Map(matchLines.map(l => [l.id, l]))

  for (const p of payments) {
    if (!isBankCheckable(p)) continue
    const mine = linksByPayment.get(p.id) ?? []
    const linkedPaise = mine.reduce((a, l) => a + toPaise(l.amount), 0)
    if (mine.length > 0) {
      marks.set(p.id, {
        kind: 'linked',
        complete: linkedPaise >= toPaise(p.amount),
        links: mine.map(l => ({ lineId: l.line_id, lineDate: l.line_date, amount: l.amount, narration: l.narration })),
      })
      continue
    }
    const found = suggestLinesForPayment(p, matchLines)
    if (found.length > 0) {
      marks.set(p.id, {
        kind: 'suggested',
        candidates: found.map(s => {
          const l = byId.get(s.lineId)!
          return {
            lineId: s.lineId, account: l.account, lineDate: l.line_date, deposit: l.raw.deposit, remaining: l.remaining,
            narration: l.narration, confidence: s.confidence, amountExact: s.amountExact, reasons: s.reasons, warnings: s.warnings,
          }
        }),
      })
      continue
    }
    const cov = coverage[p.payment_mode as BankAccountKey]
    marks.set(p.id, !cov || p.payment_date < cov.first || p.payment_date > cov.last ? { kind: 'uncovered' } : { kind: 'none' })
  }
  return marks
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

type LinkRow = {
  payment_id: string; line_id: string; amount: number | string
  bank_statement_lines: { line_date: string; narration: string } | null
}
type LineRow = {
  id: string; account: BankAccountKey; line_date: string; deposit: number | string; narration: string; bank_ref: string | null
  bank_line_payment_links: { amount: number | string; unlinked_at: string | null }[] | null
}

export async function loadBankMarks(supabase: SupabaseClient, payments: MarkPayment[]): Promise<Map<string, BankMark>> {
  const eligible = payments.filter(isBankCheckable)
  if (eligible.length === 0) return new Map()

  const ids = eligible.map(p => p.id)
  const dates = eligible.map(p => p.payment_date).sort()
  const from = addDays(dates[0], -21)
  const to = addDays(dates[dates.length - 1], 21)

  const [linkRes, lineRes, ...cov] = await Promise.all([
    supabase.from('bank_line_payment_links')
      .select('payment_id, line_id, amount, bank_statement_lines(line_date, narration)')
      .in('payment_id', ids).is('unlinked_at', null),
    supabase.from('bank_statement_lines')
      .select('id, account, line_date, deposit, narration, bank_ref, bank_line_payment_links(amount, unlinked_at)')
      .gt('deposit', 0).gte('line_date', from).lte('line_date', to).range(0, 1999),
    ...(['hdfc', 'hdfc_sec'] as const).flatMap(a => [
      supabase.from('bank_statement_lines').select('line_date').eq('account', a).order('line_date', { ascending: true }).limit(1),
      supabase.from('bank_statement_lines').select('line_date').eq('account', a).order('line_date', { ascending: false }).limit(1),
    ]),
  ])
  if (linkRes.error || lineRes.error) throw new Error('Bank matches could not be read.')

  const coverage: Coverage = {}
  ;(['hdfc', 'hdfc_sec'] as const).forEach((a, i) => {
    const first = (cov[i * 2].data as { line_date: string }[] | null)?.[0]?.line_date
    const last = (cov[i * 2 + 1].data as { line_date: string }[] | null)?.[0]?.line_date
    if (first && last) coverage[a] = { first, last }
  })

  const links: MarkLink[] = ((linkRes.data ?? []) as unknown as LinkRow[]).map(r => ({
    payment_id: r.payment_id, line_id: r.line_id, amount: Number(r.amount),
    line_date: r.bank_statement_lines?.line_date ?? '', narration: r.bank_statement_lines?.narration ?? '',
  }))
  const lines: MarkLine[] = ((lineRes.data ?? []) as unknown as LineRow[]).map(r => ({
    id: r.id, account: r.account, line_date: r.line_date, deposit: Number(r.deposit), narration: r.narration, bank_ref: r.bank_ref,
    linkedAmount: (r.bank_line_payment_links ?? []).filter(k => k.unlinked_at === null).reduce((a, k) => a + toPaise(Number(k.amount)), 0) / 100,
  }))
  return deriveBankMarks(eligible, links, lines, coverage)
}
