'use client'

// ── "For you" on the Modules launcher ────────────────────────────────────────
//
// A 280px column docked to the right-hand edge of the window, holding only what
// the owner asked for (2026-10-29), each as one brief card with one action:
//
//   1. THE NEWEST UNREAD ANNOUNCEMENT — Read. Opening it marks it read (the
//      announcement page acknowledges), and it leaves the panel.
//   2. CASH HANDED TO YOU — for everyone. Accept, after the same "Yes, I
//      received ₹X" confirmation as the handover page.
//   3. CASH NOT WITH THE COMPANY — Finance's own "money not yet with the
//      company" list (finance_unclosed_funds: everyone's for an admin, the
//      custodian or a view_all holder; otherwise the viewer's own), one card per
//      person holding money. Review opens Cash journeys, for Finance users. A
//      handover waiting for the VIEWER is item 2, not repeated here.
//   4. LEAVE AND LATE ARRIVAL — for the signed-in admin (PendingApprovals.tsx).
//
// CLEAR ALL hides every card showing for 24 hours, on this device; anything
// still not dealt with then comes back, and anything new shows at once (see
// src/lib/modules/forYouSnooze.ts). Nothing is deleted, decided or marked read.
//
// WITH NOTHING TO SHOW THE PANEL IS NOT DRAWN AT ALL, and the tiles take the
// whole width again.
//
// A PLACEMENT AND NOTHING ELSE. Every card reads an existing query and every
// write goes through an existing door (accept_cash_handover, the attendance
// decision route). Accepting custody never approves a payment: Finance still
// verifies it (20270417000000).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, Banknote, HandCoins, Megaphone } from 'lucide-react'
import type { MyAnnouncement } from '@/lib/announcements'
import { useHandoverActions, useOpenHandovers } from '@/hooks/queries/useHandovers'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import { HandoverConfirmDialog } from '@/components/finance/HandoverCard'
import { CASH_JOURNEYS_PATH } from '@/components/finance/UnclosedFundsCard'
import { formatINR } from '@/lib/currency'
import { handoverPaymentCount, handoverRole, waitingFor, type Handover } from '@/lib/finance/handover'
import { totalsByHolder, waitingAge, type CashPayment } from '@/lib/finance/cashJourney'
import {
  EMPTY_SNOOZE, isHidden, itemKeys, readSnooze, snoozeAll, snoozeStorageKey, type SnoozeState,
} from '@/lib/modules/forYouSnooze'
import { PendingApprovals, usePendingApprovalQueue } from './PendingApprovals'
import styles from './attentionPanel.module.css'

export type AttentionSources = {
  userId: string | null
  /** The viewer may open Finance, so a cash card can link to Cash journeys. */
  financeAllowed: boolean
  /** The signed-in admin, not previewing: leave and late requests are theirs. */
  showAttendance: boolean
  /** The newest announcement this person may see, or null. */
  latestAnnouncement: MyAnnouncement | null
}

type HolderCard = {
  key: string
  holderId: string
  brief: string
  state: string
  age: string
}

/** What one person's held cash is doing, in a few words (no age: it is in the key). */
function holderState(payments: CashPayment[]): string {
  const n = payments.length
  const inHandover = payments.filter(p => p.openHandover)
  const recipients = [...new Set(inHandover.map(p => p.openHandover!.recipientName))]
  const disputed = inHandover.some(p => p.openHandover!.status === 'disputed')
  if (inHandover.length === 0) return `${n} ${n === 1 ? 'payment' : 'payments'}, not handed over`
  if (inHandover.length === n && recipients.length === 1) {
    return disputed ? `${recipients[0]} marked not received` : `Handed to ${recipients[0]}, not accepted`
  }
  return `${n} payments · ${inHandover.length} handed over, not accepted`
}

/** Told to every copy of useSnooze in this tab when one of them clears. */
const SNOOZE_EVENT = 'boe-for-you-cleared'

