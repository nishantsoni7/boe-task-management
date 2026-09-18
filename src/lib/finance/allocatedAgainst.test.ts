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
  allocationTargetName,
  allocationTargetNames,
  nameSummaryTargets,
  piDraftSafeName,
  allocationBadgeState,
  allocationStatusFromTotal,
  buildAllocatedAgainst,
  type AllocationTargetRow,
} from './allocatedAgainst'
import { parseExact } from './exactMoney'
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
    assert.deepEqual(view, { kind: 'none', status: 'zero' })
    assert.equal(allocatedAgainstText(view, formatMoney), NOT_ALLOCATED_TEXT)
  })

  test('B. one confirmed Order', () => {
    const v = lines(buildAllocatedAgainst(payment('500000'), [order(ORDER_425, '0425', '500000.00')], covered))
    assert.equal(v.lines.length, 1)
    assert.equal(v.lines[0].label, 'Order 0425')
    assert.equal(v.lines[0].amount, '500000.00')
    assert.equal(v.unallocated, null, 'fully allocated shows no remainder')
    assert.equal(v.over, false)
    assert.equal(v.status, 'full')
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

// ── The status: from the SAME exact total as the lines ───────────────────────

describe('Allocation Status comes from the complete total, in exact decimals', () => {
  const x = (v: string) => parseExact(v)!

  test('the rule, case for case with the database’s received_payment_allocation_status', () => {
    assert.equal(allocationStatusFromTotal(x('100'), x('0')), 'zero')
    assert.equal(allocationStatusFromTotal(x('100'), x('0.01')), 'partial')
    assert.equal(allocationStatusFromTotal(x('750000.55'), x('725000.55')), 'partial')
    assert.equal(allocationStatusFromTotal(x('750000.55'), x('750000.55')), 'full')
    assert.equal(allocationStatusFromTotal(x('750000.55'), x('750000.56')), 'over')
    assert.equal(allocationStatusFromTotal(null, x('5')), null)
  })

  test('no floating-point drift: 0.1 + 0.2 against 0.30 is Full, not Partial or Over', () => {
    const v = lines(buildAllocatedAgainst(payment('0.30'), [
      order(ORDER_425, '0425', '0.1'), order(ORDER_431, '0431', '0.2'),
    ], covered))
    assert.equal(v.status, 'full')
    assert.equal(v.unallocated, null)
  })

  test('REGRESSION: a restricted viewer sees ₹4,00,000.25 through RLS; the complete ledger is ₹7,25,000.55', () => {
    // The complete read (received_payment_allocation_targets) returns every
    // active destination of the payment; the viewer's own RLS read would have
    // returned only the first row.
    const complete = [
      order(ORDER_425, '0524', '400000.25'),
      order(ORDER_431, '0529', '200000.20'),
      order(ORDER_431, '0529', '25000.00'),
      pi(PI_HOTEL, 'Hotel ABC.xlsx', '100000.10'),
    ]
    const v = lines(buildAllocatedAgainst(payment('750000.55'), complete, covered))
    assert.equal(v.lines.length, 3, 'every destination, the two 0529 rows combined')
    assert.deepEqual(v.lines.map(l => l.amount), ['400000.25', '225000.20', '100000.10'])
    assert.equal(v.status, 'partial', 'Partial — not Full, not Zero')
    assert.equal(v.unallocated, '25000.00', 'exactly ₹25,000.00')
    assert.equal(allocationBadgeState(v), 'partial')

    // What the RLS-limited read alone would have said, for contrast.
    const partialOnly = lines(buildAllocatedAgainst(payment('750000.55'), complete.slice(0, 1), covered))
    assert.equal(partialOnly.unallocated, '350000.30', 'the understated figure the old read produced')
  })

  test('zero, full and over, and reversed rows never reach the total', () => {
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment('3000'), [], covered)), 'zero',
      'a payment whose only allocation was reversed: the read returns no rows, so Zero')
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment('1000'), [
      order(ORDER_425, '0425', '600'), order(ORDER_431, '0431', '400')], covered)), 'full')
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment('100'), [
      order(ORDER_425, '0425', '60'), order(ORDER_431, '0431', '50')], covered)), 'over')
  })

  test('duplicates add into the status exactly once each', () => {
    const v = lines(buildAllocatedAgainst(payment('500'), [
      order(ORDER_425, '0425', '200'), order(ORDER_425, '0425', '300')], covered))
    assert.equal(v.status, 'full')
    assert.equal(v.lines.length, 1)
  })

  test('no confident status while the read is loading, failed, or did not cover the payment', () => {
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment('500'), null)), 'loading')
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment('500'), [], { readFailed: true })), 'unavailable')
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment('500'), [], { covered: false })), 'unavailable')
    assert.equal(allocationBadgeState(buildAllocatedAgainst(payment(null as unknown as string), [], covered)), 'unavailable',
      'an unreadable payment amount has no status')
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

  test('the badge is drawn from the same read as the cell, on desktop and mobile alike', () => {
    const occurrences = view.split('status={allocationBadgeState(allocatedAgainst(r))}').length - 1
    assert.equal(occurrences, 2, 'table and cards')
    assert.ok(!view.includes('status={r.confirmed_allocation_status}'), 'the RLS-limited status is drawn nowhere')
  })

  test('the filter, its count and the Allocate Funds offer use the complete computed status', () => {
    assert.ok(view.includes("scoped.eq('complete_allocation_status', filters.confirmedFilter)"))
    assert.ok(!view.includes("eq('confirmed_allocation_status'"), 'never the RLS-limited column')
    assert.ok(view.includes("return r.complete_allocation_status === 'zero' || r.complete_allocation_status === 'partial'"))
    // One query: the count is the same builder's count: exact.
    assert.ok(view.includes("`, { count: 'exact' })"))
  })

  test('Payments to Verify does not call it', () => {
    assert.ok(view.includes("if (surface === 'confirmed') void loadAllocationTargets(mapped, token)"))
  })
})

