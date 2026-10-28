import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { deriveOrdersCapabilities } from '../permissions/orders'
import { PROTECTED_ACTIONS, ACTION_DEPENDENCIES } from '../permissions/levels'
import '../permissions/modules'
import { getRegisteredModule } from '../permissions/registry'

const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20270428000000_order_payment_plan.sql'), 'utf8')

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `${name} is defined`)
  const end = sql.indexOf('\n$$;', start)
  return sql.slice(start, end)
}

test('the four tables are closed to every client role; only the functions reach them', () => {
  for (const t of ['order_payment_plans', 'order_dispatch_lots', 'order_dispatch_lot_lines', 'order_dispatch_lot_events']) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`))
    assert.match(sql, new RegExp(`revoke all on public\\.${t} from anon, authenticated`))
  }
  assert.doesNotMatch(sql, /create policy/i)
  assert.doesNotMatch(sql, /grant (select|insert|update|delete|all) on public\./i)
})

test('every function a person can call asks the gate first; the internal ones are callable by nobody', () => {
  for (const name of ['order_payment_plan_read', 'order_payment_plan_save', 'order_dispatch_lot_save', 'order_dispatch_lot_mark_dispatched']) {
    assert.match(fn(name), /perform public\.order_payment_plan_assert\(/, `${name} asks the gate`)
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(`))
  }
  assert.match(fn('order_dispatch_lot_admin_change'), /perform public\.assert_order_amender\(\)/)
  for (const internal of ['order_payment_plan_assert', 'order_payment_plan_check_lines']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${internal}\\([^)]*\\) from public, anon, authenticated`))
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${internal}\\(`))
  }
})

test('reading needs view_payment_plan, changing needs edit_payment_plan, and both need the unscoped right to open the Order', () => {
  const gate = fn('order_payment_plan_assert')
  assert.match(gate, /'edit_payment_plan' else 'view_payment_plan'/)
  assert.match(gate, /can_view_order_unscoped\(p_order_id\)/)
  assert.match(gate, /module_entry_open\('orders'\)/)
})

test('payments leave the database as totals only', () => {
  const read = fn('order_payment_plan_read')
  assert.match(read, /'payment_count'/)
  assert.doesNotMatch(read, /human_payment_id|proof|submitted_by|client_name\s*=\s*r\./)
})

test('there is at most one planned lot per Order, and a lot can never exceed what was ordered', () => {
  assert.match(sql, /create unique index order_dispatch_lots_one_planned[\s\S]*where status = 'planned'/)
  assert.match(fn('order_payment_plan_check_lines'), /DISPATCH_QUANTITY_EXCEEDS_ORDER/)
  // the Order row is locked before the totals are checked, so two saves cannot both pass
  assert.match(fn('order_dispatch_lot_save'), /from public\.orders where id = p_order_id for update/)
})

test('a change to a dispatched lot is admin only, needs a reason, and leaves a trail', () => {
  const admin = fn('order_dispatch_lot_admin_change')
  assert.match(admin, /DISPATCH_REASON_REQUIRED/)
  assert.match(admin, /'admin_changed'/)
  assert.match(admin, /'admin_deleted'/)
})

test('the migration writes nothing to Orders, PIs or payments', () => {
  assert.doesNotMatch(sql, /(insert into|update|delete from) public\.(orders|order_submissions|order_submission_items|finance_payment_requests|finance_payment_allocations)\b/)
})

test('the app registers exactly the permissions the migration inserts, protected and dependent', () => {
  const orders = getRegisteredModule('orders')
  assert.ok(orders)
  const keys = orders.actions.map(a => a.actionKey)
  for (const key of ['view_payment_plan', 'edit_payment_plan']) {
    assert.ok(keys.includes(key), `${key} registered in modules.ts`)
    assert.match(sql, new RegExp(`'${key}'`))
    assert.ok(PROTECTED_ACTIONS.has(key), `${key} is protected`)
  }
  assert.equal(ACTION_DEPENDENCIES.view_payment_plan, 'view')
  assert.equal(ACTION_DEPENDENCIES.edit_payment_plan, 'view_payment_plan')
})

test('capabilities: admins hold both, others need Orders entry and their own grant', () => {
  const admin = deriveOrdersCapabilities('admin', [])
  assert.equal(admin.canViewPaymentPlan, true)
  assert.equal(admin.canEditPaymentPlan, true)
  const grant = (actionKey: string) => ({ actionKey, allowed: true }) as never
  const viewer = deriveOrdersCapabilities('employee', [grant('view'), grant('view_payment_plan')])
  assert.equal(viewer.canViewPaymentPlan, true)
  assert.equal(viewer.canEditPaymentPlan, false)
  const noEntry = deriveOrdersCapabilities('employee', [grant('view_payment_plan'), grant('edit_payment_plan')])
  assert.equal(noEntry.canViewPaymentPlan, false)
  assert.equal(deriveOrdersCapabilities('employee', [grant('view'), grant('manage'), grant('view_all')]).canViewPaymentPlan, false)
})
