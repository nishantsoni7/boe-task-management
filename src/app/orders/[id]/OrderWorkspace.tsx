'use client'

// THE CONFIRMED ORDER WORKSPACE — the presentational pieces of /orders/[id].
//
// PAGE-OWNED, like OrderPiSections.tsx beside it: nothing else renders these.
// EVERY COMPONENT BELOW IS A FUNCTION OF ITS PROPS. Nothing here fetches,
// writes, authorizes or decides. What needs attention, how the health card
// reads, which action is primary and how much of the trail is shown are
// decided by ../../../lib/orders/orderWorkspace; the page decides which
// controls exist from the capabilities the database resolved. These draw the
// answers.
//
// THE VISUAL LANGUAGE IS THE EXISTING ONE. Cards are the shared PiCard the PI
// sections already use, buttons are the record-header actions the Assets and
// Order Request screens introduced, and every colour is a token.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, MoreHorizontal } from 'lucide-react'
import { PiCard, PiCardHeader } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { formatMoney, formatPercent } from '@/lib/finance/piPaymentView'
import { type OrderFinancePosition } from '@/lib/finance/orderFinancePosition'
import { PAYMENT_BAR_COLORS_SUBDUED, PiPaymentProgress } from '@/components/orders/PiPaymentCard'
import { PAYMENT_MODE_LABEL, customerDisplayName } from '@/lib/finance/paymentEntry'
import { piPaymentStatusLabel } from '@/lib/finance/piPaymentView'
import {
  PAYMENT_DETAIL_BACK,
  PAYMENT_DETAIL_SPLIT_NOTE,
  PAYMENT_DETAIL_TITLE,
  PAYMENT_DETAIL_VIEW,
  paymentListCaption,
  PAYMENT_LIST_EMPTY,
  PAYMENT_LIST_TITLE,
  RECEIVED_IN_LABEL,
  orderPaymentById,
  type OrderPaymentDetailState,
  type OrderPaymentListKind,
  type OrderPaymentListRow,
} from '@/lib/orders/orderPaymentLists'
import { OrderModalShell } from './OrderStatusWorkspace'
import {
  activityToggleLabel,
  activityWindow,
  attentionHeading,
  ORDER_PRODUCTION_LABEL,
  SUMMARY_GROUP_TITLE,
  type OrderAttentionItem,
  type OrderFactRow,
  type OrderSummaryView,
  type WorkspaceTone,
} from '@/lib/orders/orderWorkspace'

// ── Shared chrome ─────────────────────────────────────────────────────────────

/** The compact header every section on this page uses: one line, no slack. */
export const SECTION_HEADER_STYLE: React.CSSProperties = { padding: '9px 16px' }

// ── Tones ─────────────────────────────────────────────────────────────────────

const TONE: Record<WorkspaceTone, { dot: string; text: string }> = {
  neutral: { dot: colors.muted, text: colors.primary },
  blue:    { dot: colors.blue,  text: colors.primary },
  green:   { dot: colors.green, text: '#2F7A52' },
  amber:   { dot: colors.amber, text: '#9A6A12' },
  red:     { dot: colors.red,   text: '#B42318' },
}

// ── The attention bar ─────────────────────────────────────────────────────────

/**
 * What needs somebody's attention, in one restrained strip: the count, then
 * the conditions separated so each reads on its own. Rendered only when there
 * is something to say; the page hides it otherwise. Amber ground, red text
 * only for the genuinely overdue item — and the words carry the meaning, so
 * nothing here depends on colour alone.
 */
