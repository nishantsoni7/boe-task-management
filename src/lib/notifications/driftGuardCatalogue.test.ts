// THE DRIFT GUARD'S CATALOGUE CHECKS.
//
// ── THE DEFECT THIS FILE EXISTS FOR ─────────────────────────────────────────
//
// The guard used to prove SECURITY DEFINER and search_path by searching the
// FORMATTED function text for 'SECURITY DEFINER' and 'public, pg_temp'.
// pg_get_functiondef renders the configuration as
//
//     SET search_path TO 'public', 'pg_temp'
//
// with `TO` rather than `=` and each schema single-quoted. So the substring
// `public, pg_temp` is not in that output, and the guard would have rejected
// the CORRECT production function — a guard that always fails, which is worse
// than no guard.
//
// Both properties are now read from pg_proc: `prosecdef` and `proconfig`.
//
// ── WHAT THIS FILE CAN AND CANNOT PROVE ─────────────────────────────────────
//
// No PostgreSQL server is reachable from this environment (psql is installed;
// no server, no Docker daemon), so the DO block itself cannot be executed here.
// These tests do two separable things and neither pretends to be the other:
//
//   1. ASSERT THE SQL'S SHAPE — that it reads to_regprocedure, prosecdef and
//      proconfig, and that the brittle text checks are gone. That is a fact
//      about the file and is checked directly.
//
//   2. EXERCISE A FAITHFUL PORT of the one piece of logic with any subtlety —
//      normalising a proconfig entry into an ordered schema list. The port is
//      written to mirror the SQL line for line and the SQL is asserted to still
//      contain that line, so the two cannot drift apart silently. It is a
//      MODEL of the SQL, not the SQL running.
//
// Run:
//   npx tsx --test src/lib/notifications/driftGuardCatalogue.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const MIGRATION = 'supabase/migrations/20261016000000_notifications_link_activity_log.sql'
const sql = read(MIGRATION)
const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

// ── The port ────────────────────────────────────────────────────────────────
//
// Mirrors, exactly:
//
//   SELECT array_agg(btrim(translate(e, '"''', '')) ORDER BY ord)
//     FROM unnest(string_to_array(substr(v_search, length('search_path=') + 1), ','))
//          WITH ORDINALITY AS t(e, ord);
//
// substr past `search_path=`, split on commas, drop both quote characters,
// trim, keep the order.

