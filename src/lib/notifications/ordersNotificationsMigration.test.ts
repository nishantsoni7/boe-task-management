/**
 * 20270321000000 / 20270321000001 — Orders notifications from the database
 * (owner, 2026-10-19: every concerned person told of every new activity).
 * These pin what the migration promises; the behaviour was rehearsed against
 * the linked database inside BEGIN…ROLLBACK before the PR.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/ordersNotificationsMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const types = readFileSync('supabase/migrations/20270321000000_order_submission_notification_types.sql', 'utf8')
const sql = readFileSync('supabase/migrations/20270321000001_order_submission_notifications_complete.sql', 'utf8')

describe('the Orders notifications migration', () => {
  test('the enum values live in their own file — a new value cannot be used in the transaction that adds it', () => {
    assert.match(types, /add value if not exists 'order_update_approval'/)
    assert.doesNotMatch(types, /create (or replace )?function|create trigger/i)
    assert.match(sql, /apply 20270321000000_order_submission_notification_types\.sql first/)
  })

  test('every activity the audit found silent now has a trigger', () => {
    for (const [table, trigger] of [
      ['order_activity_log', 'order_activity_log_notify'],
      ['order_approval_events', 'order_approval_events_notify'],
      ['order_change_requests', 'order_change_requests_notify'],
      ['order_submissions', 'order_submissions_review_notify'],
      ['orders', 'orders_created_notify'],
      ['order_operations_handoffs', 'order_operations_handoffs_notify'],
    ]) {
      assert.match(sql, new RegExp(`create (constraint )?trigger ${trigger}[\\s\\S]*?on public\\.${table}\\b`), trigger)
    }
    for (const ev of ['status_changed', 'production_alignment_changed', 'payment_verified', 'sample_type_changed', 'order_advance_hold_opened']) {
      assert.ok(sql.includes(`'${ev}'`), ev)
    }
  })

  test('never the actor, never an inactive or deleted user, never twice in two minutes', () => {
    const helper = sql.slice(sql.indexOf('create or replace function public.order_notify_users'), sql.indexOf('create or replace function public.order_update_recipient_ids'))
    assert.match(helper, /u\.id is distinct from p_actor/)
    assert.match(helper, /u\.is_active/)
    assert.match(helper, /coalesce\(u\.is_deleted, false\) = false/)
    assert.match(helper, /interval '2 minutes'/)
    assert.match(helper, /null::uuid/, 'task_id typed — a bare null in SELECT DISTINCT is text (caught in rehearsal)')
    assert.match(sql, /revoke all on function public\.order_notify_users\([^)]*\) from public, anon, authenticated;/)
  })

  test('a notice never undoes the action: every trigger body swallows its own error', () => {
    const bodies = sql.split('create or replace function public.').filter(b => /returns trigger/.test(b))
    assert.equal(bodies.length, 6)
    for (const b of bodies) assert.match(b, /exception when others then\s+raise warning/, b.slice(0, 40))
  })

  test('the recipients are the configured Order recipients, bdm off by default', () => {
    assert.match(sql, /recipient_role = 'bdm'\), false\)/)
    assert.match(sql, /recipient_role = 'salesperson'\), true\)/)
  })

  test('"sent for approval" waits for commit, so a self-approved PI does not page the other approvers', () => {
    assert.match(sql, /create constraint trigger order_submissions_review_notify[\s\S]*?deferrable initially deferred/)
    assert.match(sql, /is distinct from 'submitted' then\s+return null;/)
  })
})
