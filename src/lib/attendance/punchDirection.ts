// Which door a punch went through, and how confidently we know it.
//
// WHY THIS EXISTS
// ---------------
// A working day with exactly one punch costs a flat MISSING_PUNCH_HOURS. To
// charge it the engine must first know whether the punch that IS there is the
// arrival or the departure — "Missing Punch In" and "Missing Punch Out" are
// different statements to an employee, and only one of them can carry a
// late-arrival deduction.
//
// The two supported fingerprint exports answer that question with very different
// confidence, and the difference is load-bearing rather than cosmetic:
//
//   Format A  puts arrivals and departures on SEPARATE ROWS. The machine states
//             the direction. We are reading it, not deciding it.  → 'confirmed'
//
//   Format B  puts every punch of the day in ONE cell, newline separated. With
//             two or more punches the first and last are the pair. With exactly
//             one there is nothing in the bytes that says which door it was —
//             only the clock time.                                → 'inferred'
//
// An inferred direction is a good enough basis for "somebody was here and one
// punch is missing". It is NOT a good enough basis for then charging that person
// for arriving late, because the lateness is measured against a time we guessed
// the meaning of. So the provenance travels with the punch pair all the way into
// the deduction rules, and `engine.ts` refuses to stack a late-arrival line on an
// inferred punch. See classifySingleDay() there.
//
// Nothing in this module reads a clock, a database or a file. It is the
// vocabulary the parser, the classifier and the engine share, kept free of
// dependencies so importing it costs nothing anywhere.

/**
 * How the IN/OUT split for a day was decided.
 *
 *   'confirmed' — the source stated the direction (Format A), or a human did
 *                 (an admin attendance correction), or both punches are present
 *                 so nothing had to be decided at all.
 *   'inferred'  — the direction was derived from the clock alone, by the
 *                 divider below. Treat every time-based conclusion drawn from
 *                 it as provisional.
 */
export type PunchDirectionSource = 'confirmed' | 'inferred'

/**
 * TEMPORARY — the clock time that splits a lone Format B punch.
 *
 * 14:00 IST, as minutes past midnight. A single punch BEFORE this is read as an
 * arrival (so the punch-out is the missing one); a single punch AT OR AFTER it
 * is read as a departure (so the punch-in is the missing one).
 *
 * The value is a business decision, not a derived one: it is deliberately NOT
 * the midpoint between the scheduled in and out times, and it must not quietly
 * become one. It is named and isolated here because Central Payroll Settings —
 * the next phase — replaces this constant with an admin-editable setting, and
 * this is the single line that has to change when it does.
 *
 * Until then, treat it as the one hardcoded number this change is allowed to add.
 */
export const TEMP_SINGLE_PUNCH_DIVIDER_MINUTES = 14 * 60

/**
 * Whether a lone punch at this IST time reads as an arrival.
 *
 * Exactly 14:00 is a DEPARTURE — the boundary belongs to the afternoon. Stated
 * here once so the parser and its tests cannot disagree about the edge.
 */
export function isArrivalByDivider(istMinutesPastMidnight: number): boolean {
  return istMinutesPastMidnight < TEMP_SINGLE_PUNCH_DIVIDER_MINUTES
}

/**
 * The provenance to use when a record does not carry one.
 *
 * Defaults to 'inferred', and the direction of that default is the safe one:
 * every attendance row written before this change was stored by a parser that
 * forced the lone punch into check_in_at whatever the clock said, so its
 * direction is exactly as trustworthy as a guess. Reading those rows as
 * 'confirmed' would let the engine charge late arrival on a punch nobody ever
 * established was an arrival — the over-deduction this work exists to remove.
 *
 * The consequence is deliberate and worth stating plainly: until provenance is
 * persisted on attendance_records, a Format A single punch also arrives here as
 * 'inferred' and its genuine late arrival is not charged. That under-charges a
 * narrow case, which is the correct direction to be wrong in, and an admin
 * correction restores the full treatment for any day it matters on.
 */
export function resolveDirectionSource(
  value: PunchDirectionSource | null | undefined,
): PunchDirectionSource {
  return value === 'confirmed' ? 'confirmed' : 'inferred'
}

/**
 * A value read out of the database, narrowed to the type or dropped.
 *
 * `attendance_records.punch_direction_source` is `text` with a CHECK, and a
 * Supabase read hands it back as `string | null` — the CHECK constrains the
 * database, not the TypeScript. Rather than assert the string is one of ours,
 * this checks. Anything unexpected (a value written by some future path, a
 * constraint dropped in an incident, a typo in a manual fix) becomes null and
 * therefore resolves to 'inferred'.
 *
 * The point is that no arbitrary text ever reaches the payroll engine, and an
 * unrecognised value fails toward the reading that cannot over-charge anybody
 * rather than toward the one that can.
 */
export function parseStoredDirectionSource(value: unknown): PunchDirectionSource | null {
  return value === 'confirmed' || value === 'inferred' ? value : null
}
