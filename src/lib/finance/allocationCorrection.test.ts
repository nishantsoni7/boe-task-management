/**
 * CORRECT ALLOCATION — the rules, the complete-ledger read and the send path,
 * without a browser.
 *
 * The screen is src/app/finance/received/CorrectAllocationModal.tsx; its rules
 * and its network paths are src/lib/finance/allocationCorrection.ts, tested
 * here against a fake client that records every call.
 *
 * THE LEDGER IS ONLY EVER READ WHOLE. Since 20261215000000 every figure comes
 * from payment_allocation_ledger_for_correction(), never from a direct read of
 * finance_payment_allocations, whose participant RLS is per row. The database
 * half — who may call it, completeness for a participant corrector, refusals,
 * "writes nothing" — is executed by
 * supabase/tests/run_payment_allocation_ledger_suite.sh on a disposable
 * database; this file pins the application half and the migration's shape.
 *
 * Amounts are deliberately not round (₹7,50,000.55 split 4,00,000.25 /
 * 2,00,000.20 / 1,50,000.10) so a sum taken from the wrong field, or in float,
 * cannot pass by coincidence.
 *
 * Run:
 *   npx tsx --test src/lib/finance/allocationCorrection.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  ALLOCATION_LEDGER_RPC,
  buildAllocationLedger,
  correctionBlockedReason,
  correctionPosition,
  ledgerReadErrorMessage,
  ledgerTargetName,
  loadAllocationLedger,
  performAllocationReversal,
  reversalErrorMessage,
  staleAllocationReason,
  unallocatedAfterReversal,
  CORRECTION_REASON_MAX,
  type AllocationLedgerEntry,
  type LedgerRpcRow,
} from './allocationCorrection'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import type { EffectivePermission } from '@/lib/permissions/types'

const ORDER_524 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_529 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PI_019    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PAYMENT   = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp'

const PAYMENT_AMOUNT = '750000.55'

const read = (...p: string[]) => readFileSync(join(...p), 'utf8').split('\r\n').join('\n')

/** One row exactly as payment_allocation_ledger_for_correction() returns it. */
function rpcRow(id: string, amount: string, target: { order?: string; submission?: string }, extra: Partial<LedgerRpcRow> = {}): LedgerRpcRow {
  const ref = target.order === ORDER_524 ? '0524' : target.order === ORDER_529 ? '0529' : '019'
  const client = target.order === ORDER_529 ? 'Cafe Verde' : 'Hotel Aurum'
  return {
    allocation_id: id,
    status: 'active',
    allocated_amount: amount,
    order_id: target.order ?? null,
    order_submission_id: target.submission ?? null,
    target_reference: ref,
    client_name: client,
    created_at: '2026-09-10T05:00:00.000Z',
    reversed_at: null,
    reversal_reason: null,
    reversed_by_name: null,
    ...extra,
  }
}

/** The complete ledger of a split payment: two Orders and one PI Draft, fully allocated. */
const SPLIT_ROWS: LedgerRpcRow[] = [
  rpcRow('alloc-1', '400000.25', { order: ORDER_524 },   { created_at: '2026-09-10T05:00:00.000Z' }),
  rpcRow('alloc-2', '200000.20', { order: ORDER_529 },   { created_at: '2026-09-10T06:00:00.000Z' }),
  rpcRow('alloc-3', '150000.10', { submission: PI_019 }, { created_at: '2026-09-10T07:00:00.000Z' }),
]
const splitLedger = (): AllocationLedgerEntry[] => buildAllocationLedger(SPLIT_ROWS)

// ─────────────────────────────────────────────────────────────────────────────

