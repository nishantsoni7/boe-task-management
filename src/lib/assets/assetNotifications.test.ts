/**
 * Asset notifications — who is told what.
 *
 * These rules are the part of a notification system nobody notices going
 * wrong: no one reports a notification they never received. So they are pure
 * functions with a test each.
 *
 * Run:
 *   npx tsx --test src/lib/assets/assetNotifications.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_NOTIFICATION_EVENTS,
  assetNotification,
  assetNotificationBody,
  editDeservesNotification,
  isAssetNotifyEvent,
} from './assetNotifications'
import { ASSET_NOTIFICATION_TYPES, getNotificationCategoryFilter } from '@/lib/notifications'

const ctx = { assetName: 'Dell XPS 15', assetCode: 'BOE-AST-000001' }

describe('event vocabulary', () => {
  test('every required event from the brief exists', () => {
    for (const required of [
      'asset_request_submitted', 'asset_request_approved', 'asset_request_rejected',
      'asset_edit_request_submitted', 'asset_edit_request_approved', 'asset_edit_request_rejected',
      'asset_assigned', 'asset_transferred', 'asset_transfer_acknowledged',
      'asset_returned', 'asset_lost', 'asset_recovered',
      'asset_repair_sent', 'asset_repair_returned', 'asset_warranty_expiring',
    ]) {
      assert.ok((ASSET_NOTIFICATION_EVENTS as readonly string[]).includes(required), required)
    }
  })

  test('the app-side enum list matches the event list exactly', () => {
    // If these drift, a notification is written with a type the module-scoped
    // feed filter does not select — it exists but is invisible.
    assert.deepEqual([...ASSET_NOTIFICATION_TYPES].sort(), [...ASSET_NOTIFICATION_EVENTS].sort())
  })

  test('the Assets feed filter selects exactly those types', () => {
    const filter = getNotificationCategoryFilter('asset')
    for (const type of ASSET_NOTIFICATION_TYPES) assert.ok(filter.includes(type), type)
    // Never a prefix LIKE: `type` is an enum column and LIKE errors server-side.
    assert.ok(filter.startsWith('type.in.('))
    assert.ok(!filter.includes('like'))
  })

  test('isAssetNotifyEvent rejects anything else', () => {
    assert.equal(isAssetNotifyEvent('asset_assigned'), true)
    assert.equal(isAssetNotifyEvent('order_assigned'), false)
    assert.equal(isAssetNotifyEvent(''), false)
    assert.equal(isAssetNotifyEvent(null), false)
    assert.equal(isAssetNotifyEvent(42), false)
  })
})

describe('recipients', () => {
  test('assignment goes to the new custodian and nobody else', () => {
    const { recipients } = assetNotification('asset_assigned', ctx)
    assert.deepEqual(recipients, ['new_custodian'])
  })

  test('a transfer tells BOTH sides — one gained accountability, one lost it', () => {
    const { recipients } = assetNotification('asset_transferred', ctx)
    assert.deepEqual([...recipients].sort(), ['new_custodian', 'previous_custodian'])
  })

  test('an acknowledgement goes to whoever handed the asset over', () => {
    const { recipients } = assetNotification('asset_transfer_acknowledged', ctx)
    assert.deepEqual(recipients, ['assigner'])
  })

  test('loss is an accountability event: last holder AND administration', () => {
    const { recipients } = assetNotification('asset_lost', ctx)
    assert.deepEqual([...recipients].sort(), ['admins', 'previous_custodian'])
  })

  test('a change request goes to reviewers; its decision goes back to the requester', () => {
    assert.deepEqual(assetNotification('asset_request_submitted', ctx).recipients, ['admins'])
    assert.deepEqual(assetNotification('asset_edit_request_submitted', ctx).recipients, ['admins'])
    for (const e of ['asset_request_approved', 'asset_request_rejected',
                     'asset_edit_request_approved', 'asset_edit_request_rejected'] as const) {
      assert.deepEqual(assetNotification(e, ctx).recipients, ['requester'], e)
    }
  })

  test('warranty reminders go to administration only', () => {
    assert.deepEqual(assetNotification('asset_warranty_expiring', ctx).recipients, ['admins'])
  })

  test('every event names at least one recipient', () => {
    for (const event of ASSET_NOTIFICATION_EVENTS) {
      assert.ok(assetNotification(event, ctx).recipients.length > 0, event)
    }
  })
})

describe('titles', () => {
  test('every title names the asset — the reader’s first question is "which one"', () => {
    for (const event of ASSET_NOTIFICATION_EVENTS) {
      const { title } = assetNotification(event, { ...ctx, daysToExpiry: 5 })
      assert.ok(title.includes('Dell XPS 15'), event)
      assert.ok(title.includes('BOE-AST-000001'), event)
    }
  })

  test('an asset with no code still produces a readable title', () => {
    const { title } = assetNotification('asset_assigned', { assetName: 'Old Printer' })
    assert.ok(title.includes('Old Printer'))
    assert.ok(!title.includes('('))
  })

  test('a transfer to a person names the person; to a place, the place', () => {
    assert.ok(assetNotification('asset_transferred', { ...ctx, toName: 'Rahul Verma' }).title.includes('Rahul Verma'))
    assert.ok(assetNotification('asset_transferred', { ...ctx, toLocation: 'Store Room' }).title.includes('Store Room'))
  })

  test('a transfer with neither still reads as a sentence', () => {
    const { title } = assetNotification('asset_transferred', ctx)
    assert.ok(title.endsWith('was transferred.'))
  })

  test('the warranty reminder states the distance, not a raw number of days', () => {
    assert.ok(assetNotification('asset_warranty_expiring', { ...ctx, daysToExpiry: 1 }).title.includes('in 1 day.'))
    assert.ok(assetNotification('asset_warranty_expiring', { ...ctx, daysToExpiry: 12 }).title.includes('in 12 days.'))
    assert.ok(assetNotification('asset_warranty_expiring', { ...ctx, daysToExpiry: 0 }).title.includes('today'))
    assert.ok(assetNotification('asset_warranty_expiring', ctx).title.includes('soon'))
  })

  test('no title leaks an internal id', () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    for (const event of ASSET_NOTIFICATION_EVENTS) {
      const { title } = assetNotification(event, { ...ctx, toName: uuid ? 'Rahul Verma' : null })
      assert.ok(!title.includes('-4444-'), event)
    }
  })
})

describe('bodies', () => {
  test('a rejection carries the reviewer’s reason — a rejection you cannot act on is worse than none', () => {
    const body = assetNotificationBody('asset_request_rejected', { ...ctx, note: 'Still in use by Design.' })
    assert.equal(body, 'Reason: Still in use by Design.')
  })

  test('nothing worth adding produces null, not an empty second line', () => {
    assert.equal(assetNotificationBody('asset_assigned', ctx), null)
    assert.equal(assetNotificationBody('asset_request_rejected', ctx), null)
  })

  test('a transfer says who had it before', () => {
    assert.equal(
      assetNotificationBody('asset_transferred', { ...ctx, fromName: 'Priya Sharma' }),
      'Previously held by Priya Sharma',
    )
  })
})

describe('editDeservesNotification — the metadata rule', () => {
  test('a harmless metadata correction does NOT notify', () => {
    assert.equal(editDeservesNotification(['serial_no']), false)
    assert.equal(editDeservesNotification(['description', 'specifications', 'brand', 'model']), false)
    assert.equal(editDeservesNotification([]), false)
  })

  test('anything touching ownership, position or warranty dates does', () => {
    assert.equal(editDeservesNotification(['status']), true)
    assert.equal(editDeservesNotification(['location']), true)
    assert.equal(editDeservesNotification(['department']), true)
    assert.equal(editDeservesNotification(['condition']), true)
    assert.equal(editDeservesNotification(['warranty_expiry_date']), true)
  })

  test('one significant field among many harmless ones is enough', () => {
    assert.equal(editDeservesNotification(['brand', 'model', 'status']), true)
  })
})
