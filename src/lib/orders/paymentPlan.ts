// ── The Payment plan: how much more the client must pay before a dispatch ─────
//
// ONE PURE FUNCTION decides every figure on the sheet; the screen, the Excel
// and the PDF all draw its result, so they cannot disagree. The database
// (20270428000000) stores only the inputs: lots, the percentages, a typed
// advance. Nothing here reads or writes anything.
//
// THE RULE (owner, 2026-10-28)
//   T  total before GST (goods - discount + fabric + packing + transport):
//      every charge travels with the goods, in proportion to their value.
//   Dc value of everything dispatched to date plus the planned lot, at rate.
//   G  value of every ordered line, at rate.
//   A  = T x Dc / G                      dispatched goods + their charges, in full
//   GST = A x billing% x GST rate        GST on the BILLED part of what leaves
//   P  = (T - A) x pending%              goods still to come, charges included,
//                                        no GST
//   required         = A + GST + P
//   still to collect = required - advance received  (negative = surplus)
//
// MONEY IS INTEGER PAISE. Quantity (2 dp) x rate (2 dp) is held in units of
// 1/10,000 rupee, so a line value is exact; only the money figures are rounded,
// half up, to the paisa, each once.

export type PlanItem = {
  itemSequence: string
  productName: string | null
  quantity: number
  rate: number
}

export type PlanLot = {
  id: string
  lotNo: number
  status: 'planned' | 'dispatched'
  plannedOn: string | null
  dispatchedOn: string | null
  lines: { itemSequence: string; quantity: number }[]
}

export type PlanInput = {
  items: readonly PlanItem[]
  /** Lots already dispatched, in order. */
  dispatchedLots: readonly PlanLot[]
  /** The planned lot, as being edited: quantity per itemSequence (blank/0 = none). */
  planned: Readonly<Record<string, number>>
  totalBeforeGst: number | null
  gstAmount: number | null
  /** The PI's own billing percentage, or null when it declares none. */
  piBillingPercent: number | null
  /** The plan's own billing percentage, which wins when set. */
  billingPercentOverride: number | null
  pendingPercent: number
  /** Money Finance holds against the Order, as totals only. */
  financeVerified: number
  financeAwaiting: number
  financePaymentCount: number
  /** A typed advance; null = use Finance's verified figure. */
  advanceOverride: number | null
}

export type PlanLineResult = {
  itemSequence: string
  productName: string | null
  rate: number
  ordered: number
  previouslyDispatched: number
  planned: number
  remaining: number
  /** Value of the goods at rate, in paise. */
  orderedPaise: number
  dispatchedBeforePaise: number
  plannedPaise: number
  remainingPaise: number
}

export type PlanProblem =
  | 'NO_TOTAL'            // the PI has no total before GST
  | 'NO_ITEMS'            // the PI has no lines
  | 'OVER_DISPATCHED'     // some line has more dispatched + planned than ordered
  | 'UNKNOWN_LINE'        // a lot names a line the PI no longer has

export type PlanResult = {
  ok: boolean
  problems: PlanProblem[]
  lines: PlanLineResult[]
  /** Totals in paise. */
  orderedValuePaise: number
  dispatchedBeforePaise: number
  plannedPaise: number
  remainingPaise: number
  totalBeforeGstPaise: number | null
  /** Dispatched to date + planned, with their share of every charge. */
  dispatchAmountPaise: number
  billingPercent: number | null
  billingMissing: boolean
  gstRate: number
  gstOnDispatchPaise: number
  pendingPercent: number
  /** The part of the PI still to come, charges included, before the percentage. */
  pendingBasePaise: number
  pendingShareAmountPaise: number
  requiredPaise: number
  advancePaise: number
  advanceSource: 'typed' | 'finance' | 'none'
  financeVerifiedPaise: number
  financeAwaitingPaise: number
  financePaymentCount: number
  /** Signed: positive = still to collect, negative = surplus. */
  toCollectPaise: number
  /** Fraction of the goods leaving (dispatched to date + planned), basis points of a percent. */
  dispatchSharePercent: number
}

