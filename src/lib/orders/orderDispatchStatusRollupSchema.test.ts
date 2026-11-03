/**
 * 20270528000000: dispatch drives the Order's status. These are the text-level
 * facts about the migration; the BEHAVIOUR is proven by executing it, in
 * supabase/tests/order_dispatch_status_pglite.mjs (32 checks), because a text
 * test can pass while an apply aborts.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderDispatchStatusRollupSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const FILE = '20270528000000_order_dispatch_status_rollup.sql'
const sql = readFileSync(`supabase/migrations/${FILE}`, 'utf8')
const page = readFileSync('src/app/orders/[id]/page.tsx', 'utf8')

/** The statuses one `when 'x' then array[...]` arm allows, from the migration's graph. */
function sqlArm(status: string): string[] {
  const m = new RegExp(`when '${status}'\\s+then array\\[([^\\]]*)\\]`).exec(sql.slice(sql.indexOf("v_allowed := case old.status\n    when 'running'")))
  assert.ok(m, `no arm for ${status}`)
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
}

/** The same arm from the Order page's TRANSITION_GRAPH. */
function pageArm(status: string): string[] {
  const m = new RegExp(`^  ${status}:\\s+\\[([^\\]]*)\\]`, 'm').exec(page.slice(page.indexOf('const TRANSITION_GRAPH')))
  assert.ok(m, `no arm for ${status}`)
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
}

describe('the status graph: the database and the Order page agree, as 20260819000000 required', () => {
  for (const status of ['running', 'on_hold', 'ready_for_dispatch']) {
    test(`${status}`, () => {
      assert.deepEqual([...sqlArm(status)].sort(), [...pageArm(status)].sort())
    })
  }

  test('Ready for Dispatch can go back to Running, and nothing else changed', () => {
    assert.deepEqual(sqlArm('running'), ['on_hold', 'ready_for_dispatch', 'cancelled'])
    assert.deepEqual(sqlArm('on_hold'), ['running', 'cancelled'])
    assert.deepEqual(sqlArm('ready_for_dispatch'), ['running', 'dispatched', 'cancelled'])
  })
})

describe('what the migration does and does not do', () => {
  test('it is later than every migration before it, so it applies last', () => {
    const others = readdirSync('supabase/migrations').filter(f => f !== FILE && /^\d{14}_/.test(f)).map(f => f.slice(0, 14))
    assert.ok(others.every(v => v < FILE.slice(0, 14)), 'a later migration exists: renumber this one above it')
  })

  test('both roll-up triggers are DEFERRED constraint triggers, so they read the finished state', () => {
    assert.equal((sql.match(/create constraint trigger/g) ?? []).length, 2)
    assert.equal((sql.match(/deferrable initially deferred/g) ?? []).length, 2)
    assert.ok(/after insert or update or delete on public\.order_dispatch_lots/.test(sql))
    assert.ok(/after update of status on public\.order_pi_versions/.test(sql))
    assert.ok(sql.includes("when (new.status = 'approved' and old.status is distinct from new.status)"))
  })

  test('the helpers are not callable by clients; only the list read is, and not by anon', () => {
    for (const fn of ['in_order_dispatch_sync()', 'orders_enforce_status_transition()', 'order_dispatch_pieces(uuid)',
      'order_dispatch_sync_status(uuid)', 'order_dispatch_lots_rollup_trg()', 'order_pi_versions_rollup_trg()']) {
      assert.ok(sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`), fn)
    }
    assert.ok(sql.includes('revoke execute on function public.orders_dispatch_progress() from public, anon;'))
    assert.ok(sql.includes('grant  execute on function public.orders_dispatch_progress() to authenticated;'))
    assert.equal(/grant\s+execute[^;]*order_dispatch_sync_status/.test(sql), false)
  })

  test('every SECURITY DEFINER function pins its search_path', () => {
    const defs = sql.split(/create or replace function /).slice(1)
    for (const d of defs) {
      if (/security definer/.test(d)) assert.ok(/set search_path = public, pg_temp/.test(d.slice(0, 600)), d.slice(0, 60))
    }
  })

  test('a cancel is refused once anything has left, before the audited-door check', () => {
    assert.ok(sql.includes("ORDER_PART_DISPATCHED: Part of Order % has already been dispatched, so it can no longer be cancelled"))
    assert.ok(sql.indexOf('ORDER_PART_DISPATCHED') < sql.indexOf('ORDER_CANCEL_PATH_REQUIRED'))
  })

  test('only a close the roll-up made is undone: the latest status change must carry source = dispatch', () => {
    assert.ok(sql.includes("v_last ->> 'source' = 'dispatch'"))
    assert.ok(sql.includes("'source', 'dispatch'"))
  })

  test('it writes the same status_changed row the Order page writes, so the Operations dashboard counts it', () => {
    assert.ok(sql.includes("'status_changed'"))
    assert.ok(sql.includes("jsonb_build_object('from', v_order.status, 'to', 'dispatched'"))
    const dash = readFileSync('supabase/migrations/20270401000000_operations_dashboard.sql', 'utf8')
    assert.ok(dash.includes("a.payload ->> 'to' = 'dispatched'"), 'the dashboard still reads payload.to')
  })

  test('it changes no existing Order: the backfill is a commented query for the owner', () => {
    const live = sql.split('\n').filter(l => !l.startsWith('--')).join('\n')
    assert.equal(/select public\.order_dispatch_sync_status\(o\.id\)/.test(live), false)
    assert.ok(sql.includes('BACKFILL (NOT RUN HERE'))
  })

  test('it executes its own assertions', () => {
    assert.ok(sql.includes('do $assert$'))
    assert.ok(sql.includes('ASSERT: both roll-up triggers must be deferred constraint triggers'))
  })
})
