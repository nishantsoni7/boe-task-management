import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { computePaymentPlan, inputFromData, parsePlanData } from './paymentPlan'
import { BANK_CASH_NOTE, BILLING_MISSING_NOTE, buildPaymentPlanSheet } from './paymentPlanSheet'
import {
  ADVANCE_HELP, AMOUNT_PROBLEM, PERCENT_PROBLEM, balanceText, billingHelp, lineRatesText, lotPiecesText,
  lotQuantityProblem, moneyText, receivedHelp,
} from './paymentPlanScreen'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const UI = 'src/app/orders/[id]/OrderPaymentPlan.tsx'

// ── The words themselves ──

test('money and balances read in whole rupees; a balance below zero says "paid extra"', () => {
  assert.equal(moneyText(29369300), '₹2,93,693')
  assert.equal(moneyText(-50000), '−₹500')
  assert.equal(balanceText(29369300), '₹2,93,693')
  assert.equal(balanceText(-10000000), '₹1,00,000 paid extra')
})

test('the rates line names price, packing and fabric only when the line has them', () => {
  assert.equal(lineRatesText({ rate: 5650, packingRate: 550, fabricMetresPerPiece: 0.45, fabricRate: 750 }),
    '₹5,650 / pc · packing ₹550 · fabric 0.45 m × ₹750')
  assert.equal(lineRatesText({ rate: 12600, packingRate: 480, fabricMetresPerPiece: 0, fabricRate: null }),
    '₹12,600 / pc · packing ₹480')
  assert.equal(lineRatesText({ rate: 8700, packingRate: null, fabricMetresPerPiece: null, fabricRate: null }), '₹8,700 / pc')
  assert.equal(lineRatesText({ rate: 19600, packingRate: 0, fabricMetresPerPiece: 5, fabricRate: null }),
    '₹19,600 / pc · fabric 5 m, no rate')
})

test('a wrong "This lot" quantity says what is left to send, never just turns red', () => {
  const line = { ordered: 2, previouslyDispatched: 0, planned: 3, remaining: -1 }
  assert.equal(lotQuantityProblem(line, false), 'Only 2 left to send. Lower it to 2 or less.')
  assert.equal(lotQuantityProblem({ ordered: 10, previouslyDispatched: 6, planned: 5, remaining: -1 }, false),
    'Only 4 left to send. Lower it to 4 or less.')
  assert.equal(lotQuantityProblem({ ordered: 2, previouslyDispatched: 2, planned: 1, remaining: -1 }, false),
    'Nothing is left to send on this line.')
  assert.equal(lotQuantityProblem({ ordered: 2, previouslyDispatched: 0, planned: 2, remaining: 0 }, false), null)
  assert.equal(lotQuantityProblem({ ordered: 2, previouslyDispatched: 0, planned: 0, remaining: 2 }, true),
    'Type a number, with at most two decimals.')
  // an empty box on a line over-sent EARLIER is the plan-wide warning's job, not this box's
  assert.equal(lotQuantityProblem({ ordered: 2, previouslyDispatched: 3, planned: 0, remaining: -1 }, false), null)
})

test('the lot counts its pieces against everything not yet sent', () => {
  assert.equal(lotPiecesText([
    { ordered: 30, previouslyDispatched: 0, planned: 0 },
    { ordered: 13, previouslyDispatched: 3, planned: 4 },
    { ordered: 2, previouslyDispatched: 5, planned: 0 },
  ]), '4 of 40 pieces planned')
})

test('help under each Plan settings box says what a blank box uses', () => {
  assert.equal(billingHelp(null), 'The PI has none. Leave blank to count everything as cash.')
  assert.equal(billingHelp(50), "Leave blank to use the PI's 50%.")
  assert.equal(receivedHelp(100000), 'Leave blank to use confirmed payments: ₹1,00,000')
  assert.equal(receivedHelp(0), 'Leave blank to use confirmed payments: ₹0')
})

// ── The screen draws them (layout B, owner 2026-10-30) ──

