/**
 * The incoming-data register: payload expansion, duplicate flags, filters,
 * redaction and the Excel-safe CSV, all against local fixtures.
 *
 * Run:
 *   npx tsx --test src/lib/minop/incomingRegister.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIncomingRows, filterIncomingRows, sortIncomingRows, redactRawBody, redactSecrets,
  type MinopDeliveryRow,
} from './incomingRegister'
import { buildIncomingCsv, buildRawPayloadExport, csvCell, formatIst, INCOMING_CSV_COLUMNS } from './incomingCsv'

function delivery(id: string, receivedAt: string, body: unknown, over: Partial<MinopDeliveryRow> = {}): MinopDeliveryRow {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  let payload: unknown = null
  try { payload = JSON.parse(raw) } catch { /* invalid JSON stays null */ }
  return {
    id, received_at: receivedAt, service_tag_id: null, content_type: 'application/json', user_agent: null,
    auth_method: 'url-path-token',
    processing_status: payload === null ? 'quarantined_invalid_json' : 'received',
    error_text: payload === null ? 'Webhook body is not valid JSON' : null,
    body_sha256: `sha-${raw}`, payload, raw_body: raw, ...over,
  }
}

const txn = (over: Record<string, unknown> = {}) => ({
  txnId: '33', dvcId: '1', dvcIP: '127.0.0.2', punchId: '0012', txnDateTime: '2026-09-29 17:20:12', mode: '8', ...over,
})

