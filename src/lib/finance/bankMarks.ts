// ── Is this payment in the bank? ────────────────────────────────────────────
//
// The marker drawn on Payment Requests and in the review window. Pure derivation
// plus loaders. It READS bank statements and links; it never writes, and a marker
// is information for the verifier, not a decision on the payment. The rule that an
// HDFC payment is verified only against the bank is the database's
// (20270516000000); these words only say where a payment stands.
//
// WHO MAY SEE IT: finance.reconcile only. The bank tables are closed to everyone
// else by RLS, so for any other reader these reads would return nothing — the
// page does not call the loader for them at all.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabasePaging'
import { formatMoney, paymentModeLabel } from './piPaymentView'
import { amountsClose, daysBetween, lineFactsForPayment, payerFromNarration, suggestLinesForPayment, type LineSuggestion, type MatchLine, type MatchPayment, type MatchConfidence } from './bankMatching'
import { samePaise, toPaise } from './bankMoney'
import { BANK_ACCOUNT_LABEL, type BankAccountKey } from './bankStatement'

export type BankCandidate = {
  lineId: string
  statementNo: number
  account: BankAccountKey
  lineDate: string
  deposit: number
  remaining: number
  narration: string
  bankRef: string | null
  confidence: MatchConfidence
  amountExact: boolean
  referenceMatch: boolean
  nameFit: number
  daysApart: number
  sameAccount: boolean
  reasons: string[]
  warnings: string[]
}

/** A payment that holds a credit, named for the verifier of another payment. */
export type BankHolder = { paymentId: string; humanId: string | null; clientName: string | null; status: string }

export type BankMark = BankMarkState & {
  /** Credits a person answered Not this one to, so the answer can be seen and undone. */
  dismissed?: { lineId: string; statementNo: number }[]
}

type BankMarkState =
  /**
   * Credits are linked. Only credits in the payment's own account cover it, as in
   * the database's rule: `remaining` is what they leave uncovered, `candidates` what
   * could cover it, and `otherAccount` says a link is in the other HDFC account.
   */
  | { kind: 'linked'; complete: boolean; otherAccount: boolean; remaining: number; links: { lineId: string; lineDate: string; amount: number; narration: string }[]; candidates: BankCandidate[] }
  | { kind: 'suggested'; remaining: number; candidates: BankCandidate[] }
  /** No free credit, but one of the same money already has another payment: this may be a second record of it. */
  | { kind: 'lookalike'; lineId: string; lineDate: string; deposit: number; narration: string; holders: BankHolder[] }
  | { kind: 'none' }
  | { kind: 'uncovered' }

export type MarkPayment = MatchPayment

export type MarkLink = { payment_id: string; line_id: string; amount: number; line_date: string; narration: string; account: BankAccountKey }
export type MarkLine = {
  id: string
  account: BankAccountKey
  line_date: string
  deposit: number
  narration: string
  bank_ref: string | null
  statementNo: number
  linkedAmount: number
}
export type MarkDismissal = { payment_id: string; line_id: string }
export type Coverage = Partial<Record<BankAccountKey, { first: string; last: string }>>

const BANK_MODES = new Set(['hdfc', 'hdfc_sec'])

/** The two accounts a statement is uploaded for. Everything else is cash and verified by hand. */
export function isBankAccountMode(mode: string | null | undefined): boolean {
  return BANK_MODES.has(mode ?? '')
}

/** Only a payment that says it arrived in an HDFC account can be looked for in the bank. */
export function isBankCheckable(p: { payment_mode: string; status: string }): boolean {
  return isBankAccountMode(p.payment_mode) && p.status !== 'rejected'
}