export function OrderAttentionBar({ items }: { items: readonly OrderAttentionItem[] }) {
  if (items.length === 0) return null
  return (
    <section className="order-attention" aria-label={attentionHeading(items.length)}>
      <AlertTriangle size={15} strokeWidth={2.2} aria-hidden="true" className="order-attention-icon" />
      <span className="order-attention-heading">{attentionHeading(items.length)}</span>
      <ul className="order-attention-list">
        {items.map(item => (
          <li key={item.key} className={item.tone === 'red' ? 'order-attention-item order-attention-item--red' : 'order-attention-item'}>
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── The Order Summary panel ───────────────────────────────────────────────────

/**
 * THREE GROUPS, READ LEFT TO RIGHT, IN THE ORDER A READER ASKS THEM.
 *
 *   1  who the client is, and what the order is worth
 *   2  who owns the sale, and whether production has been aligned
 *   3  the dates
 *
 * WHAT IT REPLACED. A flat row of six equal fact cells, plus a separate Record
 * information block below the payment section holding the salesperson, the lead
 * source and production. The two together meant a reader told "Production not
 * aligned" by the attention strip had to scroll past the money to find the
 * field that said so. The three operational facts are now in group 2, beside
 * the sale they belong to, and the block below the payment is gone.
 *
 * EVERY FIELD IS ONE ROW: the label on the left, the value on the right, and
 * the values of a group ending on one edge that can be scanned. The client's
 * name used to be an oversized paragraph and the total product value a tinted
 * panel of its own, which made one group three different kinds of thing and the
 * panel half again as tall as the facts in it need. Both are rows now; the
 * value keeps a half-step of extra weight and nothing more.
 *
 * THE HEADINGS CARRY THE HIERARCHY, and they are the only thing that does. A
 * section heading is dark, semibold and ruled off; a row label is small and
 * muted. Before, both were the same 10px uppercase grey, so a group title and
 * a field caption were indistinguishable at a glance.
 *
 * PRODUCTION IS A BADGE — the one value in the panel that is a STATUS rather
 * than a name — and its supporting line is drawn ONLY when the Order is
 * aligned. orderSummaryView has already made that line null otherwise, so there
 * is no empty "aligned on" row to read past.
 *
 * A MISSING VALUE IS DRAWN QUIETLY AND NEVER SUBSTITUTED. The two builders
 * behind this have already turned a null into `Not available` or `Not set`;
 * this only mutes it. The one field that raises its voice is a due date that
 * has passed, which is the page's existing overdue rule and not a new one.
 *
 * DESKTOP IS THREE COLUMNS, tablet two and mobile one — the groups stack whole,
 * and every value wraps inside its own cell rather than widening the page.
 */
export const ORDER_SUMMARY_TITLE = 'Order summary'

/**
 * ONE FIELD: THE LABEL ON THE LEFT, THE VALUE ON THE RIGHT, ONE LINE EACH.
 *
 * The pair used to stack — a small uppercase caption with its value underneath
 * — which cost two lines per field and left the values on a ragged left edge
 * that could not be scanned. They are a two-column row now: the labels form one
 * column, the values end on one right edge, and a group of four fields is four
 * lines rather than eight.
 *
 * THE VALUE COLUMN IS FLEXIBLE, NOT FIXED. A long client name or location wraps
 * inside its own cell and pushes the row taller; it never widens the panel and
 * never introduces a horizontal scroll. `min-width: 0` on both cells is what
 * lets that happen — see the rule in globals.css.
 */
function SummaryRow({ row }: { row: OrderFactRow }) {
  const tone = TONE[row.tone]
  const warning = row.tone === 'amber' || row.tone === 'red'
  return (
    <div className={[
      'order-sum-row',
      row.missing ? 'order-sum-row--missing' : '',
      row.emphasis ? 'order-sum-row--strong' : '',
      warning ? `order-sum-row--${row.tone}` : '',
    ].filter(Boolean).join(' ')}>
      <dt className="order-sum-label">{row.label}</dt>
      <dd className="order-sum-value">
        <span style={{ color: row.missing ? colors.muted : tone.text, fontWeight: warning ? 700 : 600 }}>
          {row.value}
        </span>
        {row.detail && <span className="order-sum-detail" style={{ color: tone.text }}>{row.detail}</span>}
      </dd>
    </div>
  )
}

export function OrderSummaryPanel({ view }: { view: OrderSummaryView }) {
  const production = view.sales.production
  const productionTone = STATUS_PILL_TONE[production.tone]
  return (
    <section className="order-facts" aria-label={ORDER_SUMMARY_TITLE}>
      <div className="order-sum-groups">

        {/* ── 1. Client and value ──
            FOUR ROWS AND NOTHING ELSE: the client, the contact, the location
            and what the products come to. The name was an oversized paragraph
            and the value a tinted panel, which between them made one group look
            like three different kinds of thing and made this card the tallest
            of the three for no reason a reader benefits from. */}
        <section className="order-sum-group" aria-label={SUMMARY_GROUP_TITLE.client}>
          <h3 className="order-sum-group-head">{SUMMARY_GROUP_TITLE.client}</h3>
          <dl className="order-sum-rows">
            {view.client.rows.map(row => <SummaryRow key={row.key} row={row} />)}
          </dl>
        </section>

        {/* ── 2. Sales and production ──
            PRODUCTION LEADS, as a row like the two under it. Its value is the
            badge rather than plain text, because the alignment state is the one
            thing in this group that is a STATUS and not a name — the word still
            carries it, and the tint only agrees. */}
        <section className="order-sum-group" aria-label={SUMMARY_GROUP_TITLE.sales}>
          <h3 className="order-sum-group-head">{SUMMARY_GROUP_TITLE.sales}</h3>
          <dl className="order-sum-rows">
            <div className="order-sum-row order-sum-row--production">
              <dt className="order-sum-label">{ORDER_PRODUCTION_LABEL}</dt>
              <dd className="order-sum-value">
                <span
                  className="order-sum-badge"
                  style={{ background: productionTone.bg, color: productionTone.fg, borderColor: productionTone.border }}
                >
                  {production.label}
                </span>
                {/* ONLY WHEN ALIGNED. Never an empty date or an empty actor. */}
                {production.line && (
                  <span className="order-sum-production-line">{production.line}</span>
                )}
              </dd>
            </div>
            {view.sales.rows.map(row => <SummaryRow key={row.key} row={row} />)}
          </dl>
        </section>

        {/* ── 3. Important dates ── */}
        <section className="order-sum-group" aria-label={SUMMARY_GROUP_TITLE.dates}>
          <h3 className="order-sum-group-head">{SUMMARY_GROUP_TITLE.dates}</h3>
          <dl className="order-sum-rows order-sum-rows--dates">
            {view.dates.map(row => <SummaryRow key={row.key} row={row} />)}
          </dl>
        </section>

      </div>
    </section>
  )
}


// ── The status pill ───────────────────────────────────────────────────────────

/**
 * THE STATUS, BESIDE THE ORDER NUMBER — "ORDER BOE-147  IN PRODUCTION".
 *
 * It used to be the first of six equal facts in the band below, which made the
 * one thing every reader opens this page to check indistinguishable from the
 * lead source. It is now a filled pill on the same line as the number, in the
 * status's own colour, at a size that carries across the room.
 *
 * COLOUR IS NOT THE MESSAGE. The word is the message; the tint only agrees
 * with it. Nothing on this page depends on a reader telling amber from red.
 */
export const STATUS_PILL_TONE: Record<WorkspaceTone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: colors.raised,    fg: colors.secondary, border: colors.border },
  blue:    { bg: colors.blueTint,  fg: colors.blue,      border: 'rgba(58,122,190,0.30)' },
  green:   { bg: colors.greenTint, fg: '#2F7A52',        border: 'rgba(69,168,112,0.32)' },
  amber:   { bg: colors.amberTint, fg: '#9A6A12',        border: 'rgba(190,140,40,0.30)' },
  red:     { bg: colors.redTint,   fg: '#B42318',        border: 'rgba(217,79,79,0.32)' },
}

export function OrderStatusPill({ label, tone }: { label: string; tone: WorkspaceTone }) {
  const t = STATUS_PILL_TONE[tone]
  return (
    <span
      className="order-status-pill"
      style={{ background: t.bg, color: t.fg, borderColor: t.border }}
    >
      {label}
    </span>
  )
}

// ── The payment section ───────────────────────────────────────────────────────

export const PAYMENT_SECTION_TITLE = 'Payment'

/** The one creating action in this section. Finance’s own form does the work;
 *  this page only opens it. Named here with the section it sits in. */
export const ADD_PAYMENT_ACTION_LABEL = 'Add payment'

/**
 * THE ONLY PAYMENT FIGURES ON THE PAGE, and now the only payment surface too.
 *
 * WHAT A READER CAME FOR, IN FIVE LINES. How much is verified, how much is
 * awaiting Finance, how much remains, and what percentage of the Order that
 * verified money covers. The section used to answer those four questions with a
 * headline, two metric blocks, a bar, a three-item legend naming the same
 * shares the metric blocks had just named, a second grid of three captioned
 * figures restating the order value and adding verified to awaiting under the
 * caption `Received`, and a permanently open table of every payment underneath.
 * The same rupees appeared up to three times, and the section was taller than
 * the product list.
 *
 * THE TWO METRICS ARE BUTTONS NOW. A figure that is the total of a set of real
 * payments should open that set; the alternative -- printing the whole set under
 * the figure, forever, on a page that also carries products, activity and a
 * commercial breakdown -- is what made this section the tallest on the screen.
 * The dialog is the same rows the table drew, with the columns nobody read
 * removed.
 *
 * NOTHING WAS DROPPED. Order value is stated in the line under the headline
 * ("X verified of Y order value"); `Received` was verified plus awaiting, and
 * both of its parts are named and clickable above it; the legend named the
 * three shares of a bar whose two coloured shares are the two buttons beside
 * it. Balance keeps its own line, because it is the one figure that is not the
 * total of anything shown.
 *
 * EVERY FIGURE IS buildOrderFinancePosition'S. Nothing here adds, subtracts or
 * percentages money, and no amount, percentage or status rule changed in this
 * pass.
 */
export function PaymentSummaryFigures({ finance, loaded, onOpenList }: {
  finance: OrderFinancePosition
  /** False while the payment reads are still in flight. */
  loaded: boolean
  /**
   * Open the payments behind one of the two figures. Always offered, including
   * for an empty set: a figure of zero that cannot be opened leaves a reader
   * unable to tell a broken control from an empty list.
   */
  onOpenList: (kind: OrderPaymentListKind) => void
}) {
  if (!loaded) {
    return (
      <div role="status" aria-label="Loading payment summary">
        <SkeletonBlock w={152} h={28} />
        <div style={{ marginTop: 8 }}><SkeletonBlock w={240} h={12} /></div>
        <div className="order-pay-metrics" style={{ marginTop: 12 }}>
          {[0, 1].map(i => (
            <div key={i} className="order-pay-metric">
              <SkeletonBlock w={92} h={10} />
              <div style={{ marginTop: 7 }}><SkeletonBlock w={104} h={16} /></div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  /** The two parts of what has been received -- each one a door to its rows. */
  const metrics: {
    kind: OrderPaymentListKind; label: string; amount: string; meta: string; tone: WorkspaceTone
  }[] = [
    {
      kind: 'verified',
      label: 'Verified',
      amount: formatMoney(finance.verified),
      meta: finance.counts.verified > 0
        ? `${finance.counts.verified} payment${finance.counts.verified === 1 ? '' : 's'}`
        : 'no payments',
      tone: 'green',
    },
    {
      kind: 'awaiting',
      label: 'Awaiting verification',
      amount: formatMoney(finance.awaitingVerification),
      meta: finance.counts.awaiting > 0
        ? `${finance.counts.awaiting} payment${finance.counts.awaiting === 1 ? '' : 's'}`
        : 'no payments',
      tone: finance.counts.awaiting > 0 ? 'amber' : 'neutral',
    },
  ]

  return (
    <>
      {/* THE HEADLINE -- the one percentage a reader came for, and the word it
          qualifies. The figure is buildOrderFinancePosition's and is
          deliberately not capped, so an overpaid Order reads over 100%. */}
      <div className="order-pay-headline">
        <span
          className="order-pay-percent"
          style={{ color: finance.fullyPaid ? TONE.green.text : colors.primary }}
        >
          {formatPercent(finance.verifiedPercent)}
        </span>
        <span className="order-pay-word">verified</span>
      </div>
      {/* THE ORDER VALUE IS STATED HERE, and nowhere else in this section. */}
      <div className="order-pay-of">
        {formatMoney(finance.verified)} verified of {formatMoney(finance.orderValue)} order value
      </div>

      <div className="order-pay-metrics">
        {metrics.map(metric => (
          <button
            key={metric.kind}
            type="button"
            className={`order-pay-metric order-pay-metric--${metric.kind}`}
            onClick={() => onOpenList(metric.kind)}
            aria-label={`${metric.label}: ${metric.amount}, ${metric.meta}. Show the payments.`}
          >
            <span className="order-pay-metric-label">{metric.label}</span>
            <span className="order-pay-metric-value" style={{ color: TONE[metric.tone].text }}>
              {metric.amount}
            </span>
            <span className="order-pay-metric-meta">{metric.meta}</span>
          </button>
        ))}
      </div>

      {/* THE SHARED TRACK, the Draft PI's own component -- green for money
          Finance verified, amber for the rest of what was received, the
          remainder for what has not arrived. Percentages in, pixels out: it
          computes no money. The Order shows no advance marker here, so it is
          passed none rather than being given an invented one.

          NO LEGEND. The two buttons above it name the two coloured shares, in
          the same words and the same order, and the bar's accessible label
          names all three -- a legend repeating them was a third statement of
          figures already made twice. */}
      {finance.verifiedPercent !== null && (
        <PiPaymentProgress
          confirmedPercent={Number(finance.verifiedPercent)}
          receivedPercent={Number(finance.receivedPercent ?? finance.verifiedPercent)}
          thresholdPercent={null}
          height={10}
          palette={PAYMENT_BAR_COLORS_SUBDUED}
          label={`Verified: ${formatPercent(finance.verifiedPercent)} of the order value -- ${formatMoney(finance.verified)} verified, ${formatMoney(finance.awaitingVerification)} awaiting verification, ${formatMoney(finance.pendingBalance)} not received`}
        />
      )}

      {/* THE ONE FIGURE THAT IS NOT THE TOTAL OF ANYTHING ABOVE: what is still
          owed, measured against VERIFIED money -- the business's own reading,
          unchanged, and the reason it keeps a line of its own. */}
      <div className="order-pay-balance">
        <span className="order-pay-balance-label">Balance</span>
        <span
          className="order-pay-balance-value"
          style={{
            color: finance.pendingBalance && finance.pendingBalance !== '0.00' && !finance.fullyPaid
              ? TONE.amber.text
              : colors.primary,
          }}
        >
          {formatMoney(finance.pendingBalance)}
        </span>
        <span className="order-pay-balance-hint">against verified</span>
      </div>
    </>
  )
}

// ── The payments behind a figure ──────────────────

/**
 * THE ROWS BEHIND ONE OF THE TWO SUMMARY FIGURES, IN A DIALOG.
 *
 * WHY A DIALOG AND NOT A TABLE ON THE PAGE. The table that used to sit here was
 * open whether or not anybody wanted it, carried six columns to say four things,
 * and restated each payment's status beside a summary that had just grouped the
 * payments BY status. A reader who wants to know which payments make up a figure
 * clicks the figure; everybody else gets a section four lines long.
 *
 * ── TWO AUDIENCES, TWO AMOUNTS OF RECORD ──
 *
 * THE LIST IS FOR EVERYBODY WHO MAY READ THE ORDER. Its amounts are the Order's
 * own — the share allocated to it, when it was paid, how, by whom, and whether
 * Finance has decided yet. Those are facts about the Order, the totals above are
 * built from them, and a reader who may see the Order may see them.
 *
 * THE DETAIL IS FOR A FINANCE READER. The proof note, the clarification Finance
 * asked for, where the money landed and who signed it off are Finance's record
 * of its own work. They sat behind a Finance-module door when this was a link
 * into Finance, and they sit behind the same door now: `canViewDetails` is that
 * capability, `View details` is drawn only for it, and the page fetches the
 * fields only when it is true. A reader without it is offered no control, shown
 * no field, and — because the page never asks — has none of it in their browser.
 *
 * ROW-LEVEL ACCESS IS NOT THE SAME PERMISSION. That a reader may see a payment's
 * amount on their Order does not mean they may read Finance's notes about it,
 * and this component does not treat the two as one answer.
 *
 * THE AMOUNT IS THIS ORDER'S SHARE. `allocated` is the exact figure the summary
 * above is built from — never the payment's full ledger amount — so the rows and
 * the total they belong to cannot disagree. A payment that is only partly this
 * Order's says so under its own amount, which is the one case where the full
 * amount is worth printing at all.
 */
export function OrderPaymentListDialog({
  kind, rows, formatDate, formatDateTime,
  canViewDetails, openId, detail, onOpen, onBack, onClose,
}: {
  kind: OrderPaymentListKind
  rows: readonly OrderPaymentListRow[]
  /** The page's own date formatting, so one date reads the same everywhere. */
  formatDate: (iso: string | null) => string
  /** The page's own timestamp formatting, for the moments Finance decided. */
  formatDateTime: (iso: string | null) => string
  /**
   * Finance module entry, resolved by the page — the same capability that used
   * to decide whether the Finance record link existed. False hides the control
   * AND the detail view; it is not a styling hint.
   */
  canViewDetails: boolean
  /** The payment whose detail is showing, or null for the list. */
  openId: string | null
  /** The lazily fetched record for that payment, or null before it is asked for. */
  detail: OrderPaymentDetailState | null
  onOpen: (paymentId: string) => void
  onBack: () => void
  onClose: () => void
}) {
  // BOTH CONDITIONS, NOT EITHER. An openId without the capability draws the
  // list, so a state left over from anything cannot become a detail view.
  const open = canViewDetails ? orderPaymentById(rows, openId) : null

  // ── THE DETAIL, IN THE SAME DIALOG ──
  //
  // Not a second dialog stacked on the first, and not a page in Finance. A
  // reader who came from a figure to a list to one payment is still on the
  // Order, one Escape from where they started, with a Back that returns them to
  // the list rather than to whatever the browser remembers.
  if (open) {
    const d = detail?.state === 'ready' ? detail.fields : null

    // THE ORDER'S OWN FACTS, from the row the list already had.
    const facts: { key: string; label: string; value: string }[] = [
      { key: 'share', label: 'Allocated to this Order', value: formatMoney(open.allocated) },
      // Stated ONLY when it differs. Printing "Full payment" equal to the share
      // on every ordinary row would invite a reader to look for a difference
      // that is not there.
      ...(open.isPartialShare
        ? [{ key: 'full', label: 'Full payment', value: formatMoney(open.full) }]
        : []),
      { key: 'date', label: 'Payment date', value: formatDate(open.dateIso) },
      { key: 'mode', label: 'Mode', value: PAYMENT_MODE_LABEL[open.mode ?? ''] ?? open.mode ?? '\u2014' },
      { key: 'payer', label: 'Payer', value: customerDisplayName(open.client) },
      ...(open.reference ? [{ key: 'order', label: 'Order reference', value: open.reference }] : []),
      { key: 'status', label: 'Verification', value: piPaymentStatusLabel(open.status) },
    ]

    // FINANCE'S OWN RECORD, from the read the page made only because this
    // reader holds Finance module entry.
    const financeFacts: { key: string; label: string; value: string }[] = d ? [
      ...(d.humanId ? [{ key: 'ref', label: 'Payment reference', value: d.humanId }] : []),
      ...(d.receivedIn
        ? [{ key: 'in', label: 'Received in', value: RECEIVED_IN_LABEL[d.receivedIn] ?? d.receivedIn }]
        : []),
      ...(d.approvedAtIso
        ? [{ key: 'approved', label: 'Verified on', value: formatDateTime(d.approvedAtIso) }]
        : []),
      ...(d.clarificationAtIso
        ? [{ key: 'clarify', label: 'Clarification asked', value: formatDateTime(d.clarificationAtIso) }]
        : []),
      ...(d.rejectedAtIso
        ? [{ key: 'rejected', label: 'Rejected on', value: formatDateTime(d.rejectedAtIso) }]
        : []),
    ] : []

    // WHAT SOMEBODY WROTE ABOUT IT. Each is drawn only where it exists; an
    // empty heading over nothing is worse than no heading.
    const notes: { key: string; label: string; value: string }[] = d ? [
      ...(d.proofNote ? [{ key: 'proof', label: 'Proof', value: d.proofNote }] : []),
      ...(d.salesNote ? [{ key: 'sales', label: 'Sales note', value: d.salesNote }] : []),
      ...(d.adminNote ? [{ key: 'admin', label: 'Finance note', value: d.adminNote }] : []),
    ] : []

    return (
      <OrderModalShell title={PAYMENT_DETAIL_TITLE} onClose={onClose}>
        <button type="button" className="boe-btn boe-btn-ghost order-pay-detail-back" onClick={onBack}>
          {PAYMENT_DETAIL_BACK}
        </button>

        <dl className="order-pay-detail">
          {[...facts, ...financeFacts].map(fact => (
            <div key={fact.key} className="order-pay-detail-row">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>

        {/* THE REST IS STILL COMING, OR WAS REFUSED. Said either way, so a
            half-drawn record never reads as a complete one. */}
        {detail?.state === 'loading' && (
          <p className="order-doc-loading" role="status">Loading the rest of this payment…</p>
        )}
        {detail?.state === 'error' && (
          <p className="order-doc-unavailable" role="alert">{detail.message}</p>
        )}

        {open.isPartialShare && (
          <p className="order-pay-list-note">{PAYMENT_DETAIL_SPLIT_NOTE}</p>
        )}

        {notes.length > 0 && (
          <dl className="order-pay-detail-notes">
            {notes.map(note => (
              <div key={note.key} className="order-pay-detail-note">
                <dt>{note.label}</dt>
                <dd>{note.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </OrderModalShell>
    )
  }

  return (
    <OrderModalShell title={PAYMENT_LIST_TITLE[kind]} onClose={onClose}>
      {rows.length === 0 ? (
        /* AN EMPTY SET IS AN ANSWER, and it is given rather than withheld. */
        <p className="order-pay-list-empty">{PAYMENT_LIST_EMPTY[kind]}</p>
      ) : (
        <>
          <ul className="order-pay-list">
            {rows.map(row => (
              <li key={row.id} className="order-pay-list-row">
                <div className="order-pay-list-main">
                  <div className="order-pay-list-amount">{formatMoney(row.allocated)}</div>
                  {/* ONLY WHEN THE TWO GENUINELY DIFFER. Saying "of X" under
                      every row would be noise on the ordinary case, where the
                      whole payment is this Order's. */}
                  {row.isPartialShare && (
                    <div className="order-pay-list-split">
                      allocated from {formatMoney(row.full)} received
                    </div>
                  )}
                </div>
                <dl className="order-pay-list-facts">
                  <div className="order-pay-list-fact">
                    <dt>Date</dt>
                    <dd>{formatDate(row.dateIso)}</dd>
                  </div>
                  <div className="order-pay-list-fact">
                    <dt>Mode</dt>
                    <dd>{PAYMENT_MODE_LABEL[row.mode ?? ''] ?? row.mode ?? '\u2014'}</dd>
                  </div>
                  <div className="order-pay-list-fact">
                    <dt>Client</dt>
                    <dd>{customerDisplayName(row.client)}</dd>
                  </div>
                  {/* THE STATUS, ONLY WHERE IT DISTINGUISHES ANYTHING. Every
                      row in the verified list is verified and captioning each
                      one so says nothing; a row awaiting Finance may be
                      pending or may need clarification, which is a real
                      difference to the person chasing it. */}
                  {kind === 'awaiting' && (
                    <div className="order-pay-list-fact">
                      <dt>Status</dt>
                      <dd>{piPaymentStatusLabel(row.status)}</dd>
                    </div>
                  )}
                </dl>
                {/* THE DOOR TO FINANCE'S OWN RECORD, and it opens HERE rather
                    than in the Finance module. Drawn on the SAME capability
                    that used to decide whether the Finance record link existed:
                    a reader without it gets the list and no control, which is
                    exactly what they got before. */}
                {canViewDetails && (
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost order-pay-list-link"
                    onClick={() => onOpen(row.id)}
                  >
                    {PAYMENT_DETAIL_VIEW}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="order-pay-list-note">{paymentListCaption(canViewDetails)}</p>
        </>
      )}
    </OrderModalShell>
  )
}

// ── The activity trail ────────────────────────────────────────────────────────

/** One event, already worded by the page: the label maps, the amendment lines
 *  and the date formatting all stay where they were. */
export type OrderActivityItem = {
  key: string
  label: string
  detail: string | null
  /** An amendment's before/after pairs; empty for every other event. */
  lines: readonly string[]
  actor: string | null
  when: string
  /** The page's own marker for this event, already coloured by its kind. */
  dot: React.ReactNode
  /** Written by the source PI's trail rather than the Order's own. */
  fromPi: boolean
  /**
   * This entry happened after the reader's last visit — see NEW_SINCE_LABEL.
   * False for every entry when the reader had nothing unread, which is the
   * ordinary case.
   */
  isNew?: boolean
}

export const ACTIVITY_TITLE = 'Activity'
export const ACTIVITY_EMPTY = 'No activity recorded yet.'

/**
 * WHAT CHANGED WHILE THEY WERE AWAY, marked in place.
 *
 * NOT A MODAL. Opening an Order is Product Orders → click → Order Detail, with
 * nothing in between: an "OK" somebody has to dismiss before they can read the
 * page is a toll on the most common action in the module. The trail already
 * holds the change history, so the unseen entries are simply marked where they
 * already are, and a reader who does not care scrolls past them.
 */
export const NEW_SINCE_LABEL = 'New since your last visit'

/**
 * The complete trail, newest first, showing the latest five until asked for
 * the rest. Every entry, timestamp and actor is exactly what the page handed
 * over; this only decides how many are on screen at once.
 */
export function OrderActivityList({ items }: { items: readonly OrderActivityItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden } = activityWindow(items.length, expanded)
  const visible = items.slice(0, shown)
  const collapsible = items.length > shown || expanded
  // Counted over the WHOLE trail, not the visible window: a reader with six
  // unseen entries and five on screen must not be told there are five.
  const newCount = items.filter(i => i.isNew).length

  return (
    <PiCard>
      <PiCardHeader
        title={ACTIVITY_TITLE}
        style={SECTION_HEADER_STYLE}
        right={items.length > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' }}>
            {newCount > 0 && (
              <span className="order-activity-new">
                {newCount} {NEW_SINCE_LABEL.toLowerCase()}
              </span>
            )}
            <span style={{ fontSize: '12px', color: colors.muted }}>
              {hidden > 0 ? `Latest ${shown} of ${items.length}` : `${items.length} event${items.length === 1 ? '' : 's'}`}
            </span>
          </span>
        ) : undefined}
      />
      <div style={{ padding: '12px 16px 12px' }}>
        {items.length === 0 ? (
          <div style={{ color: colors.muted, fontSize: '13px' }}>{ACTIVITY_EMPTY}</div>
        ) : (
          <ol id="order-activity-list" className="order-activity">
            {visible.map((entry, idx) => (
              <li
                key={entry.key}
                className={entry.isNew ? 'order-activity-item order-activity-item--new' : 'order-activity-item'}
              >
                <div className="order-activity-rail">
                  {entry.dot}
                  {idx < visible.length - 1 && <span className="order-activity-line" aria-hidden="true" />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
                    {entry.label}
                    {entry.fromPi && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, marginLeft: '6px' }}>PI</span>
                    )}
                    {/* The WORDS say it, not the tint: a reader who cannot see
                        the background still reads "New". */}
                    {entry.isNew && (
                      <span className="order-activity-new" title={NEW_SINCE_LABEL}>New</span>
                    )}
                  </div>
                  {entry.detail && (
                    <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '1px' }}>{entry.detail}</div>
                  )}
                  {entry.lines.length > 0 && (
                    <ul style={{ margin: '3px 0 0', paddingLeft: '16px', fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
                      {entry.lines.map(line => <li key={line}>{line}</li>)}
                    </ul>
                  )}
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                    {entry.actor ? `${entry.actor} · ` : ''}{entry.when}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            aria-controls="order-activity-list"
            className="order-inline-link"
            style={{ marginTop: '8px' }}
          >
            {activityToggleLabel(items.length, expanded)}
            <ChevronDown
              size={13}
              strokeWidth={2.2}
              aria-hidden="true"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
            />
          </button>
        )}
      </div>
    </PiCard>
  )
}

// ── More actions ──────────────────────────────────────────────────────────────

export type MoreActionItem<K extends string> = {
  key: K
  label: string
  disabled?: boolean
  title?: string
  danger?: boolean
}

/**
 * The overflow menu for the rare paths. Keyboard behaviour is the WAI-ARIA
 * menu-button pattern: click or ArrowDown opens, focus lands on the first
 * enabled item, Up/Down/Home/End move, Escape closes and returns focus to the
 * trigger, Tab or an outside click closes. Renders nothing when there is no
 * item — an empty trigger would be a control that does nothing.
 */
export function MoreActionsMenu<K extends string>({ items, onSelect }: {
  items: readonly MoreActionItem<K>[]
  onSelect: (key: K) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs   = useRef<(HTMLButtonElement | null)[]>([])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const first = itemRefs.current.findIndex(el => el && !el.disabled)
    if (first >= 0) itemRefs.current[first]?.focus()
  }, [open])

  if (items.length === 0) return null

  const focusItem = (index: number) => {
    const bounded = (index + items.length) % items.length
    itemRefs.current[bounded]?.focus()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); focusItem(index + 1) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); focusItem(index - 1) }
    else if (e.key === 'Home')      { e.preventDefault(); focusItem(0) }
    else if (e.key === 'End')       { e.preventDefault(); focusItem(items.length - 1) }
    else if (e.key === 'Tab')       { setOpen(false) }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) }
        }}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="boe-record-action boe-record-action--icon"
        style={{ background: open ? colors.float : undefined }}
      >
        <MoreHorizontal size={15} strokeWidth={2} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="More actions"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: '9px', boxShadow: '0 8px 24px rgba(16,24,40,0.14)',
            minWidth: '224px', padding: '4px 0', overflow: 'hidden',
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={el => { itemRefs.current[index] = el }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => { triggerRef.current?.focus(); setOpen(false); onSelect(item.key) }}
              onKeyDown={e => onMenuKeyDown(e, index)}
              className="order-menu-item"
              style={{ color: item.danger ? '#B42318' : colors.secondary }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Loading states ────────────────────────────────────────────────────────────

const BLOCK = '#E8EBF0'

export function SkeletonBlock({ w, h, radius = 4 }: { w: string | number; h: number; radius?: number }) {
  return <div style={{ width: w, height: h, borderRadius: radius, background: BLOCK, flexShrink: 0, maxWidth: '100%' }} />
}

/** A section that is still on its way: a card in the shape of a short table. */
export function SectionSkeleton({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{
      background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${colors.border}` }}>
        <SkeletonBlock w={140} h={12} />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px',
          borderBottom: i < rows - 1 ? '1px solid #F0F2F5' : 'none',
        }}>
          <SkeletonBlock w={36} h={36} radius={6} />
          <SkeletonBlock w="34%" h={11} />
          <SkeletonBlock w="14%" h={11} />
          <SkeletonBlock w="18%" h={11} />
        </div>
      ))}
    </div>
  )
}

/**
 * THE PAGE BEFORE THE ORDER ROW HAS LANDED, IN THE SHAPE THE ORDER ROW WILL
 * TAKE.
 *
 * IT WAS THE SHAPE OF A PAGE THAT NO LONGER EXISTS. This drew a flat row of six
 * fact cells with a commercial rail beside them — the summary band two passes
 * ago — under class names (.order-summary, .order-summary-facts, .order-fact,
 * .order-summary-commercial) whose rules were deleted along with the band. So it
 * rendered unstyled blocks at the wrong size in the wrong place, and the page
 * jumped the moment the data arrived, which is the one thing a skeleton exists
 * to prevent.
 *
 * IT USES THE REAL LAYOUT CLASSES NOW. The three-group panel, the Documents row
 * and the lower workspace are the same grids the loaded page uses, so the blocks
 * sit where the content will and the transition is a fill rather than a reflow.
 * A skeleton built from its own private geometry drifts the moment the page
 * moves; this one cannot, because it shares the page's.
 *
 * STATIC, AND IT FETCHES NOTHING. No animation, no timers, no reads — the same
 * treatment the Control Center uses.
 */
export function OrderDetailSkeleton() {
  return (
    <div className="order-detail-page" role="status" aria-busy="true" aria-label="Loading order">
      <div style={{ marginBottom: 10 }}><SkeletonBlock w={54} h={12} /></div>
      <div className="order-command-header" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SkeletonBlock w={160} h={26} />
          <SkeletonBlock w={104} h={22} radius={999} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <SkeletonBlock w={110} h={34} radius={8} />
          <SkeletonBlock w={100} h={34} radius={8} />
          <SkeletonBlock w={150} h={34} radius={8} />
        </div>
      </div>

      {/* THE COMPACT OVERVIEW: three groups of label/value rows — four, three
          and three — in the panel's own grid. */}
      <section className="order-facts">
        <div className="order-sum-groups">
          {[4, 3, 3].map((rows, group) => (
            <section key={group} className="order-sum-group">
              <div style={{ marginBottom: 9 }}><SkeletonBlock w={104} h={12} /></div>
              {Array.from({ length: rows }, (_, rowIndex) => (
                <div key={rowIndex} className="order-sum-row">
                  <SkeletonBlock w={70} h={11} />
                  <div style={{ justifySelf: 'end' }}><SkeletonBlock w={112} h={12} /></div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </section>

      {/* Documents two thirds, Fabric & Finish one third — the row's own grid. */}
      <div className="order-docs-row">
        <section className="order-docs">
          <div style={{ padding: '9px 14px', borderBottom: '1px solid #F0F2F5' }}>
            <SkeletonBlock w={88} h={11} />
          </div>
          {[0, 1, 2].map(i => (
            <div key={i} className="order-doc-section">
              <SkeletonBlock w={76} h={12} />
              <div>
                <SkeletonBlock w={132} h={15} />
                <div style={{ marginTop: 6 }}><SkeletonBlock w="62%" h={11} /></div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <SkeletonBlock w={70} h={26} radius={6} />
              </div>
            </div>
          ))}
        </section>
        <div className="order-status-card">
          <div className="order-status-card-head"><SkeletonBlock w={104} h={11} /></div>
          <div className="order-status-card-body">
            {[0, 1].map(i => (
              <div key={i}>
                <SkeletonBlock w={52} h={10} />
                <div style={{ marginTop: 6 }}><SkeletonBlock w={148} h={20} radius={999} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="order-products">
        <SectionSkeleton rows={4} label="Loading products" />
      </div>

      {/* Payment and the commercial breakdown, in the lower workspace's grid. */}
      <div className="order-lower">
        <div className="order-lower-main">
          <div className="order-status-card">
            <div className="order-status-card-head"><SkeletonBlock w={70} h={11} /></div>
            <div className="order-status-card-body">
              <SkeletonBlock w={152} h={28} />
              <SkeletonBlock w={248} h={12} />
              <div className="order-pay-metrics">
                {[0, 1].map(i => (
                  <div key={i} className="order-pay-metric">
                    <SkeletonBlock w={92} h={10} />
                    <div style={{ marginTop: 7 }}><SkeletonBlock w={112} h={16} /></div>
                  </div>
                ))}
              </div>
              <SkeletonBlock w="100%" h={10} radius={999} />
            </div>
          </div>
        </div>
        <aside className="order-lower-aside">
          <div className="order-commercial">
            <SkeletonBlock w={132} h={11} />
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0, 1, 2, 3, 4].map(i => <SkeletonBlock key={i} w="100%" h={12} />)}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
