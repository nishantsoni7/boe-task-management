// Validating a stored Minop delivery's payload into a punch event, before
// anything about employees, attendance or payroll is decided.
//
// This module only reads the shape Minop's published real-time callback
// documents:
//
//   { RealTime: { AuthToken, OperationID, PunchLog: { UserId, LogTime, Type,
//                 InputType, ... }, Time } }
//
// It does not authenticate (the webhook route already did, before the
// delivery was ever stored) and it does not touch a database. It answers one
// question: is this a well-formed punch, and if so, which one.

/** The two punch types this branch turns into attendance. Everything else —
 *  BreakIn, BreakOut, or any type Minop adds later — is read, recorded on the
 *  delivery, and left alone. */
export const SUPPORTED_PUNCH_TYPES = ['CheckIn', 'CheckOut'] as const
export type SupportedPunchType = (typeof SUPPORTED_PUNCH_TYPES)[number]

export type MinopPunchEvent = {
  minopUserId: string
  type: string
  /** Present only when `type` is one this branch acts on. */
  supportedType: SupportedPunchType | null
  /** PunchLog.LogTime, parsed and re-emitted as a UTC ISO instant. */
  logTimeUtc: string
  operationId: string | null
}

export type PunchEventResult =
  | { ok: true; event: MinopPunchEvent }
  | { ok: false; reason: 'missing_realtime' | 'missing_punchlog' | 'missing_user_id' | 'invalid_log_time' | 'missing_type' }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** OperationID is documented as an "INT_ID" but the example payload sends a
 *  JSON number — accept either without assuming which the real device uses. */
function idLikeString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return nonEmptyString(value)
}

/**
 * The published contract's `LogTime` is documented as UTC, but not guaranteed
 * to carry a `Z`/offset in whatever the device actually sends — so this
 * parses with `Date.parse` (which accepts a bare `YYYY-MM-DDTHH:mm:ss` as UTC
 * only when explicit about it) and then re-serialises, refusing anything that
 * does not round-trip to an unambiguous instant.
 */
function parseUtcInstant(value: unknown): string | null {
  const raw = nonEmptyString(value)
  if (!raw) return null
  // Require an explicit UTC/offset marker. A bare local-looking string with no
  // zone is not "UTC because the docs say so" — it is a device clock this
  // branch has not seen yet, and guessing its zone is exactly what Phase C4
  // forbids scattering.
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/** Validate a stored delivery's parsed payload into one punch event. */
export function parseMinopPunchEvent(payload: unknown): PunchEventResult {
  const root = record(payload)
  const realTime = record(root?.RealTime)
  if (!realTime) return { ok: false, reason: 'missing_realtime' }

  const punchLog = record(realTime.PunchLog)
  if (!punchLog) return { ok: false, reason: 'missing_punchlog' }

  const minopUserId = nonEmptyString(punchLog.UserId)
  if (!minopUserId) return { ok: false, reason: 'missing_user_id' }

  const type = nonEmptyString(punchLog.Type)
  if (!type) return { ok: false, reason: 'missing_type' }

  const logTimeUtc = parseUtcInstant(punchLog.LogTime)
  if (!logTimeUtc) return { ok: false, reason: 'invalid_log_time' }

  const operationId = idLikeString(realTime.OperationID)

  return {
    ok: true,
    event: {
      minopUserId,
      type,
      supportedType: (SUPPORTED_PUNCH_TYPES as readonly string[]).includes(type)
        ? (type as SupportedPunchType)
        : null,
      logTimeUtc,
      operationId,
    },
  }
}