export function deriveBankMarks(
  payments: MarkPayment[], links: MarkLink[], lines: MarkLine[], coverage: Coverage, dismissals: MarkDismissal[] = [],
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
  const candidate = (s: LineSuggestion): BankCandidate => {
    const l = byId.get(s.lineId)!
    return {
      lineId: s.lineId, statementNo: l.raw.statementNo, account: l.account, lineDate: l.line_date, deposit: l.raw.deposit, remaining: l.remaining,
      narration: l.narration, bankRef: l.bank_ref, confidence: s.confidence, amountExact: s.amountExact,
      referenceMatch: s.referenceMatch, nameFit: s.nameFit, daysApart: s.daysApart, sameAccount: s.sameAccount,
      reasons: s.reasons, warnings: s.warnings,
    }
  }

  for (const p of payments) {
    if (!isBankCheckable(p)) continue
    const rejected = new Set(dismissals.filter(d => d.payment_id === p.id).map(d => d.line_id))
    const offerable = matchLines.filter(l => !rejected.has(l.id))
    const mine = linksByPayment.get(p.id) ?? []
    const own = mine.filter(l => l.account === p.payment_mode)
    const otherAccount = own.length < mine.length
    const linkedPaise = own.reduce((a, l) => a + toPaise(l.amount), 0)
    const left = Math.max(toPaise(p.amount) - linkedPaise, 0) / 100
    if (mine.length > 0) {
      marks.set(p.id, {
        kind: 'linked',
        complete: linkedPaise >= toPaise(p.amount),
        otherAccount,
        remaining: left,
        links: mine.map(l => ({ lineId: l.line_id, lineDate: l.line_date, amount: l.amount, narration: l.narration })),
        // A link in the other account holds the payment's room, so that comes first.
        candidates: left > 0 && !otherAccount ? suggestLinesForPayment({ ...p, remaining: left }, offerable).map(candidate) : [],
      })
      continue
    }
    const found = suggestLinesForPayment({ ...p, remaining: left }, offerable)
    if (found.length > 0) {
      marks.set(p.id, { kind: 'suggested', remaining: left, candidates: found.map(candidate) })
      continue
    }
    const twin = matchLines
      .filter(l => l.remaining <= 0 && amountsClose(l.raw.deposit, p.amount) && Math.abs(daysBetween(l.line_date, p.payment_date)) <= 21)
      .sort((a, b) => Math.abs(daysBetween(a.line_date, p.payment_date)) - Math.abs(daysBetween(b.line_date, p.payment_date)))[0]
    if (twin) {
      // The loader names the holders; this works out only that there is a twin.
      marks.set(p.id, { kind: 'lookalike', lineId: twin.id, lineDate: twin.line_date, deposit: twin.raw.deposit, narration: twin.narration, holders: [] })
      continue
    }
    const cov = coverage[p.payment_mode as BankAccountKey]
    marks.set(p.id, !cov || p.payment_date < cov.first || p.payment_date > cov.last ? { kind: 'uncovered' } : { kind: 'none' })
  }
  for (const d of dismissals) {
    const mark = marks.get(d.payment_id)
    const line = byId.get(d.line_id)
    if (mark && line) marks.set(d.payment_id, { ...mark, dismissed: [...(mark.dismissed ?? []), { lineId: line.id, statementNo: line.raw.statementNo }] })
  }
  return marks
}

// ── What a person is told ───────────────────────────────────────────────────