describe('the ledger this screen shows', () => {
  test('a split payment lists every allocation with its target, customer and amount', () => {
    assert.deepEqual(
      splitLedger().map(e => [ledgerTargetName(e), e.clientName, e.amount, e.status]),
      [
        ['Order 0524',   'Hotel Aurum', '400000.25', 'active'],
        ['Order 0529',   'Cafe Verde',  '200000.20', 'active'],
        ['PI Draft 019', 'Hotel Aurum', '150000.10', 'active'],
      ])
  })

  test('mixed PI Draft and Order allocations keep their own kind', () => {
    assert.deepEqual(splitLedger().map(e => e.kind), ['order', 'order', 'submission'])
  })

  test('a reversed allocation stays in the ledger, after the active ones, with actor, time and reason', () => {
    const ledger = buildAllocationLedger([
      rpcRow('alloc-old', '100000.00', { order: ORDER_524 }, {
        status: 'reversed',
        reversed_at: '2026-09-12T09:30:00.000Z',
        reversal_reason: 'Customer asked to adjust against Order 529',
        reversed_by_name: 'Asha Finance',
      }),
      rpcRow('alloc-new', '100000.00', { order: ORDER_529 }),
    ])
    assert.deepEqual(ledger.map(e => e.status), ['active', 'reversed'])
    const reversed = ledger[1]
    assert.equal(reversed.reversedByName, 'Asha Finance')
    assert.equal(reversed.reversedAt, '2026-09-12T09:30:00.000Z')
    assert.equal(reversed.reversalReason, 'Customer asked to adjust against Order 529')
    assert.equal(ledgerTargetName(reversed), 'Order 0524', 'the original target is still named')
  })

  test('a row with no reference is named by its kind, never by a uuid', () => {
    const [entry] = buildAllocationLedger([rpcRow('x', '10.00', { order: ORDER_524 }, { target_reference: null })])
    assert.equal(ledgerTargetName(entry), 'A Confirmed Order')
  })
})

describe('the payment position before and after a reversal', () => {
  test('a fully allocated split payment shows zero unallocated, exactly', () => {
    const pos = correctionPosition(PAYMENT_AMOUNT, splitLedger())
    assert.equal(pos.allocated, '750000.55')
    assert.equal(pos.unallocated, '0.00')
    assert.equal(pos.activeCount, 3)
  })

  test('reversing releases the WHOLE allocation into the unallocated balance', () => {
    assert.equal(unallocatedAfterReversal(PAYMENT_AMOUNT, splitLedger(), 'alloc-2'), '200000.20')
  })

  test('reversed allocations never count as allocated', () => {
    const ledger = splitLedger().map(e => e.allocationId === 'alloc-1' ? { ...e, status: 'reversed' as const } : e)
    const pos = correctionPosition(PAYMENT_AMOUNT, ledger)
    assert.equal(pos.allocated, '350000.30')
    assert.equal(pos.unallocated, '400000.25')
  })

  test('the payment amount is an input only — nothing here produces a new amount', () => {
    const before = correctionPosition(PAYMENT_AMOUNT, splitLedger())
    const after = correctionPosition(PAYMENT_AMOUNT, splitLedger().filter(e => e.allocationId !== 'alloc-3'))
    assert.deepEqual([before.allocated, before.unallocated], ['750000.55', '0.00'])
    assert.deepEqual([after.allocated, after.unallocated], ['600000.45', '150000.10'])
  })
})

describe('what stops the person before anything is sent', () => {
  const [first] = splitLedger()

  test('an allocation must be chosen', () => {
    assert.match(correctionBlockedReason({ selected: null, reason: 'x' }) ?? '', /Choose the allocation/)
  })

  test('the reason is mandatory, and whitespace is not a reason', () => {
    assert.match(correctionBlockedReason({ selected: first, reason: '' }) ?? '', /reason/)
    assert.match(correctionBlockedReason({ selected: first, reason: '   \n ' }) ?? '', /reason/)
    assert.equal(correctionBlockedReason({ selected: first, reason: 'Wrong Order' }), null)
  })

  test('an over-long reason is refused before it reaches the server', () => {
    assert.match(correctionBlockedReason({ selected: first, reason: 'x'.repeat(CORRECTION_REASON_MAX + 1) }) ?? '', /under/)
  })

  test('a reversed allocation cannot be chosen again', () => {
    assert.match(correctionBlockedReason({ selected: { ...first, status: 'reversed' }, reason: 'x' }) ?? '', /already been reversed/)
  })

  test('a fully allocated payment can still be corrected', () => {
    assert.equal(correctionPosition(PAYMENT_AMOUNT, splitLedger()).unallocated, '0.00')
    assert.equal(correctionBlockedReason({ selected: first, reason: 'Wrong Order' }), null)
  })
})

