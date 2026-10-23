// ── Cash handover with acceptance ────────────────────────────────────────────
//
// The giver OFFERS a handover of specific PNB/Paytm payments; the recipient
// ACCEPTS it (or disputes it). Until then both people are shown it, loudly, on
// every Finance page. Accepting appends the per-payment custody events, so
// custody_events stays the one custody record.
//
// NOTHING HERE AUTHORIZES ANYTHING. Who may create, accept, dispute, cancel or
// remind is decided by the RPCs in 20270410000100 (create_cash_handover and
// friends) and echoed to the browser as the can_* flags of
// finance_handover_list. The browser only draws what the server already allowed.
//
// TYPED CASH (20270412000000). A handover may also carry one typed cash line:
// cash FROM THE GIVER'S CASH IN HAND (up to what they have available) and/or NEW
// cash with a "where is it from" note. Typed cash is tracked as a per-person
// cash-in-hand balance (finance_cash_balance_entries), moved only on accept.

import { amountInputProblem } from '@/lib/currency'

export const HANDOVER_STATUSES = ['pending', 'accepted', 'disputed', 'cancelled'] as const
export type HandoverStatus = typeof HANDOVER_STATUSES[number]

export const OPEN_HANDOVER_STATUSES: readonly HandoverStatus[] = ['pending', 'disputed']

export const HANDOVER_STATUS_LABEL: Record<HandoverStatus, string> = {
  pending:   'Waiting for acceptance',
  accepted:  'Accepted',
  disputed:  'Disputed',
  cancelled: 'Cancelled',
}

export type HandoverItem = {
  paymentId: string
  humanPaymentId: string | null
  clientName: string | null
  amount: number
  paymentMode: string
  paymentDate: string | null
}

export type HandoverEvent = {
  eventType: 'created' | 'accepted' | 'disputed' | 'cancelled' | 'reminded'
  actorId: string | null
  actorName: string | null
  note: string | null
  createdAt: string
}

export type Handover = {
  id: string
  humanId: string
  status: HandoverStatus
  giverId: string
  giverName: string
  recipientId: string
  recipientName: string
  totalAmount: number
  /** Typed cash taken from the giver's cash in hand (20270412000000). */
  cashFromHand: number
  /** Typed cash not recorded anywhere before this handover, with its source. */
  cashNew: number
  cashNewSource: string | null
  handedAt: string
  note: string | null
  createdAt: string
  acceptedAt: string | null
  disputedAt: string | null
  disputeReason: string | null
  cancelledAt: string | null
  cancelReason: string | null
  lastRemindedAt: string | null
  ageHours: number
  canAccept: boolean
  canDispute: boolean
  canCancel: boolean
  canRemind: boolean
  items: HandoverItem[]
  events: HandoverEvent[]
}

// ── Reading the RPC's JSON ───────────────────────────────────────────────────

type Raw = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function isStatus(v: unknown): v is HandoverStatus {
  return typeof v === 'string' && (HANDOVER_STATUSES as readonly string[]).includes(v)
}

const EVENT_TYPES = ['created', 'accepted', 'disputed', 'cancelled', 'reminded'] as const