const clientWords = (name: string | null) => (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * What to do about a credit another payment holds. The names only choose the words:
 * "May be a duplicate" compares amount and date, and only a person can say it is
 * the same money.
 */
export function creditHolderAdvice(holders: BankHolder[], clientName: string | null): string {
  if (holders.length === 0) return 'Open the credit to see which payment holds it.'
  if (holders.some(h => clientWords(h.clientName) === '')) {
    return 'A payment with no client usually came from the old bank sync. If this is the same money: open the credit, unlink that payment, delete it in Confirmed Payments, then verify this one here.'
  }
  if (holders.some(h => clientWords(h.clientName) === clientWords(clientName))) {
    return 'Same client, so this is probably a second record of the same money. Compare the two and keep only one.'
  }
  return 'This is in another name. If it is a different client, it is not a duplicate, and this payment is waiting for its own credit: upload the latest statement and look again.'
}

/** Everything agrees: this credit, this amount, this account, this name, this UTR, within 3 days. */
export function isExactCandidate(c: BankCandidate): boolean {
  return c.amountExact && c.referenceMatch && c.sameAccount && c.nameFit >= 0.99 && c.daysApart <= 3
}

/** What should stop a person before using this credit. The bank's own reference outweighs a name or a date. */
export function candidateDoubts(c: BankCandidate, clientName: string | null): string[] {
  const doubts: string[] = []
  if (!c.sameAccount) doubts.push('this credit is in the other HDFC account')
  if (c.referenceMatch) return doubts
  if (c.nameFit < 0.5) doubts.push(clientName ? 'the name does not match' : 'the payment has no client name')
  if (c.daysApart > 3) doubts.push(`the dates are ${c.daysApart} days apart`)
  return doubts
}

export type BankMarkTone = 'ok' | 'match' | 'warn' | 'quiet'

/** The credits still to choose from, best first. */
export function markCandidates(mark: BankMark | undefined): BankCandidate[] {
  return mark?.kind === 'suggested' || mark?.kind === 'linked' ? mark.candidates : []
}

/** One phrase for the list: how this payment stands against the bank. */
export function bankMarkSummary(mark: BankMark): { text: string; tone: BankMarkTone } {
  switch (mark.kind) {
    case 'linked':
      if (mark.complete) return { text: 'In the bank', tone: 'ok' }
      if (mark.otherAccount) return { text: 'Linked in the other account', tone: 'warn' }
      return { text: `${formatMoney(mark.remaining)} still needs a credit`, tone: 'match' }
    case 'suggested': {
      const best = mark.candidates[0]
      const fits = mark.candidates.filter(c => c.amountExact).length
      if (fits > 1) return { text: `${fits} credits fit`, tone: 'warn' }
      if (isExactCandidate(best)) return { text: 'Exact match', tone: 'ok' }
      if (best.amountExact) return { text: 'Match found, check it', tone: 'match' }
      const gap = toPaise(mark.remaining) - toPaise(best.remaining)
      return gap > 0 && amountsClose(mark.remaining, best.remaining)
        ? { text: `${formatMoney(gap / 100)} less in the bank`, tone: 'warn' }
        : { text: 'Part of a bigger amount', tone: 'match' }
    }
    case 'lookalike':
      return { text: 'May be a duplicate', tone: 'warn' }
    case 'none':
      return { text: 'Not found in the bank', tone: 'warn' }
    case 'uncovered':
      return { text: 'Statement not uploaded', tone: 'quiet' }
  }
}

/** The views of Pending. A payment is in exactly one. */
export type PendingBankView = 'match_found' | 'waiting_for_bank' | 'cash'

export function pendingBankView(mode: string, mark: BankMark | undefined): PendingBankView {
  if (!isBankAccountMode(mode)) return 'cash'
  if (mark?.kind === 'linked' || mark?.kind === 'suggested') return 'match_found'
  return 'waiting_for_bank'
}

const shortDate = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export type CompareRow = { label: string; request: string; bank: string; verdict: string; tone: 'same' | 'differs' | 'plain' }

/** The request and the credit side by side. */
export function compareCandidate(
  p: { client_name: string | null; payment_date: string; payment_mode: string; proof_note: string | null },
  c: BankCandidate,
  remaining: number,
): CompareRow[] {
  const covers = toPaise(c.remaining) >= toPaise(remaining)
  return [
    {
      label: 'Amount',
      request: formatMoney(remaining),
      bank: formatMoney(c.remaining),
      verdict: samePaise(remaining, c.remaining) ? 'Same' : covers ? 'Bigger than this payment' : `${formatMoney((toPaise(remaining) - toPaise(c.remaining)) / 100)} short`,
      tone: samePaise(remaining, c.remaining) ? 'same' : 'differs',
    },
    {
      label: 'Date',
      request: shortDate(p.payment_date),
      bank: shortDate(c.lineDate),
      verdict: c.daysApart === 0 ? 'Same day' : `${c.daysApart} day${c.daysApart === 1 ? '' : 's'} apart`,
      tone: c.daysApart <= 3 ? 'same' : 'differs',
    },
    {
      label: 'Account',
      request: paymentModeLabel(p.payment_mode),
      bank: BANK_ACCOUNT_LABEL[c.account],
      verdict: c.sameAccount ? 'Same' : 'Different',
      tone: c.sameAccount ? 'same' : 'differs',
    },
    {
      label: 'Name',
      request: p.client_name ?? 'Not identified',
      bank: payerFromNarration(c.narration) ?? '—',
      verdict: !p.client_name ? '' : c.nameFit >= 0.99 ? 'Same' : c.nameFit >= 0.5 ? 'Partly the same' : 'No match',
      tone: c.nameFit >= 0.5 ? 'same' : 'plain',
    },
    {
      label: 'UTR',
      request: p.proof_note ?? 'None recorded',
      bank: c.bankRef ?? '—',
      verdict: c.referenceMatch ? 'Same' : '',
      tone: c.referenceMatch ? 'same' : 'plain',
    },
  ]
}

/** How far the uploaded statements run, for the top of a list. Null before the first upload. */
export function statementsRunTo(coverage: Coverage | null | undefined): string | null {
  const parts = (['hdfc', 'hdfc_sec'] as const)
    .filter(a => coverage?.[a])
    .map(a => `${BANK_ACCOUNT_LABEL[a]} to ${shortDate(coverage![a]!.last)}`)
  return parts.length > 0 ? `Bank statements run: ${parts.join(' · ')}` : null
}

/** A refusal from the verification doors, in a sentence. Null for anything else. */
export function bankVerifyRefusal(message: string | null | undefined): string | null {
  const m = message ?? ''
  if (m.includes('PAYMENT_EDIT_NEEDS_BANK_MATCH')) return 'This change would leave the payment without a bank credit covering it. Link the credit first.'
  if (m.includes('PAYMENT_NEEDS_BANK_MATCH')) return 'This HDFC payment has no bank credit covering it yet. Match it to its credit in Payment Requests first.'
  if (m.includes('BANK_PAYMENT_OVER_LINKED')) return 'This payment is already fully linked to bank credits. Unlink one on Bank Statements first.'
  if (m.includes('BANK_LINE_OVER_LINKED')) return 'That bank credit is already used by another payment. If this is the same money, this payment is a duplicate.'
  if (m.includes('BANK_ACCOUNT_DIFFERS')) return 'That credit is in the other HDFC account. Correct the payment first.'
  if (m.includes('BANK_LINE_CLASSIFIED')) return 'That credit is marked as an old order or not customer money. Remove the mark first.'
  if (m.includes('BANK_CHECK_PENDING_ADMIN_ONLY')) return 'Only an admin may verify a payment before its bank credit is seen.'
  if (m.includes('BANK_REASON_REQUIRED')) return 'Say why this cannot wait.'
  if (m.includes('BANK_FORBIDDEN')) return 'Verifying an HDFC payment needs access to Bank Statements.'
  return null
}

// ── Loaders ─────────────────────────────────────────────────────────────────

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

type LinkRow = {
  payment_id: string; line_id: string; amount: number | string
  bank_statement_lines: { line_date: string; narration: string; account: BankAccountKey } | null
}
type LineRow = {
  id: string; account: BankAccountKey; line_date: string; deposit: number | string; narration: string; bank_ref: string | null; statement_no: number | string
  bank_line_payment_links: { amount: number | string; unlinked_at: string | null; payment_id: string | null }[] | null
}

/**
 * Who holds each credit a payment looks like a second record of. This is help beside
 * a warning, so a failed read leaves the warning standing, without the names.
 */
async function nameCreditHolders(supabase: SupabaseClient, marks: Map<string, BankMark>, rows: LineRow[]) {
  const held = new Map(rows.map(r => [r.id, (r.bank_line_payment_links ?? []).flatMap(k => (k.unlinked_at === null && k.payment_id ? [k.payment_id] : []))]))
  const twins = [...marks].flatMap(([id, mark]) => (mark.kind === 'lookalike' ? [{ id, mark }] : []))
  const ids = [...new Set(twins.flatMap(t => held.get(t.mark.lineId) ?? []))]
  if (ids.length === 0) return
  const { data, error } = await supabase.from('finance_payment_requests')
    .select('id, human_payment_id, client_name, status').in('id', ids)
  if (error) return
  type Row = { id: string; human_payment_id: string | null; client_name: string | null; status: string }
  const byId = new Map(((data ?? []) as Row[]).map(r => [r.id, r]))
  for (const { id, mark } of twins) {
    const holders = (held.get(mark.lineId) ?? []).flatMap(p => {
      const r = byId.get(p)
      return r ? [{ paymentId: r.id, humanId: r.human_payment_id, clientName: r.client_name, status: r.status }] : []
    })
    marks.set(id, { ...mark, holders })
  }
}

/** The marks, and how far each account's statements run. */
export async function loadBankState(supabase: SupabaseClient, payments: MarkPayment[]): Promise<{ marks: Map<string, BankMark>; coverage: Coverage }> {
  const eligible = payments.filter(isBankCheckable)
  if (eligible.length === 0) return { marks: new Map(), coverage: {} }

  const ids = eligible.map(p => p.id)
  const dates = eligible.map(p => p.payment_date).sort()
  const from = addDays(dates[0], -21)
  const to = addDays(dates[dates.length - 1], 21)

  const [linkRes, lineRes, dismissRes, ...cov] = await Promise.all([
    supabase.from('bank_line_payment_links')
      .select('payment_id, line_id, amount, bank_statement_lines(line_date, narration, account)')
      .in('payment_id', ids).is('unlinked_at', null),
    // EVERY credit in the window, in a fixed order: one old pending payment can make
    // it months wide, and a credit cut off here would read as Not found in the bank.
    fetchAllRows<LineRow>((a, b) => supabase.from('bank_statement_lines')
      .select('id, account, line_date, deposit, narration, bank_ref, statement_no, bank_line_payment_links(amount, unlinked_at, payment_id)')
      .gt('deposit', 0).is('classification', null).gte('line_date', from).lte('line_date', to)
      .order('line_date', { ascending: true }).order('id', { ascending: true })
      .range(a, b) as unknown as PromiseLike<{ data: LineRow[] | null; error: { message: string } | null }>),
    supabase.from('bank_match_dismissals').select('payment_id, line_id').in('payment_id', ids).is('undone_at', null),
    ...(['hdfc', 'hdfc_sec'] as const).flatMap(a => [
      supabase.from('bank_statement_lines').select('line_date').eq('account', a).order('line_date', { ascending: true }).limit(1),
      supabase.from('bank_statement_lines').select('line_date').eq('account', a).order('line_date', { ascending: false }).limit(1),
    ]),
  ])
  if (linkRes.error || !lineRes.ok || dismissRes.error) throw new Error('Bank matches could not be read.')

  const coverage: Coverage = {}
  ;(['hdfc', 'hdfc_sec'] as const).forEach((a, i) => {
    const first = (cov[i * 2].data as { line_date: string }[] | null)?.[0]?.line_date
    const last = (cov[i * 2 + 1].data as { line_date: string }[] | null)?.[0]?.line_date
    if (first && last) coverage[a] = { first, last }
  })

  const links: MarkLink[] = ((linkRes.data ?? []) as unknown as LinkRow[]).map(r => ({
    payment_id: r.payment_id, line_id: r.line_id, amount: Number(r.amount),
    line_date: r.bank_statement_lines?.line_date ?? '', narration: r.bank_statement_lines?.narration ?? '',
    account: r.bank_statement_lines?.account as BankAccountKey,
  }))
  const lines: MarkLine[] = lineRes.rows.map(r => ({
    id: r.id, account: r.account, line_date: r.line_date, deposit: Number(r.deposit), narration: r.narration, bank_ref: r.bank_ref, statementNo: Number(r.statement_no),
    linkedAmount: (r.bank_line_payment_links ?? []).filter(k => k.unlinked_at === null).reduce((a, k) => a + toPaise(Number(k.amount)), 0) / 100,
  }))
  const marks = deriveBankMarks(eligible, links, lines, coverage, (dismissRes.data ?? []) as MarkDismissal[])
  await nameCreditHolders(supabase, marks, lineRes.rows)
  return { marks, coverage }
}

export async function loadBankMarks(supabase: SupabaseClient, payments: MarkPayment[]): Promise<Map<string, BankMark>> {
  return (await loadBankState(supabase, payments)).marks
}

// ── Searching by hand ───────────────────────────────────────────────────────

export type SearchCredit = {
  lineId: string
  statementNo: number
  account: BankAccountKey
  lineDate: string
  deposit: number
  remaining: number
  narration: string
  bankRef: string | null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A date as people type it, or null. 31 Oct 2026, 31/10/2026 and 2026-10-31. */
export function parseSearchDate(text: string): string | null {
  const t = text.trim().toLowerCase()
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)?.slice(1).map(Number)
    ?? /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t)?.slice(1).map(Number).reverse()
  const worded = /^(\d{1,2}) ([a-z]{3})[a-z]* (\d{4})$/.exec(t)
  const [y, m, d] = parts ?? (worded ? [Number(worded[3]), MONTHS.indexOf(worded[2]) + 1, Number(worded[1])] : [0, 0, 0])
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : null
}

