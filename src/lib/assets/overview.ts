// Assets & Access — the owner's overview: what BOE owns, who holds what, what
// is free, and what needs someone to act.
//
// THE RULE: every number and every attention item here is derived from fields
// the module actually records and from states its workflow actually defines.
// Nothing is estimated, and nothing is a problem merely by existing:
//
//   * An AVAILABLE asset is stock, not a problem. It is never an attention item.
//   * There is no "overdue return": no expected-return date is recorded
//     anywhere, so no asset can be late.
//   * There is no cost or age figure: purchase price and purchase date are
//     optional and, on 2026-09-27, recorded on none of production's assets. A
//     total over missing values would be a guess presented as a number.
//
// Pure and tested (overview.test.ts). Operates on the AssetRow list the
// inventory already builds, so the counts, the attention list and the table
// can never disagree about who holds what.

import type { AssetRow } from './assetFilters'

/** Statuses an asset leaves the working fleet by. Counted apart, never as "active". */
export const OUT_OF_SERVICE_STATUSES: ReadonlySet<string> = new Set(['retired', 'disposed'])

export type AssetSummary = {
  /** Everything not retired or disposed. */
  active: number
  assigned: number
  available: number
  underRepair: number
  lost: number
  /** Retired + disposed: kept for the record, not part of the fleet. */
  outOfService: number
  /** DISTINCT assets with at least one attention item. */
  needsAttention: number
}

// ─── Needs attention ─────────────────────────────────────────────────────────

export type AttentionReason =
  | 'custody_mismatch'     // status and custody records disagree
  | 'lost'                 // written off as lost; recover it, or retire it
  | 'awaiting_acceptance'  // handed over, not yet acknowledged by the employee
  | 'under_repair'         // out for service; follow it up
  | 'poor_condition'       // condition recorded as poor or damaged, still in use or stock
  | 'warranty_expiring'    // warranty ends within 30 days (only when recorded)

export type AttentionItem = {
  row: AssetRow
  reason: AttentionReason
  /** A short heading for the reason. */
  label: string
  /** One sentence naming the specific fact, for this asset. */
  detail: string
  /** Whole days since the relevant event, where one is recorded. */
  days: number | null
}

/** Order of the list: data problems first, then what is waiting on a person. */
const REASON_ORDER: readonly AttentionReason[] = [
  'custody_mismatch', 'lost', 'awaiting_acceptance', 'under_repair', 'poor_condition', 'warranty_expiring',
]

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
  custody_mismatch:    'Record needs review',
  lost:                'Marked lost',
  awaiting_acceptance: 'Handover not accepted',
  under_repair:        'Under repair',
  poor_condition:      'Poor condition',
  warranty_expiring:   'Warranty ending soon',
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Every attention item, one per (asset, reason). An asset can carry more than
 * one reason — a lost laptop that was in poor condition is both — but it is
 * listed once per FACT, not duplicated for decoration.
 */
export function attentionItems(rows: readonly AssetRow[], now: Date | string = new Date()): AttentionItem[] {
  const at = typeof now === 'string' ? new Date(now) : now
  const items: AttentionItem[] = []

  for (const row of rows) {
    const a = row.asset
    if (OUT_OF_SERVICE_STATUSES.has(a.status)) continue

    if (row.custodyInconsistent) {
      items.push({
        row, reason: 'custody_mismatch', label: ATTENTION_LABEL.custody_mismatch,
        detail: a.status === 'assigned' && !row.assignment
          ? 'Marked assigned, but no holder is recorded.'
          : `Marked ${a.status.replace(/_/g, ' ')}, but ${row.holderName ?? 'someone'} still holds it on record.`,
        days: null,
      })
    }

    if (a.status === 'lost') {
      items.push({
        row, reason: 'lost', label: ATTENTION_LABEL.lost,
        detail: 'Recover it, or retire it from the fleet.',
        days: daysSince(a.updated_at, at),
      })
    }

    if (row.assignment?.status === 'pending_acceptance') {
      const days = daysSince(row.assignment.assigned_at, at)
      items.push({
        row, reason: 'awaiting_acceptance', label: ATTENTION_LABEL.awaiting_acceptance,
        detail: `${row.holderName ?? 'The employee'} has not accepted the handover`
          + (days === null ? '.' : days === 0 ? ' (assigned today).' : ` (${plural(days, 'day')}).`),
        days,
      })
    }

    if (a.status === 'under_repair') {
      items.push({
        row, reason: 'under_repair', label: ATTENTION_LABEL.under_repair,
        detail: 'Out for service. Follow up and record its return.',
        days: daysSince(a.updated_at, at),
      })
    }

    if ((a.condition === 'poor' || a.condition === 'damaged') && a.status !== 'lost') {
      items.push({
        row, reason: 'poor_condition', label: ATTENTION_LABEL.poor_condition,
        detail: `Condition recorded as ${a.condition}.`,
        days: null,
      })
    }

    // Only a RECORDED expiry can be ending soon; an unrecorded one is simply
    // unknown and is not flagged.
    if (row.warranty === 'expiring_soon') {
      items.push({
        row, reason: 'warranty_expiring', label: ATTENTION_LABEL.warranty_expiring,
        detail: `Warranty ends ${a.warranty_expiry_date}.`,
        days: null,
      })
    }
  }

  return items.sort((x, y) => {
    const r = REASON_ORDER.indexOf(x.reason) - REASON_ORDER.indexOf(y.reason)
    if (r !== 0) return r
    // Within a reason, the longest-waiting first.
    return (y.days ?? -1) - (x.days ?? -1)
  })
}

