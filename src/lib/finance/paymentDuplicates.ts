// ── A pending payment request that may already be a payment in Confirmed Payments ──
//
// The owner often records a payment (or it comes from the bank) and Sales then send a
// request for the same money. This module finds the earlier payment, lays the two side by
// side field by field, and says whether MERGE is offered. It decides nothing: the database
// door merge_payment_request (20270608000000) judges every rule again under row locks, and
// the rules here only decide what is DRAWN.
//
// WHERE AN EARLIER PAYMENT IS FOUND
//   1. By its details: a verified payment in the same account, the exact same amount, a
//      date within 21 days. This works before any statement is uploaded.
//   2. By the bank credit: a payment that already holds the credit this request looks like.
//      It may be in another name or amount, so it is shown, and a merge is offered only if
//      it also passes the rules below.
//
// MERGE IS OFFERED ONLY WHEN (mirrors the database, which has the final say)
//   the earlier payment is verified, in the SAME account, has the EXACT same amount, and is
//   not already allocated somewhere other than where the request asked.

import type { SupabaseClient } from '@supabase/supabase-js'
import { toPaise } from './bankMoney'
import { bankLineId } from './bankStatement'
import { formatMoney, paymentModeLabel } from './piPaymentView'
import {
  DESTINATION_KIND_LABEL, destinationReferenceLabel, loadPaymentDestinations, type PaymentDestination,
} from './paymentDestination'
import { isConfirmedPaymentStatus } from './paymentSurfaces'

/** A date this far from the request's is still looked at: recorded dates drift. */
export const DUPLICATE_WINDOW_DAYS = 21
/** How many look-alikes one window will list. */
const MAX_CANDIDATES = 5

export type DuplicateCredit = { lineId: string; statementNo: number | null; lineDate: string }

/** One payment, as the comparison reads it. */
export type DuplicateSide = {
  id: string
  humanId: string | null
  status: string
  amount: number
  paymentDate: string
  paymentMode: string
  clientName: string | null
  /** The UTR / reference typed on the payment. */
  reference: string | null
  addedByName: string | null
  addedAt: string
  credits: DuplicateCredit[]
  destination: PaymentDestination | null
  proofFiles: number
}

export type DuplicateRequestInput = {
  id: string
  humanId: string | null
  status: string
  amount: number
  paymentDate: string
  paymentMode: string
  clientName: string | null
  reference: string | null
  addedByName: string | null
  addedAt: string
}

export type VerdictTone = 'same' | 'differs' | 'adds' | 'plain'
export type Cell = { text: string; sub?: string; muted?: boolean }
export type CompareRow = { key: string; label: string; request: Cell; existing: Cell; tone: VerdictTone; verdict: string }

// ── Small readers ───────────────────────────────────────────────────────────

const dayGap = (a: string, b: string) =>
  Math.round(Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000)

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

const fmtDate = (iso: string) =>
  new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

const words = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const squash = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '')
const idOf = (s: DuplicateSide | DuplicateRequestInput) => s.humanId ?? 'this payment'

export function isVerifiedPayment(status: string): boolean {
  return isConfirmedPaymentStatus(status)
}

/** What a payment is for, in one phrase; null when it is for nothing yet (Suspense). */
export function destinationText(d: PaymentDestination | null | undefined): string | null {
  if (!d || d.kind === 'suspense') return null
  const ref = destinationReferenceLabel(d)
  return ref ? `${DESTINATION_KIND_LABEL[d.kind]} ${ref}` : DESTINATION_KIND_LABEL[d.kind]
}

/** The same place: same PI, same Order, same old order number. A mixed destination is never "the same". */
export function sameDestination(a: PaymentDestination | null | undefined, b: PaymentDestination | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'pi_draft') return !!a.submissionId && a.submissionId === b.submissionId
  if (a.kind === 'confirmed_order') return !!a.orderId && a.orderId === b.orderId
  if (a.kind === 'old_order') return squash(a.reference) !== '' && squash(a.reference) === squash(b.reference)
  return false
}

