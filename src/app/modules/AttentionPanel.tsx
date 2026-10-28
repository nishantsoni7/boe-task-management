'use client'

// ── "For you" on the Modules launcher ────────────────────────────────────────
//
// One panel beside the module tiles holding only what the owner asked for
// (2026-10-29), in this order:
//
//   1. THE NEWEST UNREAD ANNOUNCEMENT. Opening it marks it read (the
//      announcement page acknowledges), and it leaves the panel.
//   2. CASH HANDED TO YOU — for everyone. A handover whose recipient is the
//      viewer and that they may accept, with Accept right here (after the same
//      "Yes, I received ₹X" confirmation as the handover page).
//   3. CASH NOT WITH THE COMPANY — Finance's own "money not yet with the
//      company" list (finance_unclosed_funds: everyone's for an admin, the
//      custodian or a view_all holder; otherwise the viewer's own), one row per
//      person holding money. A handover waiting for the VIEWER is not repeated
//      here: it is item 2.
//   4. LEAVE AND LATE ARRIVAL — for the signed-in admin, the attendance requests
//      of those types (PendingApprovals.tsx).
//
// Nothing else: no notification previews and no Orders group.
//
// A PLACEMENT AND NOTHING ELSE. Every row reads an existing query and every
// write goes through an existing door (accept_cash_handover, the attendance
// decision route). Accepting custody never approves a payment: Finance still
// verifies it (20270417000000).
//
// With nothing to show, somebody who regularly has items here (an admin, the
// custodian, a view_all holder) sees one "You're all caught up." line; anybody
// else gets no panel and the tiles keep the whole width.

import { useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowRight, Banknote, CalendarClock, HandCoins, Megaphone } from 'lucide-react'
import type { MyAnnouncement } from '@/lib/announcements'
import { useHandoverActions, useOpenHandovers } from '@/hooks/queries/useHandovers'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import { HandoverConfirmDialog } from '@/components/finance/HandoverCard'
import { CASH_JOURNEYS_PATH } from '@/components/finance/UnclosedFundsCard'
import { formatINR } from '@/lib/currency'
import { handoverPaymentCount, handoverRole, waitingFor, type Handover } from '@/lib/finance/handover'
import { sumAmounts, totalsByHolder, waitingAge, type CashPayment } from '@/lib/finance/cashJourney'
import { initialsOf } from '@/lib/attendance/pendingApprovals'
import { PendingApprovals, usePendingApprovalQueue } from './PendingApprovals'
import styles from './attentionPanel.module.css'

export type AttentionSources = {
  userId: string | null
  /** The viewer may open Finance, so a cash row can link to Cash journeys. */
  financeAllowed: boolean
  /** The signed-in admin, not previewing: leave and late requests are theirs. */
  showAttendance: boolean
  /** The newest announcement this person may see, or null. */
  latestAnnouncement: MyAnnouncement | null
}

type HolderRow = {
  holderId: string
  name: string
  amount: number
  detail: string
}

/** What one person's held cash is doing, in a few words. */
function holderDetail(payments: CashPayment[], oldestAgeHours: number): string {
  const n = payments.length
  const inHandover = payments.filter(p => p.openHandover)
  const recipients = [...new Set(inHandover.map(p => p.openHandover!.recipientName))]
  const disputed = inHandover.some(p => p.openHandover!.status === 'disputed')
  let what: string
  if (inHandover.length === 0) {
    what = `${n} ${n === 1 ? 'payment' : 'payments'}, not handed over`
  } else if (inHandover.length === n && recipients.length === 1) {
    what = disputed
      ? `${recipients[0]} marked not received`
      : `Handed to ${recipients[0]}, not accepted`
  } else {
    what = `${n} payments · ${inHandover.length} handed over, not accepted`
  }
  return `${what} · ${waitingAge(oldestAgeHours)}`
}

/**
 * Everything the panel and the phone strip need, from one set of queries (each
 * deduped by its key, so calling this twice costs nothing).
 */
