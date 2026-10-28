'use client'

// ── "For you" on the Modules launcher ────────────────────────────────────────
//
// One panel beside the module tiles, in two tiers:
//
//   WAITING ON YOU   things nobody else can move: a cash handover handed to you
//                    (accept it), and — for an admin — attendance requests to
//                    decide. Each says how long it has waited and carries a
//                    Review button. Drawn first, on a light red ground.
//   UPDATES          the newest unread notifications per module (Finance,
//                    Orders), each a two-line preview that opens its record,
//                    plus open cash handovers that wait on somebody else.
//
// The header sums both ("2 to act on · 9 updates"). With nothing pending the
// panel stays, as one "You're all caught up" line, so the tiles do not change
// width when the last item is cleared.
//
// A PLACEMENT AND NOTHING ELSE. Every row reads what it read before — the
// handover query, the module's own notification list, the attendance queue —
// and every gate is decided by the page and passed in: a person who may not
// open Finance or Orders gets no group for them, exactly as they get no tile.
// The panel exists only for somebody with at least one source; an employee with
// none of them (and no handover) gets no panel and the tiles keep the width.

import Link from 'next/link'
import { ArrowDown, ClipboardList, DollarSign, HandCoins } from 'lucide-react'
import { useOpenHandovers } from '@/hooks/queries/useHandovers'
import { formatINR } from '@/lib/currency'
import { handoverRole, sortMyHandovers, waitingFor, type Handover } from '@/lib/finance/handover'
import { NotificationPreviews } from './NotificationPreviews'
import { PendingApprovals, usePendingApprovalQueue } from './PendingApprovals'
import styles from './attentionPanel.module.css'

export type AttentionSources = {
  userId: string | null
  /** null = may not open Finance. undefined = count not known yet. */
  financeUnread: number | null | undefined
  /** null = may not open Orders. undefined = count not known yet. */
  ordersUnread: number | null | undefined
  /** The signed-in admin, not previewing: attendance approvals are theirs. */
  showAttendance: boolean
}

/**
 * Everything the panel and the phone strip need to agree on, from one set of
 * queries (each deduped by its key, so calling this twice costs nothing).
 */