const person = (name: string | null, at: string): Cell => ({ text: name ?? 'Not known', sub: fmtDate(at), muted: !name })
const creditsCell = (c: DuplicateCredit[], none: string): Cell =>
  c.length === 0
    ? { text: none, muted: true }
    : { text: c.map(x => (x.statementNo === null ? 'A credit' : bankLineId(x.statementNo))).join(', '), sub: c.map(x => fmtDate(x.lineDate)).join(', ') }

// ── The comparison ──────────────────────────────────────────────────────────

/**
 * What Sales entered beside what is already confirmed, one row per fact. `requestCredit` is the
 * credit this request looks like when the request itself is not linked to one: it is how the
 * "same credit" line is answered for a request that has no link yet.
 */
export function compareSides(request: DuplicateSide, existing: DuplicateSide, requestCredit?: DuplicateCredit | null): CompareRow[] {
  const rows: CompareRow[] = []
  const row = (key: string, label: string, req: Cell, old: Cell, tone: VerdictTone, verdict: string) =>
    rows.push({ key, label, request: req, existing: old, tone, verdict })

  const same = !!request.addedByName && request.addedByName === existing.addedByName
  row('added', 'Added by', person(request.addedByName, request.addedAt), person(existing.addedByName, existing.addedAt), 'plain', same ? 'Same person' : 'Different people')

  const diff = Math.abs(toPaise(request.amount) - toPaise(existing.amount)) / 100
  row('amount', 'Amount', { text: formatMoney(request.amount) }, { text: formatMoney(existing.amount) },
    diff === 0 ? 'same' : 'differs', diff === 0 ? 'Same' : `Differs by ${formatMoney(diff)}`)

  const gap = dayGap(request.paymentDate, existing.paymentDate)
  row('date', 'Payment date', { text: fmtDate(request.paymentDate) }, { text: fmtDate(existing.paymentDate) },
    gap === 0 ? 'same' : 'differs', gap === 0 ? 'Same' : `${gap} day${gap === 1 ? '' : 's'} apart`)

  const sameAccount = request.paymentMode === existing.paymentMode
  row('account', 'Account', { text: paymentModeLabel(request.paymentMode) }, { text: paymentModeLabel(existing.paymentMode) },
    sameAccount ? 'same' : 'differs', sameAccount ? 'Same' : 'Different account')

  // The credit: the request's own links, or the credit it looks like when it has none.
  const reqCredits = request.credits.length > 0 ? request.credits : requestCredit ? [requestCredit] : []
  const sharedCredit = reqCredits.some(c => existing.credits.some(e => e.lineId === c.lineId))
  const reqCreditCell = creditsCell(reqCredits, 'Not linked')
  if (request.credits.length === 0 && requestCredit) reqCreditCell.sub = `${fmtDate(requestCredit.lineDate)} · already used`
  const bankTone: [VerdictTone, string] =
    sharedCredit ? ['same', 'Same credit']
    : reqCredits.length === 0 && existing.credits.length === 0 ? ['plain', 'Neither is linked']
    : reqCredits.length === 0 ? ['plain', 'Request not linked']
    : existing.credits.length === 0 ? ['plain', 'Not linked']
    : ['differs', 'Different credits']
  row('credit', 'Bank credit', reqCreditCell, creditsCell(existing.credits, 'Not linked'), bankTone[0], bankTone[1])

  const refA = squash(request.reference)
  const refB = squash(existing.reference)
  row('utr', 'UTR', { text: request.reference?.trim() || 'Not entered', muted: !request.reference?.trim() },
    { text: existing.reference?.trim() || 'Not entered', muted: !existing.reference?.trim() },
    refA && refB ? (refA === refB || refA.includes(refB) || refB.includes(refA) ? 'same' : 'differs') : 'plain',
    refA && refB ? (refA === refB || refA.includes(refB) || refB.includes(refA) ? 'Same' : 'Differs') : !refA && !refB ? 'Neither has one' : !refA ? 'Request left it blank' : 'Not on the old payment')

  const nameA = words(request.clientName)
  const nameB = words(existing.clientName)
  row('client', 'Client', { text: request.clientName?.trim() || 'Not identified', muted: !nameA },
    { text: existing.clientName?.trim() || 'Not identified', sub: nameB ? undefined : 'Suspense payment', muted: !nameB },
    nameA && nameA === nameB ? 'same' : !nameA ? 'plain' : 'differs',
    nameA && nameA === nameB ? 'Same' : !nameA ? 'Request has no client' : 'Differs')

  const reqFor = destinationText(request.destination)
  const oldFor = destinationText(existing.destination)
  row('for', 'For', { text: reqFor ?? 'Nothing asked', muted: !reqFor }, { text: oldFor ?? 'Not allocated yet', muted: !oldFor },
    !reqFor ? 'plain' : !oldFor ? 'adds' : sameDestination(request.destination, existing.destination) ? 'same' : 'differs',
    !reqFor ? 'Nothing to apply' : !oldFor ? 'Merge applies it' : sameDestination(request.destination, existing.destination) ? 'Same' : 'Different place')

  const files = request.proofFiles
  row('proof', 'Proof', { text: files > 0 ? `${files} file${files === 1 ? '' : 's'}` : 'None', muted: files === 0 },
    { text: existing.proofFiles > 0 ? `${existing.proofFiles} file${existing.proofFiles === 1 ? '' : 's'}` : 'None', muted: existing.proofFiles === 0 },
    files > 0 ? 'adds' : 'plain', files > 0 ? 'Merge moves it' : 'Nothing to move')
  return rows
}

