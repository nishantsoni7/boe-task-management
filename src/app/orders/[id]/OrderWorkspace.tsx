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
import {
  activityToggleLabel,
  activityWindow,
  attentionHeading,
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
 * THE VALUE IS THE ONE FIGURE IN THE HEADER, so it gets a panel of its own —
 * a tinted ground and a size up, inside group 1 where the reader already is.
 * It is a tint from the existing token set and nothing louder: the figure is
 * meant to be found, not announced.
 *
 * PRODUCTION IS A BADGE, and its supporting line is drawn ONLY when the Order
 * is aligned. orderSummaryView has already made that line null otherwise, so
 * there is no empty "aligned on" row to read past.
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

/** One label/value line inside a group. */
function SummaryRow({ row }: { row: OrderFactRow }) {
  const tone = TONE[row.tone]
  const warning = row.tone === 'amber' || row.tone === 'red'
  return (
    <div className={['order-sum-row', row.missing ? 'order-sum-row--missing' : '', warning ? `order-sum-row--${row.tone}` : ''].filter(Boolean).join(' ')}>
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

        {/* ── 1. Client and value ── */}
        <section className="order-sum-group" aria-label={SUMMARY_GROUP_TITLE.client}>
          <h3 className="order-sum-group-head">{SUMMARY_GROUP_TITLE.client}</h3>
          <p
            className={view.client.nameMissing ? 'order-sum-client order-sum-client--missing' : 'order-sum-client'}
          >
            {view.client.name}
          </p>
          <dl className="order-sum-rows">
            {view.client.rows.map(row => <SummaryRow key={row.key} row={row} />)}
          </dl>
          {/* THE ONE FIGURE IN THE HEADER. A lightly tinted panel from the
              existing token set — found at a glance, and no louder than that. */}
          <div className={view.client.value.missing ? 'order-sum-amount order-sum-amount--missing' : 'order-sum-amount'}>
            <span className="order-sum-amount-label">{view.client.value.label}</span>
            <span className="order-sum-amount-value">{view.client.value.value}</span>
          </div>
        </section>

        {/* ── 2. Sales and production ── */}
        <section className="order-sum-group" aria-label={SUMMARY_GROUP_TITLE.sales}>
          <h3 className="order-sum-group-head">{SUMMARY_GROUP_TITLE.sales}</h3>
          <div className="order-sum-production">
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
          </div>
          <dl className="order-sum-rows">
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

/**
 * THE ONLY PAYMENT FIGURES ON THE PAGE, in the Draft PI's approved shape.
 *
 * WHAT IT BORROWS, AND WHAT IT DOES NOT. The Draft PI's payment card reads as a
 * position, then its parts, then one bar that adds up to the whole: a headline
 * percentage with the word it qualifies, two metric blocks under it, the shared
 * three-share track, and a legend that names each share. This is that same
 * arrangement, drawn with the same PiPaymentProgress component, so the two
 * screens' payment sections cannot drift apart.
 *
 * THE WORDS ARE THE ORDER'S OWN, AND THEY ARE NOT THE PI'S. The PI card says
 * `confirmed`; this says `verified`, because that is what this screen has
 * always called money Finance has decided on. NOTHING IS RELABELLED TO MATCH:
 * `Received` here still means verified PLUS awaiting verification, and it is
 * never presented as approved money.
 *
 * IT SITS QUIETER THAN THE PI'S. The Order page carries several sections and
 * the money must not be the loudest of them, so the track uses the subdued
 * palette and the metrics are tinted rather than filled. Every colour is still
 * a token and every share keeps its meaning.
 *
 * NO CONTROL WAS ADDED. The Confirmed Order has never offered payment entry and
 * this does not invent one; the per-payment Finance links below the figures are
 * the page's existing disclosure and are untouched.
 *
 * EVERY FIGURE IS buildOrderFinancePosition'S. Nothing here adds, subtracts or
 * percentages money.
 */
export function PaymentSummaryFigures({ finance, loaded }: {
  finance: OrderFinancePosition
  /** False while the payment reads are still in flight. */
  loaded: boolean
}) {
  if (!loaded) {
    return (
      <div className="order-pay-figures" role="status" aria-label="Loading payment summary">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <div key={i} className="order-pay-figure">
            <SkeletonBlock w={78} h={10} />
            <div style={{ marginTop: 7 }}><SkeletonBlock w={104} h={16} /></div>
          </div>
        ))}
      </div>
    )
  }

  /** The two parts of what has been received. */
  const metrics: { key: 'verified' | 'awaiting'; label: string; amount: string; meta: string; tone: WorkspaceTone }[] = [
    {
      key: 'verified',
      label: 'Verified',
      amount: formatMoney(finance.verified),
      meta: 'confirmed by Finance',
      tone: 'green',
    },
    {
      key: 'awaiting',
      label: 'Awaiting verification',
      amount: formatMoney(finance.awaitingVerification),
      meta: finance.counts.awaiting > 0
        ? `${finance.counts.awaiting} payment${finance.counts.awaiting === 1 ? '' : 's'} with Finance`
        : 'nothing with Finance',
      tone: finance.counts.awaiting > 0 ? 'amber' : 'neutral',
    },
  ]

  /** The three figures the position is measured against. Each was on this
   *  screen before and each is still here. */
  const supporting: { key: string; label: string; value: string; tone?: WorkspaceTone; hint?: string }[] = [
    { key: 'order_value', label: 'Order value', value: formatMoney(finance.orderValue) },
    { key: 'received', label: 'Received', value: formatMoney(finance.received), hint: 'verified + awaiting' },
    {
      key: 'balance', label: 'Balance', value: formatMoney(finance.pendingBalance),
      tone: finance.pendingBalance && finance.pendingBalance !== '0.00' && !finance.fullyPaid ? 'amber' : undefined,
      hint: 'against verified',
    },
  ]

  return (
    <>
      <div className="order-pay-position">
        {/* THE HEADLINE — the one percentage a reader came for, and the word it
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
        <div className="order-pay-of">
          {formatMoney(finance.verified)} verified of {formatMoney(finance.orderValue)} order value
        </div>

        <div className="order-pay-metrics">
          {metrics.map(metric => (
            <div key={metric.key} className={`order-pay-metric order-pay-metric--${metric.key}`}>
              <span className="order-pay-metric-label">{metric.label}</span>
              <span className="order-pay-metric-value" style={{ color: TONE[metric.tone].text }}>
                {metric.amount}
              </span>
              <span className="order-pay-metric-meta">{metric.meta}</span>
            </div>
          ))}
        </div>
      </div>

      {/* THE SHARED TRACK, the Draft PI's own component — green for money
          Finance verified, amber for the rest of what was received, the
          remainder for what has not arrived. Percentages in, pixels out: it
          computes no money. The Order shows no advance marker here, so it is
          passed none rather than being given an invented one. */}
      {finance.verifiedPercent !== null && (
        <PiPaymentProgress
          confirmedPercent={Number(finance.verifiedPercent)}
          receivedPercent={Number(finance.receivedPercent ?? finance.verifiedPercent)}
          thresholdPercent={null}
          height={10}
          palette={PAYMENT_BAR_COLORS_SUBDUED}
          label={`Verified: ${formatPercent(finance.verifiedPercent)} of the order value — ${formatMoney(finance.verified)} verified, ${formatMoney(finance.awaitingVerification)} awaiting verification`}
        />
      )}

      <ul className="order-pay-legend">
        <li className="order-pay-legend-item">
          <span className="order-pay-swatch" style={{ background: PAYMENT_BAR_COLORS_SUBDUED.confirmed }} aria-hidden="true" />
          Verified
        </li>
        <li className="order-pay-legend-item">
          <span className="order-pay-swatch" style={{ background: PAYMENT_BAR_COLORS_SUBDUED.awaiting }} aria-hidden="true" />
          Awaiting verification
        </li>
        <li className="order-pay-legend-item">
          <span className="order-pay-swatch" style={{ background: PAYMENT_BAR_COLORS_SUBDUED.unpaid }} aria-hidden="true" />
          Not received
        </li>
      </ul>

      <div className="order-pay-figures">
        {supporting.map(figure => (
          <div key={figure.key} className="order-pay-figure">
            <div className="order-pay-figure-label">{figure.label}</div>
            <div
              className="order-pay-figure-value"
              style={{ color: figure.tone ? TONE[figure.tone].text : colors.primary }}
            >
              {figure.value}
            </div>
            {figure.hint && <div className="order-pay-figure-hint">{figure.hint}</div>}
          </div>
        ))}
      </div>

      {/* MONEY THAT IS ONLY PARTLY THIS ORDER'S. A payment may legitimately be
          split across targets, and every figure above counts only this Order's
          share. Said out loud, because a reader comparing the Balance against a
          bank statement needs to know the difference is a split and not a
          missing payment. */}
      {finance.splitPayments.length > 0 && (
        <div className="order-pay-split">
          {finance.splitPayments.length === 1 ? 'One payment below is' : `${finance.splitPayments.length} payments below are`}
          {' '}allocated across more than one record. Once a payment is allocated, the
          allocations decide what each Order receives — so only this Order&apos;s allocated
          share is counted above. The complete allocation history is in each one&apos;s
          Finance record.
        </div>
      )}
    </>
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
 * The whole workspace before the Order row has landed: the command header, the
 * main column and the health rail, each in the shape of what is about to
 * appear, so the shell does not jump when the data arrives. Static blocks, no
 * animation — the same treatment the Control Center uses.
 */
export function OrderDetailSkeleton() {
  return (
    <div className="order-detail-page" role="status" aria-busy="true" aria-label="Loading order">
      <div style={{ marginBottom: 10 }}><SkeletonBlock w={54} h={12} /></div>
      <div className="order-command-header" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SkeletonBlock w={160} h={26} />
          <SkeletonBlock w={200} h={14} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <SkeletonBlock w={110} h={34} radius={8} />
          <SkeletonBlock w={100} h={34} radius={8} />
          <SkeletonBlock w={150} h={34} radius={8} />
        </div>
      </div>
      <section className="order-summary">
        <div className="order-summary-facts">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="order-fact">
              <SkeletonBlock w={72} h={10} />
              <div style={{ marginTop: 6 }}><SkeletonBlock w={132} h={13} /></div>
            </div>
          ))}
        </div>
        <div className="order-summary-commercial">
          <SkeletonBlock w="60%" h={14} />
          <div style={{ marginTop: 10 }}><SkeletonBlock w="80%" h={20} /></div>
          <div style={{ marginTop: 16 }}><SkeletonBlock w="100%" h={120} /></div>
        </div>
      </section>
      <div className="order-products">
        <SectionSkeleton rows={4} label="Loading products" />
      </div>
      <SectionSkeleton rows={2} label="Loading payment" />
    </div>
  )
}
