'use client'

// ── A module's newest unread notifications, previewed in place ───────────────
//
// The "Updates" half of the launcher's For you panel. Each unread notification
// is one compact row — an unread dot, its headline, the line under it, its age —
// readable without opening anything. A row is a link: clicking it marks that
// notification read (as the module's own Notifications page does on "Open") and
// goes to the record it is about (`getNotificationMeta(n).href`).
//
// Reads the module's list through the same hook as its Notifications page, so
// the rows and the read state cannot disagree with it. Mounted only for
// somebody who may open the module, because the hook asks as soon as it mounts.
//
// THE NEWEST PREVIEW_LIMIT ONLY, then "N more in <module> →". That cap is what
// keeps the panel no taller than a screen on a busy day.

import Link from 'next/link'
import { useNotifications } from '@/hooks/queries/useNotifications'
import { useNotificationMutations } from '@/hooks/queries/useNotificationMutations'
import type { NotificationCategory } from '@/lib/notifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import { timeSince } from '@/lib/ui'
import styles from './attentionPanel.module.css'

/** Per module. More than this and the rest are one tap away. */
export const PREVIEW_LIMIT = 3

export function NotificationPreviews({ category, moduleName, allHref, unreadCount }: {
  category: Extract<NotificationCategory, 'finance' | 'order'>
  /** "Finance", "Orders" — for the "N more in …" line. */
  moduleName: string
  /** The module's own Notifications page. */
  allHref: string
  /** The shared unread count: the group's number, and the "more" line. */
  unreadCount: number
}) {
  const { data, isPending, isError } = useNotifications(category)
  const { markRead } = useNotificationMutations(category)

  const unread = (data ?? []).filter(n => !n.is_read)

  // Not loaded yet, or failed with nothing to show: one honest line carrying
  // the number, linking to the full list, so a count is never lost.
  if (isPending || (isError && unread.length === 0)) {
    return (
      <li>
        <Link href={allHref} className={styles.moreLink}>
          {isPending ? 'Loading…' : `Open ${unreadCount} in ${moduleName} →`}
        </Link>
      </li>
    )
  }

  const shown = unread.slice(0, PREVIEW_LIMIT)
  const more = Math.max(unreadCount, unread.length) - shown.length

  return (
    <>
      {shown.map(n => {
        const meta = getNotificationMeta(n)
        return (
          <li key={n.id}>
            <Link
              href={meta.href ?? allHref}
              className={styles.updateRow}
              onClick={() => markRead(n.id)}
            >
              <span className={styles.unreadDot} aria-hidden="true" />
              <span className={styles.updateText}>
                <span className={styles.updateTitle}>{n.title}</span>
                {n.body && <span className={styles.updateDetail}>{n.body}</span>}
              </span>
              <span className={styles.updateTime}>{timeSince(n.created_at)}</span>
            </Link>
          </li>
        )
      })}
      {more > 0 && (
        <li>
          <Link href={allHref} className={styles.moreLink}>
            {more} more in {moduleName} →
          </Link>
        </li>
      )}
    </>
  )
}