// ── The read boundary: 20261216000000 ────────────────────────────────────────

describe('20261216000000 — the complete targets read and the complete status', () => {
  const FILE = '20261216000000_received_payment_allocation_targets.sql'
  const sql = readFileSync(join('supabase', 'migrations', FILE), 'utf8').replace(/\r\n/g, '\n')
  const bodyOf = (name: string) => sql.slice(
    sql.indexOf(`create or replace function public.${name}(`),
    sql.indexOf(`comment on function public.${name}(`))
  const code = (name: string) => bodyOf(name).replace(/--[^\n]*/g, '')
  const visible = bodyOf('received_payment_visible_to_actor')
  const targets = code('received_payment_allocation_targets')
  const status = code('complete_allocation_status')
  const rule = code('received_payment_allocation_status')

  test('forward-only: it follows 20261215000000 and its version is unique', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.equal(files[i - 1], '20261215000000_payment_allocation_ledger_for_correction.sql')
  })

  test('every definer function is STABLE with a pinned search_path; the rule is IMMUTABLE', () => {
    for (const name of ['received_payment_visible_to_actor', 'received_payment_allocation_targets', 'complete_allocation_status']) {
      const c = code(name)
      assert.ok(c.includes('security definer'), name)
      assert.ok(c.includes('\nstable\n'), name)
      assert.ok(c.includes('set search_path = public, pg_temp'), name)
    }
    assert.ok(rule.includes('\nimmutable\n') && !rule.includes('security definer'))
    assert.ok(rule.includes('set search_path = public, pg_temp'))
  })

  test('both client-facing functions check auth.uid(), Finance entry and finance.view — in that order', () => {
    for (const c of [targets, status]) {
      const uid = c.search(/v_actor is null|auth\.uid\(\) is null/)
      const entry = c.indexOf("module_entry_open('finance')")
      const perm = c.indexOf("actor_has_module_permission('finance', 'view')")
      assert.ok(uid > 0 && entry > uid && perm > entry)
    }
    assert.ok(targets.indexOf('> 50') > targets.indexOf("actor_has_module_permission('finance', 'view')"),
      'the 50-id bound follows the permission checks')
  })

  test('both answer only for confirmed payments the caller may already read', () => {
    assert.ok(targets.includes('public.finance_payment_status_is_verified(f.status)'))
    assert.ok(targets.includes('public.received_payment_visible_to_actor(f.id)'))
    assert.ok(targets.includes("and a.status = 'active'"))
    assert.ok(targets.includes('where f.id = any (p_payment_request_ids)'))
    assert.ok(status.includes('public.finance_payment_status_is_verified(v_status)'))
    assert.ok(status.includes('public.received_payment_visible_to_actor(p_row.id)'))
    assert.ok(status.includes("and a.status = 'active'"))
  })

  test('the computed field trusts only the id of the row it is handed', () => {
    assert.ok(status.includes('from public.finance_payment_requests f\n  where f.id = p_row.id'),
      'amount and status are read from the base table')
    assert.ok(!/p_row\.(amount|status|confirmed_allocation_status)/.test(status), 'never from the row')
    assert.ok(status.includes('return public.received_payment_allocation_status(v_amount, v_total)'),
      'and classified by the one rule')
  })

  test('the one status rule: zero / partial / full / over, and its apply-time checks', () => {
    for (const piece of ["<= 0          then 'zero'", "> p_amount    then 'over'", "= p_amount    then 'full'", "else 'partial'"]) {
      assert.ok(rule.includes(piece), piece)
    }
    assert.ok(sql.includes("public.received_payment_allocation_status(750000.55, 725000.55) <> 'partial'"))
  })

  test('returns display fields only — never source_order_number or a client', () => {
    for (const c of [targets, status]) {
      assert.ok(!c.includes('source_order_number'))
      assert.ok(!c.includes('client_name'))
    }
    assert.ok(sql.includes("'TABLE(payment_request_id uuid, allocation_id uuid, target_type text, target_id uuid, target_reference text, reserved_order_number text, allocated_amount numeric)'"),
      'the apply-time assertion pins the exact result shape')
  })

  test('writes nothing and redefines no view', () => {
    for (const c of [targets, status, code('received_payment_visible_to_actor'), rule]) {
      assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(c))
    }
    const ddl = sql.replace(/--[^\n]*/g, '')
    assert.ok(!/create\s+(or\s+replace\s+)?view/i.test(ddl), 'finance_received_payments is not redefined')
  })

  test('EXECUTE: the two client functions to authenticated only; the two helpers to nobody', () => {
    for (const sig of ['received_payment_allocation_targets(uuid[])', 'complete_allocation_status(public.finance_received_payments)']) {
      for (const role of ['public', 'anon', 'service_role']) {
        assert.ok(sql.includes(`revoke all on function public.${sig} from ${role};`), `${sig} ${role}`)
      }
      assert.ok(sql.includes(`grant execute on function public.${sig} to authenticated;`), sig)
    }
    for (const sig of ['received_payment_visible_to_actor(uuid)', 'received_payment_allocation_status(numeric, numeric)']) {
      for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
        assert.ok(sql.includes(`revoke all on function public.${sig} from ${role};`), `${sig} ${role}`)
      }
      assert.ok(!sql.includes(`grant execute on function public.${sig}`), `${sig} is granted to nobody`)
    }
  })

  test('changes no table, column, policy or permission, and proves it at apply time', () => {
    const ddl = sql.replace(/--[^\n]*/g, '').replace('create temporary table targets_policy_snapshot', '')
    assert.ok(!/\b(create|alter|drop)\s+(policy|table\s+public|index)\b/i.test(ddl))
    assert.ok(!/\bpermission_actions\b|\brole_permissions\b/.test(ddl))
    for (const needle of ['a payment or allocation RLS policy changed', 'must be SECURITY DEFINER', 'must be STABLE',
      'must pin search_path', 'anon must NOT', 'service_role must NOT', 'PUBLIC must NOT',
      'authenticated must be able', 'must be executable by its owner only', 'the status rule is wrong']) {
      assert.ok(sql.includes(needle), needle)
    }
  })

  test('the visibility helper mirrors EVERY live permissive SELECT policy on finance_payment_requests', () => {
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
      assert.ok(visible.includes(`-- ${name}`), `the helper must mirror ${name}`)
    }
  })

  test('an executable suite proves it on a disposable database', () => {
    const runner = readFileSync(join('supabase', 'tests', 'run_received_payment_allocation_targets_suite.sh'), 'utf8')
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('the partial-RLS defect did not reproduce'))
    const suite = readFileSync(join('supabase', 'tests', 'received_payment_allocation_targets_assertions.sql'), 'utf8')
    for (const needle of [
      '0b. reproduced: the RLS projection classifies full PAY5 and over PAY8 as partial for P',
      '1. finance.view participant without view_all: complete targets',
      '2. reversed excluded; duplicate active rows returned separately',
      '3. PI Draft: file name or reserved Order number, never source_order_number',
      '4a. admin', '4b. view_all', '5. unrelated payment access: nothing returned',
      '6. no Finance entry', '7. inactive user', '8. authenticated role with no user',
      '9a. anon', '9b. service_role', '10. at most 50 ids',
      '11. complete status for P (finance.view, no view_all): PAY1 partial (725000.55, 25000.00 left)',
      '12. filters for P: zero 1, partial 1, full 1, over 1',
      '13a. admin: PAY2 and PAY4 full; a forged amount in the row is ignored',
      '13b. unrelated reader handing in a forged row: null',
      '14a. computed field, no Finance entry', '14b. computed field, inactive user',
      '14c. computed field, no user', '14d. computed field, anon', '14e. computed field, service_role',
      '15. internal helpers: not executable by authenticated',
      '16. create or replace view appending a column succeeds',
      '17. no payment, allocation, Order, PI, permission or policy changed']) {
      assert.ok(suite.includes(needle), needle)
    }
  })
})

