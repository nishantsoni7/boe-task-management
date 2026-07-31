// Asset repair & service — cost arithmetic and record validation.
//
// Costs arrive from PostgREST as STRINGS, because numeric(14,2) is serialised
// as a string to avoid the precision loss a JS number would introduce. Adding
// them with `+` therefore concatenates rather than sums — "1200" + "800" is
// "1200800", a number a hundred thousand times too large that still renders as
// a plausible-looking figure. Every total in this module goes through
// totalServiceCost() for exactly that reason.

import type { AssetServiceRecord, AssetServiceType } from './types'

/** One cost value → a usable number, or null when it is not one. */
export function parseCost(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * Total spent on an asset across every service record.
 *
 * Unreadable values contribute 0 rather than making the whole total NaN: one
 * bad row must not blank out a figure the rest of the history supports.
 * Rounded to paise so repeated float addition cannot surface as ₹4,199.999998.
 */
export function totalServiceCost(records: readonly Pick<AssetServiceRecord, 'cost'>[]): number {
  const sum = records.reduce((acc, r) => acc + (parseCost(r.cost) ?? 0), 0)
  return Math.round(sum * 100) / 100
}

/** The most recent date on which the asset actually came back from service. */
export function lastServiceDate(
  records: readonly Pick<AssetServiceRecord, 'returned_date' | 'sent_date' | 'created_at'>[],
): string | null {
  let latest: string | null = null
  for (const r of records) {
    // Preference order is "what happened last, as far as we know": a returned
    // date beats a sent date, and a record with neither still dates from when
    // it was written down.
    const candidate = r.returned_date ?? r.sent_date ?? r.created_at ?? null
    if (!candidate) continue
    if (latest === null || candidate > latest) latest = candidate
  }
  return latest
}

/**
 * The next scheduled service date, when one has been recorded.
 *
 * Only dates in the FUTURE relative to `now` count as upcoming — a next-service
 * date that has already passed is an overdue fact about the past, and labelling
 * it "Upcoming" would be a lie. Returns the soonest such date.
 */
export function upcomingServiceDate(
  records: readonly Pick<AssetServiceRecord, 'next_service_date'>[],
  now: Date | string = new Date(),
): string | null {
  const today = (typeof now === 'string' ? new Date(now) : now).toISOString().slice(0, 10)
  let soonest: string | null = null
  for (const r of records) {
    const d = r.next_service_date
    if (!d || d < today) continue
    if (soonest === null || d < soonest) soonest = d
  }
  return soonest
}

export type ServiceSummary = {
  totalCost: number
  recordCount: number
  lastServiceDate: string | null
  upcomingServiceDate: string | null
  openRecordCount: number
}

/** Everything the Repair & Service header states, computed in one pass. */
export function summarizeService(
  records: readonly AssetServiceRecord[],
  now: Date | string = new Date(),
): ServiceSummary {
  return {
    totalCost:           totalServiceCost(records),
    recordCount:         records.length,
    lastServiceDate:     lastServiceDate(records),
    upcomingServiceDate: upcomingServiceDate(records, now),
    openRecordCount:     records.filter(r => r.status === 'in_progress').length,
  }
}

export type ServiceRecordInput = {
  serviceType: string
  vendor?: string | null
  sentDate?: string | null
  returnedDate?: string | null
  cost?: string | null
  issue?: string | null
}

const SERVICE_TYPES: readonly string[] = ['repair', 'maintenance', 'inspection', 'upgrade']

export function isServiceType(value: string): value is AssetServiceType {
  return SERVICE_TYPES.includes(value)
}

/**
 * Why this service record cannot be saved, or null when it can.
 *
 * Mirrors the database constraints (asset_service_dates_ordered, the cost
 * CHECK, the service_type CHECK) so the form refuses what the database would
 * refuse — and says why in a sentence rather than a constraint name.
 */
export function validateServiceRecord(input: ServiceRecordInput): string | null {
  if (!isServiceType(input.serviceType)) {
    return 'Choose a service type.'
  }

  const raw = (input.cost ?? '').trim()
  if (raw !== '') {
    const cost = Number(raw)
    if (!Number.isFinite(cost)) return 'Service cost must be a number.'
    if (cost < 0) return 'Service cost cannot be negative.'
  }

  const sent = (input.sentDate ?? '').trim()
  const back = (input.returnedDate ?? '').trim()
  if (sent && back && back < sent) {
    return 'The returned date cannot be earlier than the sent date.'
  }

  return null
}