describe('expanding stored messages', () => {
  test('a device callback becomes one row with IDs kept as strings', () => {
    const [row] = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39.690726+00:00', { trans: [txn()] })])
    assert.equal(row.minopUserId, '0012')
    assert.equal(row.eventId, '33')
    assert.equal(row.deviceId, '1')
    assert.equal(row.deviceIp, '127.0.0.2')
    assert.equal(row.punchTypeRaw, '8')
    assert.equal(row.punchTypeSource, 'mode')
    assert.equal(row.readStatus, 'readable')
    assert.equal(row.readReason, null)
  })

  test('received time and punch time stay separate; a zone-less punch time is not converted', () => {
    const [row] = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn()] })])
    assert.equal(row.receivedAt, '2026-09-30T12:10:39+00:00')
    assert.equal(row.punchTimeRaw, '2026-09-29 17:20:12')
    assert.equal(row.punchTimeHasZone, false)
    assert.equal(row.punchTimeInstant, null)
  })

  test('a punch time that carries a zone is an exact instant', () => {
    const rows = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', {
      RealTime: { OperationID: 77, PunchLog: { UserId: '0014', LogTime: '2026-09-30T04:15:00Z', Type: 'CheckIn' } },
    })])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].minopUserId, '0014')
    assert.equal(rows[0].eventId, '77')
    assert.equal(rows[0].punchTypeRaw, 'CheckIn')
    assert.equal(rows[0].punchTypeSource, 'Type')
    assert.equal(rows[0].punchTimeInstant, '2026-09-30T04:15:00.000Z')
    assert.equal(formatIst(rows[0].punchTimeInstant), '2026-09-30 09:45:00')
  })

  test('absent fields stay null — nothing is invented and IN/OUT is never inferred', () => {
    const [row] = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [{ punchId: '5', txnDateTime: '2026-09-29 17:20:12' }] })])
    assert.equal(row.eventId, null)
    assert.equal(row.deviceId, null)
    assert.equal(row.deviceName, null)
    assert.equal(row.nameSupplied, null)
    assert.equal(row.punchTypeRaw, null)
    assert.equal(row.punchTypeSource, null)
    assert.equal(row.readStatus, 'readable')
  })

  test('a name is shown only when the payload carries one', () => {
    const [row] = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn({ name: 'Asha Rao' })] })])
    assert.equal(row.nameSupplied, 'Asha Rao')
  })

  test('a batch shows every punch, each with its parent message', () => {
    const rows = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', {
      trans: [txn({ txnId: '1' }), txn({ txnId: '2', punchId: '0013' }), txn({ txnId: '3' })],
    })])
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map(r => r.eventId), ['1', '2', '3'])
    assert.ok(rows.every(r => r.deliveryId === 'd1' && r.entryCount === 3))
    assert.deepEqual(rows.map(r => r.entryNumber), [1, 2, 3])
    assert.equal(new Set(rows.map(r => r.rowId)).size, 3)
  })

  test('a punch missing its user ID or time is partly read, with the exact reason', () => {
    const rows = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', {
      trans: [{ txnId: '9', dvcId: '1' }, txn({ punchId: undefined })],
    })])
    assert.deepEqual(rows.map(r => r.readStatus), ['partial', 'partial'])
    assert.equal(rows[0].readReason, 'Not present in this punch: punchId, txnDateTime')
    assert.equal(rows[1].readReason, 'Not present in this punch: punchId')
  })

  test('invalid JSON stays visible, with the stored reason and the raw text available', () => {
    const [row] = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', '{"trans": [')])
    assert.equal(row.readStatus, 'unreadable')
    assert.match(row.readReason ?? '', /not valid JSON/)
    assert.equal(row.minopUserId, null)
  })

  test('well-formed JSON of the wrong shape is unreadable, naming what it did contain', () => {
    const rows = buildIncomingRows([
      delivery('d1', '2026-09-30T12:10:39+00:00', { hello: 1, world: 2 }),
      delivery('d2', '2026-09-30T12:10:40+00:00', { trans: [] }),
      delivery('d3', '2026-09-30T12:10:41+00:00', { trans: 'x' }),
      delivery('d4', '2026-09-30T12:10:42+00:00', [1, 2]),
    ])
    assert.deepEqual(rows.map(r => r.readStatus), ['unreadable', 'no_punches', 'unreadable', 'unreadable'])
    assert.match(rows[0].readReason ?? '', /Top-level fields: hello, world/)
    assert.match(rows[1].readReason ?? '', /empty "trans" list/)
    assert.match(rows[2].readReason ?? '', /not a list/)
    assert.match(rows[3].readReason ?? '', /JSON list/)
  })

  test('one non-object entry inside a batch does not hide the others', () => {
    const rows = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn(), 'oops', txn({ txnId: '3' })] })])
    assert.deepEqual(rows.map(r => r.readStatus), ['readable', 'unreadable', 'readable'])
    assert.match(rows[1].readReason ?? '', /Entry 2/)
    assert.equal(new Set(rows.map(r => r.rowId)).size, 3)
  })
})

describe('a message with no punches is distinguishable from real punches', () => {
  test('the synthetic self-test is labelled as such, apart from an empty list and from real punches', () => {
    const rows = buildIncomingRows([
      delivery('self', '2026-09-19T14:10:42+00:00', { boeSyntheticSelfTest: true, note: 'x', trans: [] }),
      delivery('empty', '2026-09-19T14:11:42+00:00', { trans: [] }),
      delivery('real', '2026-09-19T14:12:42+00:00', { trans: [txn()] }),
    ])
    const by = Object.fromEntries(rows.map(r => [r.deliveryId, r]))
    assert.equal(by.self.readStatus, 'no_punches')
    assert.match(by.self.readReason ?? '', /boeSyntheticSelfTest/)
    assert.equal(by.empty.readStatus, 'no_punches')
    assert.doesNotMatch(by.empty.readReason ?? '', /boeSyntheticSelfTest/)
    assert.equal(by.real.readStatus, 'readable')
    for (const r of [by.self, by.empty]) {
      assert.equal(r.minopUserId, null)
      assert.equal(r.entryNumber, null)
      assert.equal(r.entryJson, null)
    }
  })
})

