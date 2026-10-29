import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computePaymentPlan,
  formatPaise,
  gstRateOf,
  parsePlanData,
  parseTypedNumber,
  planItemKey,
  plannedLinesPayload,
  type PlanInput,
} from './paymentPlan'

// Two lines worth 10,000 each (20,000 of goods) carrying 4,000 of charges:
// total before GST 24,000, GST 4,320 (18%).
const base: PlanInput = {
  items: [
    { itemSequence: '1', productName: 'Table', quantity: 10, rate: 1000 },
    { itemSequence: '2', productName: 'Chair', quantity: 20, rate: 500 },
  ],
  dispatchedLots: [],
  planned: { '1': 10 },
  totalBeforeGst: 24000,
  gstAmount: 4320,
  piBillingPercent: 50,
  billingPercentOverride: null,
  pendingPercent: 50,
  financeVerified: 0,
  financeAwaiting: 0,
  financePaymentCount: 0,
  financeAccountVerified: 0,
  financeCashVerified: 0,
  financeAccountAwaiting: 0,
  financeCashAwaiting: 0,
  advanceAccountOverride: null,
  advanceCashOverride: 10000,
}

const paise = (rupees: number) => Math.round(rupees * 100)

test('half the goods leave: they carry half the charges, GST on the billed part only, half of the rest', () => {
  const r = computePaymentPlan(base)
  assert.equal(r.ok, true)
  assert.equal(r.dispatchAmountPaise, paise(12000))        // 24,000 x 10,000 / 20,000
  assert.equal(r.gstRate, 0.18)
  assert.equal(r.gstOnDispatchPaise, paise(1080))          // 12,000 x 50% x 18%
  assert.equal(r.pendingBasePaise, paise(12000))
  assert.equal(r.pendingShareAmountPaise, paise(6000))     // 50% of the goods still to come
  assert.equal(r.requiredPaise, paise(19080))
  assert.equal(r.advancePaise, paise(10000))
  assert.equal(r.advanceSource, 'typed')
  assert.equal(r.toCollectPaise, paise(9080))
  assert.equal(r.dispatchSharePercent, 50)
})

test('changing the pending percentage moves only the pending share', () => {
  const at100 = computePaymentPlan({ ...base, pendingPercent: 100 })
  assert.equal(at100.pendingShareAmountPaise, paise(12000))
  assert.equal(at100.requiredPaise, paise(25080))
  const at0 = computePaymentPlan({ ...base, pendingPercent: 0 })
  assert.equal(at0.pendingShareAmountPaise, 0)
  assert.equal(at0.requiredPaise, paise(13080))
  assert.equal(at0.dispatchAmountPaise, paise(12000))
})

test('nothing planned means only the pending share is due and no GST', () => {
  const r = computePaymentPlan({ ...base, planned: {} })
  assert.equal(r.dispatchAmountPaise, 0)
  assert.equal(r.gstOnDispatchPaise, 0)
  assert.equal(r.requiredPaise, paise(12000))               // 50% of all 24,000
})

test('everything dispatched at once is the whole PI total plus GST on the billed part', () => {
  const r = computePaymentPlan({ ...base, planned: { '1': 10, '2': 20 } })
  assert.equal(r.dispatchAmountPaise, paise(24000))
  assert.equal(r.gstOnDispatchPaise, paise(2160))
  assert.equal(r.pendingShareAmountPaise, 0)
  assert.equal(r.requiredPaise, paise(26160))
})

test('earlier dispatches stay at 100% and are never counted twice', () => {
  const withHistory = computePaymentPlan({
    ...base,
    dispatchedLots: [{
      id: 'l1', lotNo: 1, status: 'dispatched', plannedOn: null, dispatchedOn: '2026-10-01',
      lines: [{ itemSequence: '1', quantity: 10 }],
    }],
    planned: { '2': 5 },                                     // 2,500 more goods
  })
  // 12,500 of 20,000 leaves => 15,000 of the 24,000
  assert.equal(withHistory.dispatchAmountPaise, paise(15000))
  assert.equal(withHistory.lines[0].previouslyDispatched, 10)
  assert.equal(withHistory.lines[0].remaining, 0)
  assert.equal(withHistory.lines[1].remaining, 15)
  // the same dispatched total reached in one go gives the same answer
  const oneGo = computePaymentPlan({ ...base, planned: { '1': 10, '2': 5 } })
  assert.equal(withHistory.requiredPaise, oneGo.requiredPaise)
})

