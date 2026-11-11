// ── The Cash journeys board (2026-10-29) ─────────────────────────────────────
//
// The founders' view of every PNB, Paytm and Canara payment: where the money
// is, how long it has been there, who recorded it, whether Finance has
// verified it, and what is wrong — in words, so nothing is colour alone.
//
// Everything here is pure. The data comes from two reads the hooks already
// make (finance_unclosed_funds and finance_payment_custody_status, both
// 20270413000000) and one enrichment read of finance_payment_requests under
// the reader's own RLS. NOTHING HERE AUTHORIZES ANYTHING.

import {
  HANDOVER_LATE_AFTER_HOURS,
  HANDOVER_OVERDUE_AFTER_HOURS,
  type Handover,
} from './handover'
import { journeyStepLabel, sumAmounts, waitingAge, type CashPayment, type JourneyStep } from './cashJourney'

// ── The payment record behind a journey ──────────────────────────────────────
//
// What the journey RPCs do not carry and a founder wants beside every row: who
// recorded the payment, whether Finance verified it, and the Order it names.

export type TrackedPaymentRecord = {
  paymentId: string
  humanPaymentId: string | null
  clientName: string | null
  amount: number
  paymentMode: string
  paymentDate: string | null
  recordedAt: string
  status: string
  orderNumber: string | null
  recordedByName: string | null
}

/** How many tracked payments the board reads behind the journeys (newest first). */
export const TRACKED_RECORDS_LIMIT = 200

type Raw = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export function readTrackedPaymentRecords(raw: unknown): TrackedPaymentRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r): TrackedPaymentRecord[] => {
    const o = (r ?? {}) as Raw
    const paymentId = str(o.id)
    if (!paymentId) return []
    // PostgREST returns a many-to-one embed as an object; an array is tolerated.
    const by = Array.isArray(o.submitted_by_user) ? o.submitted_by_user[0] : o.submitted_by_user
    const byName = by && typeof by === 'object' ? str((by as Raw).full_name) : null
    return [{
      paymentId,
      humanPaymentId: str(o.human_payment_id),
      clientName: str(o.client_name),
      amount: num(o.amount),
      paymentMode: str(o.payment_mode) ?? '',
      paymentDate: str(o.payment_date),
      recordedAt: str(o.created_at) ?? '',
      status: str(o.status) ?? '',
      orderNumber: str(o.order_number),
      recordedByName: byName,
    }]
  })
}

// ── Finance verification, beside the cash state ──────────────────────────────
//
// Custody and verification are two different facts (20270417000000: accepting
// cash never approves a payment). A founder needs both on one line: money that
// is with the company but not verified is a loop Finance has not closed yet.

export type VerificationState = 'verified' | 'not_verified' | 'clarification' | 'unknown'

export function verificationState(status: string | null | undefined): VerificationState {
  switch ((status ?? '').trim()) {
    case 'approved_unlinked':
    case 'approved_linked':
      return 'verified'
    case 'pending_approval':
      return 'not_verified'
    case 'needs_clarification':
      return 'clarification'
    default:
      return 'unknown'
  }
}

export const VERIFICATION_LABEL: Record<VerificationState, string> = {
  verified:      'Verified',
  not_verified:  'Not verified yet',
  clarification: 'Clarification asked',
  unknown:       'Verification unknown',
}

// ── Time ─────────────────────────────────────────────────────────────────────

export function hoursSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, (nowMs - t) / 3_600_000)
}

/** Whole days from one instant (or date) to another; null when either is missing. */
export function daysBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null
  const a = Date.parse(fromIso)
  const b = Date.parse(toIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.floor((b - a) / 86_400_000)
}

export type AgeTone = 'fresh' | 'late' | 'overdue'

/** The same thresholds as the handover banner: a day is late, three days is overdue. */
export function ageTone(hours: number | null | undefined): AgeTone {
  const h = hours ?? 0
  if (h >= HANDOVER_OVERDUE_AFTER_HOURS) return 'overdue'
  if (h >= HANDOVER_LATE_AFTER_HOURS) return 'late'
  return 'fresh'
}

// ── What is wrong with a journey, in words ───────────────────────────────────
//
// Every reason a founder would want to be told about, each as one sentence.
// A payment with no flags is simply on its way.

/** A payment recorded this many days (or more) after it was paid is flagged. */
export const LATE_RECORD_AFTER_DAYS = 3

export type FlagKind = 'not_accepted' | 'held_long' | 'order_exception' | 'late_record'
export type FlagSeverity = 'overdue' | 'late' | 'note'
export type JourneyFlag = { kind: FlagKind; severity: FlagSeverity; text: string }

export function paymentFlags(
  p: CashPayment,
  rec: TrackedPaymentRecord | null | undefined,
  nowMs: number = Date.now(),
): JourneyFlag[] {
  const flags: JourneyFlag[] = []
  if (p.state === 'with_company') return flags

  if (p.state === 'waiting' && p.openHandover) {
    const h = hoursSince(p.openHandover.createdAt, nowMs) ?? 0
    const tone = ageTone(h)
    if (tone !== 'fresh') {
      flags.push({
        kind: 'not_accepted',
        severity: tone,
        text: `${p.openHandover.recipientName} has not accepted for ${waitingAge(h)}`,
      })
    }
  }

  if (p.state === 'with_holder') {
    const tone = ageTone(p.ageHours)
    if (tone !== 'fresh') {
      flags.push({
        kind: 'held_long',
        severity: tone,
        text: `With ${p.holderName ?? 'someone'} for ${waitingAge(p.ageHours)} and no handover started`,
      })
    }
  }

  if (p.orderException) {
    flags.push({
      kind: 'order_exception',
      severity: 'note',
      text: 'Its Order was approved before this cash reached the company',
    })
  }

  const paidToRecorded = daysBetween(rec?.paymentDate ?? p.paymentDate, rec?.recordedAt ?? p.recordedAt)
  if (paidToRecorded !== null && paidToRecorded >= LATE_RECORD_AFTER_DAYS) {
    flags.push({
      kind: 'late_record',
      severity: 'note',
      text: `Recorded ${paidToRecorded} days after it was paid`,
    })
  }

  return flags
}