describe('stale screens and concurrent corrections', () => {
  const [shown, , pi] = splitLedger()

  test('an unchanged allocation is not stale', () => {
    assert.equal(staleAllocationReason(shown, { ...shown }), null)
  })

  test('already reversed by somebody else', () => {
    assert.match(staleAllocationReason(shown, { ...shown, status: 'reversed' }) ?? '', /Someone else has already reversed/)
  })

  test('moved from its PI Draft onto the Order the PI became', () => {
    const moved: AllocationLedgerEntry = { ...pi, kind: 'order', targetId: ORDER_529 }
    assert.match(staleAllocationReason(pi, moved) ?? '', /different record/)
  })

  test('no longer in the complete ledger', () => {
    assert.match(staleAllocationReason(shown, null) ?? '', /can no longer be found/)
  })

  test('every stale message says nothing was changed', () => {
    for (const msg of [
      staleAllocationReason(shown, null),
      staleAllocationReason(shown, { ...shown, status: 'reversed' }),
      staleAllocationReason(shown, { ...shown, targetId: ORDER_529 }),
      staleAllocationReason(shown, { ...shown, amount: '1.00' }),
    ]) {
      assert.match(msg ?? '', /Nothing was changed/)
    }
  })
})

describe('server refusals are worded, and say that nothing changed', () => {
  test('reversal: permission refused (42501)', () => {
    const msg = reversalErrorMessage('You do not have permission to correct payment allocations', '42501')
    assert.match(msg, /do not have permission/)
    assert.match(msg, /Nothing was changed/)
    assert.match(msg, /Correct Payment Allocations/, 'names the permission as the Access Control screen does')
  })
  test('reversal: blank reason', () => assert.match(reversalErrorMessage('ALLOCATION_REASON_REQUIRED: …'), /reason is required/))
  test('reversal: not found', () => assert.match(reversalErrorMessage('ALLOCATION_NOT_FOUND: allocation x not found'), /can no longer be found/))
  test('reversal: unknown text never leaks', () => {
    const msg = reversalErrorMessage('relation "finance_payment_allocations" does not exist')
    assert.ok(!msg.includes('relation'))
    assert.match(msg, /Nothing was changed/)
  })

  test('ledger read: every refusal is worded and says nothing changed', () => {
    for (const [raw, code, re] of [
      ['ALLOCATION_LEDGER_AUTH_REQUIRED: sign in', '28000', /session has ended/],
      ['ALLOCATION_LEDGER_NOT_PERMITTED: …', '42501', /do not have permission/],
      ['ALLOCATION_LEDGER_PAYMENT_NOT_FOUND: …', 'P0002', /not available to you/],
      ['connection reset', null, /could not be loaded/],
    ] as const) {
      const msg = ledgerReadErrorMessage(raw, code)
      assert.match(msg, re)
      assert.match(msg, /Nothing was changed/)
      assert.ok(!msg.includes('ALLOCATION_LEDGER'), 'no raw code reaches the screen')
    }
  })
})

// ── The fake client: two RPCs, and any table access is a defect ──────────────

type Call = { fn: string; args: unknown }

function fakeClient(opts: {
  /** What the ledger RPC returns, in order, one entry per call. */
  ledgers?: ({ data: LedgerRpcRow[] } | { error: { message: string; code?: string } })[]
  reverse?: { data?: unknown; error?: { message: string; code?: string } }
}) {
  const calls: Call[] = []
  const ledgers = [...(opts.ledgers ?? [])]
  const client = {
    from(table: string) {
      throw new Error(`direct table access to ${table} — the ledger must come from the RPC`)
    },
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args })
      if (fn === ALLOCATION_LEDGER_RPC) {
        const next = ledgers.shift() ?? { error: { message: 'no more fixture ledgers' } }
        return 'data' in next ? { data: next.data, error: null } : { data: null, error: next.error }
      }
      if (fn === 'reverse_payment_allocation') {
        return { data: opts.reverse?.data ?? null, error: opts.reverse?.error ?? null }
      }
      throw new Error(`unexpected rpc ${fn}`)
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls }
}