/** "Clear all", remembered in this browser for the signed-in user. */
function useSnooze(userId: string | null) {
  const [state, setState] = useState<SnoozeState>(EMPTY_SNOOZE)

  // Read after mount (localStorage is not there during the server render), when
  // the user changes, and whenever another copy of this hook (the panel or the
  // phone strip) or another tab clears — so both agree at once.
  useEffect(() => {
    if (!userId) return
    const load = () => {
      let stored: string | null = null
      try { stored = window.localStorage.getItem(snoozeStorageKey(userId)) } catch { /* private mode */ }
      setState(readSnooze(stored, Date.now()))
    }
    load()
    window.addEventListener(SNOOZE_EVENT, load)
    window.addEventListener('storage', load)
    return () => {
      window.removeEventListener(SNOOZE_EVENT, load)
      window.removeEventListener('storage', load)
    }
  }, [userId])

  // The 24 hours end while the page is open: everything comes back at once.
  // (readSnooze already drops an expired value on load.)
  useEffect(() => {
    if (state.until === 0) return
    const left = Math.max(0, state.until - Date.now())
    const timer = window.setTimeout(() => setState(EMPTY_SNOOZE), Math.min(left, 2 ** 31 - 1))
    return () => window.clearTimeout(timer)
  }, [state.until])

  const clear = useCallback((keys: string[]) => {
    const next = snoozeAll(keys, Date.now())
    setState(next)
    if (!userId) return
    try { window.localStorage.setItem(snoozeStorageKey(userId), JSON.stringify(next)) } catch { /* private mode */ }
    window.dispatchEvent(new Event(SNOOZE_EVENT))
  }, [userId])

  return { state, clear }
}

/**
 * Everything the panel and the phone strip need, from one set of queries (each
 * deduped by its key, so calling this twice costs nothing).
 */
export function useAttentionSummary({ userId, showAttendance, latestAnnouncement }: AttentionSources) {
  const { viewerId, mine, isError: handoversError } = useOpenHandovers()
  const unclosed = useUnclosedFunds()
  const approvals = usePendingApprovalQueue(userId, showAttendance)
  const snooze = useSnooze(userId)
  // The state is only ever unexpired (readSnooze on load, the timer after), so
  // the check needs no clock here.
  const shown = (key: string) => !isHidden(snooze.state, key)

  const announcement = latestAnnouncement && !latestAnnouncement.read_at
    && shown(itemKeys.announcement(latestAnnouncement.id)) ? latestAnnouncement : null

  const toAccept = mine
    .filter(h => handoverRole(h, viewerId) === 'recipient' && h.canAccept)
    .filter(h => shown(itemKeys.handover(h.id)))

  // Not repeated: cash on its way to the viewer is an Accept card above.
  const payments = (unclosed.data?.payments ?? [])
    .filter(p => !(p.openHandover && p.openHandover.recipientId === viewerId))
  const holders: HolderCard[] = totalsByHolder(payments)
    .sort((a, b) => b.oldestAgeHours - a.oldestAgeHours)
    .map(t => {
      const own = payments.filter(p => (p.holderId ?? 'unknown') === t.holderId)
      const state = holderState(own)
      return {
        key: itemKeys.holder(t.holderId, t.amount, state),
        holderId: t.holderId,
        brief: t.holderId === viewerId ? `You hold ${formatINR(t.amount)}` : `${t.holderName} holds ${formatINR(t.amount)}`,
        state,
        age: waitingAge(t.oldestAgeHours),
      }
    })
    .filter(h => shown(h.key))

  const requests = showAttendance
    ? approvals.rows.filter(r => shown(itemKeys.request(r.id)))
    : []

  const actCount = toAccept.length + requests.length
  const itemCount = (announcement ? 1 : 0) + toAccept.length + holders.length + requests.length
  const visibleKeys = [
    ...(announcement ? [itemKeys.announcement(announcement.id)] : []),
    ...toAccept.map(h => itemKeys.handover(h.id)),
    ...holders.map(h => h.key),
    ...requests.map(r => itemKeys.request(r.id)),
  ]

  return {
    announcement, toAccept, holders, requests,
    handoversError, cashError: unclosed.isError, approvalsError: showAttendance && approvals.isError,
    actCount, itemCount, visibleKeys, shown, clearAll: () => snooze.clear(visibleKeys),
  }
}