const SEVERITY_RANK: Record<FlagSeverity, number> = { overdue: 0, late: 1, note: 2 }

/** Lower is more urgent; a payment with nothing wrong ranks last. */
export function attentionRank(flags: readonly JourneyFlag[]): number {
  return flags.reduce((best, f) => Math.min(best, SEVERITY_RANK[f.severity]), 3)
}

export function worstSeverity(flags: readonly JourneyFlag[]): FlagSeverity | null {
  const rank = attentionRank(flags)
  return rank === 3 ? null : (Object.keys(SEVERITY_RANK) as FlagSeverity[])[rank]
}

// ── The rows the board draws ─────────────────────────────────────────────────

export type BoardRow = {
  payment: CashPayment
  record: TrackedPaymentRecord | null
  flags: JourneyFlag[]
  verification: VerificationState
  /** Hours since its open handover was offered; null when there is none. */
  handoverHours: number | null
}

export function toBoardRows(
  payments: readonly CashPayment[],
  records: ReadonlyMap<string, TrackedPaymentRecord>,
  nowMs: number = Date.now(),
): BoardRow[] {
  return payments.map(p => {
    const record = records.get(p.paymentId) ?? null
    return {
      payment: p,
      record,
      flags: paymentFlags(p, record, nowMs),
      verification: verificationState(record?.status),
      handoverHours: p.openHandover ? hoursSince(p.openHandover.createdAt, nowMs) : null,
    }
  })
}

/** Most urgent first, then the oldest; stable for rows that tie. */
export function sortByAttention(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) =>
    attentionRank(a.flags) - attentionRank(b.flags) || b.payment.ageHours - a.payment.ageHours)
}

/** The payments that reached the company, newest arrival first. */
export function sortByReached(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => Date.parse(b.payment.holderSince) - Date.parse(a.payment.holderSince))
}

// ── Search ───────────────────────────────────────────────────────────────────

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase()

/** Payment ID, client, holder, recorder, the people of its open handover, its Order. */
export function rowMatches(row: BoardRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const p = row.payment
  const hay = [
    p.humanPaymentId, p.clientName, p.holderName, p.paymentMode,
    p.openHandover?.humanId, p.openHandover?.giverName, p.openHandover?.recipientName,
    row.record?.recordedByName, row.record?.orderNumber,
  ].map(norm)
  return hay.some(h => h.includes(q))
}

// ── The trail ────────────────────────────────────────────────────────────────

const RESOLVING_KINDS: readonly JourneyStep['kind'][] = ['handover_accepted', 'handover_disputed', 'handover_cancelled']

/**
 * One trail step as a sentence. A "handed it to X — waiting for acceptance"
 * step keeps its tail only while that handover is still open; once a later
 * step of the same handover answered it, the history reads as history.
 */
export function trailStepLabel(step: JourneyStep, steps: readonly JourneyStep[]): string {
  const label = journeyStepLabel(step)
  if (step.kind !== 'handover_created' || !step.handoverHumanId) return label
  const answered = steps.some(s => s.handoverHumanId === step.handoverHumanId && RESOLVING_KINDS.includes(s.kind))
  return answered ? label.replace(/ — waiting for acceptance$/, '') : label
}

/** The handover log's search: its number, the two people, and the payments in it. */
export function handoverMatches(
  h: Pick<Handover, 'humanId' | 'giverName' | 'recipientName' | 'items'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    h.humanId, h.giverName, h.recipientName,
    ...h.items.flatMap(i => [i.humanPaymentId, i.clientName]),
  ].map(norm)
  return hay.some(s => s.includes(q))
}

// ── The four figures above the board ─────────────────────────────────────────

export const REACHED_WINDOW_DAYS = 30

export type BoardSummary = {
  outside:   { amount: number; count: number; people: number }
  attention: { count: number; overdue: number }
  waiting:   { amount: number; count: number }
  reached:   { amount: number; count: number; days: number }
}

export function boardSummary(
  unclosed: readonly BoardRow[],
  reached: readonly BoardRow[],
  nowMs: number = Date.now(),
): BoardSummary {
  const people = new Set(unclosed.map(r => r.payment.holderId ?? 'unknown'))
  const flagged = unclosed.filter(r => r.flags.length > 0)
  const waiting = unclosed.filter(r => r.payment.state === 'waiting')
  const since = nowMs - REACHED_WINDOW_DAYS * 86_400_000
  const recent = reached.filter(r => {
    const t = Date.parse(r.payment.holderSince)
    return Number.isFinite(t) && t >= since
  })
  return {
    outside:   { amount: sumAmounts(unclosed.map(r => r.payment)), count: unclosed.length, people: people.size },
    attention: { count: flagged.length, overdue: flagged.filter(r => worstSeverity(r.flags) === 'overdue').length },
    waiting:   { amount: sumAmounts(waiting.map(r => r.payment)), count: waiting.length },
    reached:   { amount: sumAmounts(recent.map(r => r.payment)), count: recent.length, days: REACHED_WINDOW_DAYS },
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
