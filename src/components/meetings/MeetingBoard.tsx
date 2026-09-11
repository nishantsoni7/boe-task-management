'use client'

import { CheckCircle2, ChevronRight, Paperclip, Search } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingBadge } from './MeetingModal'
import { orderNumberKey, type DiscussionState, type EarlierPresence } from '@/lib/meetings/orderHistory'
import {
  ORDER_POSITION_META, formatMeetingDate, formatMeetingTimestamp,
  type MeetingOrder, type MeetingOrderItem,
} from '@/lib/meetings/types'

// The meeting board — every Order in this meeting, one row each.
//
// The Order is the unit a review walks through, so each row answers the four
// things asked before anyone opens it:
//
//   * which Order is this?            number, customer, dispatch date, position
//   * have we seen it before?         how many earlier meetings, and the last one
//   * have we covered it today?       discussed / not yet, with updates and images
//   * what is underneath it?          product lines still open, next review
//
// Clicking a row opens that Order's discussion. Nothing is edited here: the
// board is for finding the next Order, not a second place to type.

type Props = {
  orders: MeetingOrder[]
  itemsByOrder: Map<string, MeetingOrderItem[]>
  discussion: Map<string, DiscussionState>
  /** null while unknown (the lookup failed) — shown as unknown, never as "first review". */
  earlier: Map<string, EarlierPresence> | null
  search: string
  onSearch: (value: string) => void
  isMobile: boolean
  onOpen: (orderId: string) => void
}

function isDiscussed(state: DiscussionState | undefined): boolean {
  return !!state && state.updates + state.evidence > 0
}

