// ORDERS THAT HAVE COME BACK TO OPERATIONS: the "New update" mark (owner, 2026-11-15, for Nitish).
//
// Run with: npm run test:file -- src/lib/orders/backWithOperations.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BACK_WITH_OPERATIONS_BADGE,
  BACK_WITH_OPERATIONS_NOTE,
  backWithOperationsFor,
  isBackWithOperations,
  loadOrdersBackWithOperations,
  ordersBackWithOperations,
  type BackHandoff,
} from './backWithOperations'
import { unreadUpdateLabel, unreadUpdateNote } from './orderUnreadUpdates'

const h = (over: Partial<BackHandoff> = {}): BackHandoff => ({
  order_id: 'o1', status: 'awaiting', chain_holder: 'operations', chain_round: 0, version_number: 1, ...over,
})

describe('which orders have come back to Operations', () => {
  test('a first look at a brand-new order is NOT marked: nothing has come back', () => {
    assert.equal(isBackWithOperations(h()), false)
  })

  test('an order Operations flagged, the approver passed back (version 1, flagged once) IS marked', () => {
    assert.equal(isBackWithOperations(h({ chain_round: 1 })), true)
    assert.equal(isBackWithOperations(h({ chain_round: 3 })), true)
  })

  test('a revised PI the approver approved (version 2 or later) IS marked, even on its first look', () => {
    assert.equal(isBackWithOperations(h({ version_number: 2 })), true)
    assert.equal(isBackWithOperations(h({ version_number: 5, chain_round: 0 })), true)
  })

  test('it is Operations\' own to act on only while Operations holds it', () => {
    for (const holder of ['coordinator', 'sales', null]) {
      assert.equal(isBackWithOperations(h({ chain_round: 1, chain_holder: holder })), false, String(holder))
    }
  })

  test('it ends the moment Operations decides: accepted, or flagged again (held by the approver)', () => {
    assert.equal(isBackWithOperations(h({ chain_round: 1, status: 'accepted' })), false)
    assert.equal(isBackWithOperations(h({ chain_round: 2, status: 'clarification_needed', chain_holder: 'coordinator' })), false)
    // A flagged version that somehow still names Operations as holder is still not "awaiting".
    assert.equal(isBackWithOperations(h({ chain_round: 1, status: 'clarification_needed' })), false)
  })

  test('missing columns (a database before the review chain) mean "not back", never a guess', () => {
    assert.equal(isBackWithOperations(h({ chain_round: null, version_number: null })), false)
    assert.equal(isBackWithOperations(h({ chain_round: null, version_number: 2 })), true)
  })

  test('the set holds order ids, once each', () => {
    const set = ordersBackWithOperations([
      h({ order_id: 'a', chain_round: 1 }), h({ order_id: 'a', version_number: 2 }),
      h({ order_id: 'b' }), h({ order_id: 'c', version_number: 3 }),
    ])
    assert.deepEqual([...set].sort(), ['a', 'c'])
  })
})

describe('who is shown it', () => {
  const ids = new Set(['o1'])

  test('the Operations team sees it; everybody else gets an empty set', () => {
    assert.equal(backWithOperationsFor('operations', ids).has('o1'), true)
    for (const team of ['sales', 'admin', 'finance', '', null, undefined]) {
      assert.equal(backWithOperationsFor(team, ids).size, 0, String(team))
    }
  })
})

describe('the words', () => {
  test('it is the same blue "New update" the list already uses for an unread notice', () => {
    assert.equal(BACK_WITH_OPERATIONS_NOTE, unreadUpdateNote(1))
    assert.equal(BACK_WITH_OPERATIONS_BADGE, unreadUpdateLabel(1))
  })
})

type Call = { table: string; steps: [string, ...unknown[]][] }

/** A stand-in for the one read: records every step of the query, answers with `answer`. */
function fakeSupabase(answer: { data: unknown[] | null; error: { message: string } | null } | 'throw', calls: Call[] = []) {
  const from = (table: string) => {
    const call: Call = { table, steps: [] }
    calls.push(call)
    const chain: Record<string, unknown> = {}
    for (const step of ['select', 'eq', 'in', 'is', 'or']) {
      chain[step] = (...args: unknown[]) => { call.steps.push([step, ...args]); return chain }
    }
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      answer === 'throw' ? reject(new Error('network')) : resolve(answer)
    return chain
  }
  return { from } as unknown as SupabaseClient
}