/** Credits with money left that fit what was typed. The newest 50. */
export async function searchBankCredits(supabase: SupabaseClient, text: string): Promise<SearchCredit[]> {
  type Row = { line_id: string; statement_no: number | string; account: BankAccountKey; line_date: string; deposit: number | string; remaining: number | string; narration: string; bank_ref: string | null }
  const { data, error } = await supabase.rpc('search_bank_unmatched', { p_query: text, p_date: parseSearchDate(text) })
  if (error) throw new Error('The bank statement could not be searched.')
  return ((data ?? []) as Row[]).map(r => ({
    lineId: r.line_id, statementNo: Number(r.statement_no), account: r.account, lineDate: r.line_date,
    deposit: Number(r.deposit), remaining: Number(r.remaining), narration: r.narration, bankRef: r.bank_ref,
  }))
}

/** A credit a person picked, in the shape the comparison reads. */
export function searchCandidate(
  p: { client_name: string | null; payment_date: string; payment_mode: string; proof_note: string | null },
  need: number,
  c: SearchCredit,
): BankCandidate {
  const facts = lineFactsForPayment({ ...p, remaining: need }, {
    id: c.lineId, account: c.account, line_date: c.lineDate, narration: c.narration, bank_ref: c.bankRef, remaining: c.remaining,
  })
  return { ...c, ...facts, confidence: 'possible', reasons: [], warnings: [] }
}