export type AttentionGroup = {
  row: AssetRow
  /** Every reason this asset is listed for, most pressing first. */
  items: AttentionItem[]
}

/**
 * One entry per ASSET, carrying all of its reasons. A damaged monitor that has
 * also not been accepted is one thing to look at, not two rows — and the count
 * on the tab then matches the count on the tile.
 */
export function attentionByAsset(items: readonly AttentionItem[]): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup>()
  for (const item of items) {
    const id = item.row.asset.id
    const g = groups.get(id)
    if (g) g.items.push(item)
    else groups.set(id, { row: item.row, items: [item] })
  }
  // Map keeps insertion order, and `items` arrive sorted, so each asset sits
  // where its MOST pressing reason put it.
  return [...groups.values()]
}

export function summariseAssets(rows: readonly AssetRow[], attention: readonly AttentionItem[]): AssetSummary {
  const s: AssetSummary = {
    active: 0, assigned: 0, available: 0, underRepair: 0, lost: 0, outOfService: 0,
    needsAttention: new Set(attention.map(i => i.row.asset.id)).size,
  }
  for (const { asset } of rows) {
    if (OUT_OF_SERVICE_STATUSES.has(asset.status)) { s.outOfService++; continue }
    s.active++
    if (asset.status === 'assigned') s.assigned++
    else if (asset.status === 'available') s.available++
    else if (asset.status === 'under_repair') s.underRepair++
    else if (asset.status === 'lost') s.lost++
  }
  return s
}

// ─── By person ───────────────────────────────────────────────────────────────

export type PersonHoldings = {
  employeeId: string
  name: string
  /** Assets this person currently holds (an open custody record). */
  total: number
  /** Of those, handed over but not yet accepted. */
  awaitingAcceptance: number
  /** Category names with counts, most first — "Laptop / Desktop ×1, Phone ×1". */
  categories: { name: string; count: number }[]
}

/**
 * Everyone who holds at least one asset, alphabetically. Custody is the open
 * assignment — the same answer the Current Holder column gives.
 */
export function holdingsByPerson(rows: readonly AssetRow[]): PersonHoldings[] {
  const map = new Map<string, PersonHoldings & { _cats: Map<string, number> }>()
  for (const row of rows) {
    if (!row.holderId || !row.assignment) continue
    let p = map.get(row.holderId)
    if (!p) {
      p = {
        employeeId: row.holderId,
        name: row.holderName ?? 'Unknown employee',
        total: 0, awaitingAcceptance: 0, categories: [], _cats: new Map(),
      }
      map.set(row.holderId, p)
    }
    p.total++
    if (row.assignment.status === 'pending_acceptance') p.awaitingAcceptance++
    p._cats.set(row.categoryName, (p._cats.get(row.categoryName) ?? 0) + 1)
  }
  return [...map.values()]
    .map(({ _cats, ...p }) => ({
      ...p,
      categories: [..._cats.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

// ─── By category ─────────────────────────────────────────────────────────────

export type CategoryCounts = {
  categoryKey: string
  name: string
  total: number
  assigned: number
  available: number
  /** Under repair + lost: in the fleet but not in use or in stock. */
  other: number
  outOfService: number
}

/**
 * One row per category that has assets, with counts by status. The columns
 * add up: total = assigned + available + other + outOfService.
 */
export function countsByCategory(rows: readonly AssetRow[]): CategoryCounts[] {
  const map = new Map<string, CategoryCounts>()
  for (const row of rows) {
    const key = row.asset.asset_type
    let c = map.get(key)
    if (!c) {
      c = { categoryKey: key, name: row.categoryName, total: 0, assigned: 0, available: 0, other: 0, outOfService: 0 }
      map.set(key, c)
    }
    c.total++
    const s = row.asset.status
    if (OUT_OF_SERVICE_STATUSES.has(s)) c.outOfService++
    else if (s === 'assigned') c.assigned++
    else if (s === 'available') c.available++
    else c.other++
  }
  return [...map.values()].sort((a, b) => {
    if (a.categoryKey === 'other' && b.categoryKey !== 'other') return 1
    if (b.categoryKey === 'other' && a.categoryKey !== 'other') return -1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}
