'use client'

// ── "For you" on the Modules launcher ────────────────────────────────────────
//
// A 280px column docked to the right-hand edge of the window, holding only what
// the owner asked for (2026-10-29), each as one brief card with one action:
//
//   1. THE NEWEST UNREAD ANNOUNCEMENT — Read. Opening it marks it read (the
//      announcement page acknowledges), and it leaves the panel.
//   1b. PI RETURNED TO YOU (owner, 2026-10-30) — one card per PI in Returned to
//      Sales where the viewer is its salesperson, creator or submitter, from
//      my_returned_pis() (20270507000000). Open PI. It stays until the PI is
//      submitted again or deleted — reading the notification does not remove
//      it — and turns red from the third day. Never the approver's note. Not
//      notification previews: those stay out of this panel (2026-10-29).
//   2. THE VIEWER'S OWN CASH, for everyone, as it passes hand to hand until a
//      company cash custodian (Nitish) accepts it (owner, 2026-10-29). Both
//      people in an open handover see it until it changes hands:
//        - HANDED TO YOU: Accept, after the handover page's own "Yes, I
//          received ₹X". Then, unless the viewer is a custodian (whose accepting
//          closes the journey), "Hand over cash" opens at once with those
//          payments ticked: who did you give it to?
//        - WAITING FOR <recipient>: the giver's side. Remind (the server allows
//          one every 4 hours).
//        - YOU HOLD: accepted or recorded cash not handed on yet. Hand over.
//   3. CASH NOT WITH THE COMPANY — everybody else's, from Finance's own "money
//      not yet with the company" list (finance_unclosed_funds: everyone's for an
//      admin, the custodian or a view_all holder), one card per person holding
//      money. Review opens Cash journeys, for Finance users. The viewer's own
//      cash is item 2, not repeated here.
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
// write goes through an existing door (accept_cash_handover,
// remind_cash_handover, create_cash_handover via HandoverModal, the attendance
// decision route; a returned PI opens the existing PI page). Accepting custody never approves a payment: Finance still
// verifies it (20270417000000).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, Banknote, Clock, HandCoins, Megaphone, Undo2, Wallet } from 'lucide-react'
import type { MyAnnouncement } from '@/lib/announcements'
import { useHandoverActions, useOpenHandovers } from '@/hooks/queries/useHandovers'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import { useMyReturnedPis } from '@/hooks/queries/useMyReturnedPis'
import {
  isReturnedPiUrgent, returnedAge, returnedBrief, returnedDetail, type ReturnedPi,
} from '@/lib/orders/returnedPis'
import { HandoverConfirmDialog } from '@/components/finance/HandoverCard'
import { HandoverModal } from '@/components/finance/HandoverModal'
import { CASH_JOURNEYS_PATH } from '@/components/finance/UnclosedFundsCard'
import { formatINR } from '@/lib/currency'
import { handoverPaymentCount, handoverRole, waitingFor, type Handover } from '@/lib/finance/handover'
import { sumAmounts, totalsByHolder, waitingAge, type CashPayment } from '@/lib/finance/cashJourney'
import {
  EMPTY_SNOOZE, isHidden, itemKeys, readSnooze, snoozeAll, snoozeStorageKey, type SnoozeState,
} from '@/lib/modules/forYouSnooze'
import { PendingApprovals, usePendingApprovalQueue } from './PendingApprovals'
import styles from './attentionPanel.module.css'