describe('duplicates', () => {
  test('the same body delivered twice is flagged on both rows; a different body is not', () => {
    const a = delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn()] }, { body_sha256: 'same' })
    const b = delivery('d2', '2026-09-30T12:11:39+00:00', { trans: [txn()] }, { body_sha256: 'same' })
    const c = delivery('d3', '2026-09-30T12:12:39+00:00', { trans: [txn({ txnId: '34' })] }, { body_sha256: 'other' })
    const rows = buildIncomingRows([a, b, c])
    assert.ok(rows[0].duplicateFlags.includes('same_body_received_again'))
    assert.ok(rows[1].duplicateFlags.includes('same_body_received_again'))
    assert.deepEqual(rows[2].duplicateFlags, [])
  })

  test('a batch with identical punches inside ONE message is not a duplicate delivery', () => {
    const rows = buildIncomingRows([delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn({ txnId: '1' }), txn({ txnId: '2' })] })])
    assert.ok(rows.every(r => !r.duplicateFlags.includes('same_body_received_again')))
  })

  test('the same device and event ID in two messages is flagged; a different device is not', () => {
    const rows = buildIncomingRows([
      delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn()] }),
      delivery('d2', '2026-09-30T12:11:39+00:00', { trans: [txn({ punchId: '9' })] }),
      delivery('d3', '2026-09-30T12:12:39+00:00', { trans: [txn({ dvcId: '2' })] }),
    ])
    assert.ok(rows[0].duplicateFlags.includes('same_device_event_id_seen_again'))
    assert.ok(rows[1].duplicateFlags.includes('same_device_event_id_seen_again'))
    assert.deepEqual(rows[2].duplicateFlags, [])
  })
})

describe('filters, search and order', () => {
  const rows = buildIncomingRows([
    delivery('d1', '2026-09-28T20:00:00+00:00', { trans: [txn({ txnId: '1', punchId: '0012' })] }),       // 29 Sep 01:30 IST
    delivery('d2', '2026-09-29T10:00:00+00:00', { trans: [txn({ txnId: '2', punchId: '7', dvcId: 'D-9' })] }),
    delivery('d3', '2026-09-30T10:00:00+00:00', '{broken'),
  ])

  test('search matches user ID, event ID and device, case-insensitively', () => {
    assert.deepEqual(filterIncomingRows(rows, { q: '0012' }).map(r => r.deliveryId), ['d1'])
    assert.deepEqual(filterIncomingRows(rows, { q: '127.0.0.2' }).map(r => r.deliveryId).sort(), ['d1', 'd2'])
    assert.deepEqual(filterIncomingRows(rows, { q: 'd-9' }).map(r => r.deliveryId), ['d2'])
    assert.deepEqual(filterIncomingRows(rows, { q: 'nope' }), [])
  })

  test('the received-date range is inclusive and read in Asia/Kolkata', () => {
    assert.deepEqual(filterIncomingRows(rows, { from: '2026-09-29', to: '2026-09-29' }).map(r => r.deliveryId).sort(), ['d1', 'd2'])
    assert.deepEqual(filterIncomingRows(rows, { from: '2026-09-30' }).map(r => r.deliveryId), ['d3'])
    assert.deepEqual(filterIncomingRows(rows, { to: '2026-09-28' }), [])
  })

  test('unreadable messages are not hidden by an empty filter, and are newest-first', () => {
    const sorted = sortIncomingRows(filterIncomingRows(rows, {}))
    assert.deepEqual(sorted.map(r => r.deliveryId), ['d3', 'd2', 'd1'])
  })
})

