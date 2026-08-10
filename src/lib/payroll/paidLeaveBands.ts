// Editing the paid-leave bands.
//
// The bands are the one setting that is a LIST rather than a number, so the
// editor needs operations — add, change, remove — instead of a single input.
// Those operations live here rather than inside the settings page for one
// reason: logic buried in JSX cannot be tested without a DOM, and this logic
// decides how much paid leave an employee earns.
//
// Everything here is pure. Nothing validates — validation belongs to
// parsePayrollSettings in ./settings, which is the same function the API runs,
// so the form cannot accept something the server would reject. These helpers
// only rearrange.
//
// ON ORDER
// --------
// The engine reads the bands top-down and awards the FIRST one an employee
// reaches (computePaidLeaveEntitlement in ./engine), so order is genuinely part
// of the calculation. But it is not an independent property: it is entirely
// determined by `min_days_present` descending, and parsePayrollSettings
// normalises by sorting on exactly that.
//
// So there is no `moveBandUp`/`moveBandDown` here, and that absence is
// deliberate. Offering a reorder control would present a choice that does not
// exist — any arrangement disagreeing with the thresholds would be silently
// re-sorted on save. `orderBands` instead shows the admin the order the engine
// will actually use.

import type { PaidLeaveTier } from './settings'
import { MAX_PAID_LEAVE_BANDS } from './settings'

/**
 * The bands in the order payroll evaluates them: highest threshold first.
 *
 * This is the same ordering parsePayrollSettings applies on save, so what the
 * editor shows is what the engine will do.
 */
export function orderBands(bands: readonly PaidLeaveTier[]): PaidLeaveTier[] {
  return [...bands].sort((a, b) => b.min_days_present - a.min_days_present)
}

/** The highest days-present threshold a band may carry — a month of days. */
const MAX_THRESHOLD = 31

/**
 * A new band, at the lowest threshold not already taken.
 *
 * The threshold has to be UNUSED, not merely low. A valid list always contains a
 * 0-day band (the validator requires one so every employee falls into a band),
 * so "one below the lowest" resolves to 0 and collides with it — the admin would
 * meet a duplicate-threshold error on a row they had not yet typed anything
 * into. Searching for the first free value avoids that by construction.
 *
 * 0 is offered first only when nothing occupies it, which happens while a list
 * is mid-edit. Otherwise the search runs upward from 1, so the new band lands
 * between the floor band and whatever sits above it, where it is reachable.
 *
 * At the cap, or with every threshold taken, the list comes back unchanged
 * rather than throwing — the caller is a button that is already disabled, and an
 * exception there would be a crash instead of a message.
 */
export function addBand(bands: readonly PaidLeaveTier[]): PaidLeaveTier[] {
  if (bands.length >= MAX_PAID_LEAVE_BANDS) return [...bands]

  const ordered = orderBands(bands)
  const taken = new Set(ordered.map(b => b.min_days_present))

  let threshold: number | null = null
  for (let candidate = 0; candidate <= MAX_THRESHOLD; candidate++) {
    if (!taken.has(candidate)) { threshold = candidate; break }
  }
  if (threshold == null) return ordered

  return orderBands([...ordered, { min_days_present: threshold, leave: 0 }])
}

/**
 * One band changed, by its position in the DISPLAYED (ordered) list.
 *
 * The index is a display index because that is what the admin clicked. The list
 * is ordered first so the index means the same thing here as it did on screen —
 * indexing into an unordered array would edit whichever band happened to be
 * stored in that slot, which is a different row from the one they touched.
 *
 * The result is NOT re-sorted. Re-sorting mid-edit would move a row out from
 * under the cursor the moment a threshold was typed; the caller sorts for
 * display, and the save path sorts for storage.
 */
export function updateBand(
  bands: readonly PaidLeaveTier[],
  displayIndex: number,
  patch: Partial<PaidLeaveTier>,
): PaidLeaveTier[] {
  const ordered = orderBands(bands)
  if (displayIndex < 0 || displayIndex >= ordered.length) return ordered
  return ordered.map((band, i) => (i === displayIndex ? { ...band, ...patch } : band))
}

/**
 * One band removed, by display index.
 *
 * The last band is never removed. The engine cannot work out an allowance from
 * an empty list — computePaidLeaveEntitlement would fall through every band and
 * return 0 for everybody, silently withdrawing paid leave from the whole company
 * — and parsePayrollSettings refuses an empty list for the same reason. Refusing
 * here too means the button can be disabled with an explanation rather than the
 * admin meeting a validation error after the fact.
 */
export function removeBand(
  bands: readonly PaidLeaveTier[],
  displayIndex: number,
): PaidLeaveTier[] {
  const ordered = orderBands(bands)
  if (ordered.length <= 1) return ordered
  if (displayIndex < 0 || displayIndex >= ordered.length) return ordered
  return ordered.filter((_, i) => i !== displayIndex)
}

/** Whether another band may be added. */
export function canAddBand(bands: readonly PaidLeaveTier[]): boolean {
  return bands.length < MAX_PAID_LEAVE_BANDS
}

/** Whether a band may be removed. False at one band, which is the minimum. */
export function canRemoveBand(bands: readonly PaidLeaveTier[]): boolean {
  return bands.length > 1
}

/**
 * The allowance these bands would award an employee with this many days present.
 *
 * A mirror of the engine's lookup, for the editor to describe a band in words.
 * It reads the bands in engine order so it cannot disagree with what payroll
 * will actually pay.
 */
export function allowanceForDaysPresent(
  bands: readonly PaidLeaveTier[],
  daysPresent: number,
): number {
  for (const band of orderBands(bands)) {
    if (daysPresent >= band.min_days_present) return band.leave
  }
  return 0
}