test('the billing percentage typed on the plan wins over the PI, and is flagged when neither exists', () => {
  const typed = computePaymentPlan({ ...base, billingPercentOverride: 100 })
  assert.equal(typed.gstOnDispatchPaise, paise(2160))
  const none = computePaymentPlan({ ...base, piBillingPercent: null })
  assert.equal(none.billingMissing, true)
  assert.equal(none.gstOnDispatchPaise, 0)
})

test('the GST rate is the PI\'s own, 18% when it states none', () => {
  assert.equal(gstRateOf(24000, 4320), 0.18)
  assert.equal(gstRateOf(10000, 500), 0.05)
  assert.equal(gstRateOf(null, null), 0.18)
  assert.equal(gstRateOf(24000, null), 0.18)
  const five = computePaymentPlan({ ...base, gstAmount: 1200 })
  assert.equal(five.gstRate, 0.05)
  assert.equal(five.gstOnDispatchPaise, paise(300))
})

test('surplus is negative, and the advance falls back to Finance then to none', () => {
  const surplus = computePaymentPlan({ ...base, advanceCashOverride: 30000 })
  assert.equal(surplus.toCollectPaise, paise(-10920))
  const fromFinance = computePaymentPlan({ ...base, advanceCashOverride: null, financeVerified: 5000, financeCashVerified: 5000, financeAwaiting: 2000, financePaymentCount: 2 })
  assert.equal(fromFinance.advanceSource, 'finance')
  assert.equal(fromFinance.advancePaise, paise(5000))
  assert.equal(fromFinance.financeAwaitingPaise, paise(2000))
  const none = computePaymentPlan({ ...base, advanceCashOverride: null })
  assert.equal(none.advanceSource, 'none')
  assert.equal(none.advancePaise, 0)
  // a typed zero is a real answer, not "use Finance"
  const typedZero = computePaymentPlan({ ...base, advanceCashOverride: 0, financeVerified: 5000, financeCashVerified: 5000 })
  assert.equal(typedZero.advanceSource, 'typed')
  assert.equal(typedZero.advancePaise, 0)
})

test('rounding happens once per figure, half up, to the paisa', () => {
  const r = computePaymentPlan({
    items: [{ itemSequence: 'a', productName: null, quantity: 3, rate: 33.33 }, { itemSequence: 'b', productName: null, quantity: 1, rate: 0.01 }],
    dispatchedLots: [], planned: { a: 1 },
    totalBeforeGst: 100, gstAmount: 18, piBillingPercent: 100, billingPercentOverride: null,
    pendingPercent: 50, financeVerified: 0, financeAwaiting: 0, financePaymentCount: 0, financeAccountVerified: 0, financeCashVerified: 0, financeAccountAwaiting: 0, financeCashAwaiting: 0, advanceAccountOverride: null, advanceCashOverride: 0,
  })
  // 33.33 of 100.00 goods => 33.33% of 100.00 = 33.33
  assert.equal(r.dispatchAmountPaise, 3333)
  assert.equal(r.gstOnDispatchPaise, 600)                    // 33.33 x 18% = 5.9994 -> 6.00
  assert.equal(r.pendingBasePaise, 6667)
  assert.equal(r.pendingShareAmountPaise, 3334)              // 33.335 -> 33.34
})

test('problems are named instead of guessed over', () => {
  assert.deepEqual(computePaymentPlan({ ...base, totalBeforeGst: null }).problems, ['NO_TOTAL'])
  assert.equal(computePaymentPlan({ ...base, totalBeforeGst: null }).ok, false)
  assert.ok(computePaymentPlan({ ...base, planned: { '1': 11 } }).problems.includes('OVER_DISPATCHED'))
  // an over-dispatch never pushes the dispatched share past the whole PI
  assert.equal(computePaymentPlan({ ...base, planned: { '1': 11, '2': 20 } }).dispatchAmountPaise <= paise(24000), true)
  assert.deepEqual(computePaymentPlan({ ...base, items: [], planned: {} }).problems.sort(), ['NO_ITEMS'])
})

test('typed numbers: blank is nothing, junk is NaN, three decimals are refused', () => {
  assert.equal(parseTypedNumber(''), null)
  assert.equal(parseTypedNumber(' 1,25,000.50 '), 125000.5)
  assert.ok(Number.isNaN(parseTypedNumber('12.345')))
  assert.ok(Number.isNaN(parseTypedNumber('abc')))
  assert.ok(Number.isNaN(parseTypedNumber('-5')))
})

