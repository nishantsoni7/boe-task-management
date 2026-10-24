// ── Cash journeys (20270413000000) ───────────────────────────────────────────
//
// Every payment that does NOT land in the two HDFC accounts (PNB, Paytm,
// Canara — Canara also stands for money received in somebody's savings
// account) is carried by people until it reaches the company. Its JOURNEY is
// the chain of accepted handovers; it CLOSES when its holder is a company cash
// custodian (an admin setting; Nitish today).
//
// One idea for users: "where is this money now?" Every tracked payment is in
// exactly one of four states, said in the same words everywhere.
//
// NOTHING HERE AUTHORIZES ANYTHING. Who may accept, hand over or receive is
// decided by the database (create/accept_cash_handover, receive_cash_directly)
// and echoed as the can_* flags of finance_cash_payment_state.

export const CASH_STATES = ['with_holder', 'waiting', 'disputed', 'with_company'] as const
export type CashState = typeof CASH_STATES[number]

export type OpenHandoverRef = {
  id: string
  humanId: string
  status: 'pending' | 'disputed'
  giverId: string
  giverName: string
  recipientId: string
  recipientName: string
  createdAt: string
}

export type CashPayment = {
  paymentId: string
  humanPaymentId: string | null
  clientName: string | null
  amount: number
  paymentMode: string
  paymentDate: string | null
  recordedAt: string
  tracked: boolean
  state: CashState
  holderId: string | null
  holderName: string | null
  holderSince: string
  ageHours: number
  openHandover: OpenHandoverRef | null
  canAccept: boolean
  canHandOver: boolean
  canReceive: boolean
  /** Its Order was approved before this cash reached the company (20270414000000). */
  orderException: { reason: string; byName: string | null; at: string } | null
}

export type UnclosedFunds = {
  scope: 'all' | 'mine' | 'none'
  viewerIsCustodian: boolean
  custodians: { id: string; fullName: string }[]
  payments: CashPayment[]
}

export type JourneyStepKind =
  | 'recorded' | 'collected' | 'handed_over' | 'received_directly'
  | 'handover_created' | 'handover_accepted' | 'handover_disputed' | 'handover_cancelled'

export type JourneyStep = {
  kind: JourneyStepKind
  at: string
  actorName: string | null
  toName: string | null
  note: string | null
  handoverHumanId: string | null
}

export type PaymentJourney = { payment: CashPayment | null; steps: JourneyStep[] }

// ── The modes ────────────────────────────────────────────────────────────────

/** The two company bank accounts. Everything else is carried by people. */
export const UNTRACKED_PAYMENT_MODES = ['hdfc', 'hdfc_sec'] as const

/** Mirrors payment_mode_requires_custody() (20270413000000). */
export const TRACKED_PAYMENT_MODES = ['pnb', 'paytm', 'canara'] as const

export function isTrackedPaymentMode(mode: string | null | undefined): boolean {
  return (TRACKED_PAYMENT_MODES as readonly string[]).includes((mode ?? '').trim().toLowerCase())
}

// ── Reading the RPC JSON ─────────────────────────────────────────────────────

type Raw = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const isState = (v: unknown): v is CashState =>
  typeof v === 'string' && (CASH_STATES as readonly string[]).includes(v)

function readOpenHandover(raw: unknown): OpenHandoverRef | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Raw
  const id = str(o.id)
  if (!id) return null
  return {
    id,
    humanId: str(o.human_id) ?? 'Handover',
    status: o.status === 'disputed' ? 'disputed' : 'pending',
    giverId: str(o.giver_id) ?? '',
    giverName: str(o.giver_name) ?? 'Unknown user',
    recipientId: str(o.recipient_id) ?? '',
    recipientName: str(o.recipient_name) ?? 'Unknown user',
    createdAt: str(o.created_at) ?? '',
  }
}

export function readCashPayment(raw: unknown): CashPayment | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Raw
  const paymentId = str(o.payment_id)
  if (!paymentId || !isState(o.state)) return null
  return {
    paymentId,
    humanPaymentId: str(o.human_payment_id),
    clientName: str(o.client_name),
    amount: num(o.amount),
    paymentMode: str(o.payment_mode) ?? '',
    paymentDate: str(o.payment_date),
    recordedAt: str(o.recorded_at) ?? '',
    tracked: o.tracked === true,
    state: o.state,
    holderId: str(o.holder_id),
    holderName: str(o.holder_name),
    holderSince: str(o.holder_since) ?? '',
    ageHours: num(o.age_hours),
    openHandover: readOpenHandover(o.open_handover),
    canAccept: o.can_accept === true,
    canHandOver: o.can_hand_over === true,
    canReceive: o.can_receive === true,
    orderException: readOrderException(o.order_exception),
  }
}

function readOrderException(raw: unknown): CashPayment['orderException'] {
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Raw
  const reason = str(x.reason)
  return reason ? { reason, byName: str(x.by_name), at: str(x.at) ?? '' } : null
}