export function AttentionPanel(props: AttentionSources) {
  const { userId, financeAllowed } = props
  const s = useAttentionSummary(props)
  const errors = s.handoversError || s.cashError || s.approvalsError

  // Nothing to show: no panel at all, and the tiles take the whole width.
  if (s.itemCount === 0 && !errors) return null

  return (
    <aside id="for-you" className={styles.attention} aria-labelledby="for-you-heading">
      <header className={styles.attentionHead}>
        <h2 id="for-you-heading" className={styles.attentionHeading}>
          For you <span className={styles.attentionCount}>{s.itemCount}</span>
        </h2>
        {s.itemCount > 0 && (
          <button
            type="button"
            className={styles.clearAll}
            onClick={s.clearAll}
            title="Hide these for 24 hours. Anything not dealt with by then comes back."
          >
            Clear all
          </button>
        )}
      </header>

      <ul className={styles.cards}>
        {s.announcement && <AnnouncementCard latest={s.announcement} />}

        {s.handoversError && (
          <ErrorCard icon={<HandCoins size={13} strokeWidth={2} />} label="Cash handovers">
            Could not be loaded, so one waiting for you may be missing.
          </ErrorCard>
        )}
        {s.toAccept.map(h => <AcceptCard key={h.id} h={h} />)}

        {s.cashError && (
          <ErrorCard icon={<Banknote size={13} strokeWidth={2} />} label="Cash not with the company">
            Could not be loaded.
          </ErrorCard>
        )}
        {s.holders.map(h => (
          <li key={h.key} className={styles.card}>
            <span className={styles.cardLabel}>
              <Banknote size={13} strokeWidth={2} aria-hidden="true" />
              Not with the company · {h.age}
            </span>
            <span className={styles.cardBrief}>{h.brief}</span>
            <span className={styles.cardDetail}>{h.state}</span>
            {/* Cash journeys is a Finance page: offered only to somebody who
                may open Finance. */}
            {financeAllowed && (
              <Link
                href={`${CASH_JOURNEYS_PATH}?holder=${encodeURIComponent(h.holderId)}`}
                className={styles.button}
                aria-label={`Review: ${h.brief}`}
              >
                Review
              </Link>
            )}
          </li>
        ))}

        {(s.requests.length > 0 || s.approvalsError) && userId && (
          <PendingApprovals userId={userId} shown={key => s.shown(key)} />
        )}
      </ul>
    </aside>
  )
}

function ErrorCard({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <li className={styles.card} role="alert">
      <span className={styles.cardLabel}><span aria-hidden="true">{icon}</span>{label}</span>
      <span className={styles.cardError}>{children}</span>
    </li>
  )
}

// ── The newest unread announcement ───────────────────────────────────────────
//
// The first row of the list the page already holds: `useMyAnnouncements` is the
// Announcements module's own query (the bell's), and public.my_announcements()
// decides who sees what, newest first. No second query and no ordering here.
// Reading this panel acknowledges nothing; the announcement page does.
function AnnouncementCard({ latest }: { latest: MyAnnouncement }) {
  return (
    <li className={styles.card}>
      <span className={styles.cardLabel}>
        <Megaphone size={13} strokeWidth={2} aria-hidden="true" />
        New announcement
      </span>
      <span className={styles.cardBrief}>{latest.title}</span>
      <Link
        href={`/announcements/${latest.id}`}
        className={styles.button}
        aria-label={`Read announcement: ${latest.title}`}
      >
        Read
      </Link>
    </li>
  )
}

// ── One handover waiting for the viewer ──────────────────────────────────────
//
// Accept writes through accept_cash_handover (useHandoverActions), after the
// handover page's own confirmation. It records custody only: a payment it
// carries still waits for Finance to verify it.
function AcceptCard({ h }: { h: Handover }) {
  const { accept } = useHandoverActions()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disputed = h.status === 'disputed'

  return (
    <li className={`${styles.card} ${styles.cardUrgent}`}>
      <span className={styles.cardLabelUrgent}>
        <HandCoins size={13} strokeWidth={2} aria-hidden="true" />
        Handed to you · {waitingFor(h.ageHours)}
      </span>
      <span className={styles.cardBrief}>{formatINR(h.totalAmount)} from {h.giverName}</span>
      <span className={styles.cardDetail}>
        {handoverPaymentCount(h)}{disputed ? ' · marked not received' : ''}
      </span>
      {error && <span className={styles.cardError} role="alert">{error}</span>}
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