export function readHandover(raw: unknown): Handover | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Raw
  const id = str(r.id)
  if (!id || !isStatus(r.status)) return null
  const items = Array.isArray(r.items) ? r.items : []
  const events = Array.isArray(r.events) ? r.events : []
  return {
    id,
    humanId: str(r.human_id) ?? 'Handover',
    status: r.status,
    giverId: str(r.giver_id) ?? '',
    giverName: str(r.giver_name) ?? 'Unknown user',
    recipientId: str(r.recipient_id) ?? '',
    recipientName: str(r.recipient_name) ?? 'Unknown user',
    totalAmount: num(r.total_amount),
    cashFromHand: num(r.cash_from_hand),
    cashNew: num(r.cash_new),
    cashNewSource: str(r.cash_new_source),
    handedAt: str(r.handed_at) ?? '',
    note: str(r.note),
    createdAt: str(r.created_at) ?? '',
    acceptedAt: str(r.accepted_at),
    disputedAt: str(r.disputed_at),
    disputeReason: str(r.dispute_reason),
    cancelledAt: str(r.cancelled_at),
    cancelReason: str(r.cancel_reason),
    lastRemindedAt: str(r.last_reminded_at),
    ageHours: num(r.age_hours),
    canAccept: r.can_accept === true,
    canDispute: r.can_dispute === true,
    canCancel: r.can_cancel === true,
    canRemind: r.can_remind === true,
    items: items.map((i): HandoverItem => {
      const o = (i ?? {}) as Raw
      return {
        paymentId: str(o.payment_id) ?? '',
        humanPaymentId: str(o.human_payment_id),
        clientName: str(o.client_name),
        amount: num(o.amount),
        paymentMode: str(o.payment_mode) ?? '',
        paymentDate: str(o.payment_date),
      }
    }),
    events: events.flatMap((e): HandoverEvent[] => {
      const o = (e ?? {}) as Raw
      const type = (EVENT_TYPES as readonly string[]).includes(String(o.event_type))
        ? (o.event_type as HandoverEvent['eventType']) : null
      if (!type) return []
      return [{
        eventType: type,
        actorId: str(o.actor_id),
        actorName: str(o.actor_name),
        note: str(o.note),
        createdAt: str(o.created_at) ?? '',
      }]
    }),
  }
}

export function readHandovers(raw: unknown): Handover[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(r => {
    const h = readHandover(r)
    return h ? [h] : []
  })
}

export function isOpenHandover(h: Pick<Handover, 'status'>): boolean {
  return h.status === 'pending' || h.status === 'disputed'
}

// ── Who is looking, and how loud to be ───────────────────────────────────────

/** The viewer's seat in one handover. An admin watching others' handovers is an observer. */
export type HandoverRole = 'recipient' | 'giver' | 'observer'

export function handoverRole(h: Pick<Handover, 'giverId' | 'recipientId'>, viewerId: string | null): HandoverRole {
  if (viewerId && h.recipientId === viewerId) return 'recipient'
  if (viewerId && h.giverId === viewerId) return 'giver'
  return 'observer'
}

/**
 * How urgent the banner is, by age and state.
 *
 *   fresh    < 24 h    amber
 *   late     24-72 h   deep orange
 *   overdue  > 72 h    red, labelled OVERDUE
 *   disputed any age   red-purple, labelled DISPUTED (it needs a person to resolve it)
 */
export const HANDOVER_LATE_AFTER_HOURS = 24
export const HANDOVER_OVERDUE_AFTER_HOURS = 72

export type HandoverSeverity = 'fresh' | 'late' | 'overdue' | 'disputed'

export function handoverSeverity(h: Pick<Handover, 'status' | 'ageHours'>): HandoverSeverity {
  if (h.status === 'disputed') return 'disputed'
  if (h.ageHours >= HANDOVER_OVERDUE_AFTER_HOURS) return 'overdue'
  if (h.ageHours >= HANDOVER_LATE_AFTER_HOURS) return 'late'
  return 'fresh'
}