export function useAttentionSummary({ userId, showAttendance, latestAnnouncement }: AttentionSources) {
  const { viewerId, mine, isError: handoversError, isLoading: handoversLoading } = useOpenHandovers()
  const unclosed = useUnclosedFunds()
  const approvals = usePendingApprovalQueue(userId, showAttendance)

  const toAccept = mine.filter(h => handoverRole(h, viewerId) === 'recipient' && h.canAccept)

  // Not repeated: cash on its way to the viewer is the Accept row above.
  const payments = (unclosed.data?.payments ?? [])
    .filter(p => !(p.openHandover && p.openHandover.recipientId === viewerId))
  const holders: HolderRow[] = totalsByHolder(payments)
    .sort((a, b) => b.oldestAgeHours - a.oldestAgeHours)
    .map(t => ({
      holderId: t.holderId,
      name: t.holderId === viewerId ? 'You' : t.holderName,
      amount: t.amount,
      detail: holderDetail(payments.filter(p => (p.holderId ?? 'unknown') === t.holderId), t.oldestAgeHours),
    }))

  const announcement = latestAnnouncement && !latestAnnouncement.read_at ? latestAnnouncement : null
  const approvalCount = showAttendance ? approvals.rows.length : 0
  const actCount = toAccept.length + approvalCount
  const itemCount = (announcement ? 1 : 0) + toAccept.length + holders.length + approvalCount

  // Known only once every list this person has is in, so "caught up" is never
  // said on the strength of a list still loading.
  const known = !handoversLoading
    && (unclosed.isFetched || unclosed.fetchStatus === 'idle')
    && (!showAttendance || approvals.isFetched)
  const regular = unclosed.data?.scope === 'all' || showAttendance

  return {
    announcement, toAccept, holders, cashTotal: sumAmounts(payments),
    handoversError, cashError: unclosed.isError,
    approvalCount, actCount, itemCount, known, regular,
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function AttentionPanel(props: AttentionSources) {
  const { userId, financeAllowed, showAttendance } = props
  const s = useAttentionSummary(props)

  const caughtUp = s.known && s.itemCount === 0 && !s.handoversError && !s.cashError
  // Nothing here, and nothing that regularly comes here: no panel.
  const show = s.itemCount > 0 || s.handoversError || s.cashError || s.regular
  if (!show) return null

  return (
    <aside id="for-you" className={styles.attention} aria-labelledby="for-you-heading">
      <header className={styles.attentionHead}>
        <h2 id="for-you-heading" className={styles.attentionHeading}>For you</h2>
        {s.known && s.itemCount > 0 && (
          <span className={styles.attentionSummary}>{plural(s.itemCount, 'item', 'items')}</span>
        )}
      </header>

      {caughtUp && <p className={styles.caughtUp}>You&rsquo;re all caught up.</p>}

      {s.announcement && <AnnouncementItem latest={s.announcement} />}

      {(s.toAccept.length > 0 || s.handoversError) && (
        <section className={styles.accept} aria-labelledby="accept-heading">
          <h3 id="accept-heading" className={styles.acceptHeading}>
            <HandCoins size={14} strokeWidth={2} aria-hidden="true" />
            Cash handed to you
          </h3>
          {s.handoversError ? (
            <p className={styles.sectionError} role="alert">
              Handovers could not be loaded, so one waiting for you may be missing.
            </p>
          ) : (
            <>
              <ul className={styles.list}>
                {s.toAccept.map(h => <AcceptItem key={h.id} h={h} />)}
              </ul>
              <p className={styles.acceptHint}>Accept only after the cash is in your hands.</p>
            </>
          )}
        </section>
      )}

      {(s.holders.length > 0 || s.cashError) && (
        <section className={styles.group} aria-labelledby="cash-heading">
          <h3 id="cash-heading" className={styles.groupHeading}>
            <span className={styles.groupLabel}>
              <Banknote size={14} strokeWidth={2} aria-hidden="true" />
              Cash not with the company
            </span>
            {!s.cashError && <span className={styles.groupTotal}>{formatINR(s.cashTotal)}</span>}
          </h3>
          {s.cashError ? (
            <p className={styles.sectionError} role="alert">Could not be loaded.</p>
          ) : (
            <ul className={styles.list}>
              {s.holders.map(h => (
                <li key={h.holderId} className={styles.item}>
                  <span className={styles.avatar} aria-hidden="true">{h.name === 'You' ? 'Y' : initialsOf(h.name)}</span>
                  <span className={styles.itemText}>
                    <span className={styles.itemTitle}>{h.name} · {formatINR(h.amount)}</span>
                    <span className={styles.itemDetail}>{h.detail}</span>
                  </span>
                  {/* Cash journeys is a Finance page: offered only to somebody
                      who may open Finance. */}
                  {financeAllowed && (
                    <Link
                      href={`${CASH_JOURNEYS_PATH}?holder=${encodeURIComponent(h.holderId)}`}
                      className={styles.button}
                      aria-label={`Review cash held by ${h.name}`}
                    >
                      Review
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Rendered for the admin whatever the count, so the queue can load; with
          nothing in it the group is hidden by CSS (`.group:not(:has(li))`). */}
      {showAttendance && userId && (
        <section className={styles.group} aria-labelledby="leave-heading">
          <h3 id="leave-heading" className={styles.groupHeading}>
            <span className={styles.groupLabel}>
              <CalendarClock size={14} strokeWidth={2} aria-hidden="true" />
              Leave and late arrival
            </span>
          </h3>
          <ul className={styles.list}>
            <PendingApprovals userId={userId} />
          </ul>
        </section>
      )}
    </aside>
  )
}

// ── The newest unread announcement ───────────────────────────────────────────
//
// The first row of the list the page already holds: `useMyAnnouncements` is the
// Announcements module's own query (the bell's), and public.my_announcements()
// decides who sees what, newest first. No second query and no ordering here.
// Reading this panel acknowledges nothing; the announcement page does.
function AnnouncementItem({ latest }: { latest: MyAnnouncement }) {
  return (
    <Link
      href={`/announcements/${latest.id}`}
      className={styles.announcement}
      aria-label={`New announcement: ${latest.title}. Read update.`}
    >
      <span className={styles.announcementIcon} aria-hidden="true">
        <Megaphone size={15} strokeWidth={1.9} />
      </span>
      <span className={styles.itemText}>
        <span className={styles.announcementLabel}>New announcement</span>
        <span className={styles.itemTitle}>{latest.title}</span>
        <span className={styles.announcementCta}>
          Read update <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
        </span>
      </span>
    </Link>
  )
}

// ── One handover waiting for the viewer ──────────────────────────────────────
//
// Accept writes through accept_cash_handover (useHandoverActions), after the
// handover page's own confirmation. It records custody only: a payment it
// carries still waits for Finance to verify it.
function AcceptItem({ h }: { h: Handover }) {
  const { accept } = useHandoverActions()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disputed = h.status === 'disputed'

  return (
    <li className={styles.item}>
      <span className={styles.avatarOnTint} aria-hidden="true">{initialsOf(h.giverName)}</span>
      <span className={styles.itemText}>
        <span className={styles.itemTitle}>{formatINR(h.totalAmount)} from {h.giverName}</span>
        <span className={styles.itemDetail}>
          {handoverPaymentCount(h)}{disputed ? ' · marked not received' : ''} · waiting {waitingFor(h.ageHours)}
        </span>
        {error && <span className={styles.itemError} role="alert">{error}</span>}
      </span>
      <button
        type="button"
        className={styles.buttonPrimary}
        disabled={accept.isPending}
        onClick={() => { setError(null); setConfirming(true) }}
        aria-label={`Accept ${formatINR(h.totalAmount)} from ${h.giverName}`}
      >
        Accept
      </button>

      {confirming && (
        <HandoverConfirmDialog
          title="Accept this cash"
          confirmLabel={`Yes, I received ${formatINR(h.totalAmount)}`}
          pending={accept.isPending}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            try { await accept.mutateAsync(h.id); setConfirming(false) }
            catch (e) { setConfirming(false); setError(e instanceof Error ? e.message : 'Could not accept the handover.') }
          }}
        >
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            Accept only after the cash is in your hands. You are confirming that you received{' '}
            <strong>{formatINR(h.totalAmount)}</strong> from <strong>{h.giverName}</strong> for {handoverPaymentCount(h)}.
            You will then be the holder of these payments in the custody trail.
          </p>
        </HandoverConfirmDialog>
      )}
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
  if (s.actCount === 0) return null
  return (
    <a href="#for-you" className={styles.attentionStrip}>
      <span className={styles.attentionStripDot} aria-hidden="true" />
      <span className={styles.attentionStripText}>{s.actCount} waiting on you</span>
      <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
    </a>
  )
}