export function useAttentionSummary({ userId, financeUnread, ordersUnread, showAttendance }: AttentionSources) {
  const { viewerId, mine, others, isError: handoversError } = useOpenHandovers()
  const approvals = usePendingApprovalQueue(userId, showAttendance)

  const handovers = sortMyHandovers([...mine, ...others], viewerId)
  // Waiting on YOU: handed to you and yours to accept. Everything else that is
  // open (you gave it, or you are watching) waits on somebody else.
  const toAccept = handovers.filter(h => handoverRole(h, viewerId) === 'recipient' && h.canAccept)
  const elsewhere = handovers.filter(h => !toAccept.includes(h))

  const approvalCount = showAttendance ? approvals.rows.length : 0
  const actCount = toAccept.length + approvalCount
  const updateCount = (financeUnread ?? 0) + (ordersUnread ?? 0) + elsewhere.length

  // Known only once every count this person has is in. Until then the header
  // says nothing rather than "all caught up".
  const known = financeUnread !== undefined
    && ordersUnread !== undefined
    && (!showAttendance || approvals.isFetched)

  const hasSource = financeUnread !== null || ordersUnread !== null || showAttendance
    || handovers.length > 0 || handoversError

  return {
    viewerId, toAccept, elsewhere, handoversError,
    approvalsError: showAttendance && approvals.isError,
    approvalCount, actCount, updateCount, known, hasSource,
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function AttentionPanel(props: AttentionSources) {
  const { userId, financeUnread, ordersUnread, showAttendance } = props
  const s = useAttentionSummary(props)
  if (!s.hasSource) return null

  const financeCount = financeUnread ?? 0
  const ordersCount = ordersUnread ?? 0
  const showWaiting = s.toAccept.length > 0 || s.handoversError || (showAttendance && !!userId)
  const showFinance = financeCount > 0 || s.elsewhere.length > 0
  const caughtUp = s.known && s.actCount === 0 && s.updateCount === 0 && !s.handoversError && !s.approvalsError

  return (
    <aside id="for-you" className={styles.attention} aria-labelledby="for-you-heading">
      <header className={styles.attentionHead}>
        <h2 id="for-you-heading" className={styles.attentionHeading}>For you</h2>
        {s.known && !caughtUp && (
          <span className={styles.attentionSummary}>
            {s.actCount} to act on · {plural(s.updateCount, 'update', 'updates')}
          </span>
        )}
      </header>

      {caughtUp && <p className={styles.caughtUp}>You&rsquo;re all caught up.</p>}

      {/* Rendered whenever there is a source for it, so the approvals list can
          mount and load; with nothing in it the block is hidden by CSS
          (`.waiting:not(:has(li))`). */}
      {showWaiting && (
        <section className={styles.waiting} aria-labelledby="waiting-heading">
          <h3 id="waiting-heading" className={styles.waitingHeading}>Waiting on you</h3>
          <ul className={styles.actionList}>
            {s.handoversError && (
              <li className={styles.actionItem} role="alert">
                <span className={styles.actionIcon} aria-hidden="true"><HandCoins size={15} strokeWidth={1.9} /></span>
                <span className={styles.actionText}>
                  <span className={styles.actionTitle}>Cash handovers</span>
                  <span className={styles.actionDetail}>Could not be loaded, so one waiting for you may be missing</span>
                </span>
              </li>
            )}
            {s.toAccept.map(h => <HandoverAction key={h.id} h={h} />)}
            {showAttendance && userId && <PendingApprovals userId={userId} />}
          </ul>
        </section>
      )}

      {showFinance && (
        <section className={styles.updateGroup} aria-labelledby="updates-finance-heading">
          <h3 id="updates-finance-heading" className={styles.updateHeading}>
            <DollarSign size={14} strokeWidth={2} aria-hidden="true" />
            Finance
            {financeCount > 0 && <span className={styles.updateCount}>· {financeCount} new</span>}
          </h3>
          <ul className={styles.updateList}>
            {s.elsewhere.map(h => <HandoverUpdate key={h.id} h={h} viewerId={s.viewerId} />)}
            {financeCount > 0 && (
              <NotificationPreviews category="finance" moduleName="Finance" allHref="/finance/notifications" unreadCount={financeCount} />
            )}
          </ul>
        </section>
      )}

      {ordersCount > 0 && (
        <section className={styles.updateGroup} aria-labelledby="updates-orders-heading">
          <h3 id="updates-orders-heading" className={styles.updateHeading}>
            <ClipboardList size={14} strokeWidth={2} aria-hidden="true" />
            Orders
            <span className={styles.updateCount}>· {ordersCount} new</span>
          </h3>
          <ul className={styles.updateList}>
            <NotificationPreviews category="order" moduleName="Orders" allHref="/orders/notifications" unreadCount={ordersCount} />
          </ul>
        </section>
      )}
    </aside>
  )
}

/** A handover handed to the viewer: theirs to accept. Opens the handover page. */
function HandoverAction({ h }: { h: Handover }) {
  const disputed = h.status === 'disputed'
  return (
    <li className={styles.actionItem}>
      <span className={styles.actionIcon} aria-hidden="true"><HandCoins size={15} strokeWidth={1.9} /></span>
      <span className={styles.actionText}>
        <span className={styles.actionTitle}>Accept {formatINR(h.totalAmount)} from {h.giverName}</span>
        <span className={styles.actionDetail}>
          Cash handover{disputed ? ' · disputed' : ''} · waiting {waitingFor(h.ageHours)}
        </span>
      </span>
      <Link href={`/handover/${h.id}`} className={styles.actionButton}
        aria-label={`Review cash handover of ${formatINR(h.totalAmount)} from ${h.giverName}`}>
        Review
      </Link>
    </li>
  )
}

/** An open handover waiting on somebody else: the viewer gave it, or watches. */
function HandoverUpdate({ h, viewerId }: { h: Handover; viewerId: string | null }) {
  const role = handoverRole(h, viewerId)
  const title = role === 'giver'
    ? `${h.recipientName} has not accepted ${formatINR(h.totalAmount)}`
    : `${h.giverName} → ${h.recipientName} · ${formatINR(h.totalAmount)}`
  return (
    <li>
      <Link href={`/handover/${h.id}`} className={styles.updateRow}>
        {/* Not a notification, so not an unread dot: a hollow "open" marker. */}
        <span className={styles.openDot} aria-hidden="true" />
        <span className={styles.updateText}>
          <span className={styles.updateTitle}>{title}</span>
          <span className={styles.updateDetail}>
            Cash handover{h.status === 'disputed' ? ' · disputed' : ''} · waiting {waitingFor(h.ageHours)}
          </span>
        </span>
      </Link>
    </li>
  )
}

/**
 * Phones and narrow windows only (CSS): the panel falls below the tiles there,
 * so this one line at the top says how much waits on you and jumps to it.
 * Nothing waiting on you = no strip.
 */
export function AttentionStrip(props: AttentionSources) {
  const s = useAttentionSummary(props)
  if (!s.hasSource || s.actCount === 0) return null
  return (
    <a href="#for-you" className={styles.attentionStrip}>
      <span className={styles.attentionStripDot} aria-hidden="true" />
      <span className={styles.attentionStripText}>{s.actCount} waiting on you</span>
      <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
    </a>
  )
}
