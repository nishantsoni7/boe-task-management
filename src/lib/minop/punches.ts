// Turning a stored Minop delivery into punches, each kept once.
//
// Reads ONLY the real device shape, `{"trans":[{txnId, dvcId, dvcIP, punchId,
// txnDateTime, mode}]}`. It never decides anything about employees, attendance
// or payroll: the result is written to public.minop_punches, and
// ./machineAttendance decides what those punches mean for a day.

/** The machine's clock is IST (+05:30): production punches arrive 2 minutes after their stated time. */
export const MINOP_DEVICE_UTC_OFFSET_MINUTES = 330

/**
 * How far a punch time may sit from the moment BOE received it. The machine
 * holds punches and sends them later (6 days is the longest seen), so a late
 * punch is normal; a time beyond these limits is not a real punch. Minop's own
 * sample message is dated 2018, and a machine that lost its clock would look
 * the same.
 */
const MAX_DELIVERY_DELAY_MS = 30 * 24 * 60 * 60_000
const MAX_CLOCK_AHEAD_MS = 60 * 60_000

export type MinopPunchRow = {
  dvc_id: string
  minop_user_id: string
  /** `YYYY-MM-DD HH:mm:ss`, exactly as the device sent it. */
  punch_local: string
  /** UTC instant, ISO-8601, derived from punch_local and the offset above. */
  punch_at: string
  txn_id: string | null
  mode: string | null
}

const DEVICE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The device sends numbers and strings interchangeably (punchId is a number). */
function idString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

/** `YYYY-MM-DD HH:mm:ss` device time -> UTC ISO string, or null if not a real date. */
export function deviceTimeToUtcIso(local: string, offsetMinutes = MINOP_DEVICE_UTC_OFFSET_MINUTES): string | null {
  const m = DEVICE_TIME.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(asUtc)
  // Date.UTC rolls 31 Feb over to March; a real timestamp must round-trip.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  if (h > 23 || mi > 59 || s > 59) return null
  return new Date(asUtc - offsetMinutes * 60_000).toISOString()
}

/** False for a punch time too far from when BOE received it to be a real punch. */
export function isPlausiblePunchTime(punchAt: string, firstSeenAt: string): boolean {
  const punchMs = Date.parse(punchAt)
  const seenMs = Date.parse(firstSeenAt)
  if (!Number.isFinite(punchMs) || !Number.isFinite(seenMs)) return false
  return seenMs - punchMs <= MAX_DELIVERY_DELAY_MS && punchMs - seenMs <= MAX_CLOCK_AHEAD_MS
}

/**
 * Every readable punch in a delivery payload. Unreadable entries are skipped,
 * never guessed; the raw delivery still holds them.
 */
export function extractMinopPunches(payload: unknown): MinopPunchRow[] {
  const root = record(payload)
  const trans = root && Array.isArray(root.trans) ? root.trans : []
  const rows: MinopPunchRow[] = []

  for (const entry of trans) {
    const punch = record(entry)
    if (!punch) continue
    const minopUserId = idString(punch.punchId)
    const local = typeof punch.txnDateTime === 'string' ? punch.txnDateTime.trim() : ''
    const punchAt = deviceTimeToUtcIso(local)
    if (!minopUserId || !punchAt) continue

    rows.push({
      dvc_id: idString(punch.dvcId) ?? 'unknown',
      minop_user_id: minopUserId,
      punch_local: local.replace('T', ' '),
      punch_at: punchAt,
      txn_id: idString(punch.txnId),
      mode: idString(punch.mode),
    })
  }
  return rows
}

export type MinopPunchWithFirstSeen = MinopPunchRow & { first_seen_at: string }

/**
 * One row per punch across several messages, keeping the earliest receipt. An
 * upsert may not carry the same key twice in one call.
 */
export function mergePunchRows(rows: MinopPunchWithFirstSeen[]): MinopPunchWithFirstSeen[] {
  const byKey = new Map<string, MinopPunchWithFirstSeen>()
  for (const row of rows) {
    const key = JSON.stringify([row.dvc_id, row.minop_user_id, row.punch_local])
    const held = byKey.get(key)
    if (!held || row.first_seen_at < held.first_seen_at) byKey.set(key, row)
  }
  return [...byKey.values()]
}

type PunchWriter = {
  from: (table: 'minop_punches') => {
    upsert: (
      rows: MinopPunchWithFirstSeen[],
      options: { onConflict: string; ignoreDuplicates: boolean },
    ) => PromiseLike<{ error: { message: string } | null }>
  }
}

/**
 * Best-effort: records the punches of an already-stored delivery. It must never
 * throw, because the raw delivery is safe and Minop's acknowledgement must not
 * depend on this derived table. A punch already held is left exactly as it is.
 */
export async function recordMinopPunches(svc: PunchWriter, receivedAt: string, payload: unknown): Promise<void> {
  try {
    const punches = extractMinopPunches(payload)
    if (punches.length === 0) return
    const { error } = await svc
      .from('minop_punches')
      .upsert(punches.map(p => ({ ...p, first_seen_at: receivedAt })), {
        onConflict: 'dvc_id,minop_user_id,punch_local',
        ignoreDuplicates: true,
      })
    if (error) console.error('[minop/punches] record failed:', error.message)
  } catch (error) {
    console.error('[minop/punches] record failed:', error instanceof Error ? error.message : 'unknown error')
  }
}
