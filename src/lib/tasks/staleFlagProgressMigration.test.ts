/**
 * The migration that makes an update count as progress in run_task_health_check
 * (20270827000000), proved against the function as it is live today
 * (20270610000000, read from the production database on 2026-11-24).
 *
 * WHAT MUST HOLD. Only the stale block changes. A started/working task is stale
 * when its newest `status_changed` OR `note_added` row is older than 6 days (or
 * there is none) and the task is at least 5 days old; its day count is measured
 * from that row; and a flagged task that no longer qualifies is un-flagged.
 * Everything else — the selection, both skips, the stale line and its text, the
 * signature — is compared line by line with the live function, and the exact set
 * of lines taken away and put in is pinned, so an unrelated edit cannot ride in.
 *
 * This file reads SQL text. The behaviour itself (a task with a comment is not
 * flagged, a flagged task is cleared, a second run changes nothing) was executed
 * on a throwaway in-memory Postgres before merging; see the pull request.
 *
 * Run:
 *   npm run test:file -- src/lib/tasks/staleFlagProgressMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripSqlComments } from './healthCheckMigrationAudit'

const DIR = join(process.cwd(), 'supabase/migrations')
const NEW_FILE = '20270827000000_task_health_check_updates_count_as_progress.sql'
const PREV_FILE = '20270610000000_task_health_check_stops_escalating.sql'
const read = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n')

const NEW = read(NEW_FILE)
const PREV = read(PREV_FILE)

/** Code lines only: comments stripped, trimmed, blanks dropped. */
const codeLines = (sql: string): string[] =>
  stripSqlComments(sql).split('\n').map(l => l.trim()).filter(l => l.length > 0)

