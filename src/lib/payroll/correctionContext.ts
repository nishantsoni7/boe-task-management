// What the correction modal shows as "the machine record".
//
// Split out of the Payroll Result Detail page because getting it wrong is not
// visible in a type check and not obvious on screen: the modal keeps rendering,
// it just shows the admin a punch the biometric machine never recorded, right
// where they are deciding what to correct.
//
// The rule: once a correction exists for a date, the correction row's raw_*
// fields ARE the machine record and are authoritative — including when they are
// null, which is what "the machine never recorded that punch" looks like. Only
// an uncorrected date falls back to the day's own punches, which are the raw
// ones by definition.

export type RawPunches = {
  check_in_at: string | null
  check_out_at: string | null
}

export type CorrectionRawPunches = {
  raw_check_in_at: string | null
  raw_check_out_at: string | null
}

/**
 * The machine record for a date.
 *
 * `dayPunches` are the effective punches the engine used — equal to the raw
 * ones only when no correction applies.
 */
export function resolveMachineRecord(
  correction: CorrectionRawPunches | null | undefined,
  dayPunches: RawPunches,
): RawPunches {
  if (correction) {
    return {
      check_in_at:  correction.raw_check_in_at,
      check_out_at: correction.raw_check_out_at,
    }
  }
  return { check_in_at: dayPunches.check_in_at, check_out_at: dayPunches.check_out_at }
}