// ── Safe names on every surface (go-live readiness, 2026-09-18) ──────────────
//
// The live review found the payment detail panel saying "A PI Draft" beside a
// list row that said "PI Draft · Reserved Order 0526", and the per-page RLS
// name lookup (Delete confirmation) still naming a PI by source_order_number —
// the older PI's number the list was forbidden to show.

describe('one safe name for a destination, wherever it is printed', () => {
  test('without the kind word: Order display number, reserved number, workbook — never B20', () => {
    assert.equal(allocationTargetName({ target_type: 'order', target_reference: '0526', reserved_order_number: null }), '0526')
    assert.equal(allocationTargetName({ target_type: 'pi_draft', target_reference: 'x.xlsx', reserved_order_number: '0526' }), 'Reserved Order 0526')
    assert.equal(allocationTargetName({ target_type: 'pi_draft', target_reference: 'x.xlsx', reserved_order_number: null }), 'x.xlsx')
    assert.equal(allocationTargetName({ target_type: 'pi_draft', target_reference: null, reserved_order_number: null }), null)
  })

  test('the RLS read of a PI Draft uses the same rule and never source_order_number', () => {
    assert.equal(piDraftSafeName({ reserved_order_number: '0526', source_workbook_name: 'a.xlsx' }), 'Reserved Order 0526')
    assert.equal(piDraftSafeName({ reserved_order_number: null, source_workbook_name: 'C:/fakepath/Hotel ABC.xlsx' }), 'Hotel ABC.xlsx')
    assert.equal(piDraftSafeName({ reserved_order_number: '  ', source_workbook_name: '' }), 'Draft')
    const view = readFileSync(join('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx'), 'utf8')
    const code = view.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    assert.ok(!code.includes('source_order_number'), 'the list page never reads the workbook B20 number')
    assert.equal(code.split("select('id, reserved_order_number, source_workbook_name')").length - 1, 2)
  })

  test('the detail panel is named from the complete read, keeping any name it already has', () => {
    const names = allocationTargetNames([
      row({ target_type: 'pi_draft', target_id: PI_HOTEL, target_reference: 'Hotel ABC.xlsx', reserved_order_number: '0526', allocated_amount: '1' }),
      row({ target_type: 'order', target_id: ORDER_425, target_reference: '0425', allocated_amount: '1' }),
    ])
    const summary = {
      paymentId: PAY, state: 'full' as const, allocated: '2', unallocated: '0',
      targets: [
        { allocationId: 'a', kind: 'submission' as const, targetId: PI_HOTEL, label: null, amount: '1' },
        { allocationId: 'b', kind: 'order' as const, targetId: ORDER_425, label: 'kept', amount: '1' },
        { allocationId: 'c', kind: 'order' as const, targetId: 'unknown', label: null, amount: '0' },
      ],
    }
    const named = nameSummaryTargets(summary, names)
    assert.deepEqual(named.targets.map(t => t.label), ['Reserved Order 0526', 'kept', null])
    assert.equal(nameSummaryTargets(summary, new Map()), summary, 'no names: the summary is returned untouched')
    const view = readFileSync(join('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(/allocation=\{nameSummaryTargets\([\s\S]{0,200}?allocationTargetNames\(allocationTargets\.rows\)\)\}/.test(view))
  })
})

describe('the Paid date range fits a 320px phone', () => {
  test('the row wraps instead of refusing to shrink, and "to" travels with its date', () => {
    const view = readFileSync(join('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx'), 'utf8')
    const at = view.indexOf('htmlFor="payment-date-from"')
    const container = view.slice(view.lastIndexOf('<div style={{', at), at)
    assert.ok(container.includes("flexWrap: 'wrap'") && container.includes("maxWidth: '100%'"))
    assert.ok(!container.includes('flexShrink: 0'))
    const pair = view.slice(at, view.indexOf('id="payment-date-to"'))
    assert.ok(pair.includes("<span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>"))
  })
})