/** Multiset difference: what `a` has that `b` does not also have, counting duplicates. */
function missingFrom(a: string[], b: string[]): string[] {
  const pool = new Map<string, number>()
  for (const line of b) pool.set(line, (pool.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of a) {
    const left = pool.get(line) ?? 0
    if (left > 0) pool.set(line, left - 1)
    else out.push(line)
  }
  return out
}

const newCode = codeLines(NEW)
const prevCode = codeLines(PREV)
const code = newCode.join('\n')

const STALE_NOTE = 'Auto-flagged: same status for 5+ days with no progress'

describe('an update counts as progress', () => {
  test("progress is the newest status_changed or note_added row, and nothing else", () => {
    assert.ok(code.includes('SELECT MAX(created_at) INTO last_progress_at'))
    assert.ok(code.includes("AND action IN ('status_changed', 'note_added');"))
    // The stale line itself must never count as progress, or the job would
    // un-flag what it just flagged.
    assert.equal(/action IN \([^)]*stale_flagged/.test(code), false)
  })

  test('stale = no progress in 6 days (or none at all) AND a task at least 5 days old', () => {
    assert.ok(code.includes("IF (last_progress_at IS NULL OR last_progress_at < now() - INTERVAL '6 days')"))
    assert.ok(code.includes('AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400 >= 5 THEN'))
  })

  test('the day count runs from the last progress row, or from creation when there is none', () => {
    assert.ok(code.includes(
      'FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(last_progress_at, t.created_at))) / 86400)'))
    assert.equal(code.includes('now() - t.last_update_at)) / 86400)'), false,
      'last_update_at (which a comment moves) no longer feeds the day count')
  })

  test('a flagged task that no longer qualifies is un-flagged, and only inside the stale test', () => {
    const at = newCode.indexOf('ELSIF t.is_stale THEN')
    assert.ok(at > 0, 'the un-flag branch is missing')
    assert.deepEqual(newCode.slice(at, at + 6), [
      'ELSIF t.is_stale THEN',
      'UPDATE tasks',
      'SET is_stale = false,',
      'stale_day_count = 0',
      'WHERE id = t.id;',
      'END IF;',
    ])
    assert.equal(newCode.filter(l => l === 'SET is_stale = false,').length, 1)
    assert.equal(newCode.filter(l => l === 'SET is_stale = true,').length, 1)
  })
})

describe('the stale line is written exactly as before', () => {
  test('its text, action, guard and actor are unchanged', () => {
    assert.equal((code.match(new RegExp(STALE_NOTE.replace(/[+]/g, '\\+'), 'g')) ?? []).length, 2,
      'the dedup guard and the INSERT both keep the exact stored text')
    assert.ok(code.includes("AND action = 'stale_flagged'"))
    assert.deepEqual(newCode.filter(l => l.startsWith('INSERT INTO')),
      ['INSERT INTO task_activity_log (task_id, actor_id, action, note)'])
    assert.ok(code.includes('t.created_by,'))
  })
})

describe('line by line against the live function', () => {
  const added = missingFrom(newCode, prevCode)
  const removed = missingFrom(prevCode, newCode)

  test('exactly these lines were taken away', () => {
    assert.deepEqual(removed, [
      'days_same_status INTEGER;',
      'SELECT COUNT(*) INTO days_same_status',
      "AND action = 'status_changed'",
      "AND created_at > now() - INTERVAL '6 days';",
      'IF days_same_status = 0',
      'FLOOR(EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 86400)',
    ])
  })

  test('exactly these lines were put in', () => {
    assert.deepEqual(added, [
      'last_progress_at TIMESTAMPTZ;',
      'SELECT MAX(created_at) INTO last_progress_at',
      "AND action IN ('status_changed', 'note_added');",
      "IF (last_progress_at IS NULL OR last_progress_at < now() - INTERVAL '6 days')",
      'FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(last_progress_at, t.created_at))) / 86400)',
      'ELSIF t.is_stale THEN',
      'UPDATE tasks',
      'SET is_stale = false,',
      'stale_day_count = 0',
      'WHERE id = t.id;',
    ])
  })

  test('the function above the stale block is character-for-character the live one', () => {
    const head = (sql: string) =>
      sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf("    IF t.type = 'completion'"))
    assert.ok(NEW.includes("    IF t.type = 'completion'"), 'fixture guard')
    assert.equal(
      head(NEW),
      head(PREV).replace('days_same_status INTEGER;', 'last_progress_at TIMESTAMPTZ;'),
    )
  })

  test('the task selection, both skips and the overdue-and-silent rule are untouched', () => {
    for (const keep of [
      'SELECT * FROM tasks',
      "WHERE status NOT IN ('completed', 'blocked')",
      'hours_since_update := EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 3600;',
      "IF t.status = 'waiting' THEN",
      'AND hours_since_update >= 24 THEN',
    ]) {
      assert.ok(prevCode.includes(keep), `fixture guard: the live function lacks "${keep}"`)
      assert.ok(newCode.includes(keep), `lost: "${keep}"`)
    }
    assert.equal(newCode.filter(l => l === 'CONTINUE;').length, 2, 'the overdue skip and the waiting skip')
  })

  test('control flow still balances', () => {
    // An ELSIF line ends in THEN but closes nothing, so it is not counted as an opener.
    const openers = newCode.filter(l => /\bTHEN$/.test(l) && !l.startsWith('ELSIF')).length
    assert.equal(openers, newCode.filter(l => l === 'END IF;').length, 'IF / END IF')
    assert.equal(newCode.filter(l => l === 'LOOP').length, newCode.filter(l => l === 'END LOOP;').length)
  })
})

describe('it replaces one function and nothing else', () => {
  test('same function, signature, language and return type', () => {
    assert.ok(code.includes('CREATE OR REPLACE FUNCTION public.run_task_health_check()'))
    assert.ok(code.includes('RETURNS void'))
    assert.ok(code.includes('LANGUAGE plpgsql'))
    assert.ok(NEW.trimEnd().endsWith('$function$;'))
  })

  test('no notification, escalation, delete, cron, security, search_path, owner or grant statement', () => {
    assert.equal(/\bnotifications?\b/i.test(code), false)
    assert.equal(/escalated/i.test(code), false)
    assert.equal(/\bdelete\b|\btruncate\b/i.test(code), false)
    assert.equal(/\bcron\b/i.test(code), false)
    assert.equal(/security\s+(definer|invoker)/i.test(code), false)
    assert.equal(/set\s+search_path/i.test(code), false)
    assert.equal(/\bowner\s+to\b|\bgrant\b|\brevoke\b/i.test(code), false)
  })

  test('its timestamp is unique and later than the migration it replaces', () => {
    const stamps = readdirSync(DIR).filter(n => n.endsWith('.sql')).map(n => n.slice(0, 14))
    assert.equal(new Set(stamps).size, stamps.length, 'duplicate migration timestamp')
    assert.ok(NEW_FILE.slice(0, 14) > PREV_FILE.slice(0, 14))
  })

  test('the rollback text is still there: the previous migration still holds the old rule', () => {
    assert.ok(PREV.includes('IF days_same_status = 0'))
    assert.ok(PREV.includes("AND action = 'status_changed'"))
  })
})
