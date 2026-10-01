// Minop is collection-only for this phase.
//
// Incoming Minop data is stored in public.minop_webhook_deliveries and shown on
// the "Incoming Minop data" register for verification. It must not create or
// update attendance, employee mappings, payroll or deductions.
//
// The switch is a compile-time constant on purpose: it is not read from an
// environment variable, so a stray MINOP_ATTENDANCE_PROCESSING_ENABLED=true in
// a deployment cannot reopen the write path. The only function that can write
// attendance from a Minop delivery (runMinopAttendanceProcessing) calls the
// assertion below before it reads or writes anything, so every present or
// future caller — the webhook route, an admin action, a job, a retry — is
// stopped at the same place. Turning attendance processing back on is a
// deliberate code change in a later phase.

export const MINOP_COLLECTION_ONLY = true

export const MINOP_COLLECTION_ONLY_MESSAGE =
  'Minop is in collection-only mode: incoming data is stored for verification and is not used for attendance.'

export class MinopCollectionOnlyError extends Error {
  constructor() {
    super(MINOP_COLLECTION_ONLY_MESSAGE)
    this.name = 'MinopCollectionOnlyError'
  }
}

/** Throws while Minop is collection-only. Call before any read or write. */
export function assertMinopAttendanceWritesAllowed(): void {
  if (MINOP_COLLECTION_ONLY) throw new MinopCollectionOnlyError()
}
