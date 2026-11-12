import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { periodRange, toCsv } from './report'

describe('report periods (India dates)', () => {
  test('week Monday to Sunday, month, financial-year quarter and year', () => {
    assert.deepEqual(periodRange('week', '2026-11-12'), { from: '2026-11-09', to: '2026-11-15' }) // a Thursday
    assert.deepEqual(periodRange('week', '2026-11-15'), { from: '2026-11-09', to: '2026-11-15' }) // a Sunday
    assert.deepEqual(periodRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' })
    assert.deepEqual(periodRange('quarter', '2026-11-12'), { from: '2026-10-01', to: '2026-12-31' })
    assert.deepEqual(periodRange('quarter', '2027-02-01'), { from: '2027-01-01', to: '2027-03-31' })
    assert.deepEqual(periodRange('year', '2026-11-12'), { from: '2026-04-01', to: '2027-03-31' })
    assert.deepEqual(periodRange('year', '2027-02-01'), { from: '2026-04-01', to: '2027-03-31' })
  })
})

describe('CSV download', () => {
  test('BOM, CRLF, escaping and the formula guard', () => {
    const csv = toCsv(['Name', 'Value'], [['Hotel, Goa', 100], ['=HYPERLINK("x")', null]])
    assert.ok(csv.startsWith('﻿Name,Value\r\n'))
    assert.match(csv, /"Hotel, Goa",100\r\n/)
    assert.match(csv, /"'=HYPERLINK\(""x""\)",\r\n$/)
  })
})

describe('the report function', () => {
  test('is read-only, closed to anon, and gives salespeople only their own', () => {
    const sql = readFileSync('supabase/migrations/20270618000000_quotation_reports.sql', 'utf8')
    assert.doesNotMatch(sql, /\b(insert|update|delete)\s+(into|from)?\s*public\./i)
    assert.match(sql, /v_all := p_scope = 'all' and \(a\.p_admin or a\.p_view_all\)/)
    assert.match(sql, /revoke all on function public\.quotation_report\(date, date, text\) from public, anon/)
  })
})