// ── Whether a merge is offered ──────────────────────────────────────────────

export type MergeBlocker = { code: 'not_verified' | 'account' | 'amount' | 'elsewhere'; text: string }

/** Null when a merge may be offered; otherwise the plain reason it may not (no disabled button is drawn). */
export function mergeBlocker(request: DuplicateSide, existing: DuplicateSide): MergeBlocker | null {
  const old = idOf(existing)
  if (!isVerifiedPayment(existing.status)) {
    return { code: 'not_verified', text: `${old} is not verified yet. Verify one of the two, then merge the other into it.` }
  }
  if (request.paymentMode !== existing.paymentMode) {
    return { code: 'account', text: `${old} is in ${paymentModeLabel(existing.paymentMode)} and this request is in ${paymentModeLabel(request.paymentMode)}. Correct the account first.` }
  }
  if (toPaise(request.amount) !== toPaise(existing.amount)) {
    const d = Math.abs(toPaise(request.amount) - toPaise(existing.amount)) / 100
    return { code: 'amount', text: `The amounts differ by ${formatMoney(d)}. A merge needs the same amount to the paisa. If one of them was typed wrongly, correct it first, then merge.` }
  }
  const asked = destinationText(request.destination)
  const placed = destinationText(existing.destination)
  if (asked && placed && !sameDestination(request.destination, existing.destination)) {
    return { code: 'elsewhere', text: `${old} is already allocated to ${placed}. Sales asked for ${asked}. Merging would put the same money in two places. Settle which is right in Confirmed Payments (Correct Allocation), then merge.` }
  }
  return null
}

/** The look-alikes, the likeliest first: a payment a merge could use, then the nearest date. */
export function rankCandidates(request: DuplicateSide, list: DuplicateSide[]): DuplicateSide[] {
  const rank = (c: DuplicateSide) =>
    (mergeBlocker(request, c) === null ? 0 : 1000) + dayGap(request.paymentDate, c.paymentDate)
  return [...list].sort((a, b) => rank(a) - rank(b))
}

/** What a merge will do, as sentences for the confirmation. Only what applies to this pair. */
export function mergeEffects(request: DuplicateSide, existing: DuplicateSide): string[] {
  const old = idOf(existing)
  const out = [`${old} stays as it is: verified, ${formatMoney(existing.amount)}${existing.credits.length > 0 ? `, linked to ${existing.credits.map(c => (c.statementNo === null ? 'a bank credit' : bankLineId(c.statementNo))).join(', ')}` : ''}.`]
  const asked = destinationText(request.destination)
  if (asked && !destinationText(existing.destination)) out.push(`It is applied to ${asked}, as Sales asked. It is not allocated yet.`)
  if (request.proofFiles > 0) out.push(`The ${request.proofFiles === 1 ? 'proof file' : `${request.proofFiles} proof files`} on the request ${request.proofFiles === 1 ? 'moves' : 'move'} to ${old}.`)
  if (request.credits.length > 0) out.push(`The bank credit the request was linked to is released.`)
  out.push(`${idOf(request)} is closed as merged. It is not rejected.`)
  out.push(request.addedByName ? `${request.addedByName} is told it was already recorded. They do not need to do anything.` : 'The person who sent it is told it was already recorded.')
  out.push(`The activity on ${old} records who sent the request, who merged it, and why.`)
  return out
}

