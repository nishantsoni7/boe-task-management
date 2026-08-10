// How long somebody was actually at work.
//
// ONE PLACE, BECAUSE IT DECIDES MONEY
// -----------------------------------
// The paid duration of a day is the input to its classification, and the
// classification is what a day costs. Every screen that shows "worked hours" and
// every path that charges for a day has to agree to the minute, so the
// arithmetic lives here and nothing else recomputes it.
//
// THE LUNCH BUG THIS EXISTS TO FIX
// --------------------------------
// Lunch used to be a BOOLEAN: if the punch-in was before lunch ended and the
// punch-out was after lunch started, a whole `lunch_hours` was subtracted —
// however little of lunch the employee's day actually covered.
//
// So 10:05 → 13:33, which overlaps a 13:00–14:00 lunch by 33 minutes, lost a
// full hour: 3h28m of presence became 2h28m of paid time instead of 2h55m. The
// employee was charged 27 minutes they had worked, and because the shortfall
// pushed the day into a lower band it changed what the day cost.
//
// The fix is to subtract the ACTUAL overlap of the two intervals. That is the
// only reading under which "lunch is unpaid" means what it says.

/** A closed interval in IST minutes past midnight. */
export type MinuteInterval = { start: number; end: number }

/**
 * Minutes shared by two intervals. Zero when they do not meet.
 *
 *   overlap = max(0, min(aEnd, bEnd) − max(aStart, bStart))
 *
 * Worked examples against a 13:00–14:00 lunch:
 *
 *   10:05–12:55  →  0m   (ends before lunch starts)
 *   10:05–13:33  →  33m  (covers the first 33 minutes of lunch)
 *   10:05–14:20  →  60m  (covers all of it)
 *   13:20–13:50  →  30m  (sits entirely inside lunch)
 *   13:30–18:30  →  30m  (covers the second half)
 *   14:00–18:30  →  0m   (starts exactly as lunch ends)
 */
export function overlapMinutes(a: MinuteInterval, b: MinuteInterval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

/** The unpaid lunch window, from settings. */
export type LunchWindow = {
  /** Lunch starts here — `lunch_out_after_minutes`. */
  start: number
  /** …and ends here — `lunch_in_before_minutes`. */
  end: number
  /**
   * The most that may be deducted for lunch, in hours.
   *
   * The window and the allowance are configured separately, so a company can say
   * "lunch runs 13:00–14:00 but only 30 minutes of it is unpaid". The deduction
   * is therefore the overlap CAPPED at this, never more.
   */
  maxHours: number
}

export type WorkedDuration = {
  /** Clock time between the punches, before lunch. */
  elapsed_hours: number
  /** Lunch actually inside the punch interval, capped at the allowance. */
  lunch_hours_deducted: number
  /** What the day is paid and classified on. Never negative. */
  paid_hours: number
}

/**
 * The paid worked time for one complete punch pair.
 *
 * `inMinutes`/`outMinutes` are IST minutes past midnight and `elapsedHours` is
 * the true clock difference — passed in rather than derived from the minutes so
 * a pair that crosses midnight, or one whose seconds matter, is measured from
 * the timestamps themselves rather than from a same-day assumption.
 *
 * The lunch deduction is capped twice: at the configured allowance, and at the
 * elapsed time itself. The second cap stops a misconfigured window (a lunch
 * longer than the working day) from producing negative paid hours, which would
 * classify a present employee as absent.
 */
export function computeWorkedDuration(
  inMinutes: number,
  outMinutes: number,
  elapsedHours: number,
  lunch: LunchWindow,
): WorkedDuration {
  const overlap = overlapMinutes(
    { start: inMinutes, end: outMinutes },
    { start: lunch.start, end: lunch.end },
  )

  const cappedHours = Math.min(overlap / 60, Math.max(0, lunch.maxHours))
  const lunchDeducted = Math.min(cappedHours, Math.max(0, elapsedHours))

  return {
    elapsed_hours: elapsedHours,
    lunch_hours_deducted: lunchDeducted,
    paid_hours: Math.max(0, elapsedHours - lunchDeducted),
  }
}