test('only quantities above zero go to the database', () => {
  assert.deepEqual(plannedLinesPayload({ '1': 4, '2': 0, '3': Number.NaN }), [{ item_sequence: '1', quantity: 4 }])
})

test('rupees are grouped the Indian way and negatives keep their sign', () => {
  assert.equal(formatPaise(12345678), '₹1,23,456.78')
  assert.equal(formatPaise(-5), '-₹0.05')
  assert.equal(formatPaise(0), '₹0.00')
})

test('the database answer is read into plan data, and a missing PI reads as null', () => {
  assert.equal(parsePlanData({ found: false }), null)
  assert.equal(parsePlanData({ found: true, has_pi: false }), null)
  const data = parsePlanData({
    found: true, has_pi: true,
    order: { id: 'o1', display_number: '0539', status: 'running', total_value: 28320, client_name: 'Acme' },
    pi: { total_before_gst: '24000.00', gst_amount: '4320.00', grand_total: '28320.00', billing_percentage: '50.00' },
    items: [{ item_sequence: '1', product_name: 'Table', quantity: '10.00', rate: '1000.00' }],
    plan: { pending_percent: '60.00', billing_percent: null, advance_account_override: '1500.00', advance_cash_override: null, note: 'n' },
    lots: [{ id: 'l1', lot_no: 1, status: 'planned', planned_on: null, dispatched_on: null, lines: [{ item_sequence: '1', quantity: '4.00' }] }],
    finance: { verified: '100.00', awaiting: '0', payment_count: 1 },
  })
  assert.ok(data)
  assert.equal(data.pendingPercent, 60)
  assert.equal(data.advanceAccountOverride, 1500)
  assert.equal(data.advanceCashOverride, null)
  assert.equal(data.piBillingPercent, 50)
  assert.equal(data.piDiffersFromOrder, false)
  assert.equal(data.lots[0].lines[0].quantity, 4)
  assert.equal(data.displayNumber, '0539')
})

test('a PI line is keyed by its item sequence, or its row id when it has none (as the database does)', () => {
  assert.equal(planItemKey(' 3 ', 'id-1'), '3')
  assert.equal(planItemKey('', 'id-1'), 'id-1')
  assert.equal(planItemKey(null, 'id-2'), 'id-2')
})

// ── Account and cash (owner, 2026-10-29) ──
// base: dispatch 12,000 + pending 6,000, billing 50%, GST 1,080.
const split = (over: Partial<PlanInput>) => computePaymentPlan({ ...base, advanceCashOverride: null, ...over }).split

test('the billed part and all GST are due in account; the rest is cash', () => {
  const s = split({})
  assert.deepEqual(s.dispatch, { account: paise(6000), cash: paise(6000), total: paise(12000) })
  assert.deepEqual(s.pending, { account: paise(3000), cash: paise(3000), total: paise(6000) })
  assert.deepEqual(s.gst, { account: paise(1080), cash: 0, total: paise(1080) })
  assert.deepEqual(s.due, { account: paise(10080), cash: paise(9000), total: paise(19080) })
})

test('confirmed payments are split by where they were paid, and each side is settled on its own', () => {
  const s = split({ financeVerified: 12000, financeAccountVerified: 4000, financeCashVerified: 8000 })
  assert.deepEqual(s.received, { account: paise(4000), cash: paise(8000), total: paise(12000) })
  assert.deepEqual(s.receivedSource, { account: 'finance', cash: 'finance' })
  assert.deepEqual(s.balance, { account: paise(6080), cash: paise(1000), total: paise(7080) })
})

test('a typed figure replaces only its own side', () => {
  const s = split({ financeAccountVerified: 4000, financeCashVerified: 8000, advanceCashOverride: 2000 })
  assert.equal(s.received.account, paise(4000))
  assert.equal(s.received.cash, paise(2000))
  assert.deepEqual(s.receivedSource, { account: 'finance', cash: 'typed' })
})

test('extra paid in account is billed: its goods value comes off the cash balance, the rest is GST', () => {
  // account due 10,080; paid 21,880 => 11,800 extra = 10,000 goods + 1,800 GST at 18%
  const r = computePaymentPlan({ ...base, advanceCashOverride: null, advanceAccountOverride: 21880 })
  const s = r.split
  assert.deepEqual(s.movedFromAccount, { excessPaise: paise(11800), goodsPaise: paise(10000), gstPaise: paise(1800) })
  assert.equal(s.balance.account, 0)
  assert.equal(s.balance.cash, paise(-1000))                      // 9,000 cash due - 10,000 moved
  assert.equal(r.toCollectPaise, paise(-1000))
})