/** What merge_payment_request answers, in the page's own spelling. */
export type MergeResult = {
  mergedRequestId: string
  requestNumber: string | null
  requestHumanId: string | null
  submittedBy: string | null
  clientName: string | null
  intoPaymentId: string
  intoHumanId: string | null
  intoRequestNumber: string | null
  allocationsApplied: number
  /** The Order the money now sits on, when Sales asked for one: its people are told. */
  orderId: string | null
  proofFilesMoved: number
  bankLinksReleased: number
}

export function readMergeResult(data: unknown): MergeResult {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const s = (k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null)
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0)
  return {
    mergedRequestId: s('merged_request_id') ?? '', requestNumber: s('request_number'), requestHumanId: s('request_human_id'),
    submittedBy: s('submitted_by'), clientName: s('client_name'), intoPaymentId: s('into_payment_id') ?? '',
    intoHumanId: s('into_human_id'), intoRequestNumber: s('into_request_number'), allocationsApplied: n('allocations_applied'),
    orderId: s('order_id'), proofFilesMoved: n('proof_files_moved'), bankLinksReleased: n('bank_links_released'),
  }
}

/** The database's refusal, in words. */
export function mergeRefusal(message: string | null | undefined): string {
  const m = message ?? ''
  if (m.includes('PAYMENT_SELF_DECISION_FORBIDDEN')) return 'You recorded this request yourself, so another payment verifier must decide it.'
  if (m.includes('BANK_FORBIDDEN') || m.includes('MERGE_FORBIDDEN')) return 'Merging needs access to Bank Statements and permission to verify payments.'
  if (m.includes('MERGE_REQUEST_NOT_PENDING')) return 'Somebody decided this request first. Close this window and open it again.'
  if (m.includes('MERGE_NOT_FOUND')) return 'One of the two payments is gone. Close this window and open it again.'
  if (m.includes('MERGE_AMOUNT_DIFFERS')) return 'The amounts differ, so these are not the same payment. Correct one of them first.'
  if (m.includes('MERGE_ACCOUNT_DIFFERS')) return 'The two payments are in different accounts. Correct the account first.'
  if (m.includes('MERGE_TARGET_NOT_VERIFIED')) return 'The payment to merge into is not verified yet.'
  if (m.includes('MERGE_ALLOCATED_ELSEWHERE')) return 'The old payment is already allocated somewhere other than where Sales asked. Correct that allocation first.'
  if (m.includes('MERGE_NOT_BANK_ACCOUNT')) return 'Only a payment received in an HDFC account can be merged here.'
  if (m.includes('MERGE_TEST_DATA_MISMATCH')) return 'A test payment and a real payment are never merged.'
  if (m.includes('MERGE_TRY_AGAIN')) return 'The request changed while it was being merged. Close this window and open it again.'
  if (m.includes('ALLOCATION_TARGET')) return 'What Sales asked for can no longer take this money (the PI or Order has moved on). Nothing was merged. Settle it in Confirmed Payments first.'
  return 'The payment could not be merged. Nothing was changed. Try again.'
}

// ── Reading them ────────────────────────────────────────────────────────────

type PayRow = {
  id: string; human_payment_id: string | null; client_name: string | null; status: string
  amount: number | string; payment_date: string; payment_mode: string; proof_note: string | null; created_at: string
  submitted_by_user: { full_name: string | null } | { full_name: string | null }[] | null
}
type LinkRow = {
  payment_id: string; line_id: string
  bank_statement_lines: { line_date: string; statement_no: number | string | null } | { line_date: string; statement_no: number | string | null }[] | null
}

const PAY_COLUMNS = 'id, human_payment_id, client_name, status, amount, payment_date, payment_mode, proof_note, created_at, submitted_by_user:users!submitted_by(full_name)'
const first = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)

