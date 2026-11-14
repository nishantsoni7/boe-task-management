// PIs FLAGGED BY OPERATIONS THAT WAIT ON YOU (owner, 2026-11-11).
//
// Operations flags a PI version it cannot accept ("clarification needed") and the Order goes On Hold.
// The person who must answer is the one the answer door lets answer: the PI's creator / submitter, or
// an active admin. public.my_flagged_pis() (20270611000000) is the ONE definition of that list; three
// screens read it and never decide it themselves:
//   - the approver's "Needs your decision" on the Orders dashboard,
//   - the salesperson's (and any other reader's) Orders dashboard strip,
//   - the Modules launcher's For you column.
//
// This module validates the database's answer and owns the words. A row it cannot read makes the whole
// answer unreadable (the screen then says so), never a silently shorter list. A database without the
// function answers [], like my_returned_pis() before it: nothing is invented.

import type { SupabaseClient } from '@supabase/supabase-js'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { isDashboardFunctionMissing } from '@/lib/orders/salespersonDashboard'

export type FlaggedPi = {
  handoffId: string
  orderId: string
  /** The Order's own number as people say it (`546`). */
  orderNumber: string
  clientName: string
  versionNumber: number
  /** Operations' reason, whole (at most 1000 characters). */
  reason: string
  /** Who flagged it; null when the person is no longer on record. */
  byName: string | null
  /** When it was flagged (ISO); null only on data older than the column. */
  since: string | null
  waitingSeconds: number
  /**
   * WHO HOLDS IT (20270718000000): 'coordinator' = the approver (Operations flagged it, or Sales replied),
   * 'sales' = the approver sent it to the salesperson. null on a database without the review chain.
   */
  holder: 'coordinator' | 'sales' | null
  /** True when the READER holds it: it waits on them. An approver is also shown what Sales holds, to watch. */
  mine: boolean
  /** How many times Operations has flagged this version; 0 when unknown. */
  round: number
  /** When the current holder got it (ISO), else null. */
  holderSince: string | null
  /** The salesperson's reply to the approver's send-back, when there is one. */
  reply: string | null
  replyByName: string | null
  replyAt: string | null
}

/** Turns the RPC's answer into rows; throws when the answer is not a list of readable rows. */
export function readFlaggedPis(raw: unknown): FlaggedPi[] {
  if (!Array.isArray(raw)) throw new Error('The flagged PIs answer is not a list.')
  return raw.map((x): FlaggedPi => {
    if (typeof x !== 'object' || x === null) throw new Error('A flagged PI row is not an object.')
    const o = x as Record<string, unknown>
    if (typeof o.handoff_id !== 'string' || o.handoff_id === '') throw new Error('A flagged PI has no id.')
    if (typeof o.order_id !== 'string' || o.order_id === '') throw new Error('A flagged PI has no Order.')
    const version = typeof o.version_number === 'number' ? o.version_number : Number(o.version_number)
    if (!Number.isInteger(version) || version < 1) throw new Error('A flagged PI has no version.')
    const seconds = typeof o.waiting_seconds === 'number' ? o.waiting_seconds : Number(o.waiting_seconds)
    return {
      handoffId: o.handoff_id,
      orderId: o.order_id,
      orderNumber: displayOrderNumber(typeof o.order_number === 'string' ? o.order_number : null) || '—',
      clientName: typeof o.client_name === 'string' ? o.client_name : '',
      versionNumber: version,
      reason: typeof o.reason === 'string' ? o.reason.trim() : '',
      byName: typeof o.by_name === 'string' && o.by_name.trim() !== '' ? o.by_name.trim() : null,
      since: typeof o.since === 'string' ? o.since : null,
      waitingSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
      holder: o.holder === 'coordinator' || o.holder === 'sales' ? o.holder : null,
      mine: typeof o.mine === 'boolean' ? o.mine : true,
      round: typeof o.round === 'number' && Number.isFinite(o.round) ? Math.max(0, o.round) : 0,
      holderSince: typeof o.holder_since === 'string' ? o.holder_since : null,
      reply: typeof o.reply === 'string' && o.reply.trim() !== '' ? o.reply.trim() : null,
      replyByName: typeof o.reply_by_name === 'string' && o.reply_by_name.trim() !== '' ? o.reply_by_name.trim() : null,
      replyAt: typeof o.reply_at === 'string' ? o.reply_at : null,
    }
  })
}

type RpcLike = { rpc: (fn: string) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> }

/**
 * The flagged PIs that wait on the signed-in reader. null = the read FAILED (the screen says so; it never
 * reads as "nothing waits"); [] = none, or this database does not have the function yet.
 */
export async function loadFlaggedPis(client: RpcLike): Promise<FlaggedPi[] | null> {
  try {
    const { data, error } = await client.rpc('my_flagged_pis')
    if (isDashboardFunctionMissing(error)) return []
    if (error) return null
    return readFlaggedPis(data)
  } catch {
    return null
  }
}

// ── The approver's comment, on the card of who it was sent to (2026-11-12) ───────
//
// "Send back to salesperson" (20270619000000) writes ONE Order history entry with the comment and rings
// the salesperson's bell. The bell alone was not enough (owner, Order 547: three notices, none opened),
// so the same comment is drawn on the flagged-PI card the salesperson already has. It is read from the
// history the salesperson may already read on the Order page; a failed or empty read draws nothing extra,
// and never changes the list itself (that stays the database's).

export type SentBack = { by: string | null; atIso: string; text: string }

/**
 * The newest send-back comment per flagged handoff, from history rows (any order). Rows about another
 * handoff (an older PI version) or without a readable comment are ignored.
 */