test('extra cash never moves to the account side', () => {
  const s = split({ advanceCashOverride: 20000 })
  assert.equal(s.balance.account, paise(10080))
  assert.equal(s.balance.cash, paise(-11000))
  assert.equal(s.movedFromAccount.excessPaise, 0)
})

test('with no billing percentage everything is cash and there is no GST', () => {
  const s = split({ piBillingPercent: null })
  assert.equal(s.due.account, 0)
  assert.equal(s.due.cash, paise(18000))
})

// ── Fabric and packing per product (owner, 2026-10-29, "Req-0169") ──
// Sofa: 1 @ 2,85,000, packing 8,000, fabric 45 m @ 550. Chair: 110 @ 4,200, packing 200, 1.25 m @ 550.
// PI total = items 7,47,000 + packing 30,000 + fabric 1,00,375 + transport 10,000 - discount 37,350 = 8,50,025.
const sheet: PlanInput = {
  ...base,
  items: [
    { itemSequence: 'S', productName: 'Sofa', quantity: 1, rate: 285000, packingRate: 8000, fabricMetresPerPiece: 45, fabricRate: 550 },
    { itemSequence: 'C', productName: 'Chair', quantity: 110, rate: 4200, packingRate: 200, fabricMetresPerPiece: 1.25, fabricRate: 550 },
  ],
  totalBeforeGst: 850025, gstAmount: 153004.5, discount: 37350, piBillingPercent: 30,
  planned: {}, advanceCashOverride: null,
}

test('a lot carries its own packing and fabric, and a share of transport and discount by item value', () => {
  const r = computePaymentPlan({ ...sheet, planned: { S: 1 } })
  assert.equal(r.lot.items, paise(285000))
  assert.equal(r.lot.packing, paise(8000))
  assert.equal(r.lot.fabric, paise(24750))
  // item share 2,85,000 / 7,47,000 of transport 10,000 and of discount 37,350
  assert.equal(r.lot.otherShare, Math.round(10000 * 285000 / 747000 * 100))
  assert.equal(r.lot.discountShare, -Math.round(37350 * 285000 / 747000 * 100))
  assert.equal(r.lot.value, r.lot.items + r.lot.packing + r.lot.fabric + r.lot.otherShare + r.lot.discountShare)
  assert.equal(r.dispatchAmountPaise, r.lot.value)
  const sofa = r.lines.find(l => l.itemSequence === 'S')!
  assert.deepEqual([sofa.plannedPackingPaise, sofa.plannedFabricMetres, sofa.plannedFabricPaise, sofa.plannedLineTotalPaise],
    [paise(8000), 45, paise(24750), paise(317750)])
})

test('billing, GST and cash are worked out on the lot value', () => {
  const r = computePaymentPlan({ ...sheet, planned: { C: 110 } })
  assert.equal(r.lot.fabric, paise(75625))
  assert.equal(r.lot.billed, Math.round(r.lot.value * 0.3))
  assert.equal(r.lot.gst, Math.round(r.lot.billed * 0.18))
  assert.equal(r.lot.cash, r.lot.value - r.lot.billed)
})

test('everything sent adds up to the whole PI, however it is split into lots', () => {
  const all = computePaymentPlan({ ...sheet, planned: { S: 1, C: 110 } })
  assert.equal(all.dispatchAmountPaise, paise(850025))
  assert.equal(all.pendingValuePaise, 0)
  const twoLots = computePaymentPlan({
    ...sheet,
    dispatchedLots: [{ id: 'l1', lotNo: 1, status: 'dispatched', plannedOn: null, dispatchedOn: '2026-10-20', lines: [{ itemSequence: 'C', quantity: 60 }] }],
    planned: { S: 1, C: 50 },
  })
  assert.equal(twoLots.earlier.value + twoLots.lot.value, paise(850025))
  assert.equal(twoLots.dispatchAmountPaise, paise(850025))
})

test('goods still to come carry their own packing and fabric too', () => {
  const r = computePaymentPlan({ ...sheet, planned: { S: 1 } })
  const chairsValue = 110 * 4200 + 110 * 200 + 110 * 1.25 * 550 + (10000 - 37350) * (110 * 4200) / 747000
  assert.ok(Math.abs(r.pendingValuePaise - Math.round(chairsValue * 100)) <= 1)
})
