import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { SEO_MAX_ROWS_PER_TABLE, SeoIngestError, parseSeoIngest } from './ingest'

const NOW = '2026-11-01T00:00:00.000Z'
const metric = { metric_date: '2026-10-26', metric: 'keyword.position', scope: 'hotel chairs', value: 18.6, source: 'search_console' }
const refuses = (body: unknown, message: RegExp) =>
  assert.throws(() => parseSeoIngest(body, NOW), (e: Error) => e instanceof SeoIngestError && message.test(e.message))

describe('what the door accepts', () => {
  test('a good delivery names its table, its key, and stamps the time', () => {
    const [batch] = parseSeoIngest({ metrics: [metric] }, NOW)
    assert.equal(batch.table, 'seo_metrics')
    assert.equal(batch.onConflict, 'metric_date,metric,scope')
    assert.deepEqual(batch.rows, [{ ...metric, detail: null, updated_at: NOW }])
  })

  test('a site-wide number has an empty scope, so its key still works', () => {
    const [batch] = parseSeoIngest({ metrics: [{ ...metric, scope: undefined }] }, NOW)
    assert.equal(batch.rows[0].scope, '')
  })

  test('sending the same row twice keeps the last, because one upsert cannot touch a row twice', () => {
    const [batch] = parseSeoIngest({ metrics: [metric, { ...metric, value: 9 }] }, NOW)
    assert.equal(batch.rows.length, 1)
    assert.equal(batch.rows[0].value, 9)
  })

  test('columns nobody named never reach the database', () => {
    const [batch] = parseSeoIngest({ metrics: [{ ...metric, updated_at: '1999-01-01', injected: 'x' }] }, NOW)
    assert.equal(batch.rows[0].updated_at, NOW)
    assert.equal('injected' in batch.rows[0], false)
  })

  test('every table can be sent', () => {
    const batches = parseSeoIngest({
      metrics: [metric],
      watchlist: [{ kind: 'competitor', entry_key: 'a.com', label: 'a.com' }],
      plan_items: [{ id: 'n1', window_key: 'd30', title: 'T', status: 'started', due_date: '2026-11-08' }],
      reviews: [{ review_date: '2026-11-02', verdict: 'none' }],
      log: [{ id: 'w1', kind: 'work', log_date: '2026-10-15', title: 'T' }],
      runs: [{ feed: 'city_check', run_date: '2026-11-01', status: 'blocked' }],
    }, NOW)
    assert.deepEqual(batches.map(b => b.table), ['seo_metrics', 'seo_watchlist', 'seo_plan_items', 'seo_reviews', 'seo_log', 'seo_feed_runs'])
  })
})

describe('what the door refuses, before anything is written', () => {
  test('anything but an object', () => {
    for (const body of [null, [], 'x', 1]) refuses(body, /must be an object/)
  })
  test('an empty delivery', () => refuses({}, /nothing in it/))
  test('a section it does not know', () => refuses({ users: [] }, /not something this door accepts/))
  test('a section that is not a list', () => refuses({ metrics: {} }, /must be a list/))
  test('too many rows', () => refuses({ metrics: Array(SEO_MAX_ROWS_PER_TABLE + 1).fill(metric) }, /too many rows/))
  test('a row that is not an object', () => refuses({ metrics: ['x'] }, /metrics\[0\]: must be an object/))
  test('a date that is not a real day', () => {
    refuses({ metrics: [{ ...metric, metric_date: '26 Oct' }] }, /metric_date must be a date/)
    refuses({ metrics: [{ ...metric, metric_date: '2026-02-31' }] }, /metric_date must be a date/)
  })
  test('a value that is not a number', () => {
    refuses({ metrics: [{ ...metric, value: '18' }] }, /value must be a number/)
    refuses({ metrics: [{ ...metric, value: Number.NaN }] }, /value must be a number/)
  })
  test('a status the board does not have', () => {
    refuses({ plan_items: [{ id: 'n1', window_key: 'd30', title: 'T', status: 'finished' }] }, /status must be one of/)
  })
  test('a missing required field', () => refuses({ log: [{ id: 'w1', kind: 'work', log_date: '2026-10-15' }] }, /title is required/))
  test('a required field left empty', () => refuses({ log: [{ id: '', kind: 'work', log_date: '2026-10-15', title: 'T' }] }, /id is required/))
  test('text that is too long', () => refuses({ log: [{ id: 'x'.repeat(201), kind: 'work', log_date: '2026-10-15', title: 'T' }] }, /id is too long/))
  test('a broken row later in the list refuses the whole delivery', () => {
    refuses({ metrics: [metric, { ...metric, source: undefined }] }, /metrics\[1\]: source is required/)
  })
})
