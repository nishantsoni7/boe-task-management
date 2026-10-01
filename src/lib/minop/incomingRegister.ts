// The "Incoming Minop data" register: turns stored raw deliveries into one
// inspectable row per punch, without interpreting them as attendance.
//
// Rules this module keeps:
//   - Pure. It reads nothing, writes nothing, and never maps an employee.
//   - Reads only fields that are actually present. A field the payload does not
//     carry stays null; nothing is invented, defaulted or inferred (IN/OUT is
//     never worked out from punch order).
//   - IDs stay strings exactly as received, so leading zeros survive.
//   - Received time (when BOE stored the message) and punch time (what the
//     device says) are separate fields. A punch time with no zone marker is
//     kept exactly as sent and is NOT converted: guessing the device's zone is
//     a fact this module does not have.
//   - Credentials are removed from everything that is displayed or exported.
//
// Shapes read (both observed or documented in this repo):
//   Device callback (seen on production):
//     { "trans": [ { txnId, dvcId, dvcIP, punchId, txnDateTime, mode, ... } ] }
//   Published real-time callback (docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md):
//     { "RealTime": { OperationID, PunchLog: { UserId, LogTime, Type, ... } } }

export type MinopDeliveryRow = {
  id: string
  received_at: string
  service_tag_id: string | null
  content_type: string | null
  user_agent: string | null
  auth_method: string
  processing_status: string
  error_text: string | null
  body_sha256: string
  payload: unknown | null
  raw_body: string
}

/**
 * readable    every punch field the register needs is present
 * partial     the message has a punch, but it lacks a field (reason says which)
 * no_punches  the message was read but carries no punches (an empty "trans" list)
 * unreadable  the message could not be read at all (invalid JSON, unknown shape)
 */
export type ReadStatus = 'readable' | 'partial' | 'no_punches' | 'unreadable'

export type MessageFormat = 'device_trans' | 'realtime_punchlog' | 'unknown'

export type DuplicateFlag = 'same_body_received_again' | 'same_device_event_id_seen_again'

export type IncomingRegisterRow = {
  /** Stable row key: `<deliveryId>#<entryIndex>`, or `<deliveryId>#-` for a message with no entries. */
  rowId: string
  deliveryId: string
  /** 1-based position inside the message's list of punches; null when the message has none. */
  entryNumber: number | null
  entryCount: number
  receivedAt: string
  /** Which field set the punch was read from. */
  format: MessageFormat
  /**
   * `punchId` on the device callback, `PunchLog.UserId` on the real-time one.
   * Whether it is the person's fingerprint/employee ID is NOT confirmed by Minop;
   * the register labels it by its field name.
   */
  minopUserId: string | null
  /** `txnId` on the device callback, `OperationID` on the real-time one. Separate from the punch ID. */
  eventId: string | null
  /** Punch time exactly as sent. */
  punchTimeRaw: string | null
  /** True only when the punch time carries a zone marker (Z or ±hh:mm), so it is an exact instant. */
  punchTimeHasZone: boolean
  /** ISO instant, set only when punchTimeHasZone. */
  punchTimeInstant: string | null
  /** The device's own punch-type value as sent (`mode` or `Type`). Not translated. */
  punchTypeRaw: string | null
  punchTypeSource: 'mode' | 'Type' | null
  deviceId: string | null
  deviceIp: string | null
  deviceName: string | null
  /** A person's name, only when the payload itself carries one. */
  nameSupplied: string | null
  readStatus: ReadStatus
  /** Exact reason when the row is partial or unreadable; null when fully read. */
  readReason: string | null
  duplicateFlags: DuplicateFlag[]
  bodySha256: string
  authMethod: string
  /** The single punch entry as received, credentials removed; null for a message with none. */
  entryJson: unknown | null
}

const SECRET_KEY = /^(auth[_-]?token|authorization|secret|password|api[_-]?key|access[_-]?token|bearer|token)$/i