function schemasOf(proconfigEntry: string): string[] {
  const value = proconfigEntry.slice('search_path='.length)
  return value.split(',').map(e => e.replace(/["']/g, '').trim())
}

/** The whole guard decision, as the SQL sequences it. */
type Verdict = { ok: true } | { ok: false; code: string }
function guard(fn: { exists: boolean; prosecdef?: boolean; proconfig?: string[] | null }): Verdict {
  if (!fn.exists) return { ok: false, code: 'TRANSITION_TASK_REVIEW_MISSING' }
  if (fn.prosecdef !== true) return { ok: false, code: 'DRIFTED:prosecdef' }
  if (fn.proconfig == null) return { ok: false, code: 'DRIFTED:no-proconfig' }
  const entry = fn.proconfig.find(c => c.startsWith('search_path='))
  if (entry === undefined) return { ok: false, code: 'DRIFTED:no-search_path' }
  const schemas = schemasOf(entry)
  const expected = ['public', 'pg_temp']
  if (schemas.length !== expected.length || schemas.some((s, i) => s !== expected[i])) {
    return { ok: false, code: 'DRIFTED:search_path' }
  }
  return { ok: true }
}

// ── 1. The SQL reads the catalogue, not the formatted text ──────────────────

describe('the guard reads pg_proc, not pg_get_functiondef text', () => {
  test('it resolves with to_regprocedure and never with a ::regprocedure cast', () => {
    assert.match(statements, /to_regprocedure\('public\.transition_task_review\(uuid,text,text\)'\)/)
    assert.equal(/::regprocedure/.test(statements), false,
      'a cast throws 42883 before this block can report anything')
  })

  test('it reads prosecdef and proconfig in ONE catalogue query', () => {
    assert.match(statements, /SELECT pg_get_functiondef\(p\.oid\), p\.prosecdef, p\.proconfig/)
    assert.match(statements, /FROM pg_proc p\s*\n\s*WHERE p\.oid = v_oid/)
    assert.equal((statements.match(/FROM pg_proc/g) ?? []).length, 1, 'one query, not three')
  })

  test('THE DEFECT IS GONE: no formatted-text check for either property', () => {
    assert.equal(/position\('SECURITY DEFINER' in/.test(statements), false)
    assert.equal(/'public, pg_temp' in v_current/.test(statements), false)
    // …and nothing else searches the rendered header either.
    assert.equal(/in v_current\)/.test(statements.replace(/position\('activity_log_id' in v_current\)/g, '')
      .replace(/position\(v_fragment in v_current\)/g, '')), false)
  })

  test('SECURITY DEFINER is decided by the boolean', () => {
    assert.match(statements, /IF v_secdef IS NOT TRUE THEN/)
  })

  test('the ordered comparison is the one the port mirrors', () => {
    assert.match(statements, /array_agg\(btrim\(translate\(e, '"''', ''\)\) ORDER BY ord\)/)
    assert.match(statements, /string_to_array\(substr\(v_search, length\('search_path='\) \+ 1\), ','\)/)
    assert.match(statements, /v_schemas IS DISTINCT FROM ARRAY\['public', 'pg_temp'\]/)
  })

  test('no cryptographic extension is required', () => {
    assert.equal(/pgcrypto|digest\(|sha256|md5\(/i.test(statements), false)
  })
})

// ── 2. The port, against the exact live format and the rejections ───────────

describe('the corrected rule ACCEPTS the exact live production format', () => {
  // THE FIXTURE. pg_get_functiondef renders this function's configuration as
  //     SET search_path TO 'public', 'pg_temp'
  // and pg_proc.proconfig holds the same setting as a name=value entry. Both
  // quoted and unquoted spellings are accepted, because the value half is
  // stored as written.
  const LIVE_PROCONFIG_QUOTED   = ["search_path='public', 'pg_temp'"]
  const LIVE_PROCONFIG_UNQUOTED = ['search_path=public, pg_temp']

  test('the quoted form — the one that broke the old check', () => {
    assert.deepEqual(schemasOf(LIVE_PROCONFIG_QUOTED[0]), ['public', 'pg_temp'])
    assert.deepEqual(guard({ exists: true, prosecdef: true, proconfig: LIVE_PROCONFIG_QUOTED }), { ok: true })
  })

  test('the unquoted form', () => {
    assert.deepEqual(guard({ exists: true, prosecdef: true, proconfig: LIVE_PROCONFIG_UNQUOTED }), { ok: true })
  })

  test('and the old check would indeed have rejected the live rendering', () => {
    // The regression, demonstrated rather than asserted from memory.
    const rendered = "SET search_path TO 'public', 'pg_temp'"
    assert.equal(rendered.includes('public, pg_temp'), false,
      'this is why the substring check had to go')
  })

  test('double-quoted, spaced and reordered-whitespace variants all normalise', () => {
    for (const entry of [
      'search_path="public", "pg_temp"',
      'search_path=  public ,  pg_temp  ',
      "search_path='public','pg_temp'",
    ]) {
      assert.deepEqual(schemasOf(entry), ['public', 'pg_temp'], entry)
    }
  })

  test('extra unrelated proconfig entries do not confuse it', () => {
    assert.deepEqual(guard({
      exists: true, prosecdef: true,
      proconfig: ['statement_timeout=5s', "search_path='public', 'pg_temp'", 'row_security=off'],
    }), { ok: true })
  })
})

describe('and REJECTS every drift it is meant to catch', () => {
  test('SECURITY INVOKER', () => {
    assert.deepEqual(
      guard({ exists: true, prosecdef: false, proconfig: ["search_path='public', 'pg_temp'"] }),
      { ok: false, code: 'DRIFTED:prosecdef' })
  })

  test('no per-function configuration at all', () => {
    assert.deepEqual(guard({ exists: true, prosecdef: true, proconfig: null }),
      { ok: false, code: 'DRIFTED:no-proconfig' })
  })

  test('configuration present but no search_path in it', () => {
    assert.deepEqual(guard({ exists: true, prosecdef: true, proconfig: ['statement_timeout=5s'] }),
      { ok: false, code: 'DRIFTED:no-search_path' })
  })

  test('a search_path without pg_temp', () => {
    assert.deepEqual(guard({ exists: true, prosecdef: true, proconfig: ["search_path='public'"] }),
      { ok: false, code: 'DRIFTED:search_path' })
  })

  test('an unexpected schema BEFORE public — order is part of the property', () => {
    // A schema ahead of public changes which objects the body resolves to, so
    // this is the shape a search_path attack takes.
    assert.deepEqual(
      guard({ exists: true, prosecdef: true, proconfig: ["search_path='evil', 'public', 'pg_temp'"] }),
      { ok: false, code: 'DRIFTED:search_path' })
    assert.deepEqual(
      guard({ exists: true, prosecdef: true, proconfig: ["search_path='pg_temp', 'public'"] }),
      { ok: false, code: 'DRIFTED:search_path' })
  })

  test('a schema appended after pg_temp', () => {
    assert.deepEqual(
      guard({ exists: true, prosecdef: true, proconfig: ["search_path='public', 'pg_temp', 'extra'"] }),
      { ok: false, code: 'DRIFTED:search_path' })
  })

  test('a missing function, WITHOUT leaking the raw resolution error', () => {
    assert.deepEqual(guard({ exists: false }), { ok: false, code: 'TRANSITION_TASK_REVIEW_MISSING' })
    // The message names the migration to run, not PostgreSQL's 42883.
    assert.match(statements,
      /TRANSITION_TASK_REVIEW_MISSING: public\.transition_task_review\(uuid,text,text\) does not exist\. 20260833000000/)
    assert.equal(/does not exist\s*$/m.test(statements), false)
  })
})

// ── 3. The body guards are untouched ────────────────────────────────────────

describe('the semantic body guards were not weakened', () => {
  test('all 32 fragments remain', () => {
    const start = statements.indexOf('v_required text[] := array[')
    const end = statements.indexOf('  ];', start)
    const frags = [...statements.slice(start, end).matchAll(/^\s*'((?:[^']|'')*)',?\s*$/gm)]
    assert.equal(frags.length, 32)
  })

  test('and none of them depends on the rendered HEADER', () => {
    // pg_get_functiondef reformats the header and preserves the body verbatim,
    // so every fragment must come from inside the $$ … $$ body — otherwise the
    // same class of defect returns.
    const source = read('supabase/migrations/20260833000000_task_creator_approval.sql')
    const fnStart = source.indexOf('create or replace function public.transition_task_review(')
    const bodyStart = source.indexOf('as $$', fnStart)
    const body = source.slice(bodyStart, source.indexOf('\n$$;', bodyStart))

    const start = statements.indexOf('v_required text[] := array[')
    const end = statements.indexOf('  ];', start)
    const frags = [...statements.slice(start, end).matchAll(/^\s*'((?:[^']|'')*)',?\s*$/gm)]
      .map(m => m[1].replace(/''/g, "'"))
    const notInBody = frags.filter(f => !body.includes(f))
    assert.deepEqual(notInBody, [], 'these fragments are not in the body and could be reformatted away')
  })

  test('the documented limitation is preserved, not quietly upgraded', () => {
    assert.match(sql, /WHAT IT IS NOT: a full-definition comparison/)
    assert.match(sql, /WHAT IT CANNOT DETECT/)
    assert.match(sql, /a rule ADDED in production/)
  })
})

// ── 4. Transaction safety ───────────────────────────────────────────────────

describe('every statement is transaction-compatible', () => {
  test('nothing in the file can run outside a transaction block', () => {
    // If the guard raises after the column, FK and index have been created, the
    // whole migration must roll back rather than leave activity_log_id half
    // installed and unregistered in migration history. That holds only if every
    // statement here is transactional.
    const forbidden = [
      /CREATE\s+INDEX\s+CONCURRENTLY/i,
      /DROP\s+INDEX\s+CONCURRENTLY/i,
      /REINDEX\s+CONCURRENTLY/i,
      /\bVACUUM\b/i,
      /CREATE\s+DATABASE/i,
      /DROP\s+DATABASE/i,
      /CREATE\s+TABLESPACE/i,
      /ALTER\s+SYSTEM/i,
      /ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i,   // not allowed mid-transaction pre-PG12 patterns
      // Transaction CONTROL statements — a bare `BEGIN;` / `COMMIT;`. The
      // PL/pgSQL `BEGIN` that opens a DO block is not one and must not match,
      // so this requires the terminating semicolon a statement carries.
      /^\s*(COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION)\s*;/im,
    ]
    for (const re of forbidden) {
      assert.equal(re.test(statements), false, `non-transactional or transaction-breaking: ${re}`)
    }
  })

  test('the statements used are exactly the transactional set', () => {
    const kinds = [
      /ALTER TABLE notifications\s*\n\s*ADD COLUMN IF NOT EXISTS/,
      /COMMENT ON COLUMN notifications\.activity_log_id/,
      /ADD CONSTRAINT notifications_activity_log_id_fkey/,
      /CREATE INDEX IF NOT EXISTS notifications_activity_log_id_idx/,
      /create or replace function public\.transition_task_review/,
      /revoke all\s+on function public\.transition_task_review/,
      /grant execute on function public\.transition_task_review/,
      /comment on function public\.transition_task_review/,
    ]
    for (const re of kinds) assert.match(statements, re)
  })

  test('the guard runs BEFORE the replacement, so a refusal changes nothing', () => {
    const guardAt = statements.indexOf('TRANSITION_TASK_REVIEW_MISSING')
    const replaceAt = statements.indexOf('create or replace function public.transition_task_review')
    assert.ok(guardAt > 0 && guardAt < replaceAt)
  })
})