export const DEFAULT_PENDING_PERCENT = 50
export const DEFAULT_GST_RATE = 0.18

const BIG = BigInt

/** A decimal as an integer count of `scale`; throws never, NaN -> 0. */
function scaled(value: number | null | undefined, scale: number): bigint {
  if (value === null || value === undefined || !Number.isFinite(value)) return BIG(0)
  return BIG(Math.round(value * scale))
}

/** n / d rounded half up, for d > 0 and n >= 0. */
function divRound(n: bigint, d: bigint): bigint {
  if (d <= BIG(0)) return BIG(0)
  return (n * BIG(2) + d) / (d * BIG(2))
}

const toNumber = (v: bigint) => Number(v)

/** The GST rate the PI itself carries: its GST amount over its total, 18% when it states none. */
export function gstRateOf(totalBeforeGst: number | null, gstAmount: number | null): number {
  if (totalBeforeGst && totalBeforeGst > 0 && gstAmount !== null && gstAmount >= 0) {
    return Math.round((gstAmount / totalBeforeGst) * 10000) / 10000
  }
  return DEFAULT_GST_RATE
}

export function effectiveBillingPercent(piPercent: number | null, override: number | null): number | null {
  return override ?? piPercent ?? null
}

/** Quantity already in dispatched lots, per line. */
export function dispatchedQuantities(lots: readonly PlanLot[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const lot of lots) {
    if (lot.status !== 'dispatched') continue
    for (const l of lot.lines) {
      out.set(l.itemSequence, Math.round(((out.get(l.itemSequence) ?? 0) + l.quantity) * 100) / 100)
    }
  }
  return out
}

export function computePaymentPlan(input: PlanInput): PlanResult {
  const problems: PlanProblem[] = []
  const before = dispatchedQuantities(input.dispatchedLots)
  const known = new Set(input.items.map(i => i.itemSequence))
  for (const seq of before.keys()) if (!known.has(seq)) problems.push('UNKNOWN_LINE')

  let orderedV = BIG(0)   // units of 1/10,000 rupee
  let beforeV = BIG(0)
  let plannedV = BIG(0)

  const lines: PlanLineResult[] = input.items.map(item => {
    const prev = before.get(item.itemSequence) ?? 0
    const plan = Math.max(0, input.planned[item.itemSequence] ?? 0)
    const remaining = Math.round((item.quantity - prev - plan) * 100) / 100
    if (remaining < 0) problems.push('OVER_DISPATCHED')

    const rate = scaled(item.rate, 100)
    const value = (q: number) => scaled(q, 100) * rate           // 1/10,000 rupee
    const o = value(item.quantity)
    const b = value(prev)
    const p = value(plan)
    orderedV += o
    beforeV += b
    plannedV += p
    const rest = o - b - p
    const paise = (v: bigint) => toNumber(divRound(v < BIG(0) ? BIG(0) : v, BIG(100)))
    return {
      itemSequence: item.itemSequence,
      productName: item.productName,
      rate: item.rate,
      ordered: item.quantity,
      previouslyDispatched: prev,
      planned: plan,
      remaining,
      orderedPaise: paise(o),
      dispatchedBeforePaise: paise(b),
      plannedPaise: paise(p),
      remainingPaise: paise(rest),
    }
  })

  if (input.items.length === 0) problems.push('NO_ITEMS')
  const noTotal = input.totalBeforeGst === null || !(input.totalBeforeGst > 0)
  if (noTotal) problems.push('NO_TOTAL')

  const billing = effectiveBillingPercent(input.piBillingPercent, input.billingPercentOverride)
  const gstRate = gstRateOf(input.totalBeforeGst, input.gstAmount)
  const pending = input.pendingPercent

  const T = noTotal ? BIG(0) : scaled(input.totalBeforeGst, 100)               // paise
  const dispatchedV = beforeV + plannedV
  // A line can never make the dispatched share more than the whole.
  const cappedV = dispatchedV > orderedV ? orderedV : dispatchedV
  const A = orderedV > BIG(0) ? divRound(T * cappedV, orderedV) : BIG(0)       // paise
  const gstP = billing === null
    ? BIG(0)
    : divRound(A * scaled(billing, 100) * scaled(gstRate, 10000), BIG(100000000))
  const pendBase = T - A
  const pendShare = divRound(pendBase * scaled(pending, 100), BIG(10000))
  const required = A + gstP + pendShare

  const typed = input.advanceOverride !== null
  const advanceSource: PlanResult['advanceSource'] =
    typed ? 'typed' : input.financeVerified > 0 ? 'finance' : 'none'
  const advance = typed ? scaled(input.advanceOverride, 100) : scaled(input.financeVerified, 100)

  const share = orderedV > BIG(0)
    ? Number(divRound(cappedV * BIG(10000), orderedV)) / 100
    : 0

  const paiseOf = (v: bigint) => toNumber(divRound(v, BIG(100)))
  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    lines,
    orderedValuePaise: paiseOf(orderedV),
    dispatchedBeforePaise: paiseOf(beforeV),
    plannedPaise: paiseOf(plannedV),
    remainingPaise: paiseOf(orderedV - beforeV - plannedV < BIG(0) ? BIG(0) : orderedV - beforeV - plannedV),
    totalBeforeGstPaise: noTotal ? null : toNumber(T),
    dispatchAmountPaise: toNumber(A),
    billingPercent: billing,
    billingMissing: billing === null,
    gstRate,
    gstOnDispatchPaise: toNumber(gstP),
    pendingPercent: pending,
    pendingBasePaise: toNumber(pendBase),
    pendingShareAmountPaise: toNumber(pendShare),
    requiredPaise: toNumber(required),
    advancePaise: toNumber(advance),
    advanceSource,
    financeVerifiedPaise: toNumber(scaled(input.financeVerified, 100)),
    financeAwaitingPaise: toNumber(scaled(input.financeAwaiting, 100)),
    financePaymentCount: input.financePaymentCount,
    toCollectPaise: toNumber(required - advance),
    dispatchSharePercent: share,
  }
}

