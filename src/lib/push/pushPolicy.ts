// What a phone alert says, and which notifications get one.
//
// A push is a SECOND delivery of a row already in `public.notifications`; it
// never creates one. Whether a row deserves a push is decided here, once, and
// the dispatch route is the only caller.
//
// THE LOCK SCREEN IS PUBLIC. Anyone holding a locked phone can read the banner,
// so the text is generic per category - "Payment update", never a client name,
// an amount or a task title. The row's own title/body stay in the inbox, one
// tap away behind the sign-in. The deep link is the same one the inbox row uses
// (`getNotificationMeta`), so a tap lands on the exact record.

import {
  ASSET_NOTIFICATION_TYPES,
  ATTENDANCE_PAYROLL_NOTIFICATION_TYPES,
  FINANCE_NOTIFICATION_TYPES,
  INVENTORY_NOTIFICATION_TYPES,
  ORDER_NOTIFICATION_TYPES,
  REVIEW_NOTIFICATION_TYPES,
  isSystemGeneratedNotificationType,
  type NotificationCategory,
} from '@/lib/notifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import type { Notification } from '@/lib/types'

/** The columns of a notifications row the policy reads. */
export type PushSourceRow = Pick<
  Notification,
  'id' | 'user_id' | 'task_id' | 'entity_id' | 'type' | 'title' | 'body' | 'is_digest'
>

export type PushPayload = {
  title: string
  body: string
  /** Same-origin path the tap opens. */
  url: string
  /** Collapses repeats of one category into one banner per category. */
  tag: string
}

/** Every category a person can mute, in the order the settings card lists them. */
export const PUSH_CATEGORIES: readonly NotificationCategory[] = [
  'task', 'finance', 'order', 'asset', 'attendance_payroll', 'review', 'inventory',
]

export const PUSH_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  task: 'Tasks',
  finance: 'Finance',
  order: 'Orders',
  asset: 'Assets & Access',
  attendance_payroll: 'Attendance & Payroll',
  review: 'Review Workflow',
  inventory: 'Inventory',
}

/** Where each category's inbox lives - the fallback when a row has no record to open. */
const INBOX_PATH: Record<NotificationCategory, string> = {
  task: '/notifications',
  finance: '/finance/notifications',
  order: '/orders/notifications',
  asset: '/assets-access/notifications',
  attendance_payroll: '/attendance/notifications',
  review: '/customer-reviews/notifications',
  inventory: '/inventory/notifications',
}

/** Generic lock-screen headline per category. No names, no amounts. */
const HEADLINE: Record<NotificationCategory, string> = {
  task: 'Task update',
  finance: 'Finance update',
  order: 'Order update',
  asset: 'Assets & Access update',
  attendance_payroll: 'Attendance & Payroll update',
  review: 'Review update',
  inventory: 'Inventory update',
}

const GENERIC_BODY = 'Open BOE One to see what needs you.'

const TYPE_TO_CATEGORY: ReadonlyMap<string, NotificationCategory> = (() => {
  const map = new Map<string, NotificationCategory>()
  const add = (category: NotificationCategory, types: readonly string[]) => {
    for (const t of types) map.set(t, category)
  }
  add('finance', FINANCE_NOTIFICATION_TYPES)
  add('order', ORDER_NOTIFICATION_TYPES)
  add('asset', ASSET_NOTIFICATION_TYPES)
  add('attendance_payroll', ATTENDANCE_PAYROLL_NOTIFICATION_TYPES)
  add('review', REVIEW_NOTIFICATION_TYPES)
  add('inventory', INVENTORY_NOTIFICATION_TYPES)
  return map
})()

/**
 * The inbox a row belongs to. A task row is "has a task", exactly as the inbox
 * decides it; every other row is filed by its type list. Null for a type that
 * no inbox shows - such a row gets no push, because the person could not find
 * it after tapping.
 */
export function pushCategoryFor(row: Pick<PushSourceRow, 'task_id' | 'type'>): NotificationCategory | null {
  if (row.task_id) return 'task'
  return TYPE_TO_CATEGORY.get(String(row.type)) ?? null
}

/**
 * Whether a row gets a phone alert. Mirrors what the inbox hides, so a banner
 * never promises something the inbox then fails to show: system-generated rows,
 * digests, and `task_assigned` (the inbox hides it by owner decision).
 */
export function shouldPushNotification(row: PushSourceRow, mutedCategories: readonly string[] = []): boolean {
  if (row.is_digest) return false
  if (isSystemGeneratedNotificationType(row.type)) return false
  if (row.type === 'task_assigned') return false
  const category = pushCategoryFor(row)
  if (!category) return false
  return !mutedCategories.includes(category)
}

/** A same-origin path, or null. The service worker opens only what passes this. */
export function safePushPath(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null
  return href
}

/** The banner for one row. Call only after `shouldPushNotification`. */
export function buildPushPayload(row: PushSourceRow): PushPayload {
  const category = pushCategoryFor(row) ?? 'task'
  const href = safePushPath(getNotificationMeta(row as Notification).href)
  return {
    title: HEADLINE[category],
    body: GENERIC_BODY,
    url: href ?? INBOX_PATH[category],
    tag: `boe-${category}`,
  }
}