/** Remove credential-looking keys at any depth. Returns a copy; the input is untouched. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[removed]' : redactSecrets(inner)
    }
    return out
  }
  return value
}

const SECRET_IN_TEXT =
  /("(?:auth[_-]?token|authorization|secret|password|api[_-]?key|access[_-]?token|bearer|token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi

/**
 * The received body with credential values blanked, otherwise byte-for-byte as
 * received. Works on text, so it also covers a body that is not valid JSON.
 */
export function redactRawBody(rawBody: string): string {
  return rawBody.replace(SECRET_IN_TEXT, (_m, head: string) => `${head}"[removed]"`)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A present scalar as text, exactly as received. Strings keep their form (leading zeros). */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

function firstScalar(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = scalar(source[key])
    if (found !== null) return found
  }
  return null
}

const ZONE_MARKER = /(?:[Zz]|[+-]\d{2}:?\d{2})$/

function withZoneInstant(raw: string | null): { hasZone: boolean; instant: string | null } {
  if (!raw || !ZONE_MARKER.test(raw.trim())) return { hasZone: false, instant: null }
  const ms = Date.parse(raw.trim())
  return Number.isFinite(ms)
    ? { hasZone: true, instant: new Date(ms).toISOString() }
    : { hasZone: false, instant: null }
}

type Entry = {
  userId: string | null
  eventId: string | null
  punchTime: string | null
  punchType: string | null
  punchTypeSource: 'mode' | 'Type' | null
  deviceId: string | null
  deviceIp: string | null
  deviceName: string | null
  name: string | null
  raw: unknown
}

function readTransEntry(raw: unknown): Entry {
  const e = record(raw) ?? {}
  return {
    userId: scalar(e.punchId),
    eventId: scalar(e.txnId),
    punchTime: scalar(e.txnDateTime),
    punchType: scalar(e.mode),
    punchTypeSource: scalar(e.mode) !== null ? 'mode' : null,
    deviceId: scalar(e.dvcId),
    deviceIp: scalar(e.dvcIP),
    deviceName: firstScalar(e, ['dvcName', 'deviceName', 'DeviceName']),
    name: firstScalar(e, ['name', 'userName', 'UserName', 'empName']),
    raw,
  }
}

function missingFields(entry: Entry, labels: { user: string; time: string }): string[] {
  const missing: string[] = []
  if (entry.userId === null) missing.push(labels.user)
  if (entry.punchTime === null) missing.push(labels.time)
  return missing
}

type Expanded = Omit<IncomingRegisterRow, 'duplicateFlags'>

function baseRow(delivery: MinopDeliveryRow, entryCount: number): Omit<
  Expanded,
  'rowId' | 'format' | 'entryNumber' | 'minopUserId' | 'eventId' | 'punchTimeRaw' | 'punchTimeHasZone' | 'punchTimeInstant' |
  'punchTypeRaw' | 'punchTypeSource' | 'deviceId' | 'deviceIp' | 'deviceName' | 'nameSupplied' | 'readStatus' |
  'readReason' | 'entryJson'
> {
  return {
    deliveryId: delivery.id,
    entryCount,
    receivedAt: delivery.received_at,
    bodySha256: delivery.body_sha256,
    authMethod: delivery.auth_method,
  }
}

function unreadableRow(
  delivery: MinopDeliveryRow,
  reason: string,
  entryCount = 0,
  readStatus: ReadStatus = 'unreadable',
  format: MessageFormat = 'unknown',
): Expanded {
  return {
    ...baseRow(delivery, entryCount),
    rowId: `${delivery.id}#-`,
    format,
    entryNumber: null,
    minopUserId: null,
    eventId: null,
    punchTimeRaw: null,
    punchTimeHasZone: false,
    punchTimeInstant: null,
    punchTypeRaw: null,
    punchTypeSource: null,
    deviceId: null,
    deviceIp: null,
    deviceName: null,
    nameSupplied: null,
    readStatus,
    readReason: reason,
    entryJson: null,
  }
}