// ── Reading what the database returns ─────────────────────────────────────────

export type PlanData = {
  orderId: string
  displayNumber: string
  clientName: string | null
  orderStatus: string | null
  items: PlanItem[]
  lots: PlanLot[]
  totalBeforeGst: number | null
  gstAmount: number | null
  grandTotal: number | null
  piBillingPercent: number | null
  /** Set when the Order's value no longer equals the PI's grand total (an amendment). */
  piDiffersFromOrder: boolean
  pendingPercent: number
  billingPercentOverride: number | null
  advanceOverride: number | null
  note: string | null
  financeVerified: number
  financeAwaiting: number
  financePaymentCount: number
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Turns the order_payment_plan_read answer into PlanData; null when there is no PI to plan against. */
export function parsePlanData(raw: unknown): PlanData | null {
  const r = obj(raw)
  if (r.found !== true || r.has_pi !== true) return null
  const order = obj(r.order)
  const pi = obj(r.pi)
  const plan = obj(r.plan)
  const fin = obj(r.finance)
  const grand = num(pi.grand_total)
  const orderValue = num(order.total_value)
  return {
    orderId: String(order.id ?? ''),
    displayNumber: String(order.display_number ?? ''),
    clientName: order.client_name === null || order.client_name === undefined ? null : String(order.client_name),
    orderStatus: order.status === null || order.status === undefined ? null : String(order.status),
    items: arr(r.items).map(x => {
      const i = obj(x)
      return {
        itemSequence: String(i.item_sequence ?? ''),
        productName: i.product_name === null || i.product_name === undefined ? null : String(i.product_name),
        quantity: num(i.quantity) ?? 0,
        rate: num(i.rate) ?? 0,
      }
    }),
    lots: arr(r.lots).map(x => {
      const l = obj(x)
      return {
        id: String(l.id ?? ''),
        lotNo: num(l.lot_no) ?? 0,
        status: l.status === 'dispatched' ? 'dispatched' : 'planned',
        plannedOn: l.planned_on === null || l.planned_on === undefined ? null : String(l.planned_on),
        dispatchedOn: l.dispatched_on === null || l.dispatched_on === undefined ? null : String(l.dispatched_on),
        lines: arr(l.lines).map(y => {
          const q = obj(y)
          return { itemSequence: String(q.item_sequence ?? ''), quantity: num(q.quantity) ?? 0 }
        }),
      } satisfies PlanLot
    }),
    totalBeforeGst: num(pi.total_before_gst),
    gstAmount: num(pi.gst_amount),
    grandTotal: grand,
    piBillingPercent: num(pi.billing_percentage),
    piDiffersFromOrder: grand !== null && orderValue !== null && Math.abs(grand - orderValue) > 0.005,
    pendingPercent: num(plan.pending_percent) ?? DEFAULT_PENDING_PERCENT,
    billingPercentOverride: num(plan.billing_percent),
    advanceOverride: num(plan.advance_override),
    note: plan.note === null || plan.note === undefined ? null : String(plan.note),
    financeVerified: num(fin.verified) ?? 0,
    financeAwaiting: num(fin.awaiting) ?? 0,
    financePaymentCount: num(fin.payment_count) ?? 0,
  }
}

/** A PI line's key in the plan: its item_sequence, or its row id when it has none (as order_payment_plan_read does). */
export function planItemKey(itemSequence: string | null | undefined, itemId: string): string {
  const s = (itemSequence ?? '').trim()
  return s === '' ? itemId : s
}

/** The planned lot's quantities as the editor holds them. */
export function plannedQuantities(lots: readonly PlanLot[]): Record<string, number> {
  const out: Record<string, number> = {}
  const planned = lots.find(l => l.status === 'planned')
  if (planned) for (const l of planned.lines) out[l.itemSequence] = l.quantity
  return out
}

export function plannedLotOf(lots: readonly PlanLot[]): PlanLot | null {
  return lots.find(l => l.status === 'planned') ?? null
}

export function inputFromData(
  data: PlanData,
  edit: {
    planned: Record<string, number>
    pendingPercent: number
    billingPercentOverride: number | null
    advanceOverride: number | null
  },
): PlanInput {
  return {
    items: data.items,
    dispatchedLots: data.lots.filter(l => l.status === 'dispatched'),
    planned: edit.planned,
    totalBeforeGst: data.totalBeforeGst,
    gstAmount: data.gstAmount,
    piBillingPercent: data.piBillingPercent,
    billingPercentOverride: edit.billingPercentOverride,
    pendingPercent: edit.pendingPercent,
    financeVerified: data.financeVerified,
    financeAwaiting: data.financeAwaiting,
    financePaymentCount: data.financePaymentCount,
    advanceOverride: edit.advanceOverride,
  }
}

/** Lines as the save function takes them: only quantities above zero. */
export function plannedLinesPayload(planned: Readonly<Record<string, number>>): { item_sequence: string; quantity: number }[] {
  return Object.entries(planned)
    .filter(([, q]) => Number.isFinite(q) && q > 0)
    .map(([item_sequence, quantity]) => ({ item_sequence, quantity }))
}

/** Reads a quantity or percentage a person typed. Blank = null; anything else that is not a number = NaN. */
export function parseTypedNumber(text: string): number | null {
  const cleaned = text.replace(/[\s,₹]/g, '')
  if (cleaned === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN
  return Number(cleaned)
}

// ── Display ───────────────────────────────────────────────────────────────────

/** Paise as rupees with two decimals and Indian digit grouping; negative keeps its sign. */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const rupees = Math.trunc(abs / 100)
  const p = String(abs % 100).padStart(2, '0')
  return `${sign}₹${rupees.toLocaleString('en-IN')}.${p}`
}

export const rupees = (paise: number): number => paise / 100

export const PLAN_PROBLEM_TEXT: Record<PlanProblem, string> = {
  NO_TOTAL: 'This PI has no total before GST, so the amounts cannot be worked out.',
  NO_ITEMS: 'This PI has no product lines.',
  OVER_DISPATCHED: 'A line has more dispatched and planned than was ordered. Check the quantities.',
  UNKNOWN_LINE: 'An earlier lot names a line that is no longer on the PI.',
}