/**
 * The request and its look-alikes, ready to compare. `holderIds` are the payments that already
 * hold the credit the request looks like. Throws when the payments cannot be read: the caller
 * then shows nothing extra rather than a half-comparison.
 */
export async function loadDuplicates(
  supabase: SupabaseClient, request: DuplicateRequestInput, holderIds: string[],
): Promise<{ request: DuplicateSide; candidates: DuplicateSide[] }> {
  const byDetails = await supabase.from('finance_payment_requests').select(PAY_COLUMNS)
    .eq('payment_mode', request.paymentMode).eq('amount', request.amount)
    .in('status', ['approved_unlinked', 'approved_linked'])
    .gte('payment_date', addDays(request.paymentDate, -DUPLICATE_WINDOW_DAYS))
    .lte('payment_date', addDays(request.paymentDate, DUPLICATE_WINDOW_DAYS))
    .neq('id', request.id).is('deleted_at', null)
    .order('payment_date', { ascending: false }).limit(MAX_CANDIDATES)
  if (byDetails.error) throw new Error('Possible duplicates could not be read.')
  const rows = new Map(((byDetails.data ?? []) as unknown as PayRow[]).map(r => [r.id, r]))

  const extra = [...new Set(holderIds)].filter(id => id !== request.id && !rows.has(id))
  if (extra.length > 0) {
    const held = await supabase.from('finance_payment_requests').select(PAY_COLUMNS).in('id', extra).is('deleted_at', null)
    if (!held.error) for (const r of (held.data ?? []) as unknown as PayRow[]) rows.set(r.id, r)
  }
  if (rows.size === 0) return { request: toSide(request, [], null, 0), candidates: [] }

  const ids = [request.id, ...rows.keys()]
  const [links, proofs, destinations] = await Promise.all([
    supabase.from('bank_line_payment_links').select('payment_id, line_id, bank_statement_lines(line_date, statement_no)')
      .in('payment_id', ids).is('unlinked_at', null),
    supabase.from('payment_proof_attachments').select('payment_request_id').in('payment_request_id', ids),
    loadPaymentDestinations(supabase, ids),
  ])
  const creditsOf = new Map<string, DuplicateCredit[]>()
  for (const l of (links.error ? [] : (links.data ?? [])) as unknown as LinkRow[]) {
    const line = first(l.bank_statement_lines)
    const list = creditsOf.get(l.payment_id) ?? []
    list.push({ lineId: l.line_id, lineDate: line?.line_date ?? '', statementNo: line?.statement_no == null ? null : Number(line.statement_no) })
    creditsOf.set(l.payment_id, list)
  }
  const filesOf = new Map<string, number>()
  for (const p of (proofs.error ? [] : (proofs.data ?? [])) as { payment_request_id: string }[]) {
    filesOf.set(p.payment_request_id, (filesOf.get(p.payment_request_id) ?? 0) + 1)
  }

  const mine = toSide(request, creditsOf.get(request.id) ?? [], destinations.get(request.id) ?? null, filesOf.get(request.id) ?? 0)
  const candidates = [...rows.values()].map(r => ({
    id: r.id, humanId: r.human_payment_id, status: r.status, amount: Number(r.amount), paymentDate: r.payment_date,
    paymentMode: r.payment_mode, clientName: r.client_name, reference: r.proof_note,
    addedByName: first(r.submitted_by_user)?.full_name ?? null, addedAt: r.created_at,
    credits: creditsOf.get(r.id) ?? [], destination: destinations.get(r.id) ?? null, proofFiles: filesOf.get(r.id) ?? 0,
  }))
  return { request: mine, candidates: rankCandidates(mine, candidates).slice(0, MAX_CANDIDATES) }
}

function toSide(r: DuplicateRequestInput, credits: DuplicateCredit[], destination: PaymentDestination | null, proofFiles: number): DuplicateSide {
  return {
    id: r.id, humanId: r.humanId, status: r.status, amount: r.amount, paymentDate: r.paymentDate, paymentMode: r.paymentMode,
    clientName: r.clientName, reference: r.reference, addedByName: r.addedByName, addedAt: r.addedAt, credits, destination, proofFiles,
  }
}