function entryRow(
  delivery: MinopDeliveryRow,
  entry: Entry,
  index: number,
  total: number,
  labels: { user: string; time: string },
  format: MessageFormat,
): Expanded {
  const missing = missingFields(entry, labels)
  const zone = withZoneInstant(entry.punchTime)
  return {
    ...baseRow(delivery, total),
    rowId: `${delivery.id}#${index + 1}`,
    format,
    entryNumber: index + 1,
    minopUserId: entry.userId,
    eventId: entry.eventId,
    punchTimeRaw: entry.punchTime,
    punchTimeHasZone: zone.hasZone,
    punchTimeInstant: zone.instant,
    punchTypeRaw: entry.punchType,
    punchTypeSource: entry.punchTypeSource,
    deviceId: entry.deviceId,
    deviceIp: entry.deviceIp,
    deviceName: entry.deviceName,
    nameSupplied: entry.name,
    readStatus: missing.length ? 'partial' : 'readable',
    readReason: missing.length ? `Not present in this punch: ${missing.join(', ')}` : null,
    entryJson: redactSecrets(entry.raw),
  }
}

/** One stored delivery → one row per punch, or a single unreadable row. */
export function expandDelivery(delivery: MinopDeliveryRow): Expanded[] {
  if (delivery.processing_status !== 'received' || delivery.payload === null || delivery.payload === undefined) {
    return [unreadableRow(delivery, delivery.error_text
      ? `Message could not be read: ${delivery.error_text}`
      : 'Message could not be read: no parsed payload was stored')]
  }

  const root = record(delivery.payload)
  if (!root) {
    return [unreadableRow(delivery, 'The message is a JSON list, not the object with a "trans" list that the device sends')]
  }

  if ('trans' in root) {
    if (!Array.isArray(root.trans)) {
      return [unreadableRow(delivery, '"trans" is present but is not a list of punches')]
    }
    if (root.trans.length === 0) {
      const selfTest = root.boeSyntheticSelfTest === true
      return [unreadableRow(
        delivery,
        selfTest
          ? 'The message body is flagged boeSyntheticSelfTest (a BOE receiver self-test) and its "trans" list is empty'
          : 'The message has an empty "trans" list',
        0, 'no_punches', 'device_trans',
      )]
    }
    const total = root.trans.length
    return root.trans.map((raw, index) =>
      record(raw)
        ? entryRow(delivery, readTransEntry(raw), index, total, { user: 'punchId', time: 'txnDateTime' }, 'device_trans')
        : { ...unreadableRow(delivery, `Entry ${index + 1} of "trans" is not an object`, total, 'unreadable', 'device_trans'),
            rowId: `${delivery.id}#${index + 1}`, entryNumber: index + 1,
            entryJson: redactSecrets(raw) },
    )
  }

  const realTime = record(root.RealTime)
  const punchLog = record(realTime?.PunchLog)
  if (realTime && punchLog) {
    const entry: Entry = {
      userId: scalar(punchLog.UserId),
      eventId: scalar(realTime.OperationID),
      punchTime: scalar(punchLog.LogTime),
      punchType: scalar(punchLog.Type),
      punchTypeSource: scalar(punchLog.Type) !== null ? 'Type' : null,
      deviceId: firstScalar(punchLog, ['DeviceId', 'DeviceID']),
      deviceIp: null,
      deviceName: firstScalar(punchLog, ['DeviceName']),
      name: firstScalar(punchLog, ['Name', 'UserName']),
      raw: punchLog,
    }
    return [entryRow(delivery, entry, 0, 1, { user: 'PunchLog.UserId', time: 'PunchLog.LogTime' }, 'realtime_punchlog')]
  }

  return [unreadableRow(
    delivery,
    'Unrecognised message shape: it has neither a "trans" list nor RealTime.PunchLog. Top-level fields: '
      + (Object.keys(root).sort().join(', ') || '(none)'),
  )]
}