export function readCashPayments(raw: unknown): CashPayment[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(r => {
    const p = readCashPayment(r)
    return p ? [p] : []
  })
}

export function readUnclosedFunds(raw: unknown): UnclosedFunds {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Raw
  const scope = o.scope === 'all' || o.scope === 'mine' ? o.scope : 'none'
  const custodians = Array.isArray(o.custodians) ? o.custodians : []
  return {
    scope,
    viewerIsCustodian: o.viewer_is_custodian === true,
    custodians: custodians.flatMap(c => {
      const x = (c ?? {}) as Raw
      const id = str(x.id)
      return id ? [{ id, fullName: str(x.full_name) ?? 'Unknown user' }] : []
    }),
    payments: readCashPayments(o.payments),
  }
}

const STEP_KINDS: readonly JourneyStepKind[] = [
  'recorded', 'collected', 'handed_over', 'received_directly',
  'handover_created', 'handover_accepted', 'handover_disputed', 'handover_cancelled',
]

export function readJourney(raw: unknown): PaymentJourney | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Raw
  const steps = Array.isArray(o.steps) ? o.steps : []
  return {
    payment: readCashPayment(o.payment),
    steps: steps.flatMap((s): JourneyStep[] => {
      const x = (s ?? {}) as Raw
      if (!STEP_KINDS.includes(x.kind as JourneyStepKind)) return []
      return [{
        kind: x.kind as JourneyStepKind,
        at: str(x.at) ?? '',
        actorName: str(x.actor_name),
        toName: str(x.to_name),
        note: str(x.note),
        handoverHumanId: str(x.handover_human_id),
      }]
    }),
  }
}

// ── Words ────────────────────────────────────────────────────────────────────

/** The one phrase for where a payment's money is. */
export function cashStateLabel(p: Pick<CashPayment, 'state' | 'holderName' | 'openHandover'>): string {
  switch (p.state) {
    case 'with_company': return 'With company'
    case 'waiting':      return `Waiting for ${p.openHandover?.recipientName ?? 'the receiver'} to accept`
    case 'disputed':     return `Not received by ${p.openHandover?.recipientName ?? 'the receiver'}`
    case 'with_holder':  return `With ${p.holderName ?? 'someone'}`
  }
}

/** "5 hours", "3 days": how long the money has been where it is. */
export function waitingAge(ageHours: number): string {
  if (!Number.isFinite(ageHours) || ageHours < 1) return 'just now'
  if (ageHours < 24) {
    const h = Math.floor(ageHours)
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  const d = Math.floor(ageHours / 24)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

/** One journey step as a sentence. */
export function journeyStepLabel(s: JourneyStep): string {
  const who = s.actorName ?? 'Someone'
  switch (s.kind) {
    case 'recorded':           return `${who} recorded the payment`
    case 'collected':          return `${who} collected the money`
    case 'handed_over':        return `${who} handed it to ${s.toName ?? 'someone'}`
    case 'received_directly':  return `${s.toName ?? 'The company'} received it directly${s.actorName ? ` from ${s.actorName}` : ''}`
    case 'handover_created':   return `${who} handed it to ${s.toName ?? 'someone'} — waiting for acceptance`
    case 'handover_accepted':  return `${who} accepted it`
    case 'handover_disputed':  return `${who} said it was not received`
    case 'handover_cancelled': return `${who} cancelled the handover`
  }
}

/** Holders and their totals, largest first, for the dashboard card. */
export type HolderTotal = { holderId: string; holderName: string; amount: number; count: number; oldestAgeHours: number }

export function totalsByHolder(payments: readonly CashPayment[]): HolderTotal[] {
  const map = new Map<string, HolderTotal>()
  for (const p of payments) {
    const id = p.holderId ?? 'unknown'
    const t = map.get(id) ?? { holderId: id, holderName: p.holderName ?? 'Unknown user', amount: 0, count: 0, oldestAgeHours: 0 }
    t.amount = Math.round((t.amount + p.amount) * 100) / 100
    t.count += 1
    t.oldestAgeHours = Math.max(t.oldestAgeHours, p.ageHours)
    map.set(id, t)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || a.holderName.localeCompare(b.holderName))
}

export function sumAmounts(payments: readonly Pick<CashPayment, 'amount'>[]): number {
  return payments.reduce((acc, p) => acc + Math.round(p.amount * 100), 0) / 100
}

// ── "Where is this money now?" on the payment forms ──────────────────────────

export type MoneyNow = { choice: 'with_me' } | { choice: 'handed_to'; recipientId: string }

export function moneyNowError(value: MoneyNow, recorderId: string | null): string | null {
  if (value.choice === 'with_me') return null
  if (!value.recipientId) return 'Choose who you handed the money to.'
  if (recorderId && value.recipientId === recorderId) return 'Choose somebody other than yourself.'
  return null
}
