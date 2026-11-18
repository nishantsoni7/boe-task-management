// A version 2 is dated the day it was sent, not the first send, so "valid until" is not already past (review, 18 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { issuedAt, type VersionRow } from './versions'
import { validUntil } from './math'

const v = (version_no: number, created_at: string): VersionRow => ({ version_no, note: null, value_before_gst: 0, created_at, by: null })

describe('issuedAt', () => {
  test('the newest sent version dates it, whatever order the rows come in', () => {
    assert.equal(issuedAt([v(2, '2026-11-15T10:00:00Z'), v(1, '2026-11-01T10:00:00Z')], '2026-11-01T09:00:00Z', '2026-10-30T00:00:00Z'), '2026-11-15T10:00:00Z')
    assert.equal(issuedAt([v(1, '2026-11-01T10:00:00Z'), v(3, '2026-11-17T10:00:00Z'), v(2, '2026-11-10T10:00:00Z')], null, 'x'), '2026-11-17T10:00:00Z')
  })
  test('no versions (or the read failed): the first send, else the day it was made', () => {
    assert.equal(issuedAt([], '2026-11-01T09:00:00Z', '2026-10-30T00:00:00Z'), '2026-11-01T09:00:00Z')
    assert.equal(issuedAt(undefined, null, '2026-10-30T00:00:00Z'), '2026-10-30T00:00:00Z')
  })
  test('so v2 sent on 15 Nov with 7 days holds until 22 Nov, not 8 Nov', () => {
    assert.equal(validUntil(issuedAt([v(2, '2026-11-15T10:00:00Z'), v(1, '2026-11-01T10:00:00Z')], '2026-11-01T09:00:00Z', 'x').slice(0, 10), 7), '2026-11-22')
  })
})

describe('the screens use it', () => {
  test('the builder and the print page date the quotation with issuedAt; the print waits for the versions', () => {
    const builder = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    const print = readFileSync('src/components/quotations/DocumentScreens.tsx', 'utf8')
    assert.match(builder, /const issued = istDateOf\(issuedAt\(versionsQ\.data, base\.sent_at, base\.created_at\)\)/)
    assert.match(print, /issued_at: issuedAt\(vq\.data, x\.sent_at, x\.created_at\)/)
    // Waits for the versions (and, since 18 Nov 2026, for the logo-mark switch) before drawing.
    assert.match(print, /\(!!q\.data && \(vq\.isLoading \|\| mq\.isLoading\)\)\) return <LoadingScreen \/>/)
  })
})