/**
 * Expand every delivery and flag duplicates across the WHOLE set, so a flag
 * never depends on which filter or page is on screen.
 *
 * Two flags, both reliably identifiable:
 *   same_body_received_again          the exact same request body (SHA-256) arrived in more than one delivery
 *   same_device_event_id_seen_again   the same device ID and event ID appear in more than one punch
 * Whether an event ID is unique per punch on the real device is unconfirmed
 * (docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md), so the second flag says
 * only what it observed.
 */
export function buildIncomingRows(deliveries: MinopDeliveryRow[]): IncomingRegisterRow[] {
  const rows = deliveries.flatMap(expandDelivery)

  const deliveriesPerBody = new Map<string, Set<string>>()
  const rowsPerDeviceEvent = new Map<string, number>()
  for (const row of rows) {
    const set = deliveriesPerBody.get(row.bodySha256) ?? new Set<string>()
    set.add(row.deliveryId)
    deliveriesPerBody.set(row.bodySha256, set)
    if (row.eventId !== null && row.deviceId !== null) {
      const key = JSON.stringify([row.deviceId, row.eventId])
      rowsPerDeviceEvent.set(key, (rowsPerDeviceEvent.get(key) ?? 0) + 1)
    }
  }

  return rows.map(row => {
    const flags: DuplicateFlag[] = []
    if ((deliveriesPerBody.get(row.bodySha256)?.size ?? 0) > 1) flags.push('same_body_received_again')
    if (row.eventId !== null && row.deviceId !== null
      && (rowsPerDeviceEvent.get(JSON.stringify([row.deviceId, row.eventId])) ?? 0) > 1) {
      flags.push('same_device_event_id_seen_again')
    }
    return { ...row, duplicateFlags: flags }
  })
}

export const DUPLICATE_FLAG_LABEL: Record<DuplicateFlag, string> = {
  same_body_received_again: 'Same message received again',
  same_device_event_id_seen_again: 'Same device and event ID seen again',
}

// ── Filtering ────────────────────────────────────────────────────────────────

export type IncomingFilters = {
  /** Matches user ID, event ID, or device ID / IP / name (case-insensitive, substring). */
  q?: string
  /** Received-date range, IST calendar dates, YYYY-MM-DD, inclusive. */
  from?: string
  to?: string
}

const IST_OFFSET = '+05:30'
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function isIstDate(value: string | null | undefined): value is string {
  if (!value || !DATE_ONLY.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00${IST_OFFSET}`)
  return Number.isFinite(ms) && new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10) === value
}

/** [start, end) instants for an inclusive IST date range. */
export function receivedRangeBounds(filters: IncomingFilters): { startMs: number | null; endMs: number | null } {
  const startMs = isIstDate(filters.from) ? Date.parse(`${filters.from}T00:00:00${IST_OFFSET}`) : null
  const endMs = isIstDate(filters.to) ? Date.parse(`${filters.to}T00:00:00${IST_OFFSET}`) + 86_400_000 : null
  return { startMs, endMs }
}

export function filterIncomingRows(rows: IncomingRegisterRow[], filters: IncomingFilters): IncomingRegisterRow[] {
  const { startMs, endMs } = receivedRangeBounds(filters)
  const needle = filters.q?.trim().toLowerCase() ?? ''
  return rows.filter(row => {
    const received = Date.parse(row.receivedAt)
    if (startMs !== null && received < startMs) return false
    if (endMs !== null && received >= endMs) return false
    if (!needle) return true
    return [row.minopUserId, row.eventId, row.deviceId, row.deviceIp, row.deviceName]
      .some(field => field !== null && field.toLowerCase().includes(needle))
  })
}

/** Newest received first; within one message, punches in the order sent. */
export function sortIncomingRows(rows: IncomingRegisterRow[]): IncomingRegisterRow[] {
  return [...rows].sort((a, b) => {
    const byTime = Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
    if (byTime !== 0) return byTime
    if (a.deliveryId !== b.deliveryId) return a.deliveryId < b.deliveryId ? -1 : 1
    return (a.entryNumber ?? 0) - (b.entryNumber ?? 0)
  })
}
