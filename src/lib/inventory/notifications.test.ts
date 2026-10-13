/**
 * Inventory booking notifications, audited from the source: the category and its filter, how a row is shown and
 * where it opens, and what the migration's trigger says. Behaviour is proven against Postgres by
 * supabase/tests/inventory_notifications_suite.sql.
 *
 * Run: npx tsx --test src/lib/inventory/notifications.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { INVENTORY_NOTIFICATION_TYPES, getNotificationCategoryFilter, isAdminOnlyNotificationCategory } from '../notifications'
import { NOTIFICATION_CATEGORIES } from '../notificationCache'
import { getNotificationMeta } from '../notificationMeta'
import type { Notification } from '../types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')
const TYPES_SQL = read('supabase/migrations/20270314000000_inventory_notification_types.sql')
const TRIGGER_FILE = '20270314000100_inventory_booking_notifications.sql'
const TRIGGER_SQL = read(`supabase/migrations/${TRIGGER_FILE}`)
const code = TRIGGER_SQL.replace(/--[^\n]*/g, '')

const note = (over: Partial<Notification>): Notification => ({
  id: 'n1', user_id: 'u1', task_id: null, entity_id: 'b1', type: 'inventory_booking_requested', title: 't', body: 'b',
  is_read: false, is_push_sent: true, is_digest: false, ...over,
} as Notification)

describe('the category', () => {
  it('names exactly the two types the migration adds', () => {
    assert.deepEqual([...INVENTORY_NOTIFICATION_TYPES], ['inventory_booking_requested', 'inventory_booking_decided'])
    for (const t of INVENTORY_NOTIFICATION_TYPES) assert.match(TYPES_SQL, new RegExp(`ADD VALUE IF NOT EXISTS '${t}'`))
  })
  it('filters by those types and is open to everyone who can use the module', () => {
    assert.equal(getNotificationCategoryFilter('inventory'), 'type.in.(inventory_booking_requested,inventory_booking_decided)')
    assert.equal(isAdminOnlyNotificationCategory('inventory'), false)
  })
  it('is in the cache list, so mark-all-read and the counts cover it', () => {
    assert.ok(NOTIFICATION_CATEGORIES.includes('inventory'))
  })
})

describe('how a row is shown', () => {
  it('opens the booking request, with its id, under Inventory', () => {
    for (const type of INVENTORY_NOTIFICATION_TYPES) {
      const m = getNotificationMeta(note({ type, entity_id: 'abc-123' }))
      assert.equal(m.heading, 'Inventory')
      assert.equal(m.href, '/inventory/requests?request=abc-123')
      assert.notEqual(m.badge.label, 'Activity', `${type} must not fall back to the neutral badge`)
    }
  })
  it('asks the approver to review and shows the salesperson the request', () => {
    assert.equal(getNotificationMeta(note({ type: 'inventory_booking_requested' })).actionLabel, 'Review request')
    assert.equal(getNotificationMeta(note({ type: 'inventory_booking_decided' })).actionLabel, 'View request')
  })
  it('still opens the list when a row carries no id', () => {
    assert.equal(getNotificationMeta(note({ entity_id: null })).href, '/inventory/requests')
  })
})

describe('the migrations', () => {
  it('are numbered after Inventory itself and are the only files with their numbers', () => {
    const all = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    assert.deepEqual(all.filter(f => f.startsWith('20270314000000')), ['20270314000000_inventory_notification_types.sql'])
    assert.deepEqual(all.filter(f => f.startsWith('20270314000100')), [TRIGGER_FILE])
    assert.ok(all.includes('20270313000000_inventory_module.sql'))
  })
  it('add the enum values in one file and use them only in the next (a new value cannot be used in its own transaction)', () => {
    assert.ok(!/inventory_booking_(requested|decided)'::notification_type/.test(TYPES_SQL.replace(/--[^\n]*/g, '')))
    assert.match(code, /'inventory_booking_requested'::notification_type/)
    assert.match(code, /'inventory_booking_decided'::notification_type/)
  })
  it('write from a trigger on the booking row, in its own transaction, as a definer with a pinned path', () => {
    assert.match(code, /after insert or update of status on public\.inventory_bookings/)
    assert.match(code, /security definer\s+set search_path = public, pg_temp/)
    assert.ok(!/(cron\.schedule|pg_net|net\.http_|supabase_functions\.)/i.test(code), 'nothing outside the database')
    assert.ok(!/create\s+(or\s+replace\s+)?trigger[\s\S]{0,200}on\s+(public\.)?notifications/i.test(code), 'no trigger on notifications')
    assert.match(code, /revoke all on function public\.inventory_booking_notify\(\) from public, anon, authenticated/)
  })
  it('never tell a person about their own action, and only active people', () => {
    assert.match(code, /u\.id <> new\.requested_by/)
    assert.match(code, /new\.decided_by = new\.requested_by then return new/)
    assert.match(code, /u\.is_active and not coalesce\(u\.is_deleted, false\)/)
  })
  it('tell approvers by the same rule the module uses (Admin role, or inventory:approve)', () => {
    assert.match(code, /u\.role = 'admin' or public\.resolve_permission\(u\.id, 'inventory', 'approve'\)/)
  })
  it('write database notifications: no task id, the booking as the subject', () => {
    assert.match(code, /insert into public\.notifications \(user_id, task_id, entity_id, type, title, body, is_push_sent\)/)
    assert.match(code, /select u\.id, null, new\.id, 'inventory_booking_requested'/)
  })
})