export type AttentionSources = {
  userId: string | null
  /** The viewer may open Finance, so a cash card can link to Cash journeys. */
  financeAllowed: boolean
  /** The viewer may open Order Management: PIs returned to them are read. */
  ordersAllowed: boolean
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

/** Cash the viewer holds and has not handed on yet. */
type HeldCard = {
  key: string
  amount: number
  count: number
  age: string
  canHandOver: boolean
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
export function useAttentionSummary({ userId, ordersAllowed, showAttendance, latestAnnouncement }: AttentionSources) {
  const { viewerId, mine, isError: handoversError } = useOpenHandovers()
  const unclosed = useUnclosedFunds()
  const returnedPis = useMyReturnedPis(ordersAllowed)
  const approvals = usePendingApprovalQueue(userId, showAttendance)
  const snooze = useSnooze(userId)
  // The state is only ever unexpired (readSnooze on load, the timer after), so
  // the check needs no clock here.
  const shown = (key: string) => !isHidden(snooze.state, key)

  const announcement = latestAnnouncement && !latestAnnouncement.read_at
    && shown(itemKeys.announcement(latestAnnouncement.id)) ? latestAnnouncement : null

  // PIs returned to the viewer: each is waiting on them until they submit it again.
  const returned = (returnedPis.data ?? []).filter(r => shown(itemKeys.returnedPi(r.submissionId, r.since)))

  const toAccept = mine
    .filter(h => handoverRole(h, viewerId) === 'recipient' && h.canAccept)
    .filter(h => shown(itemKeys.handover(h.id)))

  // The giver's side of the same handovers: shown until the recipient accepts.
  const handedOut = mine
    .filter(h => handoverRole(h, viewerId) === 'giver')
    .filter(h => shown(itemKeys.handover(h.id)))

  const allPayments = unclosed.data?.payments ?? []
  // What the viewer holds and has not handed on. (Held cash already in an open
  // handover is a "Waiting for" card above.) A custodian's cash is with the
  // company, so finance_unclosed_funds never lists it.
  const ownLoose = allPayments.filter(p => p.holderId === viewerId && !p.openHandover)
  const ownTotal = sumAmounts(ownLoose)
  const heldKey = viewerId ? itemKeys.holder(viewerId, ownTotal, 'held') : ''
  const held: HeldCard | null = viewerId && ownLoose.length > 0 && shown(heldKey)
    ? {
        key: heldKey,
        amount: ownTotal,
        count: ownLoose.length,
        age: waitingAge(Math.max(...ownLoose.map(p => p.ageHours))),
        canHandOver: ownLoose.some(p => p.canHandOver),
      }
    : null

  // Everybody else's. Not repeated: the viewer's own cash, and cash on its way
  // to the viewer (an Accept card above).
  const payments = allPayments
    .filter(p => p.holderId !== viewerId)
    .filter(p => !(p.openHandover && p.openHandover.recipientId === viewerId))
  const holders: HolderCard[] = totalsByHolder(payments)
    .sort((a, b) => b.oldestAgeHours - a.oldestAgeHours)
    .map(t => {
      const own = payments.filter(p => (p.holderId ?? 'unknown') === t.holderId)
      const state = holderState(own)
      return {
        key: itemKeys.holder(t.holderId, t.amount, state),
        holderId: t.holderId,
        brief: `${t.holderName} holds ${formatINR(t.amount)}`,
        state,
        age: waitingAge(t.oldestAgeHours),
      }
    })
    .filter(h => shown(h.key))

  const requests = showAttendance
    ? approvals.rows.filter(r => shown(itemKeys.request(r.id)))
    : []

  // Waiting on the viewer: accepting, handing on, deciding. Not their own
  // "Waiting for" cards: that is somebody else's move.
  const actCount = returned.length + toAccept.length + (held?.canHandOver ? 1 : 0) + requests.length
  const itemCount = (announcement ? 1 : 0) + returned.length + toAccept.length + handedOut.length + (held ? 1 : 0)
    + holders.length + requests.length
  const visibleKeys = [
    ...(announcement ? [itemKeys.announcement(announcement.id)] : []),
    ...returned.map(r => itemKeys.returnedPi(r.submissionId, r.since)),
    ...toAccept.map(h => itemKeys.handover(h.id)),
    ...handedOut.map(h => itemKeys.handover(h.id)),
    ...(held ? [held.key] : []),
    ...holders.map(h => h.key),
    ...requests.map(r => itemKeys.request(r.id)),
  ]

  return {
    announcement, returned, toAccept, handedOut, held, holders, requests,
    viewerIsCustodian: unclosed.data?.viewerIsCustodian ?? false,
    returnedError: ordersAllowed && returnedPis.isError,
    handoversError, cashError: unclosed.isError, approvalsError: showAttendance && approvals.isError,
    actCount, itemCount, visibleKeys, shown, clearAll: () => snooze.clear(visibleKeys),
  }
}

export function AttentionPanel(props: AttentionSources) {
  const { userId, financeAllowed } = props
  const s = useAttentionSummary(props)
  const errors = s.returnedError || s.handoversError || s.cashError || s.approvalsError
  // "Hand over cash", opened from a card. Kept here, not in the card: the card
  // it was opened from leaves the list the moment its handover is accepted.
  // `paymentIds` = the payments to tick first (null = none).
  const [handOn, setHandOn] = useState<{ paymentIds: string[] | null } | null>(null)

  const handOnModal = handOn && (
    <HandoverModal
      initialPaymentIds={handOn.paymentIds ?? undefined}
      onClose={() => setHandOn(null)}
    />
  )

  // Nothing to show: no panel at all, and the tiles take the whole width.
  if (s.itemCount === 0 && !errors) return handOnModal || null

  return (
    <>
    {handOnModal}
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

        {s.returnedError && (
          <ErrorCard icon={<Undo2 size={13} strokeWidth={2} />} label="PIs returned to you">
            Could not be loaded, so one waiting for you may be missing.
          </ErrorCard>
        )}
        {s.returned.map(r => <ReturnedPiCard key={r.submissionId} r={r} />)}

        {s.handoversError && (
          <ErrorCard icon={<HandCoins size={13} strokeWidth={2} />} label="Cash handovers">
            Could not be loaded, so one waiting for you may be missing.
          </ErrorCard>
        )}
        {s.toAccept.map(h => (
          <AcceptCard
            key={h.id}
            h={h}
            // Accepted: who did you give it to? Not for a custodian, whose
            // accepting puts the cash with the company and ends the journey.
            onAccepted={s.viewerIsCustodian ? undefined : () => setHandOn({ paymentIds: h.items.map(i => i.paymentId) })}
          />
        ))}
        {s.handedOut.map(h => <WaitingCard key={h.id} h={h} />)}
        {s.held && (
          <li className={`${styles.card} ${styles.cardUrgent}`}>
            <span className={styles.cardLabelUrgent}>
              <Wallet size={13} strokeWidth={2} aria-hidden="true" />
              With you · {s.held.age}
            </span>
            <span className={styles.cardBrief}>You hold {formatINR(s.held.amount)}</span>
            <span className={styles.cardDetail}>
              {s.held.count} {s.held.count === 1 ? 'payment' : 'payments'}, not with the company yet
            </span>
            {s.held.canHandOver && (
              <button
                type="button"
                className={styles.buttonPrimary}
                onClick={() => setHandOn({ paymentIds: null })}
                aria-label={`Hand over ${formatINR(s.held.amount)}`}
              >
                Hand over
              </button>
            )}
          </li>
        )}

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
    </>
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

// ── One PI returned to the viewer ────────────────────────────────────────────
//
// Which PI, who returned it, how long ago; Open PI goes to the existing PI page,
// whose attention card shows the approver's note. Red from the third day. A PI
// the existing rules would not let the viewer open gets no button.
function ReturnedPiCard({ r }: { r: ReturnedPi }) {
  const urgent = isReturnedPiUrgent(r.waitingSeconds)
  return (
    <li className={urgent ? `${styles.card} ${styles.cardUrgent}` : styles.card}>
      <span className={urgent ? styles.cardLabelUrgent : styles.cardLabel}>
        <Undo2 size={13} strokeWidth={2} aria-hidden="true" />
        PI returned to you · {returnedAge(r.waitingSeconds)}
      </span>
      <span className={styles.cardBrief}>{returnedBrief(r)}</span>
      <span className={styles.cardDetail}>{returnedDetail(r)}</span>
      {r.canOpen ? (
        <Link
          href={`/orders/drafts/${r.submissionId}`}
          className={styles.buttonPrimary}
          aria-label={`Open PI: ${returnedBrief(r)}`}
        >
          Open PI
        </Link>
      ) : (
        <span className={styles.cardDetail}>Opens only for whoever filed it</span>
      )}
    </li>
  )
}

// ── One handover waiting for the viewer ──────────────────────────────────────
//
// Accept writes through accept_cash_handover (useHandoverActions), after the
// handover page's own confirmation. It records custody only: a payment it
// carries still waits for Finance to verify it. `onAccepted` then asks who the
// cash went to next.
function AcceptCard({ h, onAccepted }: { h: Handover; onAccepted?: () => void }) {
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
        {disputed ? 'Marked not received' : 'Not accepted yet'} · {handoverPaymentCount(h)}
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
            try { await accept.mutateAsync(h.id); setConfirming(false); onAccepted?.() }
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

// ── One handover the viewer gave, not accepted yet ───────────────────────────
//
// The giver's side of an Accept card. Remind writes through
// remind_cash_handover, which notifies the recipient and refuses a second
// reminder within 4 hours (its sentence is shown as it comes).
function WaitingCard({ h }: { h: Handover }) {
  const { remind } = useHandoverActions()
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  return (
    <li className={styles.card}>
      <span className={styles.cardLabel}>
        <Clock size={13} strokeWidth={2} aria-hidden="true" />
        Waiting for {h.recipientName} · {waitingFor(h.ageHours)}
      </span>
      <span className={styles.cardBrief}>You handed {formatINR(h.totalAmount)} to {h.recipientName}</span>
      <span className={styles.cardDetail}>
        {h.recipientName} has not accepted yet · {handoverPaymentCount(h)}
      </span>
      {error && <span className={styles.cardError} role="alert">{error}</span>}
      {sent && <span className={styles.cardDetail} role="status">Reminder sent</span>}
      {h.canRemind && !sent && (
        <button
          type="button"
          className={styles.button}
          disabled={remind.isPending}
          onClick={async () => {
            setError(null)
            try { await remind.mutateAsync(h.id); setSent(true) }
            catch (e) { setError(e instanceof Error ? e.message : 'Could not send the reminder.') }
          }}
        >
          Remind {h.recipientName}
        </button>
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