describe('loadAllocationLedger — complete or nothing', () => {
  test('reads through the RPC for exactly one payment, never the table', async () => {
    const { client, calls } = fakeClient({ ledgers: [{ data: SPLIT_ROWS }] })
    const out = await loadAllocationLedger(client, PAYMENT)
    assert.equal(out.readable, true)
    assert.equal(out.entries.length, 3)
    assert.deepEqual(calls, [{ fn: ALLOCATION_LEDGER_RPC, args: { p_payment_request_id: PAYMENT } }])
  })

  test('THE DEFECT CASE: a participant who can open only Order 0524 still gets the full figures', async () => {
    // Before 20261215000000 this reader's direct RLS read returned alloc-1 alone:
    // allocated ₹4,00,000.25 and "unallocated" ₹3,50,000.30 — both wrong. The
    // RPC returns the whole ledger to an authorized corrector, so the figures
    // are the payment's own.
    const { client } = fakeClient({ ledgers: [{ data: SPLIT_ROWS }] })
    const out = await loadAllocationLedger(client, PAYMENT)
    const partial = correctionPosition(PAYMENT_AMOUNT, buildAllocationLedger(SPLIT_ROWS.slice(0, 1)))
    const full = correctionPosition(PAYMENT_AMOUNT, out.entries)
    assert.deepEqual([partial.allocated, partial.unallocated], ['400000.25', '350000.30'], 'what the partial read showed')
    assert.deepEqual([full.allocated, full.unallocated, full.activeCount], ['750000.55', '0.00', 3], 'what is true')
    assert.deepEqual([...new Set(out.entries.map(e => e.clientName))].sort(), ['Cafe Verde', 'Hotel Aurum'],
      'every existing customer, including those on records the reader cannot open')
  })

  test('a refusal is unreadable with a sentence — no entries, no fallback', async () => {
    for (const error of [
      { message: 'ALLOCATION_LEDGER_NOT_PERMITTED: …', code: '42501' },
      { message: 'ALLOCATION_LEDGER_PAYMENT_NOT_FOUND: …', code: 'P0002' },
      { message: 'fetch failed' },
    ]) {
      const { client, calls } = fakeClient({ ledgers: [{ error }] })
      const out = await loadAllocationLedger(client, PAYMENT)
      assert.equal(out.readable, false)
      assert.deepEqual(out.entries, [])
      assert.match((out as { message: string }).message, /Nothing was changed/)
      assert.equal(calls.length, 1, 'no second, weaker read is attempted')
    }
  })
})