/** "just now", "5 hours", "2 days": how long it has been waiting. */
export function waitingFor(ageHours: number): string {
  if (!Number.isFinite(ageHours) || ageHours < 1) return 'just now'
  if (ageHours < 24) {
    const h = Math.floor(ageHours)
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  const d = Math.floor(ageHours / 24)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

const SEVERITY_RANK: Record<HandoverSeverity, number> = { disputed: 0, overdue: 1, late: 2, fresh: 3 }

/**
 * The order a person's own open handovers are drawn in: the ones waiting for
 * THEM to act first (recipient), then by how loud they are, then oldest first.
 */
export function sortMyHandovers(list: Handover[], viewerId: string | null): Handover[] {
  return [...list].sort((a, b) => {
    const ar = handoverRole(a, viewerId) === 'recipient' ? 0 : 1
    const br = handoverRole(b, viewerId) === 'recipient' ? 0 : 1
    if (ar !== br) return ar - br
    const as = SEVERITY_RANK[handoverSeverity(a)]
    const bs = SEVERITY_RANK[handoverSeverity(b)]
    if (as !== bs) return as - bs
    return b.ageHours - a.ageHours
  })
}

/** The one headline sentence a reader sees first, from their own seat. */
export function handoverHeadline(h: Handover, role: HandoverRole): string {
  const disputed = h.status === 'disputed'
  if (role === 'recipient') {
    return disputed
      ? `You disputed the cash from ${h.giverName}`
      : `${h.giverName} handed you cash. Accept it once you have received it`
  }
  if (role === 'giver') {
    return disputed
      ? `${h.recipientName} disputed your handover`
      : `${h.recipientName} has not accepted your handover yet`
  }
  return disputed
    ? `${h.recipientName} disputed the cash from ${h.giverName}`
    : `${h.recipientName} has not accepted the cash from ${h.giverName}`
}

export function handoverPaymentCount(h: Pick<Handover, 'items'>): string {
  const n = h.items.length
  return `${n} ${n === 1 ? 'payment' : 'payments'}`
}

/** Typed cash on a handover (from hand + new), in rupees. */
export function handoverCash(h: Pick<Handover, 'cashFromHand' | 'cashNew'>): number {
  return sumRupees([h.cashFromHand, h.cashNew])
}

/**
 * What a handover carries, in a few words: "2 payments", "₹500 cash", or
 * "2 payments + ₹500 cash". `money` is the caller's formatter (formatINR).
 */
export function handoverContentsLabel(
  h: Pick<Handover, 'items' | 'cashFromHand' | 'cashNew'>,
  money: (n: number) => string,
): string {
  const parts: string[] = []
  if (h.items.length > 0) parts.push(handoverPaymentCount(h))
  const cash = handoverCash(h)
  if (cash > 0) parts.push(`${money(cash)} cash`)
  return parts.length > 0 ? parts.join(' + ') : 'nothing'
}

// ── The create form ──────────────────────────────────────────────────────────

export type HandoverCandidate = {
  paymentId: string
  humanPaymentId: string | null
  clientName: string | null
  amount: number
  paymentMode: string
  paymentDate: string | null
}

export function readHandoverCandidates(raw: unknown): HandoverCandidate[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((i): HandoverCandidate[] => {
    const o = (i ?? {}) as Raw
    const paymentId = str(o.payment_id)
    if (!paymentId) return []
    return [{
      paymentId,
      humanPaymentId: str(o.human_payment_id),
      clientName: str(o.client_name),
      amount: num(o.amount),
      paymentMode: str(o.payment_mode) ?? '',
      paymentDate: str(o.payment_date),
    }]
  })
}

export type HandoverRecipient = { id: string; fullName: string }

export function readHandoverRecipients(raw: unknown): HandoverRecipient[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((i): HandoverRecipient[] => {
    const o = (i ?? {}) as Raw
    const id = str(o.id)
    return id ? [{ id, fullName: str(o.full_name) ?? 'Unknown user' }] : []
  })
}

/** Sum in paise so 0.1 + 0.2 never shows as 0.30000000000000004. */
export function sumRupees(amounts: readonly number[]): number {
  return amounts.reduce((acc, a) => acc + Math.round(a * 100), 0) / 100
}

export const HANDOVER_REASON_MIN = 3
export const HANDOVER_REASON_MAX = 500

/** What is wrong with the create form, in one sentence, or null. Mirrors create_cash_handover. */
export function handoverDraftError(draft: {
  recipientId: string
  paymentIds: readonly string[]
  handedAt: string
  /** Typed amounts as entered (raw input text); '' means none. */
  cashFromHand?: string
  cashNew?: string
  cashNewSource?: string
  /** The giver's available cash in hand, when known. */
  available?: number | null
}): string | null {
  if (!draft.recipientId) return 'Choose who you are handing the cash to.'
  const fromHandRaw = (draft.cashFromHand ?? '').trim()
  const newRaw = (draft.cashNew ?? '').trim()
  const fromHandProblem = amountInputProblem(fromHandRaw)
  if (fromHandProblem) return `Cash from your hand: ${fromHandProblem}`
  const newProblem = amountInputProblem(newRaw)
  if (newProblem) return `New cash: ${newProblem}`
  const fromHand = fromHandRaw ? Number(fromHandRaw) || 0 : 0
  const cashNew = newRaw ? Number(newRaw) || 0 : 0
  if (draft.paymentIds.length === 0 && fromHand <= 0 && cashNew <= 0) {
    return 'Choose a payment or enter a cash amount to hand over.'
  }
  if (draft.paymentIds.length > 50) return 'A handover can carry at most 50 payments.'
  if (fromHand > 0 && typeof draft.available === 'number' && fromHand > draft.available) {
    return 'That is more than the cash you have available in hand.'
  }
  const source = (draft.cashNewSource ?? '').trim()
  if (cashNew > 0 && source.length < 3) return 'Say where the new cash came from.'
  if (cashNew > 0 && source.length > 200) return 'Keep where the cash came from under 200 characters.'
  if (!draft.handedAt.trim()) return 'Enter the date and time of the handover.'
  const when = new Date(draft.handedAt)
  if (Number.isNaN(when.getTime())) return 'Enter a valid date and time.'
  if (when.getTime() > Date.now() + 24 * 3600 * 1000) return 'The handover cannot be in the future.'
  return null
}

/** What is wrong with a dispute/cancel reason, or null. Mirrors dispute_cash_handover. */
export function handoverReasonError(reason: string): string | null {
  const t = reason.trim()
  if (t.length < HANDOVER_REASON_MIN) return 'Say what is wrong (at least a few words).'
  if (t.length > HANDOVER_REASON_MAX) return `Keep it under ${HANDOVER_REASON_MAX} characters.`
  return null
}

/**
 * The server's refusal in words. The RPCs raise "CODE: message"; the message is
 * already written for a reader, so it is shown and the code is dropped.
 */
/**
 * True when the database does not have the handover functions yet (the
 * migration is not applied). The banner then draws NOTHING rather than an error
 * on every page of the app.
 */
export function isHandoverFeatureMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883'
    || /could not find the function/i.test(error.message ?? '')
}

export function handoverErrorMessage(error: { message?: string } | null | undefined): string {
  const raw = (error?.message ?? '').trim()
  const m = /^HANDOVER_[A-Z_]+:\s*([\s\S]+)$/.exec(raw)
  if (m) return m[1].trim()
  const c = /CUSTODY_[A-Z_]+:\s*([\s\S]+)$/.exec(raw)
  if (c) return c[1].trim()
  return 'Something went wrong. Please try again.'
}

// ── Cash in hand (20270412000000) ────────────────────────────────────────────
//
// A person's balance is the sum of their append-only ledger entries; available
// is the balance minus the typed cash they already offered in open handovers.
// Both numbers come from the database (finance_my_cash_balance /
// finance_cash_balances); nothing here recomputes them.

export const CASH_ENTRY_KINDS = ['handover_in', 'handover_out', 'new_cash', 'cash_out', 'adjustment'] as const
export type CashEntryKind = typeof CASH_ENTRY_KINDS[number]

export const CASH_OUT_KINDS = ['bank_deposit', 'paid_out', 'other'] as const
export type CashOutKind = typeof CASH_OUT_KINDS[number]

export const CASH_OUT_KIND_LABEL: Record<CashOutKind, string> = {
  bank_deposit: 'Deposited in the bank',
  paid_out:     'Paid out',
  other:        'Other',
}

export type CashEntry = {
  id: string
  delta: number
  kind: CashEntryKind
  cashOutKind: CashOutKind | null
  note: string | null
  handoverId: string | null
  handoverHumanId: string | null
  counterpartName: string | null
  createdAt: string
}

export type CashBalance = {
  balance: number
  reserved: number
  available: number
  entries: CashEntry[]
}

export type CashBalanceRow = {
  userId: string
  fullName: string
  balance: number
  reserved: number
  available: number
}

const isCashEntryKind = (v: unknown): v is CashEntryKind =>
  typeof v === 'string' && (CASH_ENTRY_KINDS as readonly string[]).includes(v)
const isCashOutKind = (v: unknown): v is CashOutKind =>
  typeof v === 'string' && (CASH_OUT_KINDS as readonly string[]).includes(v)

export function readCashBalance(raw: unknown): CashBalance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw
  const entries = Array.isArray(r.entries) ? r.entries : []
  return {
    balance: num(r.balance),
    reserved: num(r.reserved),
    available: num(r.available),
    entries: entries.flatMap((e): CashEntry[] => {
      const o = (e ?? {}) as Raw
      const id = str(o.id)
      if (!id || !isCashEntryKind(o.kind)) return []
      return [{
        id,
        delta: num(o.delta),
        kind: o.kind,
        cashOutKind: isCashOutKind(o.cash_out_kind) ? o.cash_out_kind : null,
        note: str(o.note),
        handoverId: str(o.handover_id),
        handoverHumanId: str(o.handover_human_id),
        counterpartName: str(o.counterpart_name),
        createdAt: str(o.created_at) ?? '',
      }]
    }),
  }
}

