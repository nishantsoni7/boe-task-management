/**
 * The retention rule.
 *
 * Pure arithmetic, so this runs with no database, no bucket and no clock of its
 * own — every case pins `now` explicitly, because a test that reads the real
 * clock is a test that fails at midnight.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/retention.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RETENTION_DAYS, RETENTION_INTERVAL_SQL, HISTORY_BUCKET,
  historyObjectPath, isExpired, isVisible, daysRemaining, retentionLabel,
  visibleFilter,
} from './retention'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-30T12:00:00.000Z')

/** A row that expires `days` from NOW. */
function at(days: number, kept = false) {
  return { kept, expiresAt: new Date(NOW + days * DAY).toISOString() }
}

describe('the window is seven days, and says so everywhere', () => {
  test('the constant is seven', () => {
    assert.equal(RETENTION_DAYS, 7)
  })

  test('the SQL interval is built from the same constant', () => {
    assert.equal(RETENTION_INTERVAL_SQL, '7 days')
  })

  // The constant here is a LABEL; the database default is what actually decides
  // when a result dies. If those two ever disagree the screen lies about how
  // long somebody has, so the migration is read and checked against it.
  test('the migration defaults expires_at to the same seven days', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261021000000_image_editor_result_history.sql'),
      'utf8',
    )
    assert.ok(
      sql.includes(`interval '${RETENTION_INTERVAL_SQL}'`),
      'the migration default and RETENTION_DAYS must move together',
    )
  })
})

describe('expiry', () => {
  test('a fresh result is visible', () => {
    assert.equal(isExpired(at(7), NOW), false)
    assert.equal(isVisible(at(7), NOW), true)
  })

  test('a result one second past its window is expired', () => {
    const row = { kept: false, expiresAt: new Date(NOW - 1000).toISOString() }
    assert.equal(isExpired(row, NOW), true)
    assert.equal(isVisible(row, NOW), false)
  })

  test('the boundary itself counts as expired', () => {
    const row = { kept: false, expiresAt: new Date(NOW).toISOString() }
    assert.equal(isExpired(row, NOW), true)
  })

  test('a KEPT result is never expired, however old', () => {
    assert.equal(isExpired(at(-900, true), NOW), false)
    assert.equal(isVisible(at(-900, true), NOW), true)
  })

  // The true answer to isExpired causes a deletion, so the uncertain answer has
  // to be the one that keeps the picture.
  test('an unreadable timestamp is treated as NOT expired', () => {
    assert.equal(isExpired({ kept: false, expiresAt: 'not a date' }, NOW), false)
  })
})

describe('unkeeping restores the original window, it does not grant a new one', () => {
  test('a long-expired result unkept is immediately due', () => {
    const wasKept = at(-30, true)
    assert.equal(isExpired(wasKept, NOW), false)

    // Only `kept` changes; expires_at is untouched, which is the whole point.
    const unkept = { ...wasKept, kept: false }
    assert.equal(isExpired(unkept, NOW), true)
  })
})

describe('the countdown an employee reads', () => {
  test('a kept result has no countdown at all', () => {
    assert.equal(daysRemaining(at(3, true), NOW), null)
    assert.equal(retentionLabel(at(3, true), NOW), 'Kept')
  })

  test('a fresh result reports its full seven days', () => {
    assert.equal(daysRemaining(at(7), NOW), 7)
    assert.equal(retentionLabel(at(7), NOW), 'Expires in 7 days')
  })

  // Rounding UP is what makes this honest: eleven hours left is still "today",
  // and it is certainly not "0 days".
  test('part of a day rounds up', () => {
    assert.equal(daysRemaining(at(0.45), NOW), 1)
    assert.equal(retentionLabel(at(0.45), NOW), 'Expires today')
  })

  test('under two days reads as a day, not as today', () => {
    assert.equal(retentionLabel(at(1.5), NOW), 'Expires in 2 days')
  })

  test('past its window reads as expired, never as a negative countdown', () => {
    assert.equal(daysRemaining(at(-3), NOW), 0)
    assert.equal(retentionLabel(at(-3), NOW), 'Expired')
  })
})

describe('the object key', () => {
  // The storage policies authorize by parsing the FIRST path segment. If this
  // shape changes, every policy in 20261021000000 silently stops matching.
  test('is <user_id>/<result_id>.png', () => {
    assert.equal(
      historyObjectPath('11111111-2222-3333-4444-555555555555', 'aaaa-bbbb'),
      '11111111-2222-3333-4444-555555555555/aaaa-bbbb.png',
    )
  })

  test('puts the owner first, which is what the storage policy reads', () => {
    const path = historyObjectPath('owner-id', 'result-id')
    assert.equal(path.split('/')[0], 'owner-id')
  })

  test('names the private bucket', () => {
    assert.equal(HISTORY_BUCKET, 'image-editor-results')
  })
})

describe('the read filter and the sweep agree', () => {
  test('the visible filter keeps kept rows and unexpired rows', () => {
    const nowIso = new Date(NOW).toISOString()
    assert.equal(visibleFilter(nowIso), `kept.eq.true,expires_at.gt.${nowIso}`)
  })

  // The cleanup route selects kept = false AND expires_at <= now. That is the
  // exact complement of the filter above, so nothing can be both listed and
  // due, and nothing can be neither.
  test('the cleanup route selects precisely the complement', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/api/image-editor/cleanup/route.ts'),
      'utf8',
    )
    assert.ok(source.includes(".eq('kept', false)"), 'kept rows are never swept')
    assert.ok(source.includes(".lte('expires_at', nowIso)"), 'only past-window rows are swept')
  })
})