test('the screen leads with the sum and reads it from the same rows as the Excel and PDF', () => {
  const ui = read(UI)
  assert.match(ui, /sheet\.payColumns\.map\(/)
  assert.match(ui, /const \[bankRow, cashRow\] = sheet\.payRows/)
  assert.match(ui, /Balance to pay now/)
  // the sum comes before the settings, the goods and the folded working
  const at = (s: string) => ui.indexOf(s)
  assert.ok(at('opp-total') < at('opp-settings') && at('opp-settings') < at('Goods in this lot')
    && at('Goods in this lot') < at('<details className="opp-fold">'), 'answer first, working last')
  // the old bottom "To pay" table is gone from the screen
  assert.doesNotMatch(ui, /opp-pay-table/)
})

test('every Plan settings box has a visible label and help that stays, and the advance % box is back', () => {
  const ui = read(UI)
  assert.doesNotMatch(ui, /placeholder="Blank = use confirmed payments"/, 'the meaning of a blank box is not a placeholder')
  assert.match(ui, /label="Advance on goods still to come \(%\)" help=\{ADVANCE_HELP\}/)
  assert.match(ui, /value=\{edit\.pending\} onChange=\{v => set\(\{ pending: v \}\)\}/)
  assert.match(ui, /help=\{receivedHelp\(data\.financeAccountVerified\)\}/)
  assert.match(ui, /help=\{receivedHelp\(data\.financeCashVerified\)\}/)
  assert.match(ui, /<label htmlFor=\{id\}/)
  assert.ok(ADVANCE_HELP.length > 0 && PERCENT_PROBLEM.length > 0 && AMOUNT_PROBLEM.length > 0)
})

test('problems are words next to the box, and the download buttons say why they are off', () => {
  const ui = read(UI)
  assert.match(ui, /lotQuantityProblem\(l, /)
  assert.match(ui, /aria-describedby=\{issue \? issueId : undefined\}/)
  assert.match(ui, /Save first to download/)
  assert.doesNotMatch(ui, /title=\{dirty \? 'Save your changes first'/, 'no reason that shows only on mouse hover')
  assert.match(ui, /The PI has no billing %\./)
})

test('Save sits in the bar at the end of the plan, which says whether anything is unsaved', () => {
  const ui = read(UI)
  const bar = ui.indexOf('className="opp-bar"')
  assert.ok(bar > ui.indexOf('Dispatched lots'), 'the bar is the last thing in the plan')
  assert.match(ui.slice(bar), /Unsaved changes/)
  assert.match(ui.slice(bar), /Save plan/)
  const css = read('src/app/globals.css')
  assert.match(css, /\.opp-bar \{ position: sticky; bottom: 0;/)
  // the old round-badge rule shared this name and drew the "Mark as dispatched" row as a pill
  assert.equal((css.match(/^\.opp-mark \{/gm) ?? []).length, 1)
})

test('the screen shows each note once: bank and cash under the working, missing billing as the warning', () => {
  const data = parsePlanData({
    found: true, has_pi: true,
    order: { id: 'o1', display_number: '541', status: 'running', total_value: '100.00', client_name: 'Antera Restro' },
    pi: { total_before_gst: '100.00', gst_amount: '0', grand_total: '100.00', billing_percentage: null },
    items: [{ item_sequence: '1', product_name: 'Chair', quantity: '1.00', rate: '100.00' }],
    plan: null, lots: [],
    finance: { verified: '0', awaiting: '0', payment_count: 0, account_verified: '0', cash_verified: '0', account_awaiting: '0', cash_awaiting: '0' },
  })!
  const result = computePaymentPlan(inputFromData(data, {
    planned: {}, pendingPercent: data.pendingPercent, billingPercentOverride: null, advanceAccountOverride: null, advanceCashOverride: null,
  }))
  const sheet = buildPaymentPlanSheet(data, result, { lotLines: {}, generatedOn: '30-10-2026', plannedOn: null })
  assert.equal(result.billingMissing, true)
  assert.deepEqual(sheet.notes.slice(0, 2), [BANK_CASH_NOTE, BILLING_MISSING_NOTE], 'Excel and PDF keep both notes')
  assert.match(read(UI), /sheet\.notes\.filter\(n => n !== BANK_CASH_NOTE && n !== BILLING_MISSING_NOTE\)/)
})