describe('performAllocationReversal', () => {
  const [target] = splitLedger()

  test('success is reported only from the server answer, with the server balance', async () => {
    const { client, calls } = fakeClient({
      ledgers: [{ data: SPLIT_ROWS }],
      reverse: { data: { already_reversed: false, unallocated_balance: 400000.25, reversed_at: '2026-09-18T10:00:00Z' } },
    })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: target, reason: '  Wrong Order  ' })
    assert.deepEqual(out, { kind: 'reversed', unallocatedBalance: '400000.25', reversedAt: '2026-09-18T10:00:00Z' })
    // One complete re-read and one reversal — no payment write, no new
    // allocation, no copy of anything, no direct table access.
    assert.deepEqual(calls, [
      { fn: ALLOCATION_LEDGER_RPC, args: { p_payment_request_id: PAYMENT } },
      { fn: 'reverse_payment_allocation', args: { p_allocation_id: 'alloc-1', p_reason: 'Wrong Order' } },
    ])
  })

  test('an allocation on a record the corrector cannot open is still judged, not reported missing', async () => {
    // alloc-2 is on Order 0529, which the participant corrector cannot open.
    // A direct RLS re-read would have returned nothing and blocked the
    // correction as "no longer found"; the complete ledger contains it.
    const hidden = splitLedger()[1]
    const { client } = fakeClient({ ledgers: [{ data: SPLIT_ROWS }], reverse: { data: { unallocated_balance: '200000.20' } } })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: hidden, reason: 'Wrong Order' })
    assert.equal(out.kind, 'reversed')
  })

  test('a missing reason never reaches the server', async () => {
    const { client, calls } = fakeClient({ ledgers: [{ data: SPLIT_ROWS }] })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: target, reason: '  ' })
    assert.equal(out.kind, 'refused')
    assert.equal(calls.length, 0)
  })

  test('a stale allocation is refused before the reversal is sent', async () => {
    const reversed = SPLIT_ROWS.map(r => r.allocation_id === 'alloc-1' ? { ...r, status: 'reversed' } : r)
    const { client, calls } = fakeClient({ ledgers: [{ data: reversed }] })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'stale')
    assert.ok(!calls.some(c => c.fn === 'reverse_payment_allocation'), 'nothing may be sent for a stale allocation')
  })

  test('if the complete ledger cannot be re-read, nothing is sent', async () => {
    const { client, calls } = fakeClient({ ledgers: [{ error: { message: 'fetch failed' } }] })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'refused')
    assert.match((out as { message: string }).message, /Nothing was changed/)
    assert.ok(!calls.some(c => c.fn === 'reverse_payment_allocation'))
  })

  test('a race lost in the last milliseconds is reported as already reversed, not as success', async () => {
    const { client } = fakeClient({ ledgers: [{ data: SPLIT_ROWS }], reverse: { data: { already_reversed: true } } })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'already_reversed')
    assert.match((out as { message: string }).message, /Nothing was changed by you/)
  })

  test('the server refusing the permission is shown as a refusal', async () => {
    const { client } = fakeClient({
      ledgers: [{ data: SPLIT_ROWS }],
      reverse: { error: { message: 'You do not have permission to correct payment allocations', code: '42501' } },
    })
    const out = await performAllocationReversal(client, { paymentId: PAYMENT, allocation: target, reason: 'Wrong Order' })
    assert.equal(out.kind, 'refused')
    assert.match((out as { message: string }).message, /do not have permission/)
  })
})

