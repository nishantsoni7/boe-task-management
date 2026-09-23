/**
 * TWO DOORS THIS BRANCH MOVED, AND THE ONE IT MUST NOT HAVE LEFT OPEN.
 *
 *   THE FINANCE SWITCH. The Confirmed Order answers its own money questions, so
 *   it does not offer the shell's Switch to Finance. Every other Orders screen
 *   still does. Exactly one control, drawn behind exactly one condition — a
 *   second, unconditional render would give every other screen two buttons and
 *   give this one a switch it asked not to have.
 *
 *   THE PAYMENT DETAIL. A payment's amount on an Order is the Order's own fact.
 *   What FINANCE wrote about that payment — the proof note, the clarification it
 *   asked for, where the money landed, who signed it off — was reachable only
 *   through a control gated on Finance module entry. When the control became a
 *   dialog on this page, the gate had to come with it. ROW-LEVEL DATABASE ACCESS
 *   IS NOT THAT GATE: a reader may legitimately be allowed the payment row and
 *   still have no business reading Finance's working.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderFinanceSwitchAndDetailGate.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  orderPaymentDetailQuery,
  type OrderPaymentListRow,
} from '@/lib/orders/orderPaymentLists'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** A source file with its prose removed: these are about what RENDERS. */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

const LAYOUT = 'src/components/layout/OrdersLayout.tsx'
const PAGE = 'src/app/orders/[id]/page.tsx'
const WORKSPACE = 'src/app/orders/[id]/OrderWorkspace.tsx'

// ══ 1. The Finance switch ═════════════════════════════════════════════════════

describe('the Orders shell draws the Finance switch once, behind one condition', () => {
  const layout = code(LAYOUT)

  test('there is EXACTLY ONE render of it in the layout', () => {
    // The count is the point. An unconditional render left beside the gated one
    // would put two switches on every other Orders screen and leave one on the
    // screen that opted out — which is precisely what a careless edit produces.
    assert.equal((layout.match(/<ModuleSwitchButton\s+target="finance"/g) ?? []).length, 1)
  })

  test('and that one render is GATED, never bare', () => {
    assert.ok(layout.includes('{showModuleSwitch && <ModuleSwitchButton target="finance" />}'))
    // No bare render anywhere: every occurrence is the gated form above.
    const bare = layout
      .split('{showModuleSwitch && <ModuleSwitchButton target="finance" />}').join('')
    assert.equal(/<ModuleSwitchButton\s+target="finance"/.test(bare), false,
      'a second, ungated render of the Finance switch is present')
  })

  test('the default is ON, so every other Orders screen is unaffected', () => {
    assert.ok(layout.includes('showModuleSwitch = true'))
    assert.ok(read(LAYOUT).includes('showModuleSwitch?: boolean'))
  })

  test('the Confirmed Order is the ONE screen that turns it off', () => {
    assert.ok(code(PAGE).includes('showModuleSwitch={false}'))
    // Nothing else in the repository opts out, and no screen renders the
    // button for itself — so no Orders screen can show two.
    const optOuts = []
    for (const path of ['src/app/orders/page.tsx', 'src/app/orders/all/page.tsx',
                        'src/app/orders/drafts/page.tsx', 'src/app/orders/import/page.tsx',
                        'src/app/orders/requests/page.tsx', 'src/app/orders/notifications/page.tsx']) {
      const src = code(path)
      assert.equal(/<ModuleSwitchButton/.test(src), false, path + ' renders the switch itself')
      if (src.includes('showModuleSwitch={false}')) optOuts.push(path)
    }
    assert.deepEqual(optOuts, [], 'only the Confirmed Order detail page opts out')
  })

  test('the button, its route and its own permission rule are untouched', () => {
    const button = read('src/components/layout/ModuleSwitchButton.tsx')
    assert.ok(button.includes('canAccessManagementModule'))
    assert.ok(button.includes("route: '/finance'"))
  })
})

// ══ 2. The payment-detail gate ════════════════════════════════════════════════

const row = (over: Partial<OrderPaymentListRow> = {}): OrderPaymentListRow => ({
  id: 'p1', client: 'Vittaazio', dateIso: '2026-09-01',
  allocated: '750000.00', full: '750000.00', isPartialShare: false,
  mode: 'bank_transfer', reference: '0524', status: 'approved_linked',
  ...over,
})

describe('only a Finance reader may ask for a payment’s Finance record', () => {
  const rows = [row(), row({ id: 'p2' })]

  test('a reader WITHOUT Finance module entry is refused before any request', () => {
    const answer = orderPaymentDetailQuery({
      canViewPaymentDetails: false, rows, paymentId: 'p1',
    })
    assert.deepEqual(answer, { allowed: false, paymentId: null })
  })

  test('a reader WITH it may ask, for a row the list actually showed', () => {
    assert.deepEqual(
      orderPaymentDetailQuery({ canViewPaymentDetails: true, rows, paymentId: 'p2' }),
      { allowed: true, paymentId: 'p2' },
    )
  })

  test('AN ID THE LIST NEVER SHOWED IS REFUSED, even for a Finance reader', () => {
    // A typed, guessed or tampered id must not become a request. The refusal is
    // here, before the network — not at RLS afterwards.
    for (const id of ['someone-elses-payment', '', null]) {
      assert.deepEqual(
        orderPaymentDetailQuery({ canViewPaymentDetails: true, rows, paymentId: id }),
        { allowed: false, paymentId: null }, String(id),
      )
    }
  })

  test('an empty list answers nothing at all', () => {
    assert.deepEqual(
      orderPaymentDetailQuery({ canViewPaymentDetails: true, rows: [], paymentId: 'p1' }),
      { allowed: false, paymentId: null },
    )
  })

  test('the id it returns is the LIST’S copy, never the caller’s string', () => {
    // So a caller cannot smuggle anything alongside an id that happens to match.
    const answer = orderPaymentDetailQuery({ canViewPaymentDetails: true, rows, paymentId: 'p1' })
    assert.equal(answer.paymentId, rows[0].id)
  })
})

