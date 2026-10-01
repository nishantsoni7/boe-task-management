// CSV and raw-payload exports for the "Incoming Minop data" register.
//
// The CSV is built for Excel:
//   - UTF-8 with a byte-order mark and CRLF line ends, so Excel reads it as UTF-8.
//   - IDs and timestamps that are plain digits / date-time characters are written
//     as ="…" so Excel keeps leading zeros and the full seconds. That wrapper is
//     only ever applied to a string that matched ^[0-9][0-9:.TZ+ -]*$ (no letters
//     other than T and Z, and nothing that starts with = + - @), so it cannot
//     carry a formula.
//   - Every other cell that starts with = + - @ tab or CR is prefixed with an
//     apostrophe, so a value an outside system sent cannot run as a formula.
// The punch entry as received is included as JSON, so every original field
// survives the export even when it has no column of its own.

import { DUPLICATE_FLAG_LABEL, redactRawBody, type IncomingRegisterRow, type MinopDeliveryRow } from './incomingRegister'

const SAFE_NUMERIC_TEXT = /^[0-9][0-9:.TZ+ -]*$/
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: string | null | undefined, preserveText = false): string {
  if (value === null || value === undefined || value === '') return ''
  let text = String(value)
  if (preserveText && SAFE_NUMERIC_TEXT.test(text)) {
    return `"=""${text}"""`
  }
  if (FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const IST = 'Asia/Kolkata'

/** Local IST time with seconds, e.g. 2026-09-30 17:40:39. */
export function formatIst(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

type Column = { header: string; value: (row: IncomingRegisterRow) => string | null; text?: boolean }

export const INCOMING_CSV_COLUMNS: Column[] = [
  { header: 'Row reference', value: r => r.rowId },
  { header: 'Message reference', value: r => r.deliveryId },
  { header: 'Punch number in message', value: r => (r.entryNumber === null ? null : String(r.entryNumber)), text: true },
  { header: 'Punches in message', value: r => String(r.entryCount), text: true },
  { header: 'Received (UTC, as stored)', value: r => r.receivedAt, text: true },
  { header: 'Received (IST)', value: r => formatIst(r.receivedAt), text: true },
  { header: 'Message format', value: r => r.format === 'device_trans' ? 'device callback (trans)' : r.format === 'realtime_punchlog' ? 'real-time (RealTime.PunchLog)' : null },
  { header: 'Punch ID (punchId)', value: r => r.minopUserId, text: true },
  { header: 'Transaction ID (txnId)', value: r => r.eventId, text: true },
  { header: 'Punch time (as sent)', value: r => r.punchTimeRaw, text: true },
  { header: 'Punch time zone sent', value: r => (r.punchTimeRaw === null ? null : r.punchTimeHasZone ? 'yes' : 'no') },
  { header: 'Punch time (IST, only when a zone was sent)', value: r => formatIst(r.punchTimeInstant), text: true },
  { header: 'Mode (raw)', value: r => r.punchTypeRaw, text: true },
  { header: 'Mode field name', value: r => r.punchTypeSource },
  { header: 'Device ID (dvcId)', value: r => r.deviceId, text: true },
  { header: 'Device IP', value: r => r.deviceIp, text: true },
  { header: 'Device name', value: r => r.deviceName },
  { header: 'Name supplied in message', value: r => r.nameSupplied },
  { header: 'Data reading', value: r => r.readStatus },
  { header: 'Data reading reason', value: r => r.readReason },
  { header: 'Duplicate flags', value: r => r.duplicateFlags.map(f => DUPLICATE_FLAG_LABEL[f]).join('; ') || null },
  { header: 'Message SHA-256', value: r => r.bodySha256 },
  { header: 'Auth method', value: r => r.authMethod },
  { header: 'Punch as received (JSON)', value: r => (r.entryJson === null ? null : JSON.stringify(r.entryJson)) },
]

export function buildIncomingCsv(rows: IncomingRegisterRow[]): string {
  const lines = [INCOMING_CSV_COLUMNS.map(c => csvCell(c.header)).join(',')]
  for (const row of rows) {
    lines.push(INCOMING_CSV_COLUMNS.map(c => csvCell(c.value(row), c.text)).join(','))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/**
 * Raw payload export: each message once, with the exact received body (only
 * credential values blanked) and the delivery metadata. Carries every original
 * field regardless of what the CSV columns cover.
 */
export function buildRawPayloadExport(rows: IncomingRegisterRow[], deliveries: MinopDeliveryRow[]): string {
  const wanted = new Set(rows.map(r => r.deliveryId))
  const messages = deliveries
    .filter(d => wanted.has(d.id))
    .map(d => ({
      message_reference: d.id,
      received_at_utc: d.received_at,
      body_sha256: d.body_sha256,
      auth_method: d.auth_method,
      service_tag_id: d.service_tag_id,
      content_type: d.content_type,
      user_agent: d.user_agent,
      stored_status: d.processing_status,
      stored_error: d.error_text,
      raw_body: redactRawBody(d.raw_body),
    }))
  return JSON.stringify({ note: 'Credential values are removed. raw_body is otherwise exactly as received.', messages }, null, 2)
}
