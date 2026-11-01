// What the scheduled sessions may send to /api/integrations/seo/ingest. The secret proves who is sending; this
// decides what is allowed in. Anything unexpected refuses the whole delivery, so a wrong file changes nothing, and
// nothing reaches the database except the columns named here.

export const SEO_MAX_INGEST_BYTES = 2_000_000
export const SEO_MAX_ROWS_PER_TABLE = 5_000

export class SeoIngestError extends Error {}

type Raw = Record<string, unknown>
type Row = Record<string, unknown>

function fail(where: string, what: string): never {
  throw new SeoIngestError(`${where}: ${what}`)
}

function text(row: Raw, field: string, where: string, max: number, fallback?: string | null): string | null {
  const value = row[field]
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(where, `${field} is required`)
    return fallback
  }
  if (typeof value !== 'string') fail(where, `${field} must be text`)
  if (value.length > max) fail(where, `${field} is too long`)
  if (fallback === undefined && !value.length) fail(where, `${field} is required`)
  return value
}

function oneOf(row: Raw, field: string, where: string, allowed: readonly string[]): string {
  const value = row[field]
  if (typeof value !== 'string' || !allowed.includes(value)) fail(where, `${field} must be one of ${allowed.join(', ')}`)
  return value
}

function date(row: Raw, field: string, where: string, optional = false): string | null {
  const value = row[field]
  if (optional && (value === undefined || value === null)) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(where, `${field} must be a date`)
  // Date rolls 2026-02-31 over to March instead of refusing it, so compare the round trip.
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(where, `${field} must be a date`)
  return value
}

function number(row: Raw, field: string, where: string): number | null {
  const value = row[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, `${field} must be a number`)
  return value
}

function count(row: Raw, field: string, where: string): number | null {
  const value = number(row, field, where)
  if (value !== null && (!Number.isInteger(value) || value < 0)) fail(where, `${field} must be a whole number`)
  return value
}

function json(row: Raw, field: string, where: string): Raw | null {
  const value = row[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) fail(where, `${field} must be an object`)
  return value as Raw
}

const TABLES = {
  metrics: {
    table: 'seo_metrics',
    onConflict: 'metric_date,metric,scope',
    row: (r: Raw, w: string): Row => ({
      metric_date: date(r, 'metric_date', w),
      metric: text(r, 'metric', w, 80),
      scope: text(r, 'scope', w, 300, ''),
      value: number(r, 'value', w),
      detail: json(r, 'detail', w),
      source: text(r, 'source', w, 80),
    }),
  },
  watchlist: {
    table: 'seo_watchlist',
    onConflict: 'kind,entry_key',
    row: (r: Raw, w: string): Row => ({
      kind: oneOf(r, 'kind', w, ['keyword', 'competitor']),
      entry_key: text(r, 'entry_key', w, 300),
      label: text(r, 'label', w, 300),
      note: text(r, 'note', w, 1000, null),
      active: r.active !== false,
    }),
  },
  plan_items: {
    table: 'seo_plan_items',
    onConflict: 'id',
    row: (r: Raw, w: string): Row => ({
      id: text(r, 'id', w, 40),
      window_key: oneOf(r, 'window_key', w, ['d30', 'd60']),
      title: text(r, 'title', w, 500),
      who: text(r, 'who', w, 200, ''),
      due_date: date(r, 'due_date', w, true),
      status: oneOf(r, 'status', w, ['done', 'started', 'waiting_owner', 'not_started']),
      evidence: text(r, 'evidence', w, 1000, ''),
    }),
  },
  reviews: {
    table: 'seo_reviews',
    onConflict: 'review_date',
    row: (r: Raw, w: string): Row => ({
      review_date: date(r, 'review_date', w),
      verdict: oneOf(r, 'verdict', w, ['on_track', 'watch', 'off_track', 'none']),
      items_due: count(r, 'items_due', w),
      items_done: count(r, 'items_done', w),
      numbers_on_target: count(r, 'numbers_on_target', w),
      summary: text(r, 'summary', w, 4000, ''),
      detail: json(r, 'detail', w),
    }),
  },
  log: {
    table: 'seo_log',
    onConflict: 'id',
    row: (r: Raw, w: string): Row => ({
      id: text(r, 'id', w, 200),
      kind: oneOf(r, 'kind', w, ['work', 'finding', 'decision', 'proposal']),
      log_date: date(r, 'log_date', w),
      title: text(r, 'title', w, 1000),
      body: text(r, 'body', w, 4000, ''),
      before_value: text(r, 'before_value', w, 500, null),
      after_value: text(r, 'after_value', w, 500, null),
      source: text(r, 'source', w, 200, ''),
    }),
  },
  runs: {
    table: 'seo_feed_runs',
    onConflict: 'feed,run_date',
    row: (r: Raw, w: string): Row => ({
      feed: oneOf(r, 'feed', w, ['daily_numbers', 'city_check', 'ahrefs_research', 'monday_review']),
      run_date: date(r, 'run_date', w),
      status: oneOf(r, 'status', w, ['ok', 'partial', 'blocked', 'logged_out', 'failed']),
      message: text(r, 'message', w, 500, ''),
      row_count: count(r, 'row_count', w) ?? 0,
    }),
  },
} as const

export type SeoIngestBatch = { table: string; onConflict: string; rows: Row[] }

/** Check a whole delivery before anything is written. Throws SeoIngestError with the first thing wrong. */
export function parseSeoIngest(body: unknown, updatedAt: string): SeoIngestBatch[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('body', 'must be an object')
  const known = Object.keys(TABLES)
  const keys = Object.keys(body)
  const unknown = keys.find(key => !known.includes(key))
  if (unknown) fail(unknown, 'is not something this door accepts')
  if (!keys.length) fail('body', 'has nothing in it')

  return keys.map(key => {
    const spec = TABLES[key as keyof typeof TABLES]
    const rows = (body as Raw)[key]
    if (!Array.isArray(rows)) fail(key, 'must be a list')
    if (rows.length > SEO_MAX_ROWS_PER_TABLE) fail(key, 'has too many rows')
    // Postgres refuses one upsert that touches a row twice, so the last of any repeat wins.
    const unique = new Map<string, Row>()
    rows.forEach((raw, index) => {
      const where = `${key}[${index}]`
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(where, 'must be an object')
      const row = spec.row(raw as Raw, where)
      unique.set(spec.onConflict.split(',').map(column => String(row[column])).join('\u0000'), { ...row, updated_at: updatedAt })
    })
    return { table: spec.table, onConflict: spec.onConflict, rows: [...unique.values()] }
  })
}