export function MeetingBoard({
  orders, itemsByOrder, discussion, earlier, search, onSearch, isMobile, onOpen,
}: Props) {
  const q = search.trim().toLowerCase()
  const visible = q
    ? orders.filter(o =>
        o.order_number.toLowerCase().includes(q)
        || (o.customer_name ?? '').toLowerCase().includes(q))
    : orders
  const discussed = orders.filter(o => isDiscussed(discussion.get(o.id))).length
  const remaining = orders.length - discussed

  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '10px', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
        flexWrap: 'wrap', padding: '9px 12px', borderBottom: `1px solid ${colors.border}`,
      }}>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: '320px' }}>
          <Search
            size={13}
            color={colors.muted}
            style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            className="boe-input"
            aria-label="Find order"
            placeholder="Find order number or customer…"
            value={search}
            onChange={e => onSearch(e.target.value)}
            style={{ padding: '6px 10px 6px 28px', fontSize: '12px' }}
          />
        </div>
        <div style={{ fontSize: '12px', color: colors.secondary }}>
          {orders.length} order{orders.length !== 1 ? 's' : ''}
          {' · '}
          <span style={{ color: '#2E8A58', fontWeight: 600 }}>{discussed} discussed</span>
          {remaining > 0 && (
            <>
              {' · '}
              <span style={{ color: '#92400E', fontWeight: 600 }}>{remaining} to go</span>
            </>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div style={{ padding: '24px 12px', fontSize: '12.5px', color: colors.muted, textAlign: 'center' }}>
          No order matches “{search}”.
        </div>
      ) : isMobile ? (
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visible.map(order => (
            <BoardCard
              key={order.id}
              order={order}
              items={itemsByOrder.get(order.id) ?? []}
              state={discussion.get(order.id)}
              earlier={earlier}
              onOpen={() => onOpen(order.id)}
            />
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Order', 'Dispatch', 'Position', 'Earlier meetings', 'This meeting', 'Products', 'Next review', ''].map(h => (
                  <th key={h} style={{
                    padding: '7px 12px', textAlign: 'left',
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(order => {
                const items = itemsByOrder.get(order.id) ?? []
                return (
                  <tr
                    key={order.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open order ${order.order_number}`}
                    onClick={() => onOpen(order.id)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(order.id) } }}
                    style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer', verticalAlign: 'top' }}
                    onMouseEnter={e => { e.currentTarget.style.background = colors.raised }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <td style={{ padding: '10px 12px', minWidth: '150px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 800, color: colors.primary, letterSpacing: '-0.01em' }}>
                        {order.order_number}
                      </div>
                      <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
                        {order.customer_name ?? 'No customer recorded'}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: colors.secondary }}>
                      {formatMeetingDate(order.expected_dispatch_date)}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <MeetingBadge meta={ORDER_POSITION_META[order.position]} />
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <EarlierLine earlier={earlier} order={order} />
                    </td>
                    <td style={{ padding: '10px 12px', minWidth: '220px', maxWidth: '340px' }}>
                      <TodayLine state={discussion.get(order.id)} latestUpdate={order.latest_update} />
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: colors.secondary }}>
                      <ProductsLine items={items} />
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: colors.secondary }}>
                      {formatMeetingDate(order.next_review_date)}
                    </td>
                    <td style={{ padding: '10px 8px', color: colors.muted }}>
                      <ChevronRight size={15} strokeWidth={2} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function BoardCard({
  order, items, state, earlier, onOpen,
}: {
  order: MeetingOrder
  items: MeetingOrderItem[]
  state: DiscussionState | undefined
  earlier: Map<string, EarlierPresence> | null
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        width: '100%', textAlign: 'left', display: 'block', cursor: 'pointer',
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', padding: '11px 13px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: colors.primary }}>{order.order_number}</div>
          <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
            {order.customer_name ?? 'No customer recorded'}
            {order.expected_dispatch_date && ` · Dispatch ${formatMeetingDate(order.expected_dispatch_date)}`}
          </div>
        </div>
        <MeetingBadge meta={ORDER_POSITION_META[order.position]} />
      </div>
      <div style={{ marginTop: '8px' }}>
        <TodayLine state={state} latestUpdate={order.latest_update} />
      </div>
      <div style={{
        display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '7px',
        fontSize: '11.5px', color: colors.muted,
      }}>
        <EarlierLine earlier={earlier} order={order} />
        <ProductsLine items={items} />
      </div>
    </button>
  )
}

function EarlierLine({ earlier, order }: { earlier: Map<string, EarlierPresence> | null; order: MeetingOrder }) {
  if (!earlier) return <span style={{ color: colors.muted }}>—</span>
  const presence = earlier.get(orderNumberKey(order))
  if (!presence) return <span style={{ color: colors.muted }}>First review</span>
  return (
    <span style={{ color: colors.secondary }}>
      {presence.count} earlier · last {formatMeetingDate(presence.lastMeetingDate)}
    </span>
  )
}

function TodayLine({ state, latestUpdate }: { state: DiscussionState | undefined; latestUpdate: string | null }) {
  if (!state || !isDiscussed(state)) {
    return <span style={{ fontSize: '12px', color: '#92400E', fontWeight: 600 }}>Not discussed yet</span>
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '12px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#2E8A58', fontWeight: 600 }}>
          <CheckCircle2 size={12} strokeWidth={2.2} /> Discussed
        </span>
        {state.updates > 0 && (
          <span style={{ color: colors.muted }}>{state.updates} update{state.updates === 1 ? '' : 's'}</span>
        )}
        {state.evidence > 0 && (
          <span
            title={`${state.evidence} image${state.evidence === 1 ? '' : 's'} attached`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: colors.muted }}
          >
            <Paperclip size={11} strokeWidth={2} /> {state.evidence}
          </span>
        )}
        {state.lastAt && (
          <span style={{ color: colors.muted }}>· {formatMeetingTimestamp(state.lastAt).split(', ').pop()}</span>
        )}
      </div>
      {latestUpdate && (
        <div style={{
          fontSize: '11.5px', color: colors.secondary, marginTop: '3px', lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {latestUpdate}
        </div>
      )}
    </div>
  )
}

function ProductsLine({ items }: { items: MeetingOrderItem[] }) {
  if (items.length === 0) return <span style={{ color: colors.muted }}>—</span>
  const open = items.filter(i => i.status !== 'resolved').length
  return (
    <span>
      {items.length} SKU{items.length !== 1 ? 's' : ''}
      {open > 0 && <span style={{ color: colors.amber, fontWeight: 600 }}> · {open} open</span>}
    </span>
  )
}