describe('the one read', () => {
  test('asks only for live, awaiting, Operations-held handoffs that are a revision or a second look', async () => {
    const calls: Call[] = []
    const set = await loadOrdersBackWithOperations(fakeSupabase({
      data: [h({ order_id: 'a', chain_round: 1 }), h({ order_id: 'b' })], error: null,
    }, calls))
    assert.deepEqual([...set], ['a'], 'the rule is applied again to what came back')
    assert.equal(calls.length, 1)
    const c = calls[0]
    assert.equal(c.table, 'order_operations_handoffs')
    assert.deepEqual(c.steps.find(s => s[0] === 'select'), ['select', 'order_id, status, chain_holder, chain_round, version_number'])
    assert.deepEqual(c.steps.find(s => s[0] === 'eq' && s[1] === 'status'), ['eq', 'status', 'awaiting'])
    assert.deepEqual(c.steps.find(s => s[0] === 'eq' && s[1] === 'chain_holder'), ['eq', 'chain_holder', 'operations'])
    assert.deepEqual(c.steps.find(s => s[0] === 'is'), ['is', 'superseded_at', null])
    assert.deepEqual(c.steps.find(s => s[0] === 'or'), ['or', 'version_number.gte.2,chain_round.gte.1'])
  })

  test('a failed or refused read draws no mark at all', async () => {
    assert.equal((await loadOrdersBackWithOperations(fakeSupabase({ data: null, error: { message: 'denied' } }))).size, 0)
    assert.equal((await loadOrdersBackWithOperations(fakeSupabase('throw'))).size, 0)
  })
})

describe('the screens draw it', () => {
  const list = readFileSync(join(process.cwd(), 'src/app/orders/all/page.tsx'), 'utf8')
  const dash = readFileSync(join(process.cwd(), 'src/app/orders/page.tsx'), 'utf8')
  const view = readFileSync(join(process.cwd(), 'src/components/orders/dashboard/OperationsDashboardView.tsx'), 'utf8')

  test('the list reads it beside the others, in the page\'s one Promise.all, and again on Refresh', () => {
    assert.match(list, /await Promise\.all\(\[[^\]]*loadBackWithOps\(\)/)
    assert.ok(list.includes('loadAdvance(), loadDispatch(), loadBackWithOps()]) }}'), 'Refresh re-reads it')
  })

  test('the list shows it to the Operations team only, and never on a cancelled order', () => {
    assert.ok(list.includes('backWithOperationsFor(profile?.team, backWithOps)'))
    assert.match(list, /!cancelled && returnedToMe\.has\(o\.id\) \? BACK_WITH_OPERATIONS_NOTE : null/)
    // The cancelled branch of the phone card returns before the label is read.
    const card = list.slice(list.indexOf('<ul className="orders-list-cards"'))
    assert.ok(card.indexOf("o.status === 'cancelled'") < card.indexOf('returnedToMe.has('))
  })

  test('the old four-coloured pills are gone', () => {
    for (const gone of ['PiChangePill', 'has-pi-change', 'orders-pichange', 'piChangeMarker']) {
      assert.equal(list.includes(gone), false, gone)
    }
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    assert.equal(css.includes('has-pi-change'), false)
    assert.equal(css.includes('orders-pichange'), false)
  })

  test('the dashboard row is blue on a desktop table and on a phone, where the cells are transparent and the row carries it', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    assert.ok(css.includes(".ops-na-row[data-new='true'] td { background: #F2F6FB; }"))
    assert.ok(css.includes(".ops-na-row[data-new='true'] td:first-child { box-shadow: inset 3px 0 0 #335A86; }"))
    const at = css.search(/@media \(max-width: 759px\) \{\s+\.ops-na-table, \.ops-na-table tbody/)
    assert.ok(at > 0, 'the phone block is found')
    const phone = css.slice(at)
    assert.ok(phone.includes(".ops-na-row[data-new='true'] { background: #F2F6FB; box-shadow: inset 3px 0 0 #335A86; }"))
    assert.ok(phone.includes(".ops-na-row[data-new='true'] td:first-child { box-shadow: none; }"), 'no second edge inside the row')
  })

  test('the dashboard reads it for the Operations team only, inside its existing Promise.all', () => {
    assert.ok(dash.includes("profile?.team === 'operations' ? loadOrdersBackWithOperations(supabase)"))
    // 2026-11-21: the group is a named promise now, so the approver's cards' read can be started right after the group
    // is sent and before it is awaited. The Operations read is still one of its entries, and the page still waits for it.
    assert.ok(dash.includes('const dashboardReads = Promise.all(['))
    assert.match(dash, /operationsRes,\s+backRes,\s+\] = await dashboardReads/)
    assert.ok(dash.includes('backWithOps={backWithOps}'))
  })

  test('the dashboard marks an order that came back, in the Operations rows and on the answer card', () => {
    const rules = readFileSync(join(process.cwd(), 'src/lib/orders/operationsCards.ts'), 'utf8')
    assert.ok(rules.includes('BACK_WITH_OPERATIONS_NOTE'))
    assert.ok(rules.includes('if (input.backWithOps.has(a.orderId)) changes.push(replyBackRow('))
    assert.ok(view.includes('isNew={backWithOps.has(item.orderId)}'))
    assert.equal((view.match(/<NewUpdateTag \/>/g) ?? []).length, 1, 'one on the answer card')
  })
})