describe('the page asks for the Finance record only on a press, and only then', () => {
  const page = code(PAGE)

  test('the capability is FINANCE MODULE ENTRY, resolved and not re-derived', () => {
    assert.ok(page.includes('const mayViewPaymentDetails = financeCaps.canAccessFinanceModule'))
    // The same resolver that answers every other Finance question on this page,
    // and no role check of its own.
    assert.ok(page.includes(`getEffectivePermissions(supabase, session.user.id, 'finance')`))
    assert.equal(/role === 'admin'|profile\?\.role/.test(
      page.slice(page.indexOf('const loadPaymentDetail'), page.indexOf('const viewEvidence'))), false,
      'the detail gate must not invent a role check')
  })

  test('THE STARTUP READS ASK FOR THE SEVEN COLUMNS THE FIGURES NEED, AND NO MORE', () => {
    const load = page.slice(page.indexOf('const loadOrder'), page.indexOf('const markUpdatesSeen'))
    assert.ok(load.includes(
      ".select('id, client_name, amount, payment_date, payment_mode, order_number, status')"))
    // Not one sensitive column is fetched for everybody.
    for (const column of ['proof_note', 'admin_note', 'sales_note', 'received_in',
                          'approved_at', 'rejected_at', 'clarification_requested_at',
                          'human_payment_id']) {
      assert.equal(load.includes(column), false,
        column + ' is fetched on the startup path, for every reader')
    }
  })

  test('the detail read is ONE payment, gated, and issued from the press', () => {
    const fn = page.slice(page.indexOf('const loadPaymentDetail'), page.indexOf('const viewEvidence'))
    assert.ok(fn.includes('orderPaymentDetailQuery({'))
    assert.ok(fn.includes('canViewPaymentDetails: mayViewPaymentDetails'))
    assert.ok(fn.includes('rows: paymentRows'))
    assert.ok(fn.includes('if (!allowed || !safeId) return'), 'it returns before reading')
    assert.ok(fn.includes(".eq('id', safeId)"), 'and asks for exactly that one row')
    assert.ok(fn.includes('PAYMENT_DETAIL_COLUMNS'))
  })

  test('it is the READER’S OWN session — no service role, no RPC, no new policy', () => {
    const fn = page.slice(page.indexOf('const loadPaymentDetail'), page.indexOf('const viewEvidence'))
    assert.ok(fn.includes('await supabase'))
    assert.equal(/service_role|SERVICE_ROLE|createServiceClient|\.rpc\(/.test(fn), false)
  })

  test('a refused row is reported as refused, never drawn as an empty record', () => {
    const fn = page.slice(page.indexOf('const loadPaymentDetail'), page.indexOf('const viewEvidence'))
    assert.ok(fn.includes("setPaymentDetail({ state: 'error', message: PAYMENT_DETAIL_UNAVAILABLE })"))
  })

  test('the dialog is TOLD the capability; it does not guess', () => {
    const body = page.slice(page.indexOf('<OrdersLayout'))
    assert.ok(body.includes('canViewDetails={mayViewPaymentDetails}'))
    assert.ok(body.includes('detail={paymentDetail}'))
    // And the same rows the guard validates against are the rows it draws.
    assert.ok(body.includes('rows={paymentRows}'))
    assert.ok(page.includes('const paymentRows = paymentList === null ? [] : orderPaymentList(payments, paymentList)'))
  })

  test('closing or going back forgets the record it fetched', () => {
    const body = page.slice(page.indexOf('<OrdersLayout'))
    assert.ok(body.includes('setPaymentDetail(null)'))
  })
})

describe('the dialog itself honours the gate', () => {
  const ws = code(WORKSPACE)

  test('the detail view is unreachable without the capability', () => {
    assert.ok(ws.includes('const open = canViewDetails ? orderPaymentById(rows, openId) : null'),
      'an openId alone must not open the detail')
  })

  test('the control is drawn only with it', () => {
    assert.ok(ws.includes('{canViewDetails && ('))
  })

  test('ADD PAYMENT IS A DIFFERENT PERMISSION, and is unchanged', () => {
    // finance.allocate with module entry, plus the Order not being cancelled —
    // stated once in crossModuleLinks and enforced by the RPC.
    assert.ok(code(PAGE).includes('const mayRecordPayment = canRecordPaymentAgainstOrder({'))
    assert.ok(code(PAGE).includes('canAllocatePayment: financeCaps.canAllocatePayment'))
    assert.ok(code(PAGE).includes('{recordingPayment && mayRecordPayment && ('))
    assert.ok(code(PAGE).includes('<RecordSplitPaymentModal'))
    // The page never reaches for the allocation RPC itself.
    assert.equal(code(PAGE).includes('record_payment_with_allocations'), false)
  })

  test('and no payment action navigates to the Finance module', () => {
    assert.equal(/financePaymentHref/.test(code(PAGE)), false)
    assert.equal(/<a |href=/.test(ws), false)
  })
})