export function readCashBalances(raw: unknown): { allowed: boolean; canAdjust: boolean; rows: CashBalanceRow[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw
  const rows = Array.isArray(r.rows) ? r.rows : []
  return {
    allowed: r.allowed === true,
    canAdjust: r.can_adjust === true,
    rows: rows.flatMap((x): CashBalanceRow[] => {
      const o = (x ?? {}) as Raw
      const userId = str(o.user_id)
      if (!userId) return []
      return [{
        userId,
        fullName: str(o.full_name) ?? 'Unknown user',
        balance: num(o.balance),
        reserved: num(o.reserved),
        available: num(o.available),
      }]
    }),
  }
}

/** One ledger line in words, from the holder's own seat. */
export function cashEntryLabel(e: CashEntry): string {
  switch (e.kind) {
    case 'handover_in':  return `Received from ${e.counterpartName ?? 'someone'}${e.handoverHumanId ? ` (${e.handoverHumanId})` : ''}`
    case 'handover_out': return `Handed to ${e.counterpartName ?? 'someone'}${e.handoverHumanId ? ` (${e.handoverHumanId})` : ''}`
    case 'new_cash':     return `New cash from ${e.counterpartName ?? 'someone'}${e.note ? `: ${e.note}` : ''}`
    case 'cash_out':     return `${e.cashOutKind ? CASH_OUT_KIND_LABEL[e.cashOutKind] : 'Cash out'}${e.note ? `: ${e.note}` : ''}`
    case 'adjustment':   return `Adjusted by ${e.counterpartName ?? 'an administrator'}${e.note ? `: ${e.note}` : ''}`
  }
}

/** What is wrong with a cash-out form, or null. Mirrors record_cash_out. */
export function cashOutError(draft: { amount: string; kind: string; note: string; available: number | null }): string | null {
  const raw = draft.amount.trim()
  const problem = amountInputProblem(raw)
  if (problem) return problem
  const amount = raw ? Number(raw) || 0 : 0
  if (amount <= 0) return 'Enter the amount.'
  if (typeof draft.available === 'number' && amount > draft.available) {
    return 'That is more than the cash you have available in hand.'
  }
  if (!(CASH_OUT_KINDS as readonly string[]).includes(draft.kind)) return 'Choose what happened to the cash.'
  const note = draft.note.trim()
  if (note.length < 3) return 'Add a short note (at least a few characters).'
  if (note.length > 500) return 'Keep the note under 500 characters.'
  return null
}

/** What is wrong with an administrator's adjustment, or null. Mirrors adjust_cash_balance. */
export function adjustmentError(draft: { amount: string; direction: 'add' | 'remove'; reason: string; available: number }): string | null {
  const raw = draft.amount.trim()
  const problem = amountInputProblem(raw)
  if (problem) return problem
  const amount = raw ? Number(raw) || 0 : 0
  if (amount <= 0) return 'Enter the amount.'
  if (draft.direction === 'remove' && amount > draft.available) {
    return 'That would take the balance below what this person has available.'
  }
  const reason = draft.reason.trim()
  if (reason.length < 3) return 'Give a reason (at least a few characters).'
  if (reason.length > 500) return 'Keep the reason under 500 characters.'
  return null
}