/**
 * Every pending payment, for the views of Pending. A view applied to the fifty rows
 * of one page would hide every match on the next, so the views are worked out over
 * all of them and the list is then asked for those ids.
 */
export async function loadPendingBankPayments(supabase: SupabaseClient): Promise<MarkPayment[]> {
  type Row = Omit<MarkPayment, 'remaining'>
  const result = await fetchAllRows<Row>((from, to) => supabase
    .from('finance_payment_requests')
    .select('id, human_payment_id, client_name, amount, payment_date, payment_mode, proof_note, status')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>)
  if (!result.ok) throw new Error('Pending payments could not be read.')
  return result.rows.map(r => ({ ...r, amount: Number(r.amount), remaining: Number(r.amount) }))
}

export type BankCheckRow = {
  payment_id: string
  human_payment_id: string | null
  client_name: string | null
  amount: number
  covered: number
  payment_date: string
  payment_mode: string
  proof_note: string | null
  status: string
  reason: string
  created_at: string
  created_by_name: string | null
}

/** Payments verified before their bank credit could be seen, still short of it. */
export async function loadBankCheckPending(supabase: SupabaseClient): Promise<BankCheckRow[]> {
  const { data, error } = await supabase.rpc('finance_bank_check_pending')
  if (error) throw new Error('The bank check list could not be read.')
  return ((data ?? []) as BankCheckRow[]).map(r => ({ ...r, amount: Number(r.amount), covered: Number(r.covered) }))
}

/** After this many days with no credit, a bank check pending stands out. */
export const BANK_CHECK_LATE_DAYS = 7

/** Where a payment verified ahead of the bank stands. */
export function bankCheckState(row: { payment_date: string }, mark: BankMark | undefined, today: string): { text: string; tone: BankMarkTone | 'stop' } {
  if (markCandidates(mark).length > 0) return { text: 'Match found', tone: 'ok' }
  if (mark?.kind === 'lookalike') return { text: 'Its credit is on another payment', tone: 'warn' }
  const age = daysBetween(today, row.payment_date)
  const late = age > BANK_CHECK_LATE_DAYS
  if (mark?.kind === 'none') return late ? { text: `No bank credit after ${age} days`, tone: 'stop' } : { text: 'No bank credit yet', tone: 'quiet' }
  return late ? { text: `Waiting for next upload · ${age} days`, tone: 'warn' } : { text: 'Waiting for next upload', tone: 'quiet' }
}
