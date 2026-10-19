/**
 * Orders notifications that were WRITTEN BUT SHOWN NOWHERE (owner audit,
 * 2026-10-19): the PI exception, the revised PI and the Design Files / Client
 * PO review rows reached no feed, badge or "mark all read". They now ride the
 * Orders channel and open the record they are about.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/hiddenOrderTypes.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ORDER_NOTIFICATION_TYPES } from '@/lib/notifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import type { Notification } from '@/lib/types'

const note = (type: string, entity_id: string | null = 'e1') =>
  ({ id: 'n', user_id: 'u', actor_id: null, task_id: null, type, message: 'm', read: false, created_at: '2026-10-19T00:00:00Z', entity_id } as unknown as Notification)

describe('the once-hidden Orders notifications', () => {
  const NOW_LISTED = [
    'pi_exception_requested', 'pi_exception_approved', 'pi_exception_rejected',
    'pi_revision_proposed', 'pi_revision_approved', 'pi_revision_rejected',
    'order_document_review_requested', 'order_document_review_decided',
  ]

  test('every one is in the Orders feed list', () => {
    for (const t of NOW_LISTED) assert.ok((ORDER_NOTIFICATION_TYPES as readonly string[]).includes(t), t)
  })

  test('the correction events stay OUT until the enum has them — an unknown value fails the whole read', () => {
    for (const t of ['pi_correction_requested', 'pi_correction_resolved', 'pi_correction_rejected']) {
      assert.equal((ORDER_NOTIFICATION_TYPES as readonly string[]).includes(t), false, t)
    }
  })

  test('each is filed under Orders and opens the record it is about', () => {
    for (const t of NOW_LISTED) assert.equal(getNotificationMeta(note(t)).category, 'order', t)
    assert.equal(getNotificationMeta(note('pi_revision_proposed', 'sub1')).href, '/orders/drafts/sub1')
    assert.equal(getNotificationMeta(note('pi_exception_requested', 'sub1')).href, '/orders/drafts/sub1')
    assert.equal(getNotificationMeta(note('order_document_review_requested', 'ord1')).href, '/orders/ord1#documents')
    assert.equal(getNotificationMeta(note('order_document_review_decided', null)).href, '/orders/all',
      'a submission sent with a PI before its Order exists has no Order to open')
    assert.equal(getNotificationMeta(note('order_document_review_requested')).badge.label, 'Documents to review')
  })
})