describe('no screen assembles the ledger from a direct table read', () => {
  test('allocationCorrection.ts never reads finance_payment_allocations itself', () => {
    const src = read('src', 'lib', 'finance', 'allocationCorrection.ts')
    assert.ok(!/\.from\(/.test(src), 'every read goes through the RPC')
  })
  test('neither modal reads the allocation table directly', () => {
    for (const file of ['CorrectAllocationModal.tsx', 'AllocateFundsModal.tsx']) {
      const src = read('src', 'app', 'finance', 'received', file)
      assert.ok(!src.includes("from('finance_payment_allocations')"), `${file} must not read allocations directly`)
    }
  })
})

// ── Who may see the control ──────────────────────────────────────────────────

function perm(actionKey: string): EffectivePermission {
  return { actionKey, allowed: true } as unknown as EffectivePermission
}

describe('who is offered Correct Allocation', () => {
  test('nobody without finance.allocate_correct', () => {
    assert.equal(deriveFinanceCapabilities('employee', []).canCorrectPaymentAllocation, false)
    assert.equal(deriveFinanceCapabilities('employee', [perm('view')]).canCorrectPaymentAllocation, false)
  })

  test('finance.allocate alone does not confer it', () => {
    const caps = deriveFinanceCapabilities('employee', [perm('view'), perm('allocate')])
    assert.equal(caps.canAllocatePayment, true)
    assert.equal(caps.canCorrectPaymentAllocation, false)
  })

  test('finance.allocate_correct with module entry does — and it does not imply view_all', () => {
    const caps = deriveFinanceCapabilities('employee', [perm('view'), perm('allocate_correct')])
    assert.equal(caps.canCorrectPaymentAllocation, true)
    assert.equal(caps.canAllocatePayment, false, 'and it does not confer allocating')
    assert.equal(caps.canViewAllFinance, false, 'the defect case: a corrector need not see every payment')
  })

  test('a leftover allocate_correct grant without Finance entry draws nothing', () => {
    assert.equal(deriveFinanceCapabilities('employee', [perm('allocate_correct')]).canCorrectPaymentAllocation, false)
  })

  test('an administrator is offered it, matching actor_has_module_permission', () => {
    assert.equal(deriveFinanceCapabilities('admin', []).canCorrectPaymentAllocation, true)
  })

  test('the page passes the control only to a holder of the capability', () => {
    const view = read('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx')
    assert.ok(/onCorrectAllocation=\{caps\.canCorrectPaymentAllocation\s*\?/.test(view),
      'the Correct Allocation door must be gated on canCorrectPaymentAllocation')
  })
})

// ── The complete-ledger read: 20261215000000 ─────────────────────────────────

describe('payment_allocation_ledger_for_correction() — the read boundary', () => {
  const FILE = '20261215000000_payment_allocation_ledger_for_correction.sql'
  const sql = read('supabase', 'migrations', FILE)
  const body = sql.slice(
    sql.indexOf('create or replace function public.payment_allocation_ledger_for_correction('),
    sql.indexOf('comment on function public.payment_allocation_ledger_for_correction('))
  const code = body.replace(/--[^\n]*/g, '')

  test('it is forward-only: it follows the last migration that existed, with a unique version', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1, 'its version is unique')
    assert.equal(files[i - 1], '20261213000000_meeting_order_discussion_workflow.sql',
      'nothing may be inserted before it, which would re-order applied history')
  })

  test('SECURITY DEFINER, STABLE, with a pinned search_path', () => {
    assert.ok(code.includes('security definer'))
    assert.ok(code.includes('\nstable\n'), 'STABLE, so PostgreSQL refuses any write inside it')
    assert.ok(code.includes('set search_path = public, pg_temp'))
  })

  test('checks auth.uid(), Finance entry and finance.allocate_correct — in that order', () => {
    const uid = code.indexOf('v_actor is null')
    const entry = code.indexOf("module_entry_open('finance')")
    const perm = code.indexOf("actor_has_module_permission('finance', 'allocate_correct')")
    assert.ok(uid > 0 && entry > uid && perm > entry)
    assert.ok(!code.includes("'allocate')"), 'finance.allocate is not an alternative')
  })

  test('refuses a missing and an invisible payment with the same error', () => {
    assert.ok(code.includes('v_visible boolean := false'))
    assert.equal((code.match(/ALLOCATION_LEDGER_PAYMENT_NOT_FOUND/g) ?? []).length, 1)
  })

  test('returns rows for the requested payment only', () => {
    assert.ok(code.includes('where a.payment_request_id = p_payment_request_id'))
  })

  test('writes nothing', () => {
    assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(code))
  })

  test('EXECUTE: revoked from PUBLIC, anon and service_role; granted to authenticated only', () => {
    for (const role of ['public', 'anon', 'service_role']) {
      assert.ok(sql.includes(`revoke all on function public.payment_allocation_ledger_for_correction(uuid) from ${role};`), role)
    }
    const grants = sql.match(/grant execute on function public\.payment_allocation_ledger_for_correction\(uuid\) to (\w+);/g) ?? []
    assert.deepEqual(grants, ['grant execute on function public.payment_allocation_ledger_for_correction(uuid) to authenticated;'])
  })

  test('changes no table, column, policy or permission', () => {
    const ddl = sql.replace(/--[^\n]*/g, '')
    assert.ok(!/\b(create|alter|drop)\s+(policy|table\s+public|index)\b/i.test(ddl.replace('create temporary table ledger_policy_snapshot', '')))
    assert.ok(!/\bpermission_actions\b|\brole_permissions\b/.test(ddl))
    assert.ok(ddl.includes('a payment or allocation RLS policy changed'), 'the migration proves it at apply time')
  })

  test('its apply-time assertions cover definer, volatility, search_path and every EXECUTE grant', () => {
    for (const needle of ['must be SECURITY DEFINER', 'must be STABLE', 'must pin search_path',
      'anon must NOT', 'service_role must NOT', 'PUBLIC must NOT', 'authenticated must be able']) {
      assert.ok(sql.includes(needle), needle)
    }
  })

  test('its visibility rule mirrors EVERY live permissive SELECT policy on finance_payment_requests', () => {
    // Replay every create/drop policy in migration order. If a SELECT policy is
    // ever added or removed, this list changes and the RPC must be revisited.
    const live = new Map<string, string>()
    for (const f of readdirSync(join('supabase', 'migrations')).sort()) {
      const text = read('supabase', 'migrations', f).replace(/--[^\n]*/g, '')
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
    const runner = read('supabase', 'tests', 'run_payment_allocation_ledger_suite.sh')
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('the partial-RLS defect did not reproduce'), 'the defect is reproduced before the fix')
    const suite = read('supabase', 'tests', 'payment_allocation_ledger_assertions.sql')
    for (const needle of ['1. admin: full ledger', '2. view_all + allocate_correct', '3. participant + allocate_correct',
      '4. unrelated payment', '5. finance.allocate only', '6. finance.view only', '7. allocate_correct without Finance entry',
      '8. inactive user', '9. authenticated role with no user', '10a. anon', '10b. service_role', '11. missing payment',
      '12. no payment, allocation, permission or policy changed']) {
      assert.ok(suite.includes(needle), needle)
    }
  })
})

