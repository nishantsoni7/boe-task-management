// A small in-memory stand-in for the service-role Supabase client, for route
// handler tests that must not touch the linked (production) project.
//
// It implements only what the attendance-request handlers and the payroll
// store functions they call actually use: select / insert / update / upsert /
// delete, the filters eq · neq · in · gte · gt · lte · lt · is · or (with
// and(...) groups), order · limit · range, single · maybeSingle, and a
// returning select after a write. Column lists and embedded relations in
// select() are ignored — whole rows are returned — which is enough for these
// handlers, which only pass embeds through.
//
// Two database rules the tests depend on are emulated because the real
// migrations enforce them and the handlers rely on it:
//   * attendance_day_corrections: at most one is_current row per (user, date)
//     → 23505, like the partial unique index;
//   * attendance_day_reviews: inserting supersedes the current row, like the
//     attendance_day_reviews_supersede trigger.
// Everything else (RLS, other triggers, constraints) is NOT emulated; the SQL
// behaviour is verified separately against a real database.

import { randomUUID } from 'node:crypto'

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean
type PgError = { message: string; code?: string }

const DEFAULTS: Record<string, () => Row> = {
  attendance_day_corrections: () => ({ is_current: true, superseded_at: null, superseded_by: null, corrected_at: new Date().toISOString() }),
  attendance_day_reviews: () => ({ is_current: true, superseded_at: null, excused: false, applied_correction_id: null }),
  attendance_requests: () => {
    const now = new Date().toISOString()
    return {
      status: 'pending', submitted_at: now, original_submitted_at: now, decided_by: null, decided_at: null,
      decision_note: null, cancelled_at: null, cancel_reason: null, replaces_request_id: null,
      expected_arrival_time: null, departure_time: null, return_time: null, half_session: null, work_kind: null,
      reason_note: null, updated_at: now,
    }
  },
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function parseOr(expr: string): Filter {
  const parts = splitTopLevel(expr).map(parseTerm)
  return r => parts.some(p => p(r))
}

function parseTerm(term: string): Filter {
  const t = term.trim()
  if (t.startsWith('and(') && t.endsWith(')')) {
    const parts = splitTopLevel(t.slice(4, -1)).map(parseTerm)
    return r => parts.every(p => p(r))
  }
  if (t.startsWith('or(') && t.endsWith(')')) return parseOr(t.slice(3, -1))
  const [col, op, ...rest] = t.split('.')
  const val = rest.join('.')
  switch (op) {
    case 'eq':  return r => String(r[col]) === val
    case 'neq': return r => String(r[col]) !== val
    case 'is':  return r => (val === 'null' ? r[col] == null : String(r[col]) === val)
    case 'gte': return r => String(r[col]) >= val
    case 'lte': return r => String(r[col]) <= val
    default: throw new Error(`memorySupabase: unsupported or() operator ${op}`)
  }
}

const cmp = (a: unknown, b: unknown) => (a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0)

class Query implements PromiseLike<{ data: unknown; error: PgError | null; count?: number }> {
  private filters: Filter[] = []
  private orders: { col: string; asc: boolean }[] = []
  private lim: number | null = null
  private rng: [number, number] | null = null
  private mode: 'many' | 'single' | 'maybe' = 'many'
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private payload: Row | Row[] | null = null
  private conflict: string[] = []
  private returning = false

  constructor(private db: MemorySupabase, private table: string) {}

  select(_cols?: string, _opts?: unknown) { if (this.op !== 'select') this.returning = true; return this }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this }
  upsert(row: Row | Row[], opts?: { onConflict?: string }) {
    this.op = 'upsert'; this.payload = row; this.conflict = (opts?.onConflict ?? 'id').split(','); return this
  }
  delete() { this.op = 'delete'; return this }

  eq(c: string, v: unknown)  { this.filters.push(r => r[c] === v || (v != null && String(r[c]) === String(v))); return this }
  neq(c: string, v: unknown) { this.filters.push(r => r[c] !== v); return this }
  in(c: string, vs: unknown[]) { this.filters.push(r => vs.includes(r[c])); return this }
  gte(c: string, v: unknown) { this.filters.push(r => cmp(r[c], v) >= 0 && r[c] != null); return this }
  gt(c: string, v: unknown)  { this.filters.push(r => cmp(r[c], v) > 0 && r[c] != null); return this }
  lte(c: string, v: unknown) { this.filters.push(r => r[c] != null && cmp(r[c], v) <= 0); return this }
  lt(c: string, v: unknown)  { this.filters.push(r => r[c] != null && cmp(r[c], v) < 0); return this }
  is(c: string, v: unknown)  { this.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return this }
  or(expr: string) { this.filters.push(parseOr(expr)); return this }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this }
  limit(n: number) { this.lim = n; return this }
  range(a: number, b: number) { this.rng = [a, b]; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybe'; return this }

  then<A = { data: unknown; error: PgError | null }, B = never>(
    ok?: ((v: { data: unknown; error: PgError | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(ok, bad)
  }

  private rows(): Row[] { return (this.db.tables[this.table] ??= []) }
  private match(): Row[] { return this.rows().filter(r => this.filters.every(f => f(r))) }

  private shape(rows: Row[]): { data: unknown; error: PgError | null } {
    let out = rows.map(r => ({ ...r }))
    for (const o of [...this.orders].reverse()) out.sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]))
    if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1)
    if (this.lim != null) out = out.slice(0, this.lim)
    if (this.mode === 'single') {
      return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected 1 row, got ${out.length}`, code: 'PGRST116' } }
    }
    if (this.mode === 'maybe') {
      return out.length <= 1 ? { data: out[0] ?? null, error: null } : { data: null, error: { message: 'multiple rows', code: 'PGRST116' } }
    }
    return { data: out, error: null }
  }

  private run(): { data: unknown; error: PgError | null } {
    this.db.log.push({ table: this.table, op: this.op })
    const hook = this.db.failOn.get(`${this.table}:${this.op}`)
    if (hook) return { data: null, error: { message: hook } }

    if (this.op === 'select') return this.shape(this.match())

    if (this.op === 'delete') {
      const doomed = new Set(this.match())
      this.db.tables[this.table] = this.rows().filter(r => !doomed.has(r))
      return { data: null, error: null }
    }

    if (this.op === 'update') {
      const hit = this.match()
      for (const r of hit) Object.assign(r, this.payload as Row)
      return this.returning ? this.shape(hit) : { data: null, error: null }
    }

    const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload as Row])
    const written: Row[] = []
    for (const src of incoming) {
      const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...(DEFAULTS[this.table]?.() ?? {}), ...src }
      if (this.op === 'upsert') {
        const existing = this.rows().find(r => this.conflict.every(c => r[c] === row[c]))
        if (existing) { const { id: _id, ...rest } = row; void _id; Object.assign(existing, rest); written.push(existing); continue }
      }
      const err = this.db.beforeInsert(this.table, row)
      if (err) return { data: null, error: err }
      this.rows().push(row)
      written.push(row)
    }
    if (!this.returning) return { data: null, error: null }
    return this.shape(written)
  }
}

export class MemorySupabase {
  tables: Record<string, Row[]> = {}
  log: { table: string; op: string }[] = []
  /** `${table}:${op}` → error message, to simulate a failing write. */
  failOn = new Map<string, string>()

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map(r => ({ ...r }))
  }

  from(table: string) { return new Query(this, table) }

  rpc(name: string) {
    return Promise.resolve({ data: null, error: { message: `memorySupabase: rpc ${name} is not available` } })
  }

  rows(table: string): Row[] { return this.tables[table] ?? [] }

  beforeInsert(table: string, row: Row): PgError | null {
    if (table === 'attendance_day_corrections' && row.is_current) {
      const clash = this.rows(table).some(r => r.is_current && r.user_id === row.user_id && r.attendance_date === row.attendance_date)
      if (clash) return { message: 'duplicate key value violates unique constraint "attendance_day_corrections_current_unique"', code: '23505' }
    }
    if (table === 'attendance_day_reviews') {
      const now = new Date().toISOString()
      for (const r of this.rows(table)) {
        if (r.is_current && r.employee_id === row.employee_id && r.attendance_date === row.attendance_date && r.event_key === row.event_key) {
          r.is_current = false
          r.superseded_at = now
        }
      }
      row.reviewed_at = now
    }
    return null
  }
}
