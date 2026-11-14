// THE "PI CHANGE WAITING" MARKER ON THE CONFIRMED ORDERS LIST (Operations' request, 2026-11-14).
//
// Run with: npm run test:file -- src/lib/orders/piChangeMarker.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildPiChangeMarkers, loadPiChangeMarkers, piChangeMarker } from './piChangeMarker'

const none = new Set<string>()

describe('which state an Order is in', () => {
  test('an Operations review of a revised PI that is undecided is "awaiting Operations"', () => {
    const m = buildPiChangeMarkers({ pendingRevisionOrderIds: [], handoffs: [{ order_id: 'o1', status: 'awaiting' }], withSales: none })
    assert.equal(m.get('o1')?.stage, 'awaiting_operations')
    assert.equal(m.get('o1')?.tone, 'amber')
  })

  test('Operations asking for changes is red and waits on Sales', () => {
    const m = buildPiChangeMarkers({ pendingRevisionOrderIds: [], handoffs: [{ order_id: 'o1', status: 'clarification_needed' }], withSales: none })
    assert.equal(m.get('o1')?.stage, 'operations_asked_changes')
    assert.equal(m.get('o1')?.tone, 'red')
  })

  test('a PI the approver sent back is with Sales, not waiting on Operations', () => {
    const m = buildPiChangeMarkers({
      pendingRevisionOrderIds: [],
      handoffs: [{ order_id: 'o1', status: 'awaiting' }, { order_id: 'o2', status: 'clarification_needed' }],
      withSales: new Set(['o1', 'o2']),
    })
    assert.equal(m.get('o1')?.stage, 'returned_to_sales')
    assert.equal(m.get('o2')?.stage, 'returned_to_sales')
  })

  test('a revised PI waiting for approval is the newest step and wins over everything older', () => {
    const m = buildPiChangeMarkers({
      pendingRevisionOrderIds: ['o1', 'o2', 'o3'],
      handoffs: [
        { order_id: 'o1', status: 'clarification_needed' },
        { order_id: 'o2', status: 'awaiting' },
        { order_id: 'o3', status: 'awaiting' },
      ],
      withSales: new Set(['o3']),
    })
    for (const id of ['o1', 'o2', 'o3']) assert.equal(m.get(id)?.stage, 'awaiting_approval', id)
  })

  test('an Order with nothing waiting has no marker, and each Order has at most one', () => {
    const m = buildPiChangeMarkers({
      pendingRevisionOrderIds: ['o1'], handoffs: [{ order_id: 'o2', status: 'awaiting' }], withSales: none,
    })
    assert.equal(m.has('o3'), false)
    assert.deepEqual([...m.keys()].sort(), ['o1', 'o2'])
  })

  test('every state says its words, so colour is never the only signal', () => {
    for (const stage of ['awaiting_approval', 'returned_to_sales', 'operations_asked_changes', 'awaiting_operations'] as const) {
      const m = piChangeMarker(stage)
      assert.match(m.label, /^PI changed · /)
      assert.ok(m.title.length > 20)
    }
  })
})

type Call = { table: string; steps: [string, ...unknown[]][] }

/** A stand-in for the two reads: records every step of each query, answers with `answers[table]`. */
function fakeSupabase(answers: Record<string, { data: unknown[] | null; error: { message: string } | null }>, calls: Call[] = []) {
  const from = (table: string) => {
    const call: Call = { table, steps: [] }
    calls.push(call)
    const chain: Record<string, unknown> = {}
    for (const step of ['select', 'eq', 'in', 'is', 'gte', 'order']) {
      chain[step] = (...args: unknown[]) => { call.steps.push([step, ...args]); return chain }
    }
    chain.then = (resolve: (v: unknown) => unknown) => resolve(answers[table] ?? { data: [], error: null })
    return chain
  }
  return { from } as unknown as SupabaseClient
}

describe('the two reads beside the list', () => {
  test('ask only for pending revisions and live undecided handoffs of version 2 or later', async () => {
    const calls: Call[] = []
    const m = await loadPiChangeMarkers(fakeSupabase({
      order_pi_versions: { data: [{ order_id: 'o1' }], error: null },
      order_operations_handoffs: { data: [], error: null },
    }, calls))
    assert.equal(m.get('o1')?.stage, 'awaiting_approval')
    const versions = calls.find(c => c.table === 'order_pi_versions')!
    assert.deepEqual(versions.steps.find(s => s[0] === 'eq'), ['eq', 'status', 'pending'])
    const handoffs = calls.find(c => c.table === 'order_operations_handoffs')!
    assert.deepEqual(handoffs.steps.find(s => s[0] === 'in'), ['in', 'status', ['awaiting', 'clarification_needed']])
    assert.deepEqual(handoffs.steps.find(s => s[0] === 'is'), ['is', 'superseded_at', null])
    assert.deepEqual(handoffs.steps.find(s => s[0] === 'gte'), ['gte', 'version_number', 2])
  })

  test('a failed read draws no marker at all', async () => {
    const denied = { data: null, error: { message: 'denied' } }
    assert.equal((await loadPiChangeMarkers(fakeSupabase({ order_pi_versions: denied }))).size, 0)
    assert.equal((await loadPiChangeMarkers(fakeSupabase({ order_operations_handoffs: denied }))).size, 0)
  })
})

describe('the list draws it', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/orders/all/page.tsx'), 'utf8')

  test('it loads beside the list, inside the page\'s one Promise.all', () => {
    assert.match(page, /loadPiChangeMarkers/)
    assert.match(page, /await Promise\.all\(\[[^\]]*loadPiChanges\(\)/)
  })

  test('the marker sits in the Factory Status cell, on the table row and on the phone card, never on a cancelled Order', () => {
    assert.equal((page.match(/<PiChangePill /g) ?? []).length, 2, 'one pill in the table, one on the card')
    assert.match(page, /has-pi-change/)
    // The cancelled branch of the card returns before the marker is read.
    const card = page.slice(page.indexOf('<ul className="orders-list-cards"'))
    assert.ok(card.indexOf("o.status === 'cancelled'") < card.indexOf('piChanges.get('))
  })
})