// ── The reversal RPC is unchanged and is the only write path ─────────────────

describe('reverse_payment_allocation() is the only write path, and it decides', () => {
  const sql = read('supabase', 'migrations', '20260918000000_finance_payment_allocations.sql')
  const body = sql.slice(
    sql.indexOf('create or replace function public.reverse_payment_allocation('),
    sql.indexOf('comment on function public.reverse_payment_allocation('))

  test('it requires finance.allocate_correct, not finance.allocate', () => {
    assert.ok(body.includes("actor_has_module_permission('finance', 'allocate_correct')"))
    assert.ok(!body.includes("'allocate')"))
  })

  test('it refuses a blank reason', () => assert.ok(body.includes('ALLOCATION_REASON_REQUIRED')))

  test('it locks the payment, then the allocation', () => {
    const pay = body.indexOf('from public.finance_payment_requests')
    const alloc = body.lastIndexOf('from public.finance_payment_allocations\n  where id = p_allocation_id\n  for update')
    assert.ok(pay > 0 && body.slice(pay, pay + 120).includes('for update'), 'the payment is locked')
    assert.ok(alloc > pay, 'the allocation is locked after the payment')
  })

  test('it keeps the row — an UPDATE to reversed, never a DELETE, never an INSERT', () => {
    assert.ok(body.includes("set status          = 'reversed'"))
    assert.ok(!/\bdelete\s+from\b/i.test(body))
    assert.ok(!/\binsert\s+into\b/i.test(body))
    assert.ok(!/update\s+public\.finance_payment_requests/i.test(body), 'the payment row is not written')
  })

  test('it is idempotent and says so', () => assert.ok(body.includes("'already_reversed',     true")))

  test('the SQL suite proves an allocate-only caller is refused', () => {
    const suite = read('supabase', 'tests', 'finance_payment_allocation_assertions.sql')
    assert.ok(suite.includes("'finance.allocate alone must not be able to reverse an allocation'"))
    assert.ok(suite.includes("'reversal must PRESERVE the row — nothing may be deleted'"))
  })

  test('PI and Order totals count ACTIVE allocations only, so a reversal moves them', () => {
    const order = read('supabase', 'migrations', '20261012000000_allocation_ledger_as_single_source.sql')
    assert.ok(order.slice(order.indexOf('create or replace function public.order_linked_payment_total')).slice(0, 2000).includes("a.status = 'active'"))
    const pi = read('supabase', 'migrations', '20261119000000_order_submission_pi_review_gate_versions_and_production.sql')
    assert.ok(pi.slice(pi.indexOf('create or replace function public.pi_submission_payment_summary')).slice(0, 6000).includes("a.status = 'active'"))
  })
})
