// THE CONFIRMED ORDER PAGE'S ONE READ (20270406000000).
//
// public.order_page_bundle(order_id) returns, as one jsonb answer, everything the page reads once it knows
// the Order's id. This module turns that answer into the SAME { data, error } shapes the page's separate
// reads produce today, so the page's existing mapping code runs on either without a second copy of it, and
// decides whether to use it at all.
//
// THE PAGE KEEPS ITS SEPARATE READS. If the function is not on the database (an older one), refuses, or
// answers something that is not the expected shape, fetchOrderBundle() returns null and the page reads the
// way it always did. A database that is known to lack the function is remembered for the life of the tab, so
// the failed attempt is paid once, not on every Order.
//
// ACCESS IS THE DATABASE'S: the function is SECURITY INVOKER, so each table's own row-level security decides
// what this person gets. Nothing here widens, caches or re-derives that.

import type { SupabaseClient } from '@supabase/supabase-js'

/** The shape of a PostgREST answer, as far as the page reads one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the page casts each read where it uses it, as it does a PostgREST answer
export type Read<T = any> = {
  data: T | null
  error: { code: string; message: string } | null
}

/** The Order's source PI, as the page's nine reads plus the names read it makes next. */
export type PiReads = {
  submission: Read
  items: Read
  images: Read
  versions: Read
  trail: Read
  codes: Read
  handoffs: Read
  commission: Read
  commissionReadable: Read<boolean>
  /** Who the versions, the trail and the handoffs mention: { id, full_name, is_active }. */
  people: Read
}

export type OrderBundleReads = {
  /** found:false (no such Order, or not visible to this reader) is { data: null, error: null }. */
  orderRow: Read<Record<string, unknown>>
  /** order_advance_readiness's own answer, or null when it could not be read. */
  advance: unknown
  pi: PiReads
  payments: Read
  allocations: Read
  activity: Read
  approvals: Read
  changeRequests: Read
  /** payment_active_allocation_totals rows; empty when there were none or the part failed. */
  activeTotals: { payment_request_id: string; active_total: string | number | null }[]
}

/** The column lists the SQL function selects, kept here so a test can hold the two in step. */
export const ORDER_BUNDLE_PARTS = [
  'advance', 'submission', 'items', 'images', 'codes', 'versions', 'trail', 'handoffs', 'commission',
  'commission_readable', 'payments', 'allocations', 'active_totals', 'activity', 'approvals',
  'change_requests', 'people',
] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One part of the answer, as a PostgREST-shaped read. A part that is not { ok: true } reads as an error. */
export function partToRead(part: unknown): Read | null {
  if (!isObj(part) || typeof part.ok !== 'boolean') return null
  if (part.ok) return { data: part.data ?? null, error: null }
  return { data: null, error: { code: typeof part.code === 'string' ? part.code : 'unknown', message: 'part of the Order bundle could not be read' } }
}

/**
 * Turns the function's answer into the page's reads, or null when the answer is not one it can trust:
 * not an object, missing a part, or a part that is neither ok nor an error. Null means "read the old way".
 */
export function adaptOrderBundle(raw: unknown): OrderBundleReads | null {
  if (!isObj(raw) || typeof raw.found !== 'boolean') return null

  if (!raw.found) {
    const empty: Read = { data: [], error: null }
    return {
      orderRow: { data: null, error: null },
      advance: null,
      pi: {
        submission: { data: null, error: null }, items: empty, images: empty, versions: empty, trail: empty, codes: empty,
        handoffs: empty, commission: { data: null, error: null }, commissionReadable: { data: false, error: null }, people: empty,
      },
      payments: empty, allocations: empty, activity: empty, approvals: empty, changeRequests: empty, activeTotals: [],
    }
  }

  if (!isObj(raw.order)) return null
  const reads: Record<string, Read> = {}
  for (const name of ORDER_BUNDLE_PARTS) {
    const read = partToRead(raw[name])
    if (!read) return null
    reads[name] = read
  }

  const advance = reads.advance.error ? null : reads.advance.data
  const totals = reads.active_totals.error ? [] : (Array.isArray(reads.active_totals.data) ? reads.active_totals.data : [])

  return {
    orderRow: { data: raw.order, error: null },
    advance,
    pi: {
      submission: reads.submission,
      items: reads.items,
      images: reads.images,
      versions: reads.versions,
      trail: reads.trail,
      codes: reads.codes,
      handoffs: reads.handoffs,
      commission: reads.commission,
      commissionReadable: reads.commission_readable as Read<boolean>,
      people: reads.people,
    },
    payments: reads.payments,
    allocations: reads.allocations,
    activity: reads.activity,
    approvals: reads.approvals,
    changeRequests: reads.change_requests,
    activeTotals: totals as OrderBundleReads['activeTotals'],
  }
}

/** True when the error means the function is not on this database (as opposed to a failure of this call). */
export function isBundleFunctionMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883'
    || /could not find the function|does not exist/i.test(error.message ?? '')
}

// Remembered for the life of the tab: once the database has said it has no such function, do not ask again.
let knownMissing = false

/** For tests: forget what this tab has learned. */
export function resetOrderBundleMemory(): void { knownMissing = false }

/**
 * Reads the whole page in one call, or returns null when the page should read the way it always did.
 * Never throws: a failure of any kind is "read the old way".
 */
export async function fetchOrderBundle(supabase: SupabaseClient, orderId: string): Promise<OrderBundleReads | null> {
  if (knownMissing) return null
  try {
    const { data, error } = await supabase.rpc('order_page_bundle', { p_order_id: orderId })
    if (error) {
      if (isBundleFunctionMissing(error)) knownMissing = true
      return null
    }
    return adaptOrderBundle(data)
  } catch {
    return null
  }
}