export function readSentBackComments(raw: unknown, rows: readonly Pick<FlaggedPi, 'handoffId'>[]): Record<string, SentBack> {
  const out: Record<string, SentBack> = {}
  if (!Array.isArray(raw)) return out
  const wanted = new Set(rows.map(r => r.handoffId))
  for (const x of raw) {
    if (typeof x !== 'object' || x === null) continue
    const o = x as Record<string, unknown>
    const p = (typeof o.payload === 'object' && o.payload !== null ? o.payload : {}) as Record<string, unknown>
    const handoff = typeof p.handoff_id === 'string' ? p.handoff_id : ''
    const comment = typeof p.comment === 'string' ? p.comment.trim() : ''
    const at = typeof o.created_at === 'string' ? o.created_at : ''
    if (!wanted.has(handoff) || comment === '' || Number.isNaN(Date.parse(at))) continue
    const actor = o.actor as { full_name?: unknown } | null | undefined
    const by = typeof actor?.full_name === 'string' && actor.full_name.trim() !== '' ? actor.full_name.trim() : null
    const best = out[handoff]
    if (!best || Date.parse(at) > Date.parse(best.atIso)) out[handoff] = { by, atIso: at, text: comment }
  }
  return out
}

type HistoryRead = (orderIds: string[]) => PromiseLike<{ data: unknown; error: { message?: string } | null }>

/** The one history read both cards use: send-back entries of these Orders, newest first. */
export const sentBackHistoryRead = (supabase: SupabaseClient): HistoryRead => ids => supabase
  .from('order_activity_log')
  .select('order_id, payload, created_at, actor:users!actor_id(full_name)')
  .eq('event_type', 'operations_handoff_sent_to_sales')
  .in('order_id', ids)
  .order('created_at', { ascending: false })

/**
 * "Returned to Sales": Sales holds this flagged PI. With the review chain (20270718000000) that is the stored
 * holder. On a database without it, the older rule: the approver sent it back AFTER Operations flagged it,
 * and a send-back older than the flag (Operations flagged it again since) does not count.
 */
export function isReturnedToSales(r: Pick<FlaggedPi, 'since' | 'holder'>, sent: Pick<SentBack, 'atIso'> | undefined): boolean {
  if (r.holder) return r.holder === 'sales'
  return !!sent && (!r.since || Date.parse(sent.atIso) >= Date.parse(r.since))
}

/** The comments for these flagged PIs; {} when none, or when the read fails (the card is then as it was). */
export async function loadSentBackComments(read: HistoryRead, rows: readonly FlaggedPi[]): Promise<Record<string, SentBack>> {
  if (rows.length === 0) return {}
  try {
    const { data, error } = await read([...new Set(rows.map(r => r.orderId))])
    return error ? {} : readSentBackComments(data, rows)
  } catch {
    return {}
  }
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** `Nishant Soni sent it back to you`. */
export const sentBackBy = (s: Pick<SentBack, 'by'>): string => `${s.by ?? 'The approver'} sent it back to you`

/** The comment on one line of the card; the Order page carries all of it. */
export const COMMENT_CLIP = 200
export function commentLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= COMMENT_CLIP ? flat : `${flat.slice(0, COMMENT_CLIP - 1).trimEnd()}…`
}

/** On the salesperson's card, for a PI returned to them. */
export const returnedToYou = (r: Pick<FlaggedPi, 'versionNumber'>): string => `Returned to you: make the changes and resubmit PI V${r.versionNumber} with Edit PI`
/** On the approver's row, for a PI they returned: no decision waits on them. */
export const RETURNED_TO_SALES_LABEL = 'With Sales: waiting for their reply or a revised PI'

export const FLAGGED_KIND_LABEL = 'Flagged by Operations'
export const FLAGGED_LOAD_FAILED = 'PIs flagged by Operations could not be loaded, so one waiting for you may be missing. Refresh to try again.'
export const FLAGGED_STRIP_HINT = 'The approver sent these back to you. Open the Order, reply to the approver, or revise the PI with Edit PI.'
export const FLAGGED_OPEN = 'Respond'

export const flaggedTitle = (n: number): string => `Operations flagged ${n} ${n === 1 ? 'PI' : 'PIs'}`
/** The salesperson's strip lists only what the approver sent to them. */
export const sentToYouTitle = (n: number): string => `${n} ${n === 1 ? 'PI' : 'PIs'} sent back to you`

// ── The approver's rows, by who holds the PI (20270718000000) ──
/** Chip when the salesperson replied: it waits on the approver again. */
export const SALES_REPLIED_ROW_LABEL = 'Sales replied: waiting for you'
/** The ordinal of the loop, said only from the second flag on. */
export const roundLabel = (round: number): string | null => (round >= 2 ? `Round ${round}` : null)

/** `Operations cannot accept PI V1`. */
export const flaggedLabel = (r: Pick<FlaggedPi, 'versionNumber'>): string => `Operations cannot accept PI V${r.versionNumber}`

/** `Order 546 · Qavaali`. */
export function flaggedBrief(r: Pick<FlaggedPi, 'orderNumber' | 'clientName'>): string {
  return `Order ${r.orderNumber} · ${r.clientName || 'Client not recorded'}`
}

/** Operations' reason, on one short line; the Order page carries all of it. */
export const REASON_CLIP = 140
export function reasonLine(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  if (flat === '') return 'No reason recorded'
  return flat.length <= REASON_CLIP ? flat : `${flat.slice(0, REASON_CLIP - 1).trimEnd()}…`
}

/** Where the answer is made: the Order page, whose top banner holds Respond and resubmit. */
export const flaggedHref = (orderId: string): string => `/orders/${orderId}`