describe('credentials never reach the display or the export', () => {
  const secretBody = '{"RealTime":{"AuthToken":"s3cr3t-value","PunchLog":{"UserId":"1"}},"trans":[{"punchId":"1","token":"abc"}]}'

  test('redactRawBody blanks credential values and leaves everything else byte-for-byte', () => {
    const out = redactRawBody(secretBody)
    assert.ok(!out.includes('s3cr3t-value'))
    assert.ok(!out.includes('"abc"'))
    assert.match(out, /"AuthToken":"\[removed\]"/)
    assert.match(out, /"UserId":"1"/)
  })

  test('redactSecrets removes them at any depth', () => {
    const out = JSON.stringify(redactSecrets({ a: { AuthToken: 'x', b: [{ password: 'y', ok: 1 }] } }))
    assert.ok(!out.includes('"x"') && !out.includes('"y"'))
    assert.match(out, /"ok":1/)
  })

  test('the CSV and raw export carry no credential', () => {
    const d = delivery('d1', '2026-09-30T12:10:39+00:00', JSON.parse(secretBody), { body_sha256: 'a'.repeat(64) })
    const rows = buildIncomingRows([d])
    const text = buildIncomingCsv(rows) + buildRawPayloadExport(rows, [d])
    assert.ok(!text.includes('s3cr3t-value'))
  })
})

describe('CSV', () => {
  test('a leading-zero ID and the full timestamp are written as text, not numbers', () => {
    assert.equal(csvCell('0012', true), '"=""0012"""')
    assert.equal(csvCell('2026-09-29 17:20:12', true), '"=""2026-09-29 17:20:12"""')
  })

  test('a value that could run as a formula is neutralised', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '=HYPERLINK("http://x")']) {
      assert.equal(csvCell(value, true).replace(/^"/, '').startsWith("'"), true, value)
      assert.equal(csvCell(value).replace(/^"/, '').startsWith("'"), true, value)
    }
  })

  test('the text wrapper is only ever applied to digit-and-time characters', () => {
    // Would be a formula if wrapped: it must be neutralised instead.
    assert.equal(csvCell('0012+cmd|calc', true), '0012+cmd|calc')
    assert.equal(csvCell('=0012', true), "'=0012")
  })

  test('quotes, commas and line breaks are escaped; the file opens as UTF-8 in Excel', () => {
    assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"')
    const csv = buildIncomingCsv([])
    assert.ok(csv.startsWith('﻿'))
    assert.ok(csv.endsWith('\r\n'))
  })

  test('every row carries the same number of cells as the header, one row per punch', () => {
    const rows = buildIncomingRows([
      delivery('d1', '2026-09-30T12:10:39+00:00', { trans: [txn({ name: 'A, "B"' }), txn({ txnId: '2' })] }),
      delivery('d2', '2026-09-30T12:11:39+00:00', '{broken'),
    ])
    const csv = buildIncomingCsv(rows).replace('﻿', '')
    // Count cells with a small quote-aware split.
    const records: string[][] = []
    let cur: string[] = []; let cell = ''; let quoted = false
    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i]
      if (quoted) {
        if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
        else cell += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') { cur.push(cell); cell = '' }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { cur.push(cell); records.push(cur); cur = []; cell = '' }
      else cell += ch
    }
    assert.equal(records.length, 4)
    assert.ok(records.every(r => r.length === INCOMING_CSV_COLUMNS.length))
    assert.equal(records[1][INCOMING_CSV_COLUMNS.findIndex(c => c.header === 'Punch ID (punchId)')], '="0012"')
    assert.deepEqual(['Punch ID (punchId)', 'Transaction ID (txnId)', 'Device ID (dvcId)', 'Mode (raw)'].filter(h => !INCOMING_CSV_COLUMNS.some(c => c.header === h)), [])
    assert.match(records[1][INCOMING_CSV_COLUMNS.length - 1], /"name":"A, \\"B\\""/)
    assert.equal(records[3][INCOMING_CSV_COLUMNS.findIndex(c => c.header === 'Data reading')], 'unreadable')
  })

  test('IST display includes seconds', () => {
    assert.equal(formatIst('2026-09-30T12:10:39.690726+00:00'), '2026-09-30 17:40:39')
  })
})
