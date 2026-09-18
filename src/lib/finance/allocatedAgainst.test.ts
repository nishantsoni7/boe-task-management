/**
 * ALLOCATED AGAINST — where a confirmed payment's money has gone.
 *
 * The pure rules behind the Confirmed Payments list's Allocated Against cell
 * (src/lib/finance/allocatedAgainst.ts), and the read boundary of the RPC that
 * feeds it (20261216000000). The SQL behaviour itself is executed by
 * supabase/tests/run_received_payment_allocation_targets_suite.sh on a
 * disposable database; this file pins the source so the migration cannot drift
 * from what that suite proved.
 *
 * Offline and pure.
 *
 * Run:
 *   npx tsx --test src/lib/finance/allocatedAgainst.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  ALLOCATION_DETAILS_UNAVAILABLE_TEXT,
  ALLOCATION_TARGETS_MAX_IDS,
  NOT_ALLOCATED_TEXT,
  allocatedAgainstText,
  allocationCountLabel,
  allocationTargetLabel,
  buildAllocatedAgainst,
  type AllocationTargetRow,
} from './allocatedAgainst'
import { formatMoney } from './piPaymentView'

const PAY = 'pay-1'
const ORDER_425 = 'order-0425'
const ORDER_431 = 'order-0431'
const PI_HOTEL = 'pi-hotel'
const PI_RESORT = 'pi-resort'

let seq = 0
function row(over: Partial<AllocationTargetRow> & Pick<AllocationTargetRow, 'target_type' | 'target_id'>): AllocationTargetRow {
  seq += 1
  return {
    payment_request_id: PAY,
    allocation_id: `alloc-${seq}`,
    target_reference: null,
    reserved_order_number: null,
    allocated_amount: '0',
    ...over,
  }
}
const order = (id: string, ref: string, amount: string, over: Partial<AllocationTargetRow> = {}) =>
  row({ target_type: 'order', target_id: id, target_reference: ref, allocated_amount: amount, ...over })
const pi = (id: string, ref: string | null, amount: string, reserved: string | null = null) =>
  row({ target_type: 'pi_draft', target_id: id, target_reference: ref, reserved_order_number: reserved, allocated_amount: amount })

const payment = (amount: string | number) => ({ id: PAY, amount })
const covered = { covered: true }

function lines(view: ReturnType<typeof buildAllocatedAgainst>) {
  assert.equal(view.kind, 'targets')
  if (view.kind !== 'targets') throw new Error('unreachable')
  return view
}

// ── The names ────────────────────────────────────────────────────────────────

describe('each destination has a readable, truthful name', () => {
  test('an Order is named by its display number', () => {
    assert.equal(allocationTargetLabel({ target_type: 'order', target_reference: '0425', reserved_order_number: null }), 'Order 0425')
  })

  test('a PI Draft with a reserved Order number says so', () => {
    assert.equal(allocationTargetLabel({ target_type: 'pi_draft', target_reference: 'Hotel ABC.xlsx', reserved_order_number: '0431' }),
      'PI Draft · Reserved Order 0431')
  })

  test('a PI Draft without one is named by its workbook, never by a number it does not own', () => {
    const label = allocationTargetLabel({ target_type: 'pi_draft', target_reference: 'Hotel ABC.xlsx', reserved_order_number: null })
    assert.equal(label, 'PI Draft · Hotel ABC.xlsx')
    assert.ok(!/PI Draft \d/.test(label), 'no false PI number')
  })

  test('a destination with no safe reference still says what it is', () => {
    assert.equal(allocationTargetLabel({ target_type: 'pi_draft', target_reference: null, reserved_order_number: null }), 'PI Draft')
    assert.equal(allocationTargetLabel({ target_type: 'order', target_reference: '  ', reserved_order_number: null }), 'Order')
  })

  test('the row type carries no source_order_number field at all', () => {
    const src = readFileSync(join('src', 'lib', 'finance', 'allocatedAgainst.ts'), 'utf8')
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!code.includes('source_order_number'))
  })
})

// ── Every allocation case ────────────────────────────────────────────────────

describe('every allocation case the list must make clear', () => {
  test('A. no active allocation → Not allocated', () => {
    const view = buildAllocatedAgainst(payment('500000'), [], covered)
    assert.deepEqual(view, { kind: 'none' })
    assert.equal(allocatedAgainstText(view, formatMoney), NOT_ALLOCATED_TEXT)
  })

  test('B. one confirmed Order', () => {
    const v = lines(buildAllocatedAgainst(payment('500000'), [order(ORDER_425, '0425', '500000.00')], covered))
    assert.equal(v.lines.length, 1)
    assert.equal(v.lines[0].label, 'Order 0425')
    assert.equal(v.lines[0].amount, '500000.00')
    assert.equal(v.unallocated, null, 'fully allocated shows no remainder')
    assert.equal(v.over, false)
    assert.equal(allocatedAgainstText(v, formatMoney), 'Order 0425 · ₹5,00,000.00')
  })

  test('C. one PI Draft — unreserved and reserved', () => {
    const a = lines(buildAllocatedAgainst(payment('50000'), [pi(PI_HOTEL, 'Hotel ABC.xlsx', '50000')], covered))
    assert.equal(a.lines[0].label, 'PI Draft · Hotel ABC.xlsx')
    const b = lines(buildAllocatedAgainst(payment('50000'), [pi(PI_RESORT, 'Resort.xlsx', '50000', '0431')], covered))
    assert.equal(b.lines[0].label, 'PI Draft · Reserved Order 0431')
  })

  test('D. several Orders, several PI Drafts, and a mix — each visible with its own amount', () => {
    const v = lines(buildAllocatedAgainst(payment('400000'), [
      order(ORDER_425, '0425', '200000'),
      order(ORDER_431, '0431', '150000'),
      pi(PI_HOTEL, 'Hotel ABC.xlsx', '50000'),
    ], covered))
    assert.deepEqual(v.lines.map(l => [l.label, l.amount]), [
      ['Order 0425', '200000'],
      ['Order 0431', '150000'],
      ['PI Draft · Hotel ABC.xlsx', '50000'],
    ])
    assert.equal(allocationCountLabel(v.lines.length), '3 allocations')
    assert.equal(v.unallocated, null)

    const pis = lines(buildAllocatedAgainst(payment('100000'), [
      pi(PI_HOTEL, 'Hotel ABC.xlsx', '60000'), pi(PI_RESORT, 'Resort.xlsx', '40000', '0431'),
    ], covered))
    assert.deepEqual(pis.lines.map(l => l.label), ['PI Draft · Hotel ABC.xlsx', 'PI Draft · Reserved Order 0431'])

    const text = allocatedAgainstText(v, formatMoney)
    assert.ok(text.startsWith('3 allocations: '), text)
    for (const part of ['Order 0425 · ₹2,00,000.00', 'Order 0431 · ₹1,50,000.00', 'PI Draft · Hotel ABC.xlsx · ₹50,000.00']) {
      assert.ok(text.includes(part), part)
    }
  })

  test('E. partial allocation lists the targets and the exact unallocated remainder', () => {
    const v = lines(buildAllocatedAgainst(payment('750000.55'), [
      order(ORDER_425, '0425', '400000.25'), pi(PI_HOTEL, 'Hotel ABC.xlsx', '250000.20'),
    ], covered))
    assert.equal(v.unallocated, '100000.10')
    assert.ok(allocatedAgainstText(v, formatMoney).endsWith('Unallocated · ₹1,00,000.10'))
  })

  test('F. over-allocation shows every target, no remainder, and is flagged', () => {
    const v = lines(buildAllocatedAgainst(payment('100000'), [
      order(ORDER_425, '0425', '80000'), order(ORDER_431, '0431', '30000'),
    ], covered))
    assert.equal(v.lines.length, 2, 'nothing is hidden')
    assert.equal(v.over, true)
    assert.equal(v.unallocated, null)
    assert.deepEqual(v.lines.map(l => l.amount), ['80000', '30000'], 'amounts are not clipped')
  })

  test('G. duplicate active allocations to one target are combined, exactly', () => {
    const v = lines(buildAllocatedAgainst(payment('1'), [
      order(ORDER_425, '0425', '0.10'), order(ORDER_425, '0425', '0.20'), pi(PI_HOTEL, 'x.xlsx', '0.30'),
      order(ORDER_425, '0425', '0.40'),
    ], covered))
    assert.equal(v.lines.length, 2)
    assert.equal(v.lines[0].label, 'Order 0425')
    assert.equal(v.lines[0].amount, '0.70', '0.1 + 0.2 + 0.4 with no floating-point drift')
    assert.equal(v.lines[0].allocationCount, 3)
    assert.equal(v.unallocated, null, 'exactly 1.00 allocated')
    assert.equal(allocationCountLabel(v.lines.length), '2 allocations', 'counts destinations, not rows')
  })

  test('an Order and a PI Draft that share an id are still two destinations', () => {
    const v = lines(buildAllocatedAgainst(payment('10'), [
      order('same', '0425', '4'), pi('same', 'a.xlsx', '6'),
    ], covered))
    assert.equal(v.lines.length, 2)
  })

  test('only this payment\'s rows are used', () => {
    const other = order(ORDER_431, '0431', '999', { payment_request_id: 'pay-2' })
    const v = lines(buildAllocatedAgainst(payment('500'), [order(ORDER_425, '0425', '200'), other], covered))
    assert.deepEqual(v.lines.map(l => l.label), ['Order 0425'])
    assert.equal(v.unallocated, '300')
  })
})

// ── Never "Not allocated" on the strength of a read that did not happen ──────

describe('an incomplete answer is never shown as a complete one', () => {
  test('a failed read is "Allocation details unavailable", not "Not allocated"', () => {
    const view = buildAllocatedAgainst(payment('500'), [], { readFailed: true })
    assert.deepEqual(view, { kind: 'unavailable' })
    assert.equal(allocatedAgainstText(view, formatMoney), ALLOCATION_DETAILS_UNAVAILABLE_TEXT)
  })

  test('a read still in flight is loading, not Not allocated', () => {
    assert.deepEqual(buildAllocatedAgainst(payment('500'), null), { kind: 'loading' })
  })

  test('a payment the read did not cover is unavailable, not Not allocated', () => {
    assert.deepEqual(buildAllocatedAgainst(payment('500'), [], { covered: false }), { kind: 'unavailable' })
  })

  test('an unreadable amount on an allocation makes the cell unavailable rather than understated', () => {
    const view = buildAllocatedAgainst(payment('500'), [order(ORDER_425, '0425', 'abc')], covered)
    assert.deepEqual(view, { kind: 'unavailable' })
  })
})

// ── Where the list gets its data ─────────────────────────────────────────────

describe('the list builds the column from the complete read, and only from it', () => {
  const view = readFileSync(join('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx'), 'utf8')
  const loader = view.slice(view.indexOf('const loadAllocationTargets'), view.indexOf('const allocatedAgainstFor'))
  const builder = view.slice(view.indexOf('const allocatedAgainstFor'), view.indexOf('const allocationTargetHref'))

  test('one RPC call per page, bounded to the page\'s ids', () => {
    assert.ok(loader.includes(".rpc('received_payment_allocation_targets'"))
    assert.ok(loader.includes('.slice(0, ALLOCATION_TARGETS_MAX_IDS)'))
    assert.equal(ALLOCATION_TARGETS_MAX_IDS, 50)
    assert.ok(!/rows\.map\([\s\S]{0,200}?\.rpc\(/.test(loader), 'never one call per row')
  })

  test('never from allocated_order_number, the legacy order_id, or the partial RLS read', () => {
    for (const forbidden of ['allocated_order_number', 'r.order_id', "from('finance_payment_allocations')", 'allocations.get(']) {
      assert.ok(!loader.includes(forbidden) && !builder.includes(forbidden), forbidden)
    }
  })

  test('a failed read marks the page as unavailable', () => {
    assert.ok(loader.includes('{ rows: null, failed: true, ids: new Set() }'))
    assert.ok(builder.includes('readFailed: allocationTargets.failed'))
  })

  test('a target is a link only when the reader may already open it', () => {
    const href = view.slice(view.indexOf('const allocationTargetHref'))
    const body = href.slice(0, href.indexOf('\n  }'))
    assert.ok(body.includes('canOpenOrderRecord(ordersCaps.canAccessOrdersModule)'), 'Orders module entry')
    assert.ok(body.includes('targetLabels.has(targetId)'), 'and the record came back from the reader\'s own RLS read')
  })

  test('Payments to Verify does not call it', () => {
    assert.ok(view.includes("if (surface === 'confirmed') void loadAllocationTargets(mapped, token)"))
  })
})

// ── The read boundary: 20261216000000 ────────────────────────────────────────

describe('received_payment_allocation_targets() — the read boundary', () => {
  const FILE = '20261216000000_received_payment_allocation_targets.sql'
  const sql = readFileSync(join('supabase', 'migrations', FILE), 'utf8').replace(/\r\n/g, '\n')
  const body = sql.slice(
    sql.indexOf('create or replace function public.received_payment_allocation_targets('),
    sql.indexOf('comment on function public.received_payment_allocation_targets('))
  const code = body.replace(/--[^\n]*/g, '')

  test('forward-only: it follows 20261215000000 and its version is unique', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.equal(files[i - 1], '20261215000000_payment_allocation_ledger_for_correction.sql')
  })

  test('SECURITY DEFINER, STABLE, with a pinned search_path', () => {
    assert.ok(code.includes('security definer'))
    assert.ok(code.includes('\nstable\n'))
    assert.ok(code.includes('set search_path = public, pg_temp'))
  })

  test('checks auth.uid(), Finance entry and finance.view — in that order — then bounds the input to 50', () => {
    const uid = code.indexOf('v_actor is null')
    const entry = code.indexOf("module_entry_open('finance')")
    const perm = code.indexOf("actor_has_module_permission('finance', 'view')")
    const bound = code.indexOf('> 50')
    assert.ok(uid > 0 && entry > uid && perm > entry && bound > perm)
  })

  test('returns only confirmed, visible payments\' ACTIVE allocations', () => {
    assert.ok(code.includes('public.finance_payment_status_is_verified(f.status)'))
    assert.ok(code.includes("where a.status = 'active'"))
    assert.ok(code.includes('where f.id = any (p_payment_request_ids)'))
  })

  test('returns the display fields only — never source_order_number or a client', () => {
    assert.ok(!code.includes('source_order_number'))
    assert.ok(!code.includes('client_name'))
    assert.ok(sql.includes("'TABLE(payment_request_id uuid, allocation_id uuid, target_type text, target_id uuid, target_reference text, reserved_order_number text, allocated_amount numeric)'"),
      'the apply-time assertion pins the exact result shape')
  })

  test('writes nothing', () => {
    assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(code))
  })

  test('EXECUTE: revoked from PUBLIC, anon and service_role; granted to authenticated only', () => {
    for (const role of ['public', 'anon', 'service_role']) {
      assert.ok(sql.includes(`revoke all on function public.received_payment_allocation_targets(uuid[]) from ${role};`), role)
    }
    const grants = sql.match(/grant execute on function public\.received_payment_allocation_targets\(uuid\[\]\) to (\w+);/g) ?? []
    assert.deepEqual(grants, ['grant execute on function public.received_payment_allocation_targets(uuid[]) to authenticated;'])
  })

  test('changes no table, column, policy or permission, and proves it at apply time', () => {
    const ddl = sql.replace(/--[^\n]*/g, '').replace('create temporary table targets_policy_snapshot', '')
    assert.ok(!/\b(create|alter|drop)\s+(policy|table\s+public|index)\b/i.test(ddl))
    assert.ok(!/\bpermission_actions\b|\brole_permissions\b/.test(ddl))
    for (const needle of ['a payment or allocation RLS policy changed', 'must be SECURITY DEFINER', 'must be STABLE',
      'must pin search_path', 'anon must NOT', 'service_role must NOT', 'PUBLIC must NOT', 'authenticated must be able']) {
      assert.ok(sql.includes(needle), needle)
    }
  })

  test('its visibility rule mirrors EVERY live permissive SELECT policy on finance_payment_requests', () => {
    const live = new Map<string, string>()
    for (const f of readdirSync(join('supabase', 'migrations')).sort()) {
      const text = readFileSync(join('supabase', 'migrations', f), 'utf8').replace(/--[^\n]*/g, '')
      const re = /(create|drop)\s+policy\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+(?:public\.)?(\w+)([\s\S]*?);/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        if (m[3] !== 'finance_payment_requests') continue
        if (m[1].toLowerCase() === 'drop') live.delete(m[2])
        else live.set(m[2], m[4].replace(/\s+/g, ' '))
      }
    }
    const permissiveSelect = [...live.entries()]
      .filter(([, def]) => !/as restrictive/i.test(def) && /for (select|all)/i.test(def))
      .map(([name]) => name).sort()
    assert.deepEqual(permissiveSelect, [
      'finance_payment_requests_admin_select',
      'finance_payment_requests_order_request_assignee_select',
      'finance_payment_requests_order_request_owner_select',
      'finance_payment_requests_own_select',
      'finance_payment_requests_participant_select',
      'finance_payment_requests_view_all_select',
    ])
    for (const name of permissiveSelect) {
      assert.ok(body.includes(`-- ${name}`), `the RPC must mirror ${name}`)
    }
  })

  test('an executable suite proves it on a disposable database', () => {
    const runner = readFileSync(join('supabase', 'tests', 'run_received_payment_allocation_targets_suite.sh'), 'utf8')
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('the partial-RLS defect did not reproduce'))
    const suite = readFileSync(join('supabase', 'tests', 'received_payment_allocation_targets_assertions.sql'), 'utf8')
    for (const needle of ['1. finance.view participant without view_all: complete targets',
      '2. reversed excluded; duplicate active rows returned separately',
      '3. PI Draft: file name or reserved Order number, never source_order_number',
      '4a. admin', '4b. view_all', '5. unrelated payment access: nothing returned',
      '6. no Finance entry', '7. inactive user', '8. authenticated role with no user',
      '9a. anon', '9b. service_role', '10. at most 50 ids',
      '11. no payment, allocation, Order, PI, permission or policy changed']) {
      assert.ok(suite.includes(needle), needle)
    }
  })
})
